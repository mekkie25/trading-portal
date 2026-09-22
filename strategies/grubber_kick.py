"""
strategies/grubber_kick.py
Maps to the 3-Rule Box Strategy (AMD Cycle).
"""

class GrubberKick:
    def __init__(self, instrument_config):
        self.instrument = instrument_config.get('name', 'US30')
        # Fixed tight stop loss of 30 to 35 points
        self.stop_loss_points = instrument_config.get('stop_loss_points', 35)

    def evaluate(self, current_time, data_5m, session_levels):
        # Strategy is explicitly designed for US30
        if self.instrument != 'US30':
            return None

        # 1. Fetch required levels
        ah = session_levels.get('asia_high')
        al = session_levels.get('asia_low')
        r1 = session_levels.get('pivot_r1')
        r2 = session_levels.get('pivot_r2')
        s1 = session_levels.get('pivot_s1')
        s2 = session_levels.get('pivot_s2')
        
        # Calculate EQ (Daily Equilibrium / 50% Midpoint) if not explicitly provided
        eq = session_levels.get('daily_eq')
        if not eq:
            dh = session_levels.get('daily_high')
            dl = session_levels.get('daily_low')
            if dh and dl:
                eq = (dh + dl) / 2
            else:
                return None

        # 2. Rule 1 & Rule 2: Detect the Liquidity Sweep (Fakeout)
        # Scan recent 5m history for an aggressive punch through AH/AL that sharply rejected
        sweep_direction = self._detect_recent_sweep(data_5m, ah, al)
        if not sweep_direction:
            return None

        # 3. Rule 3: EQ Level Test & Confirmation (5-Minute Timeframe)
        candle_curr = data_5m.iloc[-1]
        candle_prev = data_5m.iloc[-2]
        
        if sweep_direction == 'LONG':
            # Price swept AL (trapped sellers), reversed up to test EQ
            tested_eq = candle_prev['low'] <= eq <= candle_prev['high'] or candle_curr['low'] <= eq <= candle_curr['high']
            # Confirmation: Second candle closure holding above EQ
            holds_above = candle_prev['close'] > eq and candle_curr['close'] > eq
            
            if tested_eq and holds_above:
                return self._execute('LONG', candle_curr['close'], eq, ah, r1, r2)
                
        elif sweep_direction == 'SHORT':
            # Price swept AH (trapped buyers), reversed down to test EQ
            tested_eq = candle_prev['high'] >= eq >= candle_prev['low'] or candle_curr['high'] >= eq >= candle_curr['low']
            # Confirmation: Second candle closure holding below EQ
            holds_below = candle_prev['close'] < eq and candle_curr['close'] < eq
            
            if tested_eq and holds_below:
                return self._execute('SHORT', candle_curr['close'], eq, al, s1, s2)

        return None

    def _detect_recent_sweep(self, data_5m, ah, al, lookback=48):
        """Scans the last N periods for a confirmed fakeout (sweep & rejection)."""
        recent_data = data_5m.tail(lookback)
        for i in range(len(recent_data)):
            c = recent_data.iloc[i]
            # Sweep AL: Breaks below Asia Low, closes back inside (bullish fakeout -> go Long)
            if c['low'] < al and c['close'] > al:
                return 'LONG'
            # Sweep AH: Breaks above Asia High, closes back inside (bearish fakeout -> go Short)
            if c['high'] > ah and c['close'] < ah:
                return 'SHORT'
        return None

    def _execute(self, direction, current_price, eq, tp1, tp2, tp3):
        # Stop loss placed tightly beyond the invalidation point (EQ line +/- points buffer)
        sl = eq - self.stop_loss_points if direction == 'LONG' else eq + self.stop_loss_points
        
        return {
            'strategy': 'GRUBBER_KICK',
            'type': 'MARKET',
            'direction': direction,
            'stop_loss': sl,
            'targets': [
                {'price': tp1, 'size': 0.33, 'trigger_be': True},  # Break-Even trigger at Opposing Asia High/Low
                {'price': tp2, 'size': 0.33},                      # Main Target (R1/S1)
                {'price': tp3, 'size': 0.34}                       # Runner Target (R2/S2)
            ]
        }