from strategies.base import StrategySignal

class AVWAPTrendContinuation:
    def evaluate(self, symbol: str, data_5m, session_levels: dict) -> StrategySignal | None:
        if data_5m is None or len(data_5m) < 30:
            return None

        ema_200 = data_5m['close'].ewm(span=200, adjust=False).mean()
        curr = data_5m.iloc[-1]
        level = ema_200.iloc[-1]

        # Trend Continuation Long off 200 EMA
        if curr['low'] <= level and curr['close'] > level:
            sl = float(level * 0.998)
            risk = abs(curr['close'] - sl)
            return StrategySignal(
                strategy="AVWAP_200EMA_CONTINUATION",
                symbol=symbol,
                direction="BUY",
                entry_price=float(curr['close']),
                stop_loss=sl,
                take_profit=float(curr['close'] + 2 * risk),
                confidence=0.80,
                reason="Dynamic pullback and rejection wick off 200 EMA in uptrend"
            )

        # Trend Continuation Short off 200 EMA
        if curr['high'] >= level and curr['close'] < level:
            sl = float(level * 1.002)
            risk = abs(sl - curr['close'])
            return StrategySignal(
                strategy="AVWAP_200EMA_CONTINUATION",
                symbol=symbol,
                direction="SELL",
                entry_price=float(curr['close']),
                stop_loss=sl,
                take_profit=float(curr['close'] - 2 * risk),
                confidence=0.80,
                reason="Dynamic pullback and rejection wick off 200 EMA in downtrend"
            )

        return None