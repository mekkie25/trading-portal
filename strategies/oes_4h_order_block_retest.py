import pandas as pd
from strategies.base import StrategySignal

class OrderBlockRetest:
    def evaluate(self, symbol: str, data_5m: pd.DataFrame, data_h4: pd.DataFrame = None, data_d1: pd.DataFrame = None, session_levels: dict = None) -> StrategySignal | None:
        if data_5m is None or len(data_5m) < 20:
            return None

        # Require genuine 4-Hour data to identify real institutional Order Blocks
        if data_h4 is None or len(data_h4) < 10:
            return None

        # Identify genuine 4H Order Block:
        # A bullish OB is the last down-candle before a strong upward displacement breaking structure.
        # A bearish OB is the last up-candle before a strong downward displacement breaking structure.
        h4_recent = data_h4.tail(8)
        bearish_ob_high = 0.0
        bearish_ob_low = 0.0
        bullish_ob_high = 0.0
        bullish_ob_low = 0.0

        for i in range(1, len(h4_recent) - 1):
            prev = h4_recent.iloc[i-1]
            curr = h4_recent.iloc[i]
            nxt = h4_recent.iloc[i+1]
            
            # Bearish 4H OB: Green candle followed by strong red impulse breaking prior lows
            if curr['close'] > curr['open'] and nxt['close'] < curr['low'] and (nxt['open'] - nxt['close']) > (curr['high'] - curr['low']):
                bearish_ob_high = float(curr['high'])
                bearish_ob_low = float(curr['low'])

            # Bullish 4H OB: Red candle followed by strong green impulse breaking prior highs
            if curr['close'] < curr['open'] and nxt['close'] > curr['high'] and (nxt['close'] - nxt['open']) > (curr['high'] - curr['low']):
                bullish_ob_high = float(curr['high'])
                bullish_ob_low = float(curr['low'])

        curr_5m = data_5m.iloc[-1]
        prev_5m = data_5m.iloc[-2]

        # Short: 5M price tests the 4H Bearish OB Zone, rejects, and closes with a bearish engulfing bar
        if bearish_ob_high > 0 and bearish_ob_low > 0:
            tested_zone = curr_5m['high'] >= bearish_ob_low and curr_5m['high'] <= (bearish_ob_high * 1.002)
            rejected = curr_5m['close'] < curr_5m['open'] and curr_5m['close'] < prev_5m['low']
            if tested_zone and rejected:
                sl = float(max(bearish_ob_high, curr_5m['high']))
                risk = abs(sl - curr_5m['close'])
                if risk > 0:
                    return StrategySignal(
                        strategy="OES_4H_ORDER_BLOCK",
                        symbol=symbol,
                        direction="SELL",
                        entry_price=float(curr_5m['close']),
                        stop_loss=sl,
                        take_profit=float(curr_5m['close'] - (2 * risk)),
                        confidence=0.88,
                        reason="Confirmed test and rejection of 4H Bearish Order Block with 5M structure shift"
                    )

        # Long: 5M price tests the 4H Bullish OB Zone, rejects, and closes with a bullish engulfing bar
        if bullish_ob_high > 0 and bullish_ob_low > 0:
            tested_zone = curr_5m['low'] <= bullish_ob_high and curr_5m['low'] >= (bullish_ob_low * 0.998)
            rejected = curr_5m['close'] > curr_5m['open'] and curr_5m['close'] > prev_5m['high']
            if tested_zone and rejected:
                sl = float(min(bullish_ob_low, curr_5m['low']))
                risk = abs(curr_5m['close'] - sl)
                if risk > 0:
                    return StrategySignal(
                        strategy="OES_4H_ORDER_BLOCK",
                        symbol=symbol,
                        direction="BUY",
                        entry_price=float(curr_5m['close']),
                        stop_loss=sl,
                        take_profit=float(curr_5m['close'] + (2 * risk)),
                        confidence=0.88,
                        reason="Confirmed test and rejection of 4H Bullish Order Block with 5M structure shift"
                    )

        return None