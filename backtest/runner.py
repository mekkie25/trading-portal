"""
backtest/runner.py
High-Performance Automated End-to-End Backtest Matrix Runner.

PROPOSED: entry-feature capture. Each opened trade now stores the market
condition features from backtest/features.py (see that module for the
definitions). At the end of main() the pooled analysis is written to
backtest/output/entry_analysis.json by backtest/entry_analysis.py. Both are
backtest-only; the live bot is untouched.

PROPOSED: fast engine path.
- The six-combination matrix is Adaptive only, BE on/off, R:R 1:1 / 1:2 / 1:3.
  There is no Legacy and no Trail combination.
- The shared precompute pass (aggregator, volatility engine, session levels,
  strategy evaluation) is cached to disk as <SYMBOL>_precompute.pkl.gz keyed
  on a source hash plus the window. On a cache hit, the pass is skipped and
  the whole pair runs in a couple of seconds.
- Each pair's summary carries one engine line and a wrong_engine flag, so a
  silent fallback to the old slow path is impossible to miss.

PROPOSED: alt-target replay. The Adaptive · BE off · R:R 1:1 combination
passes the full M5 series to the simulator so it can replay each trade at
1.0R, 1.5R, 2.0R and 3.0R. This adds fields only; trades, entries, exits and
P&L are unchanged. To keep the added cost small, only that one combination
enables the replay.
"""

import sys
import os
import glob
import shutil
import json
import time
import copy
import math
import random
import asyncio
import argparse
import tempfile
import pickle
import hashlib
import gzip
import numpy as np
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
from backtest.export_advice import generate_pair_advice
from backtest.paths import DATA_DIR, OUTPUT_DIR
from backtest.diagnostics import compute_diagnostics
from backtest.portfolio import compute_portfolio_correlation, DEFAULT_WHITELIST

# PROPOSED: entry-feature capture pipeline.
from backtest.features import compute_entry_features
from backtest.entry_analysis import write_entry_analysis

STORE_TARGET_DAYS = 500
STORE_MAX_DAYS = 550

# PROPOSED: six combinations only. No Legacy, no Trail.
# Each combination that needs a non-default R:R carries "rr_override".
# The first combination is the "analysis_combo" — its trades feed
# backtest/entry_analysis.py and its simulator gets the full M5 series so the
# alternative-target replay can run.
COMBINATIONS = [
    {
        "mode": "adaptive", "adaptive_mode": True,
        "be": "off", "use_be": False,
        "trail": "off", "use_trail": False,
        "label": "Adaptive · BE off · R:R 1:1",
        "rr_override": 1.0,
        "analysis_combo": True,
    },
    {
        "mode": "adaptive", "adaptive_mode": True,
        "be": "on", "use_be": True,
        "trail": "off", "use_trail": False,
        "label": "Adaptive · BE on · R:R 1:1",
        "rr_override": 1.0,
        "analysis_combo": False,
    },
    {
        "mode": "adaptive", "adaptive_mode": True,
        "be": "off", "use_be": False,
        "trail": "off", "use_trail": False,
        "label": "Adaptive · BE off · R:R 1:2",
        "rr_override": 2.0,
        "analysis_combo": False,
    },
    {
        "mode": "adaptive", "adaptive_mode": True,
        "be": "on", "use_be": True,
        "trail": "off", "use_trail": False,
        "label": "Adaptive · BE on · R:R 1:2",
        "rr_override": 2.0,
        "analysis_combo": False,
    },
    {
        "mode": "adaptive", "adaptive_mode": True,
        "be": "off", "use_be": False,
        "trail": "off", "use_trail": False,
        "label": "Adaptive · BE off · R:R 1:3",
        "rr_override": 3.0,
        "analysis_combo": False,
    },
    {
        "mode": "adaptive", "adaptive_mode": True,
        "be": "on", "use_be": True,
        "trail": "off", "use_trail": False,
        "label": "Adaptive · BE on · R:R 1:3",
        "rr_override": 3.0,
        "analysis_combo": False,
    },
]

# Phase-3 Blueprint variants (Section 5 items 22 / 23 / 25). Only run when
# the caller asks for --variants. They are separate from the six-combination
# matrix.
VARIANT_COMBINATIONS = [
    {
        "label": "BE Structural (2-close break)",
        "mode": "adaptive", "adaptive_mode": True,
        "be": "on", "use_be": True,
        "be_mode": "STRUCTURAL",
        "trail": "off", "use_trail": False,
        "trail_override": None,
        "max_daily_override": None,
        "report_file": "variant_be_structural_report.json",
    },
    {
        "label": "Trail EMA_9 (no BE)",
        "mode": "adaptive", "adaptive_mode": True,
        "be": "off", "use_be": False,
        "be_mode": "FIXED_80",
        "trail": "on", "use_trail": True,
        "trail_override": "EMA_9",
        "max_daily_override": None,
        "report_file": "variant_trail_ema9_report.json",
    },
    {
        "label": "Trail EMA_25 (no BE)",
        "mode": "adaptive", "adaptive_mode": True,
        "be": "off", "use_be": False,
        "be_mode": "FIXED_80",
        "trail": "on", "use_trail": True,
        "trail_override": "EMA_25",
        "max_daily_override": None,
        "report_file": "variant_trail_ema25_report.json",
    },
    {
        "label": "Daily Cap 1",
        "mode": "adaptive", "adaptive_mode": True,
        "be": "off", "use_be": False,
        "be_mode": "FIXED_80",
        "trail": "off", "use_trail": False,
        "trail_override": None,
        "max_daily_override": 1,
        "report_file": "variant_dailycap1_report.json",
    },
    {
        "label": "Daily Cap 4",
        "mode": "adaptive", "adaptive_mode": True,
        "be": "off", "use_be": False,
        "be_mode": "FIXED_80",
        "trail": "off", "use_trail": False,
        "trail_override": None,
        "max_daily_override": 4,
        "report_file": "variant_dailycap4_report.json",
    },
]

