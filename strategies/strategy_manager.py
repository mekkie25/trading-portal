"""
trading-portal/strategies/strategy_manager.py
Orchestrates strategies across the 7 whitelisted assets.

CHANGES 2026-10-13 (round 2)
----------------------------
- _apply_always_on_filters now also applies the global SAST entry session
  window (GLOBAL_PARAMS.trading_hours_sast_start / _end). New signals are
  dropped outside that window with reason BLOCKED_OUTSIDE_SESSION_HH_SAST.
  Existing positions are untouched; this only gates entries.

STEP 1: diagnostics on SPREAD_IN_R skips.
STEP 2: spreads loaded from config/spread_config.json.
STEP 3: per-pair and per-strategy overrides via core.pair_settings.
"""

import os
import json
import logging
import inspect
from typing import List, Optional, Dict, Any
import pandas as pd

from strategies.base import StrategySignal
from strategies.grubber_kick import GrubberKick
from strategies.strategy_513_cross import Strategy513
from strategies.orb_liquidity_sweep_reversal import ORBLiquiditySweep
from strategies.avwap_200ema_trend_continuation import AVWAPTrendContinuation
from strategies.pdh_pdl_failed_breakout import LiquidityTrap
from strategies.ema_9_25_cross_trail import EMACrossTrail
from strategies.orb_cracker_counter_sweep import ORBCracker
from strategies.oes_4h_order_block_retest import OrderBlockRetest

try:
    from config.strategy_params import GLOBAL_PARAMS, TZ_SAST
except ImportError:
    from core.session_config import GLOBAL_PARAMS, TZ_SAST

from core.session_config import MarketSessionManager
from core.pip_sizes import PIP_SIZES
from core.spread_config import load_spreads as _load_spreads

from core.pair_settings import (
    load_pair_settings as _load_pair_settings,
    resolve_max_spread_in_r as _resolve_max_spread_in_r,
    resolve_always_htf_enabled as _resolve_always_htf_enabled,
    resolve_blocked_hours as _resolve_blocked_hours,
)

log = logging.getLogger("StrategyManager")
CONFIG_FILE = "bot_config.json"

_SPREADS: Dict[str, float] = _load_spreads()


