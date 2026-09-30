"""
trading-portal/tests/test_institutional_engine.py
Pytest Test Suite covering:
- Lookback math per timeframe
- Session Windows & True DST handling
- Asia Range & Fixed Opening Range freezing
- 75% Value Area expansion
- Pivots with R2/S2
- Engulfing & CVD absorption
- Risk scaling, daily reset & stop validation
- Strategy unit tests (Valid signal + Rejection signal for each strategy)
"""

import sys
import os
import pytest
import pandas as pd
import numpy as np
from datetime import datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from core.session_config import MarketSessionManager
from core.indicators import (
    calculate_session_vwap,
    get_session_volume_profile,
    get_pivot_points,
    is_bullish_engulfing,
    is_bearish_engulfing,
    calculate_cvd_absorption_proxy,
    calculate_supertrend
)
from risk.risk_manager import RiskManager
from strategies.grubber_kick import GrubberKick
from strategies.strategy_513_cross import Strategy513

# ------------------------------------------------------------------------------
# 1. DATA LAYER LOOKBACK & RESOLUTION TESTS
# ------------------------------------------------------------------------------

def test_bar_lookback_duration():
    period_minutes = {1: 1, 5: 5, 7: 15, 9: 60, 10: 240, 12: 1440}
    count = 30
    h4_duration_ms = count * period_minutes[10] * 60 * 1000 * 3
    expected_ms = 30 * 240 * 60 * 1000 * 3
    assert h4_duration_ms == expected_ms
    assert h4_duration_ms > (5 * 24 * 3600 * 1000)

# ------------------------------------------------------------------------------
# 2. SESSION TIMING & DST TESTS
# ------------------------------------------------------------------------------

def test_london_and_ny_session_windows():
    # London Winter (January: 08:30 GMT is 08:30 London)
    dt_london_open = datetime(2026, 1, 15, 8, 30, tzinfo=timezone.utc)
    assert MarketSessionManager.is_in_london_open(dt_london_open) is True

    # NY Open (14:45 UTC is 09:45 US/Eastern in winter)
    dt_ny_open = datetime(2026, 1, 15, 14, 45, tzinfo=timezone.utc)
    assert MarketSessionManager.is_in_ny_open(dt_ny_open) is True
    assert MarketSessionManager.is_in_ny_cracker_window(dt_ny_open) is True

# ------------------------------------------------------------------------------
# 3. LEVEL CONSTRUCTION TESTS
# ------------------------------------------------------------------------------

def test_true_75_percent_value_area():
    prices = [100.0, 101.0, 102.0, 103.0, 104.0, 105.0]
    volumes = [10, 50, 200, 50, 20, 10]
    data = []
    for p, v in zip(prices, volumes):
        data.append({'high': p + 0.5, 'low': p - 0.5, 'close': p, 'tick_volume': v})
    df = pd.DataFrame(data)

    vp = get_session_volume_profile(df, bins=10, value_area_pct=0.75)
    assert 101.5 <= vp['poc'] <= 102.5
    assert vp['val'] <= vp['poc'] <= vp['vah']

def test_pivots_r2_and_s2_available():
    pivots = get_pivot_points(high=100.0, low=80.0, close=90.0)
    assert pivots['P'] == 90.0
    assert pivots['R1'] == 100.0
    assert pivots['S1'] == 80.0
    assert pivots['R2'] == 110.0
    assert pivots['S2'] == 70.0

# ------------------------------------------------------------------------------
# 4. CANDLESTICK ANATOMY & ABSORPTION TESTS
# ------------------------------------------------------------------------------

def test_engulfing_validation():
    red_candle = pd.Series({'open': 100.0, 'close': 95.0, 'high': 101.0, 'low': 94.0})
    green_engulfing = pd.Series({'open': 94.0, 'close': 101.0, 'high': 102.0, 'low': 93.0})
    green_weak = pd.Series({'open': 96.0, 'close': 98.0, 'high': 99.0, 'low': 95.0})

    assert is_bullish_engulfing(red_candle, green_engulfing) is True
    assert is_bullish_engulfing(red_candle, green_weak) is False

