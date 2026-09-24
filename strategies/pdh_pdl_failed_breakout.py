from strategies.base import StrategySignal

class LiquidityTrap:
    def evaluate(self, symbol: str, data_5m, session_levels: dict) -> StrategySignal | None:
        if data_5m is None or len(data_5m) < 10:
            return None

        pdh = session_levels.get('pdh')
        pdl = session_levels.get('pdl')
        if not pdh or not pdl:
            return None

        curr = data_5m.iloc[-1]
        prev = data_5m.iloc[-2]

        if prev['high'] > pdh and curr['close'] < pdh:
            sl = float(prev['high'])
            return StrategySignal(
                strategy="PDH_PDL_FAILED_BREAKOUT",
                symbol=symbol,
                direction="SELL",
                entry_price=float(curr['close']),
                stop_loss=sl,
                take_profit=float(curr['close'] - 2 * abs(sl - curr['close'])),
                confidence=0.83,
                reason=f"Failed breakout above Previous Daily High ({pdh:.2f}) - Liquidity Trap"
            )

        if prev['low'] < pdl and curr['close'] > pdl:
            sl = float(prev['low'])
            return StrategySignal(
                strategy="PDH_PDL_FAILED_BREAKOUT",
                symbol=symbol,
                direction="BUY",
                entry_price=float(curr['close']),
                stop_loss=sl,
                take_profit=float(curr['close'] + 2 * abs(curr['close'] - sl)),
                confidence=0.83,
                reason=f"Failed breakout below Previous Daily Low ({pdl:.2f}) - Liquidity Trap"
            )

        return None