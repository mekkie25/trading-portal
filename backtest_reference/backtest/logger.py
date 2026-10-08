"""
backtest/logger.py
Writes completed trades to CSV/JSON and records skipped signals with diagnostic reasons.
"""

import os
import json
import pandas as pd
from typing import List, Dict, Any
from backtest.paths import DATA_DIR

class AuditLogger:
    def __init__(self, run_label: str = "simulation"):
        self.run_label = run_label
        self.trades: List[Dict[str, Any]] = []
        self.skipped_signals: List[Dict[str, Any]] = []

    def log_trade(self, trade_record: Dict[str, Any]):
        self.trades.append(trade_record)

    def log_skipped(self, skipped_record: Dict[str, Any]):
        self.skipped_signals.append(skipped_record)

    def save_to_disk(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        
        # 1. Save Trades Log (CSV & JSON)
        if self.trades:
            df_trades = pd.DataFrame(self.trades)
            csv_path = os.path.join(DATA_DIR, f"{self.run_label}_trades.csv")
            json_path = os.path.join(DATA_DIR, f"{self.run_label}_trades.json")
            df_trades.to_csv(csv_path, index=False)
            with open(json_path, "w") as f:
                json.dump(self.trades, f, indent=2)
            print(f"[✓] Saved {len(self.trades)} trades to {csv_path}")
        else:
            print("[!] No trades were executed to log.")

        # 2. Save Skipped Signals Log (CSV)
        if self.skipped_signals:
            df_skipped = pd.DataFrame(self.skipped_signals)
            skip_csv_path = os.path.join(DATA_DIR, f"{self.run_label}_skipped_signals.csv")
            df_skipped.to_csv(skip_csv_path, index=False)
            print(f"[✓] Saved {len(self.skipped_signals)} skipped signals to {skip_csv_path}")