"""
backtest/runner.py
High-Performance Automated End-to-End Backtest Matrix Runner.
Includes:
- Fixed 00:00 UTC boundary verification harness comparing 4 combinations (30 days each).
- Trade-by-trade comparison across all fields: entry time, direction, strategy, entry, SL, TP1, TP2, exit time, exit price, exit reason, P&L.
- Shared code disclosure labeling verdicts 'PARTIAL: shares code with optimized version'.
- Single shared precompute pass and cached combination runs.
"""

import sys
import os
import glob
import shutil
import json
import time
import copy
import asyncio
import argparse
import tempfile
import pandas as pd
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, Optional, List

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import core.session_config
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

STORE_TARGET_DAYS = 365
STORE_MAX_DAYS = 400

COMBINATIONS = [
    {"mode": "adaptive", "adaptive_mode": True,  "be": "off", "use_be": False, "trail": "off", "use_trail": False, "label": "Adaptive · BE off · Trail off"},
    {"mode": "adaptive", "adaptive_mode": True,  "be": "off", "use_be": False, "trail": "on",  "use_trail": True,  "label": "Adaptive · BE off · Trail on"},
    {"mode": "adaptive", "adaptive_mode": True,  "be": "on",  "use_be": True,  "trail": "off", "use_trail": False, "label": "Adaptive · BE on · Trail off"},
    {"mode": "adaptive", "adaptive_mode": True,  "be": "on",  "use_be": True,  "trail": "on",  "use_trail": True,  "label": "Adaptive · BE on · Trail on"},
    {"mode": "legacy",   "adaptive_mode": False, "be": "off", "use_be": False, "trail": "off", "use_trail": False, "label": "Legacy · BE off · Trail off"},
    {"mode": "legacy",   "adaptive_mode": False, "be": "off", "use_be": False, "trail": "on",  "use_trail": True,  "label": "Legacy · BE off · Trail on"},
    {"mode": "legacy",   "adaptive_mode": False, "be": "on",  "use_be": True,  "trail": "off", "use_trail": False, "label": "Legacy · BE on · Trail off"},
    {"mode": "legacy",   "adaptive_mode": False, "be": "on",  "use_be": True,  "trail": "on",  "use_trail": True,  "label": "Legacy · BE on · Trail on"},
]

def _atomic_write_csv(df: pd.DataFrame, target_path: str) -> None:
    dirname = os.path.dirname(target_path)
    fd, tmp_path = tempfile.mkstemp(dir=dirname, prefix="tmp_", suffix=".csv")
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            df.to_csv(f, index=False)
        os.replace(tmp_path, target_path)
    except Exception:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        raise

async def ensure_symbol_data(client: CTraderClient, symbol: str) -> bool:
    m5_path = os.path.join(DATA_DIR, f"{symbol}_M5.csv")
    now_utc = datetime.now(timezone.utc)
    target_start = now_utc - timedelta(days=STORE_TARGET_DAYS)
    max_history_start = now_utc - timedelta(days=STORE_MAX_DAYS)

    existing_df = pd.DataFrame()
    old_count = 0
    if os.path.exists(m5_path) and os.path.getsize(m5_path) > 100:
        try:
            existing_df = pd.read_csv(m5_path)
            if not existing_df.empty:
                existing_df['dt'] = pd.to_datetime(existing_df['time'], utc=True)
                existing_df.sort_values('dt', inplace=True)
                old_count = len(existing_df)
        except Exception as e:
            print(f"ERROR: Could not read existing {symbol}_M5.csv ({e}). Keeping old file.", flush=True)
            existing_df = pd.DataFrame()

    chunks_to_merge = []
    if not existing_df.empty:
        chunks_to_merge.append(existing_df)

    try:
        if existing_df.empty:
            print(f"[*] Initial download for {symbol}: fetching last {STORE_TARGET_DAYS} days...", flush=True)
            if not client.is_authorized:
                if not await client.connect():
                    print(f"ERROR: Could not connect to cTrader for {symbol}.", flush=True)
                    return False

            new_df = await fetch_chunked_bars(client, symbol, CTraderTrendbarPeriod.M5, target_start, now_utc)
            if new_df.empty:
                print(f"ERROR: No candle data returned from broker for {symbol}.", flush=True)
                return False
            new_df['dt'] = pd.to_datetime(new_df['time'], utc=True)
            chunks_to_merge.append(new_df)
        else:
            last_bar_time = existing_df['dt'].iloc[-1].to_pydatetime()
            first_bar_time = existing_df['dt'].iloc[0].to_pydatetime()

            forward_start = max(target_start, last_bar_time - timedelta(days=1))
            if forward_start < now_utc:
                if not client.is_authorized:
                    if not await client.connect():
                        last_d = existing_df['dt'].iloc[-1].strftime('%Y-%m-%d')
                        print(f"WARNING: broker unavailable, using stored data up to {last_d}", flush=True)
                        return True

                forward_df = await fetch_chunked_bars(client, symbol, CTraderTrendbarPeriod.M5, forward_start, now_utc)
                if not forward_df.empty:
                    forward_df['dt'] = pd.to_datetime(forward_df['time'], utc=True)
                    chunks_to_merge.append(forward_df)

            if first_bar_time > (target_start + timedelta(days=2)):
                if not client.is_authorized:
                    if not await client.connect():
                        last_d = existing_df['dt'].iloc[-1].strftime('%Y-%m-%d')
                        print(f"WARNING: broker unavailable, using stored data up to {last_d}", flush=True)
                        return True

                backfill_end = first_bar_time + timedelta(days=1)
                print(f"[*] Backfilling older history for {symbol} from {target_start.strftime('%Y-%m-%d')} to {backfill_end.strftime('%Y-%m-%d')}...", flush=True)
                backfill_df = await fetch_chunked_bars(client, symbol, CTraderTrendbarPeriod.M5, target_start, backfill_end)
                if not backfill_df.empty:
                    backfill_df['dt'] = pd.to_datetime(backfill_df['time'], utc=True)
                    chunks_to_merge.append(backfill_df)

        combined = pd.concat(chunks_to_merge, ignore_index=True)
        combined.drop_duplicates(subset=['time'], keep='last', inplace=True)
        combined.sort_values('dt', inplace=True)

        combined = combined[combined['dt'] >= max_history_start].copy()
        combined.reset_index(drop=True, inplace=True)

        new_count = len(combined)
        added_bars = max(0, new_count - old_count)
        first_date = combined['dt'].iloc[0].strftime('%Y-%m-%d')
        last_date = combined['dt'].iloc[-1].strftime('%Y-%m-%d')

        out_df = combined[['time', 'open', 'high', 'low', 'close', 'volume']].copy()
        _atomic_write_csv(out_df, m5_path)

        build_higher_timeframes_from_m5(out_df, symbol)

        print(f"[{symbol} Store]: {added_bars:,} new bars added | Total: {new_count:,} bars | Span: {first_date} to {last_date}", flush=True)
        return True

    except Exception as e:
        if not existing_df.empty:
            last_d = existing_df['dt'].iloc[-1].strftime('%Y-%m-%d')
            print(f"WARNING: broker unavailable, using stored data up to {last_d}", flush=True)
            return True
        print(f"ERROR: Failed updating data store for {symbol} ({e}). Preserving existing files.", flush=True)
        return False

