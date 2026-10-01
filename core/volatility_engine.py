"""
core/volatility_engine.py
Adaptive Volatility Engine: Dynamic ADR/AWR/AMR computation, Regime Scaling,
Volatility-Bounded Stops, Structural Target Preservation, and Runner Management.
"""

import logging
import pandas as pd
import numpy as np
from datetime import datetime, timezone, timedelta
from typing import Dict, Tuple, Optional, Any

from strategies.base import StrategySignal
from core.session_config import GLOBAL_PARAMS

log = logging.getLogger("VolatilityEngine")


class VolatilityEngine:
    REVERSAL_STRATEGIES = {
        "ORB_LIQUIDITY_SWEEP",
        "PDH_PDL_FAILED_BREAKOUT",
        "GRUBBER_KICK",
        "ORB_CRACKER"
    }

    def __init__(self):
        # Per-symbol cache: symbol -> (timestamp_epoch, metrics_dict)
        self._vol_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
        # Rejection tracking telemetry
        self.rejection_stats: Dict[str, int] = {
            "spread": 0,
            "room": 0,
            "sl_too_wide": 0,
            "min_rr": 0,
            "monotonicity": 0
        }

    def get_rejection_stats(self) -> Dict[str, int]:
        """Exposes dynamic rejection telemetry for logging and UI telemetry."""
        return dict(self.rejection_stats)

    def compute_symbol_volatility(
        self,
        d1_df: pd.DataFrame,
        m5_df: pd.DataFrame,
        current_quote: float,
        symbol: str,
        as_of: Optional[datetime] = None
    ) -> Dict[str, Any]:
        """
        Computes rolling smoothed ADR, true W1/MN1 resampled ranges, and 90-day ADR percentile.
        Requires >= 120 completed D1 bars.
        """
        now_utc = as_of if as_of is not None else datetime.now(timezone.utc)
        now_epoch = now_utc.timestamp()

        # 1. 60-second TTL Per-Symbol Cache Guard (only active in live mode)
        if as_of is None and symbol in self._vol_cache:
            cached_ts, cached_data = self._vol_cache[symbol]
            if (now_epoch - cached_ts) < 60.0:
                return dict(cached_data)

        if d1_df.empty or len(d1_df) < 120:
            return {
                "valid": False,
                "reason": f"Insufficient D1 history: {len(d1_df)} bars provided, >= 120 required."
            }

        df_d1 = d1_df.copy()
        if not isinstance(df_d1.index, pd.DatetimeIndex):
            df_d1['parsed_time'] = pd.to_datetime(df_d1['time'], utc=True)
            df_d1 = df_d1.set_index('parsed_time').sort_index()

        # 2. Exclude D1 bars where bar_open + 24h > now_utc (cTrader D1 opens 21:00/22:00 UTC)
        d1_hist = df_d1[df_d1.index + pd.Timedelta(hours=24) <= now_utc].copy()
        if len(d1_hist) < 100:
            return {
                "valid": False,
                "reason": f"Insufficient closed D1 bars after excluding active bar: {len(d1_hist)} < 100."
            }

        daily_ranges = (d1_hist['high'] - d1_hist['low']).dropna()

        # 3. Rolling smoothed ADR across a 90-day window (0.5*5d + 0.3*10d + 0.2*20d)
        r_5 = daily_ranges.rolling(5).mean()
        r_10 = daily_ranges.rolling(10).mean()
        r_20 = daily_ranges.rolling(20).mean()
        smoothed_series = ((0.50 * r_5) + (0.30 * r_10) + (0.20 * r_20)).dropna()

        current_adr = float(smoothed_series.iloc[-1])
        lookback_90 = smoothed_series.tail(90)
        percentile = float((lookback_90 < current_adr).mean() * 100.0)

        if percentile < 20.0:
            regime = "LOW"
            k_scale = 0.85
        elif percentile > 80.0:
            regime = "HIGH"
            k_scale = 1.20
        else:
            regime = "NORMAL"
            k_scale = 1.00

        # 4. AWR: Resample to W1; drop bin if right-edge timestamp + 23h > now_utc
        w1_bars = d1_hist.resample('W-FRI').agg({'high': 'max', 'low': 'min'}).dropna()
        if not w1_bars.empty and (w1_bars.index[-1] + pd.Timedelta(hours=23)) > now_utc:
            w1_bars = w1_bars.iloc[:-1]
        weekly_ranges = (w1_bars['high'] - w1_bars['low']).dropna()
        awr_4 = float(weekly_ranges.tail(4).mean()) if len(weekly_ranges) >= 4 else current_adr * 3.5

        # 5. AMR: Resample to MN (pandas < 2.2 'M' fallback); drop bin if right edge + 23h > now_utc
        try:
            mn_bars = d1_hist.resample('ME').agg({'high': 'max', 'low': 'min'}).dropna()
        except ValueError:
            mn_bars = d1_hist.resample('M').agg({'high': 'max', 'low': 'min'}).dropna()

        if not mn_bars.empty and (mn_bars.index[-1] + pd.Timedelta(hours=23)) > now_utc:
            mn_bars = mn_bars.iloc[:-1]
        monthly_ranges = (mn_bars['high'] - mn_bars['low']).dropna()
        amr_3 = float(monthly_ranges.tail(3).mean()) if len(monthly_ranges) >= 3 else current_adr * 12.0

        # 6. Today's Range Slice with Fallback Warning
        active_day_candles = df_d1[df_d1.index + pd.Timedelta(hours=24) > now_utc]
        if not active_day_candles.empty:
            current_d1_open_time = active_day_candles.index[-1]
            active_d1_open = float(active_day_candles['open'].iloc[-1])
        else:
            current_d1_open_time = now_utc - timedelta(hours=24)
            active_d1_open = current_quote
            log.warning(f"No active D1 bar found for {symbol}; falling back to last 24h window for M5 range.")

        if not m5_df.empty:
            m5_times = pd.to_datetime(m5_df['time'], utc=True)
            today_m5 = m5_df[m5_times >= current_d1_open_time]
        else:
            today_m5 = pd.DataFrame()

        if not today_m5.empty:
            today_high = float(today_m5['high'].max())
            today_low = float(today_m5['low'].min())
        else:
            today_high = current_quote
            today_low = current_quote

        today_high = max(today_high, current_quote)
        today_low = min(today_low, current_quote)
        range_consumed = max(0.0, today_high - today_low)
        drc_pct = (range_consumed / (current_adr + 1e-9)) * 100.0

        metrics_result = {
            "valid": True,
            "symbol": symbol,
            "adr": current_adr,
            "awr": awr_4,
            "amr": amr_3,
            "regime": regime,
            "k_scale": k_scale,
            "today_high": today_high,
            "today_low": today_low,
            "d1_open": active_d1_open,
            "range_consumed": range_consumed,
            "drc_pct": drc_pct
        }

        # Cache metrics copy for 60 seconds
        self._vol_cache[symbol] = (now_epoch, dict(metrics_result))
        return dict(metrics_result)

    def evaluate_volatility_filters(
        self,
        vol_metrics: Dict[str, Any],
        spread: float,
        sl_distance: float,
        target_distance: float,
        direction: str,
        current_price: float,
        strategy_name: str,
        max_spread_to_sl_ratio: Optional[float] = None
    ) -> Tuple[bool, str]:
        if not vol_metrics.get("valid", False):
            return False, f"Volatility filter blocked: {vol_metrics.get('reason', 'Invalid metrics')}"

        ratio_limit = max_spread_to_sl_ratio if max_spread_to_sl_ratio is not None else GLOBAL_PARAMS.max_spread_to_sl_ratio

        # 1. Spread-to-SL Check
        if sl_distance > 0 and (spread / sl_distance) > ratio_limit:
            self.rejection_stats["spread"] += 1
            return False, (
                f"Spread ({spread:.5f}) is {(spread / sl_distance) * 100:.1f}% of SL "
                f"(Max allowed: {ratio_limit * 100:.0f}%)"
            )

        adr = vol_metrics["adr"]
        today_high = vol_metrics["today_high"]
        today_low = vol_metrics["today_low"]
        is_reversal = strategy_name in self.REVERSAL_STRATEGIES

        # 2. Trend vs. Reversal Room Gate
        if not is_reversal:
            remaining_adr_room = max(0.0, (today_low + adr) - current_price) if direction.upper() == "BUY" else max(0.0, current_price - (today_high - adr))
            if target_distance > remaining_adr_room:
                self.rejection_stats["room"] += 1
                return False, (
                    f"ADR Room Depleted: Target dist ({target_distance:.2f}) > "
                    f"Remaining room ({remaining_adr_room:.2f}) [{vol_metrics['drc_pct']:.1f}% consumed]"
                )
        else:
            # Reversal branch: Room back inside range
            room_back = (current_price - today_low) if direction.upper() == "SELL" else (today_high - current_price)
            # [PROPOSED]: 0.25 * ADR buffer for sweep-reversal pullback allowance
            if target_distance > (room_back + (0.25 * adr)):
                self.rejection_stats["room"] += 1
                return False, (
                    f"Reversal Target ({target_distance:.2f}) exceeds realistic pullback room "
                    f"({room_back:.2f} + buffer {0.25 * adr:.2f})"
                )

        return True, "Volatility filters cleared"

    def adapt_signal(
        self,
        signal: StrategySignal,
        vol_metrics: Dict[str, Any],
        ui_rr: float,
        session_levels: Dict[str, Any],
        min_rr: Optional[float] = None
    ) -> Optional[StrategySignal]:
        if not vol_metrics.get("valid", False):
            return None

        # 1. Weekly Open derivation with logged fallback
        weekly_open = session_levels.get("weekly_open")
        if weekly_open is None or weekly_open == 0.0:
            fallback_open = vol_metrics.get("d1_open", signal.entry_price)
            log.warning(f"Missing weekly_open in session_levels for {signal.symbol}; falling back to D1 open ({fallback_open}).")
            weekly_open = fallback_open

        effective_min_rr = min_rr if min_rr is not None else GLOBAL_PARAMS.min_rr
        adr = vol_metrics["adr"]
        k_scale = vol_metrics["k_scale"]
        entry = signal.entry_price
        direction = signal.direction.upper()

        # Read directly from GLOBAL_PARAMS
        raw_k_min, _, raw_k_max = GLOBAL_PARAMS.adr_sl_ratios.get(signal.symbol, (0.10, 0.20, 0.25))
        k_min = raw_k_min * k_scale
        k_max = raw_k_max * k_scale
        structural_sl_dist = abs(entry - signal.stop_loss)

        # 2. Reject if structural SL > k_max * ADR; widen if < k_min * ADR
        if structural_sl_dist > (k_max * adr):
            self.rejection_stats["sl_too_wide"] += 1
            return None

        effective_sl_dist = max(structural_sl_dist, k_min * adr)
        adapted_sl = (entry - effective_sl_dist) if direction == "BUY" else (entry + effective_sl_dist)

        # 3. Target Sizing & Structural Capping
        ideal_rr_dist = effective_sl_dist * ui_rr
        ideal_rr_target = (entry + ideal_rr_dist) if direction == "BUY" else (entry - ideal_rr_dist)
        strat_tp1 = signal.take_profit_1
        strat_tp2 = signal.take_profit_2 or signal.take_profit

        if strat_tp2 and strat_tp2 != 0:
            if direction == "BUY":
                tp2 = min(strat_tp2, ideal_rr_target) if strat_tp2 > entry else ideal_rr_target
            else:
                tp2 = max(strat_tp2, ideal_rr_target) if strat_tp2 < entry else ideal_rr_target
        else:
            tp2 = ideal_rr_target

        final_tp_dist = abs(tp2 - entry)
        if (final_tp_dist / effective_sl_dist) < effective_min_rr:
            self.rejection_stats["min_rr"] += 1
            return None

        tp1 = strat_tp1 if (strat_tp1 and strat_tp1 != 0) else entry + (0.50 * (tp2 - entry))

        # 4. Strict Monotonicity Check
        if direction == "BUY":
            if not (entry < tp1 < tp2):
                tp1 = entry + (0.50 * (tp2 - entry))
                if not (entry < tp1 < tp2):
                    self.rejection_stats["monotonicity"] += 1
                    return None
        else:
            if not (entry > tp1 > tp2):
                tp1 = entry + (0.50 * (tp2 - entry))
                if not (entry > tp1 > tp2):
                    self.rejection_stats["monotonicity"] += 1
                    return None

        # 5. TP3 Runner (R2/S2 capped by 85% AWR)
        pivot_r2_s2 = session_levels.get("pivot_r2" if direction == "BUY" else "pivot_s2")
        awr = vol_metrics["awr"]
        weekly_cap = (weekly_open + (0.85 * awr)) if direction == "BUY" else (weekly_open - (0.85 * awr))

        if pivot_r2_s2 and pivot_r2_s2 != 0:
            candidate_tp3 = min(pivot_r2_s2, weekly_cap) if direction == "BUY" else max(pivot_r2_s2, weekly_cap)
        else:
            # [PROPOSED]: Extended R:R fallback when Pivot R2/S2 is missing
            candidate_tp3 = (entry + (effective_sl_dist * (ui_rr + 1.0))) if direction == "BUY" else (entry - (effective_sl_dist * (ui_rr + 1.0)))

        if (direction == "BUY" and candidate_tp3 <= tp2) or (direction == "SELL" and candidate_tp3 >= tp2):
            final_tp3 = None
        else:
            final_tp3 = round(candidate_tp3, 5)

        # 6. Apply updates without altering original strategy trail_mode
        signal.stop_loss = round(adapted_sl, 5)
        signal.take_profit = round(tp2, 5)
        signal.take_profit_1 = round(tp1, 5)
        signal.take_profit_2 = round(tp2, 5)
        signal.take_profit_3 = final_tp3
        signal.scale_out_fraction = 0.50
        return signal


# Module-level singleton instance for engine import
volatility_engine = VolatilityEngine()