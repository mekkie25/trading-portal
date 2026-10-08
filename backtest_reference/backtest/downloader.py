"""
backtest/downloader.py
Automated historical candle downloader using your existing cTrader connection.
Pulls rolling 500 days of 5-Minute (M5) candles in safe 10-day chunks, then automatically
synthesizes H1, H4, and D1 history from M5 so no extra broker API calls are needed.
"""

import sys
import os
import time
import asyncio
import pandas as pd
from datetime import datetime, timezone, timedelta

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from engine.matrix import ConfigManager, CTraderClient, CTraderTrendbarPeriod
from backtest.paths import DATA_DIR

WHITELIST_SYMBOLS = ["GOLD", "US30", "NAS100", "GERMAN30", "EURUSD", "GBPUSD", "USDJPY"]

async def fetch_chunked_bars(
    client: CTraderClient,
    symbol_name: str,
    period_enum: CTraderTrendbarPeriod,
    start_dt: datetime,
    end_dt: datetime
) -> pd.DataFrame:
    sid = client.resolve_symbol_id(symbol_name)
    if not sid:
        print(f"[-] Could not resolve broker symbol ID for {symbol_name}", flush=True)
        return pd.DataFrame()

    digits = client.symbol_details.get(sid, {}).get("digits", 5)
    divisor = float(10 ** digits)

    all_candles = []
    chunk_days = 10
    current_start = start_dt

    print(f"    Fetching {period_enum.name} from {start_dt.strftime('%Y-%m-%d')} to {end_dt.strftime('%Y-%m-%d')}...", flush=True)

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

        await asyncio.sleep(0.25)
        current_start = current_end

    if not all_candles:
        return pd.DataFrame()

    df = pd.DataFrame(all_candles)
    df.drop_duplicates(subset=["time"], inplace=True)
    df.sort_values("time", inplace=True)
    df.reset_index(drop=True, inplace=True)
    return df

def build_higher_timeframes_from_m5(m5_df: pd.DataFrame, symbol: str) -> None:
    if m5_df.empty:
        return

    df = m5_df.copy()
    df['dt'] = pd.to_datetime(df['time'], utc=True)
    df.set_index('dt', inplace=True)

    agg_rules = {
        'open': 'first',
        'high': 'max',
        'low': 'min',
        'close': 'last',
        'volume': 'sum'
    }

    # 1. H1 Bars
    h1 = df.resample('1h').agg(agg_rules).dropna().reset_index()
    h1['time'] = h1['dt'].dt.strftime("%Y-%m-%d %H:%M:%S")
    h1[['time', 'open', 'high', 'low', 'close', 'volume']].to_csv(
        os.path.join(DATA_DIR, f"{symbol}_H1.csv"), index=False
    )

    # 2. H4 Bars
    h4 = df.resample('4h').agg(agg_rules).dropna().reset_index()
    h4['time'] = h4['dt'].dt.strftime("%Y-%m-%d %H:%M:%S")
    h4[['time', 'open', 'high', 'low', 'close', 'volume']].to_csv(
        os.path.join(DATA_DIR, f"{symbol}_H4.csv"), index=False
    )

    # 3. D1 Bars (21:00 UTC open alignment)
    d1 = df.resample('24h', offset='21h').agg(agg_rules).dropna().reset_index()
    d1['time'] = d1['dt'].dt.strftime("%Y-%m-%d %H:%M:%S")
    d1[['time', 'open', 'high', 'low', 'close', 'volume']].to_csv(
        os.path.join(DATA_DIR, f"{symbol}_D1.csv"), index=False
    )
    print(f"    [+] Automatically synthesized H1, H4, and D1 for {symbol} from M5 data.", flush=True)

async def run_downloader(days_back: int = 500):
    client = CTraderClient()
    print("=" * 65, flush=True)
    print("1. CONNECTING TO BROKER VIA CTRADER OPEN API", flush=True)
    print("=" * 65, flush=True)

    if not await client.connect():
        print("[!] Connection failed. Check CTRADER credentials in your .env file.", flush=True)
        return

    now_utc = datetime.now(timezone.utc)
    test_start = now_utc - timedelta(days=days_back)

    print("\n" + "=" * 65, flush=True)
    print(f"2. DOWNLOADING ROLLING {days_back} DAYS OF 5-MINUTE CANDLES", flush=True)
    print("=" * 65, flush=True)

    for symbol in WHITELIST_SYMBOLS:
        print(f"\n[*] Processing Asset: {symbol}", flush=True)
        m5_df = await fetch_chunked_bars(client, symbol, CTraderTrendbarPeriod.M5, test_start, now_utc)
        if not m5_df.empty:
            m5_filename = os.path.join(DATA_DIR, f"{symbol}_M5.csv")
            m5_df.to_csv(m5_filename, index=False)
            print(f"    [+] Saved {len(m5_df):,} M5 bars to {m5_filename}", flush=True)
            build_higher_timeframes_from_m5(m5_df, symbol)
        else:
            print(f"    [-] No data returned for {symbol} M5", flush=True)

    print("\n[✓] Historical download and timeframe synthesis complete.", flush=True)
    if client.ws:
        try:
            await client.ws.close()
        except Exception:
            pass

if __name__ == "__main__":
    asyncio.run(run_downloader(days_back=500))