"""
strategies/oes_4h_order_block_retest.py
"""
class OrderBlockRetest:
    def __init__(self, config):
        # Interpretation: "Strong move" = candle body is > 1.5x ATR.
        self.strong_move_atr_mult = config.get('strong_move_atr_mult', 1.5)
        # Interpretation: "Breaks structure" = close beyond the rolling 10-period swing high/low.
        self.structure_lookback = config.get('structure_lookback', 10)

    def identify_order_block(self, data_4h):
        # Scan for FVG and structure break
        for i in range(len(data_4h)-3, 0, -1):
            c1, c2, c3 = data_4h.iloc[i], data_4h.iloc[i+1], data_4h.iloc[i+2]
            fvg_bullish = c1['high'] < c3['low']
            fvg_bearish = c1['low'] > c3['high']
            
            if fvg_bullish and c2['close'] > data_4h['high'].iloc[i-self.structure_lookback:i].max():
                return {'type': 'BULLISH', 'high': c1['high'], 'low': c1['low']}
            elif fvg_bearish and c2['close'] < data_4h['low'].iloc[i-self.structure_lookback:i].min():
                return {'type': 'BEARISH', 'high': c1['high'], 'low': c1['low']}
        return None

    def evaluate(self, data_5m, data_4h, session_levels):
        ob = self.identify_order_block(data_4h)
        if not ob: return None

        candle = data_5m.iloc[-1]
        
        # Structure shift on 5m (closing beyond recent 5m pivot)
        recent_pivot_high = data_5m['high'].iloc[-5:-1].max()
        recent_pivot_low = data_5m['low'].iloc[-5:-1].min()

        if ob['type'] == 'BULLISH' and candle['low'] <= ob['high']: # Retest
            if candle['close'] > recent_pivot_high and candle['close'] > ob['high']: # Shift & Engulf out of zone
                return self._execute('LONG', ob, session_levels)

        if ob['type'] == 'BEARISH' and candle['high'] >= ob['low']:
            if candle['close'] < recent_pivot_low and candle['close'] < ob['low']:
                return self._execute('SHORT', ob, session_levels)

    def _execute(self, direction, ob, session_levels):
        buffer = 2 # pips/points
        sl = ob['low'] - buffer if direction == 'LONG' else ob['high'] + buffer
        
        target_2 = session_levels['session_high'] if direction == 'LONG' else session_levels['session_low']
        
        return {
            'direction': direction,
            'stop_loss': sl,
            'targets': [{'rr': 2.0, 'size': 0.5}, {'price': target_2, 'size': 0.5}]
        }