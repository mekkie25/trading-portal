from strategies.base import StrategySignal
from core import volume_profile

class ORBLiquiditySweep:
    def evaluate(self, symbol: str, data_5m, session_levels: dict) -> StrategySignal | None:
        if data_5m is None or len(data_5m) < 15:
            return None

        vp = volume_profile.get_levels(data_5m)
        curr = data_5m.iloc[-1]
        prev = data_5m.iloc[-2]

        ah = session_levels.get('asia_high')
        al = session_levels.get('asia_low')
        if not ah or not al:
            return None

        # Sweep of Asia Low & Reversal back inside Value Area
        if prev['low'] < al and curr['close'] > al and curr['close'] > curr['open']:
            sl = float(prev['low'])
            risk = abs(curr['close'] - sl)
            return StrategySignal(
                strategy="ORB_LIQUIDITY_SWEEP",
                symbol=symbol,
                direction="BUY",
                entry_price=float(curr['close']),
                stop_loss=sl,
                take_profit=float(vp['POC'] if vp['POC'] > curr['close'] else curr['close'] + 2 * risk),
                confidence=0.85,
                reason=f"Opening Range sweep of Asia Low ({al:.2f}) with bullish reversal close"
            )

        # Sweep of Asia High & Reversal back inside Value Area
        if prev['high'] > ah and curr['close'] < ah and curr['close'] < curr['open']:
            sl = float(prev['high'])
            risk = abs(sl - curr['close'])
            return StrategySignal(
                strategy="ORB_LIQUIDITY_SWEEP",
                symbol=symbol,
                direction="SELL",
                entry_price=float(curr['close']),
                stop_loss=sl,
                take_profit=float(vp['POC'] if vp['POC'] < curr['close'] else curr['close'] - 2 * risk),
                confidence=0.85,
                reason=f"Opening Range sweep of Asia High ({ah:.2f}) with bearish reversal close"
            )

        return None