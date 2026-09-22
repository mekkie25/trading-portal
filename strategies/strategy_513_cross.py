"""
strategies/strategy_513_cross.py
"""
class Strategy513:
    def __init__(self, config):
        self.tf = config.get('timeframe', '5m')
        # Interpretation: Explicitly assuming standard daily floor pivot point per user prompt instructions.
        self.daily_flip_mode = config.get('daily_flip_mode', 'standard_pivot') 
        self.rr = config.get('risk_reward', 1.5)

    def evaluate(self, data):
        ema_5 = data['ema_5']
        ema_13 = data['ema_13']
        ema_200 = data['ema_200']
        
        daily_flip = data['daily_pivot'].iloc[-1] if self.daily_flip_mode == 'standard_pivot' else data['prev_daily_close'].iloc[-1]
        
        candle = data.iloc[-1]
        prev_candle = data.iloc[-2]
        
        cross_up = ema_5.iloc[-2] < ema_13.iloc[-2] and ema_5.iloc[-1] > ema_13.iloc[-1]
        cross_down = ema_5.iloc[-2] > ema_13.iloc[-2] and ema_5.iloc[-1] < ema_13.iloc[-1]
        
        if cross_up and candle['close'] >= daily_flip and candle['close'] > ema_200.iloc[-1]:
            if candle['close'] > ema_13.iloc[-1]: # Held above 13
                swing_low = data['low'].rolling(5).min().iloc[-1]
                sl = max(ema_13.iloc[-1], swing_low)
                return {'direction': 'LONG', 'stop_loss': sl, 'rr': self.rr}
                
        if cross_down and candle['close'] <= daily_flip and candle['close'] < ema_200.iloc[-1]:
            if candle['close'] < ema_13.iloc[-1]:
                swing_high = data['high'].rolling(5).max().iloc[-1]
                sl = min(ema_13.iloc[-1], swing_high)
                return {'direction': 'SHORT', 'stop_loss': sl, 'rr': self.rr}

        return None