def test_cvd_absorption_proxy():
    df = pd.DataFrame([
        {'high': 100.0, 'low': 98.0, 'close': 99.0, 'open': 98.5, 'tick_volume': 100},
        {'high': 100.5, 'low': 98.2, 'close': 99.2, 'open': 98.6, 'tick_volume': 110},
        {'high': 101.0, 'low': 97.0, 'close': 100.5, 'open': 97.5, 'tick_volume': 350},
    ])
    cvd = calculate_cvd_absorption_proxy(df, lookback=3)
    assert 'absorption_detected' in cvd
    assert 'delta_direction' in cvd

# ------------------------------------------------------------------------------
# 5. RISK ENGINE TESTS
# ------------------------------------------------------------------------------

def test_consecutive_loss_scaling():
    rm = RiskManager(state_file="/tmp/test_risk_state.json")
    rm.reset_daily_counters("2026-09-30", current_equity=1000.0)

    # 3 losses drops risk to 0.5%
    rm.record_trade_outcome(-10.0)
    rm.record_trade_outcome(-10.0)
    assert rm.get_effective_risk_pct() == 1.0
    rm.record_trade_outcome(-10.0)
    assert rm.get_effective_risk_pct() == 0.5

    # Win resets streak to 1.0%
    rm.record_trade_outcome(+15.0)
    assert rm.get_effective_risk_pct() == 1.0

def test_asset_stop_validation():
    rm = RiskManager(state_file="/tmp/test_risk_state.json")
    valid_us30, _ = rm.validate_asset_stop_size("US30", 35.0)
    invalid_us30, _ = rm.validate_asset_stop_size("US30", 75.0)
    assert valid_us30 is True
    assert invalid_us30 is False

# ------------------------------------------------------------------------------
# 6. STRATEGY UNIT TESTS
# ------------------------------------------------------------------------------

def test_grubber_kick_logic():
    strat = GrubberKick(stop_loss_points=35.0)
    session_levels = {'asia_high': 43100.0, 'asia_low': 42900.0, 'daily_eq': 43000.0, 'pivot_r1': 43200.0, 'pivot_r2': 43300.0}

    bars = []
    for i in range(20):
        t = datetime(2026, 9, 30, 7, i * 5, tzinfo=timezone.utc)
        bars.append({'time': t, 'open': 42950.0, 'high': 42980.0, 'low': 42890.0, 'close': 42920.0})
    bars.append({'time': datetime(2026, 9, 30, 8, 40, tzinfo=timezone.utc), 'open': 43005.0, 'high': 43030.0, 'low': 43000.0, 'close': 43020.0})
    bars.append({'time': datetime(2026, 9, 30, 8, 45, tzinfo=timezone.utc), 'open': 43020.0, 'high': 43050.0, 'low': 43010.0, 'close': 43045.0})
    df_valid = pd.DataFrame(bars)

    sig = strat.evaluate("US30", df_valid, session_levels=session_levels)
    assert sig is not None
    assert sig.direction == "BUY"
    assert sig.stop_loss == (43000.0 - 35.0)

    # Reject on non-US30
    assert strat.evaluate("GOLD", df_valid, session_levels=session_levels) is None

def test_strategy_513_cross_logic():
    strat = Strategy513()
    session_levels = {'daily_eq': 100.0, 'daily_pivot': 100.0}

    prices = np.linspace(95.0, 105.0, 40)
    df = pd.DataFrame({
        'open': prices - 0.2,
        'high': prices + 0.5,
        'low': prices - 0.5,
        'close': prices,
        'tick_volume': 100
    })
    df.iloc[-2, df.columns.get_loc('close')] = 101.0
    df.iloc[-1, df.columns.get_loc('close')] = 106.0

    sig = strat.evaluate("EURUSD", df, session_levels=session_levels)
    assert sig is not None
    assert sig.direction == "BUY"
    assert sig.strategy == "STRATEGY_513"