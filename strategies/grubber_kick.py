from strategies.base import StrategySignal

class GrubberKick:
    def __init__(self, instrument_name="US30", stop_loss_points=35):
        self.instrument = instrument_name
        self.stop_loss_points = stop_loss_points

    def evaluate(self, symbol: str, data_5m, session_levels: dict) -> StrategySignal | None:
        if symbol != "US30" or data_5m is None or len(data_5m) < 10:
            return None

        ah = session_levels.get('asia_high')
        al = session_levels.get('asia_low')
        r1 = session_levels.get('pivot_r1')
        s1 = session_levels.get('pivot_s1')
        eq = session_levels.get('daily_eq')

        if not all([ah, al, eq]):
            return None

        recent_data = data_5m.tail(20)
        swept_low = any(recent_data['low'] < al) and recent_data.iloc[-1]['close'] > al
        swept_high = any(recent_data['high'] > ah) and recent_data.iloc[-1]['close'] < ah

        c_curr = data_5m.iloc[-1]
        c_prev = data_5m.iloc[-2]

        if swept_low:
            if c_prev['close'] > eq and c_curr['close'] > eq:
                sl = eq - self.stop_loss_points
                tp = r1 if r1 else c_curr['close'] + 100
                return StrategySignal(
                    strategy="GRUBBER_KICK",
                    symbol="US30",
                    direction="BUY",
                    entry_price=float(c_curr['close']),
                    stop_loss=float(sl),
                    take_profit=float(tp),
                    confidence=0.90,
                    reason="US30 Asia Low swept and 2 consecutive 5M closes confirmed above EQ"
                )

        if swept_high:
            if c_prev['close'] < eq and c_curr['close'] < eq:
                sl = eq + self.stop_loss_points
                tp = s1 if s1 else c_curr['close'] - 100
                return StrategySignal(
                    strategy="GRUBBER_KICK",
                    symbol="US30",
                    direction="SELL",
                    entry_price=float(c_curr['close']),
                    stop_loss=float(sl),
                    take_profit=float(tp),
                    confidence=0.90,
                    reason="US30 Asia High swept and 2 consecutive 5M closes confirmed below EQ"
                )

        return None