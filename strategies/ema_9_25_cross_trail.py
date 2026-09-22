"""
strategies/ema_9_25_cross_trail.py
"""
from foundation import indicators

class EMACrossTrail:
    def __init__(self, config):
        self.tf = config.get('timeframe', '5m')
        self.ref_tf = config.get('reference_timeframe', '1H')
        
    def evaluate(self, data, data_ref):
        ema_9 = data['ema_9']
        ema_25 = data['ema_25']
        ema_200_ref = data_ref['ema_200'].iloc[-1]
        current_price = data['close'].iloc[-1]
        
        bias = 'LONG' if current_price > ema_200_ref else 'SHORT'
        
        cross_up = ema_9.iloc[-2] < ema_25.iloc[-2] and ema_9.iloc[-1] > ema_25.iloc[-1]
        cross_down = ema_9.iloc[-2] > ema_25.iloc[-2] and ema_9.iloc[-1] < ema_25.iloc[-1]
        
        if bias == 'LONG' and cross_up:
            return self._wait_for_pullback(data, 'LONG')
        elif bias == 'SHORT' and cross_down:
            return self._wait_for_pullback(data, 'SHORT')
            
        return None

    def _wait_for_pullback(self, data, direction):
        # Requires state management in live bot; returning logic block for confirmation.
        candle = data.iloc[-1]
        ema_9, ema_25 = candle['ema_9'], candle['ema_25']
        
        touched_ema = (candle['low'] <= ema_9 or candle['low'] <= ema_25) if direction == 'LONG' else (candle['high'] >= ema_9 or candle['high'] >= ema_25)
        held_ema = candle['close'] > ema_25 if direction == 'LONG' else candle['close'] < ema_25
        
        if touched_ema and held_ema:
            # Interpretation choice: Stop loss uses the tighter of 25 EMA or recent 5-period swing extreme.
            swing_extreme = data['low'].rolling(5).min().iloc[-1] if direction == 'LONG' else data['high'].rolling(5).max().iloc[-1]
            sl = max(ema_25, swing_extreme) if direction == 'LONG' else min(ema_25, swing_extreme)
            
            return {
                'direction': direction,
                'stop_loss': sl,
                'exit_mode': 'TRAIL_9_EMA' # Exit triggered when price closes back across 9 EMA
            }
        return None