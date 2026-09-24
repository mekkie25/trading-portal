"""
Volume profile and local Point of Control (POC) helpers.
"""
import pandas as pd
import numpy as np

def get_levels(df: pd.DataFrame, bins: int = 30) -> dict:
    if df.empty or len(df) < 5:
        return {'POC': 0.0, 'VAH': 0.0, 'VAL': 0.0}
    
    price_min = df['low'].min()
    price_max = df['high'].max()
    if price_min == price_max:
        return {'POC': price_min, 'VAH': price_max, 'VAL': price_min}

    hist, bin_edges = np.histogram(df['close'], bins=bins, weights=df.get('tick_volume', None))
    poc_idx = np.argmax(hist)
    poc = float((bin_edges[poc_idx] + bin_edges[poc_idx + 1]) / 2.0)
    
    return {
        'POC': poc,
        'VAH': float(bin_edges[min(poc_idx + 4, len(bin_edges) - 1)]),
        'VAL': float(bin_edges[max(poc_idx - 4, 0)])
    }

def get_local_poc(df: pd.DataFrame) -> float:
    return get_levels(df)['POC']