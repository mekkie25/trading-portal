from strategies.base import StrategySignal

class GrubberKick:
    def __init__(self, instrument_name="US30", stop_loss_points=35):
        self.instrument = instrument_name
        self.stop_loss_points = stop_loss_points

    def evaluate(self, symbol: str, data_5m, session_levels: dict) -> StrategySignal | None:
        if symbol != "US30" or data_5m is None or len(data_5m) < 15:
            return None

        ah = session_levels.get('asia_high')
        al = session_levels.get('asia_low')
        r1 = session_levels.get('pivot_r1')
        s1 = session_levels.get('pivot_s1')
        eq = session_levels.get('daily_eq')

        if not all([ah, al, eq]):
            return None

        recent_data = data_5m.tail(15)
        swept_low = (recent_data['low'] < al).any() and (data_5m.iloc[-1]['close'] > al)
        swept_high = (recent_data['high'] > ah).any() and (data_5m.iloc[-1]['close'] < ah)

        c_curr = data_5m.iloc[-1]
        c_prev = data_5m.iloc[-2]

        # Rule 3: 2 consecutive 5M closes holding across Daily Equilibrium (EQ)
        if swept_low:
            if c_prev['close'] > eq and c_curr['close'] > eq:
                sl = eq - self.stop_loss_points
                tp1 = ah  # TP1: Opposing Asian extreme
                tp2 = r1 if r1 and r1 > c_curr['close'] else c_curr['close'] + (2 * self.stop_loss_points)
                return StrategySignal(
                    strategy="GRUBBER_KICK",
                    symbol="US30",
                    direction="BUY",
                    entry_price=float(c_curr['close']),
                    stop_loss=float(sl),
                    take_profit=float(tp1),
                    take_profit_2=float(tp2),
                    confidence=0.92,
                    reason="US30 Asia Low swept + 2 consecutive 5M closes confirmed above EQ"
                )

        if swept_high:
            if c_prev['close'] < eq and c_curr['close'] < eq:
                sl = eq + self.stop_loss_points
                tp1 = al  # TP1: Opposing Asian extreme
                tp2 = s1 if s1 and s1 < c_curr['close'] else c_curr['close'] - (2 * self.stop_loss_points)
                return StrategySignal(
                    strategy="GRUBBER_KICK",
                    symbol="US30",
                    direction="SELL",
                    entry_price=float(c_curr['close']),
                    stop_loss=float(sl),
                    take_profit=float(tp1),
                    take_profit_2=float(tp2),
                    confidence=0.92,
                    reason="US30 Asia High swept + 2 consecutive 5M closes confirmed below EQ"
                )

        return None