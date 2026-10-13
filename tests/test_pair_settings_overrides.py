"""
tests/test_pair_settings_overrides.py
Verifies Step 3 override resolution.

1. An empty/default pair_settings gives the same result as the global.
2. A pair-level max_spread_in_r on EURUSD changes only EURUSD.
3. A strategy-level override beats the pair-level override.
4. blocked_hours_sast at pair level overrides the global map.
5. always_htf_enabled=false at strategy level disables the HTF check.
"""

import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from core.pair_settings import (
    default_settings,
    resolve_max_spread_in_r,
    resolve_always_htf_enabled,
    resolve_blocked_hours,
)


def test_default_falls_back_to_global_spread():
    s = default_settings()
    v = resolve_max_spread_in_r(s, "EURUSD", "STRATEGY_513", 0.05)
    assert v == 0.05


def test_pair_level_max_spread_wins_over_global():
    s = default_settings()
    s["pairs"]["EURUSD"]["max_spread_in_r"] = 0.20
    assert resolve_max_spread_in_r(s, "EURUSD", "STRATEGY_513", 0.05) == 0.20
    assert resolve_max_spread_in_r(s, "GBPUSD", "STRATEGY_513", 0.05) == 0.05


def test_strategy_level_beats_pair_level():
    s = default_settings()
    s["pairs"]["EURUSD"]["max_spread_in_r"] = 0.20
    s["pairs"]["EURUSD"]["strategies"]["STRATEGY_513"]["max_spread_in_r"] = 0.10
    assert resolve_max_spread_in_r(s, "EURUSD", "STRATEGY_513", 0.05) == 0.10
    assert resolve_max_spread_in_r(s, "EURUSD", "EMA_9_25_CROSS", 0.05) == 0.20


def test_pair_level_blocked_hours_override():
    s = default_settings()
    glob = {"EURUSD": [0, 23], "US30": [0, 23]}
    assert resolve_blocked_hours(s, "EURUSD", glob) == [0, 23]
    s["pairs"]["EURUSD"]["blocked_hours_sast"] = []
    assert resolve_blocked_hours(s, "EURUSD", glob) == []
    assert resolve_blocked_hours(s, "US30", glob) == [0, 23]


def test_always_htf_strategy_override():
    s = default_settings()
    glob = ["STRATEGY_513", "EMA_9_25_CROSS"]
    assert resolve_always_htf_enabled(s, "EURUSD", "STRATEGY_513", glob) is True
    assert resolve_always_htf_enabled(s, "EURUSD", "AVWAP_200EMA_CONTINUATION", glob) is False
    s["pairs"]["EURUSD"]["strategies"]["AVWAP_200EMA_CONTINUATION"]["always_htf_enabled"] = True
    assert resolve_always_htf_enabled(s, "EURUSD", "AVWAP_200EMA_CONTINUATION", glob) is True
    s["pairs"]["EURUSD"]["strategies"]["STRATEGY_513"]["always_htf_enabled"] = False
    assert resolve_always_htf_enabled(s, "EURUSD", "STRATEGY_513", glob) is False