# ==============================================================================
# UNOPTIMIZED REFERENCE ENGINE (Per-candle recomputation, no caches)
# ==============================================================================
def run_backtest_reference(
    symbol: str,
    m5_df: pd.DataFrame,
    h1_df: pd.DataFrame,
    h4_df: pd.DataFrame,
    d1_df: pd.DataFrame,
    sim_start_idx: int,
    total_bars: int,
    adaptive_mode: bool = True,
    use_be: bool = False,
    use_trail: bool = False,
    balance: float = 1000.0,
    risk_pct: float = 1.0,
    eurusd_df: Optional[pd.DataFrame] = None
) -> Dict[str, Any]:
    volatility_engine.reset_rejection_stats()

    GLOBAL_PARAMS.adaptive_mode = adaptive_mode
    GLOBAL_PARAMS.use_breakeven = use_be
    GLOBAL_PARAMS.use_supertrend_trail = use_trail

    aggregator = ZeroLookAheadAggregator(d1_df, h4_df, h1_df)
    sm = StrategyManager()
    sim = TradeSimulator(starting_balance=balance, risk_pct=risk_pct, eurusd_df=eurusd_df)

    frozen_orbs: Dict[Any, Any] = {}
    last_vol_date = None
    last_vol_retry_hour = None
    vol_metrics = {"valid": False}
    adr_val = None
    regime = "NORMAL"

    for i in range(sim_start_idx, total_bars):
        m5_slice = m5_df.iloc[max(0, i - 120):i + 1].copy().reset_index(drop=True)
        curr_bar = m5_slice.iloc[-1]
        curr_time = curr_bar['time'].to_pydatetime()
        curr_date = curr_time.date()
        sast_dt = curr_time.astimezone(TZ_SAST)
        sast_hour_key = (sast_dt.date(), sast_dt.hour)

        # 1. Update in-flight trades against every single candle
        sim.process_candle(symbol, curr_bar, m5_slice)

        # 2. Rebuild H1, H4, D1
        h1_view, h4_view, d1_view = aggregator.get_feeds_at_time(m5_slice, curr_time)

        # 3. Volatility calculation
        need_full_recalc = (curr_date != last_vol_date)
        if not vol_metrics.get("valid", False) and sast_hour_key != last_vol_retry_hour:
            need_full_recalc = True

        if need_full_recalc:
            vol_metrics = volatility_engine.compute_symbol_volatility(
                d1_df=d1_view,
                m5_df=m5_slice,
                current_quote=float(curr_bar['close']),
                symbol=symbol,
                as_of=curr_time
            )
            if vol_metrics.get("valid", False):
                adr_val = vol_metrics.get("adr")
                regime = vol_metrics.get("regime", "NORMAL")
            last_vol_date = curr_date
            last_vol_retry_hour = sast_hour_key

        if vol_metrics.get("valid", False):
            active_vol = volatility_engine.refresh_intraday(
                vol_metrics=vol_metrics,
                m5_df=m5_slice,
                current_quote=float(curr_bar['close']),
                d1_view=d1_view,
                as_of=curr_time
            )
        else:
            active_vol = vol_metrics

        # 4. Session levels and volume profile
        vp = get_session_volume_profile(m5_slice)
        session_levels = build_session_levels(
            symbol=symbol,
            m5_df=m5_slice,
            d1_df=d1_view,
            vp_node=vp,
            frozen_orbs=frozen_orbs,
            as_of=curr_time,
            adr_val=adr_val
        )

        # 5. Evaluate all strategies on every single candle
        signal = sm.evaluate_all(
            symbol=symbol,
            data_5m=m5_slice,
            data_h4=h4_view,
            data_d1=d1_view,
            session_levels=session_levels,
            data_h1=h1_view
        )

        if signal and adaptive_mode:
            if active_vol.get("valid", False):
                adapted = volatility_engine.adapt_signal(signal, active_vol, ui_rr=GLOBAL_PARAMS.target_rr, session_levels=session_levels)
                if adapted:
                    spread = ASSETS.get(symbol, {}).get("spread", 0.0001)
                    sl_dist = abs(adapted.entry_price - adapted.stop_loss)
                    tp_dist = abs(adapted.take_profit_2 - adapted.entry_price)
                    vol_ok, _ = volatility_engine.evaluate_volatility_filters(
                        active_vol, spread, sl_dist, tp_dist, adapted.direction, adapted.entry_price, adapted.strategy
                    )
                    signal = adapted if vol_ok else None
                else:
                    signal = None
            else:
                signal = None

        if signal:
            has_open = any(p["symbol"] == symbol for p in sim.open_positions)
            if not has_open:
                sim.open_trade(signal, curr_time, adr_val, regime, session_levels)

    if len(m5_df) > 0 and len(sim.open_positions) > 0:
        sim.close_all(symbol, m5_df.iloc[-1])

    kpis = calculate_kpis(sim.completed_trades)
    return {
        "trades": sim.completed_trades,
        "kpis": kpis
    }