class StrategyManager:
    ALLOWED_ASSETS = {
        "GOLD": "frxXAUUSD",
        "US30": "OTC_DJI",
        "NAS100": "OTC_NDX",
        "GERMAN30": "OTC_GDAXI",
        "EURUSD": "frxEURUSD",
        "USDJPY": "frxUSDJPY",
        "GBPUSD": "frxGBPUSD"
    }

    STRATEGY_PERMITTED_ASSETS = {
        "GRUBBER_KICK": {"US30"},
        "STRATEGY_513": {"GOLD", "US30", "NAS100", "GERMAN30", "EURUSD", "USDJPY", "GBPUSD"},
        "ORB_LIQUIDITY_SWEEP": {"GOLD", "US30", "NAS100", "GERMAN30", "EURUSD", "GBPUSD"},
        "AVWAP_200EMA_CONTINUATION": {"GOLD", "US30", "NAS100", "GERMAN30"},
        "PDH_PDL_FAILED_BREAKOUT": {"GOLD", "US30", "NAS100", "GERMAN30", "EURUSD", "GBPUSD"},
        "EMA_9_25_CROSS": {"GOLD", "EURUSD", "USDJPY", "GBPUSD"},
        "ORB_CRACKER": {"NAS100", "US30", "GOLD"},
        "OES_4H_ORDER_BLOCK": {"GOLD", "US30", "NAS100", "GERMAN30", "EURUSD", "USDJPY", "GBPUSD"}
    }

    def __init__(self):
        self.error_count = 0
        self.filter_skips: List[Dict[str, Any]] = []
        try:
            self._pair_settings_cache: Dict[str, Any] = _load_pair_settings()
        except Exception:
            self._pair_settings_cache = {"pairs": {}}
        self.strategies = [
            GrubberKick(),
            Strategy513(),
            ORBLiquiditySweep(),
            AVWAPTrendContinuation(),
            LiquidityTrap(),
            EMACrossTrail(),
            ORBCracker(),
            OrderBlockRetest()
        ]

    def _get_strategy_modes(self) -> dict:
        if not os.path.exists(CONFIG_FILE):
            return {}
        try:
            with open(CONFIG_FILE, "r") as f:
                cfg = json.load(f)
            return cfg.get("strategyModes", {})
        except Exception:
            return {}

    def _apply_always_on_filters(
        self,
        signal: StrategySignal,
        data_5m: pd.DataFrame,
        data_d1: pd.DataFrame,
        current_time: Any = None,
    ) -> Optional[str]:
        # 0. Global SAST entry window. Must run first so that every strategy
        #    is gated identically and the reason is unambiguous.
        try:
            if current_time is not None:
                ts_window = pd.Timestamp(current_time)
                if ts_window.tzinfo is None:
                    ts_window = ts_window.tz_localize("UTC")
                in_window, window_reason = MarketSessionManager.is_in_trading_window(
                    ts_window.to_pydatetime()
                )
                if not in_window:
                    return window_reason
        except Exception:
            pass

        # 1. Blocked hours, per pair.
        try:
            blocked_hours = _resolve_blocked_hours(
                self._pair_settings_cache,
                signal.symbol,
                getattr(GLOBAL_PARAMS, "blocked_hours_sast", None),
            )
            if current_time is not None:
                ts = pd.Timestamp(current_time)
                if ts.tzinfo is None:
                    ts = ts.tz_localize("UTC")
                sast_hour = ts.tz_convert(TZ_SAST).hour
                if sast_hour in blocked_hours:
                    return f"BLOCKED_HOUR_{sast_hour:02d}_SAST"
        except Exception:
            pass

        # 2. HTF alignment.
        try:
            global_targets = getattr(GLOBAL_PARAMS, "strat_always_htf_targets", None)
            htf_on = _resolve_always_htf_enabled(
                self._pair_settings_cache,
                signal.symbol,
                signal.strategy,
                global_targets,
            )
        except Exception:
            htf_on = signal.strategy in set(
                getattr(GLOBAL_PARAMS, "strat_always_htf_targets", []) or []
            )
        if htf_on:
            try:
                if data_d1 is not None and len(data_d1) >= 21:
                    closes = data_d1["close"].astype(float)
                    closed = closes.iloc[:-1] if len(closes) > 20 else closes
                    if len(closed) >= 20:
                        ema20 = float(closed.ewm(span=20, adjust=False).mean().iloc[-1])
                        last_close = float(closed.iloc[-1])
                        d = signal.direction.upper()
                        if d == "BUY" and last_close <= ema20:
                            return "ALWAYS_HTF"
                        if d == "SELL" and last_close >= ema20:
                            return "ALWAYS_HTF"
            except Exception:
                pass

        # 3. Spread-in-R ceiling.
        try:
            max_spr = _resolve_max_spread_in_r(
                self._pair_settings_cache,
                signal.symbol,
                signal.strategy,
                getattr(GLOBAL_PARAMS, "max_spread_in_r", None),
            )
        except Exception:
            max_spr = getattr(GLOBAL_PARAMS, "max_spread_in_r", None)
        if max_spr is not None and max_spr > 0.0:
            try:
                spread = _SPREADS.get(signal.symbol, 0.0)
                sl_dist = abs(float(signal.entry_price) - float(signal.stop_loss))
                if sl_dist > 0.0 and (spread / sl_dist) > max_spr:
                    return "SPREAD_IN_R"
            except Exception:
                pass

        return None

    def _apply_post_filters(
        self,
        signal: StrategySignal,
        data_5m: pd.DataFrame,
        data_d1: pd.DataFrame,
        current_time: Any = None,
    ) -> Optional[str]:
        targets = set(getattr(GLOBAL_PARAMS, "strat_filter_targets", []) or [])
        if signal.strategy not in targets:
            return None

        if signal.strategy in set(getattr(GLOBAL_PARAMS, "strat_disabled", []) or []):
            return "FILTER_DISABLED"

        window = getattr(GLOBAL_PARAMS, "strat_session_window_sast", None)
        if window:
            try:
                start_h, end_h = int(window[0]), int(window[1])
                ts = pd.Timestamp(current_time if current_time is not None else pd.Timestamp.utcnow())
                if ts.tzinfo is None:
                    ts = ts.tz_localize("UTC")
                sast_h = ts.tz_convert(TZ_SAST).hour
                if start_h <= end_h:
                    ok = start_h <= sast_h < end_h
                else:
                    ok = sast_h >= start_h or sast_h < end_h
                if not ok:
                    return "FILTER_SESSION"
            except Exception:
                pass

        if bool(getattr(GLOBAL_PARAMS, "strat_htf_trend_filter", False)):
            try:
                if data_d1 is not None and len(data_d1) >= 21:
                    closes = data_d1["close"].astype(float)
                    closed = closes.iloc[:-1] if len(closes) > 20 else closes
                    if len(closed) >= 20:
                        ema20 = float(closed.ewm(span=20, adjust=False).mean().iloc[-1])
                        last_close = float(closed.iloc[-1])
                        d = signal.direction.upper()
                        if d == "BUY" and last_close <= ema20:
                            return "FILTER_HTF"
                        if d == "SELL" and last_close >= ema20:
                            return "FILTER_HTF"
            except Exception:
                pass

        min_stop_atr = float(getattr(GLOBAL_PARAMS, "strat_min_stop_atr", 0.0) or 0.0)
        if min_stop_atr > 0.0 and data_5m is not None and len(data_5m) >= 15:
            try:
                highs = data_5m["high"].astype(float)
                lows = data_5m["low"].astype(float)
                closes = data_5m["close"].astype(float)
                prev_closes = closes.shift(1)
                tr = pd.concat([
                    (highs - lows).abs(),
                    (highs - prev_closes).abs(),
                    (lows - prev_closes).abs(),
                ], axis=1).max(axis=1)
                atr14 = float(tr.tail(14).mean())
                sl_dist = abs(float(signal.entry_price) - float(signal.stop_loss))
                if atr14 > 0.0 and sl_dist < (min_stop_atr * atr14):
                    return "FILTER_MIN_STOP"
            except Exception:
                pass

        max_spread_r = float(getattr(GLOBAL_PARAMS, "strat_max_spread_in_r", 0.0) or 0.0)
        if max_spread_r > 0.0:
            try:
                spread = _SPREADS.get(signal.symbol, 0.0)
                sl_dist = abs(float(signal.entry_price) - float(signal.stop_loss))
                if sl_dist > 0.0 and (spread / sl_dist) > max_spread_r:
                    return "FILTER_COST"
            except Exception:
                pass

        return None

    def _record_filter_skip(self, reason: str, signal: StrategySignal, current_time: Any) -> None:
        spread_in_r_value: Optional[float] = None
        sl_dist_at_reject: Optional[float] = None
        structural_sl_pips: Optional[float] = None

        if reason == "SPREAD_IN_R":
            try:
                spread = float(_SPREADS.get(signal.symbol, 0.0))
                sl_dist = abs(float(signal.entry_price) - float(signal.stop_loss))
                if sl_dist > 0.0:
                    spread_in_r_value = round(spread / sl_dist, 6)
                    sl_dist_at_reject = round(sl_dist, 6)
                    pip = float(PIP_SIZES.get(signal.symbol, 0.0))
                    if pip > 0.0:
                        structural_sl_pips = round(sl_dist / pip, 2)
            except Exception:
                pass

        try:
            ts = pd.Timestamp(current_time if current_time is not None else pd.Timestamp.utcnow())
            if ts.tzinfo is None:
                ts = ts.tz_localize("UTC")
            sast = ts.tz_convert(TZ_SAST)
            self.filter_skips.append({
                "time": ts.strftime("%Y-%m-%d %H:%M:%S"),
                "date_sast": sast.strftime("%Y-%m-%d"),
                "symbol": signal.symbol,
                "strategy": signal.strategy,
                "direction": signal.direction.upper(),
                "reason": reason,
                "hour_sast": int(sast.hour),
                "spread_in_r_value": spread_in_r_value,
                "sl_dist_at_reject": sl_dist_at_reject,
                "structural_sl_pips": structural_sl_pips,
            })
        except Exception:
            pass

    def drain_filter_skips(self) -> List[Dict[str, Any]]:
        out = self.filter_skips
        self.filter_skips = []
        return out

    def evaluate_all(
        self,
        symbol: str,
        data_5m: pd.DataFrame,
        data_h4: pd.DataFrame,
        data_d1: pd.DataFrame,
        session_levels: dict,
        data_h1: pd.DataFrame = None,
        apply_strat_filters: bool = False,
    ) -> Optional[StrategySignal]:
        if symbol not in self.ALLOWED_ASSETS:
            return None

        strategy_modes = self._get_strategy_modes()
        valid_signals: List[StrategySignal] = []

        try:
            current_time = pd.to_datetime(data_5m["time"].iloc[-1], utc=True) if data_5m is not None and len(data_5m) > 0 else None
        except Exception:
            current_time = None

        for strat in self.strategies:
            strat_name = strat.__class__.__name__
            try:
                sig = inspect.signature(strat.evaluate)
                params = sig.parameters
                kwargs = {}
                if 'data_h4' in params: kwargs['data_h4'] = data_h4
                if 'data_d1' in params: kwargs['data_d1'] = data_d1
                if 'session_levels' in params: kwargs['session_levels'] = session_levels
                if 'data_h1' in params: kwargs['data_h1'] = data_h1

                signal = strat.evaluate(symbol, data_5m, **kwargs)

                if signal:
                    permitted = self.STRATEGY_PERMITTED_ASSETS.get(signal.strategy, set())
                    if signal.symbol not in permitted:
                        continue

                    mode = strategy_modes.get(signal.strategy, "LIVE")
                    if mode == "OFF":
                        continue

                    if mode == "DRY_RUN":
                        setattr(signal, "is_dry_run", True)
                    else:
                        setattr(signal, "is_dry_run", False)

                    always_reason = self._apply_always_on_filters(
                        signal, data_5m, data_d1, current_time
                    )
                    if always_reason is not None:
                        self._record_filter_skip(always_reason, signal, current_time)
                        continue

                    if apply_strat_filters and bool(getattr(GLOBAL_PARAMS, "strat_filters_backtest_only", True)):
                        reason = self._apply_post_filters(signal, data_5m, data_d1, current_time)
                        if reason is not None:
                            self._record_filter_skip(reason, signal, current_time)
                            continue

                    valid_signals.append(signal)

            except Exception as e:
                self.error_count += 1
                log.error(f"Error evaluating {strat_name} on {symbol}: {e}")
                continue

        if not valid_signals:
            return None

        best_signal = max(valid_signals, key=lambda s: getattr(s, 'confidence', 0.80))
        if len(valid_signals) > 1:
            log.info(f"Multiple signals generated for {symbol} ({[s.strategy for s in valid_signals]}). Selected highest confidence: {best_signal.strategy} ({best_signal.confidence})")

        return best_signal