"""
backtest/downloader.py
Automated historical candle downloader using your existing cTrader connection.
Pulls chunked M5, H1, H4, and D1 data in UTC without exceeding Spotware 5000-bar limits.
"""

import sys
import os
import time
import asyncio
import pandas as pd
from datetime import datetime, timezone, timedelta

# Ensure parent directory is in path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from engine.matrix import ConfigManager, CTraderClient, CTraderTrendbarPeriod

# Target whitelist assets
WHITELIST_SYMBOLS = ["GOLD", "US30", "NAS100", "GERMAN30", "EURUSD", "GBPUSD", "USDJPY"]

# Output directory
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
os.makedirs(DATA_DIR, exist_ok=True)

async def fetch_chunked_bars(
    client: CTraderClient,
    symbol_name: str,
    period_enum: CTraderTrendbarPeriod,
    start_dt: datetime,
    end_dt: datetime
) -> pd.DataFrame:
    """
    Downloads trendbars in safe 10-day chunks (under 3,000 M5 bars per request)
    to strictly respect the Spotware 5,000-bar limit.
    """
    sid = client.resolve_symbol_id(symbol_name)
    if not sid:
        print(f"[-] Could not resolve broker symbol ID for {symbol_name}")
        return pd.DataFrame()

    digits = client.symbol_details.get(sid, {}).get("digits", 5)
    divisor = float(10 ** digits)

    all_candles = []
    chunk_days = 10 if period_enum == CTraderTrendbarPeriod.M5 else 60
    current_start = start_dt

    print(f"    Fetching {period_enum.name} from {start_dt.strftime('%Y-%m-%d')} to {end_dt.strftime('%Y-%m-%d')}...")

    while current_start < end_dt:
        current_end = min(current_start + timedelta(days=chunk_days), end_dt)
        from_ms = int(current_start.timestamp() * 1000)
        to_ms = int(current_end.timestamp() * 1000)

        res = await client._send_and_wait(2137, {
            "ctidTraderAccountId": client.account_id,
            "symbolId": sid,
            "period": period_enum.value,
            "fromTimestamp": from_ms,
            "toTimestamp": to_ms
        }, timeout=10.0)

        if res and "trendbar" in res.get("payload", {}):
            bars = res["payload"]["trendbar"]
            for b in bars:
                low = float(b.get("low", 0)) / divisor
                open_p = (float(b.get("low", 0)) + float(b.get("deltaOpen", 0))) / divisor
                close_p = (float(b.get("low", 0)) + float(b.get("deltaClose", 0))) / divisor
                high_p = (float(b.get("low", 0)) + float(b.get("deltaHigh", 0))) / divisor
                t_sec = b.get("utcTimestampInMinutes", 0) * 60

                all_candles.append({
                    "time": datetime.fromtimestamp(t_sec, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                    "open": round(open_p, digits),
                    "high": round(high_p, digits),
                    "low": round(low, digits),
                    "close": round(close_p, digits),
                    "volume": b.get("volume", 1)
                })

        # Pacing rate limiter: 4 req/sec to prevent disconnects
        await asyncio.sleep(0.25)
        current_start = current_end

    if not all_candles:
        return pd.DataFrame()

    df = pd.DataFrame(all_candles)
    df.drop_duplicates(subset=["time"], inplace=True)
    df.sort_values("time", inplace=True)
    df.reset_index(drop=True, inplace=True)
    return df

async def run_downloader(days_back: int = 90):
    client = CTraderClient()
    print("=" * 65)
    print("1. CONNECTING TO BROKER VIA CTRADER OPEN API")
    print("=" * 65)

    if not await client.connect():
        print("[!] Connection failed. Check CTRADER credentials in your .env file.")
        return

    now_utc = datetime.now(timezone.utc)
    # 90 days of backtest + 150 days of D1 warmup history
    test_start = now_utc - timedelta(days=days_back)
    warmup_start = now_utc - timedelta(days=days_back + 180)

    periods_to_fetch = [
        (CTraderTrendbarPeriod.M5, test_start),
        (CTraderTrendbarPeriod.H1, test_start),
        (CTraderTrendbarPeriod.H4, test_start),
        (CTraderTrendbarPeriod.D1, warmup_start)  # Needs 150+ closed bars for volatility engine
    ]

    print("\n" + "=" * 65)
    print(f"2. DOWNLOADING {days_back} DAYS OF DATA + 180 DAYS D1 WARMUP")
    print("=" * 65)

    for symbol in WHITELIST_SYMBOLS:
        print(f"\n[*] Processing Asset: {symbol}")
        for period_enum, start_time in periods_to_fetch:
            df = await fetch_chunked_bars(client, symbol, period_enum, start_time, now_utc)
            if not df.empty:
                filename = os.path.join(DATA_DIR, f"{symbol}_{period_enum.name}.csv")
                df.to_csv(filename, index=False)
                print(f"    [+] Saved {len(df):,} bars to {filename}")
            else:
                print(f"    [-] No data returned for {symbol} {period_enum.name}")

    print("\n[✓] Historical download complete.")
    if client.ws:
        try:
            await client.ws.close()
        except Exception:
            pass

if __name__ == "__main__":
    asyncio.run(run_downloader(days_back=90))