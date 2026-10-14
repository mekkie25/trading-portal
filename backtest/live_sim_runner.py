"""
backtest/live_sim_runner.py
Standalone CLI for the Live Bot Portfolio Replay.

This file exists so the live simulation can be spawned by server.ts
without touching backtest/runner.py. It shares precompute caches and
constants with the research runner, but does not modify it.

Usage:
    python backtest/live_sim_runner.py \
        --symbols US30,GOLD,NAS100,GERMAN30,EURUSD,GBPUSD,USDJPY \
        --days 365 \
        --balance 170 \
        --currency ZAR \
        --zar-rate 18.0 \
        --profile "Max Growth"
"""

import os
import sys
import argparse
import asyncio

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

# Load .env if present so any broker env vars resolve the same way as the
# research runner. Non-fatal if missing.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(PROJECT_ROOT, '.env'))
except Exception:
    pass

from backtest.live_sim import (
    run_live_portfolio_simulation,
    WHITELIST_PAIRS,
)


def _print_diagnostics() -> None:
    print('=' * 60, flush=True)
    print('LIVE BOT REPLAY STARTUP DIAGNOSTICS', flush=True)
    print('=' * 60, flush=True)
    print(f'Python version: {sys.version.split()[0]}', flush=True)
    print(f'Project root:   {PROJECT_ROOT}', flush=True)
    print('=' * 60, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Live Bot Portfolio Replay across all pairs and combinations.',
    )
    parser.add_argument(
        '--symbols',
        type=str,
        default=','.join(WHITELIST_PAIRS),
        help='Comma-separated list of pairs to include.',
    )
    parser.add_argument(
        '--days',
        type=int,
        default=365,
        help='Number of days of history to replay.',
    )
    parser.add_argument(
        '--balance',
        type=float,
        default=170.0,
        help='Starting balance in the given currency. Any value >= 1.',
    )
    parser.add_argument(
        '--currency',
        type=str,
        default='USD',
        choices=['USD', 'ZAR'],
        help='Currency of the starting balance.',
    )
    parser.add_argument(
        '--zar-rate',
        type=float,
        default=18.0,
        help='ZAR per USD rate used when --currency ZAR.',
    )
    parser.add_argument(
        '--profile',
        type=str,
        default='Max Growth',
        help='Risk profile: Steady, Balanced, Aggressive, Max Growth, or None.',
    )
    args = parser.parse_args()

    symbols = [s.strip().upper() for s in args.symbols.split(',') if s.strip()]
    if not symbols:
        print('[live-sim] No symbols given.', flush=True)
        return 1

    _print_diagnostics()

    ok = asyncio.run(run_live_portfolio_simulation(
        symbols_list=symbols,
        days_count=args.days,
        starting_balance_input=args.balance,
        currency=args.currency,
        zar_rate=args.zar_rate,
        profile_name=args.profile,
    ))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())