# -----------------------------------------------------------------------------
# Strategy Lab: 12 single-setting variants on the 365-day window.
# Baseline is Adaptive · BE on · Trail off. Each other variant changes ONE setting.
# -----------------------------------------------------------------------------
LAB_VARIANTS: List[Dict[str, Any]] = [
    {"label": "Baseline",                 "overrides": {}},
    {"label": "Max spread-in-R 0.10",     "overrides": {"strat_max_spread_in_r": 0.10}},
    {"label": "Max spread-in-R 0.05",     "overrides": {"strat_max_spread_in_r": 0.05}},
    {"label": "Min stop ATR 1.0",         "overrides": {"strat_min_stop_atr": 1.0}},
    {"label": "Min stop ATR 1.5",         "overrides": {"strat_min_stop_atr": 1.5}},
    {"label": "Session 09-22 SAST",       "overrides": {"strat_session_window_sast": (9, 22)}},
    {"label": "Session 15-22 SAST",       "overrides": {"strat_session_window_sast": (15, 22)}},
    {"label": "HTF trend filter ON",      "overrides": {"strat_htf_trend_filter": True}},
    {"label": "Disable AVWAP",            "overrides": {"strat_disabled": ["AVWAP_200EMA_CONTINUATION"]}},
    {"label": "Disable STRATEGY_513",     "overrides": {"strat_disabled": ["STRATEGY_513"]}},
    {"label": "Target R:R 1.5",           "overrides": {"target_rr": 1.5}},
    {"label": "Target R:R 2.0",           "overrides": {"target_rr": 2.0}},
]


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


