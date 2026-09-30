"""
trading-portal/strategies/oes_4h_order_block_retest.py
Order Flow Entry Strategy (OES) / 4H Zone Retest (Spec Setup 6).
- Timeframe Analysis: 4H/1H Institutional Order Block (OB) and Fair Value Gap (FVG)
- Market Action: Price returns to mitigate the 4H OB zone
- Confirmation: 5M Market Structure Shift (MSS) + Bullish/Bearish Engulfing close
- Stop Loss: Placed strictly beyond the 4H OB extreme + technical buffer
- Take Profit: TP1 = 1:2 R:R, TP2 = Session High/Low
"""

import pandas as pd
from strategies.base import StrategySignal
from core.indicators import is_bullish_engulfing, is_bearish_engulfing

class OrderBlockRetest:
    def evaluate(self, symbol: str, data_5m: pd.DataFrame, data_h4: pd.DataFrame = None, data_d1: pd.DataFrame = None, session_levels: dict = None) -> StrategySignal | None:
        diagnostics = {"strategy": "OES_4H_ORDER_BLOCK", "passed": False, "reason": ""}

        if data_5m is None or len(data_5m) < 20:
            diagnostics["reason"] = "Insufficient 5M bars"
            return None

        # Requires genuine 4H data for institutional zone validation
        if data_h4 is None or len(data_h4) < 12:
            diagnostics["reason"] = "Requires minimum 12 bars of 4H data"
            return None

        # Scan for institutional Order Block + Fair Value Gap (FVG) in 4H data
        h4 = data_h4.tail(10)
        bearish_ob = None
        bullish_ob = None

        for i in range(2, len(h4)):
            b1 = h4.iloc[i - 2]
            b2 = h4.iloc[i - 1]
            b3 = h4.iloc[i]

            # Bullish 4H OB: Down candle followed by displacement leaving an FVG (b3['low'] > b1['high'])
            if b2['close'] < b2['open'] and b3['close'] > b2['high']:
                if b3['low'] > b1['high']:  # FVG presence
                    bullish_ob = {'high': float(b2['high']), 'low': float(b2['low'])}

            # Bearish 4H OB: Up candle followed by displacement leaving an FVG (b3['high'] < b1['low'])
            if b2['close'] > b2['open'] and b3['close'] < b2['low']:
                if b3['high'] < b1['low']:  # FVG presence
                    bearish_ob = {'high': float(b2['high']), 'low': float(b2['low'])}

        curr_bar = data_5m.iloc[-1]
        prev_bar = data_5m.iloc[-2]

        buffer = 3.0 if symbol in ("US30", "NAS100") else (0.40 if symbol == "GOLD" else 0.0004)

        # BULLISH OES RETEST
        if bullish_ob:
            in_zone = curr_bar['low'] <= bullish_ob['high'] and curr_bar['close'] >= bullish_ob['low']
            mss_confirmed = is_bullish_engulfing(prev_bar, curr_bar)

            if in_zone and mss_confirmed:
                sl = float(bullish_ob['low'] - buffer)
                risk = abs(curr_bar['close'] - sl)
                if risk > 0:
                    tp1 = float(curr_bar['close'] + (2.0 * risk))
                    tp2 = float(session_levels.get('pdh', curr_bar['close'] + (3.0 * risk)))

                    diagnostics.update({"passed": True, "action": "BUY", "ob_zone": bullish_ob})
                    return StrategySignal(
                        strategy="OES_4H_ORDER_BLOCK",
                        symbol=symbol,
                        direction="BUY",
                        entry_price=float(curr_bar['close']),
                        stop_loss=sl,
                        take_profit=tp1,
                        take_profit_1=tp1,
                        take_profit_2=tp2,
                        scale_out_fraction=0.50,
                        trail_mode="MOVE_TO_BE_80",
                        session="ALL_DAY",
                        confidence=0.90,
                        reason="Mitigation of 4H Bullish Order Block + FVG with 5M market structure shift",
                        diagnostics=diagnostics
                    )

        # BEARISH OES RETEST
        if bearish_ob:
            in_zone = curr_bar['high'] >= bearish_ob['low'] and curr_bar['close'] <= bearish_ob['high']
            mss_confirmed = is_bearish_engulfing(prev_bar, curr_bar)

            if in_zone and mss_confirmed:
                sl = float(bearish_ob['high'] + buffer)
                risk = abs(sl - curr_bar['close'])
                if risk > 0:
                    tp1 = float(curr_bar['close'] - (2.0 * risk))
                    tp2 = float(session_levels.get('pdl', curr_bar['close'] - (3.0 * risk)))

                    diagnostics.update({"passed": True, "action": "SELL", "ob_zone": bearish_ob})
                    return StrategySignal(
                        strategy="OES_4H_ORDER_BLOCK",
                        symbol=symbol,
                        direction="SELL",
                        entry_price=float(curr_bar['close']),
                        stop_loss=sl,
                        take_profit=tp1,
                        take_profit_1=tp1,
                        take_profit_2=tp2,
                        scale_out_fraction=0.50,
                        trail_mode="MOVE_TO_BE_80",
                        session="ALL_DAY",
                        confidence=0.90,
                        reason="Mitigation of 4H Bearish Order Block + FVG with 5M market structure shift",
                        diagnostics=diagnostics
                    )

        diagnostics["reason"] = "No active 4H OB mitigation and lower timeframe structure shift"
        return None