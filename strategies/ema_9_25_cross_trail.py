import pandas as pd
from strategies.base import StrategySignal

class EMACrossTrail:
    def evaluate(self, symbol: str, data_5m: pd.DataFrame, data_h4: pd.DataFrame = None, data_d1: pd.DataFrame = None, session_levels: dict = None) -> StrategySignal | None:
        if data_5m is None or len(data_5m) < 35:
            return None

        close = data_5m['close']
        ema_9 = close.ewm(span=9, adjust=False).mean()
        ema_25 = close.ewm(span=25, adjust=False).mean()
        ema_200 = close.ewm(span=200, adjust=False).mean()

        c_curr = data_5m.iloc[-1]
        c_prev = data_5m.iloc[-2]

        current_200 = ema_200.iloc[-1]

        # Bullish: 9 EMA crosses above 25 EMA while price is above the 200 EMA
        bullish_cross = ema_9.iloc[-2] <= ema_25.iloc[-2] and ema_9.iloc[-1] > ema_25.iloc[-1]
        if bullish_cross and c_curr['close'] > current_200:
            sl = float(min(ema_25.iloc[-1], data_5m['low'].tail(4).min()))
            risk = abs(c_curr['close'] - sl)
            if risk > 0:
                return StrategySignal(
                    strategy="EMA_9_25_CROSS",
                    symbol=symbol,
                    direction="BUY",
                    entry_price=float(c_curr['close']),
                    stop_loss=sl,
                    take_profit=float(c_curr['close'] + (2 * risk)),
                    confidence=0.82,
                    reason="9/25 EMA bullish cross confirmed above 200 EMA trend benchmark"
                )

        # Bearish: 9 EMA crosses below 25 EMA while price is below the 200 EMA
        bearish_cross = ema_9.iloc[-2] >= ema_25.iloc[-2] and ema_9.iloc[-1] < ema_25.iloc[-1]
        if bearish_cross and c_curr['close'] < current_200:
            sl = float(max(ema_25.iloc[-1], data_5m['high'].tail(4).max()))
            risk = abs(sl - c_curr['close'])
            if risk > 0:
                return StrategySignal(
                    strategy="EMA_9_25_CROSS",
                    symbol=symbol,
                    direction="SELL",
                    entry_price=float(c_curr['close']),
                    stop_loss=sl,
                    take_profit=float(c_curr['close'] - (2 * risk)),
                    confidence=0.82,
                    reason="9/25 EMA bearish cross confirmed below 200 EMA trend benchmark"
                )

        return None