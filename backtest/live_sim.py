"""
backtest/live_sim.py
Live Bot Portfolio Replay.

Simulates the LIVE bot as a single account. One TradeSimulator instance
across all pairs. One equity. One set of daily caps. One risk profile.
One timeline. Trades advance together.

This is the mode that answers: "What would the live bot have actually
done over the last N days on a single starting balance?"

ARCHITECTURE (Option C — full separation)
-----------------------------------------
This file is self-contained. It does NOT import from backtest.runner and
does NOT read the Strategy Research precompute cache.

It generates its own candidate signals by walking the M5 series bar by
bar and calling StrategyManager.evaluate_all directly. The signals are
cached in a separate file ({SYMBOL}_live_signals.pkl.gz) whose key
includes the strategy sources, the current pair_settings.json, and the
live-relevant GLOBAL_PARAMS. Change any of those and the cache rebuilds
automatically.

The candidate signals this file generates are the SAME candidates the
live bot would see:
  - always-on filters (SAST window, blocked hours, HTF alignment,
    spread-in-R ceiling) are applied inside evaluate_all, because those
    are live rules
  - backtest-only post-filters are NOT applied, because those exist
    only to let the research panel explore counterfactuals

Per-trade decisions (pair-settings, adaptive volatility, volatility
filters, sizing, daily cap, one-position-per-symbol) are made at replay
time, against the shared equity, in strict chronological order. This is
the behaviour that makes the live sim distinct from the research panel.

Author: NEXUS Matrix
"""

import os
import sys
import copy
import math
import json
import time
import gzip
import pickle
import hashlib
import glob
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Any, Optional, Tuple

import numpy as np
import pandas as pd

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from core.session_config import GLOBAL_PARAMS, TZ_SAST
from core.volatility_engine import volatility_engine
from core.indicators import get_session_volume_profile
from core.session_levels import build_session_levels
from core.pair_settings import (
    load_pair_settings,
    get_strategy_settings,
    passes_signal_filters,
    get_effective_rr,
    get_effective_be,
)
from strategies.strategy_manager import StrategyManager
from backtest.bar_aggregator import ZeroLookAheadAggregator
from backtest.simulator import TradeSimulator, ASSETS
from backtest.paths import DATA_DIR, OUTPUT_DIR
from backtest.report import calculate_kpis


# ---------------------------------------------------------------------------
# Constants (local — no dependency on the research runner)
# ---------------------------------------------------------------------------

WHITELIST_PAIRS = ["US30", "GOLD", "NAS100", "GERMAN30", "EURUSD", "GBPUSD", "USDJPY"]

MIN_SESSION_BARS = 20

# Local copy of the combo matrix. Kept independent on purpose: a change to
# the research runner's COMBINATIONS must never silently change what the
# live sim tests. If you want them to stay in lockstep, edit both lists.
LIVE_SIM_COMBINATIONS: List[Dict[str, Any]] = [
    {"mode": "adaptive", "adaptive_mode": True, "be": "off", "use_be": False,
     "trail": "off", "use_trail": False,
     "label": "Adaptive · BE off · R:R 1:2.5", "rr_override": 2.5},
    {"mode": "adaptive", "adaptive_mode": True, "be": "on", "use_be": True,
     "trail": "off", "use_trail": False,
     "label": "Adaptive · BE on · R:R 1:2.5", "rr_override": 2.5},
    {"mode": "adaptive", "adaptive_mode": True, "be": "off", "use_be": False,
     "trail": "off", "use_trail": False,
     "label": "Adaptive · BE off · R:R 1:2", "rr_override": 2.0},
    {"mode": "adaptive", "adaptive_mode": True, "be": "on", "use_be": True,
     "trail": "off", "use_trail": False,
     "label": "Adaptive · BE on · R:R 1:2", "rr_override": 2.0},
    {"mode": "adaptive", "adaptive_mode": True, "be": "off", "use_be": False,
     "trail": "off", "use_trail": False,
     "label": "Adaptive · BE off · R:R 1:3", "rr_override": 3.0},
    {"mode": "adaptive", "adaptive_mode": True, "be": "on", "use_be": True,
     "trail": "off", "use_trail": False,
     "label": "Adaptive · BE on · R:R 1:3", "rr_override": 3.0},
]


# ---------------------------------------------------------------------------
# Small utilities (local copies — keep this file self-contained)
# ---------------------------------------------------------------------------

