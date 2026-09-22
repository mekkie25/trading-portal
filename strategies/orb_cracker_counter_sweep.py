"""
strategies/orb_cracker_counter_sweep.py
"""
from foundation import session_config

class ORBCracker:
    def __init__(self, instrument_config):
        self.stops = {
            'NASDAQ': 50,
            'US30': 50,
            'GOLD': 40,
            'SPY': 5
        }
        self.rr = instrument_config.get('risk_reward', 2.0)
        self.instrument = instrument_config['name']

    def evaluate(self, current_time, data_1m, session_levels):
        ny_session = session_config.get_session('New_York')
        if not self._is_active_window(current_time, ny_session.start_time):
            return None

        orb_high, orb_low = session_levels['orb_high'], session_levels['orb_low']
        candle = data_1m.iloc[-1]
        vwap = data_1m['session_vwap'].iloc[-1]
        ema_200 = data_1m['ema_200'].iloc[-1]

        # Break ORB High, Reject VWAP/200, Close Bearish
        if candle['high'] > orb_high and (candle['high'] >= vwap or candle['high'] >= ema_200) and candle['close'] < candle['open']:
            return self._execute('SHORT', candle)

        # Break ORB Low, Reject VWAP/200, Close Bullish
        if candle['low'] < orb_low and (candle['low'] <= vwap or candle['low'] <= ema_200) and candle['close'] > candle['open']:
            return self._execute('LONG', candle)

    def _is_active_window(self, current_time, ny_start):
        # Active only from 09:30 to 10:00 local NY time
        elapsed = (current_time - ny_start).seconds / 60
        return 0 <= elapsed <= 30

    def _execute(self, direction, candle):
        stop_points = self.stops.get(self.instrument, 30)
        entry_price = candle['close']
        
        sl = entry_price + stop_points if direction == 'SHORT' else entry_price - stop_points
        tp = entry_price - (stop_points * self.rr) if direction == 'SHORT' else entry_price + (stop_points * self.rr)
        
        return {
            'direction': direction,
            'stop_loss': sl,
            'target': tp,
            'breakeven_trigger': 0.80
        }