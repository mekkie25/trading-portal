"""
backtest/settings_optimizer.py
Per-strategy, per-pair settings optimizer.

PROPOSED.

WHAT IT DOES
------------
For each (pair, strategy) that has enough historical trades:
  1. Runs the strategy with default settings.
  2. Tries one setting change at a time from a fixed search space.
  3. Keeps the change that most improves TUNE-period profit factor.
  4. Accepts it ONLY if the honest validation rules pass:
       (a) TUNE >= 30 trades AND VALIDATE >= 30 trades
       (b) VALIDATE PF >= baseline VALIDATE PF + 0.10
       (c) VALIDATE PF > 1.0
       (d) PF > 1.0 in at least 3 of 4 date quarters
  5. Repeats up to 3 accepted changes per (pair, strategy).

BASELINE GUARD
--------------
The optimizer runs its own combined baseline per pair that matches the
"Adaptive · BE on · R:R 1:1" six-combination. It reads {pair}_summary.json
for the same window and compares trade counts. If the difference is > 2%
the pair is INVALID, listed under "OPTIMIZER INVALID" at the top of the
summary, and excluded from the suggested file and the combined backtest.

OUTPUTS
-------
  config/pair_settings.suggested.json   (never overwrites pair_settings.json)
  backtest/output/optimizer_summary.txt (plain-English summary, also in TXT export)
  backtest/output/optimizer_summary.json

TIME BUDGET
-----------
OPTIMIZER_MAX_SECONDS is a hard wall-clock cap (default 1200 = 20 min).
"""

import os
import sys
import time
import json
import copy
import traceback
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
import numpy as np

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from backtest.paths import DATA_DIR, OUTPUT_DIR
from backtest.simulator import TradeSimulator, ASSETS
from backtest.report import calculate_kpis
from backtest.runner import (
    _try_load_precompute,
    _save_precompute,
    compute_121_window_emas,
    compute_atr14_series,
    precompute_market_pass,
    compute_tune_validate_kpis,
)
from core.pair_settings import (
    load_pair_settings, default_settings, save_pair_settings,
    get_strategy_settings, get_effective_rr, get_effective_be,
    get_effective_max_daily, WHITELIST_PAIRS, STRATEGY_NAMES,
    passes_signal_filters,
)
from core.volatility_engine import volatility_engine
from core.session_config import GLOBAL_PARAMS, TZ_SAST


# ---------------------------------------------------------------------------
# Knobs
# ---------------------------------------------------------------------------
OPTIMIZER_MAX_SECONDS = 1200
MIN_BASELINE_TRADES = 60
MIN_TRADES_TUNE_VALIDATE = 30
MIN_VALIDATE_PF_IMPROVEMENT = 0.10
MIN_VALIDATE_PF = 1.00
MIN_QUARTERS_ABOVE_ONE = 3
MAX_ACCEPTED_CHANGES = 3
OPTIMIZE_WINDOW_DAYS = 365

# The baseline the optimizer compares itself to.
BASELINE_COMBINATION_LABEL = "Adaptive · BE on · R:R 1:1"
BASELINE_USE_BE = True
BASELINE_RR = 1.0

# Search space.
SEARCH_SPACE: Dict[str, List[Any]] = {
    "session_window_sast": [None, "ASIA", "LONDON", "LONDON_NY", "NY", "ALL_DAY"],
    "weekdays": [None, [1, 2, 3, 4], [0, 2, 3, 4], [0, 1, 3, 4], [0, 1, 2, 4], [0, 1, 2, 3]],
    "min_stop_atr": [0.0, 0.5, 1.0, 1.5, 2.0],
    "max_stop_atr": [None, 3.0, 4.0, 5.0],
    "max_spread_in_r": [None, 0.10, 0.05, 0.03],
    "rr": [1.0, 1.25, 1.5, 2.0],
    "be_enabled": [False, True],
    "max_daily_trades": [None, 1, 2, 3],
}

STATUS_FILE = os.path.join(DATA_DIR, "optimizer_status.json")
SUGGESTED_PATH = os.path.join(PROJECT_ROOT, "config", "pair_settings.suggested.json")
SUMMARY_PATH = os.path.join(OUTPUT_DIR, "optimizer_summary.txt")
SUMMARY_JSON_PATH = os.path.join(OUTPUT_DIR, "optimizer_summary.json")


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
_start_time: float = 0.0
_variants_tested: int = 0


def _elapsed() -> float:
    return time.time() - _start_time


def _over_budget(deadline: float) -> bool:
    return time.time() >= deadline


def _log(msg: str) -> None:
    print(f"[OPTIMIZE] {msg}", flush=True)


