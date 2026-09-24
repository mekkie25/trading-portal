from strategies.base import StrategySignal

class EMACrossTrail:
    def evaluate(self, symbol: str, data_5m, session_levels: dict) -> StrategySignal | None:
        if data_5m is None or len(data_5m) < 30:
            return None

        ema_9 = data_5m['close'].ewm(span=9, adjust=False).mean()
        ema_25 = data_5m['close'].ewm(span=25, adjust=False).mean()
        c_curr = data_5m.iloc[-1]

        if ema_9.iloc[-2] < ema_25.iloc[-2] and ema_9.iloc[-1] > ema_25.iloc[-1]:
            sl = float(ema_25.iloc[-1])
            return StrategySignal(
                strategy="EMA_9_25_CROSS",
                symbol=symbol,
                direction="BUY",
                entry_price=float(c_curr['close']),
                stop_loss=sl,
                take_profit=float(c_curr['close'] + 2 * abs(c_curr['close'] - sl)),
                confidence=0.78,
                reason="9 EMA crossed above 25 EMA with candle hold"
            )

        if ema_9.iloc[-2] > ema_25.iloc[-2] and ema_9.iloc[-1] < ema_25.iloc[-1]:
            sl = float(ema_25.iloc[-1])
            return StrategySignal(
                strategy="EMA_9_25_CROSS",
                symbol=symbol,
                direction="SELL",
                entry_price=float(c_curr['close']),
                stop_loss=sl,
                take_profit=float(c_curr['close'] - 2 * abs(sl - c_curr['close'])),
                confidence=0.78,
                reason="9 EMA crossed below 25 EMA with candle hold"
            )

        return None