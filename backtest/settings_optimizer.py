"""
backtest/settings_optimizer.py
Per-strategy, per-pair settings optimizer.

PROPOSED.

WHAT IT DOES
------------
For each (pair, strategy) that has enough historical trades:
  1. Runs the strategy with default settings (current live behaviour).
  2. Tries one setting change at a time from a fixed search space.
  3. Keeps the change that most improves TUNE-period profit factor.
  4. Accepts it ONLY if the honest validation rules pass:
       (a) TUNE >= 30 trades AND VALIDATE >= 30 trades
       (b) VALIDATE PF >= baseline VALIDATE PF + 0.10
       (c) VALIDATE PF > 1.0
       (d) PF > 1.0 in at least 3 of 4 date quarters
  5. Repeats up to 3 accepted changes per (pair, strategy).

OUTPUTS
-------
  config/pair_settings.suggested.json   (never overwrites pair_settings.json)
  backtest/output/optimizer_summary.txt (plain-English summary, also in TXT export)
  backtest/output/optimizer_summary.json

TIME BUDGET
-----------
OPTIMIZER_MAX_SECONDS is a hard wall-clock cap (default 1200 = 20 min).
The optimizer stops when the budget is hit, writes whatever it finished,
and marks unfinished pairs/strategies as SKIPPED in the summary.

HONEST NOTE
-----------
On a warm cache, on 7 pairs x 8 strategies with the search space below,
this optimizer will very likely NOT finish every strategy within 20 minutes.
That is expected. Do not widen the search space to try to make it fit —
narrow it, or run it overnight. The validation rules are the whole point;
skipping them makes the output worthless.

If you want a faster first run, edit SEARCH_SPACE below (it is at the top
of this file) and remove some options. Do not raise OPTIMIZER_MAX_SECONDS
past what your host will actually keep alive.

NOT IN THE HASH
---------------
This file is not part of the backtest signal cache hash. Editing it does
not cold-start the precompute cache.
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

OPTIMIZER_MAX_SECONDS = 1200          # hard wall-clock cap (20 min)
MIN_BASELINE_TRADES = 60              # skip a (pair, strategy) below this
MIN_TRADES_TUNE_VALIDATE = 30         # TUNE and VALIDATE each need this many
MIN_VALIDATE_PF_IMPROVEMENT = 0.10    # VALIDATE PF must improve by this much
MIN_VALIDATE_PF = 1.00                # VALIDATE PF must beat this
MIN_QUARTERS_ABOVE_ONE = 3            # 3 of 4 date quarters must have PF > 1
MAX_ACCEPTED_CHANGES = 3              # per (pair, strategy)
OPTIMIZE_WINDOW_DAYS = 365            # window used for the optimizer itself

# Search space. Each list is the set of values tried for ONE setting.
# Keep this modest. Widening it directly multiplies runtime.
SEARCH_SPACE: Dict[str, List[Any]] = {
    "session_window_sast": [None, "LONDON", "LONDON_NY", "NY", "ALL_DAY"],
    "weekdays": [None, [0, 1, 2, 3, 4], [0, 1, 2, 3], [1, 2, 3, 4]],
    "min_stop_atr": [0.0, 1.0, 2.0],
    "max_stop_atr": [None, 3.0, 5.0],
    "max_spread_in_r": [None, 0.05],
    "rr": [1.0, 1.5, 2.0],
    "be_enabled": [False, True],
    "max_daily_trades": [None, 2],
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


def _settings_equal(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    for k in _blank_settings().keys():
        if a.get(k) != b.get(k):
            return False
    return True


def _pair_from_live(live_settings: Dict[str, Any], pair: str) -> Dict[str, Any]:
    """Return a full, normalised copy of the live settings for one pair."""
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
    """Count date quarters (out of 4) where PF > 1.0 and there were >= 5 trades."""
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
        return pd.read_csv(m5_path), pd.read_csv(d1_path)
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


# ---------------------------------------------------------------------------
# The simulation pass for ONE strategy with ONE candidate setting set
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
    """
    Run one pass of the simulator using ONLY the signals from one strategy,
    filtered by 'settings'. Other strategies are ignored entirely so their
    trades cannot contaminate this strategy's tuning.
    """
    global _variants_tested

    sim = TradeSimulator(starting_balance=balance, risk_pct=risk_pct)
    m5_times_list = m5_df['time'].tolist()
    has_atr14 = 'atr_14' in m5_df.columns
    asset_spread = ASSETS.get(symbol, {}).get("spread", 0.0)

    strat_rr = get_effective_rr(settings, GLOBAL_PARAMS.target_rr)
    strat_be = get_effective_be(settings, False)
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
# Same idea, but ALL strategies with their OWN settings in one pass.
# Used only for the final combined backtest.
# ---------------------------------------------------------------------------

def _simulate_pair_all_strategies(
    symbol: str,
    m5_df: pd.DataFrame,
    cached_signals: Dict[int, Dict[str, Any]],
    sim_start_idx: int,
    total_bars: int,
    strat_settings: Dict[str, Dict[str, Any]],
    balance: float = 1000.0,
    risk_pct: float = 1.0,
) -> List[Dict[str, Any]]:
    sim = TradeSimulator(starting_balance=balance, risk_pct=risk_pct)
    m5_times_list = m5_df['time'].tolist()
    has_atr14 = 'atr_14' in m5_df.columns
    asset_spread = ASSETS.get(symbol, {}).get("spread", 0.0)

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
        s_settings = strat_settings.get(raw.strategy)
        if s_settings is None or not s_settings.get("enabled", True):
            continue
        signal = copy.deepcopy(raw)

        try:
            atr14_val = float(m5_df.iloc[i]['atr_14']) if has_atr14 else 0.0
            if not np.isfinite(atr14_val):
                atr14_val = 0.0
        except Exception:
            atr14_val = 0.0

        passes, _ = passes_signal_filters(s_settings, signal, curr_time, atr14_val, asset_spread)
        if not passes:
            continue

        active_vol = item["active_vol"]
        if not active_vol.get("valid", False):
            continue

        strat_rr = get_effective_rr(s_settings, GLOBAL_PARAMS.target_rr)
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

        strat_cap = get_effective_max_daily(s_settings, 0)
        if strat_cap is not None and strat_cap <= 0:
            strat_cap = None

        sim.open_trade(
            adapted, curr_time, item["adr_val"], item["regime"], item["session_levels"],
            use_breakeven_override=get_effective_be(s_settings, False),
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
    """
    Returns a dict with: settings, trades, tv, accepted, verdict, hit_deadline.
    """
    global _variants_tested

    current = _blank_settings()
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
                strat_settings[s] = block if block else _blank_settings()
            else:
                strat_settings[s] = _blank_settings()

        trades = _simulate_pair_all_strategies(
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

    blocks: List[str] = []
    blocks.append("OPTIMIZER SUMMARY")
    blocks.append(f"Started: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    blocks.append(f"Symbols: {', '.join(symbols_list)}")
    blocks.append(f"Window per pair: {OPTIMIZE_WINDOW_DAYS} days")
    blocks.append(f"Max wall clock: {OPTIMIZER_MAX_SECONDS}s")
    blocks.append(f"Rules: TUNE>=30 trades, VALIDATE>=30 trades, "
                  f"VALIDATE PF >= baseline + {MIN_VALIDATE_PF_IMPROVEMENT:.2f}, "
                  f"VALIDATE PF > {MIN_VALIDATE_PF:.2f}, "
                  f"PF > 1.0 in {MIN_QUARTERS_ABOVE_ONE}/4 quarters")
    blocks.append("")
    _write_summary(blocks)

    _log(f"starting, symbols={symbols_list}, budget={OPTIMIZER_MAX_SECONDS}s")

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

        m5_df['time'] = pd.to_datetime(m5_df['time'], utc=True)
        sim_start_idx, total_bars, ws, we = _window_bounds(m5_df, OPTIMIZE_WINDOW_DAYS)
        if total_bars < 200:
            blocks.append(f"[{pair}] SKIPPED — only {total_bars} bars.")
            _write_summary(blocks)
            continue

        cached = _try_load_precompute(pair, sim_start_idx, total_bars)
        if cached is None:
            _log(f"pair {pair}: building precompute cache (cold; this is the slow part)")
            blocks.append(f"[{pair}] building precompute cache (cold)...")
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
            compute_121_window_emas(m5_df)
            compute_atr14_series(m5_df)

        cached_signals = cached.get("cached_signals") or {}
        if not cached_signals:
            blocks.append(f"[{pair}] SKIPPED — no cached signals.")
            _write_summary(blocks)
            continue

        _log(f"pair {pair}: starting strategy loop")

        for strategy in STRATEGY_NAMES:
            if _over_budget(deadline):
                blocks.append(f"[{pair} / {strategy}] SKIPPED — over time budget.")
                _write_summary(blocks)
                continue

            # Baseline count check (cheap simulation with default settings)
            try:
                baseline_trades = _simulate_strategy_pass(
                    pair, m5_df, cached_signals, sim_start_idx, total_bars,
                    strategy, _blank_settings(),
                )
                _variants_tested += 1
            except Exception as e:
                blocks.append(f"[{pair} / {strategy}] baseline FAILED: {e}")
                _write_summary(blocks)
                continue

            if len(baseline_trades) < MIN_BASELINE_TRADES:
                blocks.append(
                    f"[{pair} / {strategy}] SKIPPED — baseline only "
                    f"{len(baseline_trades)} trades (need >= {MIN_BASELINE_TRADES})."
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

            b_tv = compute_tune_validate_kpis(baseline_trades, ws, we)
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

    # ---- write suggested file ----
    try:
        save_pair_settings(suggested, path=SUGGESTED_PATH)
        _log(f"suggested file written: {SUGGESTED_PATH}")
    except Exception as e:
        _log(f"WARNING: could not write suggested file: {e}")

    # ---- final combined backtest ----
    blocks.append("")
    blocks.append("FINAL COMBINED BACKTEST (all ROBUST settings applied together)")
    _write_summary(blocks)

    try:
        baseline_combined = _run_combined(
            symbols_list, suggested, OPTIMIZE_WINDOW_DAYS, use_settings=False,
        )
        robust_combined = _run_combined(
            symbols_list, suggested, OPTIMIZE_WINDOW_DAYS, use_settings=True,
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

    blocks.append("")
    blocks.append(f"Variants tested: {_variants_tested}")
    blocks.append(f"Elapsed: {round(_elapsed(), 1)}s")
    blocks.append(f"Suggested file: {SUGGESTED_PATH}")
    blocks.append("")
    blocks.append(
        "HOW TO READ THIS:\n"
        "  * ROBUST means the change passed all four validation rules.\n"
        "  * NO CHANGE means nothing qualified — the strategy stays at defaults.\n"
        "  * SKIPPED means there was not enough data or the time budget ran out.\n"
        "  * The suggested file does NOT overwrite your live file. Copy it in only\n"
        "    after reviewing this summary."
    )
    _write_summary(blocks)

    # Mirror to JSON for the panel
    try:
        os.makedirs(os.path.dirname(SUMMARY_JSON_PATH), exist_ok=True)
        with open(SUMMARY_JSON_PATH, "w", encoding="utf-8") as f:
            json.dump({
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "variants_tested": _variants_tested,
                "elapsed_s": round(_elapsed(), 1),
                "suggested_file": SUGGESTED_PATH,
                "summary_file": SUMMARY_PATH,
                "text": "\n".join(blocks),
            }, f, indent=2)
    except Exception:
        pass

    _write_status({
        "isRunning": False,
        "elapsed_s": round(_elapsed(), 1),
        "variants_tested": _variants_tested,
        "suggested_file": SUGGESTED_PATH,
        "summary_file": SUMMARY_PATH,
    })

    _log(f"done. {_variants_tested} variants tested in {round(_elapsed(), 1)}s")
    return True


if __name__ == "__main__":
    run_optimizer()