def _write_status(payload: Dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(STATUS_FILE), exist_ok=True)
        tmp = STATUS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp, STATUS_FILE)
    except Exception:
        pass


def _blank_settings() -> Dict[str, Any]:
    return {
        "enabled": True,
        "session_window_sast": None,
        "weekdays": None,
        "min_stop_atr": 0.0,
        "max_stop_atr": None,
        "max_spread_in_r": None,
        "rr": None,
        "be_enabled": None,
        "max_daily_trades": None,
    }


def _baseline_settings() -> Dict[str, Any]:
    d = _blank_settings()
    d["be_enabled"] = BASELINE_USE_BE
    d["rr"] = BASELINE_RR
    return d


def _settings_equal(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    for k in _blank_settings().keys():
        if a.get(k) != b.get(k):
            return False
    return True


def _pair_from_live(live_settings: Dict[str, Any], pair: str) -> Dict[str, Any]:
    live_pair = (live_settings.get("pairs") or {}).get(pair) or {}
    strategies: Dict[str, Any] = {}
    for s in STRATEGY_NAMES:
        live_s = ((live_pair.get("strategies") or {}).get(s)) or {}
        merged = _blank_settings()
        for k in merged.keys():
            if k in live_s:
                merged[k] = live_s[k]
        strategies[s] = merged
    return {
        "live_enabled": bool(live_pair.get("live_enabled", True)),
        "risk_pct": live_pair.get("risk_pct", None),
        "strategies": strategies,
    }


def _quarters_above_one(trades: List[Dict[str, Any]]) -> int:
    if not trades:
        return 0
    times: List[datetime] = []
    for t in trades:
        ts = t.get("signal_time_utc")
        if not ts:
            continue
        try:
            times.append(datetime.strptime(str(ts), "%Y-%m-%d %H:%M:%S"))
        except Exception:
            pass
    if len(times) < 4:
        return 0
    t0, t1 = min(times), max(times)
    span = (t1 - t0).total_seconds()
    if span <= 0:
        return 0
    buckets: List[List[Dict[str, Any]]] = [[], [], [], []]
    for t in trades:
        ts = t.get("signal_time_utc")
        if not ts:
            continue
        try:
            dt = datetime.strptime(str(ts), "%Y-%m-%d %H:%M:%S")
        except Exception:
            continue
        q = min(3, int((dt - t0).total_seconds() / span * 4))
        buckets[q].append(t)
    count = 0
    for b in buckets:
        if len(b) < 5:
            continue
        k = calculate_kpis(b)
        if float(k.get("profit_factor", 0.0) or 0.0) > 1.0:
            count += 1
    return count


def _load_pair_data(pair: str) -> Tuple[Optional[pd.DataFrame], Optional[pd.DataFrame]]:
    m5_path = os.path.join(DATA_DIR, f"{pair}_M5.csv")
    d1_path = os.path.join(DATA_DIR, f"{pair}_D1.csv")
    if not os.path.exists(m5_path) or not os.path.exists(d1_path):
        return None, None
    try:
        m5 = pd.read_csv(m5_path).reset_index(drop=True)
        d1 = pd.read_csv(d1_path).reset_index(drop=True)
        return m5, d1
    except Exception:
        return None, None


def _window_bounds(m5_df: pd.DataFrame, days_count: int) -> Tuple[int, int, str, str]:
    total_bars = len(m5_df)
    last_bar = m5_df['time'].iloc[-1]
    cutoff = last_bar - timedelta(days=days_count)
    matches = m5_df.index[m5_df['time'] >= cutoff].tolist()
    sim_start_idx = max(120, matches[0]) if matches else max(120, total_bars - 1)
    start_str = m5_df['time'].iloc[sim_start_idx].strftime('%Y-%m-%d %H:%M:%S UTC')
    end_str = last_bar.strftime('%Y-%m-%d %H:%M:%S UTC')
    return sim_start_idx, total_bars, start_str, end_str


def _load_summary_days(pair: str, default_days: int) -> int:
    summary_path = os.path.join(OUTPUT_DIR, f"{pair}_summary.json")
    if not os.path.exists(summary_path):
        return default_days
    try:
        with open(summary_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        d = data.get("days")
        if isinstance(d, (int, float)) and d > 0:
            return int(d)
    except Exception:
        pass
    return default_days


def _load_summary_combination_count(pair: str, label: str) -> Optional[int]:
    summary_path = os.path.join(OUTPUT_DIR, f"{pair}_summary.json")
    if not os.path.exists(summary_path):
        return None
    try:
        with open(summary_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    combos = data.get("combinations") or []
    for c in combos:
        if c.get("label") == label:
            try:
                return int(c.get("total_trades") or 0)
            except Exception:
                return None
    return None


def _read_strategy_modes() -> Dict[str, Any]:
    try:
        cfg_path = os.path.join(PROJECT_ROOT, "bot_config.json")
        if not os.path.exists(cfg_path):
            cfg_path = "bot_config.json"
        if not os.path.exists(cfg_path):
            return {}
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        return cfg.get("strategyModes", {}) or {}
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# Combined baseline (matches the six-combination exactly)
# ---------------------------------------------------------------------------

def _run_combined_baseline(
    pair: str,
    m5_df: pd.DataFrame,
    cached_signals: Dict[int, Dict[str, Any]],
    sim_start_idx: int,
    total_bars: int,
    strategy_settings_map: Dict[str, Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    sim = TradeSimulator(starting_balance=1000.0, risk_pct=1.0)
    m5_times_list = m5_df['time'].tolist()
    has_atr14 = 'atr_14' in m5_df.columns
    asset_spread = ASSETS.get(pair, {}).get("spread", 0.0)

    funnel = {
        "raw_signals": 0,
        "after_settings": 0,
        "after_adapt": 0,
        "after_filters": 0,
        "after_position_check": 0,
        "opened": 0,
        "sim_rejected": 0,
    }

    for i in range(sim_start_idx, total_bars):
        curr_bar = m5_df.iloc[i]
        curr_time = m5_times_list[i].to_pydatetime()

        if sim.open_positions or sim.pending_sl_evaluations:
            m5_slice = m5_df.iloc[max(0, i - 120):i + 1]
            sim.process_candle(pair, curr_bar, m5_slice)

        if i not in cached_signals:
            continue
        item = cached_signals[i]
        signal = copy.deepcopy(item["raw_signal"])
        funnel["raw_signals"] += 1

        s = strategy_settings_map.get(signal.strategy)
        if s is None:
            s = _baseline_settings()

        try:
            atr14_val = float(m5_df.iloc[i]['atr_14']) if has_atr14 else 0.0
            if not np.isfinite(atr14_val):
                atr14_val = 0.0
        except Exception:
            atr14_val = 0.0

        passes, _ = passes_signal_filters(s, signal, curr_time, atr14_val, asset_spread)
        if not passes:
            continue
        funnel["after_settings"] += 1

        active_vol = item["active_vol"]
        if not active_vol.get("valid", False):
            continue

        strat_rr = get_effective_rr(s, BASELINE_RR)
        adapted = volatility_engine.adapt_signal(
            signal, active_vol, ui_rr=strat_rr, session_levels=item["session_levels"]
        )
        if not adapted:
            continue
        funnel["after_adapt"] += 1

        spread = ASSETS.get(pair, {}).get("spread", 0.0001)
        sl_d = abs(adapted.entry_price - adapted.stop_loss)
        tp_d = abs(adapted.take_profit_2 - adapted.entry_price)
        vol_ok, _ = volatility_engine.evaluate_volatility_filters(
            active_vol, spread, sl_d, tp_d,
            adapted.direction, adapted.entry_price, adapted.strategy,
        )
        if not vol_ok:
            continue
        funnel["after_filters"] += 1

        if any(p["symbol"] == pair for p in sim.open_positions):
            continue
        funnel["after_position_check"] += 1

        opened = sim.open_trade(
            adapted, curr_time, item["adr_val"], item["regime"], item["session_levels"],
            use_breakeven_override=get_effective_be(s, BASELINE_USE_BE),
        )
        if opened:
            funnel["opened"] += 1
        else:
            funnel["sim_rejected"] += 1

    if sim.open_positions:
        sim.close_all(pair, m5_df.iloc[-1])

    return sim.completed_trades, funnel


# ---------------------------------------------------------------------------
# Isolated per-strategy search pass
# ---------------------------------------------------------------------------

def _simulate_strategy_pass(
    symbol: str,
    m5_df: pd.DataFrame,
    cached_signals: Dict[int, Dict[str, Any]],
    sim_start_idx: int,
    total_bars: int,
    strategy_name: str,
    settings: Dict[str, Any],
    balance: float = 1000.0,
    risk_pct: float = 1.0,
) -> List[Dict[str, Any]]:
    global _variants_tested

    sim = TradeSimulator(starting_balance=balance, risk_pct=risk_pct)
    m5_times_list = m5_df['time'].tolist()
    has_atr14 = 'atr_14' in m5_df.columns
    asset_spread = ASSETS.get(symbol, {}).get("spread", 0.0)

    strat_rr = get_effective_rr(settings, BASELINE_RR)
    strat_be = get_effective_be(settings, BASELINE_USE_BE)
    strat_cap = get_effective_max_daily(settings, 0)
    if strat_cap is not None and strat_cap <= 0:
        strat_cap = None

    for i in range(sim_start_idx, total_bars):
        curr_bar = m5_df.iloc[i]
        curr_time = m5_times_list[i].to_pydatetime()

        if sim.open_positions or sim.pending_sl_evaluations:
            m5_slice = m5_df.iloc[max(0, i - 120):i + 1]
            sim.process_candle(symbol, curr_bar, m5_slice)

        if i not in cached_signals:
            continue
        item = cached_signals[i]
        raw = item["raw_signal"]
        if raw.strategy != strategy_name:
            continue

        signal = copy.deepcopy(raw)

        try:
            atr14_val = float(m5_df.iloc[i]['atr_14']) if has_atr14 else 0.0
            if not np.isfinite(atr14_val):
                atr14_val = 0.0
        except Exception:
            atr14_val = 0.0

        passes, _ = passes_signal_filters(settings, signal, curr_time, atr14_val, asset_spread)
        if not passes:
            continue

        active_vol = item["active_vol"]
        if not active_vol.get("valid", False):
            continue

        adapted = volatility_engine.adapt_signal(
            signal, active_vol, ui_rr=strat_rr, session_levels=item["session_levels"]
        )
        if not adapted:
            continue

        spread = ASSETS.get(symbol, {}).get("spread", 0.0001)
        sl_d = abs(adapted.entry_price - adapted.stop_loss)
        tp_d = abs(adapted.take_profit_2 - adapted.entry_price)
        vol_ok, _ = volatility_engine.evaluate_volatility_filters(
            active_vol, spread, sl_d, tp_d,
            adapted.direction, adapted.entry_price, adapted.strategy,
        )
        if not vol_ok:
            continue

        if any(p["symbol"] == symbol for p in sim.open_positions):
            continue

        sim.open_trade(
            adapted, curr_time, item["adr_val"], item["regime"], item["session_levels"],
            use_breakeven_override=strat_be,
            max_daily_override=strat_cap,
        )

    if sim.open_positions:
        sim.close_all(symbol, m5_df.iloc[-1])
    return sim.completed_trades


# ---------------------------------------------------------------------------
# Greedy forward selection
# ---------------------------------------------------------------------------

def _greedy_select(
    symbol: str,
    m5_df: pd.DataFrame,
    cached_signals: Dict[int, Dict[str, Any]],
    sim_start_idx: int,
    total_bars: int,
    strategy_name: str,
    window_start_str: str,
    window_end_str: str,
    deadline: float,
) -> Dict[str, Any]:
    global _variants_tested

    current = _baseline_settings()
    trades = _simulate_strategy_pass(
        symbol, m5_df, cached_signals, sim_start_idx, total_bars,
        strategy_name, current,
    )
    _variants_tested += 1
    tv = compute_tune_validate_kpis(trades, window_start_str, window_end_str)

    baseline_tune_pf = float(tv["tune"].get("profit_factor") or 0.0)
    baseline_validate_pf = float(tv["validate"].get("profit_factor") or 0.0)

    accepted: List[Dict[str, Any]] = []
    hit_deadline = False

    for _step in range(MAX_ACCEPTED_CHANGES):
        if _over_budget(deadline):
            hit_deadline = True
            break

        current_tune_pf = float(tv["tune"].get("profit_factor") or 0.0)
        best_choice: Optional[Dict[str, Any]] = None

        for field, values in SEARCH_SPACE.items():
            for val in values:
                if _over_budget(deadline):
                    hit_deadline = True
                    break
                candidate = dict(current)
                candidate[field] = val
                if _settings_equal(candidate, current):
                    continue

                c_trades = _simulate_strategy_pass(
                    symbol, m5_df, cached_signals, sim_start_idx, total_bars,
                    strategy_name, candidate,
                )
                _variants_tested += 1

                c_tv = compute_tune_validate_kpis(c_trades, window_start_str, window_end_str)
                c_tune = c_tv["tune"]
                c_val = c_tv["validate"]
                c_tune_pf = float(c_tune.get("profit_factor") or 0.0)

                if c_tune_pf <= current_tune_pf:
                    continue
                if int(c_tune.get("count") or 0) < MIN_TRADES_TUNE_VALIDATE:
                    continue
                if int(c_val.get("count") or 0) < MIN_TRADES_TUNE_VALIDATE:
                    continue
                c_val_pf = float(c_val.get("profit_factor") or 0.0)
                if c_val_pf < MIN_VALIDATE_PF:
                    continue
                if c_val_pf < baseline_validate_pf + MIN_VALIDATE_PF_IMPROVEMENT:
                    continue
                q = _quarters_above_one(c_trades)
                if q < MIN_QUARTERS_ABOVE_ONE:
                    continue

                if best_choice is None or c_tune_pf > best_choice["tune_pf"]:
                    best_choice = {
                        "field": field,
                        "value": val,
                        "settings": candidate,
                        "tune_pf": c_tune_pf,
                        "validate_pf": c_val_pf,
                        "trades": c_trades,
                        "tv": c_tv,
                        "quarters": q,
                    }
            if hit_deadline:
                break

        if best_choice is None:
            break

        current = best_choice["settings"]
        trades = best_choice["trades"]
        tv = best_choice["tv"]
        accepted.append({
            "field": best_choice["field"],
            "value": best_choice["value"],
            "tune_pf": best_choice["tune_pf"],
            "validate_pf": best_choice["validate_pf"],
            "quarters": best_choice["quarters"],
        })

    verdict = "ROBUST" if accepted else "NO CHANGE"
    return {
        "settings": current,
        "trades": trades,
        "tv": tv,
        "accepted": accepted,
        "verdict": verdict,
        "hit_deadline": hit_deadline,
        "baseline_tune_pf": baseline_tune_pf,
        "baseline_validate_pf": baseline_validate_pf,
    }


# ---------------------------------------------------------------------------
# Summary writer
# ---------------------------------------------------------------------------

def _write_summary(blocks: List[str]) -> None:
    try:
        os.makedirs(os.path.dirname(SUMMARY_PATH), exist_ok=True)
        with open(SUMMARY_PATH, "w", encoding="utf-8") as f:
            f.write("\n".join(blocks))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Final combined backtest
# ---------------------------------------------------------------------------

def _run_combined(
    symbols: List[str],
    suggested: Dict[str, Any],
    days_count: int,
    use_settings: bool,
) -> List[Dict[str, Any]]:
    combined: List[Dict[str, Any]] = []
    for pair in symbols:
        m5_df, _d1 = _load_pair_data(pair)
        if m5_df is None:
            continue
        m5_df['time'] = pd.to_datetime(m5_df['time'], utc=True)
        sim_start_idx, total_bars, _ws, _we = _window_bounds(m5_df, days_count)
        cached = _try_load_precompute(pair, sim_start_idx, total_bars)
        if cached is None:
            continue
        compute_121_window_emas(m5_df)
        compute_atr14_series(m5_df)
        cached_signals = cached.get("cached_signals") or {}
        if not cached_signals:
            continue

        strat_settings: Dict[str, Dict[str, Any]] = {}
        for s in STRATEGY_NAMES:
            if use_settings:
                block = (suggested.get("pairs", {}).get(pair, {})
                         .get("strategies", {}).get(s))
                strat_settings[s] = block if block else _baseline_settings()
            else:
                strat_settings[s] = _baseline_settings()

        trades, _funnel = _run_combined_baseline(
            pair, m5_df, cached_signals, sim_start_idx, total_bars, strat_settings,
        )
        combined.extend(trades)
    return combined


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------

def run_optimizer(symbols_list: Optional[List[str]] = None) -> bool:
    global _start_time, _variants_tested

    _start_time = time.time()
    _variants_tested = 0

    if not symbols_list:
        symbols_list = list(WHITELIST_PAIRS)

    deadline = _start_time + OPTIMIZER_MAX_SECONDS
    live_settings = load_pair_settings()
    suggested: Dict[str, Any] = {"pairs": {}}

    default_settings_map: Dict[str, Dict[str, Any]] = {}
    for s in STRATEGY_NAMES:
        default_settings_map[s] = _baseline_settings()

    strategy_modes = _read_strategy_modes()

    blocks: List[str] = []
    blocks.append("OPTIMIZER SUMMARY")
    blocks.append(f"Started: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    blocks.append(f"Symbols: {', '.join(symbols_list)}")
    blocks.append(f"Baseline: {BASELINE_COMBINATION_LABEL}")
    blocks.append(f"Max wall clock: {OPTIMIZER_MAX_SECONDS}s")
    blocks.append(
        f"Rules: TUNE>={MIN_TRADES_TUNE_VALIDATE} trades, VALIDATE>={MIN_TRADES_TUNE_VALIDATE} trades, "
        f"VALIDATE PF >= baseline + {MIN_VALIDATE_PF_IMPROVEMENT:.2f}, "
        f"VALIDATE PF > {MIN_VALIDATE_PF:.2f}, "
        f"PF > 1.0 in {MIN_QUARTERS_ABOVE_ONE}/4 quarters"
    )
    if strategy_modes:
        off_list = [k for k, v in strategy_modes.items() if v == "OFF"]
        if off_list:
            blocks.append(f"bot_config strategyModes OFF: {', '.join(off_list)}")
        else:
            blocks.append(f"bot_config strategyModes: all LIVE/DRY_RUN")
    else:
        blocks.append("bot_config strategyModes: (no bot_config.json or empty)")
    blocks.append("")
    _write_summary(blocks)

    _log(f"starting, symbols={symbols_list}, budget={OPTIMIZER_MAX_SECONDS}s")

    invalid_pairs: List[str] = []
    ok_pairs: List[str] = []

    saved_adaptive = GLOBAL_PARAMS.adaptive_mode
    saved_be = GLOBAL_PARAMS.use_breakeven
    saved_trail = GLOBAL_PARAMS.use_supertrend_trail
    saved_rr = GLOBAL_PARAMS.target_rr
    GLOBAL_PARAMS.adaptive_mode = True
    GLOBAL_PARAMS.use_breakeven = BASELINE_USE_BE
    GLOBAL_PARAMS.use_supertrend_trail = False
    GLOBAL_PARAMS.target_rr = BASELINE_RR

    try:
        for pair in symbols_list:
            pair_block = _pair_from_live(live_settings, pair)
            suggested["pairs"][pair] = pair_block

            if _over_budget(deadline):
                blocks.append(f"[{pair}] SKIPPED — optimizer over time budget.")
                _write_summary(blocks)
                continue

            _log(f"pair {pair}: loading data")
            m5_df, _d1 = _load_pair_data(pair)
            if m5_df is None:
                blocks.append(f"[{pair}] SKIPPED — no market data found.")
                _write_summary(blocks)
                continue

            summary_days = _load_summary_days(pair, OPTIMIZE_WINDOW_DAYS)
            m5_df['time'] = pd.to_datetime(m5_df['time'], utc=True)
            sim_start_idx, total_bars, ws, we = _window_bounds(m5_df, summary_days)
            if total_bars < 200:
                blocks.append(f"[{pair}] SKIPPED — only {total_bars} bars.")
                _write_summary(blocks)
                continue

            cached = _try_load_precompute(pair, sim_start_idx, total_bars)
            if cached is None:
                _log(f"pair {pair}: building precompute cache (cold; this is the slow part)")
                blocks.append(f"[{pair}] building precompute cache (cold, window={summary_days}d)...")
                _write_summary(blocks)
                try:
                    h1_df = pd.read_csv(os.path.join(DATA_DIR, f"{pair}_H1.csv"))
                    h4_df = pd.read_csv(os.path.join(DATA_DIR, f"{pair}_H4.csv"))
                    d1_df = pd.read_csv(os.path.join(DATA_DIR, f"{pair}_D1.csv"))
                    compute_121_window_emas(m5_df)
                    compute_atr14_series(m5_df)
                    t0 = time.time()
                    precomputed = precompute_market_pass(
                        symbol=pair, m5_df=m5_df, h1_df=h1_df, h4_df=h4_df, d1_df=d1_df,
                        sim_start_idx=sim_start_idx, total_bars=total_bars,
                    )
                    try:
                        _save_precompute(pair, sim_start_idx, total_bars, precomputed, time.time() - t0)
                    except Exception:
                        pass
                    cached = precomputed
                except Exception as e:
                    blocks.append(f"[{pair}] FAILED to build precompute: {e}")
                    _write_summary(blocks)
                    continue
            else:
                _log(f"pair {pair}: loaded cached precompute")
                compute_121_window_emas(m5_df)
                compute_atr14_series(m5_df)

            cached_signals = cached.get("cached_signals") or {}
            if not cached_signals:
                blocks.append(f"[{pair}] SKIPPED — no cached signals.")
                _write_summary(blocks)
                continue

            raw_strategy_counts: Dict[str, int] = {}
            for _, item in cached_signals.items():
                sn = item["raw_signal"].strategy
                raw_strategy_counts[sn] = raw_strategy_counts.get(sn, 0) + 1

            _log(f"pair {pair}: running combined baseline")
            baseline_trades, funnel = _run_combined_baseline(
                pair, m5_df, cached_signals, sim_start_idx, total_bars, default_settings_map,
            )
            baseline_by_strategy: Dict[str, List[Dict[str, Any]]] = {}
            for t in baseline_trades:
                baseline_by_strategy.setdefault(t["strategy"], []).append(t)

            expected = _load_summary_combination_count(pair, BASELINE_COMBINATION_LABEL)
            guard_msg = None
            guard_ok = True
            if expected is None:
                guard_msg = f"[{pair}] GUARD SKIPPED — no summary for '{BASELINE_COMBINATION_LABEL}'. Using optimizer baseline only."
            else:
                diff = abs(len(baseline_trades) - expected)
                pct = (diff / max(1, expected)) * 100.0
                if pct > 2.0:
                    guard_ok = False
                    guard_msg = (
                        f"[{pair}] BASELINE MISMATCH: optimizer {len(baseline_trades)} "
                        f"vs backtest {expected} ({pct:.1f}%)"
                    )
                    invalid_pairs.append(pair)

            funnel_line = (
                f"[{pair}] FUNNEL window_days={summary_days} "
                f"raw={funnel['raw_signals']} "
                f"after_settings={funnel['after_settings']} "
                f"after_adapt={funnel['after_adapt']} "
                f"after_filters={funnel['after_filters']} "
                f"after_position_check={funnel['after_position_check']} "
                f"opened={funnel['opened']} "
                f"sim_rejected={funnel['sim_rejected']} "
                f"backtest={expected if expected is not None else 'n/a'}"
            )
            _log(funnel_line)
            blocks.append(funnel_line)

            raw_breakdown = " ".join(f"{k}={v}" for k, v in sorted(raw_strategy_counts.items()))
            blocks.append(f"[{pair}] CACHED SIGNALS BY STRATEGY: {raw_breakdown or '(none)'}")

            if guard_msg:
                blocks.append(guard_msg)
                _write_summary(blocks)

            if not guard_ok:
                blocks.append(f"[{pair}] SEARCH SKIPPED — guard failed.")
                _write_summary(blocks)
                continue

            ok_pairs.append(pair)

            _log(f"pair {pair}: starting strategy loop")
            for strategy in STRATEGY_NAMES:
                if _over_budget(deadline):
                    blocks.append(f"[{pair} / {strategy}] SKIPPED — over time budget.")
                    _write_summary(blocks)
                    continue

                baseline_count = len(baseline_by_strategy.get(strategy, []))
                if baseline_count < MIN_BASELINE_TRADES:
                    blocks.append(
                        f"[{pair} / {strategy}] SKIPPED — baseline only "
                        f"{baseline_count} trades (need >= {MIN_BASELINE_TRADES})."
                    )
                    _write_summary(blocks)
                    continue

                _log(f"pair {pair}, strategy {strategy}: greedy selection")

                try:
                    sel = _greedy_select(
                        pair, m5_df, cached_signals, sim_start_idx, total_bars,
                        strategy, ws, we, deadline,
                    )
                except Exception as e:
                    blocks.append(f"[{pair} / {strategy}] FAILED: {e}")
                    _write_summary(blocks)
                    traceback.print_exc()
                    continue

                current = sel["settings"]
                accepted = sel["accepted"]
                verdict = sel["verdict"]
                hit_deadline = sel["hit_deadline"]
                f_tv = sel["tv"]
                f_trades = sel["trades"]
                f_q = _quarters_above_one(f_trades)

                b_tv = compute_tune_validate_kpis(
                    baseline_by_strategy.get(strategy, []), ws, we
                )
                b_tune = b_tv["tune"]
                b_val = b_tv["validate"]
                f_tune = f_tv["tune"]
                f_val = f_tv["validate"]

                settings_desc = ", ".join(
                    f"{c['field']}={c['value']}" for c in accepted
                ) if accepted else "defaults (no qualifying change found)"

                blocks.append(
                    f"[{pair} / {strategy}]\n"
                    f"  Baseline: TUNE TR {int(b_tune.get('count', 0)):>4}  "
                    f"PF {float(b_tune.get('profit_factor') or 0):.2f}  |  "
                    f"VALIDATE TR {int(b_val.get('count', 0)):>4}  "
                    f"PF {float(b_val.get('profit_factor') or 0):.2f}\n"
                    f"  Chosen:   {settings_desc}\n"
                    f"  Result:   TUNE TR {int(f_tune.get('count', 0)):>4}  "
                    f"PF {float(f_tune.get('profit_factor') or 0):.2f}  |  "
                    f"VALIDATE TR {int(f_val.get('count', 0)):>4}  "
                    f"PF {float(f_val.get('profit_factor') or 0):.2f}  |  "
                    f"quarters>1: {f_q}/4\n"
                    f"  Verdict:  {verdict}"
                    + ("  (deadline hit mid-search)" if hit_deadline else "")
                )

                if accepted:
                    for c in accepted:
                        pair_block["strategies"][strategy][c["field"]] = c["value"]

                _write_summary(blocks)
                _write_status({
                    "isRunning": True,
                    "pair": pair,
                    "strategy": strategy,
                    "elapsed_s": round(_elapsed(), 1),
                    "variants_tested": _variants_tested,
                })
    finally:
        GLOBAL_PARAMS.adaptive_mode = saved_adaptive
        GLOBAL_PARAMS.use_breakeven = saved_be
        GLOBAL_PARAMS.use_supertrend_trail = saved_trail
        GLOBAL_PARAMS.target_rr = saved_rr

    if invalid_pairs:
        for bad in invalid_pairs:
            suggested["pairs"].pop(bad, None)

    if ok_pairs:
        try:
            save_pair_settings(suggested, path=SUGGESTED_PATH)
            _log(f"suggested file written: {SUGGESTED_PATH}")
        except Exception as e:
            _log(f"WARNING: could not write suggested file: {e}")
    else:
        blocks.append("")
        blocks.append("SUGGESTED FILE NOT WRITTEN — no pair passed the guard.")
        _write_summary(blocks)

    blocks.append("")
    blocks.append("FINAL COMBINED BACKTEST (all ROBUST settings applied together)")
    _write_summary(blocks)

    if ok_pairs:
        try:
            baseline_combined = _run_combined(
                ok_pairs, suggested, OPTIMIZE_WINDOW_DAYS, use_settings=False,
            )
            robust_combined = _run_combined(
                ok_pairs, suggested, OPTIMIZE_WINDOW_DAYS, use_settings=True,
            )
            bk = calculate_kpis(baseline_combined)
            rk = calculate_kpis(robust_combined)
            blocks.append(
                f"  Baseline (defaults):   TR {int(bk.get('count', 0))}  "
                f"PF {float(bk.get('profit_factor') or 0):.2f}  "
                f"PnL ${float(bk.get('net_pnl') or 0):.2f}  "
                f"Max DD ${float(bk.get('max_dd_money') or 0):.2f}"
            )
            blocks.append(
                f"  With ROBUST settings:  TR {int(rk.get('count', 0))}  "
                f"PF {float(rk.get('profit_factor') or 0):.2f}  "
                f"PnL ${float(rk.get('net_pnl') or 0):.2f}  "
                f"Max DD ${float(rk.get('max_dd_money') or 0):.2f}"
            )
        except Exception as e:
            blocks.append(f"  FAILED: {e}")
            traceback.print_exc()
    else:
        blocks.append("  SKIPPED — no pair passed the guard.")

    blocks.append("")
    blocks.append(f"Variants tested: {_variants_tested}")
    blocks.append(f"Elapsed: {round(_elapsed(), 1)}s")
    if invalid_pairs:
        blocks.append(f"Pairs failing the baseline guard: {', '.join(invalid_pairs)}")
    blocks.append(f"Suggested file: {SUGGESTED_PATH if ok_pairs else '(not written)'}")
    blocks.append("")
    blocks.append(
        "HOW TO READ THIS:\n"
        "  * ROBUST means the change passed all four validation rules.\n"
        "  * NO CHANGE means nothing qualified.\n"
        "  * SKIPPED means there was not enough data or the time budget ran out.\n"
        "  * BASELINE MISMATCH means the optimizer's trade count for the pair did not\n"
        "    match the six-combination summary. That pair is left untouched.\n"
        "  * The suggested file does NOT overwrite your live file. Copy it in only\n"
        "    after reviewing this summary."
    )

    if invalid_pairs:
        header = [
            f"OPTIMIZER INVALID — BASELINE GUARD FAILED FOR: {', '.join(invalid_pairs)}",
            "",
        ]
        blocks = header + blocks

    _write_summary(blocks)

    try:
        os.makedirs(os.path.dirname(SUMMARY_JSON_PATH), exist_ok=True)
        with open(SUMMARY_JSON_PATH, "w", encoding="utf-8") as f:
            json.dump({
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "variants_tested": _variants_tested,
                "elapsed_s": round(_elapsed(), 1),
                "suggested_file": SUGGESTED_PATH if ok_pairs else None,
                "summary_file": SUMMARY_PATH,
                "invalid_pairs": invalid_pairs,
                "ok_pairs": ok_pairs,
                "text": "\n".join(blocks),
            }, f, indent=2)
    except Exception:
        pass

    _write_status({
        "isRunning": False,
        "elapsed_s": round(_elapsed(), 1),
        "variants_tested": _variants_tested,
        "suggested_file": SUGGESTED_PATH if ok_pairs else None,
        "summary_file": SUMMARY_PATH,
        "invalid_pairs": invalid_pairs,
    })

    _log(f"done. {_variants_tested} variants tested in {round(_elapsed(), 1)}s")
    return True


if __name__ == "__main__":
    run_optimizer()