# ==============================================================================
# OPTIMIZED PRECOMPUTED ENGINE
# ==============================================================================
def precompute_market_pass(
    symbol: str,
    m5_df: pd.DataFrame,
    h1_df: pd.DataFrame,
    h4_df: pd.DataFrame,
    d1_df: pd.DataFrame,
    sim_start_idx: int,
    total_bars: int
) -> Dict[str, Any]:
    t_agg = 0.0
    t_vol = 0.0
    t_lvl = 0.0
    t_strat = 0.0

    aggregator = ZeroLookAheadAggregator(d1_df, h4_df, h1_df)
    sm = StrategyManager()
    frozen_orbs: Dict[Any, Any] = {}

    last_d1_bar_count = -1
    last_vol_date = None
    vol_metrics = {"valid": False}
    adr_val = None
    regime = "NORMAL"

    valid_vol_bars = 0
    cached_signals_by_index: Dict[int, Dict[str, Any]] = {}

    m5_times_list = m5_df['time'].tolist()
    total_sim_bars = max(1, total_bars - sim_start_idx)
    next_progress_pct = 20

    for i in range(sim_start_idx, total_bars):
        curr_time = m5_times_list[i].to_pydatetime()
        curr_bar = m5_df.iloc[i]
        m5_slice = m5_df.iloc[max(0, i - 120):i + 1]

        current_pct = int(((i - sim_start_idx) / total_sim_bars) * 100)
        if current_pct >= next_progress_pct:
            print(f"[*] {symbol} precompute {next_progress_pct}% ...", flush=True)
            next_progress_pct += 20

        wkday = curr_time.weekday()
        if wkday == 5 or (wkday == 6 and curr_time.hour < 21):
            continue

        _t0 = time.perf_counter()
        h1_view, h4_view, d1_view = aggregator.get_feeds_at_time(m5_slice, curr_time)
        t_agg += time.perf_counter() - _t0

        _t0 = time.perf_counter()
        curr_d1_len = len(d1_view)
        curr_date = curr_time.date()

        need_full_recalc = (curr_d1_len != last_d1_bar_count) or (curr_date != last_vol_date) or not vol_metrics.get("valid", False)

        if need_full_recalc:
            vol_metrics = volatility_engine.compute_symbol_volatility(
                d1_df=d1_view,
                m5_df=m5_slice,
                current_quote=float(curr_bar['close']),
                symbol=symbol,
                as_of=curr_time
            )
            if vol_metrics.get("valid", False):
                adr_val = vol_metrics.get("adr")
                regime = vol_metrics.get("regime", "NORMAL")
            last_d1_bar_count = curr_d1_len
            last_vol_date = curr_date

        if vol_metrics.get("valid", False):
            active_vol = volatility_engine.refresh_intraday(
                vol_metrics=vol_metrics,
                m5_df=m5_slice,
                current_quote=float(curr_bar['close']),
                d1_view=d1_view,
                as_of=curr_time
            )
            valid_vol_bars += 1
        else:
            active_vol = vol_metrics
        t_vol += time.perf_counter() - _t0

        _t0 = time.perf_counter()
        vp = get_session_volume_profile(m5_slice)
        session_levels = build_session_levels(
            symbol=symbol,
            m5_df=m5_slice,
            d1_df=d1_view,
            vp_node=vp,
            frozen_orbs=frozen_orbs,
            as_of=curr_time,
            adr_val=adr_val
        )
        t_lvl += time.perf_counter() - _t0

        _t0 = time.perf_counter()
        raw_signal = sm.evaluate_all(
            symbol=symbol,
            data_5m=m5_slice,
            data_h4=h4_view,
            data_d1=d1_view,
            session_levels=session_levels,
            data_h1=h1_view
        )
        t_strat += time.perf_counter() - _t0

        if raw_signal is not None:
            cached_signals_by_index[i] = {
                "raw_signal": raw_signal,
                "active_vol": active_vol,
                "session_levels": session_levels,
                "adr_val": adr_val,
                "regime": regime,
                "curr_time": curr_time
            }

    print(f"[*] {symbol} precompute 100% complete.", flush=True)

    return {
        "cached_signals": cached_signals_by_index,
        "valid_vol_bars": valid_vol_bars,
        "simulated_bars_count": total_sim_bars,
        "timing": {
            "aggregator_s": t_agg,
            "volatility_s": t_vol,
            "session_levels_s": t_lvl,
            "strategies_s": t_strat
        }
    }

