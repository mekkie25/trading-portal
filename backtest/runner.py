"""
backtest/runner.py
High-Performance Automated End-to-End Backtest Runner.
- Incremental data store with STORE_TARGET_DAYS=365 and STORE_MAX_DAYS=400.
- Atomic file writes (temp file then replace) protecting data files against corruption.
- Window simulation: --days specifies the test window; earlier data is preserved as history.
- Adaptive honesty tracking: records adaptive_effective_pct and warns if below 90%.
- GERMAN30 support: automatically ensures EURUSD data store and converts EUR to USD scale.
"""

import sys
import os
import json
import asyncio
import argparse
import tempfile
import pandas as pd
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, Optional

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import core.session_config
from strategies.strategy_manager import StrategyManager
from core.session_levels import build_session_levels
from core.indicators import get_session_volume_profile
from core.volatility_engine import volatility_engine
from core.session_config import GLOBAL_PARAMS
from backtest.bar_aggregator import ZeroLookAheadAggregator
from backtest.simulator import TradeSimulator, ASSETS
from backtest.report import calculate_kpis
from backtest.downloader import fetch_chunked_bars, build_higher_timeframes_from_m5, CTraderTrendbarPeriod, CTraderClient
from backtest.advisor import generate_improvement_tips

STORE_TARGET_DAYS = 365
STORE_MAX_DAYS = 400

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

def _atomic_write_csv(df: pd.DataFrame, target_path: str) -> None:
    dirname = os.path.dirname(target_path)
    fd, tmp_path = tempfile.mkstemp(dir=dirname, prefix="tmp_", suffix=".csv")
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            df.to_csv(f, index=False)
        os.replace(tmp_path, target_path)
    except Exception:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        raise

