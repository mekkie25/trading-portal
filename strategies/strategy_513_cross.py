from strategies.base import StrategySignal

class Strategy513:
    def evaluate(self, symbol: str, data_5m, session_levels: dict) -> StrategySignal | None:
        if data_5m is None or len(data_5m) < 25:
            return None

        close = data_5m['close']
        ema_5 = close.ewm(span=5, adjust=False).mean()
        ema_13 = close.ewm(span=13, adjust=False).mean()
        ema_200 = close.ewm(span=200, adjust=False).mean()

        c_curr = data_5m.iloc[-1]
        c_prev = data_5m.iloc[-2]

        bullish_cross = ema_5.iloc[-2] < ema_13.iloc[-2] and ema_5.iloc[-1] > ema_13.iloc[-1]
        bearish_cross = ema_5.iloc[-2] > ema_13.iloc[-2] and ema_5.iloc[-1] < ema_13.iloc[-1]

        pivot = session_levels.get('daily_pivot', ema_200.iloc[-1])

        if bullish_cross and c_curr['close'] > ema_200.iloc[-1] and c_curr['close'] >= pivot:
            sl = float(data_5m['low'].tail(5).min())
            risk = abs(c_curr['close'] - sl)
            return StrategySignal(
                strategy="STRATEGY_513",
                symbol=symbol,
                direction="BUY",
                entry_price=float(c_curr['close']),
                stop_loss=sl,
                take_profit=float(c_curr['close'] + (1.5 * risk)),
                confidence=0.82,
                reason="5/13 EMA Bullish Cross above Daily Pivot & 200 EMA"
            )

        if bearish_cross and c_curr['close'] < ema_200.iloc[-1] and c_curr['close'] <= pivot:
            sl = float(data_5m['high'].tail(5).max())
            risk = abs(sl - c_curr['close'])
            return StrategySignal(
                strategy="STRATEGY_513",
                symbol=symbol,
                direction="SELL",
                entry_price=float(c_curr['close']),
                stop_loss=sl,
                take_profit=float(c_curr['close'] - (1.5 * risk)),
                confidence=0.82,
                reason="5/13 EMA Bearish Cross below Daily Pivot & 200 EMA"
            )

        return None