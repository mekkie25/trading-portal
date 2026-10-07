"""
backtest/runner.py
Six-combination matrix runner with per-strategy signal caching.

Combinations per pair (Adaptive only):
  BE off · R:R 1:1, 1:2, 1:3
  BE on  · R:R 1:1, 1:2, 1:3

Caching layers
--------------
1. Level store (backtest/levels_store.py): the precomputed levels, EMAs and
   volatility metrics per candle. Built once, updated incrementally.
2. Per-strategy signal cache (backtest/signal_cache.py): the raw signal from
   each strategy at each candle, keyed on that strategy's own source hash.
   Editing one strategy invalidates only its cache file.

On a cache-hit run the strategy phase is a dict lookup per candle per
strategy. Editing strategies/foo.py invalidates only that one strategy; the
other seven remain cached.
"""

import sys
import os
import glob
import shutil
import json
import time
import copy
import math
import asyncio
import argparse
import inspect
import tempfile
import numpy as np
import pandas as pd
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, Optional, List

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from strategies.strategy_manager import StrategyManager
from core.session_levels import build_session_levels
from core.indicators import get_session_volume_profile
from core.volatility_engine import volatility_engine
from core.session_config import GLOBAL_PARAMS, TZ_SAST
from backtest.bar_aggregator import ZeroLookAheadAggregator
from backtest.simulator import TradeSimulator, ASSETS
from backtest.report import calculate_kpis
from backtest.downloader import fetch_chunked_bars, build_higher_timeframes_from_m5, CTraderTrendbarPeriod, CTraderClient
from backtest.advisor import generate_improvement_tips
from backtest.paths import DATA_DIR, OUTPUT_DIR
from backtest.diagnostics import compute_diagnostics
from backtest.portfolio import compute_portfolio_correlation, DEFAULT_WHITELIST
from backtest.signal_cache import (
    load_strategy_cache, save_strategy_cache, list_cached_strategies,
    delete_stale_caches, strategy_cache_status,
)

try:
    from backtest.levels_store import build_or_update_store, load_store
    _STORE_AVAILABLE = True
except Exception:
    _STORE_AVAILABLE = False

STORE_TARGET_DAYS = 500
STORE_MAX_DAYS = 550

COMBINATIONS = [
    {"mode": "adaptive", "adaptive_mode": True, "be": "off", "use_be": False,
     "trail": "off", "use_trail": False, "rr": 1.0, "rr_label": "1:1",
     "label": "BE off · R:R 1:1"},
    {"mode": "adaptive", "adaptive_mode": True, "be": "off", "use_be": False,
     "trail": "off", "use_trail": False, "rr": 2.0, "rr_label": "1:2",
     "label": "BE off · R:R 1:2"},
    {"mode": "adaptive", "adaptive_mode": True, "be": "off", "use_be": False,
     "trail": "off", "use_trail": False, "rr": 3.0, "rr_label": "1:3",
     "label": "BE off · R:R 1:3"},
    {"mode": "adaptive", "adaptive_mode": True, "be": "on", "use_be": True,
     "trail": "off", "use_trail": False, "rr": 1.0, "rr_label": "1:1",
     "label": "BE on · R:R 1:1"},
    {"mode": "adaptive", "adaptive_mode": True, "be": "on", "use_be": True,
     "trail": "off", "use_trail": False, "rr": 2.0, "rr_label": "1:2",
     "label": "BE on · R:R 1:2"},
    {"mode": "adaptive", "adaptive_mode": True, "be": "on", "use_be": True,
     "trail": "off", "use_trail": False, "rr": 3.0, "rr_label": "1:3",
     "label": "BE on · R:R 1:3"},
]

_MISS = object()