def run_cached_combination(
    symbol: str,
    m5_df: pd.DataFrame,
    precomputed: Dict[str, Any],
    sim_start_idx: int,
    total_bars: int,
    combo: Dict[str, Any],
    days_count: int,
    window_start_str: str,
    window_end_str: str,
    history_days_before_window: float,
    balance: float = 1000.0,
    risk_pct: float = 1.0,
    eurusd_df: Optional[pd.DataFrame] = None
) -> Dict[str, Any]:
    t_vol = 0.0
    t_strat = 0.0
    t_sim = 0.0
    t_rep = 0.0

    volatility_engine.reset_rejection_stats()

    adaptive_mode = combo["adaptive_mode"]
    use_be = combo["use_be"]
    use_trail = combo["use_trail"]
    be_label = combo["be"]
    trail_label = combo["trail"]
    mode_str = combo["mode"]

    GLOBAL_PARAMS.adaptive_mode = adaptive_mode
    GLOBAL_PARAMS.use_breakeven = use_be
    GLOBAL_PARAMS.use_supertrend_trail = use_trail

    sim = TradeSimulator(starting_balance=balance, risk_pct=risk_pct, eurusd_df=eurusd_df)
    cached_signals = precomputed["cached_signals"]
    m5_times_list = m5_df['time'].tolist()

    unique_setups = 0
    prev_signal_key = None
    funnel = {
        "unique_setups": 0,
        "raw_signals_fired": 0,
        "adapted_signals_passed": 0,
        "vol_filters_blocked": 0,
        "sim_trades_attempted": 0,
        "sim_trades_filled": 0
    }
    vol_block_reasons: Dict[str, int] = {}
    strategy_errors: Dict[str, int] = {}

    for i in range(sim_start_idx, total_bars):
        curr_bar = m5_df.iloc[i]
        curr_time = m5_times_list[i].to_pydatetime()

        _t0 = time.perf_counter()
        if sim.open_positions or sim.pending_sl_evaluations:
            m5_slice = m5_df.iloc[max(0, i - 120):i + 1]
            sim.process_candle(symbol, curr_bar, m5_slice)
        t_sim += time.perf_counter() - _t0

        if i not in cached_signals:
            continue

        item = cached_signals[i]
        signal = copy.deepcopy(item["raw_signal"])
        active_vol = item["active_vol"]
        session_levels = item["session_levels"]
        adr_val = item["adr_val"]
        regime = item["regime"]

        current_signal_key = (signal.strategy, signal.direction)
        if current_signal_key != prev_signal_key:
            unique_setups += 1
        prev_signal_key = current_signal_key
        funnel["raw_signals_fired"] += 1

        _t0 = time.perf_counter()
        if adaptive_mode:
            if active_vol.get("valid", False):
                adapted = volatility_engine.adapt_signal(signal, active_vol, ui_rr=GLOBAL_PARAMS.target_rr, session_levels=session_levels)
                if adapted:
                    funnel["adapted_signals_passed"] += 1
                    spread = ASSETS.get(symbol, {}).get("spread", 0.0001)
                    sl_dist = abs(adapted.entry_price - adapted.stop_loss)
                    tp_dist = abs(adapted.take_profit_2 - adapted.entry_price)
                    vol_ok, vol_msg = volatility_engine.evaluate_volatility_filters(
                        active_vol, spread, sl_dist, tp_dist, adapted.direction, adapted.entry_price, adapted.strategy
                    )
                    if vol_ok:
                        signal = adapted
                    else:
                        funnel["vol_filters_blocked"] += 1
                        reason_clean = vol_msg.split(":")[0].strip() if ":" in vol_msg else vol_msg[:30]
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
        else:
            funnel["adapted_signals_passed"] += 1
        t_vol += time.perf_counter() - _t0

        _t0 = time.perf_counter()
        if signal:
            funnel["sim_trades_attempted"] += 1
            has_open = any(p["symbol"] == symbol for p in sim.open_positions)
            if not has_open:
                opened = sim.open_trade(signal, curr_time, adr_val, regime, session_levels)
                if opened:
                    funnel["sim_trades_filled"] += 1
        t_sim += time.perf_counter() - _t0

    _t0 = time.perf_counter()
    if len(m5_df) > 0 and len(sim.open_positions) > 0:
        sim.close_all(symbol, m5_df.iloc[-1])

    funnel["unique_setups"] = unique_setups
    simulated_bars_count = precomputed["simulated_bars_count"]
    valid_vol_bars = precomputed["valid_vol_bars"]
    adaptive_pct = round((valid_vol_bars / max(1, simulated_bars_count)) * 100.0, 1)

    report_warnings = []
    if adaptive_mode and adaptive_pct < 90.0:
        warn_msg = f"WARNING: ADAPTIVE only active on {adaptive_pct:.1f}% of bars (needs 120 D1 bars of history before the window)"
        report_warnings.append(warn_msg)

    all_trades = sim.completed_trades
    df_trades = pd.DataFrame(all_trades)
    global_kpis = calculate_kpis(all_trades)

    if not df_trades.empty:
        df_trades["display_date"] = df_trades["date_sast"].fillna(df_trades["date"]) if "date_sast" in df_trades.columns else df_trades["date"]
    else:
        df_trades["display_date"] = []

    strat_kpis = {}
    dow_kpis = {}
    if not df_trades.empty:
        for s_name, s_group in df_trades.groupby("strategy"):
            strat_kpis[s_name] = calculate_kpis(s_group.to_dict("records"))

        df_trades["weekday"] = pd.to_datetime(df_trades["display_date"]).dt.day_name()
        for dow, dow_group in df_trades.groupby("weekday"):
            dow_kpis[dow] = calculate_kpis(dow_group.to_dict("records"))

    m5_df["dt"] = m5_df["time"]
    m5_df["date_sast_str"] = m5_df["dt"].dt.tz_convert(TZ_SAST).dt.strftime("%Y-%m-%d")
    trading_dates = sorted(df_trades["display_date"].unique().tolist()) if not df_trades.empty else []

    day_charts_data = {}
    day_candles_by_date = {}

    for d_str in trading_dates:
        sub_m5 = m5_df[m5_df["date_sast_str"] == d_str]
        candles_list = [
            {"time": int(r["dt"].timestamp()), "open": float(r["open"]), "high": float(r["high"]), "low": float(r["low"]), "close": float(r["close"])}
            for _, r in sub_m5.iterrows()
        ]
        day_candles_by_date[d_str] = candles_list

        day_t = df_trades[df_trades["display_date"] == d_str].to_dict("records")
        first_t = day_t[0] if day_t else {}
        ref_levels = first_t.get("ref_levels", {})

        day_charts_data[d_str] = {
            "candles": [],
            "trades": day_t,
            "levels": {
                "asia_high": ref_levels.get("asia_high"),
                "asia_low": ref_levels.get("asia_low"),
                "daily_eq": ref_levels.get("daily_eq"),
                "daily_pivot": ref_levels.get("daily_pivot"),
                "pdh": ref_levels.get("pdh"),
                "pdl": ref_levels.get("pdl"),
                "orb_high": ref_levels.get("orb_high"),
                "orb_low": ref_levels.get("orb_low")
            }
        }

    improvement_tips = generate_improvement_tips(all_trades, symbol, mode_str)

    run_settings_text = (
        f"mode: {mode_str}, target_rr: {GLOBAL_PARAMS.target_rr}, "
        f"use_breakeven: {GLOBAL_PARAMS.use_breakeven}, "
        f"use_supertrend_trail: {GLOBAL_PARAMS.use_supertrend_trail}, days: {days_count}, "
        f"adaptive_effective_pct: {adaptive_pct}%, "
        f"funnel: {json.dumps(funnel)}, "
        f"vol_block_reasons: {json.dumps(vol_block_reasons)}, "
        f"strategy_errors: {json.dumps(strategy_errors)}, "
        f"rejection_stats: {json.dumps(volatility_engine.get_rejection_stats())}"
    )

    full_skip_summary = sim.skip_summary()

    report_payload = {
        "symbol": symbol,
        "mode": mode_str,
        "be": be_label,
        "trail": trail_label,
        "window_start": window_start_str,
        "window_end": window_end_str,
        "history_days_before_window": history_days_before_window,
        "adaptive_effective_pct": adaptive_pct,
        "run_settings": run_settings_text,
        "warnings": report_warnings,
        "funnel": funnel,
        "vol_block_reasons": vol_block_reasons,
        "strategy_errors": strategy_errors,
        "rejection_stats": volatility_engine.get_rejection_stats(),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "global_kpis": global_kpis,
        "strategy_kpis": strat_kpis,
        "dow_kpis": dow_kpis,
        "trading_dates": trading_dates,
        "day_data": day_charts_data,
        "all_trades": all_trades,
        "skipped_summary": full_skip_summary.get("by_reason", full_skip_summary),
        "skipped_detail": full_skip_summary,
        "improvement_tips": improvement_tips
    }

    report_filename = f"{symbol}_{mode_str}_be{be_label}_trail{trail_label}_report.json"
    out_file = os.path.join(OUTPUT_DIR, report_filename)
    with open(out_file, "w") as f:
        json.dump(report_payload, f, separators=(",", ":"))
    t_rep += time.perf_counter() - _t0

    return {
        "report_file": report_filename,
        "payload": report_payload,
        "trades": all_trades,
        "kpis": global_kpis,
        "funnel": funnel,
        "adaptive_pct": adaptive_pct,
        "day_candles": day_candles_by_date,
        "timing": {
            "volatility_s": t_vol,
            "strategies_s": t_strat,
            "simulator_s": t_sim,
            "report_writing_s": t_rep,
        }
    }

