from strategies.base import StrategySignal

class ORBCracker:
    def evaluate(self, symbol: str, data_5m, session_levels: dict) -> StrategySignal | None:
        if data_5m is None or len(data_5m) < 10:
            return None

        orb_h = session_levels.get('orb_high')
        orb_l = session_levels.get('orb_low')
        if not orb_h or not orb_l:
            return None

        curr = data_5m.iloc[-1]
        ema_200 = data_5m['close'].ewm(span=200, adjust=False).mean().iloc[-1]

        if curr['high'] > orb_h and curr['high'] >= ema_200 and curr['close'] < curr['open']:
            sl = float(curr['high'])
            return StrategySignal(
                strategy="ORB_CRACKER",
                symbol=symbol,
                direction="SELL",
                entry_price=float(curr['close']),
                stop_loss=sl,
                take_profit=float(curr['close'] - 1.5 * abs(sl - curr['close'])),
                confidence=0.81,
                reason="ORB Cracker counter-pulse rejection off 200 EMA"
            )

        if curr['low'] < orb_l and curr['low'] <= ema_200 and curr['close'] > curr['open']:
            sl = float(curr['low'])
            return StrategySignal(
                strategy="ORB_CRACKER",
                symbol=symbol,
                direction="BUY",
                entry_price=float(curr['close']),
                stop_loss=sl,
                take_profit=float(curr['close'] + 1.5 * abs(curr['close'] - sl)),
                confidence=0.81,
                reason="ORB Cracker counter-pulse rejection off 200 EMA"
            )

        return None