def sanitize_for_json(obj):
    if obj is None:
        return None
    if isinstance(obj, (bool, str)):
        return obj
    if isinstance(obj, (int, np.integer)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        f = float(obj)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    if isinstance(obj, dict):
        return {str(k): sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize_for_json(v) for v in obj]
    if isinstance(obj, set):
        return [sanitize_for_json(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return [sanitize_for_json(v) for v in obj.tolist()]
    if isinstance(obj, pd.Timestamp):
        return obj.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(obj, datetime):
        return obj.strftime("%Y-%m-%d %H:%M:%S")
    try:
        return sanitize_for_json(float(obj))
    except Exception:
        return str(obj)


def _parse_window_time(s):
    if not s:
        return None
    try:
        return datetime.strptime(str(s).replace("UTC", "").strip(), "%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def _trade_time_utc(t):
    ts = t.get("signal_time_utc")
    if ts:
        try:
            return datetime.strptime(str(ts), "%Y-%m-%d %H:%M:%S")
        except Exception:
            pass
    d = t.get("date")
    if d:
        try:
            return datetime.strptime(str(d), "%Y-%m-%d")
        except Exception:
            pass
    return None


def compute_tune_validate_kpis(trades, w_start, w_end):
    empty = {"count": 0, "win_rate": 0.0, "avg_r": 0.0, "expectancy": 0.0,
             "profit_factor": 0.0, "max_dd_money": 0.0, "net_pnl": 0.0,
             "is_inconclusive": True}
    if not trades:
        return {"tune": dict(empty), "validate": dict(empty), "tune_days": 0.0, "validate_days": 0.0}
    start = _parse_window_time(w_start)
    end = _parse_window_time(w_end)
    if start is None or end is None or end <= start:
        k = calculate_kpis(list(trades))
        return {"tune": k, "validate": dict(empty), "tune_days": 0.0, "validate_days": 0.0}
    total_days = (end - start).total_seconds() / 86400.0
    tune_days = total_days * 0.70
    cutoff = start + timedelta(days=tune_days)
    tune, val = [], []
    for t in trades:
        tt = _trade_time_utc(t)
        if tt is None or tt < cutoff:
            tune.append(t)
        else:
            val.append(t)
    return {
        "tune": calculate_kpis(tune),
        "validate": calculate_kpis(val),
        "tune_days": round(tune_days, 1),
        "validate_days": round(total_days - tune_days, 1),
    }


def _atomic_write_csv(df, target_path):
    dirname = os.path.dirname(target_path)
    fd, tmp = tempfile.mkstemp(dir=dirname, prefix="tmp_", suffix=".csv")
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            df.to_csv(f, index=False)
        os.replace(tmp, target_path)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise


def _report_filename(symbol, combo):
    return f"{symbol}_adaptive_be{combo['be']}_rr{combo['rr_label'].replace(':', '.')}_report.json"


async def ensure_symbol_data(client, symbol):
    m5_path = os.path.join(DATA_DIR, f"{symbol}_M5.csv")
    now_utc = datetime.now(timezone.utc)
    target_start = now_utc - timedelta(days=STORE_TARGET_DAYS)
    max_start = now_utc - timedelta(days=STORE_MAX_DAYS)

    existing = pd.DataFrame()
    old_count = 0
    if os.path.exists(m5_path) and os.path.getsize(m5_path) > 100:
        try:
            existing = pd.read_csv(m5_path)
            if not existing.empty:
                existing['dt'] = pd.to_datetime(existing['time'], utc=True)
                existing.sort_values('dt', inplace=True)
                old_count = len(existing)
        except Exception as e:
            print(f"ERROR: could not read {symbol}_M5.csv ({e}).", flush=True)
            existing = pd.DataFrame()

    chunks = [existing] if not existing.empty else []

    try:
        if existing.empty:
            print(f"[*] Initial download for {symbol}: last {STORE_TARGET_DAYS} days...", flush=True)
            if not client.is_authorized and not await client.connect():
                print(f"ERROR: connect failed for {symbol}.", flush=True)
                return False
            new_df = await fetch_chunked_bars(client, symbol, CTraderTrendbarPeriod.M5, target_start, now_utc)
            if new_df.empty:
                print(f"ERROR: no data for {symbol}.", flush=True)
                return False
            new_df['dt'] = pd.to_datetime(new_df['time'], utc=True)
            chunks.append(new_df)
        else:
            last_bar_time = existing['dt'].iloc[-1].to_pydatetime()
            first_bar_time = existing['dt'].iloc[0].to_pydatetime()

            forward_start = max(target_start, last_bar_time - timedelta(days=1))
            if forward_start < now_utc:
                if not client.is_authorized and not await client.connect():
                    last_d = existing['dt'].iloc[-1].strftime('%Y-%m-%d')
                    print(f"WARNING: broker unavailable, stored data up to {last_d}", flush=True)
                    return True
                fwd = await fetch_chunked_bars(client, symbol, CTraderTrendbarPeriod.M5, forward_start, now_utc)
                if not fwd.empty:
                    fwd['dt'] = pd.to_datetime(fwd['time'], utc=True)
                    chunks.append(fwd)

            if first_bar_time > (target_start + timedelta(days=2)):
                if not client.is_authorized and not await client.connect():
                    return True
                bf_end = first_bar_time + timedelta(days=1)
                bf = await fetch_chunked_bars(client, symbol, CTraderTrendbarPeriod.M5, target_start, bf_end)
                if not bf.empty:
                    bf['dt'] = pd.to_datetime(bf['time'], utc=True)
                    chunks.append(bf)

        combined = pd.concat(chunks, ignore_index=True)
        combined.drop_duplicates(subset=['time'], keep='last', inplace=True)
        combined.sort_values('dt', inplace=True)
        combined = combined[combined['dt'] >= max_start].copy()
        combined.reset_index(drop=True, inplace=True)

        new_count = len(combined)
        added = max(0, new_count - old_count)
        first_d = combined['dt'].iloc[0].strftime('%Y-%m-%d')
        last_d = combined['dt'].iloc[-1].strftime('%Y-%m-%d')

        out_df = combined[['time', 'open', 'high', 'low', 'close', 'volume']].copy()
        _atomic_write_csv(out_df, m5_path)
        build_higher_timeframes_from_m5(out_df, symbol)
        print(f"[{symbol}] {added:,} new bars | total {new_count:,} | {first_d} to {last_d}", flush=True)
        return True

    except Exception as e:
        if not existing.empty:
            last_d = existing['dt'].iloc[-1].strftime('%Y-%m-%d')
            print(f"WARNING: broker unavailable, stored data up to {last_d}", flush=True)
            return True
        print(f"ERROR: store update failed for {symbol} ({e}).", flush=True)
        return False


def compute_121_window_emas(df):
    close = df['close'].values.astype(np.float64)
    n = len(close)
    wsize = 121
    for span in [5, 9, 13, 25, 200]:
        col = f"ema_{span}"
        if col in df.columns:
            continue
        alpha = 2.0 / (span + 1.0)
        weights = np.empty(wsize, dtype=np.float64)
        weights[0] = (1.0 - alpha) ** (wsize - 1)
        for k in range(1, wsize):
            weights[k] = alpha * ((1.0 - alpha) ** (wsize - 1 - k))
        valid = np.convolve(close, weights[::-1], mode='valid')
        arr = np.empty(n, dtype=np.float64)
        arr[:wsize - 1] = np.nan
        arr[wsize - 1:] = valid
        df[col] = arr


def _call_strategy(strat, symbol, m5_slice, h4_view, d1_view, session_levels, h1_view):
    """Invoke one strategy's evaluate with the kwargs its signature accepts."""
    try:
        sig = inspect.signature(strat.evaluate)
        params = sig.parameters
        kwargs = {}
        if 'data_h4' in params: kwargs['data_h4'] = h4_view
        if 'data_d1' in params: kwargs['data_d1'] = d1_view
        if 'session_levels' in params: kwargs['session_levels'] = session_levels
        if 'data_h1' in params: kwargs['data_h1'] = h1_view
        return strat.evaluate(symbol, m5_slice, **kwargs)
    except Exception:
        return None


def precompute_market_pass(symbol, m5_df, h1_df, h4_df, d1_df,
                           sim_start_idx, total_bars, force_recompute=False):
    """
    For every candle in the window, produce the raw signal (via the per-strategy
    cache) plus the shared context needed by the six combinations.
    """
    t0 = time.perf_counter()

    compute_121_window_emas(m5_df)

    sm = StrategyManager()
    strategy_names = [s.__class__.__name__ for s in sm.strategies]

    # Load each strategy's cache if the hash matches.
    strategy_caches: Dict[str, Dict[int, Any]] = {}
    cache_hit_counts: Dict[str, int] = {n: 0 for n in strategy_names}
    cache_miss_counts: Dict[str, int] = {n: 0 for n in strategy_names}
    if not force_recompute:
        for name in strategy_names:
            c = load_strategy_cache(symbol, name)
            if c is not None:
                strategy_caches[name] = c
    # If forced, we keep caches empty so every candle is a miss.

    # Track new entries per strategy to persist at the end.
    new_entries: Dict[str, Dict[int, Any]] = {n: {} for n in strategy_names}

    aggregator = ZeroLookAheadAggregator(d1_df, h4_df, h1_df)
    frozen_orbs: Dict[Any, Any] = {}

    last_d1_len = -1
    last_vol_date = None
    vol_metrics = {"valid": False}
    adr_val = None
    regime = "NORMAL"
    valid_vol_bars = 0

    cached_signals_by_index: Dict[int, Dict[str, Any]] = {}

    m5_times_list = m5_df['time'].tolist()
    total_sim_bars = max(1, total_bars - sim_start_idx)
    next_pct = 20

    strategy_modes = sm._get_strategy_modes()
    permitted = sm.STRATEGY_PERMITTED_ASSETS

    for i in range(sim_start_idx, total_bars):
        curr_time = m5_times_list[i].to_pydatetime()
        curr_bar = m5_df.iloc[i]

        pct = int(((i - sim_start_idx) / total_sim_bars) * 100)
        if pct >= next_pct:
            print(f"[*] {symbol} precompute {next_pct}% ...", flush=True)
            next_pct += 20

        wk = curr_time.weekday()
        if wk == 5 or (wk == 6 and curr_time.hour < 21):
            continue

        epoch = int(curr_time.timestamp())

        # Do all strategies hit cache at this epoch?
        all_hit = True
        for name in strategy_names:
            if name not in strategy_caches or epoch not in strategy_caches[name]:
                all_hit = False
                break

        # We always need the m5 slice for cache misses AND for the simulator
        # context (active_vol / session_levels). The latter is shared per candle.
        m5_slice = m5_df.iloc[max(0, i - 120):i + 1]

        # Compute context if any strategy misses at this candle, OR if the
        # context is not yet in cached_signals_by_index (it isn't for the very
        # first candle or when we need to seed downstream dicts).
        need_context = (not all_hit) or (i not in cached_signals_by_index)

        if need_context:
            h1_view, h4_view, d1_view = aggregator.get_feeds_at_time(m5_slice, curr_time)
            curr_d1_len = len(d1_view)
            curr_date = curr_time.date()
            need_recalc = (curr_d1_len != last_d1_len) or (curr_date != last_vol_date) or not vol_metrics.get("valid", False)
            if need_recalc:
                vol_metrics = volatility_engine.compute_symbol_volatility(
                    d1_df=d1_view, m5_df=m5_slice,
                    current_quote=float(curr_bar['close']),
                    symbol=symbol, as_of=curr_time
                )
                if vol_metrics.get("valid", False):
                    adr_val = vol_metrics.get("adr")
                    regime = vol_metrics.get("regime", "NORMAL")
                last_d1_len = curr_d1_len
                last_vol_date = curr_date

            if vol_metrics.get("valid", False):
                active_vol = volatility_engine.refresh_intraday(
                    vol_metrics=vol_metrics, m5_df=m5_slice,
                    current_quote=float(curr_bar['close']),
                    d1_view=d1_view, as_of=curr_time
                )
                valid_vol_bars += 1
            else:
                active_vol = vol_metrics

            vp = get_session_volume_profile(m5_slice)
            session_levels = build_session_levels(
                symbol=symbol, m5_df=m5_slice, d1_df=d1_view,
                vp_node=vp, frozen_orbs=frozen_orbs,
                as_of=curr_time, adr_val=adr_val
            )
        else:
            # Cached candle. We still need active_vol / session_levels / adr_val /
            # regime to run the combinations. For now, we build them from the
            # same m5_slice. The level store will replace this on a future pass.
            h1_view, h4_view, d1_view = aggregator.get_feeds_at_time(m5_slice, curr_time)
            curr_d1_len = len(d1_view)
            curr_date = curr_time.date()
            if (curr_d1_len != last_d1_len) or (curr_date != last_vol_date):
                vol_metrics = volatility_engine.compute_symbol_volatility(
                    d1_df=d1_view, m5_df=m5_slice,
                    current_quote=float(curr_bar['close']),
                    symbol=symbol, as_of=curr_time
                )
                if vol_metrics.get("valid", False):
                    adr_val = vol_metrics.get("adr")
                    regime = vol_metrics.get("regime", "NORMAL")
                last_d1_len = curr_d1_len
                last_vol_date = curr_date

            if vol_metrics.get("valid", False):
                active_vol = volatility_engine.refresh_intraday(
                    vol_metrics=vol_metrics, m5_df=m5_slice,
                    current_quote=float(curr_bar['close']),
                    d1_view=d1_view, as_of=curr_time
                )
            else:
                active_vol = vol_metrics

            vp = get_session_volume_profile(m5_slice)
            session_levels = build_session_levels(
                symbol=symbol, m5_df=m5_slice, d1_df=d1_view,
                vp_node=vp, frozen_orbs=frozen_orbs,
                as_of=curr_time, adr_val=adr_val
            )

        # Evaluate strategies with per-strategy caching.
        strategy_signals: Dict[str, Any] = {}
        for strat in sm.strategies:
            name = strat.__class__.__name__
            cache = strategy_caches.get(name)
            if cache is not None and epoch in cache:
                strategy_signals[name] = cache[epoch]
                cache_hit_counts[name] += 1
            else:
                sig = _call_strategy(strat, symbol, m5_slice, h4_view, d1_view, session_levels, h1_view)
                strategy_signals[name] = sig
                new_entries[name][epoch] = sig
                cache_miss_counts[name] += 1

        # Apply asset boundary, mode switch, and pick the highest-confidence.
        best = None
        for strat in sm.strategies:
            name = strat.__class__.__name__
            sig = strategy_signals.get(name)
            if sig is None:
                continue
            allowed = permitted.get(sig.strategy, set())
            if sig.symbol not in allowed:
                continue
            mode = strategy_modes.get(sig.strategy, "LIVE")
            if mode == "OFF":
                continue
            setattr(sig, "is_dry_run", mode == "DRY_RUN")
            if best is None or getattr(sig, "confidence", 0.80) > getattr(best, "confidence", 0.80):
                best = sig

        if best is not None:
            cached_signals_by_index[i] = {
                "raw_signal": best,
                "active_vol": active_vol,
                "session_levels": session_levels,
                "adr_val": adr_val,
                "regime": regime,
                "curr_time": curr_time,
            }

    # Persist the cache updates per strategy.
    saved_any = False
    for name in strategy_names:
        if new_entries[name]:
            existing = strategy_caches.get(name, {})
            merged = dict(existing)
            merged.update(new_entries[name])
            if save_strategy_cache(symbol, name, merged):
                saved_any = True

    # Clean up caches for strategies no longer present in StrategyManager.
    delete_stale_caches(symbol, strategy_names)

    elapsed = time.perf_counter() - t0

    hit_total = sum(cache_hit_counts.values())
    miss_total = sum(cache_miss_counts.values())
    print(
        f"[*] {symbol} precompute done in {elapsed:.1f}s | "
        f"strategy lookups hit {hit_total} miss {miss_total} | saved={saved_any}",
        flush=True
    )

    return {
        "cached_signals": cached_signals_by_index,
        "valid_vol_bars": valid_vol_bars,
        "simulated_bars_count": total_sim_bars,
        "timing": {"precompute_s": elapsed},
        "cache_hits": hit_total,
        "cache_misses": miss_total,
    }


def run_cached_combination(symbol, m5_df, precomputed, sim_start_idx, total_bars,
                           combo, days_count, window_start_str, window_end_str,
                           history_days_before_window, balance=1000.0, risk_pct=1.0,
                           eurusd_df=None):
    t_vol = 0.0
    t_sim = 0.0
    t_rep = 0.0

    volatility_engine.reset_rejection_stats()

    adaptive_mode = combo["adaptive_mode"]
    use_be = combo["use_be"]
    use_trail = combo["use_trail"]
    be_label = combo["be"]
    trail_label = combo["trail"]
    mode_str = combo["mode"]
    rr_value = float(combo.get("rr", 1.0))

    GLOBAL_PARAMS.adaptive_mode = adaptive_mode
    GLOBAL_PARAMS.use_breakeven = use_be
    GLOBAL_PARAMS.use_supertrend_trail = use_trail
    GLOBAL_PARAMS.target_rr = rr_value

    sim = TradeSimulator(starting_balance=balance, risk_pct=risk_pct,
                         eurusd_df=eurusd_df, be_mode="FIXED_80")
    cached_signals = precomputed["cached_signals"]
    has_ema200_col = 'ema_200' in m5_df.columns

    unique_setups = 0
    prev_key = None
    funnel = {"unique_setups": 0, "raw_signals_fired": 0, "adapted_signals_passed": 0,
              "vol_filters_blocked": 0, "sim_trades_attempted": 0, "sim_trades_filled": 0}
    vol_block_reasons = {}
    strategy_errors = {}

    # Pre-extract numpy arrays once. Avoid pandas .iloc inside the hot loop.
    m5_times_py = [t.to_pydatetime() for t in m5_df['time']]
    m5_high = m5_df['high'].values
    m5_low = m5_df['low'].values
    m5_close = m5_df['close'].values
    m5_open = m5_df['open'].values
    if has_ema200_col:
        m5_ema200 = m5_df['ema_200'].values
    else:
        m5_ema200 = None

    # Pass an empty DataFrame to the simulator for trail logic (we never trail).
    empty_df = pd.DataFrame()

    for i in range(sim_start_idx, total_bars):
        _t0 = time.perf_counter()
        if sim.open_positions or sim.pending_sl_evaluations:
            candle = pd.Series({
                "time": m5_times_py[i],
                "open": float(m5_open[i]),
                "high": float(m5_high[i]),
                "low": float(m5_low[i]),
                "close": float(m5_close[i]),
            })
            sim.process_candle(symbol, candle, empty_df)
        t_sim += time.perf_counter() - _t0

        if i not in cached_signals:
            continue

        item = cached_signals[i]
        signal = copy.deepcopy(item["raw_signal"])
        active_vol = item["active_vol"]
        session_levels = item["session_levels"]
        adr_val = item["adr_val"]
        regime = item["regime"]

        key = (signal.strategy, signal.direction)
        if key != prev_key:
            unique_setups += 1
        prev_key = key
        funnel["raw_signals_fired"] += 1

        _t0 = time.perf_counter()
        if adaptive_mode:
            if active_vol.get("valid", False):
                adapted = volatility_engine.adapt_signal(signal, active_vol, ui_rr=rr_value, session_levels=session_levels)
                if adapted:
                    funnel["adapted_signals_passed"] += 1
                    spread = ASSETS.get(symbol, {}).get("spread", 0.0001)
                    sl_dist = abs(adapted.entry_price - adapted.stop_loss)
                    tp_dist = abs(adapted.take_profit_2 - adapted.entry_price)
                    ok, msg = volatility_engine.evaluate_volatility_filters(
                        active_vol, spread, sl_dist, tp_dist,
                        adapted.direction, adapted.entry_price, adapted.strategy
                    )
                    if ok:
                        signal = adapted
                    else:
                        funnel["vol_filters_blocked"] += 1
                        reason_clean = msg.split(":")[0].strip() if ":" in msg else msg[:30]
                        vol_block_reasons[reason_clean] = vol_block_reasons.get(reason_clean, 0) + 1
                        signal = None
                else:
                    funnel["vol_filters_blocked"] += 1
                    vol_block_reasons["ADR Stop Clamping / Min RR"] = vol_block_reasons.get("ADR Stop Clamping / Min RR", 0) + 1
                    signal = None
            else:
                funnel["vol_filters_blocked"] += 1
                vol_block_reasons["Invalid Volatility Metrics"] = vol_block_reasons.get("Invalid Volatility Metrics", 0) + 1
                signal = None
        t_vol += time.perf_counter() - _t0

        _t0 = time.perf_counter()
        if signal:
            funnel["sim_trades_attempted"] += 1
            if not any(p["symbol"] == symbol for p in sim.open_positions):
                ema_v = None
                if m5_ema200 is not None:
                    try:
                        v = float(m5_ema200[i])
                        if not math.isnan(v):
                            ema_v = v
                    except Exception:
                        ema_v = None
                if sim.open_trade(signal, item["curr_time"], adr_val, regime, session_levels,
                                  ema_200_value=ema_v):
                    funnel["sim_trades_filled"] += 1
        t_sim += time.perf_counter() - _t0

    _t0 = time.perf_counter()
    if len(m5_df) > 0 and len(sim.open_positions) > 0:
        sim.close_all(symbol, m5_df.iloc[-1])

    funnel["unique_setups"] = unique_setups
    simulated_bars_count = precomputed["simulated_bars_count"]
    valid_vol_bars = precomputed["valid_vol_bars"]
    adaptive_pct = round((valid_vol_bars / max(1, simulated_bars_count)) * 100.0, 1)

    warnings = []
    if adaptive_mode and adaptive_pct < 90.0:
        warnings.append(f"WARNING: ADAPTIVE active on {adaptive_pct:.1f}% of bars")

    all_trades = sim.completed_trades
    df_trades = pd.DataFrame(all_trades)
    global_kpis = calculate_kpis(all_trades)

    if not df_trades.empty:
        df_trades["display_date"] = df_trades["date_sast"].fillna(df_trades["date"]) if "date_sast" in df_trades.columns else df_trades["date"]
    else:
        df_trades["display_date"] = []

    strat_kpis = {}
    dow_kpis = {}
    strat_tv = {}
    if not df_trades.empty:
        for s_name, s_group in df_trades.groupby("strategy"):
            strat_kpis[s_name] = calculate_kpis(s_group.to_dict("records"))
            strat_tv[s_name] = compute_tune_validate_kpis(s_group.to_dict("records"), window_start_str, window_end_str)
        df_trades["weekday"] = pd.to_datetime(df_trades["display_date"]).dt.day_name()
        for dow, dow_group in df_trades.groupby("weekday"):
            dow_kpis[dow] = calculate_kpis(dow_group.to_dict("records"))

    combo_tv = compute_tune_validate_kpis(all_trades, window_start_str, window_end_str)

    m5_df["dt"] = m5_df["time"]
    m5_df["date_sast_str"] = m5_df["dt"].dt.tz_convert(TZ_SAST).dt.strftime("%Y-%m-%d")
    trading_dates = sorted(df_trades["display_date"].unique().tolist()) if not df_trades.empty else []

    day_charts_data = {}
    day_candles_by_date = {}

    for d_str in trading_dates:
        sub_m5 = m5_df[m5_df["date_sast_str"] == d_str]
        candles_list = [
            {"time": int(r["dt"].timestamp()), "open": float(r["open"]), "high": float(r["high"]),
             "low": float(r["low"]), "close": float(r["close"])}
            for _, r in sub_m5.iterrows()
        ]
        day_candles_by_date[d_str] = candles_list
        day_t = df_trades[df_trades["display_date"] == d_str].to_dict("records")
        first_t = day_t[0] if day_t else {}
        ref = first_t.get("ref_levels", {})
        day_charts_data[d_str] = {
            "candles": [], "trades": day_t,
            "levels": {k: ref.get(k) for k in [
                "asia_high", "asia_low", "daily_eq", "daily_pivot",
                "pdh", "pdl", "orb_high", "orb_low"]}
        }

    improvement_tips = generate_improvement_tips(all_trades, symbol, mode_str)
    diag_payload = compute_diagnostics(trades=all_trades, m5_df=m5_df,
                                        sim_start_idx=sim_start_idx, starting_equity=balance)

    run_settings_text = (
        f"mode: {mode_str}, target_rr: {rr_value}, use_breakeven: {GLOBAL_PARAMS.use_breakeven}, "
        f"days: {days_count}, adaptive_effective_pct: {adaptive_pct}%, "
        f"funnel: {json.dumps(funnel)}, vol_block_reasons: {json.dumps(vol_block_reasons)}, "
        f"rejection_stats: {json.dumps(volatility_engine.get_rejection_stats())}"
    )

    skip_summary = sim.skip_summary()

    report_payload = {
        "symbol": symbol, "mode": mode_str, "be": be_label, "trail": trail_label,
        "rr": rr_value, "rr_label": combo.get("rr_label", "1:1"),
        "window_start": window_start_str, "window_end": window_end_str,
        "history_days_before_window": history_days_before_window,
        "adaptive_effective_pct": adaptive_pct,
        "run_settings": run_settings_text, "warnings": warnings,
        "funnel": funnel, "vol_block_reasons": vol_block_reasons,
        "rejection_stats": volatility_engine.get_rejection_stats(),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "global_kpis": global_kpis, "strategy_kpis": strat_kpis, "dow_kpis": dow_kpis,
        "trading_dates": trading_dates, "day_data": day_charts_data,
        "all_trades": all_trades,
        "skipped_summary": skip_summary.get("by_reason", {}),
        "skipped_detail": skip_summary,
        "improvement_tips": improvement_tips,
        "tune_validate": combo_tv, "strategy_tune_validate": strat_tv,
        "diagnostics": diag_payload,
    }

    report_filename = _report_filename(symbol, combo)
    with open(os.path.join(OUTPUT_DIR, report_filename), "w") as f:
        json.dump(sanitize_for_json(report_payload), f, separators=(",", ":"), allow_nan=False)
    t_rep += time.perf_counter() - _t0

    return {
        "report_file": report_filename,
        "payload": report_payload,
        "trades": all_trades,
        "kpis": global_kpis,
        "funnel": funnel,
        "adaptive_pct": adaptive_pct,
        "day_candles": day_candles_by_date,
        "tune_validate": combo_tv,
        "strategy_tune_validate": strat_tv,
        "timing": {"volatility_s": t_vol, "simulator_s": t_sim, "report_writing_s": t_rep},
    }


def write_portfolio_correlation():
    try:
        payload = compute_portfolio_correlation(OUTPUT_DIR, DEFAULT_WHITELIST)
        with open(os.path.join(OUTPUT_DIR, "portfolio_correlation.json"), "w") as f:
            json.dump(sanitize_for_json(payload), f, separators=(",", ":"), allow_nan=False)
        print(f"[✓] portfolio correlation saved", flush=True)
        return True
    except Exception as e:
        print(f"ERROR: portfolio correlation failed: {e}", flush=True)
        return False


async def run_symbol_matrix(client, symbol, days_count, eurusd_df=None, force_recompute=False):
    orig_adaptive = GLOBAL_PARAMS.adaptive_mode
    orig_be = GLOBAL_PARAMS.use_breakeven
    orig_trail = GLOBAL_PARAMS.use_supertrend_trail
    orig_rr = GLOBAL_PARAMS.target_rr

    for pattern in [f"{symbol}_*_report.json", f"{symbol}_summary.json",
                    f"{symbol}_daycandles.json", f"{symbol}_variants.json"]:
        for fpath in glob.glob(os.path.join(OUTPUT_DIR, pattern)):
            try:
                os.remove(fpath)
            except OSError:
                pass

    m5_path = os.path.join(DATA_DIR, f"{symbol}_M5.csv")
    h1_path = os.path.join(DATA_DIR, f"{symbol}_H1.csv")
    h4_path = os.path.join(DATA_DIR, f"{symbol}_H4.csv")
    d1_path = os.path.join(DATA_DIR, f"{symbol}_D1.csv")
    if not all(os.path.exists(p) for p in [m5_path, h1_path, h4_path, d1_path]):
        print(f"ERROR: missing data files for {symbol}.", flush=True)
        return False

    m5_df = pd.read_csv(m5_path)
    h1_df = pd.read_csv(h1_path)
    h4_df = pd.read_csv(h4_path)
    d1_df = pd.read_csv(d1_path)
    m5_df['time'] = pd.to_datetime(m5_df['time'], utc=True)
    total_bars = len(m5_df)
    if total_bars < 130:
        print(f"ERROR: insufficient bars for {symbol}.", flush=True)
        return False

    last_bar_time = m5_df['time'].iloc[-1]
    window_cutoff = last_bar_time - timedelta(days=days_count)
    matching = m5_df.index[m5_df['time'] >= window_cutoff].tolist()
    sim_start_idx = max(120, matching[0]) if matching else max(120, total_bars - 1)

    window_start_str = m5_df['time'].iloc[sim_start_idx].strftime('%Y-%m-%d %H:%M:%S UTC')
    window_end_str = last_bar_time.strftime('%Y-%m-%d %H:%M:%S UTC')
    history_days = max(0, round((m5_df['time'].iloc[sim_start_idx] - m5_df['time'].iloc[0]).total_seconds() / 86400.0, 1))

    # Optional level store update
    if _STORE_AVAILABLE:
        try:
            build_or_update_store(symbol, m5_df, d1_df)
        except Exception as e:
            print(f"[store] {symbol}: skipped ({e})", flush=True)

    print(f"[*] {symbol}: precompute across {total_bars - sim_start_idx:,} candles...", flush=True)
    precomputed = precompute_market_pass(
        symbol=symbol, m5_df=m5_df, h1_df=h1_df, h4_df=h4_df, d1_df=d1_df,
        sim_start_idx=sim_start_idx, total_bars=total_bars,
        force_recompute=force_recompute,
    )

    matrix_rows = []
    all_day_candles = {}
    tot_sim = 0.0
    tot_rep = 0.0
    tot_vol = 0.0

    try:
        for idx, combo in enumerate(COMBINATIONS):
            res = run_cached_combination(
                symbol=symbol, m5_df=m5_df, precomputed=precomputed,
                sim_start_idx=sim_start_idx, total_bars=total_bars,
                combo=combo, days_count=days_count,
                window_start_str=window_start_str, window_end_str=window_end_str,
                history_days_before_window=history_days, eurusd_df=eurusd_df,
            )
            k = res["kpis"]
            timing = res.get("timing", {})
            tot_vol += timing.get("volatility_s", 0.0)
            tot_sim += timing.get("simulator_s", 0.0)
            tot_rep += timing.get("report_writing_s", 0.0)

            matrix_rows.append({
                "label": combo["label"],
                "mode": combo["mode"], "be": combo["be"], "trail": combo["trail"],
                "rr": combo["rr"], "rr_label": combo["rr_label"],
                "report_file": res["report_file"],
                "total_trades": k["count"], "win_rate": k["win_rate"],
                "expectancy": k["expectancy"], "profit_factor": k["profit_factor"],
                "max_drawdown": k["max_dd_money"], "net_pnl": k["net_pnl"],
                "adaptive_effective_pct": res["adaptive_pct"],
                "funnel": res["funnel"], "tune_validate": res["tune_validate"],
            })

            for d_str, c_list in res.get("day_candles", {}).items():
                if d_str not in all_day_candles:
                    all_day_candles[d_str] = c_list

            print(f"[*] {symbol} combo {idx + 1}/6 done", flush=True)

        if all_day_candles:
            with open(os.path.join(OUTPUT_DIR, f"{symbol}_daycandles.json"), "w") as f:
                json.dump(sanitize_for_json(all_day_candles), f, separators=(",", ":"), allow_nan=False)

        precompute_s = precomputed["timing"].get("precompute_s", 0.0)
        total_pair_seconds = round(precompute_s + tot_vol + tot_sim + tot_rep, 1)

        summary_payload = {
            "symbol": symbol, "days": days_count,
            "target_rr": None, "rr_values": [c["rr"] for c in COMBINATIONS],
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            "total_seconds": total_pair_seconds,
            "phase_seconds": {
                "precompute_s": round(precompute_s, 1),
                "volatility_s": round(tot_vol, 1),
                "simulator_s": round(tot_sim, 1),
                "report_writing_s": round(tot_rep, 1),
            },
            "cache": {
                "hits": precomputed.get("cache_hits", 0),
                "misses": precomputed.get("cache_misses", 0),
            },
            "combinations": matrix_rows,
        }

        with open(os.path.join(OUTPUT_DIR, f"{symbol}_summary.json"), "w") as f:
            json.dump(sanitize_for_json(summary_payload), f, separators=(",", ":"), allow_nan=False)

        print(
            f"[time] {symbol} precompute {precompute_s:.1f}s | vol {tot_vol:.1f}s | "
            f"sim {tot_sim:.1f}s | report {tot_rep:.1f}s | Total {total_pair_seconds:.1f}s",
            flush=True
        )
        print(f"[✓] {symbol} matrix complete", flush=True)
        return len(matrix_rows) > 0

    finally:
        GLOBAL_PARAMS.adaptive_mode = orig_adaptive
        GLOBAL_PARAMS.use_breakeven = orig_be
        GLOBAL_PARAMS.use_supertrend_trail = orig_trail
        GLOBAL_PARAMS.target_rr = orig_rr


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, default="US30")
    parser.add_argument("--symbols", type=str, default=None)
    parser.add_argument("--days", type=int, default=60)
    parser.add_argument("--skip-download", action="store_true", default=False)
    parser.add_argument("--prepare-only", action="store_true", default=False)
    parser.add_argument("--portfolio-only", action="store_true", default=False)
    parser.add_argument("--force-recompute", action="store_true", default=False)
    args = parser.parse_args()

    if args.symbols:
        symbols_list = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    else:
        symbols_list = [args.symbol.upper()]

    client = CTraderClient()

    if args.portfolio_only:
        sys.exit(0 if write_portfolio_correlation() else 1)

    if args.prepare_only:
        ok_all = True
        for s in symbols_list:
            if not await ensure_symbol_data(client, s):
                ok_all = False
            if s == "GERMAN30":
                await ensure_symbol_data(client, "EURUSD")
        if client.ws:
            try:
                await client.ws.close()
            except Exception:
                pass
        sys.exit(0 if ok_all else 1)

    usage = shutil.disk_usage(OUTPUT_DIR)
    if usage.free / (1024 * 1024) < 80.0:
        print("ERROR: low disk space.", flush=True)
        sys.exit(1)

    ok_all = True
    for s in symbols_list:
        ok = await ensure_symbol_data(client, s) if not args.skip_download else True
        e = None
        if s == "GERMAN30":
            if not args.skip_download:
                await ensure_symbol_data(client, "EURUSD")
            p = os.path.join(DATA_DIR, "EURUSD_M5.csv")
            if os.path.exists(p):
                try:
                    e = pd.read_csv(p)
                except Exception:
                    e = None
        success = False
        if ok:
            success = await run_symbol_matrix(client, s, args.days, e,
                                              force_recompute=args.force_recompute)
        if not success:
            ok_all = False

    try:
        write_portfolio_correlation()
    except Exception as pe:
        print(f"WARNING: portfolio failed: {pe}", flush=True)

    if client.ws:
        try:
            await client.ws.close()
        except Exception:
            pass

    sys.exit(0 if ok_all else 1)


def print_startup_diagnostics():
    print("=" * 60, flush=True)
    print("BACKTEST STARTUP DIAGNOSTICS", flush=True)
    print("=" * 60, flush=True)
    print(f"Python {sys.version.split()[0]}", flush=True)
    for k in ["CTRADER_CLIENT_ID", "CTRADER_CLIENT_SECRET", "CTRADER_ACCESS_TOKEN", "CTRADER_ACCOUNT_ID"]:
        v = os.environ.get(k, "").strip()
        print(f"{k}: {'SET' if v else 'MISSING'}", flush=True)
    print("=" * 60, flush=True)


if __name__ == "__main__":
    try:
        from dotenv import load_dotenv
        pr = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
        load_dotenv(os.path.join(pr, '.env'))
    except ImportError:
        pass
    print_startup_diagnostics()
    asyncio.run(main())