def sanitize_for_json(obj: Any) -> Any:
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
        print(f"[live-sim][atr14] failed: {e}", flush=True)


def _session_start_utc(d1_view: pd.DataFrame) -> Optional[datetime]:
    if d1_view is None or d1_view.empty:
        return None
    try:
        last_bar = d1_view.iloc[-1]
        t = pd.to_datetime(last_bar['time'], utc=True)
        if hasattr(t, 'to_pydatetime'):
            return t.to_pydatetime()
        return t
    except Exception:
        return None


def _compute_session_volume_profile(
    m5_df: pd.DataFrame,
    session_start: Optional[datetime],
    min_bars: int = MIN_SESSION_BARS,
) -> Dict[str, Any]:
    if m5_df is None or m5_df.empty:
        return get_session_volume_profile(m5_df)
    if session_start is None:
        return get_session_volume_profile(m5_df)
    try:
        if session_start.tzinfo is None:
            session_start = session_start.replace(tzinfo=timezone.utc)
        m5_times = pd.to_datetime(m5_df['time'], utc=True)
        session_bars = m5_df[m5_times >= session_start]
        if len(session_bars) >= min_bars:
            return get_session_volume_profile(session_bars)
    except Exception:
        pass
    return get_session_volume_profile(m5_df)


# ---------------------------------------------------------------------------
# Live signal cache (fully independent of the research precompute)
# ---------------------------------------------------------------------------

_LIVE_SIGNAL_STATIC_SOURCES = [
    "core/session_config.py",
    "core/session_levels.py",
    "core/indicators.py",
    "core/volatility_engine.py",
    "core/targets.py",
    "core/volume_profile.py",
    "core/pair_settings.py",
    "core/spread_config.py",
    "core/pip_sizes.py",
    "backtest/bar_aggregator.py",
    "strategies/base.py",
    "strategies/strategy_manager.py",
]

# GLOBAL_PARAMS that affect what evaluate_all returns. If any of these
# change, the live signal cache must be rebuilt.
_LIVE_SIGNAL_GLOBAL_KEYS = [
    "target_rr",
    "use_breakeven",
    "use_supertrend_trail",
    "adaptive_mode",
    "trading_hours_sast_start",
    "trading_hours_sast_end",
    "blocked_hours_sast",
    "blocked_weekdays",
    "max_spread_in_r",
    "strat_always_htf_targets",
    "min_stop_pips",
    "breakeven_trigger_r",
]


def _live_signal_source_hash() -> str:
    h = hashlib.sha256()
    for rel in _LIVE_SIGNAL_STATIC_SOURCES:
        p = os.path.join(PROJECT_ROOT, rel)
        try:
            with open(p, "rb") as f:
                h.update(rel.encode())
                h.update(f.read())
        except FileNotFoundError:
            h.update(rel.encode())
    for p in sorted(glob.glob(os.path.join(PROJECT_ROOT, "strategies", "*.py"))):
        rel = os.path.relpath(p, PROJECT_ROOT).replace("\\", "/")
        try:
            with open(p, "rb") as f:
                h.update(rel.encode())
                h.update(f.read())
        except OSError:
            pass
    for key in _LIVE_SIGNAL_GLOBAL_KEYS:
        try:
            val = getattr(GLOBAL_PARAMS, key, None)
            h.update(f"{key}={repr(val)}".encode())
        except Exception:
            pass
    return h.hexdigest()[:16]


def _pair_settings_hash(pair_settings: Optional[Dict[str, Any]]) -> str:
    try:
        canonical = json.dumps(pair_settings or {}, sort_keys=True, default=str)
        return hashlib.sha256(canonical.encode()).hexdigest()[:12]
    except Exception:
        return "na"


def _live_signal_cache_key(
    symbol: str,
    sim_start_idx: int,
    total_bars: int,
    pair_settings: Optional[Dict[str, Any]],
) -> str:
    src = _live_signal_source_hash()
    ps = _pair_settings_hash(pair_settings)
    return f"{symbol}|{sim_start_idx}|{total_bars}|{src}|{ps}"


def _live_signal_cache_path(symbol: str) -> str:
    return os.path.join(DATA_DIR, f"{symbol}_live_signals.pkl.gz")


