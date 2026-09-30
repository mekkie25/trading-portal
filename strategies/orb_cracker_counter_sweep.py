"""
trading-portal/strategies/orb_cracker_counter_sweep.py
1M / 5M Opening Range Counter-Sweep ('Cracker' Setup - Spec Setup 5).
- Time: NYSE Session Open strictly (09:30 - 10:30 US/Eastern / 15:30 - 16:30 SAST)
- Trigger: Initial momentum pulse breaks dedicated 5M Cracker ORB High or Low
- Rejection: Counter-pulse rejects at 200 EMA or Session VWAP
- Adaptive Sizing: Adapts stop size (12-20% ADR) under adaptive mode
- TP: Fixed R:R 1:1 to 1:2 (Move SL to BE at 80%)
"""

import pandas as pd
from strategies.base import StrategySignal
from core.session_config import MarketSessionManager
from core.indicators import calculate_session_vwap

try:
    from config.strategy_params import GLOBAL_PARAMS
except ImportError:
    from core.session_config import GLOBAL_PARAMS


class ORBCracker:
    def evaluate(self, symbol: str, data_5m: pd.DataFrame, data_h4: pd.DataFrame = None, data_d1: pd.DataFrame = None, session_levels: dict = None) -> StrategySignal | None:
        diagnostics = {"strategy": "ORB_CRACKER", "passed": False, "reason": ""}

        if data_5m is None or len(data_5m) < 15 or not session_levels:
            diagnostics["reason"] = "Missing data or session levels"
            return None

        # Permitted Assets: NAS100, US30, GOLD
        if symbol not in ("NAS100", "US30", "GOLD"):
            diagnostics["reason"] = "Asset not permitted for Cracker setup"
            return None

        curr_bar_time = data_5m.iloc[-1]['time']
        if not MarketSessionManager.is_in_ny_cracker_window(curr_bar_time):
            diagnostics["reason"] = "Outside NYSE Open Cracker window (15:30 - 16:30 SAST)"
            return None

        # Dedicated 5M Cracker ORB verification
        if not session_levels.get('cracker_orb_established', False):
            diagnostics["reason"] = "Cracker 5M Opening Range not yet established"
            return None

        orb_h = session_levels.get('cracker_orb_high')
        orb_l = session_levels.get('cracker_orb_low')
        if orb_h is None or orb_l is None or orb_h == 0.0 or orb_l == 0.0:
            diagnostics["reason"] = "Cracker 5M Opening Range not yet established"
            return None

        curr_bar = data_5m.iloc[-1]
        prev_bar = data_5m.iloc[-2]

        ema_200 = data_5m['close'].ewm(span=200, adjust=False).mean().iloc[-1]
        vwap = calculate_session_vwap(data_5m).iloc[-1]

        adr = session_levels.get("adr")
        use_adaptive = GLOBAL_PARAMS.adaptive_mode and adr is not None and adr > 0

        # Asset-specific stop enforcement
        if symbol == "NAS100":
            target_sl_pts = (0.20 * adr) if use_adaptive else 45.0  # [PROPOSED]: 20% ADR
        elif symbol == "US30":
            target_sl_pts = (0.15 * adr) if use_adaptive else 45.0  # [PROPOSED]: 15% ADR
        else:  # GOLD
            target_sl_pts = (0.12 * adr) if use_adaptive else 2.50  # [PROPOSED]: 12% ADR

        cracker_range_height = abs(orb_h - orb_l)

        # BEARISH CRACKER: Upward pulse broke ORB High, rejected 200 EMA/VWAP, closed red
        if prev_bar['high'] > orb_h and (prev_bar['high'] >= ema_200 or prev_bar['high'] >= vwap):
            if curr_bar['close'] < curr_bar['open'] and curr_bar['close'] < prev_bar['low']:
                sl = float(curr_bar['close'] + target_sl_pts)
                tp = float(curr_bar['close'] - (1.8 * target_sl_pts))
                tp1 = float(curr_bar['close'] - (1.0 * target_sl_pts))

                diagnostics.update({"passed": True, "action": "SELL", "pulse": "UP_PULSE_REJECTED"})
                return StrategySignal(
                    strategy="ORB_CRACKER",
                    symbol=symbol,
                    direction="SELL",
                    entry_price=float(curr_bar['close']),
                    stop_loss=sl,
                    take_profit=tp,
                    take_profit_1=tp1,
                    take_profit_2=tp,
                    reference_range_height=cracker_range_height,
                    scale_out_fraction=0.50,
                    trail_mode="MOVE_TO_BE_80",
                    session="NY_OPEN",
                    confidence=0.87,
                    reason="NYSE Open ORB Cracker counter-pulse rejection off 200 EMA/VWAP",
                    diagnostics=diagnostics
                )

        # BULLISH CRACKER: Downward pulse broke ORB Low, rejected 200 EMA/VWAP, closed green
        if prev_bar['low'] < orb_l and (prev_bar['low'] <= ema_200 or prev_bar['low'] <= vwap):
            if curr_bar['close'] > curr_bar['open'] and curr_bar['close'] > prev_bar['high']:
                sl = float(curr_bar['close'] - target_sl_pts)
                tp = float(curr_bar['close'] + (1.8 * target_sl_pts))
                tp1 = float(curr_bar['close'] + (1.0 * target_sl_pts))

                diagnostics.update({"passed": True, "action": "BUY", "pulse": "DOWN_PULSE_REJECTED"})
                return StrategySignal(
                    strategy="ORB_CRACKER",
                    symbol=symbol,
                    direction="BUY",
                    entry_price=float(curr_bar['close']),
                    stop_loss=sl,
                    take_profit=tp,
                    take_profit_1=tp1,
                    take_profit_2=tp,
                    reference_range_height=cracker_range_height,
                    scale_out_fraction=0.50,
                    trail_mode="MOVE_TO_BE_80",
                    session="NY_OPEN",
                    confidence=0.87,
                    reason="NYSE Open ORB Cracker counter-pulse rejection off 200 EMA/VWAP",
                    diagnostics=diagnostics
                )

        diagnostics["reason"] = "No Cracker counter-pulse rejection identified"
        return None