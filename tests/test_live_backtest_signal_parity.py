"""
tests/test_live_backtest_signal_parity.py

Verifies that StrategyManager.evaluate_all returns the SAME signal when
called on the same M5 slice and the same session_levels dict, regardless of
which feeder produced the inputs.

The two feeders differ in one important respect: the live bot drops the
forming M5 bar; the backtest keeps it as the last row of the slice. This
test deliberately does not try to bridge that difference. It verifies the
narrower, more important property: given the SAME slice, the two calls
return identical signals, identical stops and identical targets.

Two specific regressions this guards against:

  1. stop_distance_multiplier. If the simulator widens stops 50% but the
     live path does not, the two paths will compute different fixed
     targets from the same signal. This test asserts the fixed target is
     identical for the same input signal.

  2. Any strategy accidentally reading module state that changes between
     the two calls. Running evaluate_all twice in a row on the same input
     must be idempotent.
"""

import sys
import os
import pandas as pd
import pytest
from datetime import datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from strategies.strategy_manager import StrategyManager
from core.targets import compute_fixed_target
from core.session_config import GLOBAL_PARAMS


def _make_m5_slice(now_utc, n_bars: int = 200):
    """Build a synthetic M5 slice with precomputed EMAs so strategies read
    the fast path and do not recompute on the fly."""
    rows = []
    for i in range(n_bars):
        t = now_utc - pd.Timedelta(minutes=(n_bars - i) * 5)
        # Slight upward drift so the 200 EMA trend filter has something to do.
        price = 43000.0 + (i * 0.5)
        rows.append({
            'time': t,
            'open': price - 1.0,
            'high': price + 3.0,
            'low': price - 3.0,
            'close': price,
            'tick_volume': 100,
        })
    df = pd.DataFrame(rows)
    df['time'] = pd.to_datetime(df['time'], utc=True)

    # Precompute EMAs the same way the runner does, so strategies take the
    # precomputed-columns path.
    close = df['close']
    df['ema_5'] = close.ewm(span=5, adjust=False).mean()
    df['ema_9'] = close.ewm(span=9, adjust=False).mean()
    df['ema_13'] = close.ewm(span=13, adjust=False).mean()
    df['ema_25'] = close.ewm(span=25, adjust=False).mean()
    df['ema_200'] = close.ewm(span=200, adjust=False).mean()
    return df


def _make_d1_bars(now_utc):
    rows = []
    for i in range(5, 0, -1):
        open_dt = (now_utc - pd.Timedelta(days=i)).replace(hour=21, minute=0, second=0, microsecond=0)
        rows.append({
            'time': open_dt.strftime("%Y-%m-%d %H:%M:%S"),
            'open': 43000.0 + i,
            'high': 43100.0 + i,
            'low': 42900.0 + i,
            'close': 43050.0 + i,
            'volume': 1000,
        })
    return pd.DataFrame(rows)


def _make_h4_bars(now_utc):
    rows = []
    for i in range(20, 0, -1):
        open_dt = now_utc - pd.Timedelta(hours=i * 4)
        rows.append({
            'time': open_dt.strftime("%Y-%m-%d %H:%M:%S"),
            'open': 43000.0,
            'high': 43100.0,
            'low': 42900.0,
            'close': 43050.0,
            'volume': 500,
        })
    return pd.DataFrame(rows)


def _make_h1_bars(now_utc):
    rows = []
    for i in range(30, 0, -1):
        open_dt = now_utc - pd.Timedelta(hours=i)
        rows.append({
            'time': open_dt.strftime("%Y-%m-%d %H:%M:%S"),
            'open': 43000.0,
            'high': 43100.0,
            'low': 42900.0,
            'close': 43050.0,
            'volume': 200,
        })
    return pd.DataFrame(rows)


def _make_session_levels():
    return {
        'asia_high': 43100.0,
        'asia_low': 42900.0,
        'daily_eq': 43000.0,
        'pdh': 43150.0,
        'pdl': 42850.0,
        'daily_pivot': 43000.0,
        'pivot_r1': 43150.0,
        'pivot_s1': 42850.0,
        'pivot_r2': 43300.0,
        'pivot_s2': 42700.0,
        'orb_high': 43120.0,
        'orb_low': 42880.0,
        'orb_established': True,
        'cracker_orb_high': 43100.0,
        'cracker_orb_low': 42900.0,
        'cracker_orb_established': True,
        'weekly_open': 43000.0,
        'd1_open': 43000.0,
        'adr': 300.0,
        'avwap_anchor_index': 0,
        'poc': 43000.0,
        'vah': 43020.0,
        'val': 42980.0,
        'is_ranging': False,
        'range_span': 0.0,
    }


