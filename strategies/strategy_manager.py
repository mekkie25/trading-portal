"""
trading-portal/strategies/strategy_manager.py
Orchestrates institutional quantitative strategies across the 7 whitelisted assets,
passing multi-timeframe market feeds (M5, H1, H4, D1) and selecting the highest-confidence
setup among all permitted strategies (eliminating first-match short-circuiting).

BRIEF CHANGES (2026-10-12):
- Added _apply_always_on_filters. Runs on every signal, live or backtest.
  It enforces:
    (a) SAST rollover/hour blackout per pair (blocked_hours_sast)
    (b) HTF daily alignment for strat_always_htf_targets
        (STRATEGY_513 and EMA_9_25_CROSS)
    (c) A spread-in-R ceiling of max_spread_in_r for every strategy
- The existing backtest-only post-filters (session window, min stop ATR,
  disabled list, forced HTF, spread cap) are unchanged.
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

# MarketSessionManager is not exported by the virtual 'config.strategy_params'
# alias, so it must come from core.session_config directly.
from core.session_config import MarketSessionManager

log = logging.getLogger("StrategyManager")
CONFIG_FILE = "bot_config.json"

# Mirror of the spread table used by the simulator, so this module never has to
# import from backtest.simulator (which would create a circular dependency).
_SPREADS: Dict[str, float] = {
    "GOLD": 0.30,
    "US30": 2.50,
    "NAS100": 1.50,
    "GERMAN30": 1.80,
    "EURUSD": 0.00010,
    "USDJPY": 0.012,
    "GBPUSD": 0.00014,
}


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
        # One-row-per-candle list of signals blocked by filters. The runner
        # drains this into the simulator's skipped list after every call.
        self.filter_skips: List[Dict[str, Any]] = []
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

    # ------------------------------------------------------------------
    # BRIEF item 6 + rollover blackout + spread ceiling.
    # Runs on every signal, live AND backtest. Never skipped.
    # ------------------------------------------------------------------

    def _apply_always_on_filters(
        self,
        signal: StrategySignal,
        data_5m: pd.DataFrame,
        data_d1: pd.DataFrame,
        current_time: Any = None,
    ) -> Optional[str]:
        """
        Returns a skip-reason string when the signal must be dropped, or None
        when it passes. This filter path never gets bypassed.
        """
        # 1. SAST rollover / hour blackout per pair.
        try:
            blocked, reason = MarketSessionManager.is_blocked_hour(
                signal.symbol, current_time
            )
            if blocked:
                return reason
        except Exception:
            pass

        # 2. HTF alignment for the brief's two target strategies.
        htf_targets = set(getattr(GLOBAL_PARAMS, "strat_always_htf_targets", []) or [])
        if signal.strategy in htf_targets:
            try:
                if data_d1 is not None and len(data_d1) >= 21:
                    closes = data_d1["close"].astype(float)
                    # Drop the currently forming bar; use only closed bars.
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

        # 3. Spread-in-R ceiling for every strategy.
        max_spr = float(getattr(GLOBAL_PARAMS, "max_spread_in_r", 0.0) or 0.0)
        if max_spr > 0.0:
            try:
                spread = _SPREADS.get(signal.symbol, 0.0)
                sl_dist = abs(float(signal.entry_price) - float(signal.stop_loss))
                if sl_dist > 0.0 and (spread / sl_dist) > max_spr:
                    return "SPREAD_IN_R"
            except Exception:
                pass

        return None

    # ------------------------------------------------------------------
    # Backtest-only post-filters
    # ------------------------------------------------------------------

    def _apply_post_filters(
        self,
        signal: StrategySignal,
        data_5m: pd.DataFrame,
        data_d1: pd.DataFrame,
        current_time: Any = None,
    ) -> Optional[str]:
        """
        Backtest-only. Only runs for strategies listed in
        GLOBAL_PARAMS.strat_filter_targets. Never runs unless the caller
        explicitly requested filters (apply_strat_filters=True).
        """
        targets = set(getattr(GLOBAL_PARAMS, "strat_filter_targets", []) or [])
        if signal.strategy not in targets:
            return None

        # 1. Disabled list
        if signal.strategy in set(getattr(GLOBAL_PARAMS, "strat_disabled", []) or []):
            return "FILTER_DISABLED"

        # 2. SAST session window
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

        # 3. HTF trend filter (D1 close vs its 20 EMA, closed candles only)
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

        # 4. Minimum stop distance in ATR14(m5) units
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

        # 5. Cost filter: spread / stop distance above threshold
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
            })
        except Exception:
            pass

    def drain_filter_skips(self) -> List[Dict[str, Any]]:
        out = self.filter_skips
        self.filter_skips = []
        return out

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

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
                    # 1. Enforce strict asset boundary
                    permitted = self.STRATEGY_PERMITTED_ASSETS.get(signal.strategy, set())
                    if signal.symbol not in permitted:
                        continue

                    # 2. Enforce 3-Way Mode Switch (LIVE | DRY_RUN | OFF)
                    mode = strategy_modes.get(signal.strategy, "LIVE")
                    if mode == "OFF":
                        continue

                    if mode == "DRY_RUN":
                        setattr(signal, "is_dry_run", True)
                    else:
                        setattr(signal, "is_dry_run", False)

                    # 3. Always-on filters (live + backtest): rollover, HTF,
                    #    spread-in-R ceiling.
                    always_reason = self._apply_always_on_filters(
                        signal, data_5m, data_d1, current_time
                    )
                    if always_reason is not None:
                        self._record_filter_skip(always_reason, signal, current_time)
                        continue

                    # 4. Backtest-only post-filters
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