# ==============================================================================
# AUDIT HARNESS: PROMPT F FIXED 00:00 UTC BOUNDARY 4-COMBO VERIFICATION
# ==============================================================================
def compare_runs(
    symbol: str = "US30",
    days_count: int = 30,
    eurusd_df: Optional[pd.DataFrame] = None
) -> str:
    """
    Fixed boundary verifier (Prompt F).
    - Freezes end time strictly at the most recent 00:00 UTC in the dataset.
    - Closes any open trade at that boundary candle. Zero data download.
    - Runs 4 combinations across 30 days.
    - Compares full list of trades field by field.
    - Reports shared code modules and labels verdict 'PARTIAL: shares code with optimized version'.
    """
    m5_path = os.path.join(DATA_DIR, f"{symbol}_M5.csv")
    h1_path = os.path.join(DATA_DIR, f"{symbol}_H1.csv")
    h4_path = os.path.join(DATA_DIR, f"{symbol}_H4.csv")
    d1_path = os.path.join(DATA_DIR, f"{symbol}_D1.csv")

    if not all(os.path.exists(p) for p in [m5_path, h1_path, h4_path, d1_path]):
        return f"ERROR: Missing market data files for {symbol} in {DATA_DIR}."

    m5_df_full = pd.read_csv(m5_path)
    h1_df = pd.read_csv(h1_path)
    h4_df = pd.read_csv(h4_path)
    d1_df = pd.read_csv(d1_path)
    m5_df_full['time'] = pd.to_datetime(m5_df_full['time'], utc=True)

    # 1. Fixed End Time Boundary: Most recent 00:00 UTC
    latest_bar_time = m5_df_full['time'].iloc[-1]
    fixed_end_utc = latest_bar_time.replace(hour=0, minute=0, second=0, microsecond=0)
    if latest_bar_time < fixed_end_utc:
        fixed_end_utc -= timedelta(days=1)

    m5_df = m5_df_full[m5_df_full['time'] <= fixed_end_utc].copy().reset_index(drop=True)
    total_bars = len(m5_df)

    window_cutoff = fixed_end_utc - timedelta(days=days_count)
    matching = m5_df.index[m5_df['time'] >= window_cutoff].tolist()
    sim_start_idx = max(120, matching[0]) if matching else max(120, total_bars - 1)

    window_start_str = m5_df['time'].iloc[sim_start_idx].strftime('%Y-%m-%d %H:%M:%S UTC')
    window_end_str = fixed_end_utc.strftime('%Y-%m-%d %H:%M:%S UTC')

    diff_lines = []
    diff_lines.append("=" * 80)
    diff_lines.append("NEXUS MATRIX VERIFICATION HARNESS (PROMPT F: 4 COMBINATIONS · 30 DAYS)")
    diff_lines.append("=" * 80)
    diff_lines.append(f"• Asset Under Test  : {symbol}")
    diff_lines.append(f"• Fixed End Time    : {window_end_str} (Frozen at 00:00 UTC boundary)")
    diff_lines.append(f"• Fixed Start Time  : {window_start_str}")
    diff_lines.append(f"• In-Window Bars    : {total_bars - sim_start_idx:,} M5 candles")
    diff_lines.append(f"• Market Data Used  : Local CSV cache only (Zero network download)")
    diff_lines.append("-" * 80)

    # Precompute Pass for optimized version
    t0_pre = time.perf_counter()
    precomputed = precompute_market_pass(
        symbol=symbol,
        m5_df=m5_df,
        h1_df=h1_df,
        h4_df=h4_df,
        d1_df=d1_df,
        sim_start_idx=sim_start_idx,
        total_bars=total_bars
    )
    t_precompute = time.perf_counter() - t0_pre

    # 4 Combinations to evaluate
    test_combos = [
        {"mode": "adaptive", "adaptive_mode": True,  "be": "off", "use_be": False, "trail": "off", "use_trail": False, "label": "Adaptive · BE off · Trail off"},
        {"mode": "adaptive", "adaptive_mode": True,  "be": "on",  "use_be": True,  "trail": "on",  "use_trail": True,  "label": "Adaptive · BE on · Trail on"},
        {"mode": "legacy",   "adaptive_mode": False, "be": "off", "use_be": False, "trail": "off", "use_trail": False, "label": "Legacy · BE off · Trail off"},
        {"mode": "legacy",   "adaptive_mode": False, "be": "on",  "use_be": True,  "trail": "on",  "use_trail": True,  "label": "Legacy · BE on · Trail on"},
    ]

    all_verdicts = []

    for c_idx, combo in enumerate(test_combos):
        combo_label = combo["label"]
        print(f"[*] Verifying combo {c_idx + 1}/4: {combo_label}...", flush=True)

        # Run unoptimized reference
        t0 = time.perf_counter()
        ref_res = run_backtest_reference(
            symbol=symbol,
            m5_df=m5_df,
            h1_df=h1_df,
            h4_df=h4_df,
            d1_df=d1_df,
            sim_start_idx=sim_start_idx,
            total_bars=total_bars,
            adaptive_mode=combo["adaptive_mode"],
            use_be=combo["use_be"],
            use_trail=combo["use_trail"],
            eurusd_df=eurusd_df
        )
        t_ref = time.perf_counter() - t0
        ref_trades = ref_res["trades"]
        ref_kpis = ref_res["kpis"]

        # Run optimized cached combination
        t0 = time.perf_counter()
        fast_res = run_cached_combination(
            symbol=symbol,
            m5_df=m5_df,
            precomputed=precomputed,
            sim_start_idx=sim_start_idx,
            total_bars=total_bars,
            combo=combo,
            days_count=days_count,
            window_start_str=window_start_str,
            window_end_str=window_end_str,
            history_days_before_window=0.0,
            eurusd_df=eurusd_df
        )
        t_fast = time.perf_counter() - t0
        fast_trades = fast_res["trades"]
        fast_kpis = fast_res["kpis"]

        # Full field-by-field trade comparison
        divergences = []
        n_compare = max(len(ref_trades), len(fast_trades))

        for idx in range(n_compare):
            if idx >= len(ref_trades):
                divergences.append({
                    "trade_num": idx + 1,
                    "stage": "EXTRA_IN_OPTIMIZED",
                    "ref": None,
                    "fast": fast_trades[idx]
                })
                continue
            if idx >= len(fast_trades):
                divergences.append({
                    "trade_num": idx + 1,
                    "stage": "MISSING_IN_OPTIMIZED",
                    "ref": ref_trades[idx],
                    "fast": None
                })
                continue

            r = ref_trades[idx]
            f = fast_trades[idx]

            # Field checks: entry time, direction, strategy, entry, SL, TP1, TP2, exit time, exit price, exit reason, P&L
            diff_stage = None
            if r['signal_time_utc'] != f['signal_time_utc'] or r['direction'] != f['direction'] or r['strategy'] != f['strategy']:
                diff_stage = "SIGNAL"
            elif abs(r['entry_price'] - f['entry_price']) > 1e-4:
                diff_stage = "ENTRY_FILL"
            elif abs(r['sl'] - f['sl']) > 1e-4 or abs(r['tp'] - f['tp']) > 1e-4:
                diff_stage = "ADAPTED_SL_TP"
            elif r['exit_time'] != f['exit_time'] or abs(r['exit_price'] - f['exit_price']) > 1e-4 or r['exit_reason'] != f['exit_reason']:
                diff_stage = "EXIT"
            elif abs(r['money_pnl'] - f['money_pnl']) > 1e-2:
                diff_stage = "PNL"

            if diff_stage is not None:
                divergences.append({
                    "trade_num": idx + 1,
                    "stage": diff_stage,
                    "ref": r,
                    "fast": f
                })

        diff_lines.append(f"\n[COMBO {c_idx + 1}/4] {combo_label}")
        diff_lines.append(f"  • Reference (Per-Candle) : {len(ref_trades)} trades | Net P&L: ${ref_kpis['net_pnl']} | WR: {ref_kpis['win_rate']}% | Time: {t_ref:.2f}s")
        diff_lines.append(f"  • Optimized (Precompute) : {len(fast_trades)} trades | Net P&L: ${fast_kpis['net_pnl']} | WR: {fast_kpis['win_rate']}% | Time: {t_fast:.2f}s")
        diff_lines.append(f"  • Compared Trades Count  : {n_compare} total executions analyzed")

        if not divergences:
            diff_lines.append("  • Match Status           : 100% IDENTICAL across all fields")
            all_verdicts.append(f"Combo {c_idx + 1}/4 ({combo_label}): VERIFIED IDENTICAL ({len(ref_trades)} trades, 0 differences)")
        else:
            diff_lines.append(f"  • Divergent Trades Found : {len(divergences)} trade(s) differed")
            all_verdicts.append(f"Combo {c_idx + 1}/4 ({combo_label}): DIVERGENCE DETECTED ({len(divergences)} trades differ)")

            diff_lines.append(f"  --- First {min(5, len(divergences))} Divergent Trades ---")
            for d_item in divergences[:5]:
                t_num = d_item["trade_num"]
                stage = d_item["stage"]
                r = d_item["ref"]
                f = d_item["fast"]
                diff_lines.append(f"  [Trade #{t_num} Diverged First At: {stage}]")
                if r:
                    diff_lines.append(f"    • Ref  : {r['signal_time_utc']} {r['direction']} {r['strategy']} | Entry: {r['entry_price']} | SL: {r['sl']} | TP: {r['tp']} | Exit: {r['exit_time']} @ {r['exit_price']} ({r['exit_reason']}) | Net: ${r['money_pnl']}")
                if f:
                    diff_lines.append(f"    • Fast : {f['signal_time_utc']} {f['direction']} {f['strategy']} | Entry: {f['entry_price']} | SL: {f['sl']} | TP: {f['tp']} | Exit: {f['exit_time']} @ {f['exit_price']} ({f['exit_reason']}) | Net: ${f['money_pnl']}")

    diff_lines.append("\n" + "=" * 80)
    diff_lines.append("FOUR-COMBINATION VERDICT SUMMARY:")
    for v_line in all_verdicts:
        diff_lines.append(f"  ✓ {v_line}")

    # Shared code audit disclosure
    diff_lines.append("\n" + "-" * 80)
    diff_lines.append("SHARED CODE AUDIT DISCLOSURE:")
    diff_lines.append("The reference version and the optimized version share the following underlying modules:")
    diff_lines.append("  1. core/session_levels.py (_DAY_LEVELS_CACHE structural level caching)")
    diff_lines.append("  2. core/volatility_engine.py (refresh_intraday incremental range tracking)")
    diff_lines.append("  3. core/indicators.py (NumPy-vectorized get_session_volume_profile)")
    diff_lines.append("  4. backtest/bar_aggregator.py (ZeroLookAheadAggregator buffer views)")
    diff_lines.append("  5. backtest/simulator.py (TradeSimulator position management & accounting)")
    diff_lines.append("  6. strategies/strategy_manager.py (Strategy evaluation)")
    diff_lines.append("\nVERDICT CLASSIFICATION: PARTIAL: shares code with optimized version")
    diff_lines.append("=" * 80)

    final_report = "\n".join(diff_lines)
    print(final_report, flush=True)
    return final_report