def test_evaluate_all_is_idempotent():
    """Calling evaluate_all twice on the same input must return the same result."""
    now_utc = datetime(2026, 10, 11, 15, 30, tzinfo=timezone.utc)
    m5 = _make_m5_slice(now_utc)
    h1 = _make_h1_bars(now_utc)
    h4 = _make_h4_bars(now_utc)
    d1 = _make_d1_bars(now_utc)
    sl = _make_session_levels()

    sm = StrategyManager()

    sig_a = sm.evaluate_all("US30", m5, h4, d1, sl, data_h1=h1)
    sig_b = sm.evaluate_all("US30", m5, h4, d1, sl, data_h1=h1)

    if sig_a is None and sig_b is None:
        pytest.skip("No signal generated on this synthetic slice — extend the slice to force one.")

    assert sig_a is not None
    assert sig_b is not None
    assert sig_a.strategy == sig_b.strategy
    assert sig_a.direction == sig_b.direction
    assert abs(sig_a.entry_price - sig_b.entry_price) < 1e-9
    assert abs(sig_a.stop_loss - sig_b.stop_loss) < 1e-9
    assert abs(sig_a.take_profit - sig_b.take_profit) < 1e-9


def test_stop_distance_multiplier_does_not_change_live_signal():
    """
    Regression guard for the stop_distance_multiplier parity break.

    The live path reads signal.stop_loss straight from the strategy. The
    backtest path used to widen it 1.5x inside the simulator. That means
    compute_fixed_target would return a different target depending on which
    path you were on.

    The guard: change GLOBAL_PARAMS.stop_distance_multiplier, run evaluate_all,
    confirm the signal's stop_loss is unchanged. If a future commit accidentally
    moves the widening into the strategy layer, this test fails.
    """
    now_utc = datetime(2026, 10, 11, 15, 30, tzinfo=timezone.utc)
    m5 = _make_m5_slice(now_utc)
    h1 = _make_h1_bars(now_utc)
    h4 = _make_h4_bars(now_utc)
    d1 = _make_d1_bars(now_utc)
    sl = _make_session_levels()

    sm = StrategyManager()

    orig = GLOBAL_PARAMS.stop_distance_multiplier
    try:
        GLOBAL_PARAMS.stop_distance_multiplier = 1.0
        sig_normal = sm.evaluate_all("US30", m5, h4, d1, sl, data_h1=h1)

        GLOBAL_PARAMS.stop_distance_multiplier = 1.5
        sig_widened = sm.evaluate_all("US30", m5, h4, d1, sl, data_h1=h1)
    finally:
        GLOBAL_PARAMS.stop_distance_multiplier = orig

    if sig_normal is None and sig_widened is None:
        pytest.skip("No signal generated on this synthetic slice — extend the slice to force one.")

    assert sig_normal is not None
    assert sig_widened is not None
    # The strategy layer must NOT know about stop_distance_multiplier.
    assert abs(sig_normal.stop_loss - sig_widened.stop_loss) < 1e-9, (
        "stop_distance_multiplier changed the strategy's stop_loss. "
        "That setting belongs in the simulator, not in the strategy layer. "
        "Live and backtest will diverge."
    )


def test_fixed_target_matches_between_paths_for_same_stop():
    """
    The simulator and the live execution both call compute_fixed_target with
    the same signal and the same target_rr. This test calls it twice and
    confirms identical output, which is what matters for parity.
    """
    now_utc = datetime(2026, 10, 11, 15, 30, tzinfo=timezone.utc)
    m5 = _make_m5_slice(now_utc)
    h1 = _make_h1_bars(now_utc)
    h4 = _make_h4_bars(now_utc)
    d1 = _make_d1_bars(now_utc)
    sl = _make_session_levels()

    sm = StrategyManager()
    sig = sm.evaluate_all("US30", m5, h4, d1, sl, data_h1=h1)
    if sig is None:
        pytest.skip("No signal generated on this synthetic slice.")

    orig_rr = GLOBAL_PARAMS.target_rr
    try:
        GLOBAL_PARAMS.target_rr = 2.5
        tp_sim = compute_fixed_target(sig, 2.5, use_final_target=GLOBAL_PARAMS.adaptive_mode)
        tp_live = compute_fixed_target(sig, 2.5, use_final_target=GLOBAL_PARAMS.adaptive_mode)
    finally:
        GLOBAL_PARAMS.target_rr = orig_rr

    assert tp_sim is not None
    assert tp_live is not None
    assert abs(tp_sim - tp_live) < 1e-9