def _parse_window_time(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        cleaned = str(s).replace("UTC", "").strip()
        return datetime.strptime(cleaned, "%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def _trade_time_utc(t: Dict[str, Any]) -> Optional[datetime]:
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


def compute_tune_validate_kpis(trades: List[Dict[str, Any]], window_start_str: str, window_end_str: str) -> Dict[str, Any]:
    empty = {"count": 0, "win_rate": 0.0, "avg_r": 0.0, "expectancy": 0.0,
             "profit_factor": 0.0, "max_dd_money": 0.0, "net_pnl": 0.0,
             "is_inconclusive": True}
    if not trades:
        return {"tune": dict(empty), "validate": dict(empty), "tune_days": 0.0, "validate_days": 0.0}

    start = _parse_window_time(window_start_str)
    end = _parse_window_time(window_end_str)
    if start is None or end is None or end <= start:
        k = calculate_kpis(list(trades))
        return {"tune": k, "validate": dict(empty), "tune_days": 0.0, "validate_days": 0.0}

    total_days = (end - start).total_seconds() / 86400.0
    tune_days = total_days * 0.70
    cutoff = start + timedelta(days=tune_days)

    tune_trades: List[Dict[str, Any]] = []
    val_trades: List[Dict[str, Any]] = []
    for t in trades:
        tt = _trade_time_utc(t)
        if tt is None or tt < cutoff:
            tune_trades.append(t)
        else:
            val_trades.append(t)

    return {
        "tune": calculate_kpis(tune_trades),
        "validate": calculate_kpis(val_trades),
        "tune_days": round(tune_days, 1),
        "validate_days": round(total_days - tune_days, 1),
    }


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


def compute_121_window_emas(df: pd.DataFrame) -> None:
    close = df['close'].values.astype(np.float64)
    n = len(close)
    window_size = 121

    for span in [5, 9, 13, 25, 200]:
        col_name = f"ema_{span}"
        if col_name in df.columns:
            continue

        alpha = 2.0 / (span + 1.0)
        weights = np.empty(window_size, dtype=np.float64)
        weights[0] = (1.0 - alpha) ** (window_size - 1)
        for k in range(1, window_size):
            weights[k] = alpha * ((1.0 - alpha) ** (window_size - 1 - k))

        valid_vals = np.convolve(close, weights[::-1], mode='valid')
        col_arr = np.empty(n, dtype=np.float64)
        col_arr[:window_size - 1] = np.nan
        col_arr[window_size - 1:] = valid_vals
        df[col_name] = col_arr


def compute_atr14_series(df: pd.DataFrame) -> None:
    """
    PROPOSED: in-place add column `atr_14` on the M5 DataFrame.
    Simple 14-period rolling mean of true range.
    """
    if df is None or df.empty:
        return
    if "atr_14" in df.columns:
        return
    try:
        high = df["high"].astype(float)
        low = df["low"].astype(float)
        close = df["close"].astype(float)
        prev_close = close.shift(1)
        tr = pd.concat([
            (high - low).abs(),
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ], axis=1).max(axis=1)
        df["atr_14"] = tr.rolling(14).mean()
    except Exception as e:
        print(f"[atr14] failed: {e}", flush=True)


def verify_precomputed_emas(df: pd.DataFrame, n_samples: int = 300) -> None:
    total = len(df)
    if total < 130:
        return

    sample_indices = random.sample(range(120, total), min(n_samples, total - 120))
    max_diff = 0.0

    for idx in sample_indices:
        slice_close = df['close'].iloc[idx - 120:idx + 1]
        for span in [5, 9, 13, 25, 200]:
            ref_val = float(slice_close.ewm(span=span, adjust=False).mean().iloc[-1])
            pre_val = float(df[f"ema_{span}"].iloc[idx])
            diff = abs(ref_val - pre_val)
            if diff > max_diff:
                max_diff = diff

    if max_diff < 1e-6:
        print(f"[check] indicators match (max diff: {max_diff:.2e})", flush=True)
    else:
        print(f"[check] indicator discrepancy: {max_diff:.6f}", flush=True)


# ---------------------------------------------------------------------------
# PROPOSED: precompute cache.
# The shared precompute pass (aggregator + volatility + session levels +
# strategy evaluation) is expensive (~10 minutes per pair on 365 days). We
# cache the result to disk keyed on a source hash and the window. On a cache
# hit, the pass is skipped entirely and only the ema/atr columns are rebuilt.
# ---------------------------------------------------------------------------

def _precompute_cache_path(symbol: str) -> str:
    return os.path.join(DATA_DIR, f"{symbol}_precompute.pkl.gz")


def _precompute_source_hash() -> str:
    h = hashlib.sha256()
    for rel in [
        "core/session_levels.py",
        "core/indicators.py",
        "core/session_config.py",
        "core/volatility_engine.py",
        "core/targets.py",
        "strategies/strategy_manager.py",
        "strategies/base.py",
        "backtest/bar_aggregator.py",
        "backtest/features.py",
    ]:
        p = os.path.join(PROJECT_ROOT, rel)
        try:
            with open(p, "rb") as f:
                h.update(rel.encode())
                h.update(f.read())
        except FileNotFoundError:
            h.update(rel.encode())
    return h.hexdigest()[:16]


def _precompute_cache_key(symbol: str, sim_start_idx: int, total_bars: int) -> str:
    src = _precompute_source_hash()
    return f"{symbol}|{sim_start_idx}|{total_bars}|{src}"


def _try_load_precompute(symbol: str, sim_start_idx: int, total_bars: int) -> Optional[Dict[str, Any]]:
    path = _precompute_cache_path(symbol)
    if not os.path.exists(path):
        return None
    try:
        with gzip.open(path, "rb") as f:
            payload = pickle.load(f)
        if not isinstance(payload, dict):
            return None
        if payload.get("__key__") != _precompute_cache_key(symbol, sim_start_idx, total_bars):
            return None
        return payload
    except Exception as e:
        print(f"[runner] WARNING: precompute cache for {symbol} unreadable ({e}); rebuilding.", flush=True)
        return None


def _save_precompute(symbol: str, sim_start_idx: int, total_bars: int, precomputed: Dict[str, Any]) -> None:
    path = _precompute_cache_path(symbol)
    payload = dict(precomputed)
    payload["__key__"] = _precompute_cache_key(symbol, sim_start_idx, total_bars)
    tmp = path + ".tmp"
    try:
        with gzip.open(tmp, "wb", compresslevel=6) as f:
            pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)
        os.replace(tmp, path)
    except Exception as e:
        print(f"[runner] WARNING: could not write precompute cache for {symbol}: {e}", flush=True)
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


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

        sim.process_candle(symbol, curr_bar, m5_slice)

        h1_view, h4_view, d1_view = aggregator.get_feeds_at_time(m5_slice, curr_time)

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
                sim.open_trade(signal, curr_time, adr_val, regime, session_levels, ema_200_value=None)

    if len(m5_df) > 0 and len(sim.open_positions) > 0:
        sim.close_all(symbol, m5_df.iloc[-1])

    kpis = calculate_kpis(sim.completed_trades)
    return {
        "trades": sim.completed_trades,
        "kpis": kpis
    }


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

    compute_121_window_emas(m5_df)
    verify_precomputed_emas(m5_df, 300)
    # PROPOSED: add atr_14 column for entry-feature analysis.
    compute_atr14_series(m5_df)

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
                "curr_time": curr_time,
                # PROPOSED: cache d1_view AND h4_view so the entry-feature
                # builder can read the last closed HTF candle without
                # re-running the aggregator. h4_view was missing before,
                # which made htf_h4 default to 0 for every trade.
                "d1_view": d1_view,
                "h4_view": h4_view,
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
    eurusd_df: Optional[pd.DataFrame] = None,
    be_mode: str = "FIXED_80",
    trail_override: Optional[str] = None,
    max_daily_override: Optional[int] = None,
    report_file_override: Optional[str] = None,
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

    # PROPOSED: R:R override per combination, restored in the finally block.
    orig_target_rr = GLOBAL_PARAMS.target_rr
    rr_override = combo.get("rr_override", None)
    if rr_override is not None:
        GLOBAL_PARAMS.target_rr = float(rr_override)

    GLOBAL_PARAMS.adaptive_mode = adaptive_mode
    GLOBAL_PARAMS.use_breakeven = use_be
    GLOBAL_PARAMS.use_supertrend_trail = use_trail

    orig_max_daily = getattr(GLOBAL_PARAMS, 'max_daily_trades', 2)
    if max_daily_override is not None:
        GLOBAL_PARAMS.max_daily_trades = max_daily_override

    # PROPOSED: only the analysis combination carries the full M5 series into
    # the simulator, so the alt-target replay runs exactly once per pair.
    is_analysis_combo = bool(combo.get("analysis_combo", False))

    sim = TradeSimulator(
        starting_balance=balance,
        risk_pct=risk_pct,
        eurusd_df=eurusd_df,
        be_mode=be_mode,
        m5_df_full=(m5_df if is_analysis_combo else None),
    )
    cached_signals = precomputed["cached_signals"]
    m5_times_list = m5_df['time'].tolist()
    has_ema200_col = 'ema_200' in m5_df.columns

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

    try:
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
            # PROPOSED: pull the cached HTF views for the entry-feature builder.
            d1_view_cached = item.get("d1_view")
            h4_view_cached = item.get("h4_view")

            if trail_override:
                signal.trail_mode = trail_override

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
                            if trail_override:
                                signal.trail_mode = trail_override
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
                    ema_200_val: Optional[float] = None
                    if has_ema200_col:
                        try:
                            v = float(m5_df.iloc[i]['ema_200'])
                            if not math.isnan(v):
                                ema_200_val = v
                        except (KeyError, IndexError, TypeError, ValueError):
                            ema_200_val = None

                    # PROPOSED: build the entry features for this trade.
                    try:
                        sast_dt = curr_time.astimezone(TZ_SAST)
                        sast_date_str = sast_dt.strftime("%Y-%m-%d")
                        trade_of_day = sim.daily_trade_counts.get(sast_date_str, 0) + 1
                    except Exception:
                        trade_of_day = 1

                    spread_for_feat = ASSETS.get(symbol, {}).get("spread", 0.0)
                    try:
                        entry_feats = compute_entry_features(
                            signal=signal,
                            curr_time=curr_time,
                            m5_df=m5_df,
                            idx=i,
                            session_levels=session_levels,
                            active_vol=active_vol,
                            d1_view=d1_view_cached,
                            h4_view=h4_view_cached,
                            spread=spread_for_feat,
                            trade_of_day=trade_of_day,
                        )
                    except Exception:
                        entry_feats = None

                    opened = sim.open_trade(
                        signal, curr_time, adr_val, regime, session_levels,
                        ema_200_value=ema_200_val,
                        entry_features=entry_feats,
                    )
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
        strat_tune_validate: Dict[str, Any] = {}
        if not df_trades.empty:
            for s_name, s_group in df_trades.groupby("strategy"):
                strat_kpis[s_name] = calculate_kpis(s_group.to_dict("records"))
                strat_tune_validate[s_name] = compute_tune_validate_kpis(
                    s_group.to_dict("records"), window_start_str, window_end_str
                )

            df_trades["weekday"] = pd.to_datetime(df_trades["display_date"]).dt.day_name()
            for dow, dow_group in df_trades.groupby("weekday"):
                dow_kpis[dow] = calculate_kpis(dow_group.to_dict("records"))

        combo_tune_validate = compute_tune_validate_kpis(all_trades, window_start_str, window_end_str)

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

        diag_payload = compute_diagnostics(
            trades=all_trades,
            m5_df=m5_df,
            sim_start_idx=sim_start_idx,
            starting_equity=balance,
        )

        run_settings_text = (
            f"mode: {mode_str}, target_rr: {GLOBAL_PARAMS.target_rr}, "
            f"use_breakeven: {GLOBAL_PARAMS.use_breakeven}, "
            f"use_supertrend_trail: {GLOBAL_PARAMS.use_supertrend_trail}, days: {days_count}, "
            f"adaptive_effective_pct: {adaptive_pct}%, "
            f"be_mode: {be_mode}, trail_override: {trail_override}, max_daily_override: {max_daily_override}, "
            f"rr_override: {rr_override}, "
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
            "skipped_summary": full_skip_summary.get("by_reason", {}),
            "skipped_detail": full_skip_summary,
            "improvement_tips": improvement_tips,
            "tune_validate": combo_tune_validate,
            "strategy_tune_validate": strat_tune_validate,
            "diagnostics": diag_payload,
        }

        if report_file_override:
            report_filename = report_file_override
        else:
            rr_tag = f"rr{rr_override:.1f}" if rr_override is not None else "rr_default"
            report_filename = f"{symbol}_{mode_str}_be{be_label}_trail{trail_label}_{rr_tag}_report.json"
        out_file = os.path.join(OUTPUT_DIR, report_filename)
        safe_payload = sanitize_for_json(report_payload)
        with open(out_file, "w") as f:
            json.dump(safe_payload, f, separators=(",", ":"), allow_nan=False)
        t_rep += time.perf_counter() - _t0

        return {
            "report_file": report_filename,
            "payload": report_payload,
            "trades": all_trades,
            "kpis": global_kpis,
            "funnel": funnel,
            "adaptive_pct": adaptive_pct,
            "day_candles": day_candles_by_date,
            "tune_validate": combo_tune_validate,
            "strategy_tune_validate": strat_tune_validate,
            "timing": {
                "volatility_s": t_vol,
                "strategies_s": t_strat,
                "simulator_s": t_sim,
                "report_writing_s": t_rep,
            }
        }
    finally:
        # PROPOSED: restore GLOBAL_PARAMS values we may have changed.
        GLOBAL_PARAMS.target_rr = orig_target_rr
        GLOBAL_PARAMS.max_daily_trades = orig_max_daily


def write_portfolio_correlation() -> bool:
    """Read every <symbol>_*_report.json in OUTPUT_DIR and write portfolio_correlation.json."""
    try:
        payload = compute_portfolio_correlation(OUTPUT_DIR, DEFAULT_WHITELIST)
        out_file = os.path.join(OUTPUT_DIR, "portfolio_correlation.json")
        safe = sanitize_for_json(payload)
        with open(out_file, "w") as f:
            json.dump(safe, f, separators=(",", ":"), allow_nan=False)
        print(f"[✓] Portfolio correlation saved to {out_file}", flush=True)
        return True
    except Exception as e:
        print(f"ERROR: Portfolio correlation failed: {e}", flush=True)
        return False


def compare_runs(
    symbol: str = "US30",
    days_count: int = 30,
    eurusd_df: Optional[pd.DataFrame] = None
) -> str:
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

    precomputed = precompute_market_pass(
        symbol=symbol,
        m5_df=m5_df,
        h1_df=h1_df,
        h4_df=h4_df,
        d1_df=d1_df,
        sim_start_idx=sim_start_idx,
        total_bars=total_bars
    )

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

        divergences = []
        n_compare = max(len(ref_trades), len(fast_trades))

        for idx in range(n_compare):
            if idx >= len(ref_trades):
                divergences.append({"trade_num": idx + 1, "stage": "EXTRA_IN_OPTIMIZED", "ref": None, "fast": fast_trades[idx]})
                continue
            if idx >= len(fast_trades):
                divergences.append({"trade_num": idx + 1, "stage": "MISSING_IN_OPTIMIZED", "ref": ref_trades[idx], "fast": None})
                continue

            r = ref_trades[idx]
            f = fast_trades[idx]

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
                divergences.append({"trade_num": idx + 1, "stage": diff_stage, "ref": r, "fast": f})

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

    final_report = "\n".join(diff_lines)
    print(final_report, flush=True)
    return final_report


async def run_symbol_matrix(
    client: CTraderClient,
    symbol: str,
    days_count: int,
    eurusd_df: Optional[pd.DataFrame] = None,
    variants: bool = False,
) -> bool:
    orig_adaptive = GLOBAL_PARAMS.adaptive_mode
    orig_be = GLOBAL_PARAMS.use_breakeven
    orig_trail = GLOBAL_PARAMS.use_supertrend_trail
    orig_rr = GLOBAL_PARAMS.target_rr

    for pattern in [f"{symbol}_*_report.json", f"{symbol}_summary.json", f"{symbol}_daycandles.json",
                    f"{symbol}_adaptive_report.json", f"{symbol}_legacy_report.json", f"{symbol}_variants.json"]:
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

    # PROPOSED: try to load the cached precompute pass first.
    cached_precompute = _try_load_precompute(symbol, sim_start_idx, total_bars)
    cache_hit = cached_precompute is not None

    if cache_hit:
        print(f"[*] {symbol}: loaded precompute cache (fast engine).", flush=True)
        # The cached payload does not carry the ema/atr columns, so we rebuild
        # them on the loaded M5 frame. This takes a couple of seconds.
        compute_121_window_emas(m5_df)
        compute_atr14_series(m5_df)
        precomputed = cached_precompute
    else:
        print(f"[*] {symbol}: Running shared precompute pass across {total_bars - sim_start_idx:,} candles...", flush=True)
        precompute_t0 = time.perf_counter()
        precomputed = precompute_market_pass(
            symbol=symbol,
            m5_df=m5_df,
            h1_df=h1_df,
            h4_df=h4_df,
            d1_df=d1_df,
            sim_start_idx=sim_start_idx,
            total_bars=total_bars
        )
        precompute_elapsed = time.perf_counter() - precompute_t0
        try:
            _save_precompute(symbol, sim_start_idx, total_bars, precomputed)
            print(f"[*] {symbol}: precompute cache saved ({precompute_elapsed:.1f}s to build).", flush=True)
        except Exception as e:
            print(f"[*] {symbol}: WARNING: could not save precompute cache: {e}", flush=True)

    precompute_timing = precomputed.get("timing", {}) or {}
    precompute_total_s = round(sum(float(v) for v in precompute_timing.values()), 1)

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
                "rr_override": combo.get("rr_override"),
                "report_file": res["report_file"],
                "total_trades": k["count"],
                "win_rate": k["win_rate"],
                "expectancy": k["expectancy"],
                "profit_factor": k["profit_factor"],
                "max_drawdown": k["max_dd_money"],
                "net_pnl": k["net_pnl"],
                "adaptive_effective_pct": res["adaptive_pct"],
                "funnel": res["funnel"],
                "tune_validate": res["tune_validate"],
            })

            day_candles = res.get("day_candles", {})
            for d_str, c_list in day_candles.items():
                if d_str not in all_day_candles:
                    all_day_candles[d_str] = c_list

            print(f"[*] {symbol} combo {idx + 1}/6 done", flush=True)

        # ---- Phase-3 variant matrix (only with --variants) ----
        variant_rows: List[Dict[str, Any]] = []
        if variants:
            print(f"[*] {symbol}: running {len(VARIANT_COMBINATIONS)} variant combos...", flush=True)
            for v_idx, vcombo in enumerate(VARIANT_COMBINATIONS):
                try:
                    v_res = run_cached_combination(
                        symbol=symbol,
                        m5_df=m5_df,
                        precomputed=precomputed,
                        sim_start_idx=sim_start_idx,
                        total_bars=total_bars,
                        combo=vcombo,
                        days_count=days_count,
                        window_start_str=window_start_str,
                        window_end_str=window_end_str,
                        history_days_before_window=history_days_before_window,
                        eurusd_df=eurusd_df,
                        be_mode=vcombo.get("be_mode", "FIXED_80"),
                        trail_override=vcombo.get("trail_override"),
                        max_daily_override=vcombo.get("max_daily_override"),
                        report_file_override=vcombo.get("report_file"),
                    )

                    v_k = v_res["kpis"]
                    v_timing = v_res.get("timing", {})
                    tot_vol += v_timing.get("volatility_s", 0.0)
                    tot_strat += v_timing.get("strategies_s", 0.0)
                    tot_sim += v_timing.get("simulator_s", 0.0)
                    tot_rep += v_timing.get("report_writing_s", 0.0)

                    variant_rows.append({
                        "label": vcombo["label"],
                        "mode": vcombo["mode"],
                        "be": vcombo["be"],
                        "trail": vcombo["trail"],
                        "be_mode": vcombo.get("be_mode", "FIXED_80"),
                        "trail_override": vcombo.get("trail_override"),
                        "max_daily_override": vcombo.get("max_daily_override"),
                        "report_file": v_res["report_file"],
                        "total_trades": v_k["count"],
                        "win_rate": v_k["win_rate"],
                        "expectancy": v_k["expectancy"],
                        "profit_factor": v_k["profit_factor"],
                        "max_drawdown": v_k["max_dd_money"],
                        "net_pnl": v_k["net_pnl"],
                        "adaptive_effective_pct": v_res["adaptive_pct"],
                        "funnel": v_res["funnel"],
                        "tune_validate": v_res["tune_validate"],
                    })

                    v_day_candles = v_res.get("day_candles", {})
                    for d_str, c_list in v_day_candles.items():
                        if d_str not in all_day_candles:
                            all_day_candles[d_str] = c_list

                except Exception as ve:
                    print(f"ERROR: variant '{vcombo.get('label', '?')}' failed on {symbol}: {ve}", flush=True)
                    variant_rows.append({
                        "label": vcombo.get("label", "UNKNOWN"),
                        "error": str(ve),
                        "total_trades": 0,
                        "win_rate": 0.0,
                        "expectancy": 0.0,
                        "profit_factor": 0.0,
                        "max_drawdown": 0.0,
                        "net_pnl": 0.0,
                    })

                print(f"[*] {symbol} variant {v_idx + 1}/{len(VARIANT_COMBINATIONS)} done", flush=True)

        _t0 = time.perf_counter()
        if all_day_candles:
            candles_file = os.path.join(OUTPUT_DIR, f"{symbol}_daycandles.json")
            safe_candles = sanitize_for_json(all_day_candles)
            with open(candles_file, "w") as f:
                json.dump(safe_candles, f, separators=(",", ":"), allow_nan=False)

        total_pair_seconds = round(tot_agg + tot_vol + tot_lvl + tot_strat + tot_sim + tot_rep, 1)

        # PROPOSED: wrong-engine guard.
        wrong_engine = (
            len(matrix_rows) != 6
            or any("Legacy" in r.get("label", "") for r in matrix_rows)
            or any("Trail on" in r.get("label", "") for r in matrix_rows)
        )

        # PROPOSED: engine line shown on the card and in the export.
        engine_line = (
            f"engine: {'fast' if cache_hit else 'cold'} | combos: {len(matrix_rows)} | "
            f"store: {'hit' if cache_hit else 'miss'} | "
            f"signal cache: {'hit' if cache_hit else 'miss'} | "
            f"precompute: {precompute_total_s}s"
        )
        print(f"[{symbol}] {engine_line}", flush=True)
        if wrong_engine:
            print(f"[{symbol}] WARN: WRONG ENGINE detected — combos={len(matrix_rows)}, legacy/trail present", flush=True)

        summary_payload = {
            "symbol": symbol,
            "days": days_count,
            "target_rr": orig_rr,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            "total_seconds": total_pair_seconds,
            "phase_seconds": {
                "aggregator_s": round(tot_agg, 1),
                "volatility_s": round(tot_vol, 1),
                "session_levels_s": round(tot_lvl, 1),
                "strategies_s": round(tot_strat, 1),
                "simulator_s": round(tot_sim, 1),
                "report_writing_s": round(tot_rep, 1),
            },
            "cpu_cores": os.cpu_count() or 1,
            "concurrent_processes": int(os.getenv("BACKTEST_CONCURRENT_WORKERS", "1")),
            "combinations": matrix_rows,
            # PROPOSED fields:
            "engine_line": engine_line,
            "engine_cache_hit": cache_hit,
            "combos_count": len(matrix_rows),
            "wrong_engine": wrong_engine,
            "precompute_s": precompute_total_s,
        }

        summary_file = os.path.join(OUTPUT_DIR, f"{symbol}_summary.json")
        safe_summary = sanitize_for_json(summary_payload)
        with open(summary_file, "w") as f:
            json.dump(safe_summary, f, separators=(",", ":"), allow_nan=False)
        tot_rep += time.perf_counter() - _t0

        # ---- Phase-3 variants summary file ----
        if variants and variant_rows:
            try:
                variants_payload = {
                    "symbol": symbol,
                    "days": days_count,
                    "target_rr": orig_rr,
                    "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
                    "variants": variant_rows,
                }
                variants_file = os.path.join(OUTPUT_DIR, f"{symbol}_variants.json")
                safe_variants = sanitize_for_json(variants_payload)
                with open(variants_file, "w") as f:
                    json.dump(safe_variants, f, separators=(",", ":"), allow_nan=False)
                print(f"[✓] {symbol} Variants saved to {variants_file}", flush=True)
            except Exception as ve:
                print(f"ERROR: saving variants file for {symbol} failed: {ve}", flush=True)

        print(
            f"[time] {symbol} aggregator {tot_agg:.1f}s, volatility {tot_vol:.1f}s, "
            f"session_levels {tot_lvl:.1f}s, strategies {tot_strat:.1f}s, "
            f"simulator {tot_sim:.1f}s, report_writing {tot_rep:.1f}s | Total: {total_pair_seconds:.1f}s",
            flush=True
        )

        print(f"[✓] {symbol} Matrix Complete: {len(matrix_rows)}/{len(COMBINATIONS)} combinations saved to {summary_file}", flush=True)
        return len(matrix_rows) > 0

    finally:
        GLOBAL_PARAMS.adaptive_mode = orig_adaptive
        GLOBAL_PARAMS.use_breakeven = orig_be
        GLOBAL_PARAMS.use_supertrend_trail = orig_trail
        GLOBAL_PARAMS.target_rr = orig_rr


