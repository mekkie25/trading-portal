"""
strategies/pdh_pdl_failed_breakout.py
Designed to run alongside strategies/orb_liquidity_sweep_reversal.py for overlap detection.
"""
from foundation import indicators

class LiquidityTrap:
    def __init__(self, config):
        self.atr_fraction = config.get('atr_fraction', 0.25)
        self.target_mode = config.get('target_mode', 'POC') # or 'OPPOSITE_VA'

    def evaluate(self, data_5m, session_levels):
        pdh, pdl = session_levels['prev_day_high'], session_levels['prev_day_low']
        candle = data_5m.iloc[-1]
        atr = indicators.get_atr(data_5m, period=14).iloc[-1]
        buffer = atr * self.atr_fraction

        # PDH Failed Breakout (Short Trigger)
        if pdh < candle['high'] <= (pdh + buffer) and candle['close'] < pdh:
            if self._check_cvd_injection(data_5m, side='SELLER'):
                return self._trigger(candle, 'SHORT', pdh, session_levels)

        # PDL Failed Breakout (Long Trigger)
        if pdl > candle['low'] >= (pdl - buffer) and candle['close'] > pdl:
            if self._check_cvd_injection(data_5m, side='BUYER'):
                return self._trigger(candle, 'LONG', pdl, session_levels)

        return None

    def _check_cvd_injection(self, data, side):
        # Interpretation: "Injection" defined as delta volume exceeding 1.5x the 10-period SMA of delta volume.
        current_delta = data.iloc[-1]['cvd_delta']
        avg_delta = data['cvd_delta'].rolling(10).mean().iloc[-1]
        
        if side == 'SELLER':
            return current_delta < 0 and abs(current_delta) > abs(avg_delta) * 1.5
        return current_delta > 0 and current_delta > avg_delta * 1.5

    def _trigger(self, candle, direction, structure_level, session_levels):
        sl = candle['high'] if direction == 'SHORT' else candle['low']
        target = session_levels['prev_day_poc'] if self.target_mode == 'POC' else (session_levels['prev_day_val'] if direction == 'SHORT' else session_levels['prev_day_vah'])
        
        return {
            'strategy': 'LIQUIDITY_TRAP',
            'direction': direction,
            'stop_loss': sl,
            'target': target
        }