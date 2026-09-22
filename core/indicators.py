import pandas as pd
import numpy as np

# =====================================================================
# 1. EXPONENTIAL MOVING AVERAGES (EMA)
# =====================================================================

def calculate_emas(data: pd.DataFrame, column: str = 'close') -> pd.DataFrame:
    """Calculates 20, 50, 100, and 200 Exponential Moving Averages (EMAs)."""
    df = data.copy()
    df['ema_20'] = df[column].ewm(span=20, adjust=False).mean()
    df['ema_50'] = df[column].ewm(span=50, adjust=False).mean()
    df['ema_100'] = df[column].ewm(span=100, adjust=False).mean()
    df['ema_200'] = df[column].ewm(span=200, adjust=False).mean()
    return df

# =====================================================================
# 2. ANCHORED VWAP
# =====================================================================

def get_avwap(data: pd.DataFrame) -> pd.Series:
    """Calculates Volume Weighted Average Price (VWAP)."""
    typical_price = (data['high'] + data['low'] + data['close']) / 3
    if 'volume' in data.columns and (data['volume'] > 0).any():
        return (typical_price * data['volume']).rolling(20).sum() / data['volume'].rolling(20).sum()
    return typical_price.rolling(20).mean()

# =====================================================================
# 3. PREVIOUS DAILY & WEEKLY LEVELS (PDH/PDL & PWH/PWL)
# =====================================================================

def get_previous_higher_tf_levels(data: pd.DataFrame) -> dict:
    """
    Extracts Previous Daily and Weekly High, Low, and Close.
    Expects DataFrame indexed by DatetimeIndex in UTC.
    """
    if not isinstance(data.index, pd.DatetimeIndex):
        raise ValueError("DataFrame index must be a pandas DatetimeIndex.")

    # Resample to Daily OHLC
    daily = data.resample('1D').agg({
        'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'
    }).dropna()

    # Resample to Weekly OHLC (Monday start)
    weekly = data.resample('1W-MON').agg({
        'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'
    }).dropna()

    return {
        'pdh': float(daily.iloc[-2]['high']) if len(daily) >= 2 else None,
        'pdl': float(daily.iloc[-2]['low']) if len(daily) >= 2 else None,
        'pdc': float(daily.iloc[-2]['close']) if len(daily) >= 2 else None,
        'pwh': float(weekly.iloc[-2]['high']) if len(weekly) >= 2 else None,
        'pwl': float(weekly.iloc[-2]['low']) if len(weekly) >= 2 else None,
        'pwc': float(weekly.iloc[-2]['close']) if len(weekly) >= 2 else None,
    }

# =====================================================================
# 4. PIVOT POINTS
# =====================================================================

def get_pivot_points(high: float, low: float, close: float, pivot_type: str = "Traditional") -> dict:
    """Calculates Standard or Camarilla Pivot Points."""
    pivot_type = pivot_type.capitalize()
    p = (high + low + close) / 3.0
    
    if pivot_type == "Camarilla":
        r_range = high - low
        return {
            'P': round(p, 5),
            'R1': round(close + r_range * 1.1 / 12.0, 5),
            'S1': round(close - r_range * 1.1 / 12.0, 5),
            'R2': round(close + r_range * 1.1 / 6.0, 5),
            'S2': round(close - r_range * 1.1 / 6.0, 5),
            'R3': round(close + r_range * 1.1 / 4.0, 5),
            'S3': round(close - r_range * 1.1 / 4.0, 5)
        }
    else: # Traditional
        return {
            'P': round(p, 5),
            'R1': round((2 * p) - low, 5),
            'S1': round((2 * p) - high, 5),
            'R2': round(p + (high - low), 5),
            'S2': round(p - (high - low), 5),
            'R3': round(high + 2 * (p - low), 5),
            'S3': round(low - 2 * (high - p), 5)
        }

# =====================================================================
# 5. ASIA SESSION RANGE
# =====================================================================

def get_asia_session_range(data: pd.DataFrame, start_time: str = "00:00", end_time: str = "08:00") -> dict:
    """Extracts the High, Low, and Range of the Asian Session."""
    if not isinstance(data.index, pd.DatetimeIndex):
        return {'asia_high': None, 'asia_low': None, 'asia_range': None}

    asia_data = data.between_time(start_time, end_time)
    if asia_data.empty:
        return {'asia_high': None, 'asia_low': None, 'asia_range': None}

    asia_high = float(asia_data['high'].max())
    asia_low = float(asia_data['low'].min())
    return {
        'asia_high': asia_high,
        'asia_low': asia_low,
        'asia_range': asia_high - asia_low
    }

# =====================================================================
# 6. SESSION VOLUME PROFILE (POC, VAH, VAL)
# =====================================================================

def get_session_volume_profile(data: pd.DataFrame, bins: int = 50, value_area_pct: float = 0.70) -> dict:
    """
    Calculates Point of Control (POC), Value Area High (VAH), and Value Area Low (VAL).
    Defaults to calculating based on time-at-price if volume is unavailable (common for Deriv).
    """
    if data.empty:
        return {'poc': None, 'vah': None, 'val': None}
        
    prices = data['close']
    # Use real volume if available, otherwise assume tick/time equivalence
    vol = data['volume'] if 'volume' in data.columns and (data['volume'] > 0).any() else pd.Series(1, index=data.index)
    
    # Distribute into price bins
    hist, bin_edges = np.histogram(prices, bins=bins, weights=vol)
    
    # Find POC (bin with the most activity)
    poc_idx = np.argmax(hist)
    poc = float((bin_edges[poc_idx] + bin_edges[poc_idx + 1]) / 2.0)
    
    # Calculate Value Area (VAH & VAL)
    total_volume = np.sum(hist)
    target_volume = total_volume * value_area_pct
    
    current_volume = hist[poc_idx]
    lower_idx = poc_idx
    upper_idx = poc_idx
    
    while current_volume < target_volume and (lower_idx > 0 or upper_idx < bins - 1):
        lower_vol = hist[lower_idx - 1] if lower_idx > 0 else 0
        upper_vol = hist[upper_idx + 1] if upper_idx < bins - 1 else 0
        
        if lower_vol > upper_vol:
            lower_idx -= 1
            current_volume += lower_vol
        elif upper_vol > lower_vol:
            upper_idx += 1
            current_volume += upper_vol
        else:
            if lower_idx > 0: lower_idx -= 1
            if upper_idx < bins - 1: upper_idx += 1
            current_volume += (lower_vol + upper_vol)
            
    val = float(bin_edges[lower_idx])
    vah = float(bin_edges[upper_idx + 1])
    
    return {
        'poc': round(poc, 5),
        'vah': round(vah, 5),
        'val': round(val, 5)
    }