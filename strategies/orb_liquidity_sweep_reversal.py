"""
strategies/orb_liquidity_sweep_reversal.py
Interacts with core components found in the `.zip` architecture[cite: 25].
"""
from foundation import session_config, risk_manager, volume_profile
from execution import OrderExecutor

class ORBLiquiditySweep:
    def __init__(self, instrument_config):
        self.instrument = instrument_config['name']
        self.stop_buffer = instrument_config.get('stop_buffer_pips', 3)
        # Interpretation: "Near a level" tolerance defined as 0.1% of price, adjustable per instrument.
        self.confluence_tolerance = instrument_config.get('confluence_tolerance_pct', 0.001)
        # Interpretation: "Absorption threshold" defined as CVD delta reducing by at least 30% from the sweep candle.
        self.absorption_threshold = 0.30 

    def evaluate(self, current_time, data_5m, data_15m, session_levels):
        # 1. Context / Timing
        current_session = session_config.get_active_session(current_time)
        if current_session not in ['London', 'New_York']:
            return None
        
        elapsed_minutes = (current_time - current_session.start_time).seconds / 60
        if elapsed_minutes <= 15:
            return None # Skip first 15m

        # 2. Entry Condition: Sweep
        current_candle = data_5m.iloc[-1]
        sweep_levels = [
            session_levels['asia_high'], session_levels['asia_low'],
            session_levels['prev_day_high'], session_levels['prev_day_low'],
            session_levels['orb_high'], session_levels['orb_low']
        ]
        
        swept_level = self._detect_sweep(current_candle, sweep_levels)
        if not swept_level:
            return None

        # 3. Confluence Check
        vp_levels = volume_profile.get_levels(data_15m) # VAH, VAL, POC
        ema_200 = data_5m['ema_200'].iloc[-1]
        confluence_levels = [vp_levels['VAH'], vp_levels['VAL'], vp_levels['POC'], ema_200]
        
        if not self._is_near_confluence(swept_level, confluence_levels):
            return None

        # 4. Confirmation (Engulfing & VA close)
        if not self._is_engulfing_reversal(data_5m) or not self._closes_inside_va(current_candle, vp_levels):
            return None

        # 5. CVD Absorption
        if not self._check_cvd_absorption(data_5m):
            return None

        return self._generate_signal(current_candle, vp_levels)

    def _detect_sweep(self, candle, levels):
        for level in levels:
            if candle['high'] >= level >= candle['low']:
                return level
        return None

    def _is_near_confluence(self, swept_level, confluence_levels):
        for level in confluence_levels:
            if abs(swept_level - level) / level <= self.confluence_tolerance:
                return True
        return False

    def _is_engulfing_reversal(self, data):
        # Checks if current 5m candle fully engulfs the previous sweep candle body
        curr, prev = data.iloc[-1], data.iloc[-2]
        return (curr['close'] > prev['open'] and curr['open'] < prev['close']) or \
               (curr['close'] < prev['open'] and curr['open'] > prev['close'])

    def _closes_inside_va(self, candle, vp_levels):
        return vp_levels['VAL'] <= candle['close'] <= vp_levels['VAH']

    def _check_cvd_absorption(self, data):
        prev_delta = data.iloc[-2]['cvd_delta']
        curr_delta = data.iloc[-1]['cvd_delta']
        if prev_delta * curr_delta < 0: return True # Flipped sign
        if abs(curr_delta) <= abs(prev_delta) * (1 - self.absorption_threshold): return True
        return False

    def _generate_signal(self, candle, vp_levels):
        direction = 'SHORT' if candle['close'] < candle['open'] else 'LONG'
        stop_loss = candle['high'] + self.stop_buffer if direction == 'SHORT' else candle['low'] - self.stop_buffer
        target_1 = vp_levels['POC']
        target_2 = vp_levels['VAL'] if direction == 'SHORT' else vp_levels['VAH']
        
        return {
            'type': 'MARKET',
            'direction': direction,
            'stop_loss': stop_loss,
            'targets': [{'price': target_1, 'size': 0.5}, {'price': target_2, 'size': 0.5}]
        }