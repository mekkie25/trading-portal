"""
backtest/tests/test_simulator_rules.py
Unit tests verifying the TradeSimulator against synthetic price action:
- Stop Loss execution (single trade)
- Fixed R:R target execution
- Break-Even gating (only active when use_breakeven is True)
- Conservative collision rule (SL hit first if both SL and TP breached in same candle)
- 21:00 SAST EOD close
- Daily trade cap blocks 3rd trade of SAST day (NEW)
- Min-lot gate rejects trade on small balance with large stop (NEW)
- EOD close happens even if there is no exact 21:00 candle (NEW)
- Candle touching both SL and TP gives a loss and is NOT labelled NOISE_STOPOUT_RECOVERED (NEW)
- USDJPY P&L is scaled to USD (NEW)
- GERMAN30 is refused with UNSUPPORTED_SYMBOL_NO_FX (NEW)
- close_all closes open positions with END_OF_DATA (NEW)
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
    # Verify it is not falsely labelled as recovered
    assert sim.completed_trades[0]["failure_reason"] != "NOISE_STOPOUT_RECOVERED"

# --- NEW TESTS ---

def test_daily_cap_blocks_third_trade():
    """NEW: Verifies daily trade quota blocks the 3rd trade on the same SAST date."""
    GLOBAL_PARAMS.max_daily_trades = 2
    sim = TradeSimulator(starting_balance=1000.0)
    sig = DummySignal()
    t1 = datetime(2026, 9, 30, 8, 0, tzinfo=timezone.utc)
    t2 = datetime(2026, 9, 30, 9, 0, tzinfo=timezone.utc)
    t3 = datetime(2026, 9, 30, 10, 0, tzinfo=timezone.utc)

    assert sim.open_trade(sig, t1, 300.0, "NORMAL", {}) is True
    assert sim.open_trade(sig, t2, 300.0, "NORMAL", {}) is True
    assert sim.open_trade(sig, t3, 300.0, "NORMAL", {}) is False
    assert sim.skip_summary().get("DAILY_CAP", 0) == 1

def test_min_lot_gate_rejects_on_small_balance():
    """NEW: Verifies min-lot risk gate rejects a trade on a tiny account with wide stop."""
    GLOBAL_PARAMS.min_lot_risk_tolerance = 1.5
    sim = TradeSimulator(starting_balance=10.0, risk_pct=1.0)  # $0.10 allowable risk
    # Stop distance = 100 points on US30 ($1/pt) -> 0.01 lots risks $1.00, which is 10x risk budget
    sig = DummySignal(symbol="US30", entry_price=43000.0, stop_loss=42900.0, take_profit=43100.0, take_profit_1=43100.0)
    t0 = datetime(2026, 9, 30, 8, 0, tzinfo=timezone.utc)

    assert sim.open_trade(sig, t0, 300.0, "NORMAL", {}) is False
    assert sim.skip_summary().get("MIN_LOT_TOO_RISKY", 0) == 1

def test_eod_close_without_exact_2100_candle():
    """NEW: Verifies EOD close happens on the first candle >= 21:00 SAST (19:00 UTC) even if 19:00 is skipped."""
    sim = TradeSimulator(starting_balance=1000.0)
    sig = DummySignal()
    t0 = datetime(2026, 9, 30, 14, 0, tzinfo=timezone.utc)
    sim.open_trade(sig, t0, 300.0, "NORMAL", {})

    # Candle arrives at 19:05 UTC (21:05 SAST)
    c_late = pd.Series({'time': '2026-09-30 19:05:00', 'open': 43010, 'high': 43020, 'low': 43005, 'close': 43015})
    sim.process_candle("US30", c_late, pd.DataFrame())

    assert len(sim.completed_trades) == 1
    assert sim.completed_trades[0]["exit_reason"] == "EOD_LOCKDOWN"

def test_usdjpy_pnl_in_usd_scale():
    """NEW: Verifies USDJPY P&L is converted from JPY to USD by dividing by price."""
    sim = TradeSimulator(starting_balance=1000.0)
    # USDJPY entry = 150.00, sl = 149.50, tp = 150.50
    sig = DummySignal(symbol="USDJPY", entry_price=150.00, stop_loss=149.50, take_profit=150.50, take_profit_1=150.50)
    t0 = datetime(2026, 9, 30, 8, 0, tzinfo=timezone.utc)
    sim.open_trade(sig, t0, 1.0, "NORMAL", {})

    # Hits TP at 150.50
    c1 = pd.Series({'time': '2026-09-30 08:05:00', 'open': 150.00, 'high': 150.60, 'low': 149.90, 'close': 150.50})
    sim.process_candle("USDJPY", c1, pd.DataFrame())

    assert len(sim.completed_trades) == 1
    trade = sim.completed_trades[0]
    assert trade["result"] == "WIN"
    # Profit in JPY would be ~10,000 JPY per lot; in USD it must be around $60 - $70, not thousands
    assert trade["money_pnl"] < 500.0

def test_german30_refused_no_fx():
    """NEW: Verifies GERMAN30 is refused because EURUSD history is not loaded."""
    sim = TradeSimulator(starting_balance=1000.0)
    sig = DummySignal(symbol="GERMAN30", entry_price=18000.0, stop_loss=17950.0, take_profit=18050.0, take_profit_1=18050.0)
    t0 = datetime(2026, 9, 30, 8, 0, tzinfo=timezone.utc)

    assert sim.open_trade(sig, t0, 200.0, "NORMAL", {}) is False
    assert sim.skip_summary().get("UNSUPPORTED_SYMBOL_NO_FX", 0) == 1

def test_close_all_closes_open_positions():
    """NEW: Verifies close_all closes in-flight trades at end of data."""
    sim = TradeSimulator(starting_balance=1000.0)
    sig = DummySignal()
    t0 = datetime(2026, 9, 30, 8, 0, tzinfo=timezone.utc)
    sim.open_trade(sig, t0, 300.0, "NORMAL", {})
    assert len(sim.open_positions) == 1

    last_candle = pd.Series({'time': '2026-09-30 18:00:00', 'open': 43010, 'high': 43020, 'low': 43000, 'close': 43015})
    sim.close_all("US30", last_candle)

    assert len(sim.open_positions) == 0
    assert len(sim.completed_trades) == 1
    assert sim.completed_trades[0]["exit_reason"] == "END_OF_DATA"