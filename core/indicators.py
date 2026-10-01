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
    typical_price = (df['high'] + df['low'] + df['close']) / 3.0
    vol = df['tick_volume'] if 'tick_volume' in df.columns else df.get('volume', pd.Series(1, index=df.index))
    vol = vol.replace(0, 1)

    if session_mask is not None:
        typical_price = typical_price.where(session_mask, 0)
        vol = vol.where(session_mask, 0)

    cum_vol = vol.cumsum()
    cum_pv = (typical_price * vol).cumsum()
    return cum_pv / (cum_vol + 1e-10)

def calculate_anchored_vwap(df: pd.DataFrame, anchor_index: int) -> pd.Series:
    """Anchors VWAP to a specific bar index (e.g. Start of Week, NFP bar, ATH)."""
    vwap = pd.Series(index=df.index, dtype=float)
    if anchor_index >= len(df) or anchor_index < 0:
        return calculate_session_vwap(df)

    sub_df = df.iloc[anchor_index:].copy()
    typical_price = (sub_df['high'] + sub_df['low'] + sub_df['close']) / 3.0
    vol = sub_df['tick_volume'] if 'tick_volume' in sub_df.columns else sub_df.get('volume', pd.Series(1, index=sub_df.index))
    vol = vol.replace(0, 1)

    cum_vol = vol.cumsum()
    cum_pv = (typical_price * vol).cumsum()
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
    """
    if value_area_pct is None:
        value_area_pct = GLOBAL_PARAMS.value_area_pct

    if df.empty or len(df) < 5:
        return {'poc': 0.0, 'vah': 0.0, 'val': 0.0, 'total_volume': 0.0}

    price_min = float(df['low'].min())
    price_max = float(df['high'].max())
    if price_min == price_max:
        return {'poc': price_min, 'vah': price_max, 'val': price_min, 'total_volume': 0.0}

    prices = (df['high'] + df['low'] + df['close']) / 3.0
    vol = df['tick_volume'] if 'tick_volume' in df.columns else df.get('volume', pd.Series(1, index=df.index))
    vol = vol.replace(0, 1)

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

    recent = df.tail(lookback).copy()
    vol = recent['tick_volume'] if 'tick_volume' in recent.columns else recent.get('volume', pd.Series(1, index=recent.index))
    c_range = recent['high'] - recent['low']
    c_range = c_range.replace(0, 1e-5)

    bar_bias = ((recent['close'] - recent['low']) / c_range - 0.5) * 2.0
    signed_vol = vol * bar_bias
    cum_delta = signed_vol.cumsum()

    last_vol = vol.iloc[-1]
    avg_vol = vol.iloc[:-1].mean()
    last_range = c_range.iloc[-1]
    avg_range = c_range.iloc[:-1].mean()

    volume_spike = last_vol > (avg_vol * 1.35)
    effort_vs_result = (last_vol / avg_vol) > (last_range / avg_range)

    last_bar = recent.iloc[-1]
    is_rejection_candle = (
        (last_bar['close'] > last_bar['open'] and (last_bar['open'] - last_bar['low']) > (last_range * 0.4)) or
        (last_bar['close'] < last_bar['open'] and (last_bar['high'] - last_bar['open']) > (last_range * 0.4))
    )

    absorption = bool(volume_spike and effort_vs_result and is_rejection_candle)
    direction = 'BULLISH_ABSORPTION' if last_bar['close'] > last_bar['open'] else 'BEARISH_ABSORPTION'

    return {
        'absorption_detected': absorption,
        'delta_direction': direction if absorption else ('POSITIVE' if cum_delta.iloc[-1] > 0 else 'NEGATIVE'),
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