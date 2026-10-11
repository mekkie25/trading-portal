"""
tests/test_live_backtest_parity.py
PROPOSED.

Verifies that the level builder produces identical values no matter
which feeder calls it:

  1. The BACKTEST feeder (bar_aggregator) keeps today's forming D1 bar
     in the DataFrame. The last row's close time is in the future.
  2. The LIVE feeder (fetch_ohlc_candles) drops the forming bar. The
     last row's close time is in the past.

Given the same underlying bars, build_session_levels must return the
same PDH, PDL, daily EQ, and pivots for both shapes.

Also verifies that a dict volume profile (produced by
core.indicators.get_session_volume_profile) is read correctly. The
previous getattr chain returned 0.0 on a dict, so POC/VAH/VAL were
silently zero in the backtest.
"""

import sys
import os
import pandas as pd
from datetime import datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from core.session_levels import (
    build_session_levels,
    _DAY_LEVELS_CACHE,
    _select_last_completed_d1_bar,
)


def _make_d1_bars_ending(now_utc):
    """
    Returns 5 D1 bars for the days before now_utc, styled the way cTrader
    emits them (open at 21:00 UTC, close 24h later).
    """
    bars = []
    for i in range(5, 0, -1):
        open_dt = (now_utc - pd.Timedelta(days=i)).replace(
            hour=21, minute=0, second=0, microsecond=0
        )
        bars.append({
            'time': open_dt.strftime("%Y-%m-%d %H:%M:%S"),
            'open': 43000.0 + i,
            'high': 43100.0 + i,
            'low': 42900.0 + i,
            'close': 43050.0 + i,
            'volume': 1000,
        })
    return pd.DataFrame(bars)


def _make_m5_bars(now_utc):
    """Two days of flat M5 bars so the Asia window has data."""
    rows = []
    for i in range(576):
        t = now_utc - pd.Timedelta(minutes=(576 - i) * 5)
        rows.append({
            'time': t.strftime("%Y-%m-%d %H:%M:%S"),
            'open': 43000.0,
            'high': 43010.0,
            'low': 42990.0,
            'close': 43000.0,
            'volume': 100,
        })
    return pd.DataFrame(rows)


class _FakeVPNode:
    poc_price = 43000.0
    value_area_high = 43020.0
    value_area_low = 42980.0


def test_select_last_completed_d1_bar():
    """The helper skips the forming bar and picks the last closed bar."""
    now_utc = datetime(2026, 10, 11, 15, 30, tzinfo=timezone.utc)
    df = pd.DataFrame([
        {'time': '2026-10-06 21:00:00', 'open': 1, 'high': 2, 'low': 0, 'close': 1, 'volume': 0},
        {'time': '2026-10-07 21:00:00', 'open': 2, 'high': 3, 'low': 1, 'close': 2, 'volume': 0},
        {'time': '2026-10-08 21:00:00', 'open': 3, 'high': 4, 'low': 2, 'close': 3, 'volume': 0},
        {'time': '2026-10-09 21:00:00', 'open': 4, 'high': 5, 'low': 3, 'close': 4, 'volume': 0},
        {'time': '2026-10-10 21:00:00', 'open': 5, 'high': 6, 'low': 4, 'close': 5, 'volume': 0},
    ])
    idx = _select_last_completed_d1_bar(df, now_utc)
    # The 2026-10-09 21:00 bar closes at 2026-10-10 21:00, which is before
    # now_utc. The 2026-10-10 21:00 bar closes at 2026-10-11 21:00, which
    # is after now_utc. So the helper should return index 3.
    assert idx == 3


def test_parity_live_vs_backtest_levels():
    """
    The backtest feeder keeps the forming bar; the live feeder drops it.
    Both must return the same levels for the same 'now'.
    """
    now_utc = datetime(2026, 10, 11, 15, 30, tzinfo=timezone.utc)
    d1_closed = _make_d1_bars_ending(now_utc)
    m5 = _make_m5_bars(now_utc)

    # Backtest feeder: today's forming bar is appended as the last row.
    forming_bar = pd.DataFrame([{
        'time': '2026-10-10 21:00:00',  # opens 2026-10-10 21:00, closes 2026-10-11 21:00
        'open': 43006.0,
        'high': 43060.0,
        'low': 42950.0,
        'close': 43020.0,
        'volume': 500,
    }])
    d1_backtest = pd.concat([d1_closed, forming_bar], ignore_index=True)

    # Live feeder: the forming bar was dropped.
    d1_live = d1_closed.copy()

    vp = _FakeVPNode()

    _DAY_LEVELS_CACHE.clear()
    lvl_backtest = build_session_levels(
        symbol="US30", m5_df=m5, d1_df=d1_backtest, vp_node=vp,
        frozen_orbs={}, as_of=now_utc, adr_val=100.0,
    )

    _DAY_LEVELS_CACHE.clear()
    lvl_live = build_session_levels(
        symbol="US30", m5_df=m5, d1_df=d1_live, vp_node=vp,
        frozen_orbs={}, as_of=now_utc, adr_val=100.0,
    )

    keys = ['pdh', 'pdl', 'daily_pivot', 'pivot_r1', 'pivot_s1',
            'pivot_r2', 'pivot_s2', 'daily_eq', 'asia_high', 'asia_low']
    for k in keys:
        assert abs(lvl_backtest[k] - lvl_live[k]) < 1e-6, (
            f"{k} differs between backtest ({lvl_backtest[k]}) and live "
            f"({lvl_live[k]}). Live is not reading yesterday's bar."
        )


def test_va_dict_is_read_correctly():
    """
    A dict VA (as produced by core.indicators) must yield real values,
    not zeros.
    """
    now_utc = datetime(2026, 10, 11, 15, 30, tzinfo=timezone.utc)
    d1 = _make_d1_bars_ending(now_utc)
    m5 = _make_m5_bars(now_utc)

    vp_dict = {'poc': 43000.0, 'vah': 43020.0, 'val': 42980.0, 'total_volume': 1234.0}

    _DAY_LEVELS_CACHE.clear()
    lvl = build_session_levels(
        symbol="US30", m5_df=m5, d1_df=d1, vp_node=vp_dict,
        frozen_orbs={}, as_of=now_utc, adr_val=100.0,
    )

    assert abs(lvl['poc'] - 43000.0) < 1e-6
    assert abs(lvl['vah'] - 43020.0) < 1e-6
    assert abs(lvl['val'] - 42980.0) < 1e-6


def test_va_dataclass_is_read_correctly():
    """The dataclass VA (from live's VolumeProfileNode) must also work."""
    now_utc = datetime(2026, 10, 11, 15, 30, tzinfo=timezone.utc)
    d1 = _make_d1_bars_ending(now_utc)
    m5 = _make_m5_bars(now_utc)

    vp = _FakeVPNode()

    _DAY_LEVELS_CACHE.clear()
    lvl = build_session_levels(
        symbol="US30", m5_df=m5, d1_df=d1, vp_node=vp,
        frozen_orbs={}, as_of=now_utc, adr_val=100.0,
    )

    assert abs(lvl['poc'] - 43000.0) < 1e-6
    assert abs(lvl['vah'] - 43020.0) < 1e-6
    assert abs(lvl['val'] - 42980.0) < 1e-6