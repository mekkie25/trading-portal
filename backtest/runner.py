"""
backtest/runner.py
Automated End-to-End Backtest Runner.
Called by the Web UI to run historical tests:
- Automatically downloads missing broker M5 candles for a rolling 365-day window.
- Replays every closed M5 bar through StrategyManager (Zero Look-Ahead).
- Simulates twin 50/50 legs, break-even triggers, and 21:00 SAST EOD close.
- Generates plain-English Actionable Improvement Tips (advisor.py).
- Exports structured JSON reports directly into backtest/output/.
"""

import sys
import os
import json
import asyncio
import argparse
import pandas as pd
from datetime import datetime, timezone, timedelta
from typing import Dict, Any

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
from backtest.simulator import TradeSimulator
from backtest.report import calculate_kpis
from backtest.downloader import fetch_chunked_bars, build_higher_timeframes_from_m5, CTraderTrendbarPeriod, CTraderClient
from backtest.advisor import generate_improvement_tips

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

async def ensure_symbol_data(client: CTraderClient, symbol: str, days_back: int = 365) -> bool:
    m5_path = os.path.join(DATA_DIR, f"{symbol}_M5.csv")
    h1_path = os.path.join(DATA_DIR, f"{symbol}_H1.csv")
    h4_path = os.path.join(DATA_DIR, f"{symbol}_H4.csv")
    d1_path = os.path.join(DATA_DIR, f"{symbol}_D1.csv")

    if os.path.exists(m5_path) and os.path.getsize(m5_path) > 5000:
        if not all(os.path.exists(p) for p in [h1_path, h4_path, d1_path]):
            m5_df = pd.read_csv(m5_path)
            build_higher_timeframes_from_m5(m5_df, symbol)
        return True

    now_utc = datetime.now(timezone.utc)
    start_dt = now_utc - timedelta(days=days_back)

    print(f"[*] Downloading rolling {days_back} days of M5 candles for {symbol}...", flush=True)
    if not client.is_authorized:
        connected = await client.connect()
        if not connected:
            print("ERROR: Could not connect to cTrader. Please check CTRADER credentials in your environment.", flush=True)
            return False

    m5_df = await fetch_chunked_bars(client, symbol, CTraderTrendbarPeriod.M5, start_dt, now_utc)
    if not m5_df.empty:
        m5_df.to_csv(m5_path, index=False)
        print(f"    [+] Saved {len(m5_df):,} M5 bars to {m5_path}", flush=True)
        build_higher_timeframes_from_m5(m5_df, symbol)
        return True
    else:
        print(f"ERROR: Failed downloading M5 candles for {symbol}", flush=True)
        return False

def run_backtest_for_symbol(symbol: str = "US30", adaptive_mode: bool = True, balance: float = 1000.0, risk_pct: float = 1.0) -> bool:
    mode_str = "adaptive" if adaptive_mode else "legacy"
    print(f"\n=======================================================", flush=True)
    print(f"STARTING AUTOMATED BACKTEST: {symbol} ({mode_str.upper()})", flush=True)
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

    aggregator = ZeroLookAheadAggregator(d1_df, h4_df, h1_df)
    sm = StrategyManager()
    sim = TradeSimulator(starting_balance=balance, risk_pct=risk_pct)

    frozen_orbs: Dict[Any, Any] = {}
    total_bars = len(m5_df)
    start_idx = 120

    print(f"[*] Simulating across {total_bars - start_idx:,} M5 candles (Zero Look-Ahead)...", flush=True)

    for i in range(start_idx, total_bars):
        m5_slice = m5_df.iloc[max(0, i - 120):i + 1].copy().reset_index(drop=True)
        m5_slice['time'] = pd.to_datetime(m5_slice['time'], utc=True)
        curr_bar = m5_slice.iloc[-1]
        curr_time = curr_bar['time'].to_pydatetime()

        sim.process_candle(symbol, curr_bar, m5_slice)

        h1_view, h4_view, d1_view = aggregator.get_feeds_at_time(m5_slice, curr_time)

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
                adapted = volatility_engine.adapt_signal(signal, vol_metrics, ui_rr=2.0, session_levels=session_levels)
                if adapted:
                    spread = 2.50 if symbol == "US30" else (0.30 if symbol == "GOLD" else 0.00010)
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

    m5_df["dt"] = pd.to_datetime(m5_df["time"], utc=True)
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

    # Generate Actionable Plain-English Improvement Tips
    improvement_tips = generate_improvement_tips(all_trades, symbol, mode_str)

    report_payload = {
        "symbol": symbol,
        "mode": mode_str,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "global_kpis": global_kpis,
        "strategy_kpis": strat_kpis,
        "dow_kpis": dow_kpis,
        "trading_dates": trading_dates,
        "day_data": day_charts_data,
        "all_trades": all_trades,
        "improvement_tips": improvement_tips
    }

    out_file = os.path.join(OUTPUT_DIR, f"{symbol}_{mode_str}_report.json")
    with open(out_file, "w") as f:
        json.dump(report_payload, f, indent=2)

    print(f"[✓] Backtest report with {len(improvement_tips)} Actionable Tips written to {out_file}", flush=True)
    return True

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, default="US30")
    parser.add_argument("--days", type=int, default=365)
    parser.add_argument("--adaptive", action="store_true", default=True)
    args = parser.parse_args()

    client = CTraderClient()
    ok = await ensure_symbol_data(client, args.symbol, days_back=args.days)
    success = False
    if ok:
        success = run_backtest_for_symbol(symbol=args.symbol, adaptive_mode=args.adaptive)

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