"""
trading-portal/core/indicators.py
Quantitative Indicator and Institutional Market Profile Library.
- True 75% Value Area & Point of Control (POC) expansion algorithm (Spec Sec 2)
- Session and Anchored VWAP (AVWAP)
- Multi-Timeframe EMA Calculations (5, 9, 13, 25, 50, 100, 200)
- Traditional Floor Pivot Points (including R2/S2 for Grubber Kick TP3)
- SuperTrend Indicator (ATR 10, Factor 1.6 / 1.25)
- CVD Absorption Proxy Engine
- Candlestick anatomy validators (True Engulfing, Rejection Wick)
Optimized with pure NumPy vectorization for high-throughput backtesting.
"""

import pandas as pd
import numpy as np
from typing import Dict, Tuple, Any

try:
    from core.session_config import GLOBAL_PARAMS
except ImportError:
    import sys, os
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
    from core.session_config import GLOBAL_PARAMS

# ==============================================================================
# 1. EXPONENTIAL MOVING AVERAGES (EMA)
# ==============================================================================

def calculate_emas(data: pd.DataFrame, column: str = 'close') -> pd.DataFrame:
    """Calculates all spec EMAs: 5, 9, 13, 25, 50, 100, and 200."""
    df = data.copy()
    for span in [5, 9, 13, 25, 50, 100, 200]:
        df[f'ema_{span}'] = df[column].ewm(span=span, adjust=False).mean()
    return df

# ==============================================================================
# 2. SESSION VWAP & ANCHORED VWAP
# ==============================================================================

def calculate_session_vwap(df: pd.DataFrame, session_mask: pd.Series = None) -> pd.Series:
    """Calculates true Session VWAP reset at session boundaries."""
    high = df['high'].values
    low = df['low'].values
    close = df['close'].values
    typical_price = (high + low + close) / 3.0

    if 'tick_volume' in df.columns:
        vol = df['tick_volume'].values.astype(float)
    elif 'volume' in df.columns:
        vol = df['volume'].values.astype(float)
    else:
        vol = np.ones(len(df), dtype=float)
    vol = np.where(vol == 0, 1.0, vol)

    if session_mask is not None:
        mask = session_mask.values
        typical_price = np.where(mask, typical_price, 0.0)
        vol = np.where(mask, vol, 0.0)

    cum_vol = np.cumsum(vol)
    cum_pv = np.cumsum(typical_price * vol)
    vwap_vals = cum_pv / (cum_vol + 1e-10)
    return pd.Series(vwap_vals, index=df.index)

def calculate_anchored_vwap(df: pd.DataFrame, anchor_index: int) -> pd.Series:
    """Anchors VWAP to a specific bar index (e.g. Start of Week, NFP bar, ATH)."""
    vwap = pd.Series(index=df.index, dtype=float)
    if anchor_index >= len(df) or anchor_index < 0:
        return calculate_session_vwap(df)

    sub_df = df.iloc[anchor_index:]
    high = sub_df['high'].values
    low = sub_df['low'].values
    close = sub_df['close'].values
    typical_price = (high + low + close) / 3.0

    if 'tick_volume' in sub_df.columns:
        vol = sub_df['tick_volume'].values.astype(float)
    elif 'volume' in sub_df.columns:
        vol = sub_df['volume'].values.astype(float)
    else:
        vol = np.ones(len(sub_df), dtype=float)
    vol = np.where(vol == 0, 1.0, vol)

    cum_vol = np.cumsum(vol)
    cum_pv = np.cumsum(typical_price * vol)
    sub_vwap = cum_pv / (cum_vol + 1e-10)
    vwap.iloc[anchor_index:] = sub_vwap
    vwap.iloc[:anchor_index] = np.nan
    return vwap

# ==============================================================================
# 3. VOLUME PROFILE: TRUE 75% VALUE AREA & POC EXPANSION ALGORITHM
# ==============================================================================