async def ensure_symbol_data(client: CTraderClient, symbol: str) -> bool:
    """
    Incremental store:
    - Missing: downloads last STORE_TARGET_DAYS (365 days).
    - Existing: fetches from (last bar minus 1 day) to now, merges, keeps newest duplicate.
    - If first bar > (now minus 365 days), backfills older missing history.
    - Drops bars older than STORE_MAX_DAYS (400 days).
    - Writes M5 atomically and rebuilds H1/H4/D1.
    - Prints summary: new bars added, total bars, first and last bar dates.
    """
    m5_path = os.path.join(DATA_DIR, f"{symbol}_M5.csv")
    now_utc = datetime.now(timezone.utc)
    target_start = now_utc - timedelta(days=STORE_TARGET_DAYS)
    max_history_start = now_utc - timedelta(days=STORE_MAX_DAYS)

    existing_df = pd.DataFrame()
    old_count = 0
    if os.path.exists(m5_path) and os.path.getsize(m5_path) > 100:
        try:
            existing_df = pd.read_csv(m5_path)
            if not existing_df.empty:
                existing_df['dt'] = pd.to_datetime(existing_df['time'], utc=True)
                existing_df.sort_values('dt', inplace=True)
                old_count = len(existing_df)
        except Exception as e:
            print(f"ERROR: Could not read existing {symbol}_M5.csv ({e}). Keeping old file.", flush=True)
            existing_df = pd.DataFrame()

    chunks_to_merge = []
    if not existing_df.empty:
        chunks_to_merge.append(existing_df)

    try:
        if existing_df.empty:
            # Full 365-day initial download
            print(f"[*] Initial download for {symbol}: fetching last {STORE_TARGET_DAYS} days...", flush=True)
            if not client.is_authorized:
                if not await client.connect():
                    print(f"ERROR: Could not connect to cTrader for {symbol}.", flush=True)
                    return False

            new_df = await fetch_chunked_bars(client, symbol, CTraderTrendbarPeriod.M5, target_start, now_utc)
            if new_df.empty:
                print(f"ERROR: No candle data returned from broker for {symbol}.", flush=True)
                return False
            new_df['dt'] = pd.to_datetime(new_df['time'], utc=True)
            chunks_to_merge.append(new_df)
        else:
            last_bar_time = existing_df['dt'].iloc[-1].to_pydatetime()
            first_bar_time = existing_df['dt'].iloc[0].to_pydatetime()

            # 1. Forward fetch from (last bar minus 1 day) to now
            forward_start = max(target_start, last_bar_time - timedelta(days=1))
            if forward_start < now_utc:
                if not client.is_authorized:
                    if not await client.connect():
                        print(f"ERROR: Could not connect to cTrader for {symbol} update.", flush=True)
                        return False

                forward_df = await fetch_chunked_bars(client, symbol, CTraderTrendbarPeriod.M5, forward_start, now_utc)
                if not forward_df.empty:
                    forward_df['dt'] = pd.to_datetime(forward_df['time'], utc=True)
                    chunks_to_merge.append(forward_df)

            # 2. Backfill older missing history if file starts later than 365 days ago
            if first_bar_time > (target_start + timedelta(days=2)):
                if not client.is_authorized:
                    if not await client.connect():
                        print(f"ERROR: Could not connect to cTrader for {symbol} backfill.", flush=True)
                        return False

                backfill_end = first_bar_time + timedelta(days=1)
                print(f"[*] Backfilling older history for {symbol} from {target_start.strftime('%Y-%m-%d')} to {backfill_end.strftime('%Y-%m-%d')}...", flush=True)
                backfill_df = await fetch_chunked_bars(client, symbol, CTraderTrendbarPeriod.M5, target_start, backfill_end)
                if not backfill_df.empty:
                    backfill_df['dt'] = pd.to_datetime(backfill_df['time'], utc=True)
                    chunks_to_merge.append(backfill_df)

        # Merge, drop duplicate timestamps keeping newest, sort by time
        combined = pd.concat(chunks_to_merge, ignore_index=True)
        combined.drop_duplicates(subset=['time'], keep='last', inplace=True)
        combined.sort_values('dt', inplace=True)

        # Drop bars older than STORE_MAX_DAYS (400 days)
        combined = combined[combined['dt'] >= max_history_start].copy()
        combined.reset_index(drop=True, inplace=True)

        new_count = len(combined)
        added_bars = max(0, new_count - old_count)
        first_date = combined['dt'].iloc[0].strftime('%Y-%m-%d')
        last_date = combined['dt'].iloc[-1].strftime('%Y-%m-%d')

        out_df = combined[['time', 'open', 'high', 'low', 'close', 'volume']].copy()
        _atomic_write_csv(out_df, m5_path)

        # Rebuild H1/H4/D1 from merged M5
        build_higher_timeframes_from_m5(out_df, symbol)

        print(f"[{symbol} Store]: {added_bars:,} new bars added | Total: {new_count:,} bars | Span: {first_date} to {last_date}", flush=True)
        return True

    except Exception as e:
        print(f"ERROR: Failed updating data store for {symbol} ({e}). Preserving existing files.", flush=True)
        return len(existing_df) > 0

