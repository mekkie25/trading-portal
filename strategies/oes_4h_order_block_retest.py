from strategies.base import StrategySignal

class OrderBlockRetest:
    def evaluate(self, symbol: str, data_5m, session_levels: dict) -> StrategySignal | None:
        if data_5m is None or len(data_5m) < 15:
            return None

        curr = data_5m.iloc[-1]
        recent_low = data_5m['low'].tail(10).min()
        recent_high = data_5m['high'].tail(10).max()

        # Shift in market structure following an order block mitigation
        if curr['close'] > recent_high and curr['close'] > curr['open']:
            sl = float(recent_low)
            return StrategySignal(
                strategy="OES_4H_ORDER_BLOCK",
                symbol=symbol,
                direction="BUY",
                entry_price=float(curr['close']),
                stop_loss=sl,
                take_profit=float(curr['close'] + 2 * abs(curr['close'] - sl)),
                confidence=0.84,
                reason="4H Order Block mitigation with lower timeframe structure shift"
            )

        if curr['close'] < recent_low and curr['close'] < curr['open']:
            sl = float(recent_high)
            return StrategySignal(
                strategy="OES_4H_ORDER_BLOCK",
                symbol=symbol,
                direction="SELL",
                entry_price=float(curr['close']),
                stop_loss=sl,
                take_profit=float(curr['close'] - 2 * abs(sl - curr['close'])),
                confidence=0.84,
                reason="4H Order Block mitigation with lower timeframe structure breakdown"
            )

        return None