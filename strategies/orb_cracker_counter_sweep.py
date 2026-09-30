from datetime import datetime, timezone
import pandas as pd
from strategies.base import StrategySignal

class ORBCracker:
    def evaluate(self, symbol: str, data_5m: pd.DataFrame, data_h4: pd.DataFrame = None, data_d1: pd.DataFrame = None, session_levels: dict = None) -> StrategySignal | None:
        if data_5m is None or len(data_5m) < 15 or session_levels is None:
            return None

        # STRICT TIME GATE: Only active during NYSE Open (15:30 - 16:30 SAST / 13:30 - 14:30 UTC)
        now_utc = datetime.now(timezone.utc)
        if not (now_utc.hour == 13 and now_utc.minute >= 30) and not (now_utc.hour == 14 and now_utc.minute <= 30):
            return None

        orb_h = session_levels.get('orb_high')
        orb_l = session_levels.get('orb_low')
        if not orb_h or not orb_l:
            return None

        curr = data_5m.iloc[-1]
        prev = data_5m.iloc[-2]
        ema_200 = data_5m['close'].ewm(span=200, adjust=False).mean().iloc[-1]

        # Bearish Cracker: NYSE open initial pulse sweeps ORB High & rejects 200 EMA
        if prev['high'] > orb_h and curr['high'] >= ema_200 and curr['close'] < curr['open']:
            sl = float(max(curr['high'], prev['high']))
            risk = abs(sl - curr['close'])
            if risk > 0:
                return StrategySignal(
                    strategy="ORB_CRACKER",
                    symbol=symbol,
                    direction="SELL",
                    entry_price=float(curr['close']),
                    stop_loss=sl,
                    take_profit=float(curr['close'] - (1.5 * risk)),
                    confidence=0.86,
                    reason="NYSE Open ORB Cracker counter-pulse rejection off 200 EMA"
                )

        # Bullish Cracker: NYSE open initial pulse sweeps ORB Low & rejects 200 EMA
        if prev['low'] < orb_l and curr['low'] <= ema_200 and curr['close'] > curr['open']:
            sl = float(min(curr['low'], prev['low']))
            risk = abs(curr['close'] - sl)
            if risk > 0:
                return StrategySignal(
                    strategy="ORB_CRACKER",
                    symbol=symbol,
                    direction="BUY",
                    entry_price=float(curr['close']),
                    stop_loss=sl,
                    take_profit=float(curr['close'] + (1.5 * risk)),
                    confidence=0.86,
                    reason="NYSE Open ORB Cracker counter-pulse rejection off 200 EMA"
                )

        return None