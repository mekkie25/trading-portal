"""
strategies/avwap_200ema_trend_continuation.py
"""
from foundation import indicators, volume_profile

class AVWAPTrendContinuation:
    def __init__(self, config):
        self.anchor_type = config.get('avwap_anchor', 'start_of_week')
        self.tf_level = config.get('ema_timeframe', '15m') # 15m or 1H
        self.exit_mode = config.get('exit_mode', 'fixed_rr') # fixed_rr or supertrend_trail
        
        # Interpretation: "Several consecutive closes clustering" defined as 3 candles closing within 0.15% of the POC.
        self.vp_cluster_count = 3
        self.vp_cluster_tolerance = 0.0015 

    def get_daily_trend(self, data_daily):
        # Swappable trend bias function
        current_price = data_daily['close'].iloc[-1]
        ema_200 = data_daily['ema_200'].iloc[-1]
        return 'BULLISH' if current_price > ema_200 else 'BEARISH'

    def evaluate(self, data_5m, data_higher, data_daily):
        trend = self.get_daily_trend(data_daily)
        
        avwap = indicators.get_avwap(data_5m, anchor=self.anchor_type)
        ema_200_htf = data_higher['ema_200'].iloc[-1]
        
        level = avwap if abs(data_5m['close'].iloc[-1] - avwap) < abs(data_5m['close'].iloc[-1] - ema_200_htf) else ema_200_htf

        if not self._is_pullback_and_rejection(data_5m, level, trend):
            return None
            
        if not self._check_vp_acceptance(data_5m, level):
            return None

        return self._generate_execution(data_5m, level, trend)

    def _is_pullback_and_rejection(self, data_5m, level, trend):
        candle = data_5m.iloc[-1]
        # Check for rejection wick crossing the level and closing on the trend side
        if trend == 'BULLISH':
            return candle['low'] <= level and candle['close'] > level
        else:
            return candle['high'] >= level and candle['close'] < level

    def _check_vp_acceptance(self, data_5m, level):
        recent_closes = data_5m['close'].iloc[-self.vp_cluster_count:]
        poc = volume_profile.get_local_poc(data_5m)
        return all(abs(c - poc)/poc <= self.vp_cluster_tolerance for c in recent_closes)

    def _generate_execution(self, data, level, trend):
        direction = 'LONG' if trend == 'BULLISH' else 'SHORT'
        stop_loss = level * 0.999 if direction == 'LONG' else level * 1.001
        
        return {
            'direction': direction,
            'stop_loss': stop_loss,
            'exit_mode': self.exit_mode,
            'breakeven_at': 0.80 # Shared risk manager rule
        }
    