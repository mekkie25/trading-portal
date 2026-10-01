"""
backtest/tests/test_simulator_rules.py
Unit tests verifying the TradeSimulator against synthetic price action:
- Stop Loss execution
- Take Profit 1 & Smart-Link Break-Even arming
- Conservative collision rule (SL hit first if both SL and TP breached in same candle)
- 21:00 SAST EOD close
"""

import sys
import os
import pytest
import pandas as pd
from datetime import datetime, timezone
from dataclasses import dataclass

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../..')))

from backtest.simulator import TradeSimulator

@dataclass
class DummySignal:
    symbol: str = "US30"
    direction: str = "BUY"
    entry_price: float = 43000.0
    stop_loss: float = 42965.0
    take_profit: float = 43070.0
    take_profit_1: float = 43035.0
    take_profit_2: float = 43070.0
    strategy: str = "GRUBBER_KICK"
    trail_mode: str = "MOVE_TO_BE_80"

def test_sl_execution():
    sim = TradeSimulator(starting_balance=1000.0)
    sig = DummySignal()
    t0 = datetime(2026, 9, 30, 8, 0, tzinfo=timezone.utc)
    sim.open_trade(sig, t0, adr_val=300.0, regime="NORMAL", ref_levels={})

    # Candle dips to 42950 (breaches SL of 42965)
    c1 = pd.Series({'time': '2026-09-30 08:05:00', 'open': 43000, 'high': 43010, 'low': 42950, 'close': 42960})
    sim.process_candle("US30", c1, pd.DataFrame())

    assert len(sim.completed_trades) == 2
    assert all(t["result"] == "LOSS" for t in sim.completed_trades)
    assert sim.balance < 1000.0

def test_tp1_smart_link_be_no_false_stopout():
    sim = TradeSimulator(starting_balance=1000.0)
    sig = DummySignal()
    t0 = datetime(2026, 9, 30, 8, 0, tzinfo=timezone.utc)
    sim.open_trade(sig, t0, adr_val=300.0, regime="NORMAL", ref_levels={})

    # Candle 1: Dips to 42990, then rallies to 43040 (hits TP1 of 43035)
    c1 = pd.Series({'time': '2026-09-30 08:05:00', 'open': 43000, 'high': 43040, 'low': 42990, 'close': 43035})
    sim.process_candle("US30", c1, pd.DataFrame())

    # Leg A must be closed at profit
    assert len(sim.completed_trades) == 1
    assert sim.completed_trades[0]["leg"] == "A"
    assert sim.completed_trades[0]["result"] == "WIN"

    # Leg B must still be OPEN (not falsely stopped out on the same candle)
    assert len(sim.open_positions) == 1
    assert sim.open_positions[0]["leg"] == "B"

    # Candle 2: Now price falls back to entry (43000) -> Leg B exits at Break-Even
    c2 = pd.Series({'time': '2026-09-30 08:10:00', 'open': 43030, 'high': 43035, 'low': 42995, 'close': 43000})
    sim.process_candle("US30", c2, pd.DataFrame())

    assert len(sim.completed_trades) == 2
    assert sim.completed_trades[1]["leg"] == "B"
    assert sim.completed_trades[1]["result"] in ("WIN", "BREAKEVEN")

def test_same_candle_collision_conservative_rule():
    sim = TradeSimulator(starting_balance=1000.0)
    sig = DummySignal()
    t0 = datetime(2026, 9, 30, 8, 0, tzinfo=timezone.utc)
    sim.open_trade(sig, t0, adr_val=300.0, regime="NORMAL", ref_levels={})

    # Crazy volatile candle touches BOTH SL (42965) and TP1 (43035)
    c_wild = pd.Series({'time': '2026-09-30 08:05:00', 'open': 43000, 'high': 43050, 'low': 42950, 'close': 43000})
    sim.process_candle("US30", c_wild, pd.DataFrame())

    # Conservative rule: SL must hit first (-1R loss, not a win)
    assert len(sim.completed_trades) == 2
    assert all(t["exit_reason"] == "SL_CONSERVATIVE_COLLISION" for t in sim.completed_trades)

def test_eod_2100_sast_close():
    sim = TradeSimulator(starting_balance=1000.0)
    sig = DummySignal()
    t0 = datetime(2026, 9, 30, 14, 0, tzinfo=timezone.utc)
    sim.open_trade(sig, t0, adr_val=300.0, regime="NORMAL", ref_levels={})

    # 19:00 UTC = 21:00 SAST
    c_eod = pd.Series({'time': '2026-09-30 19:00:00', 'open': 43010, 'high': 43020, 'low': 43005, 'close': 43015})
    sim.process_candle("US30", c_eod, pd.DataFrame())

    assert len(sim.completed_trades) == 2
    assert all(t["exit_reason"] == "EOD_LOCKDOWN" for t in sim.completed_trades)