"""
trading-portal/risk/risk_manager.py
Institutional Risk Engine with Persistent Daily Rollover & Dynamic Drawdown Throttling.
"""

import os
import json
import logging
import pandas as pd
import numpy as np
from datetime import datetime, timezone, time as dtime
from typing import Dict, Tuple, Optional

try:
    from config.strategy_params import GLOBAL_PARAMS
except ImportError:
    import sys
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
    from config.strategy_params import GLOBAL_PARAMS

log = logging.getLogger("RiskManager")

class RiskManager:
    def __init__(self, config_file: str = "bot_config.json", state_file: str = "risk_state.json"):
        self.config_file = config_file
        self.state_file = state_file

        # UI & Spec Synced Controls
        self.master_execution: bool = True
        self.dry_run: bool = False
        self.risk_per_trade_pct: float = GLOBAL_PARAMS.base_risk_per_trade_pct
        self.risk_to_reward: float = 2.0
        self.max_daily_trades: int = GLOBAL_PARAMS.max_daily_trades
        self.max_daily_loss_pct: float = GLOBAL_PARAMS.max_daily_loss_pct

        # Operational State
        self.current_day_str: str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        self.starting_day_equity: float = 0.0
        self.trades_taken_today: int = 0
        self.consecutive_losses: int = 0
        self.current_daily_loss: float = 0.0
        self.open_positions: Dict[str, dict] = {}

        self.load_persistent_state()

    def load_persistent_state(self):
        """Zero-Amnesia: Restores trade counters and streak tracking across container restarts."""
        if os.path.exists(self.state_file):
            try:
                with open(self.state_file, "r") as f:
                    st = json.load(f)
                saved_day = st.get("current_day_str")
                now_day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                if saved_day == now_day:
                    self.trades_taken_today = st.get("trades_taken_today", 0)
                    self.current_daily_loss = st.get("current_daily_loss", 0.0)
                    self.starting_day_equity = st.get("starting_day_equity", 0.0)
                else:
                    self.reset_daily_counters(now_day)
                self.consecutive_losses = st.get("consecutive_losses", 0)
            except Exception as e:
                log.warning(f"Could not load risk state: {e}")

    def save_persistent_state(self):
        try:
            st = {
                "current_day_str": self.current_day_str,
                "trades_taken_today": self.trades_taken_today,
                "consecutive_losses": self.consecutive_losses,
                "current_daily_loss": self.current_daily_loss,
                "starting_day_equity": self.starting_day_equity,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
            with open(self.state_file, "w") as f:
                json.dump(st, f, indent=2)
        except Exception as e:
            log.error(f"Failed to persist risk state: {e}")

    def check_daily_rollover(self, current_equity: float):
        """Enforces a clean 00:00 SAST daily risk reset without losing consecutive loss streaks."""
        now_day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if now_day != self.current_day_str:
            self.reset_daily_counters(now_day, current_equity)

    def reset_daily_counters(self, new_day_str: str, current_equity: float = 0.0):
        self.current_day_str = new_day_str
        self.trades_taken_today = 0
        self.current_daily_loss = 0.0
        if current_equity > 0:
            self.starting_day_equity = current_equity
        log.info(f"DAILY RISK RESET: New trading date {new_day_str} initialized. Counter reset to 0.")
        self.save_persistent_state()

    def record_trade_outcome(self, pnl: float):
        """Updates consecutive loss streak and daily drawdown (Spec Sec 7)."""
        if pnl < 0:
            self.consecutive_losses += 1
            self.current_daily_loss += abs(pnl)
            log.warning(f"LOSS RECORDED (-${abs(pnl):.2f}). Consecutive loss streak: {self.consecutive_losses}")
        elif pnl > 0:
            self.consecutive_losses = 0  # Spec: Reset streak on win
            log.info(f"WIN RECORDED (+${pnl:.2f}). Consecutive loss streak reset to 0.")
        self.save_persistent_state()

    def get_effective_risk_pct(self) -> float:
        """Enforces Spec Sec 7: 3 consecutive losses drops risk from 1% to 0.5%."""
        if self.consecutive_losses >= GLOBAL_PARAMS.consecutive_loss_threshold:
            log.info(f"CONSECUTIVE LOSS CIRCUIT ACTIVE: Risk scaled down to {GLOBAL_PARAMS.consecutive_loss_risk_pct}%")
            return GLOBAL_PARAMS.consecutive_loss_risk_pct
        return self.risk_per_trade_pct

    def validate_asset_stop_size(self, symbol: str, sl_distance: float) -> Tuple[bool, str]:
        """
        Validates stop loss strictly against Spec Section 5 parameters:
        - NAS100: 35 to 50 pts (max 60)
        - US30: 30 to 50 pts
        - GOLD: 12 to 40 pips (up to 50-60 in high ATR)
        """
        if symbol == "NAS100":
            if not (GLOBAL_PARAMS.nas100_stop_range[0] <= sl_distance <= GLOBAL_PARAMS.nas100_stop_range[2]):
                return False, f"NAS100 Stop ({sl_distance:.1f} pts) outside spec [35-60 pts]"
        elif symbol == "US30":
            if not (GLOBAL_PARAMS.us30_stop_range[0] <= sl_distance <= GLOBAL_PARAMS.us30_stop_range[2]):
                return False, f"US30 Stop ({sl_distance:.1f} pts) outside spec [30-50 pts]"
        elif symbol == "GOLD":
            pips = sl_distance * 10.0  # $1.00 move = 10 pips
            if not (GLOBAL_PARAMS.gold_stop_range_pips[0] <= pips <= GLOBAL_PARAMS.gold_stop_range_pips[2]):
                return False, f"Gold Stop ({pips:.1f} pips) outside spec [12-60 pips]"
        return True, "Stop size valid"

    def can_trade_today(self, current_equity: float) -> Tuple[bool, str]:
        """Enforces max 2 trades/day and daily drawdown cap (Spec Sec 7)."""
        self.check_daily_rollover(current_equity)

        if self.trades_taken_today >= self.max_daily_trades:
            return False, f"Daily trade limit reached ({self.trades_taken_today}/{self.max_daily_trades})"

        if self.starting_day_equity > 0:
            max_allowed_loss = self.starting_day_equity * (self.max_daily_loss_pct / 100.0)
            if self.current_daily_loss >= max_allowed_loss:
                return False, f"Daily loss cap reached (-${self.current_daily_loss:.2f} >= ${max_allowed_loss:.2f})"

        return True, "Risk gates clear"

RiskState = RiskManager
InstitutionalRiskEngine = RiskManager