#!/usr/bin/env python3
"""
trading-portal/tests/replay_harness.py
Replay & Backtest Verification Harness.
Feeds multi-timeframe OHLC candles through StrategyManager, printing per-strategy
signal counts and a structured diagnostic breakdown of rejections.
"""

import sys
import os
import argparse
import pandas as pd
import numpy as np
from datetime import datetime, timezone, timedelta
from typing import Dict

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from strategies.strategy_manager import StrategyManager
from core.indicators import get_session_volume_profile, get_pivot_points

def generate_synthetic_session_ohlc(symbol: str = "US30", bars_count: int = 150) -> Dict[str, pd.DataFrame]:
    """Generates realistic correlated M5, H4, and D1 synthetic feeds for testing."""
    now = datetime(2026, 9, 30, 14, 0, tzinfo=timezone.utc)
    base_price = 43000.0 if symbol == "US30" else (2650.0 if symbol == "GOLD" else 1.0850)

    # 1. M5
    m5_records = []
    curr = base_price
    for i in range(bars_count):
        t = now - timedelta(minutes=(bars_count - i) * 5)
        step = np.random.normal(0, 5.0 if symbol == "US30" else 0.5)
        o = curr
        c = curr + step
        h = max(o, c) + abs(np.random.normal(0, 2.0))
        l = min(o, c) - abs(np.random.normal(0, 2.0))
        curr = c
        m5_records.append({'time': t, 'open': o, 'high': h, 'low': l, 'close': c, 'tick_volume': int(np.random.randint(50, 400))})
    m5_df = pd.DataFrame(m5_records)

    # 2. H4
    h4_records = []
    for i in range(20):
        t = now - timedelta(hours=(20 - i) * 4)
        h4_records.append({'time': t, 'open': base_price, 'high': base_price + 50, 'low': base_price - 50, 'close': base_price + 10, 'tick_volume': 1000})
    h4_df = pd.DataFrame(h4_records)

    # 3. D1
    d1_records = []
    for i in range(10):
        t = now - timedelta(days=(10 - i))
        d1_records.append({'time': t, 'open': base_price, 'high': base_price + 150, 'low': base_price - 150, 'close': base_price + 20, 'tick_volume': 5000})
    d1_df = pd.DataFrame(d1_records)

    return {'M5': m5_df, 'H4': h4_df, 'D1': d1_df}

def run_replay(symbol: str = "US30", dry_run: bool = True):
    print(f"\n====================================================================")
    print(f"RUNNING STRATEGY REPLAY & DIAGNOSTIC AUDIT ON: {symbol} (Dry-Run: {dry_run})")
    print(f"====================================================================\n")

    sm = StrategyManager()
    data = generate_synthetic_session_ohlc(symbol=symbol, bars_count=120)
    m5_df = data['M5']
    h4_df = data['H4']
    d1_df = data['D1']

    vp = get_session_volume_profile(m5_df)
    pivots = get_pivot_points(high=d1_df.iloc[-2]['high'], low=d1_df.iloc[-2]['low'], close=d1_df.iloc[-2]['close'])

    session_levels = {
        'asia_high': float(m5_df['high'].max()),
        'asia_low': float(m5_df['low'].min()),
        'daily_eq': (float(m5_df['high'].max()) + float(m5_df['low'].min())) / 2.0,
        'pdh': float(d1_df.iloc[-2]['high']),
        'pdl': float(d1_df.iloc[-2]['low']),
        'daily_pivot': pivots['P'],
        'pivot_r1': pivots['R1'],
        'pivot_s1': pivots['S1'],
        'pivot_r2': pivots['R2'],
        'pivot_s2': pivots['S2'],
        'orb_high': float(m5_df['high'].iloc[3]),
        'orb_low': float(m5_df['low'].iloc[3]),
        'orb_established': True,
        'poc': vp['poc'],
        'vah': vp['vah'],
        'val': vp['val']
    }

    signal_counts = {}
    rejection_reasons = {}

    for strat in sm.strategies:
        name = strat.__class__.__name__
        signal_counts[name] = 0
        rejection_reasons[name] = []

        try:
            import inspect
            sig = inspect.signature(strat.evaluate)
            if len(sig.parameters) >= 5:
                signal = strat.evaluate(symbol, m5_df, h4_df, d1_df, session_levels)
            else:
                signal = strat.evaluate(symbol, m5_df, session_levels)

            if signal:
                signal_counts[name] += 1
                print(f"[{name}] >>> SIGNAL GENERATED: {signal.direction} @ {signal.entry_price} (SL: {signal.stop_loss}, TP: {signal.take_profit})")
            else:
                rejection_reasons[name].append("Setup condition not met in current session cycle")
        except Exception as e:
            rejection_reasons[name].append(f"Execution Error: {e}")

    print("\n---------------- AUDIT REPLAY SUMMARY ----------------")
    for strat, count in signal_counts.items():
        print(f"• {strat:<30}: {count} signals fired. Rejection diagnostic: {rejection_reasons[strat][0]}")
    print("------------------------------------------------------\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Nexus Matrix Strategy Replay Harness")
    parser.add_argument("--symbol", type=str, default="US30", help="Symbol to test (US30, GOLD, EURUSD)")
    parser.add_argument("--dry-run", action="store_true", default=True, help="Run without sending orders")
    args = parser.parse_args()

    run_replay(symbol=args.symbol, dry_run=args.dry_run)