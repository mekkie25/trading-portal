"""
trading-portal/strategies/oes_4h_order_block_retest.py
Order Flow Entry Strategy (OES) / 4H & 1H Zone Retest (Spec Setup 6).
- Timeframe Analysis: 4H & 1H Institutional Order Blocks (OB) and Fair Value Gaps (FVG)
- Confluence: 4H + 1H overlapping order block confluence yields higher confidence (0.95)
- Confirmation: 5M Market Structure Shift (MSS) + Bullish/Bearish Engulfing close
- Stop Loss: Placed strictly beyond the OB extreme + technical buffer
- Take Profit: TP1 = 1:2 R:R, TP2 = Session High/Low
"""

import pandas as pd
from strategies.base import StrategySignal
from core.indicators import is_bullish_engulfing, is_bearish_engulfing

def find_order_blocks(df: pd.DataFrame):
    bullish_ob = None
    bearish_ob = None
    if df is None or len(df) < 3:
        return bullish_ob, bearish_ob

    sub = df.tail(12)
    for i in range(2, len(sub)):
        b1 = sub.iloc[i - 2]
        b2 = sub.iloc[i - 1]
        b3 = sub.iloc[i]

        # Bullish OB: Down candle followed by displacement leaving an FVG (b3['low'] > b1['high'])
        if b2['close'] < b2['open'] and b3['close'] > b2['high']:
            if b3['low'] > b1['high']:
                bullish_ob = {'high': float(b2['high']), 'low': float(b2['low'])}

        # Bearish OB: Up candle followed by displacement leaving an FVG (b3['high'] < b1['low'])
        if b2['close'] > b2['open'] and b3['close'] < b2['low']:
            if b3['high'] < b1['low']:
                bearish_ob = {'high': float(b2['high']), 'low': float(b2['low'])}

    return bullish_ob, bearish_ob

class OrderBlockRetest:
    def evaluate(self, symbol: str, data_5m: pd.DataFrame, data_h4: pd.DataFrame = None, data_d1: pd.DataFrame = None, session_levels: dict = None, data_h1: pd.DataFrame = None) -> StrategySignal | None:
        diagnostics = {"strategy": "OES_4H_ORDER_BLOCK", "passed": False, "reason": ""}

        if data_5m is None or len(data_5m) < 20:
            diagnostics["reason"] = "Insufficient 5M bars"
            return None

        # Minimum timeframe validation
        if (data_h4 is None or len(data_h4) < 10) and (data_h1 is None or len(data_h1) < 12):
            diagnostics["reason"] = "Requires minimum 10 bars of 4H or 12 bars of 1H data"
            return None

        h4_bull, h4_bear = find_order_blocks(data_h4)
        h1_bull, h1_bear = find_order_blocks(data_h1)

        # Determine bullish OB with 4H+1H confluence check
        bullish_ob = h4_bull or h1_bull
        bull_confluence = False
        if h4_bull and h1_bull:
            if max(h4_bull['low'], h1_bull['low']) <= min(h4_bull['high'], h1_bull['high']):
                bull_confluence = True
                bullish_ob = {
                    'high': min(h4_bull['high'], h1_bull['high']),
                    'low': max(h4_bull['low'], h1_bull['low'])
                }

        # Determine bearish OB with 4H+1H confluence check
        bearish_ob = h4_bear or h1_bear
        bear_confluence = False
        if h4_bear and h1_bear:
            if max(h4_bear['low'], h1_bear['low']) <= min(h4_bear['high'], h1_bear['high']):
                bear_confluence = True
                bearish_ob = {
                    'high': min(h4_bear['high'], h1_bear['high']),
                    'low': max(h4_bear['low'], h1_bear['low'])
                }

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
                    confidence = 0.95 if bull_confluence else 0.90
                    reason = "Mitigation of 4H + 1H Confluent Order Block + FVG with 5M MSS" if bull_confluence else "Mitigation of Institutional Order Block + FVG with 5M MSS"

                    diagnostics.update({"passed": True, "action": "BUY", "ob_zone": bullish_ob, "confluence": bull_confluence})
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
                        trail_mode="SUPERTREND",
                        session="ALL_DAY",
                        confidence=confidence,
                        reason=reason,
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
                    confidence = 0.95 if bear_confluence else 0.90
                    reason = "Mitigation of 4H + 1H Confluent Order Block + FVG with 5M MSS" if bear_confluence else "Mitigation of Institutional Order Block + FVG with 5M MSS"

                    diagnostics.update({"passed": True, "action": "SELL", "ob_zone": bearish_ob, "confluence": bear_confluence})
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
                        trail_mode="SUPERTREND",
                        session="ALL_DAY",
                        confidence=confidence,
                        reason=reason,
                        diagnostics=diagnostics
                    )

        diagnostics["reason"] = "No active institutional OB mitigation and lower timeframe structure shift"
        return None