def run_backtest_for_symbol(
    symbol: str = "US30",
    adaptive_mode: bool = True,
    balance: float = 1000.0,
    risk_pct: float = 1.0,
    days_count: int = 60,
    eurusd_df: Optional[pd.DataFrame] = None
) -> bool:
    mode_str = "adaptive" if adaptive_mode else "legacy"
    print(f"\n=======================================================", flush=True)
    print(f"STARTING BACKTEST: {symbol} ({mode_str.upper()}) | Window: {days_count} Days | R:R: {GLOBAL_PARAMS.target_rr} | BE: {GLOBAL_PARAMS.use_breakeven} | Trail: {GLOBAL_PARAMS.use_supertrend_trail}", flush=True)
    print(f"=======================================================", flush=True)

    GLOBAL_PARAMS.adaptive_mode = adaptive_mode

    m5_path = os.path.join(DATA_DIR, f"{symbol}_M5.csv")
    h1_path = os.path.join(DATA_DIR, f"{symbol}_H1.csv")
    h4_path = os.path.join(DATA_DIR, f"{symbol}_H4.csv")
    d1_path = os.path.join(DATA_DIR, f"{symbol}_D1.csv")

    if not all(os.path.exists(p) for p in [m5_path, h1_path, h4_path, d1_path]):
        print(f"ERROR: Incomplete data files for {symbol} in {DATA_DIR}.", flush=True)
        return False

    m5_df = pd.read_csv(m5_path)
    h1_df = pd.read_csv(h1_path)
    h4_df = pd.read_csv(h4_path)
    d1_df = pd.read_csv(d1_path)

    m5_df['time'] = pd.to_datetime(m5_df['time'], utc=True)
    total_bars = len(m5_df)

    if total_bars < 130:
        print(f"ERROR: Insufficient data bars for {symbol} ({total_bars} bars).", flush=True)
        return False

    # Determine simulation window: start at first bar >= (last bar time - days_count), never before index 120
    last_bar_time = m5_df['time'].iloc[-1]
    window_cutoff = last_bar_time - timedelta(days=days_count)

    matching_indices = m5_df.index[m5_df['time'] >= window_cutoff].tolist()
    if matching_indices:
        sim_start_idx = max(120, matching_indices[0])
    else:
        sim_start_idx = max(120, total_bars - 1)

    window_start_str = m5_df['time'].iloc[sim_start_idx].strftime('%Y-%m-%d %H:%M:%S UTC')
    window_end_str = last_bar_time.strftime('%Y-%m-%d %H:%M:%S UTC')
    history_days_before_window = max(0, round((m5_df['time'].iloc[sim_start_idx] - m5_df['time'].iloc[0]).total_seconds() / 86400.0, 1))

    aggregator = ZeroLookAheadAggregator(d1_df, h4_df, h1_df)
    sm = StrategyManager()
    sim = TradeSimulator(starting_balance=balance, risk_pct=risk_pct, eurusd_df=eurusd_df)

    frozen_orbs: Dict[Any, Any] = {}
    simulated_bars_count = total_bars - sim_start_idx
    print(f"[*] Simulating {simulated_bars_count:,} M5 candles | Window: {window_start_str} to {window_end_str} (History: {history_days_before_window} days)...", flush=True)

    last_vol_date = None
    vol_metrics = {"valid": False}
    adr_val = None
    regime = "NORMAL"

    valid_vol_bars = 0
    step_interval = max(1, simulated_bars_count // 10)

    for i in range(sim_start_idx, total_bars):
        m5_slice = m5_df.iloc[max(0, i - 120):i + 1].copy().reset_index(drop=True)
        curr_bar = m5_slice.iloc[-1]
        curr_time = curr_bar['time'].to_pydatetime()
        curr_date = curr_time.date()

        rel_idx = i - sim_start_idx
        if rel_idx % step_interval == 0:
            pct = int((rel_idx / max(1, simulated_bars_count)) * 100)
            print(f"[*] {symbol} Progress: {pct}% ({rel_idx:,}/{simulated_bars_count:,} candles)", flush=True)

        sim.process_candle(symbol, curr_bar, m5_slice)

        h1_view, h4_view, d1_view = aggregator.get_feeds_at_time(m5_slice, curr_time)

        if curr_date != last_vol_date or not vol_metrics.get("valid", False):
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
            last_vol_date = curr_date

        if vol_metrics.get("valid", False):
            valid_vol_bars += 1

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

        signal = sm.evaluate_all(
            symbol=symbol,
            data_5m=m5_slice,
            data_h4=h4_view,
            data_d1=d1_view,
            session_levels=session_levels,
            data_h1=h1_view
        )

        if signal and adaptive_mode:
            if vol_metrics.get("valid", False):
                adapted = volatility_engine.adapt_signal(signal, vol_metrics, ui_rr=GLOBAL_PARAMS.target_rr, session_levels=session_levels)
                if adapted:
                    spread = ASSETS.get(symbol, {}).get("spread", 0.0001)
                    sl_dist = abs(adapted.entry_price - adapted.stop_loss)
                    tp_dist = abs(adapted.take_profit_2 - adapted.entry_price)
                    vol_ok, _ = volatility_engine.evaluate_volatility_filters(
                        vol_metrics, spread, sl_dist, tp_dist, adapted.direction, adapted.entry_price, adapted.strategy
                    )
                    signal = adapted if vol_ok else None
                else:
                    signal = None

        if signal:
            has_open = any(p["symbol"] == symbol for p in sim.open_positions)
            if not has_open:
                sim.open_trade(signal, curr_time, adr_val, regime, session_levels)

    # Close open positions at end of historical data
    if len(m5_df) > 0 and len(sim.open_positions) > 0:
        sim.close_all(symbol, m5_df.iloc[-1])

    # Adaptive honesty calculations
    adaptive_pct = round((valid_vol_bars / max(1, simulated_bars_count)) * 100.0, 1)
    report_warnings = []
    if adaptive_mode and adaptive_pct < 90.0:
        warn_msg = f"WARNING: ADAPTIVE only active on {adaptive_pct:.1f}% of bars (needs 120 D1 bars of history before the window)"
        print(warn_msg, flush=True)
        report_warnings.append(warn_msg)

    all_trades = sim.completed_trades
    df_trades = pd.DataFrame(all_trades)
    global_kpis = calculate_kpis(all_trades)

    strat_kpis = {}
    dow_kpis = {}
    if not df_trades.empty:
        for s_name, s_group in df_trades.groupby("strategy"):
            strat_kpis[s_name] = calculate_kpis(s_group.to_dict("records"))

        df_trades["weekday"] = pd.to_datetime(df_trades["date"]).dt.day_name()
        for dow, dow_group in df_trades.groupby("weekday"):
            dow_kpis[dow] = calculate_kpis(dow_group.to_dict("records"))

    m5_df["dt"] = m5_df["time"]
    m5_df["date_str"] = m5_df["dt"].dt.strftime("%Y-%m-%d")
    trading_dates = sorted(df_trades["date"].unique().tolist()) if not df_trades.empty else []

    day_charts_data = {}
    for d_str in trading_dates:
        sub_m5 = m5_df[m5_df["date_str"] == d_str]
        candles_list = [
            {"time": int(r["dt"].timestamp()), "open": float(r["open"]), "high": float(r["high"]), "low": float(r["low"]), "close": float(r["close"])}
            for _, r in sub_m5.iterrows()
        ]
        day_t = df_trades[df_trades["date"] == d_str].to_dict("records")
        first_t = day_t[0] if day_t else {}
        ref_levels = first_t.get("ref_levels", {})

        day_charts_data[d_str] = {
            "candles": candles_list,
            "trades": day_t,
            "levels": {
                "asia_high": ref_levels.get("asia_high"),
                "asia_low": ref_levels.get("asia_low"),
                "daily_eq": ref_levels.get("daily_eq"),
                "daily_pivot": ref_levels.get("daily_pivot"),
                "pdh": ref_levels.get("pdh"),
                "pdl": ref_levels.get("pdl"),
                "orb_high": ref_levels.get("orb_high"),
                "orb_low": ref_levels.get("orb_low")
            }
        }

    improvement_tips = generate_improvement_tips(all_trades, symbol, mode_str)

    run_settings_text = (
        f"mode: {mode_str}, target_rr: {GLOBAL_PARAMS.target_rr}, "
        f"use_breakeven: {GLOBAL_PARAMS.use_breakeven}, "
        f"use_supertrend_trail: {GLOBAL_PARAMS.use_supertrend_trail}, days: {days_count}, "
        f"adaptive_effective_pct: {adaptive_pct}%"
    )

    report_payload = {
        "symbol": symbol,
        "mode": mode_str,
        "window_start": window_start_str,
        "window_end": window_end_str,
        "history_days_before_window": history_days_before_window,
        "adaptive_effective_pct": adaptive_pct,
        "run_settings": run_settings_text,
        "warnings": report_warnings,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "global_kpis": global_kpis,
        "strategy_kpis": strat_kpis,
        "dow_kpis": dow_kpis,
        "trading_dates": trading_dates,
        "day_data": day_charts_data,
        "all_trades": all_trades,
        "skipped_summary": sim.skip_summary(),
        "improvement_tips": improvement_tips
    }

    out_file = os.path.join(OUTPUT_DIR, f"{symbol}_{mode_str}_report.json")
    with open(out_file, "w") as f:
        json.dump(report_payload, f, indent=2)

    print(f"[✓] {symbol} Backtest completed ({adaptive_pct}% adaptive coverage) -> {out_file}", flush=True)
    return True

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, default="US30")
    parser.add_argument("--days", type=int, default=60)
    parser.add_argument("--mode", type=str, default=None, choices=["adaptive", "legacy"], help="Execution mode")
    parser.add_argument("--adaptive", action="store_true", default=True, help="Legacy flag passed by server.ts")
    parser.add_argument("--rr", type=float, default=1.0, help="Fixed target R:R multiplier (default: 1.0)")
    parser.add_argument("--breakeven", type=str, default="off", choices=["on", "off"], help="Break-even on/off (default: off)")
    parser.add_argument("--supertrend", type=str, default="on", choices=["on", "off"], help="SuperTrend trail on/off (default: on)")
    args = parser.parse_args()

    # Decide adaptive mode: --mode takes precedence; if omitted, fallback to --adaptive
    if args.mode is not None:
        adaptive_selected = (args.mode.lower() == "adaptive")
    else:
        adaptive_selected = bool(args.adaptive)

    GLOBAL_PARAMS.adaptive_mode = adaptive_selected
    GLOBAL_PARAMS.target_rr = args.rr
    GLOBAL_PARAMS.use_breakeven = (args.breakeven.lower() == "on")
    GLOBAL_PARAMS.use_supertrend_trail = (args.supertrend.lower() == "on")

    client = CTraderClient()

    # Ensure symbol data in incremental store
    ok = await ensure_symbol_data(client, args.symbol)

    # For GERMAN30, also ensure EURUSD store and load EURUSD M5 for FX conversion
    eurusd_df: Optional[pd.DataFrame] = None
    if args.symbol.upper() == "GERMAN30":
        eurusd_ok = await ensure_symbol_data(client, "EURUSD")
        eurusd_m5_path = os.path.join(DATA_DIR, "EURUSD_M5.csv")
        if not eurusd_ok or not os.path.exists(eurusd_m5_path):
            print("ERROR: GERMAN30 needs EURUSD history", flush=True)
            if client.ws:
                try:
                    await client.ws.close()
                except Exception:
                    pass
            sys.exit(1)
        try:
            eurusd_df = pd.read_csv(eurusd_m5_path)
        except Exception:
            print("ERROR: GERMAN30 needs EURUSD history", flush=True)
            if client.ws:
                try:
                    await client.ws.close()
                except Exception:
                    pass
            sys.exit(1)

    success = False
    if ok:
        success = run_backtest_for_symbol(
            symbol=args.symbol,
            adaptive_mode=adaptive_selected,
            days_count=args.days,
            eurusd_df=eurusd_df
        )

    if client.ws:
        try:
            await client.ws.close()
        except Exception:
            pass

    if not ok or not success:
        sys.exit(1)

def print_startup_diagnostics() -> None:
    print("=" * 60, flush=True)
    print("BACKTEST STARTUP DIAGNOSTICS", flush=True)
    print("=" * 60, flush=True)
    print(f"Python version: {sys.version.split()[0]}", flush=True)

    env_checks = [
        "CTRADER_CLIENT_ID",
        "CTRADER_CLIENT_SECRET",
        "CTRADER_ACCESS_TOKEN",
        "CTRADER_ACCOUNT_ID",
    ]
    for key in env_checks:
        value = os.environ.get(key, "").strip()
        status = "SET" if value else "MISSING"
        print(f"{key}: {status}", flush=True)
    print("=" * 60, flush=True)

if __name__ == "__main__":
    try:
        from dotenv import load_dotenv
        project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
        load_dotenv(os.path.join(project_root, '.env'))
    except ImportError:
        pass

    print_startup_diagnostics()
    asyncio.run(main())