# -----------------------------------------------------------------------------
# Strategy Lab
# -----------------------------------------------------------------------------

def _lab_kpis_and_split(trades: List[Dict[str, Any]], window_start_str: str, window_end_str: str) -> Dict[str, Any]:
    kpis = calculate_kpis(trades)
    tv = compute_tune_validate_kpis(trades, window_start_str, window_end_str)
    return {
        "trades": kpis["count"],
        "win_rate": kpis["win_rate"],
        "profit_factor": kpis["profit_factor"],
        "max_drawdown": kpis["max_dd_money"],
        "net_pnl": kpis["net_pnl"],
        "expectancy": kpis["expectancy"],
        "tune_pf": tv["tune"]["profit_factor"],
        "tune_trades": tv["tune"]["count"],
        "validate_pf": tv["validate"]["profit_factor"],
        "validate_trades": tv["validate"]["count"],
    }


def _lab_verdict(baseline: Optional[Dict[str, Any]], variant: Dict[str, Any]) -> str:
    if baseline is None:
        return "INCONCLUSIVE"
    if variant["tune_trades"] < 30 or variant["validate_trades"] < 30:
        return "INCONCLUSIVE"
    if (variant["tune_pf"] >= baseline["tune_pf"] + 0.05
            and variant["validate_pf"] >= baseline["validate_pf"] + 0.05):
        return "IMPROVES"
    return "NO"