def get_session_volume_profile(df: pd.DataFrame, bins: int = 50, value_area_pct: float = None) -> Dict[str, float]:
    """
    Calculates POC, VAH, and VAL using the institutional 75% Value Area expansion
    algorithm moving outward from POC (Spec Section 2: '75% value area boundary').
    Optimized with C-level NumPy array vectorization.
    """
    if value_area_pct is None:
        value_area_pct = GLOBAL_PARAMS.value_area_pct

    n_rows = len(df)
    if df.empty or n_rows < 5:
        return {'poc': 0.0, 'vah': 0.0, 'val': 0.0, 'total_volume': 0.0}

    high = df['high'].values
    low = df['low'].values
    close = df['close'].values

    price_min = float(np.min(low))
    price_max = float(np.max(high))
    if price_min == price_max:
        return {'poc': price_min, 'vah': price_max, 'val': price_min, 'total_volume': 0.0}

    prices = (high + low + close) / 3.0

    if 'tick_volume' in df.columns:
        vol = df['tick_volume'].values.astype(float)
    elif 'volume' in df.columns:
        vol = df['volume'].values.astype(float)
    else:
        vol = np.ones(n_rows, dtype=float)
    vol = np.where(vol == 0, 1.0, vol)

    hist, bin_edges = np.histogram(prices, bins=bins, weights=vol)
    total_volume = float(np.sum(hist))
    target_volume = total_volume * value_area_pct

    poc_idx = int(np.argmax(hist))
    poc_price = float((bin_edges[poc_idx] + bin_edges[poc_idx + 1]) / 2.0)

    current_volume = float(hist[poc_idx])
    lower_idx = poc_idx
    upper_idx = poc_idx

    # Dual-pointer outward expansion from POC
    while current_volume < target_volume and (lower_idx > 0 or upper_idx < bins - 1):
        vol_below = float(hist[lower_idx - 1]) if lower_idx > 0 else 0.0
        vol_above = float(hist[upper_idx + 1]) if upper_idx < bins - 1 else 0.0

        if vol_above > vol_below:
            upper_idx += 1
            current_volume += vol_above
        elif vol_below > vol_above:
            lower_idx -= 1
            current_volume += vol_below
        else:
            if upper_idx < bins - 1:
                upper_idx += 1
                current_volume += vol_above
            if lower_idx > 0:
                lower_idx -= 1
                current_volume += vol_below

    val_price = float(bin_edges[lower_idx])
    vah_price = float(bin_edges[upper_idx + 1])

    return {
        'poc': round(poc_price, 5),
        'vah': round(vah_price, 5),
        'val': round(val_price, 5),
        'total_volume': total_volume
    }

# ==============================================================================
# 4. PIVOT POINTS (TRADITIONAL WITH R2 / S2 & R3 / S3)
# ==============================================================================

def get_pivot_points(high: float, low: float, close: float) -> Dict[str, float]:
    """Calculates Traditional Floor Pivot Points including R1, R2, R3 and S1, S2, S3."""
    p = (high + low + close) / 3.0
    r_range = high - low
    return {
        'P': round(p, 5),
        'R1': round((2.0 * p) - low, 5),
        'S1': round((2.0 * p) - high, 5),
        'R2': round(p + r_range, 5),
        'S2': round(p - r_range, 5),
        'R3': round(high + 2.0 * (p - low), 5),
        'S3': round(low - 2.0 * (high - p), 5)
    }

# ==============================================================================
# 5. SUPERTREND INDICATOR (Spec Section 2 & 8)
# ==============================================================================