def _try_load_live_signal_cache(
    symbol: str,
    sim_start_idx: int,
    total_bars: int,
    pair_settings: Optional[Dict[str, Any]],
) -> Tuple[Optional[Dict[str, Any]], str]:
    path = _live_signal_cache_path(symbol)
    if not os.path.exists(path):
        return None, "missing"
    try:
        with gzip.open(path, "rb") as f:
            payload = pickle.load(f)
        if not isinstance(payload, dict):
            return None, "malformed"
        expected = _live_signal_cache_key(symbol, sim_start_idx, total_bars, pair_settings)
        if payload.get("__key__") != expected:
            return None, "settings changed"
        signals = payload.get("signals")
        if not isinstance(signals, dict):
            return None, "malformed signals"
        return payload, "hit"
    except Exception as e:
        return None, f"error: {e}"


def _save_live_signal_cache(
    symbol: str,
    sim_start_idx: int,
    total_bars: int,
    pair_settings: Optional[Dict[str, Any]],
    signals: Dict[int, Any],
    build_seconds: float,
) -> None:
    path = _live_signal_cache_path(symbol)
    payload = {
        "__key__": _live_signal_cache_key(symbol, sim_start_idx, total_bars, pair_settings),
        "__version__": "1.0",
        "__built_at__": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "__build_seconds__": float(build_seconds),
        "__count__": len(signals),
        "__pair_settings_hash__": _pair_settings_hash(pair_settings),
        "signals": signals,
    }
    tmp = path + ".tmp"
    try:
        with gzip.open(tmp, "wb", compresslevel=6) as f:
            pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)
        os.replace(tmp, path)
    except Exception as e:
        print(f"[live-sim] {symbol}: could not write signal cache: {e}", flush=True)
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Live signal generation (own pipeline, own entry confirmations)
# ---------------------------------------------------------------------------

def _build_live_signals_for_pair(
    symbol: str,
    m5_df: pd.DataFrame,
    h1_df: pd.DataFrame,
    h4_df: pd.DataFrame,
    d1_df: pd.DataFrame,
    sim_start_idx: int,
    total_bars: int,
) -> Dict[int, Dict[str, Any]]:
    """
    Walk the M5 window bar by bar, call StrategyManager.evaluate_all on
    each, cache every raw signal keyed by epoch.

    This is the live sim's OWN candidate set. It runs with
    apply_strat_filters=False, so:
      - always-on filters (SAST window, blocked hours, HTF alignment,
        spread-in-R ceiling) run inside evaluate_all, exactly like the
        live bot
      - backtest-only post-filters do NOT run
      - pair-settings, adaptive volatility, and volatility filters are
        left for the replay loop, which applies them against the shared
        equity and current state
    """
    aggregator = ZeroLookAheadAggregator(d1_df, h4_df, h1_df)
    sm = StrategyManager()
    frozen_orbs: Dict[Any, Any] = {}

    last_d1_bar_count = -1
    last_vol_date = None
    vol_metrics: Dict[str, Any] = {"valid": False}
    adr_val = None
    regime = "NORMAL"

    signals: Dict[int, Dict[str, Any]] = {}
    m5_times_list = m5_df['time'].tolist()
    total_sim_bars = max(1, total_bars - sim_start_idx)
    next_progress_pct = 20

    for i in range(sim_start_idx, total_bars):
        curr_time = m5_times_list[i].to_pydatetime()
        curr_bar = m5_df.iloc[i]
        m5_slice = m5_df.iloc[max(0, i - 120):i + 1]

        pct = int(((i - sim_start_idx) / total_sim_bars) * 100)
        if pct >= next_progress_pct:
            print(f"[live-sim] {symbol} precompute {next_progress_pct}% ...", flush=True)
            next_progress_pct += 20

        # Skip weekend bars. The live bot never sees them from the feed.
        wkday = curr_time.weekday()
        if wkday == 5 or (wkday == 6 and curr_time.hour < 21):
            continue

        h1_view, h4_view, d1_view = aggregator.get_feeds_at_time(m5_slice, curr_time)

        curr_d1_len = len(d1_view)
        curr_date = curr_time.date()
        need_full_recalc = (
            curr_d1_len != last_d1_bar_count
            or curr_date != last_vol_date
            or not vol_metrics.get("valid", False)
        )

        if need_full_recalc:
            vol_metrics = volatility_engine.compute_symbol_volatility(
                d1_df=d1_view,
                m5_df=m5_slice,
                current_quote=float(curr_bar['close']),
                symbol=symbol,
                as_of=curr_time,
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
                as_of=curr_time,
            )
        else:
            active_vol = vol_metrics

        session_start = _session_start_utc(d1_view)
        vp = _compute_session_volume_profile(m5_slice, session_start)
        session_levels = build_session_levels(
            symbol=symbol,
            m5_df=m5_slice,
            d1_df=d1_view,
            vp_node=vp,
            frozen_orbs=frozen_orbs,
            as_of=curr_time,
            adr_val=adr_val,
        )

        # apply_strat_filters defaults to False — we want the live sim's
        # own candidates, not the research panel's filtered set.
        raw_signal = sm.evaluate_all(
            symbol=symbol,
            data_5m=m5_slice,
            data_h4=h4_view,
            data_d1=d1_view,
            session_levels=session_levels,
            data_h1=h1_view,
        )

        if raw_signal is not None:
            try:
                epoch = int(curr_time.timestamp())
            except Exception:
                continue
            signals[epoch] = {
                "raw_signal": raw_signal,
                "active_vol": active_vol,
                "session_levels": session_levels,
                "adr_val": adr_val,
                "regime": regime,
            }

    print(
        f"[live-sim] {symbol} precompute 100% complete "
        f"({len(signals)} signals)",
        flush=True,
    )
    return signals