def run_lab_combination(
    symbol: str,
    m5_df: pd.DataFrame,
    precomputed: Dict[str, Any],
    sim_start_idx: int,
    total_bars: int,
    filter_overrides: Dict[str, Any],
    target_rr_value: float,
    sm_for_filters: StrategyManager,
    balance: float = 1000.0,
    risk_pct: float = 1.0,
    eurusd_df: Optional[pd.DataFrame] = None,
) -> List[Dict[str, Any]]:
    saved = {
        'adaptive_mode': GLOBAL_PARAMS.adaptive_mode,
        'use_breakeven': GLOBAL_PARAMS.use_breakeven,
        'use_supertrend_trail': GLOBAL_PARAMS.use_supertrend_trail,
        'target_rr': GLOBAL_PARAMS.target_rr,
        'strat_disabled': list(getattr(GLOBAL_PARAMS, 'strat_disabled', []) or []),
        'strat_session_window_sast': getattr(GLOBAL_PARAMS, 'strat_session_window_sast', None),
        'strat_htf_trend_filter': getattr(GLOBAL_PARAMS, 'strat_htf_trend_filter', False),
        'strat_min_stop_atr': getattr(GLOBAL_PARAMS, 'strat_min_stop_atr', 0.0),
        'strat_max_spread_in_r': getattr(GLOBAL_PARAMS, 'strat_max_spread_in_r', 0.0),
    }
    try:
        GLOBAL_PARAMS.adaptive_mode = True
        GLOBAL_PARAMS.use_breakeven = True
        GLOBAL_PARAMS.use_supertrend_trail = False
        GLOBAL_PARAMS.target_rr = float(target_rr_value)

        if 'strat_disabled' in filter_overrides:
            GLOBAL_PARAMS.strat_disabled = list(filter_overrides['strat_disabled'])
        if 'strat_session_window_sast' in filter_overrides:
            GLOBAL_PARAMS.strat_session_window_sast = filter_overrides['strat_session_window_sast']
        if 'strat_htf_trend_filter' in filter_overrides:
            GLOBAL_PARAMS.strat_htf_trend_filter = bool(filter_overrides['strat_htf_trend_filter'])
        if 'strat_min_stop_atr' in filter_overrides:
            GLOBAL_PARAMS.strat_min_stop_atr = float(filter_overrides['strat_min_stop_atr'])
        if 'strat_max_spread_in_r' in filter_overrides:
            GLOBAL_PARAMS.strat_max_spread_in_r = float(filter_overrides['strat_max_spread_in_r'])

        sim = TradeSimulator(
            starting_balance=balance,
            risk_pct=risk_pct,
            eurusd_df=eurusd_df,
            be_mode="FIXED_80",
        )
        cached_signals = precomputed["cached_signals"]
        m5_times_list = m5_df['time'].tolist()
        has_ema200_col = 'ema_200' in m5_df.columns

        for i in range(sim_start_idx, total_bars):
            curr_bar = m5_df.iloc[i]
            curr_time = m5_times_list[i].to_pydatetime()

            if sim.open_positions or sim.pending_sl_evaluations:
                m5_slice = m5_df.iloc[max(0, i - 120):i + 1]
                sim.process_candle(symbol, curr_bar, m5_slice)

            if i not in cached_signals:
                continue

            item = cached_signals[i]
            signal = copy.deepcopy(item["raw_signal"])
            active_vol = item["active_vol"]
            session_levels = item["session_levels"]
            adr_val = item["adr_val"]
            regime = item["regime"]
            d1_view = item.get("d1_view")

            m5_slice_for_filter = m5_df.iloc[max(0, i - 120):i + 1]

            reason = sm_for_filters._apply_post_filters(signal, m5_slice_for_filter, d1_view, curr_time)
            if reason is not None:
                continue

            if not active_vol.get("valid", False):
                continue

            adapted = volatility_engine.adapt_signal(
                signal, active_vol, ui_rr=GLOBAL_PARAMS.target_rr, session_levels=session_levels
            )
            if not adapted:
                continue

            spread = ASSETS.get(symbol, {}).get("spread", 0.0001)
            sl_dist = abs(adapted.entry_price - adapted.stop_loss)
            tp_dist = abs(adapted.take_profit_2 - adapted.entry_price)
            vol_ok, _ = volatility_engine.evaluate_volatility_filters(
                active_vol, spread, sl_dist, tp_dist,
                adapted.direction, adapted.entry_price, adapted.strategy
            )
            if not vol_ok:
                continue

            signal = adapted

            has_open = any(p["symbol"] == symbol for p in sim.open_positions)
            if not has_open:
                ema_200_val: Optional[float] = None
                if has_ema200_col:
                    try:
                        v = float(m5_df.iloc[i]['ema_200'])
                        if not math.isnan(v):
                            ema_200_val = v
                    except (KeyError, IndexError, TypeError, ValueError):
                        ema_200_val = None
                sim.open_trade(
                    signal, curr_time, adr_val, regime, session_levels,
                    ema_200_value=ema_200_val,
                )

        if len(m5_df) > 0 and len(sim.open_positions) > 0:
            sim.close_all(symbol, m5_df.iloc[-1])

        return sim.completed_trades
    finally:
        for k, v in saved.items():
            setattr(GLOBAL_PARAMS, k, v)


