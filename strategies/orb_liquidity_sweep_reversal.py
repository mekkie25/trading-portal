"""
trading-portal/strategies/orb_liquidity_sweep_reversal.py
Opening Range Liquidity Sweep & Value Area Reversal (Spec Setup 1).
- Session: London Open (08:00-10:00 SAST) or NY Open (15:30-16:30 SAST)
- Prerequisite: 15M Opening Range Established
- Price Action: Sweep of Asia H/L OR PDH/PDL OR 15M OR H/L
- Location: At VAH, VAL, POC, or 200 EMA
- Confirmation: 5M Bullish/Bearish Engulfing candle closing back inside 75% Value Area
- Adaptive Buffers: Scales sweep cushion (2% ADR) under adaptive mode
- SL: Sweep wick extremum + buffer (2-5 pts/pips)
- TP1: Point of Control (Close 50%), TP2: Opposite Value Area Extreme
"""

import pandas as pd
from strategies.base import StrategySignal
from core.session_config import MarketSessionManager
from core.indicators import is_bullish_engulfing, is_bearish_engulfing, calculate_cvd_absorption_proxy

try:
    from config.strategy_params import GLOBAL_PARAMS
except ImportError:
    from core.session_config import GLOBAL_PARAMS


class ORBLiquiditySweep:
    def evaluate(self, symbol: str, data_5m: pd.DataFrame, data_h4: pd.DataFrame = None, data_d1: pd.DataFrame = None, session_levels: dict = None) -> StrategySignal | None:
        diagnostics = {"strategy": "ORB_LIQUIDITY_SWEEP", "passed": False, "reason": ""}

        if data_5m is None or len(data_5m) < 20 or not session_levels:
            diagnostics["reason"] = "Insufficient data or session levels"
            return None

        curr_bar_time = data_5m.iloc[-1]['time']
        in_london = MarketSessionManager.is_in_london_open(curr_bar_time)
        in_ny = MarketSessionManager.is_in_ny_open(curr_bar_time)

        if not (in_london or in_ny):
            diagnostics["reason"] = "Outside London or New York Open execution window"
            return None

        if not session_levels.get('orb_established', False):
            diagnostics["reason"] = "15M Opening Range is not yet established"
            return None

        orb_h = session_levels.get('orb_high')
        orb_l = session_levels.get('orb_low')
        vah = session_levels.get('vah')
        val = session_levels.get('val')
        poc = session_levels.get('poc')
        ah = session_levels.get('asia_high')
        al = session_levels.get('asia_low')
        pdh = session_levels.get('pdh')
        pdl = session_levels.get('pdl')

        curr_bar = data_5m.iloc[-1]
        prev_bar = data_5m.iloc[-2]

        if GLOBAL_PARAMS.require_cvd_absorption:
            cvd = calculate_cvd_absorption_proxy(data_5m, lookback=10)
            if not cvd['absorption_detected']:
                diagnostics["reason"] = "CVD absorption proxy did not confirm level absorption"
                return None

        adr = session_levels.get("adr")
        if GLOBAL_PARAMS.adaptive_mode and adr is not None and adr > 0:
            buffer = 0.02 * adr            # [PROPOSED]: 2% ADR sweep buffer
        else:
            buffer = 3.0 if symbol in ("US30", "NAS100") else (0.30 if symbol == "GOLD" else 0.0003)

        orb_range_height = abs(orb_h - orb_l) if orb_h and orb_l else None

        # BULLISH REVERSAL (Sweep Lows -> Engulfing close back inside Value Area)
        swept_low = (prev_bar['low'] < al) or (prev_bar['low'] < pdl) or (prev_bar['low'] < orb_l)
        if swept_low:
            closed_inside_va = curr_bar['close'] >= val
            engulfing = is_bullish_engulfing(prev_bar, curr_bar)

            if closed_inside_va and engulfing:
                sl = float(min(prev_bar['low'], curr_bar['low']) - buffer)
                risk = abs(curr_bar['close'] - sl)
                tp1 = float(poc) if poc and poc > curr_bar['close'] else float(curr_bar['close'] + risk)
                tp2 = float(vah) if vah and vah > tp1 else float(curr_bar['close'] + (2 * risk))

                diagnostics.update({"passed": True, "action": "BUY", "swept": "LOWS", "tp1": tp1, "tp2": tp2})
                return StrategySignal(
                    strategy="ORB_LIQUIDITY_SWEEP",
                    symbol=symbol,
                    direction="BUY",
                    entry_price=float(curr_bar['close']),
                    stop_loss=sl,
                    take_profit=tp2,
                    take_profit_1=tp1,
                    take_profit_2=tp2,
                    reference_range_height=orb_range_height,
                    scale_out_fraction=0.50,
                    trail_mode="MOVE_TO_BE_80",
                    session="LONDON_OR_NY",
                    confidence=0.89,
                    reason="ORB Low swept with 5M bullish engulfing close back inside 75% Value Area",
                    diagnostics=diagnostics
                )

        # BEARISH REVERSAL (Sweep Highs -> Engulfing close back inside Value Area)
        swept_high = (prev_bar['high'] > ah) or (prev_bar['high'] > pdh) or (prev_bar['high'] > orb_h)
        if swept_high:
            closed_inside_va = curr_bar['close'] <= vah
            engulfing = is_bearish_engulfing(prev_bar, curr_bar)

            if closed_inside_va and engulfing:
                sl = float(max(prev_bar['high'], curr_bar['high']) + buffer)
                risk = abs(sl - curr_bar['close'])
                tp1 = float(poc) if poc and poc < curr_bar['close'] else float(curr_bar['close'] - risk)
                tp2 = float(val) if val and val < tp1 else float(curr_bar['close'] - (2 * risk))

                diagnostics.update({"passed": True, "action": "SELL", "swept": "HIGHS", "tp1": tp1, "tp2": tp2})
                return StrategySignal(
                    strategy="ORB_LIQUIDITY_SWEEP",
                    symbol=symbol,
                    direction="SELL",
                    entry_price=float(curr_bar['close']),
                    stop_loss=sl,
                    take_profit=tp2,
                    take_profit_1=tp1,
                    take_profit_2=tp2,
                    reference_range_height=orb_range_height,
                    scale_out_fraction=0.50,
                    trail_mode="MOVE_TO_BE_80",
                    session="LONDON_OR_NY",
                    confidence=0.89,
                    reason="ORB High swept with 5M bearish engulfing close back inside 75% Value Area",
                    diagnostics=diagnostics
                )

        diagnostics["reason"] = "No qualifying sweep and engulfing re-entry"
        return None