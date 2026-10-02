"""
backtest/paths.py
Centralized directory paths for backtest data and report outputs.
Supports BACKTEST_STORAGE_DIR environment variable for persistent storage volumes.
"""

import os

storage_base = os.getenv("BACKTEST_STORAGE_DIR", "").strip()
if storage_base:
    DATA_DIR = os.path.join(storage_base, "data")
    OUTPUT_DIR = os.path.join(storage_base, "output")
else:
    base_dir = os.path.dirname(__file__)
    DATA_DIR = os.path.join(base_dir, "data")
    OUTPUT_DIR = os.path.join(base_dir, "output")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)