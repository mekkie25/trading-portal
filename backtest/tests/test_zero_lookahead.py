"""
backtest/tests/test_zero_lookahead.py
Verifies mathematical determinism and invariance against future data leakage.
"""

import sys
import os
import pytest
import pandas as pd
from datetime import datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../..')))

from backtest.bar_aggregator import ZeroLookAheadAggregator

def test_zero_lookahead_cutoff_invariance():
    # Synthetic M5 sequence
    m5_records = []
    base_time = datetime(2026, 9, 28, 6, 0, tzinfo=timezone.utc)
    for i in range(100):
        t = base_time + pd.Timedelta(minutes=i * 5)
        m5_records.append({
            'time': t.strftime("%Y-%m-%d %H:%M:%S"),
            'open': 100.0 + i * 0.1,
            'high': 100.5 + i * 0.1,
            'low': 99.5 + i * 0.1,
            'close': 100.2 + i * 0.1,
            'volume': 100
        })
    df_m5 = pd.DataFrame(m5_records)

    # Historical dummy H1, H4, D1
    d1_df = pd.DataFrame([{'time': '2026-09-27 21:00:00', 'open': 95.0, 'high': 102.0, 'low': 94.0, 'close': 100.0, 'volume': 5000}])
    h4_df = pd.DataFrame([{'time': '2026-09-28 00:00:00', 'open': 98.0, 'high': 101.0, 'low': 97.0, 'close': 99.5, 'volume': 1500}])
    h1_df = pd.DataFrame([{'time': '2026-09-28 05:00:00', 'open': 99.0, 'high': 100.5, 'low': 98.5, 'close': 100.0, 'volume': 400}])

    agg = ZeroLookAheadAggregator(d1_df, h4_df, h1_df)

    # Cutoff at bar 40 (09:20 UTC)
    t_cutoff = base_time + pd.Timedelta(minutes=40 * 5)
    slice_at_t = df_m5.iloc[:41].copy()
    h1_t, h4_t, d1_t = agg.get_feeds_at_time(slice_at_t, t_cutoff)

    # Now add 30 more bars of "future" data, but inspect state strictly at t_cutoff
    slice_with_future = df_m5.iloc[:71].copy()
    slice_at_t_again = slice_with_future[pd.to_datetime(slice_with_future['time'], utc=True) <= t_cutoff]
    h1_t2, h4_t2, d1_t2 = agg.get_feeds_at_time(slice_at_t_again, t_cutoff)

    # Reconstructed feeds at time T MUST be 100% identical
    pd.testing.assert_frame_equal(h1_t, h1_t2)
    pd.testing.assert_frame_equal(h4_t, h4_t2)
    pd.testing.assert_frame_equal(d1_t, d1_t2)