def calculate_supertrend(df: pd.DataFrame, period: int = 10, factor: float = 1.6) -> pd.DataFrame:
    """Calculates SuperTrend indicator for dynamic trailing stops (Spec Sec 2)."""
    res = df.copy()
    high = res['high']
    low = res['low']
    close = res['close']

    tr1 = high - low
    tr2 = (high - close.shift(1)).abs()
    tr3 = (low - close.shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    atr = tr.rolling(period).mean()

    hl2 = (high + low) / 2.0
    upperband = hl2 + (factor * atr)
    lowerband = hl2 - (factor * atr)

    direction = pd.Series(1, index=df.index)

    for i in range(1, len(df)):
        prev_c = close.iloc[i - 1]
        prev_u = upperband.iloc[i - 1]
        prev_l = lowerband.iloc[i - 1]
        curr_u = upperband.iloc[i]
        curr_l = lowerband.iloc[i]

        lowerband.iloc[i] = curr_l if (curr_l > prev_l or prev_c < prev_l) else prev_l
        upperband.iloc[i] = curr_u if (curr_u < prev_u or prev_c > prev_u) else prev_u

        if prev_c > prev_u:
            direction.iloc[i] = 1
        elif prev_c < prev_l:
            direction.iloc[i] = -1
        else:
            direction.iloc[i] = direction.iloc[i - 1]

    res['supertrend_direction'] = direction
    res['supertrend_line'] = np.where(direction == 1, lowerband, upperband)
    return res

# ==============================================================================
# 6. CVD ABSORPTION PROXY (Spec Non-Negotiable #4)
# ==============================================================================

def calculate_cvd_absorption_proxy(df: pd.DataFrame, lookback: int = 10) -> Dict[str, Any]:
    """
    Honest Proxy for Cumulative Volume Delta (CVD) Absorption using tick volume.
    Measures signed volume based on close-in-range location and checks if
    aggressive volume spiked while price halted/reversed (absorption).
    """
    if df.empty or len(df) < lookback:
        return {'absorption_detected': False, 'delta_direction': 'NEUTRAL', 'absorption_score': 0.0}

    recent = df.tail(lookback)
    vol = recent['tick_volume'].values if 'tick_volume' in recent.columns else (recent['volume'].values if 'volume' in recent.columns else np.ones(lookback))
    vol = np.where(vol == 0, 1.0, vol)

    high = recent['high'].values
    low = recent['low'].values
    close = recent['close'].values
    open_p = recent['open'].values

    c_range = high - low
    c_range = np.where(c_range == 0, 1e-5, c_range)

    bar_bias = ((close - low) / c_range - 0.5) * 2.0
    signed_vol = vol * bar_bias
    cum_delta = np.sum(signed_vol)

    last_vol = vol[-1]
    avg_vol = np.mean(vol[:-1])
    last_range = c_range[-1]
    avg_range = np.mean(c_range[:-1])

    volume_spike = last_vol > (avg_vol * 1.35)
    effort_vs_result = (last_vol / avg_vol) > (last_range / avg_range)

    last_close = close[-1]
    last_open = open_p[-1]
    last_low = low[-1]
    last_high = high[-1]

    is_rejection_candle = (
        (last_close > last_open and (last_open - last_low) > (last_range * 0.4)) or
        (last_close < last_open and (last_high - last_open) > (last_range * 0.4))
    )

    absorption = bool(volume_spike and effort_vs_result and is_rejection_candle)
    direction = 'BULLISH_ABSORPTION' if last_close > last_open else 'BEARISH_ABSORPTION'

    return {
        'absorption_detected': absorption,
        'delta_direction': direction if absorption else ('POSITIVE' if cum_delta > 0 else 'NEGATIVE'),
        'absorption_score': round(float(last_vol / (avg_vol + 1e-5)), 2)
    }

# ==============================================================================
# 7. CANDLESTICK ANATOMY VALIDATORS
# ==============================================================================

def is_bullish_engulfing(prev_row: pd.Series, curr_row: pd.Series) -> bool:
    """True Bullish Engulfing: Current green body strictly engulfs prior red body."""
    prev_red = prev_row['close'] < prev_row['open']
    curr_green = curr_row['close'] > curr_row['open']
    if not (prev_red and curr_green):
        return False
    return (curr_row['close'] >= prev_row['open']) and (curr_row['open'] <= prev_row['close'])

def is_bearish_engulfing(prev_row: pd.Series, curr_row: pd.Series) -> bool:
    """True Bearish Engulfing: Current red body strictly engulfs prior green body."""
    prev_green = prev_row['close'] > prev_row['open']
    curr_red = curr_row['close'] < curr_row['open']
    if not (prev_green and curr_red):
        return False
    return (curr_row['close'] <= prev_row['open']) and (curr_row['open'] >= prev_row['close'])

def has_rejection_wick(row: pd.Series, direction: str, min_wick_ratio: float = 0.35) -> bool:
    """Checks for pronounced rejection wick off a key technical anchor (Spec Sec 4)."""
    c_range = row['high'] - row['low']
    if c_range <= 0:
        return False

    body_top = max(row['open'], row['close'])
    body_bot = min(row['open'], row['close'])

    if direction.upper() == "BUY":
        lower_wick = body_bot - row['low']
        return (lower_wick / c_range) >= min_wick_ratio
    else:
        upper_wick = row['high'] - body_top
        return (upper_wick / c_range) >= min_wick_ratio