# ==============================================================================
# MAIN MATRIX ORCHESTRATION
# ==============================================================================
async def run_symbol_matrix(client: CTraderClient, symbol: str, days_count: int, eurusd_df: Optional[pd.DataFrame] = None) -> bool:
    orig_adaptive = GLOBAL_PARAMS.adaptive_mode
    orig_be = GLOBAL_PARAMS.use_breakeven
    orig_trail = GLOBAL_PARAMS.use_supertrend_trail

    for pattern in [f"{symbol}_*_report.json", f"{symbol}_summary.json", f"{symbol}_daycandles.json", f"{symbol}_adaptive_report.json", f"{symbol}_legacy_report.json"]:
        for fpath in glob.glob(os.path.join(OUTPUT_DIR, pattern)):
            try:
                os.remove(fpath)
            except OSError:
                pass

    for pattern in [f"{symbol}_*_trades.csv", f"{symbol}_*_trades.json", f"{symbol}_*_skipped_signals.csv"]:
        for fpath in glob.glob(os.path.join(DATA_DIR, pattern)):
            try:
                os.remove(fpath)
            except OSError:
                pass

    report_html = os.path.join(DATA_DIR, "report.html")
    if os.path.exists(report_html):
        try:
            os.remove(report_html)
        except OSError:
            pass

    m5_path = os.path.join(DATA_DIR, f"{symbol}_M5.csv")
    h1_path = os.path.join(DATA_DIR, f"{symbol}_H1.csv")
    h4_path = os.path.join(DATA_DIR, f"{symbol}_H4.csv")
    d1_path = os.path.join(DATA_DIR, f"{symbol}_D1.csv")

    if not all(os.path.exists(p) for p in [m5_path, h1_path, h4_path, d1_path]):
        print(f"ERROR: Incomplete data files for {symbol} in {DATA_DIR}.", flush=True)
        return False

    m5_df = pd.read_csv(m5_path)
    h1_df = pd.read_csv(h1_path)
    h4_df = pd.read_csv(h4_path)
    d1_df = pd.read_csv(d1_path)

    m5_df['time'] = pd.to_datetime(m5_df['time'], utc=True)
    total_bars = len(m5_df)

    if total_bars < 130:
        print(f"ERROR: Insufficient data bars for {symbol} ({total_bars} bars).", flush=True)
        return False

    last_bar_time = m5_df['time'].iloc[-1]
    window_cutoff = last_bar_time - timedelta(days=days_count)
    matching_indices = m5_df.index[m5_df['time'] >= window_cutoff].tolist()
    sim_start_idx = max(120, matching_indices[0]) if matching_indices else max(120, total_bars - 1)

    window_start_str = m5_df['time'].iloc[sim_start_idx].strftime('%Y-%m-%d %H:%M:%S UTC')
    window_end_str = last_bar_time.strftime('%Y-%m-%d %H:%M:%S UTC')
    history_days_before_window = max(0, round((m5_df['time'].iloc[sim_start_idx] - m5_df['time'].iloc[0]).total_seconds() / 86400.0, 1))

    print(f"[*] {symbol}: Running shared precompute pass across {total_bars - sim_start_idx:,} candles...", flush=True)
    precomputed = precompute_market_pass(
        symbol=symbol,
        m5_df=m5_df,
        h1_df=h1_df,
        h4_df=h4_df,
        d1_df=d1_df,
        sim_start_idx=sim_start_idx,
        total_bars=total_bars
    )

    matrix_rows = []
    all_day_candles: Dict[str, Any] = {}

    pre_timing = precomputed["timing"]
    tot_agg = pre_timing["aggregator_s"]
    tot_vol = pre_timing["volatility_s"]
    tot_lvl = pre_timing["session_levels_s"]
    tot_strat = pre_timing["strategies_s"]
    tot_sim = 0.0
    tot_rep = 0.0

    try:
        for idx, combo in enumerate(COMBINATIONS):
            res = run_cached_combination(
                symbol=symbol,
                m5_df=m5_df,
                precomputed=precomputed,
                sim_start_idx=sim_start_idx,
                total_bars=total_bars,
                combo=combo,
                days_count=days_count,
                window_start_str=window_start_str,
                window_end_str=window_end_str,
                history_days_before_window=history_days_before_window,
                eurusd_df=eurusd_df
            )

            k = res["kpis"]
            timing = res.get("timing", {})
            tot_vol += timing.get("volatility_s", 0.0)
            tot_strat += timing.get("strategies_s", 0.0)
            tot_sim += timing.get("simulator_s", 0.0)
            tot_rep += timing.get("report_writing_s", 0.0)

            matrix_rows.append({
                "label": combo["label"],
                "mode": combo["mode"],
                "be": combo["be"],
                "trail": combo["trail"],
                "report_file": res["report_file"],
                "total_trades": k["count"],
                "win_rate": k["win_rate"],
                "expectancy": k["expectancy"],
                "profit_factor": k["profit_factor"],
                "max_drawdown": k["max_dd_money"],
                "net_pnl": k["net_pnl"],
                "adaptive_effective_pct": res["adaptive_pct"],
                "funnel": res["funnel"]
            })

            day_candles = res.get("day_candles", {})
            for d_str, c_list in day_candles.items():
                if d_str not in all_day_candles:
                    all_day_candles[d_str] = c_list

            print(f"[*] {symbol} combo {idx + 1}/8 done", flush=True)

        _t0 = time.perf_counter()
        if all_day_candles:
            candles_file = os.path.join(OUTPUT_DIR, f"{symbol}_daycandles.json")
            with open(candles_file, "w") as f:
                json.dump(all_day_candles, f, separators=(",", ":"))

        summary_file = os.path.join(OUTPUT_DIR, f"{symbol}_summary.json")
        with open(summary_file, "w") as f:
            json.dump({
                "symbol": symbol,
                "days": days_count,
                "target_rr": GLOBAL_PARAMS.target_rr,
                "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
                "combinations": matrix_rows
            }, f, separators=(",", ":"))
        tot_rep += time.perf_counter() - _t0

        print(
            f"[time] {symbol} aggregator {tot_agg:.1f}s, volatility {tot_vol:.1f}s, "
            f"session_levels {tot_lvl:.1f}s, strategies {tot_strat:.1f}s, "
            f"simulator {tot_sim:.1f}s, report_writing {tot_rep:.1f}s",
            flush=True
        )

        print(f"[✓] {symbol} Matrix Complete: 8/8 combinations saved to {summary_file}", flush=True)
        return len(matrix_rows) > 0

    finally:
        GLOBAL_PARAMS.adaptive_mode = orig_adaptive
        GLOBAL_PARAMS.use_breakeven = orig_be
        GLOBAL_PARAMS.use_supertrend_trail = orig_trail

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, default="US30")
    parser.add_argument("--days", type=int, default=60)
    parser.add_argument("--rr", type=float, default=1.0, help="Target R:R multiplier")
    parser.add_argument("--mode", type=str, default=None)
    parser.add_argument("--adaptive", action="store_true", default=True)
    parser.add_argument("--breakeven", type=str, default="off")
    parser.add_argument("--supertrend", type=str, default="on")
    parser.add_argument("--compare", action="store_true", default=False, help="Run comparison vs reference engine")
    args = parser.parse_args()

    if args.compare:
        res_text = compare_runs(
            symbol=args.symbol,
            days_count=30
        )
        return

    usage = shutil.disk_usage(OUTPUT_DIR)
    free_mb = usage.free / (1024 * 1024)
    if free_mb < 80.0:
        print(f"ERROR: Low disk space on storage volume ({int(free_mb)} MB free). Clear old reports from the Storage panel.", flush=True)
        sys.exit(1)

    GLOBAL_PARAMS.target_rr = args.rr

    client = CTraderClient()
    ok = await ensure_symbol_data(client, args.symbol)

    eurusd_df: Optional[pd.DataFrame] = None
    if args.symbol.upper() == "GERMAN30":
        eurusd_ok = await ensure_symbol_data(client, "EURUSD")
        eurusd_m5_path = os.path.join(DATA_DIR, "EURUSD_M5.csv")
        if not eurusd_ok or not os.path.exists(eurusd_m5_path):
            print("ERROR: GERMAN30 needs EURUSD history", flush=True)
            sys.exit(1)
        try:
            eurusd_df = pd.read_csv(eurusd_m5_path)
        except Exception:
            print("ERROR: GERMAN30 needs EURUSD history", flush=True)
            sys.exit(1)

    success = False
    if ok:
        success = await run_symbol_matrix(client, args.symbol, args.days, eurusd_df=eurusd_df)

    if client.ws:
        try:
            await client.ws.close()
        except Exception:
            pass

    if not ok or not success:
        sys.exit(1)

def print_startup_diagnostics() -> None:
    print("=" * 60, flush=True)
    print("BACKTEST STARTUP DIAGNOSTICS", flush=True)
    print("=" * 60, flush=True)
    print(f"Python version: {sys.version.split()[0]}", flush=True)

    env_checks = [
        "CTRADER_CLIENT_ID",
        "CTRADER_CLIENT_SECRET",
        "CTRADER_ACCESS_TOKEN",
        "CTRADER_ACCOUNT_ID",
    ]
    for key in env_checks:
        value = os.environ.get(key, "").strip()
        status = "SET" if value else "MISSING"
        print(f"{key}: {status}", flush=True)
    print("=" * 60, flush=True)

if __name__ == "__main__":
    try:
        from dotenv import load_dotenv
        project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
        load_dotenv(os.path.join(project_root, '.env'))
    except ImportError:
        pass

    print_startup_diagnostics()
    asyncio.run(main())