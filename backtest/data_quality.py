"""
backtest/data_quality.py
Runs integrity checks on the downloaded CSV files:
- Duplicate timestamps
- Excessive gaps during trading hours
- Verified cTrader daily bar open times (21:00/22:00 UTC)
- Weekend filtering
- Warmup bar counts (verifies >= 150 D1 bars for volatility engine)
"""

import os
import glob
import pandas as pd
from datetime import timedelta

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

def check_file_quality(filepath: str):
    basename = os.path.basename(filepath)
    parts = basename.replace(".csv", "").split("_")
    symbol, timeframe = parts[0], parts[1]

    df = pd.read_csv(filepath)
    if df.empty:
        return {"File": basename, "Bars": 0, "Status": "EMPTY FILE", "Issues": "No data"}

    df['dt'] = pd.to_datetime(df['time'], utc=True)
    df.sort_values('dt', inplace=True)

    issues = []
    
    # 1. Duplicates
    dup_count = df.duplicated(subset=['dt']).sum()
    if dup_count > 0:
        issues.append(f"{dup_count} duplicate timestamps")

    # 2. Time delta checks
    deltas = df['dt'].diff().dropna()

    # 3. Timeframe-specific assertions
    if timeframe == "D1":
        # Must have >= 150 bars for Volatility Engine
        if len(df) < 150:
            issues.append(f"Insufficient D1 history: {len(df)} bars (need >= 150)")
        
        # Verify cTrader D1 open hours (21:00 or 22:00 UTC due to US Daylight Savings)
        open_hours = df['dt'].dt.hour.unique()
        unexpected_hours = [h for h in open_hours if h not in (21, 22)]
        if unexpected_hours:
            issues.append(f"Non-standard D1 open hours detected: {unexpected_hours}")

    elif timeframe == "M5":
        # Check for unexpected intraday gaps (ignoring weekend gap > 48h)
        intraday_gaps = deltas[(deltas > timedelta(minutes=15)) & (deltas < timedelta(hours=48))]
        if len(intraday_gaps) > 0:
            issues.append(f"{len(intraday_gaps)} session gaps (>15m)")

    status = "PASS" if not issues else "FLAGGED"
    return {
        "Symbol": symbol,
        "TF": timeframe,
        "Bars": len(df),
        "Start": df['dt'].iloc[0].strftime('%Y-%m-%d'),
        "End": df['dt'].iloc[-1].strftime('%Y-%m-%d'),
        "Status": status,
        "Notes": "; ".join(issues) if issues else "Clean"
    }

def run_audit():
    files = sorted(glob.glob(os.path.join(DATA_DIR, "*.csv")))
    if not files:
        print("[!] No CSV data files found in backtest/data/. Run downloader.py first.")
        return

    results = []
    for f in files:
        results.append(check_file_quality(f))

    report_df = pd.DataFrame(results)
    print("\n" + "=" * 80)
    print("DATA QUALITY AUDIT REPORT")
    print("=" * 80)
    print(report_df.to_string(index=False))
    print("=" * 80)

if __name__ == "__main__":
    run_audit()