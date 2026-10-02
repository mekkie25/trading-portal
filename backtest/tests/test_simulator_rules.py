"""
backtest/tests/test_simulator_rules.py
Unit tests verifying the TradeSimulator against synthetic price action:
- Stop Loss execution (single trade)
- Fixed R:R target execution
- Break-Even gating (only active when use_breakeven is True)
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

from core.session_config import GLOBAL_PARAMS
from backtest.simulator import TradeSimulator

@dataclass
class DummySignal:
    symbol: str = "US30"
    direction: str = "BUY"
    entry_price: float = 43000.0
    stop_loss: float = 42965.0
    take_profit: float = 43035.0
    take_profit_1: float = 43035.0
    take_profit_2: float = 43070.0
    strategy: str = "GRUBBER_KICK"
    trail_mode: str = "MOVE_TO_BE_80"

def test_sl_execution():
    GLOBAL_PARAMS.target_rr = 1.0
    GLOBAL_PARAMS.use_breakeven = False
    sim = TradeSimulator(starting_balance=1000.0)
    sig = DummySignal()
    t0 = datetime(2026, 9, 30, 8, 0, tzinfo=timezone.utc)
    sim.open_trade(sig, t0, adr_val=300.0, regime="NORMAL", ref_levels={})

    # Candle dips to 42950 (breaches SL of 42965)
    c1 = pd.Series({'time': '2026-09-30 08:05:00', 'open': 43000, 'high': 43010, 'low': 42950, 'close': 42960})
    sim.process_candle("US30", c1, pd.DataFrame())

    # Exactly 1 trade completed (single position, no twin legs)
    assert len(sim.completed_trades) == 1
    assert sim.completed_trades[0]["result"] == "LOSS"
    assert "trade_id" in sim.completed_trades[0]
    assert sim.balance < 1000.0

def test_fixed_rr_tp_execution():
    GLOBAL_PARAMS.target_rr = 1.0
    GLOBAL_PARAMS.use_breakeven = False
    sim = TradeSimulator(starting_balance=1000.0)
    sig = DummySignal()  # SL dist = 35 -> Fixed TP at 43035
    t0 = datetime(2026, 9, 30, 8, 0, tzinfo=timezone.utc)
    sim.open_trade(sig, t0, adr_val=300.0, regime="NORMAL", ref_levels={})

    # Candle rallies to 43040 (hits fixed TP of 43035)
    c1 = pd.Series({'time': '2026-09-30 08:05:00', 'open': 43000, 'high': 43040, 'low': 42990, 'close': 43035})
    sim.process_candle("US30", c1, pd.DataFrame())

    assert len(sim.completed_trades) == 1
    assert sim.completed_trades[0]["result"] == "WIN"
    assert sim.completed_trades[0]["exit_reason"] == "TP"
    assert len(sim.open_positions) == 0

def test_be_gating_behavior():
    # 1. When use_breakeven is False, stop should NOT move to entry
    GLOBAL_PARAMS.target_rr = 2.0
    GLOBAL_PARAMS.use_breakeven = False
    sim1 = TradeSimulator(starting_balance=1000.0)
    sig1 = DummySignal(take_profit=43070.0, take_profit_1=43070.0)
    t0 = datetime(2026, 9, 30, 8, 0, tzinfo=timezone.utc)
    sim1.open_trade(sig1, t0, adr_val=300.0, regime="NORMAL", ref_levels={})

    c1 = pd.Series({'time': '2026-09-30 08:05:00', 'open': 43000, 'high': 43065, 'low': 42990, 'close': 43060})
    sim1.process_candle("US30", c1, pd.DataFrame())
    assert sim1.open_positions[0]["is_be_moved"] is False

    # 2. When use_breakeven is True, stop DOES move to entry
    GLOBAL_PARAMS.use_breakeven = True
    sim2 = TradeSimulator(starting_balance=1000.0)
    sim2.open_trade(sig1, t0, adr_val=300.0, regime="NORMAL", ref_levels={})
    sim2.process_candle("US30", c1, pd.DataFrame())
    assert sim2.open_positions[0]["is_be_moved"] is True
    assert sim2.open_positions[0]["stop_loss"] == sim2.open_positions[0]["entry_price"]

def test_same_candle_collision_conservative_rule():
    GLOBAL_PARAMS.target_rr = 1.0
    GLOBAL_PARAMS.use_breakeven = False
    sim = TradeSimulator(starting_balance=1000.0)
    sig = DummySignal()
    t0 = datetime(2026, 9, 30, 8, 0, tzinfo=timezone.utc)
    sim.open_trade(sig, t0, adr_val=300.0, regime="NORMAL", ref_levels={})

    # Volatile candle touches BOTH SL (42965) and TP (43035)
    c_wild = pd.Series({'time': '2026-09-30 08:05:00', 'open': 43000, 'high': 43050, 'low': 42950, 'close': 43000})
    sim.process_candle("US30", c_wild, pd.DataFrame())

    # Conservative rule: SL must hit first, resulting in single LOSS
    assert len(sim.completed_trades) == 1
    assert sim.completed_trades[0]["exit_reason"] == "SL_CONSERVATIVE_COLLISION"
    assert sim.completed_trades[0]["result"] == "LOSS"

def test_eod_2100_sast_close():
    GLOBAL_PARAMS.target_rr = 1.0
    GLOBAL_PARAMS.use_breakeven = False
    sim = TradeSimulator(starting_balance=1000.0)
    sig = DummySignal()
    t0 = datetime(2026, 9, 30, 14, 0, tzinfo=timezone.utc)
    sim.open_trade(sig, t0, adr_val=300.0, regime="NORMAL", ref_levels={})

    # 19:00 UTC = 21:00 SAST
    c_eod = pd.Series({'time': '2026-09-30 19:00:00', 'open': 43010, 'high': 43020, 'low': 43005, 'close': 43015})
    sim.process_candle("US30", c_eod, pd.DataFrame())

    assert len(sim.completed_trades) == 1
    assert sim.completed_trades[0]["exit_reason"] == "EOD_LOCKDOWN"