# ---------------------------------------------------------------------------
# Pair loader (own cache, own build)
# ---------------------------------------------------------------------------

def _load_pair_for_live_sim(
    sym: str,
    days_count: int,
    pair_settings: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    m5_path = os.path.join(DATA_DIR, f"{sym}_M5.csv")
    h1_path = os.path.join(DATA_DIR, f"{sym}_H1.csv")
    h4_path = os.path.join(DATA_DIR, f"{sym}_H4.csv")
    d1_path = os.path.join(DATA_DIR, f"{sym}_D1.csv")

    if not all(os.path.exists(p) for p in [m5_path, h1_path, h4_path, d1_path]):
        print(f"[live-sim] {sym}: missing market data files, skipping.", flush=True)
        return None

    try:
        m5_df = pd.read_csv(m5_path)
        h1_df = pd.read_csv(h1_path)
        h4_df = pd.read_csv(h4_path)
        d1_df = pd.read_csv(d1_path)
        m5_df['time'] = pd.to_datetime(m5_df['time'], utc=True)
    except Exception as e:
        print(f"[live-sim] {sym}: could not load market data ({e}).", flush=True)
        return None

    if m5_df.empty:
        print(f"[live-sim] {sym}: M5 file is empty, skipping.", flush=True)
        return None

    compute_121_window_emas(m5_df)
    compute_atr14_series(m5_df)

    last_bar = m5_df['time'].iloc[-1]
    cutoff = last_bar - pd.Timedelta(days=int(days_count))
    mask = (m5_df['time'] >= cutoff).to_numpy()
    if not mask.any():
        print(f"[live-sim] {sym}: no bars in window, skipping.", flush=True)
        return None
    sim_start_idx = max(120, int(mask.argmax()))
    total_bars = len(m5_df)

    cached, reason = _try_load_live_signal_cache(
        sym, sim_start_idx, total_bars, pair_settings,
    )

    if cached is not None:
        built_at = cached.get("__built_at__", "?")
        build_s = cached.get("__build_seconds__", 0.0)
        count = cached.get("__count__", 0)
        print(
            f"[live-sim] {sym}: cache hit "
            f"(built {built_at}, {int(build_s)}s, {count} signals)",
            flush=True,
        )
        signals = cached.get("signals", {})
    else:
        print(f"[live-sim] {sym}: cache miss ({reason}), building now...", flush=True)
        t0 = time.perf_counter()
        signals = _build_live_signals_for_pair(
            sym, m5_df, h1_df, h4_df, d1_df, sim_start_idx, total_bars,
        )
        build_seconds = time.perf_counter() - t0
        _save_live_signal_cache(
            sym, sim_start_idx, total_bars, pair_settings, signals, build_seconds,
        )
        print(
            f"[live-sim] {sym}: cache built in {build_seconds:.1f}s "
            f"({len(signals)} signals)",
            flush=True,
        )

    return {
        "m5_df": m5_df,
        "sim_start_idx": sim_start_idx,
        "total_bars": total_bars,
        "signal_by_time": signals,
    }


# ---------------------------------------------------------------------------
# Portfolio simulator (unchanged trading loop)
# ---------------------------------------------------------------------------

class LivePortfolioSimulator:
    """
    Walk-forward single-account simulator for the live bot.

    Instantiate once per combo. Call .run() to walk the timeline and
    return a report dict.
    """

    def __init__(
        self,
        combo: Dict[str, Any],
        balance_usd: float,
        profile_name: Optional[str],
        pair_data: Dict[str, Dict[str, Any]],
        zar_per_usd: float = 18.0,
        pair_settings: Optional[Dict[str, Any]] = None,
    ):
        self.combo = combo
        self.balance_usd = float(balance_usd)
        self.profile_name = profile_name
        self.pair_data = pair_data
        self.pair_settings = pair_settings
        self.zar_per_usd = float(zar_per_usd) if zar_per_usd and zar_per_usd > 0 else 18.0
        self.combo_label = combo.get('label', 'Unknown')

        self.use_be = bool(combo.get('use_be', False))
        self.use_trail = bool(combo.get('use_trail', False))
        self.adaptive_mode = bool(combo.get('adaptive_mode', True))
        self.rr_override = combo.get('rr_override', None)

        self.sim = TradeSimulator(
            starting_balance=self.balance_usd,
            risk_pct=1.0,
            be_mode="FIXED_80",
            m5_df_full=None,
            profile_name=profile_name,
            zar_per_usd=self.zar_per_usd,
        )

        self.timeline = self._build_timeline()
        self.pair_setting_skips: List[Dict[str, Any]] = []

    def _build_timeline(self) -> List[Tuple[pd.Timestamp, str, int]]:
        events: List[Tuple[pd.Timestamp, str, int]] = []
        for sym, data in self.pair_data.items():
            m5 = data['m5_df']
            start = int(data['sim_start_idx'])
            total = len(m5)
            for idx in range(start, total):
                t = m5['time'].iloc[idx]
                events.append((t, sym, idx))
        events.sort(key=lambda x: (x[0], x[1]))
        return events

    def run(self) -> Dict[str, Any]:
        orig_rr = GLOBAL_PARAMS.target_rr
        orig_be = GLOBAL_PARAMS.use_breakeven
        orig_trail = GLOBAL_PARAMS.use_supertrend_trail
        orig_adaptive = GLOBAL_PARAMS.adaptive_mode

        try:
            if self.rr_override is not None:
                GLOBAL_PARAMS.target_rr = float(self.rr_override)
            GLOBAL_PARAMS.use_breakeven = self.use_be
            GLOBAL_PARAMS.use_supertrend_trail = self.use_trail
            GLOBAL_PARAMS.adaptive_mode = self.adaptive_mode

            for t, sym, idx in self.timeline:
                self._process_event(t, sym, idx)

            self._close_all_at_end()
        finally:
            GLOBAL_PARAMS.target_rr = orig_rr
            GLOBAL_PARAMS.use_breakeven = orig_be
            GLOBAL_PARAMS.use_supertrend_trail = orig_trail
            GLOBAL_PARAMS.adaptive_mode = orig_adaptive

        return self._build_report()

    def _process_event(self, t: pd.Timestamp, sym: str, idx: int) -> None:
        m5 = self.pair_data[sym]['m5_df']

        has_on_sym = any(p['symbol'] == sym for p in self.sim.open_positions)
        has_pending = any(p.get('symbol') == sym for p in self.sim.pending_sl_evaluations)
        if has_on_sym or has_pending:
            bar = m5.iloc[idx]
            m5_slice = m5.iloc[max(0, idx - 120):idx + 1]
            try:
                self.sim.process_candle(sym, bar, m5_slice)
            except Exception as e:
                print(f"[live-sim] process_candle error on {sym} at {t}: {e}", flush=True)

        t_key = int(t.timestamp())
        signal_data = self.pair_data[sym]['signal_by_time'].get(t_key)
        if signal_data is None:
            return
        self._try_open_trade(sym, idx, t, signal_data)

    def _try_open_trade(
        self,
        sym: str,
        idx: int,
        t: pd.Timestamp,
        signal_data: Dict[str, Any],
    ) -> None:
        if any(p['symbol'] == sym for p in self.sim.open_positions):
            return

        sig = copy.deepcopy(signal_data['raw_signal'])
        m5 = self.pair_data[sym]['m5_df']

        strat_rr = GLOBAL_PARAMS.target_rr
        strat_be = self.use_be
        if self.pair_settings:
            strat_s = get_strategy_settings(self.pair_settings, sym, sig.strategy)

            try:
                atr14_val = float(m5.iloc[idx]['atr_14'])
                if not math.isfinite(atr14_val):
                    atr14_val = 0.0
            except Exception:
                atr14_val = 0.0

            asset_spread = ASSETS.get(sym, {}).get('spread', 0.0)
            try:
                t_dt = t.to_pydatetime() if hasattr(t, 'to_pydatetime') else t
            except Exception:
                t_dt = None

            try:
                passes, reason = passes_signal_filters(
                    strat_s, sig, t_dt, atr14_val, asset_spread,
                )
            except Exception:
                passes, reason = True, ''

            if not passes:
                sast = t.tz_convert(TZ_SAST) if hasattr(t, 'tz_convert') else t
                self.pair_setting_skips.append({
                    'time': t.strftime('%Y-%m-%d %H:%M:%S') if hasattr(t, 'strftime') else str(t),
                    'date_sast': sast.strftime('%Y-%m-%d') if hasattr(sast, 'strftime') else '',
                    'symbol': sym,
                    'strategy': sig.strategy,
                    'direction': sig.direction,
                    'reason': reason,
                    'hour_sast': int(sast.hour) if hasattr(sast, 'hour') else 0,
                })
                return

            strat_rr = get_effective_rr(strat_s, GLOBAL_PARAMS.target_rr)
            strat_be = get_effective_be(strat_s, self.use_be)

        if self.adaptive_mode:
            active_vol = signal_data.get('active_vol') or {}
            if not active_vol.get('valid', False):
                return
            session_levels = signal_data.get('session_levels') or {}
            try:
                adapted = volatility_engine.adapt_signal(
                    sig, active_vol, strat_rr, session_levels,
                )
            except Exception:
                return
            if not adapted:
                return

            spread = ASSETS.get(sym, {}).get('spread', 0.0001)
            sl_dist = abs(adapted.entry_price - adapted.stop_loss)
            tp_dist = abs(adapted.take_profit_2 - adapted.entry_price)
            try:
                vol_ok, _ = volatility_engine.evaluate_volatility_filters(
                    active_vol, spread, sl_dist, tp_dist,
                    adapted.direction, adapted.entry_price, adapted.strategy,
                )
            except Exception:
                vol_ok = False
            if not vol_ok:
                return

            sig = adapted

        try:
            t_dt = t.to_pydatetime() if hasattr(t, 'to_pydatetime') else t
        except Exception:
            return

        self.sim.open_trade(
            sig,
            t_dt,
            signal_data.get('adr_val'),
            signal_data.get('regime', 'NORMAL') or 'NORMAL',
            signal_data.get('session_levels') or {},
            use_breakeven_override=strat_be,
        )

    def _close_all_at_end(self) -> None:
        for sym, data in self.pair_data.items():
            if any(p['symbol'] == sym for p in self.sim.open_positions):
                last_bar = data['m5_df'].iloc[-1]
                try:
                    self.sim.close_all(sym, last_bar)
                except Exception as e:
                    print(f"[live-sim] close_all error on {sym}: {e}", flush=True)
        try:
            for pending in self.sim.pending_sl_evaluations:
                self.sim._finalize_post_exit(pending)
        except Exception:
            pass
        self.sim.pending_sl_evaluations = []

    def _build_equity_curve(self) -> List[Dict[str, Any]]:
        curve = [{
            'trade_n': 0,
            'time': '',
            'equity': round(self.balance_usd, 2),
        }]
        eq = self.balance_usd
        ordered = sorted(
            self.sim.completed_trades,
            key=lambda tr: str(tr.get('exit_time', '')),
        )
        for i, tr in enumerate(ordered, 1):
            eq += float(tr.get('money_pnl', 0.0) or 0.0)
            curve.append({
                'trade_n': i,
                'time': tr.get('exit_time', ''),
                'equity': round(eq, 2),
            })
        return curve

    def _build_daily_equity(self) -> List[Dict[str, Any]]:
        by_day: Dict[str, List[Dict[str, Any]]] = {}
        for tr in self.sim.completed_trades:
            day = tr.get('date_sast') or ''
            if not day:
                continue
            by_day.setdefault(day, []).append(tr)

        daily: List[Dict[str, Any]] = []
        eq = self.balance_usd
        for day in sorted(by_day.keys()):
            day_trades = by_day[day]
            open_eq = eq
            day_pnl = sum(float(t.get('money_pnl', 0.0) or 0.0) for t in day_trades)
            eq += day_pnl
            daily.append({
                'date': day,
                'open_equity': round(open_eq, 2),
                'close_equity': round(eq, 2),
                'pnl': round(day_pnl, 2),
                'trades': len(day_trades),
            })
        return daily

    def _build_per_pair(self) -> Dict[str, Dict[str, Any]]:
        per: Dict[str, Dict[str, Any]] = {}
        for sym in self.pair_data.keys():
            sym_trades = [
                tr for tr in self.sim.completed_trades if tr.get('symbol') == sym
            ]
            if not sym_trades:
                per[sym] = {
                    'trades': 0, 'wins': 0, 'losses': 0, 'breakeven': 0,
                    'net_pnl': 0.0, 'win_rate': 0.0, 'profit_factor': 0.0,
                }
                continue

            wins = [tr for tr in sym_trades if tr.get('result') == 'WIN']
            losses = [tr for tr in sym_trades if tr.get('result') == 'LOSS']
            bes = [tr for tr in sym_trades if tr.get('result') == 'BREAKEVEN']

            gross_win = sum(float(tr.get('money_pnl', 0.0) or 0.0) for tr in wins)
            gross_loss = abs(sum(float(tr.get('money_pnl', 0.0) or 0.0) for tr in losses))
            net = sum(float(tr.get('money_pnl', 0.0) or 0.0) for tr in sym_trades)
            pf = (gross_win / gross_loss) if gross_loss > 0 else (99.0 if gross_win > 0 else 0.0)
            wr = (len(wins) / len(sym_trades)) * 100.0

            per[sym] = {
                'trades': len(sym_trades),
                'wins': len(wins),
                'losses': len(losses),
                'breakeven': len(bes),
                'net_pnl': round(net, 2),
                'win_rate': round(wr, 1),
                'profit_factor': round(pf, 2),
            }
        return per

    def _build_skip_summary(self) -> Dict[str, Any]:
        combined = list(self.sim.skipped) + self.pair_setting_skips
        by_reason: Dict[str, int] = {}
        by_pair: Dict[str, int] = {}
        by_strategy: Dict[str, int] = {}

        for s in combined:
            r = str(s.get('reason', 'UNKNOWN'))
            by_reason[r] = by_reason.get(r, 0) + 1
            p = str(s.get('symbol', 'UNKNOWN'))
            by_pair[p] = by_pair.get(p, 0) + 1
            st = str(s.get('strategy', 'UNKNOWN'))
            by_strategy[st] = by_strategy.get(st, 0) + 1

        return {
            'total': len(combined),
            'by_reason': by_reason,
            'by_pair': by_pair,
            'by_strategy': by_strategy,
        }

    def _build_report(self) -> Dict[str, Any]:
        trades = list(self.sim.completed_trades)
        kpis = calculate_kpis(trades)
        final_equity = float(self.sim.balance)

        ordered = sorted(trades, key=lambda tr: str(tr.get('signal_time_utc', '')))

        max_loss_streak = 0
        cur = 0
        for tr in ordered:
            if tr.get('result') == 'LOSS':
                cur += 1
                if cur > max_loss_streak:
                    max_loss_streak = cur
            else:
                cur = 0

        eq = self.balance_usd
        peak = eq
        max_dd = 0.0
        for tr in ordered:
            eq += float(tr.get('money_pnl', 0.0) or 0.0)
            if eq > peak:
                peak = eq
            dd = peak - eq
            if dd > max_dd:
                max_dd = dd

        net_pnl = final_equity - self.balance_usd
        net_pct = (net_pnl / self.balance_usd * 100.0) if self.balance_usd > 0 else 0.0

        wins_count = sum(1 for tr in trades if tr.get('result') == 'WIN')
        losses_count = sum(1 for tr in trades if tr.get('result') == 'LOSS')
        be_count = sum(1 for tr in trades if tr.get('result') == 'BREAKEVEN')

        return {
            'combo_label': self.combo_label,
            'mode': self.combo.get('mode', 'adaptive'),
            'be': self.combo.get('be', 'off'),
            'trail': self.combo.get('trail', 'off'),
            'rr_override': self.rr_override,

            'starting_balance_usd': round(self.balance_usd, 2),
            'final_equity': round(final_equity, 2),
            'net_pnl': round(net_pnl, 2),
            'net_pnl_pct': round(net_pct, 2),
            'peak_drawdown': round(max_dd, 2),
            'max_consecutive_losses': max_loss_streak,

            'total_trades': len(trades),
            'wins': wins_count,
            'losses': losses_count,
            'breakeven': be_count,
            'win_rate': kpis.get('win_rate', 0.0),
            'profit_factor': kpis.get('profit_factor', 0.0),
            'expectancy_r': kpis.get('expectancy', 0.0),
            'max_dd_money': kpis.get('max_dd_money', 0.0),

            'per_pair': self._build_per_pair(),
            'equity_curve': self._build_equity_curve(),
            'daily_equity': self._build_daily_equity(),
            'all_trades': trades,
            'skip_summary': self._build_skip_summary(),
        }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

async def run_live_portfolio_simulation(
    symbols_list: List[str],
    days_count: int,
    starting_balance_input: float,
    currency: str,
    zar_rate: float,
    profile_name: str,
) -> bool:
    """
    Run the Live Bot Portfolio Replay across the given symbols and every
    combination. Writes live_sim_report.json into OUTPUT_DIR.

    Returns True on success, False on any fatal error.
    """
    currency = (currency or 'USD').upper()
    if currency == 'ZAR' and zar_rate and zar_rate > 0:
        usd_balance = max(1.0, float(starting_balance_input) / float(zar_rate))
    else:
        usd_balance = max(1.0, float(starting_balance_input))

    print(
        f"[live-sim] Starting balance: {starting_balance_input} {currency} "
        f"-> ${usd_balance:.2f} USD",
        flush=True,
    )

    # Pair settings are needed up front because they are part of the live
    # signal cache key. Loaded once, reused for the whole run.
    pair_settings = load_pair_settings()

    pair_data: Dict[str, Dict[str, Any]] = {}
    for sym in symbols_list:
        loaded = _load_pair_for_live_sim(sym, days_count, pair_settings)
        if loaded is not None:
            pair_data[sym] = loaded

    if not pair_data:
        print(
            "[live-sim] No pairs available. Check that M5/H1/H4/D1 CSVs exist "
            "for the requested symbols.",
            flush=True,
        )
        return False

    combo_reports: List[Dict[str, Any]] = []
    run_started = time.perf_counter()

    for combo in LIVE_SIM_COMBINATIONS:
        print(f"[live-sim] Running {combo['label']} ...", flush=True)
        combo_t0 = time.perf_counter()
        try:
            sim = LivePortfolioSimulator(
                combo=combo,
                balance_usd=usd_balance,
                profile_name=profile_name,
                pair_data=pair_data,
                zar_per_usd=zar_rate,
                pair_settings=pair_settings,
            )
            report = sim.run()
            report['run_seconds'] = round(time.perf_counter() - combo_t0, 2)
            combo_reports.append(report)
            print(
                f"[live-sim] {combo['label']}: "
                f"{report['total_trades']} trades, "
                f"net ${report['net_pnl']}, "
                f"final ${report['final_equity']}, "
                f"{report['run_seconds']}s",
                flush=True,
            )
        except Exception as e:
            import traceback
            print(f"[live-sim] Combo {combo['label']} failed: {e}", flush=True)
            traceback.print_exc()
            combo_reports.append({
                'combo_label': combo.get('label', 'Unknown'),
                'error': str(e),
                'run_seconds': round(time.perf_counter() - combo_t0, 2),
            })

    total_seconds = round(time.perf_counter() - run_started, 2)

    output = {
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC'),
        'days': int(days_count),
        'symbols': list(pair_data.keys()),
        'starting_balance_input': float(starting_balance_input),
        'currency': currency,
        'zar_per_usd': float(zar_rate),
        'profile_name': profile_name,
        'starting_balance_usd': round(usd_balance, 2),
        'total_seconds': total_seconds,
        'combos': combo_reports,
    }

    out_file = os.path.join(OUTPUT_DIR, 'live_sim_report.json')
    try:
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        safe = sanitize_for_json(output)
        tmp = out_file + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(safe, f, separators=(',', ':'), allow_nan=False)
        os.replace(tmp, out_file)
        print(f"[live-sim] Wrote {out_file} ({total_seconds}s total).", flush=True)
        return True
    except Exception as e:
        print(f"[live-sim] Failed to write report: {e}", flush=True)
        return False