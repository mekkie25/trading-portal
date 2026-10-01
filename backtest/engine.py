"""
backtest/engine.py
Complete Historical Replay & Simulation Engine.
Steps through closed M5 bars, generates signals, runs trade simulation (twin legs, BE, EOD),
and outputs CSV/JSON logs.
"""

import sys
import os
import argparse
import pandas as pd
from datetime import datetime, timezone
from typing import Dict, Any

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from strategies.strategy_manager import StrategyManager
from core.session_levels import build_session_levels
from core.indicators import get_session_volume_profile
from core.volatility_engine import volatility_engine
from core.session_config import GLOBAL_PARAMS
from backtest.bar_aggregator import ZeroLookAheadAggregator
from backtest.simulator import TradeSimulator
from backtest.logger import AuditLogger

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

def load_data(symbol: str):
    m5 = pd.read_csv(os.path.join(DATA_DIR, f"{symbol}_M5.csv"))
    h1 = pd.read_csv(os.path.join(DATA_DIR, f"{symbol}_H1.csv"))
    h4 = pd.read_csv(os.path.join(DATA_DIR, f"{symbol}_H4.csv"))
    d1 = pd.read_csv(os.path.join(DATA_DIR, f"{symbol}_D1.csv"))
    return m5, h1, h4, d1

def run_simulation(symbol: str = "US30", adaptive_mode: bool = True, balance: float = 1000.0, risk_pct: float = 1.0):
    mode_str = "ADAPTIVE" if adaptive_mode else "LEGACY"
    print("=" * 75)
    print(f"STARTING SIMULATION: {symbol} | Mode: {mode_str} | Start Balance: ${balance:,.2f}")
    print("=" * 75)

    GLOBAL_PARAMS.adaptive_mode = adaptive_mode

    m5_df, h1_df, h4_df, d1_df = load_data(symbol)
    aggregator = ZeroLookAheadAggregator(d1_df, h4_df, h1_df)
    sm = StrategyManager()
    sim = TradeSimulator(starting_balance=balance, risk_pct=risk_pct)
    logger = AuditLogger(run_label=f"{symbol}_{mode_str.lower()}")

    frozen_orbs: Dict[Any, Any] = {}
    total_bars = len(m5_df)
    start_idx = 120

    print(f"[*] Stepping through {total_bars - start_idx:,} M5 bars...")

    for i in range(start_idx, total_bars):
        m5_slice = m5_df.iloc[max(0, i - 120):i + 1].copy().reset_index(drop=True)
        curr_bar = m5_slice.iloc[-1]
        curr_time = pd.to_datetime(curr_bar['time'], utc=True).to_pydatetime()

        # 1. Update in-flight trades against current bar
        sim.process_candle(symbol, curr_bar, m5_slice)

        # 2. Rebuild H1, H4, D1 without look-ahead
        h1_view, h4_view, d1_view = aggregator.get_feeds_at_time(m5_slice, curr_time)

        # 3. Compute volatility metrics
        adr_val = None
        regime = "NORMAL"
        vol_metrics = {"valid": False}
        if adaptive_mode:
            vol_metrics = volatility_engine.compute_symbol_volatility(
                d1_df=d1_view,
                m5_df=m5_slice,
                current_quote=float(curr_bar['close']),
                symbol=symbol,
                as_of=curr_time
            )
            if vol_metrics.get("valid", False):
                adr_val = vol_metrics.get("adr")
                regime = vol_metrics.get("regime", "NORMAL")

        # 4. Shared session levels
        vp = get_session_volume_profile(m5_slice)
        session_levels = build_session_levels(
            symbol=symbol,
            m5_df=m5_slice,
            d1_df=d1_view,
            vp_node=vp,
            frozen_orbs=frozen_orbs,
            as_of=curr_time,
            adr_val=adr_val
        )

        # 5. Evaluate strategies
        signal = sm.evaluate_all(
            symbol=symbol,
            data_5m=m5_slice,
            data_h4=h4_view,
            data_d1=d1_view,
            session_levels=session_levels,
            data_h1=h1_view
        )
# 6. Adapt signal under Adaptive Mode (identical to live matrix.py)
        if signal and adaptive_mode:
            if vol_metrics.get("valid", False):
                adapted = volatility_engine.adapt_signal(signal, vol_metrics, ui_rr=2.0, session_levels=session_levels)
                if not adapted:
                    logger.log_skipped({
                        "time": curr_time.strftime("%Y-%m-%d %H:%M:%S"),
                        "symbol": symbol,
                        "strategy": signal.strategy,
                        "reason": "Rejected by ADR stop clamping or minimum R:R filter"
                    })
                    signal = None
                else:
                    # Evaluate Volatility Spread & Room Filters
                    spread = 2.50 if symbol == "US30" else (0.30 if symbol == "GOLD" else 0.00010)
                    sl_dist = abs(adapted.entry_price - adapted.stop_loss)
                    tp_dist = abs(adapted.take_profit_2 - adapted.entry_price)
                    vol_ok, vol_msg = volatility_engine.evaluate_volatility_filters(
                        vol_metrics, spread, sl_dist, tp_dist, adapted.direction, adapted.entry_price, adapted.strategy
                    )
                    if not vol_ok:
                        logger.log_skipped({
                            "time": curr_time.strftime("%Y-%m-%d %H:%M:%S"),
                            "symbol": symbol,
                            "strategy": signal.strategy,
                            "reason": vol_msg
                        })
                        signal = None
                    else:
                        signal = adapted

        # 7. Execute trade in simulator
        if signal:
            has_open_on_symbol = any(p["symbol"] == symbol for p in sim.open_positions)
            if not has_open_on_symbol:
                opened = sim.open_trade(signal, curr_time, adr_val, regime, session_levels)
                if opened:
                    print(f"[{curr_time.strftime('%Y-%m-%d %H:%M')}] FILLED: {signal.strategy} {signal.direction} @ {signal.entry_price:.2f}")

    # Transfer trades to logger
    for t in sim.completed_trades:
        logger.log_trade(t)

    logger.save_to_disk()

    # Summary
    total_trades = len(sim.completed_trades)
    wins = len([t for t in sim.completed_trades if t["result"] == "WIN"])
    losses = len([t for t in sim.completed_trades if t["result"] == "LOSS"])
    net_pnl = sim.balance - balance
    win_rate = (wins / total_trades * 100) if total_trades > 0 else 0.0

    print("\n" + "=" * 75)
    print("SIMULATION PERFORMANCE SUMMARY")
    print("=" * 75)
    print(f"• Total Filled Legs  : {total_trades}")
    print(f"• Wins / Losses / BE : {wins}W / {losses}L / {total_trades - wins - losses}BE")
    print(f"• Win Rate           : {win_rate:.1f}%")
    print(f"• Net Profit ($)     : ${net_pnl:,.2f}")
    print(f"• Final Balance ($)  : ${sim.balance:,.2f}")
    print("=" * 75 + "\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, default="US30")
    parser.add_argument("--adaptive", action="store_true", default=True)
    parser.add_argument("--balance", type=float, default=1000.0)
    parser.add_argument("--risk", type=float, default=1.0)
    args = parser.parse_args()

    run_simulation(symbol=args.symbol, adaptive_mode=args.adaptive, balance=args.balance, risk_pct=args.risk)