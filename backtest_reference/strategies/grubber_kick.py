"""
trading-portal/strategies/grubber_kick.py
The 'Grubber Kick' 3-Rule Box Strategy (US30 Only).
Authoritative Spec:
- Primary Asset: US30 only
- Market Cycle: AMD (Accumulation Asia, Manipulation Sweep, Distribution Expansion)
- Rule 1: Asia Range Test (After 06:00 SAST)
- Rule 2: Liquidity Sweep beyond AH/AL + sharp rejection closing back inside range
- Rule 3: EQ Level Test with TWO consecutive 5M closes holding across Daily EQ
- Adaptive Buffers: Scales EQ tolerance (5% ADR) and target fallback (25% ADR) under adaptive mode
- Target Progression: TP1 = Asia High/Low, TP2 = Pivot R1/S1, TP3 = Pivot R2/S2
"""

import pandas as pd
from strategies.base import StrategySignal
from core.session_config import MarketSessionManager

try:
    from config.strategy_params import GLOBAL_PARAMS
except ImportError:
    from core.session_config import GLOBAL_PARAMS


class GrubberKick:
    def __init__(self, stop_loss_points: float = None):
        self.stop_loss_points = stop_loss_points or GLOBAL_PARAMS.grubber_kick_fixed_sl

    def evaluate(self, symbol: str, data_5m: pd.DataFrame, data_h4: pd.DataFrame = None, data_d1: pd.DataFrame = None, session_levels: dict = None) -> StrategySignal | None:
        diagnostics = {"strategy": "GRUBBER_KICK", "passed": False, "reason": ""}

        if symbol != "US30":
            diagnostics["reason"] = "Restricted strictly to US30"
            return None

        if data_5m is None or len(data_5m) < 20 or not session_levels:
            diagnostics["reason"] = "Insufficient 5M candle history"
            return None

        curr_bar_time = data_5m.iloc[-1]['time']
        if not MarketSessionManager.is_post_asia_grubber_window(curr_bar_time):
            diagnostics["reason"] = "Must be executed after 06:00 SAST"
            return None

        ah = session_levels.get('asia_high')
        al = session_levels.get('asia_low')
        eq = session_levels.get('daily_eq')
        r1 = session_levels.get('pivot_r1')
        s1 = session_levels.get('pivot_s1')
        r2 = session_levels.get('pivot_r2')
        s2 = session_levels.get('pivot_s2')

        if not all([ah, al, eq]):
            diagnostics["reason"] = "Missing Asia Levels or Daily Equilibrium"
            return None

        recent_bars = data_5m.tail(24)
        c_curr = data_5m.iloc[-1]
        c_prev = data_5m.iloc[-2]

        # Dynamic EQ tolerance and fallback target scaling
        adr = session_levels.get("adr")
        if GLOBAL_PARAMS.adaptive_mode and adr is not None and adr > 0:
            eq_tolerance = 0.05 * adr      # [PROPOSED]: 5% of daily range tolerance around EQ
            fallback_dist = 0.25 * adr     # [PROPOSED]: 25% of daily range target expansion
        else:
            eq_tolerance = 15.0            # Legacy fixed point tolerance
            fallback_dist = 80.0           # Legacy fixed point fallback target

        asia_range_height = abs(ah - al)

        # LONG CRITERIA: Sweep of Asia Low -> EQ Retest -> 2 Closes above EQ
        swept_al = False
        for i in range(len(recent_bars) - 2):
            b = recent_bars.iloc[i]
            if b['low'] < al and b['close'] > al:
                swept_al = True
                break

        if swept_al:
            two_closes_above_eq = (c_prev['close'] > eq) and (c_curr['close'] > eq)
            held_support_on_eq = (c_prev['low'] >= (eq - eq_tolerance)) and (c_curr['low'] >= (eq - eq_tolerance))
            trigger_candle_bullish = c_curr['close'] > c_curr['open']

            if two_closes_above_eq and held_support_on_eq and trigger_candle_bullish:
                sl_price = float(eq - self.stop_loss_points)
                tp1 = float(ah)
                tp2 = float(r1) if r1 and r1 > c_curr['close'] else float(c_curr['close'] + fallback_dist)
                tp3 = float(r2) if r2 and r2 > tp2 else float(tp2 + fallback_dist)

                diagnostics.update({"passed": True, "setup": "GRUBBER_LONG", "sweep_level": al, "eq": eq})
                return StrategySignal(
                    strategy="GRUBBER_KICK",
                    symbol="US30",
                    direction="BUY",
                    entry_price=float(c_curr['close']),
                    stop_loss=sl_price,
                    take_profit=tp2,
                    take_profit_1=tp1,
                    take_profit_2=tp2,
                    take_profit_3=tp3,
                    reference_range_height=asia_range_height,
                    scale_out_fraction=0.50,
                    trail_mode="MOVE_TO_BE_80",
                    session="POST_ASIA",
                    confidence=0.92,
                    reason="US30 Asia Low swept + 2 consecutive 5M closes holding above EQ",
                    diagnostics=diagnostics
                )

        # SHORT CRITERIA: Sweep of Asia High -> EQ Retest -> 2 Closes below EQ
        swept_ah = False
        for i in range(len(recent_bars) - 2):
            b = recent_bars.iloc[i]
            if b['high'] > ah and b['close'] < ah:
                swept_ah = True
                break

        if swept_ah:
            two_closes_below_eq = (c_prev['close'] < eq) and (c_curr['close'] < eq)
            held_resistance_on_eq = (c_prev['high'] <= (eq + eq_tolerance)) and (c_curr['high'] <= (eq + eq_tolerance))
            trigger_candle_bearish = c_curr['close'] < c_curr['open']

            if two_closes_below_eq and held_resistance_on_eq and trigger_candle_bearish:
                sl_price = float(eq + self.stop_loss_points)
                tp1 = float(al)
                tp2 = float(s1) if s1 and s1 < c_curr['close'] else float(c_curr['close'] - fallback_dist)
                tp3 = float(s2) if s2 and s2 < tp2 else float(tp2 - fallback_dist)

                diagnostics.update({"passed": True, "setup": "GRUBBER_SHORT", "sweep_level": ah, "eq": eq})
                return StrategySignal(
                    strategy="GRUBBER_KICK",
                    symbol="US30",
                    direction="SELL",
                    entry_price=float(c_curr['close']),
                    stop_loss=sl_price,
                    take_profit=tp2,
                    take_profit_1=tp1,
                    take_profit_2=tp2,
                    take_profit_3=tp3,
                    reference_range_height=asia_range_height,
                    scale_out_fraction=0.50,
                    trail_mode="MOVE_TO_BE_80",
                    session="POST_ASIA",
                    confidence=0.92,
                    reason="US30 Asia High swept + 2 consecutive 5M closes holding below EQ",
                    diagnostics=diagnostics
                )

        diagnostics["reason"] = "AMD sequence conditions not completed"
        return None