async def run_strategy_lab(
    client: CTraderClient,
    symbol: str,
    days_count: int = 365,
    eurusd_df: Optional[pd.DataFrame] = None,
) -> bool:
    print(f"[LAB] {symbol}: starting Strategy Lab on {days_count}-day window...", flush=True)

    m5_path = os.path.join(DATA_DIR, f"{symbol}_M5.csv")
    h1_path = os.path.join(DATA_DIR, f"{symbol}_H1.csv")
    h4_path = os.path.join(DATA_DIR, f"{symbol}_H4.csv")
    d1_path = os.path.join(DATA_DIR, f"{symbol}_D1.csv")

    if not all(os.path.exists(p) for p in [m5_path, h1_path, h4_path, d1_path]):
        print(f"[LAB] ERROR: Incomplete data files for {symbol}. Run a normal backtest first.", flush=True)
        return False

    m5_df = pd.read_csv(m5_path)
    h1_df = pd.read_csv(h1_path)
    h4_df = pd.read_csv(h4_path)
    d1_df = pd.read_csv(d1_path)
    m5_df['time'] = pd.to_datetime(m5_df['time'], utc=True)
    total_bars = len(m5_df)

    if total_bars < 130:
        print(f"[LAB] ERROR: Insufficient bars for {symbol} ({total_bars} < 130).", flush=True)
        return False

    last_bar_time = m5_df['time'].iloc[-1]
    window_cutoff = last_bar_time - timedelta(days=days_count)
    matching_indices = m5_df.index[m5_df['time'] >= window_cutoff].tolist()
    sim_start_idx = max(120, matching_indices[0]) if matching_indices else max(120, total_bars - 1)
    window_start_str = m5_df['time'].iloc[sim_start_idx].strftime('%Y-%m-%d %H:%M:%S UTC')
    window_end_str = last_bar_time.strftime('%Y-%m-%d %H:%M:%S UTC')

    print(f"[LAB] {symbol}: precomputing once over {total_bars - sim_start_idx:,} candles...", flush=True)
    cached_precompute = _try_load_precompute(symbol, sim_start_idx, total_bars)
    if cached_precompute is not None:
        print(f"[LAB] {symbol}: using cached precompute pass.", flush=True)
        compute_121_window_emas(m5_df)
        compute_atr14_series(m5_df)
        precomputed = cached_precompute
    else:
        precomputed = precompute_market_pass(
            symbol=symbol,
            m5_df=m5_df,
            h1_df=h1_df,
            h4_df=h4_df,
            d1_df=d1_df,
            sim_start_idx=sim_start_idx,
            total_bars=total_bars,
        )
        try:
            _save_precompute(symbol, sim_start_idx, total_bars, precomputed)
        except Exception:
            pass

    lab_file = os.path.join(OUTPUT_DIR, f"{symbol}_lab.json")
    if os.path.exists(lab_file):
        try:
            os.remove(lab_file)
        except OSError:
            pass

    sm_for_filters = StrategyManager()
    results: List[Dict[str, Any]] = []
    baseline_kpis: Optional[Dict[str, Any]] = None

    for idx, variant in enumerate(LAB_VARIANTS):
        label = variant["label"]
        overrides = dict(variant["overrides"])
        target_rr_value = float(overrides.pop("target_rr", 1.0))

        print(f"[LAB] {symbol}: variant {idx + 1}/{len(LAB_VARIANTS)} — {label}", flush=True)
        try:
            trades = run_lab_combination(
                symbol=symbol,
                m5_df=m5_df,
                precomputed=precomputed,
                sim_start_idx=sim_start_idx,
                total_bars=total_bars,
                filter_overrides=overrides,
                target_rr_value=target_rr_value,
                sm_for_filters=sm_for_filters,
                eurusd_df=eurusd_df,
            )
            kpi = _lab_kpis_and_split(trades, window_start_str, window_end_str)
        except Exception as e:
            print(f"[LAB] {symbol}: variant '{label}' failed: {e}", flush=True)
            kpi = {
                "trades": 0, "win_rate": 0.0, "profit_factor": 0.0,
                "max_drawdown": 0.0, "net_pnl": 0.0, "expectancy": 0.0,
                "tune_pf": 0.0, "tune_trades": 0,
                "validate_pf": 0.0, "validate_trades": 0,
            }

        row = {"label": label, **kpi}
        if label == "Baseline":
            baseline_kpis = kpi
        results.append(row)

    for row in results:
        row["verdict"] = _lab_verdict(baseline_kpis, row)

    payload = {
        "symbol": symbol,
        "days": days_count,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "window_start": window_start_str,
        "window_end": window_end_str,
        "baseline_label": "Baseline",
        "variants": results,
    }
    safe = sanitize_for_json(payload)
    with open(lab_file, "w") as f:
        json.dump(safe, f, separators=(",", ":"), allow_nan=False)

    print(f"[LAB] {symbol}: saved lab results to {lab_file}", flush=True)
    return True


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, default="US30")
    parser.add_argument("--symbols", type=str, default=None,
                        help="Comma-separated list of symbols (overrides --symbol)")
    parser.add_argument("--days", type=int, default=60)
    parser.add_argument("--rr", type=float, default=1.0, help="Default target R:R; each combo may override")
    parser.add_argument("--mode", type=str, default=None)
    parser.add_argument("--adaptive", action="store_true", default=True)
    parser.add_argument("--breakeven", type=str, default="off")
    parser.add_argument("--supertrend", type=str, default="on")
    parser.add_argument("--compare", action="store_true", default=False,
                        help="Run 4-combination verification vs reference engine")
    parser.add_argument("--prepare-only", action="store_true", default=False,
                        help="Prepare and update market data only, then exit")
    parser.add_argument("--skip-download", action="store_true", default=False,
                        help="Skip downloading data and run matrix from local cache")
    parser.add_argument("--variants", action="store_true", default=False,
                        help="Also run Phase-3 variant combos and save <symbol>_variants.json")
    parser.add_argument("--portfolio-only", action="store_true", default=False,
                        help="Only compute the cross-pair correlation matrix and exit")
    parser.add_argument("--lab", action="store_true", default=False,
                        help="Run Strategy Lab on the given symbol(s) and write <symbol>_lab.json")
    args = parser.parse_args()

    if args.symbols:
        symbols_list = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    else:
        symbols_list = [args.symbol.upper()]

    client = CTraderClient()

    if args.portfolio_only:
        ok = write_portfolio_correlation()
        sys.exit(0 if ok else 1)

    if args.prepare_only:
        overall_ok = True
        for sym in symbols_list:
            ok = await ensure_symbol_data(client, sym)
            if not ok:
                overall_ok = False
            if sym == "GERMAN30":
                await ensure_symbol_data(client, "EURUSD")
        if client.ws:
            try:
                await client.ws.close()
            except Exception:
                pass
        sys.exit(0 if overall_ok else 1)

    if args.compare:
        sym = symbols_list[0]
        eurusd_df: Optional[pd.DataFrame] = None
        if sym == "GERMAN30":
            eurusd_path = os.path.join(DATA_DIR, "EURUSD_M5.csv")
            if os.path.exists(eurusd_path):
                eurusd_df = pd.read_csv(eurusd_path)
        res_text = compare_runs(symbol=sym, days_count=30, eurusd_df=eurusd_df)
        return

    if args.lab:
        overall_ok = True
        for sym in symbols_list:
            eurusd_df: Optional[pd.DataFrame] = None
            if sym == "GERMAN30":
                eurusd_path = os.path.join(DATA_DIR, "EURUSD_M5.csv")
                if os.path.exists(eurusd_path):
                    try:
                        eurusd_df = pd.read_csv(eurusd_path)
                    except Exception as e:
                        print(f"[LAB] {sym}: could not load EURUSD history: {e}", flush=True)
                        overall_ok = False
                        continue
                else:
                    print(f"[LAB] {sym}: EURUSD history missing (required for GERMAN30)", flush=True)
                    overall_ok = False
                    continue
            try:
                ok = await run_strategy_lab(client, sym, days_count=365, eurusd_df=eurusd_df)
                if not ok:
                    overall_ok = False
            except Exception as e:
                print(f"[LAB] {sym}: fatal error: {e}", flush=True)
                overall_ok = False

        if client.ws:
            try:
                await client.ws.close()
            except Exception:
                pass
        sys.exit(0 if overall_ok else 1)

    # Normal backtest path (single or multi-symbol)
    usage = shutil.disk_usage(OUTPUT_DIR)
    free_mb = usage.free / (1024 * 1024)
    if free_mb < 80.0:
        print(f"ERROR: Low disk space on storage volume ({int(free_mb)} MB free). Clear old reports from the Storage panel.", flush=True)
        sys.exit(1)

    GLOBAL_PARAMS.target_rr = args.rr

    run_started_at = time.perf_counter()

    all_ok = True
    for sym in symbols_list:
        if not args.skip_download:
            ok = await ensure_symbol_data(client, sym)
        else:
            ok = True

        eurusd_df: Optional[pd.DataFrame] = None
        if sym == "GERMAN30":
            if not args.skip_download:
                eurusd_ok = await ensure_symbol_data(client, "EURUSD")
            else:
                eurusd_ok = True
            eurusd_path = os.path.join(DATA_DIR, "EURUSD_M5.csv")
            if not eurusd_ok or not os.path.exists(eurusd_path):
                print(f"ERROR: GERMAN30 needs EURUSD history", flush=True)
                all_ok = False
                continue
            try:
                eurusd_df = pd.read_csv(eurusd_path)
            except Exception:
                print(f"ERROR: GERMAN30 needs EURUSD history", flush=True)
                all_ok = False
                continue

        success = False
        if ok:
            success = await run_symbol_matrix(
                client, sym, args.days,
                eurusd_df=eurusd_df,
                variants=args.variants,
            )
        if not success:
            all_ok = False

    try:
        write_portfolio_correlation()
    except Exception as pe:
        print(f"WARNING: portfolio correlation refresh failed: {pe}", flush=True)

    try:
        write_entry_analysis(OUTPUT_DIR)
    except Exception as ea:
        print(f"WARNING: entry analysis refresh failed: {ea}", flush=True)

    if client.ws:
        try:
            await client.ws.close()
        except Exception:
            pass

    # PROPOSED: wall-clock total for the whole run, printed so server.ts or a
    # human can read it.
    total_wall = time.perf_counter() - run_started_at
    print(f"[TOTAL] wall_clock_seconds={total_wall:.1f}", flush=True)

    sys.exit(0 if all_ok else 1)


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