"""
trading-portal/risk/risk_manager.py
Institutional Unified Risk Engine with Real-Time Multi-Period Drawdown
Throttling & Cashflow Adjustments.

CHANGES 2026-10-14 (round 2)
----------------------------
validate_min_lot_risk now uses an equity-banded tolerance and an
absolute equity ceiling, so small accounts can open GOLD and FX trades
whose min-lot cash risk exceeds the intended risk budget. Before this
change, every GOLD and FX setup was rejected as MIN_LOT_TOO_RISKY on
the 2026-10-14 run, producing zero trades on those pairs.

Bands (used when the absolute ceiling does not already approve the trade):
  equity < $50    -> tolerance 10.0x
  equity < $250   -> tolerance  5.0x
  equity < $1000  -> tolerance  3.0x
  otherwise       -> tolerance  2.0x

Absolute gate: a trade is always approved if its min-lot cash risk is
<= 50% of current equity. On a $10 account that permits any min-lot
trade under $5, which covers GOLD, EURUSD, GBPUSD and GERMAN30.

Everything else in this file is unchanged from the 2026-10-13 brief.
"""

import os
import json
import logging
import math
import tempfile
import pandas as pd
import numpy as np
from datetime import datetime, timezone, timedelta, time as dtime
from typing import Dict, Tuple, Optional, Any, List

try:
    from config.strategy_params import GLOBAL_PARAMS
    from core.session_config import TZ_SAST
except ImportError:
    import sys
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
    from core.session_config import GLOBAL_PARAMS, TZ_SAST

log = logging.getLogger("RiskManager")

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DATA_DIR = os.getenv("DATA_DIR", "").strip() or PROJECT_ROOT
os.makedirs(DATA_DIR, exist_ok=True)
RISK_STATE_FILE = os.getenv("RISK_STATE_FILE", os.path.join(DATA_DIR, "risk_state.json"))
TRADES_DB_FILE = os.path.join(DATA_DIR, "trades_db.json")

DEFAULT_PROFILE = "Max Growth"


RISK_PROFILES: Dict[str, Dict[str, Any]] = {
    "Steady": {
        "bands_zar": [500.0, 2000.0, 10000.0, 50000.0],
        "risk_pct_by_band": [5.0, 3.0, 2.0, 1.5, 1.0],
        "daily_loss_stop_pct": 5.0,
        "weekly_loss_stop_pct": 10.0,
        "monthly_loss_stop_pct": 15.0,
        "min_rr_floor": 1.0,
        "max_daily_trades": 2,
        "apply_dow_reduction": True,
    },
    "Balanced": {
        "bands_zar": [500.0, 2000.0, 10000.0, 50000.0],
        "risk_pct_by_band": [10.0, 6.0, 4.0, 3.0, 2.0],
        "daily_loss_stop_pct": 15.0,
        "weekly_loss_stop_pct": 25.0,
        "monthly_loss_stop_pct": 40.0,
        "min_rr_floor": 1.5,
        "max_daily_trades": 3,
        "apply_dow_reduction": True,
    },
    "Aggressive": {
        "bands_zar": [500.0, 2000.0, 10000.0, 50000.0],
        "risk_pct_by_band": [30.0, 15.0, 8.0, 5.0, 3.0],
        "daily_loss_stop_pct": 30.0,
        "weekly_loss_stop_pct": 50.0,
        "monthly_loss_stop_pct": 70.0,
        "min_rr_floor": 2.0,
        "max_daily_trades": 4,
        "apply_dow_reduction": False,
    },
    "Max Growth": {
        "bands_zar": [500.0, 2000.0, 10000.0, 50000.0],
        "risk_pct_by_band": [35.0, 25.0, 12.0, 6.0, 4.0],
        "daily_loss_stop_pct": 50.0,
        "weekly_loss_stop_pct": 70.0,
        "monthly_loss_stop_pct": 85.0,
        "min_rr_floor": 2.0,
        "max_daily_trades": 4,
        "apply_dow_reduction": False,
    },
}


def get_sast_session_date(now_utc: Optional[datetime] = None) -> str:
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)
    elif now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)
    now_sast = now_utc.astimezone(TZ_SAST)
    reset_hour = getattr(GLOBAL_PARAMS, 'daily_reset_hour_sast', 0)
    if now_sast.hour < reset_hour:
        now_sast -= timedelta(days=1)
    return now_sast.strftime("%Y-%m-%d")


def convert_equity_to_zar(current_equity: float, account_currency: Optional[str] = "USD", usd_zar_rate: Optional[float] = None) -> float:
    curr = (account_currency or "USD").upper()
    if curr == "ZAR":
        return current_equity
    rate = usd_zar_rate if (usd_zar_rate is not None and usd_zar_rate > 0) else 18.0
    if curr == "USD":
        return current_equity * rate
    elif curr == "EUR":
        return current_equity * 1.10 * rate
    elif curr == "GBP":
        return current_equity * 1.30 * rate
    return current_equity * rate


class RiskManager:
    def __init__(
        self,
        config_file: str = "bot_config.json",
        state_file: str = RISK_STATE_FILE,
        persist_state: bool = True,
    ):
        self.persist_state = bool(persist_state)

        if self.persist_state:
            self.config_file = config_file if os.path.isabs(config_file) else os.path.join(DATA_DIR, config_file)
            self.state_file = state_file
        else:
            self.config_file = os.path.join(DATA_DIR, "__never_exists_backtest__.json")
            self.state_file = None

        self.active_profile_name: Optional[str] = None
        self.active_profile: Optional[Dict[str, Any]] = None

        self.master_execution: bool = True
        self.dry_run: bool = False
        self.risk_per_trade_pct: float = getattr(GLOBAL_PARAMS, 'base_risk_per_trade_pct', 1.0)
        self.risk_to_reward: float = 2.0
        self.max_daily_trades: int = getattr(GLOBAL_PARAMS, 'max_daily_trades', 2)
        self.max_daily_loss_pct: float = getattr(GLOBAL_PARAMS, 'max_daily_loss_pct', 5.0)
        self.max_weekly_loss_pct: float = getattr(GLOBAL_PARAMS, 'max_weekly_loss_pct', 10.0)
        self.max_monthly_loss_pct: float = getattr(GLOBAL_PARAMS, 'max_monthly_loss_pct', 15.0)
        self.min_rr_floor: float = getattr(GLOBAL_PARAMS, 'min_rr', 1.0)

        self.use_profile_drawdown_pct: bool = True
        self.max_daily_loss_usd: float = getattr(GLOBAL_PARAMS, 'max_daily_loss_usd', 0.0)
        self.max_weekly_loss_usd: float = getattr(GLOBAL_PARAMS, 'max_weekly_loss_usd', 0.0)
        self.max_monthly_loss_usd: float = getattr(GLOBAL_PARAMS, 'max_monthly_loss_usd', 0.0)

        self.last_seen_currency: Optional[str] = None
        self.currency_tripped_at: Optional[str] = None
        self.breaker_action: str = 'HALT_PREVENT_NEW'
        self.breaker_triggered: bool = False
        self.breaker_halted_master: bool = False
        self.active_trip_scope: str = 'NONE'
        self.last_trigger_reason: Optional[str] = None

        now_utc = datetime.now(timezone.utc)
        now_sast = now_utc.astimezone(TZ_SAST)
        self.current_day_str: str = get_sast_session_date(now_utc)
        self.current_week_str: str = now_sast.strftime("%Y-W%W")
        self.current_month_str: str = now_sast.strftime("%Y-%m")

        self.starting_day_equity: float = 0.0
        self.starting_week_equity: float = 0.0
        self.starting_month_equity: float = 0.0
        self.last_known_balance: float = 0.0
        self.expected_balance: float = 0.0
        self.today_closed_profit: float = 0.0

        self.trades_taken_today: int = 0
        self.consecutive_losses: int = 0
        self.current_daily_loss: float = 0.0
        self.current_weekly_loss: float = 0.0
        self.current_monthly_loss: float = 0.0
        self.open_positions: Dict[str, dict] = {}

        self._bot_started_at_utc: datetime = now_utc

        if self.persist_state:
            self.sync_ui_config()
            self.rebuild_period_counters_from_history()

    # ------------------------------------------------------------------
    # Config
    # ------------------------------------------------------------------

    def sync_ui_config(self) -> None:
        if not self.persist_state:
            return
        if not os.path.exists(self.config_file):
            self._apply_auto_profile_if_needed({})
            return
        try:
            with open(self.config_file, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if not content:
                    return
                cfg = json.loads(content)

            self.master_execution = cfg.get("masterExecution", self.master_execution)
            self.dry_run = cfg.get("dryRun", self.dry_run)
            self.risk_per_trade_pct = float(cfg.get("riskPerTradePct", self.risk_per_trade_pct))
            self.risk_to_reward = float(cfg.get("riskToReward", self.risk_to_reward))

            prof_name = cfg.get("riskProfile")
            auto_profile = bool(cfg.get("autoProfile", True))

            if prof_name is None and auto_profile:
                prof_name = DEFAULT_PROFILE

            profile_is_active = prof_name in RISK_PROFILES

            if profile_is_active:
                self.active_profile_name = prof_name
                self.active_profile = RISK_PROFILES[prof_name]
                self.max_daily_trades = self.active_profile["max_daily_trades"]
                self.max_daily_loss_pct = self.active_profile["daily_loss_stop_pct"]
                self.min_rr_floor = self.active_profile["min_rr_floor"]
                self.max_weekly_loss_pct = self.active_profile["weekly_loss_stop_pct"]
                self.max_monthly_loss_pct = self.active_profile["monthly_loss_stop_pct"]
            else:
                self.active_profile_name = None
                self.active_profile = None
                self.max_daily_loss_pct = getattr(GLOBAL_PARAMS, 'max_daily_loss_pct', 5.0)
                self.max_weekly_loss_pct = getattr(GLOBAL_PARAMS, 'max_weekly_loss_pct', 10.0)
                self.max_monthly_loss_pct = getattr(GLOBAL_PARAMS, 'max_monthly_loss_pct', 15.0)
                if "maxDailyTrades" in cfg:
                    self.max_daily_trades = int(cfg["maxDailyTrades"])

            use_profile_pct = bool(cfg.get("useProfileDrawdownPct", True))
            self.use_profile_drawdown_pct = use_profile_pct

            raw_daily_usd = 0.0
            if "maxDailyLossUsd" in cfg:
                raw_daily_usd = float(cfg["maxDailyLossUsd"])
            elif "maxDailyLoss" in cfg:
                raw_daily_usd = float(cfg["maxDailyLoss"])

            raw_weekly_usd = 0.0
            if "maxWeeklyLossUsd" in cfg:
                raw_weekly_usd = float(cfg["maxWeeklyLossUsd"])
            elif "maxWeeklyLoss" in cfg:
                raw_weekly_usd = float(cfg["maxWeeklyLoss"])

            raw_monthly_usd = 0.0
            if "maxMonthlyLossUsd" in cfg:
                raw_monthly_usd = float(cfg["maxMonthlyLossUsd"])
            elif "maxMonthlyLoss" in cfg:
                raw_monthly_usd = float(cfg["maxMonthlyLoss"])

            if profile_is_active and use_profile_pct:
                self.max_daily_loss_usd = 0.0
                self.max_weekly_loss_usd = 0.0
                self.max_monthly_loss_usd = 0.0
            else:
                self.max_daily_loss_usd = raw_daily_usd
                self.max_weekly_loss_usd = raw_weekly_usd
                self.max_monthly_loss_usd = raw_monthly_usd

            self.breaker_action = cfg.get("breakerAction", self.breaker_action)

            limits_confirmed_at = cfg.get("limitsConfirmedAt")
            if self.active_trip_scope == 'CURRENCY' and self.breaker_triggered and limits_confirmed_at:
                if not self.currency_tripped_at or limits_confirmed_at >= self.currency_tripped_at:
                    self.breaker_triggered = False
                    self.active_trip_scope = 'NONE'
                    self.last_trigger_reason = None
                    self.master_execution = True
                    self.breaker_halted_master = False
                    self.save_persistent_state()
                    log.info("CURRENCY BREAKER CLEARED")
        except Exception as e:
            log.warning(f"Could not sync config from {self.config_file}: {e}")

    def _apply_auto_profile_if_needed(self, cfg: Dict[str, Any]) -> None:
        if not bool(cfg.get("autoProfile", True)):
            return
        if self.active_profile_name:
            return
        prof = DEFAULT_PROFILE
        if prof in RISK_PROFILES:
            self.active_profile_name = prof
            self.active_profile = RISK_PROFILES[prof]
            self.max_daily_trades = self.active_profile["max_daily_trades"]
            self.max_daily_loss_pct = self.active_profile["daily_loss_stop_pct"]
            self.min_rr_floor = self.active_profile["min_rr_floor"]
            self.max_weekly_loss_pct = self.active_profile["weekly_loss_stop_pct"]
            self.max_monthly_loss_pct = self.active_profile["monthly_loss_stop_pct"]

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def load_persistent_state(self):
        if not self.persist_state or not self.state_file:
            return
        if not os.path.exists(self.state_file):
            return
        try:
            with open(self.state_file, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if not content:
                    return
                st = json.loads(content)
            self.consecutive_losses = st.get("consecutive_losses", 0)
            self.current_week_str = st.get("current_week_str", self.current_week_str)
            self.current_month_str = st.get("current_month_str", self.current_month_str)
            self.starting_week_equity = st.get("starting_week_equity", 0.0)
            self.starting_month_equity = st.get("starting_month_equity", 0.0)
            self.current_weekly_loss = st.get("current_weekly_loss", 0.0)
            self.current_monthly_loss = st.get("current_monthly_loss", 0.0)
            self.last_seen_currency = st.get("last_seen_currency")
            self.currency_tripped_at = st.get("currency_tripped_at")
            self.breaker_triggered = st.get("breaker_triggered", False)
            self.breaker_halted_master = st.get("breaker_halted_master", False)
            self.active_trip_scope = st.get("active_trip_scope", "NONE")
            self.last_known_balance = st.get("last_known_balance", 0.0)
            self.expected_balance = st.get("expected_balance", self.last_known_balance)
            self.today_closed_profit = st.get("today_closed_profit", 0.0)
            saved_day = st.get("current_day_str")
            now_day = get_sast_session_date()
            if saved_day == now_day:
                self.current_day_str = saved_day
                self.trades_taken_today = st.get("trades_taken_today", 0)
                self.current_daily_loss = st.get("current_daily_loss", 0.0)
                self.starting_day_equity = st.get("starting_day_equity", 0.0)
            else:
                self.current_day_str = now_day
                self.trades_taken_today = 0
                self.current_daily_loss = 0.0
                self.today_closed_profit = 0.0
        except Exception as e:
            log.warning(f"Could not load risk state: {e}")

    def save_persistent_state(self):
        if not self.persist_state or not self.state_file:
            return
        try:
            st = {
                "current_day_str": self.current_day_str,
                "current_week_str": self.current_week_str,
                "current_month_str": self.current_month_str,
                "trades_taken_today": self.trades_taken_today,
                "consecutive_losses": self.consecutive_losses,
                "current_daily_loss": self.current_daily_loss,
                "current_weekly_loss": self.current_weekly_loss,
                "current_monthly_loss": self.current_monthly_loss,
                "starting_day_equity": self.starting_day_equity,
                "starting_week_equity": self.starting_week_equity,
                "starting_month_equity": self.starting_month_equity,
                "last_known_balance": self.last_known_balance,
                "expected_balance": self.expected_balance,
                "today_closed_profit": self.today_closed_profit,
                "last_seen_currency": self.last_seen_currency,
                "currency_tripped_at": self.currency_tripped_at,
                "breaker_triggered": self.breaker_triggered,
                "breaker_halted_master": self.breaker_halted_master,
                "active_trip_scope": self.active_trip_scope,
                "last_trigger_reason": self.last_trigger_reason,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
            dirname = os.path.dirname(self.state_file)
            os.makedirs(dirname, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(dir=dirname, prefix="tmp_risk_state_", suffix=".json")
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(st, f, indent=2)
            os.replace(tmp_path, self.state_file)
        except Exception as e:
            log.error(f"Failed to persist risk state: {e}")

    def check_currency_change(self, current_currency: Optional[str]):
        if not current_currency:
            return
        if self.last_seen_currency is not None and self.last_seen_currency != current_currency:
            trip_msg = f"Account currency changed ({self.last_seen_currency} -> {current_currency})."
            self.currency_tripped_at = datetime.now(timezone.utc).isoformat()
            self._trip_breaker('CURRENCY', trip_msg)
        self.last_seen_currency = current_currency
        self.save_persistent_state()

    # ------------------------------------------------------------------
    # Rollovers
    # ------------------------------------------------------------------

    def check_rollovers(self, current_equity: float, current_balance: float = 0.0, now_utc: Optional[datetime] = None):
        if now_utc is None:
            now_utc = datetime.now(timezone.utc)
        elif now_utc.tzinfo is None:
            now_utc = now_utc.replace(tzinfo=timezone.utc)

        now_day = get_sast_session_date(now_utc)
        now_sast = now_utc.astimezone(TZ_SAST)
        now_week = now_sast.strftime("%Y-W%W")
        now_month = now_sast.strftime("%Y-%m")

        if current_balance > 0 and self.persist_state:
            if self.last_known_balance == 0.0:
                self.last_known_balance = current_balance
                self.expected_balance = current_balance
            else:
                inferred_cashflow = current_balance - self.expected_balance
                noise_threshold = max(2.0, 0.002 * current_balance)
                if abs(inferred_cashflow) > noise_threshold:
                    self.starting_day_equity = max(0.0, self.starting_day_equity + inferred_cashflow)
                    self.starting_week_equity = max(0.0, self.starting_week_equity + inferred_cashflow)
                    self.starting_month_equity = max(0.0, self.starting_month_equity + inferred_cashflow)
                    self.expected_balance = current_balance
            self.last_known_balance = current_balance

        if now_day != self.current_day_str:
            self.current_day_str = now_day
            self.trades_taken_today = 0
            self.current_daily_loss = 0.0
            self.today_closed_profit = 0.0
            if current_equity > 0:
                self.starting_day_equity = current_equity
            if self.active_trip_scope == 'DAY':
                self.breaker_triggered = False
                self.active_trip_scope = 'NONE'
                if self.breaker_halted_master:
                    self.master_execution = True
                    self.breaker_halted_master = False

        if now_week != self.current_week_str:
            self.current_week_str = now_week
            self.current_weekly_loss = 0.0
            if current_equity > 0:
                self.starting_week_equity = current_equity
            if self.active_trip_scope == 'WEEK':
                self.breaker_triggered = False
                self.active_trip_scope = 'NONE'
                if self.breaker_halted_master:
                    self.master_execution = True
                    self.breaker_halted_master = False

        if now_month != self.current_month_str:
            self.current_month_str = now_month
            self.current_monthly_loss = 0.0
            if current_equity > 0:
                self.starting_month_equity = current_equity
            if self.active_trip_scope == 'MONTH':
                self.breaker_triggered = False
                self.active_trip_scope = 'NONE'
                if self.breaker_halted_master:
                    self.master_execution = True
                    self.breaker_halted_master = False

        if current_equity > 0:
            if self.starting_day_equity <= 0: self.starting_day_equity = current_equity
            if self.starting_week_equity <= 0: self.starting_week_equity = current_equity
            if self.starting_month_equity <= 0: self.starting_month_equity = current_equity

        self.save_persistent_state()

    # ------------------------------------------------------------------
    # Outcomes
    # ------------------------------------------------------------------

    def record_trade_outcome(self, pnl: float):
        self.expected_balance += pnl
        if pnl < 0:
            self.consecutive_losses += 1
            self.current_daily_loss += abs(pnl)
            self.current_weekly_loss += abs(pnl)
            self.current_monthly_loss += abs(pnl)
        elif pnl > 0:
            self.consecutive_losses = 0
            self.today_closed_profit += pnl
        self.save_persistent_state()

    def record_trade_outcome_scoped(self, pnl: float, closed_at_utc: Optional[datetime]) -> bool:
        if closed_at_utc is None:
            return False
        if closed_at_utc.tzinfo is None:
            closed_at_utc = closed_at_utc.replace(tzinfo=timezone.utc)
        startup = getattr(self, "_bot_started_at_utc", None)
        if startup is None:
            return False
        if startup.tzinfo is None:
            startup = startup.replace(tzinfo=timezone.utc)
        if closed_at_utc < startup:
            return False

        close_sast = closed_at_utc.astimezone(TZ_SAST)
        today_str = get_sast_session_date()
        week_str = close_sast.strftime("%Y-W%W")
        month_str = close_sast.strftime("%Y-%m")
        touched = False
        if pnl < 0:
            if close_sast.strftime("%Y-%m-%d") == today_str:
                self.current_daily_loss += abs(pnl); touched = True
            if week_str == self.current_week_str:
                self.current_weekly_loss += abs(pnl); touched = True
            if month_str == self.current_month_str:
                self.current_monthly_loss += abs(pnl); touched = True
            self.consecutive_losses += 1; touched = True
        elif pnl > 0:
            if close_sast.strftime("%Y-%m-%d") == today_str:
                self.today_closed_profit += pnl; touched = True
            self.consecutive_losses = 0; touched = True
        else:
            return False
        if touched:
            self.expected_balance += pnl
            self.save_persistent_state()
        return touched

    def rebuild_period_counters_from_history(self) -> None:
        if not self.persist_state:
            return
        try:
            if not os.path.exists(TRADES_DB_FILE):
                self.current_daily_loss = 0.0
                self.current_weekly_loss = 0.0
                self.current_monthly_loss = 0.0
                self.today_closed_profit = 0.0
                return
            with open(TRADES_DB_FILE, "r", encoding="utf-8") as f:
                content = f.read().strip()
            if not content:
                return
            rows = json.loads(content)
            if not isinstance(rows, list):
                return
            today_str = get_sast_session_date()
            day_loss = 0.0; week_loss = 0.0; month_loss = 0.0; today_profit = 0.0
            seen_tickets = set()
            for row in rows:
                if not isinstance(row, dict): continue
                ticket = str(row.get("ticket", "")).strip()
                if ticket:
                    if ticket in seen_tickets: continue
                    seen_tickets.add(ticket)
                close_time_str = row.get("closeTime")
                if not close_time_str or close_time_str == "OPEN": continue
                try:
                    close_dt = datetime.strptime(str(close_time_str), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                except (ValueError, TypeError):
                    continue
                close_sast = close_dt.astimezone(TZ_SAST)
                row_day = close_sast.strftime("%Y-%m-%d")
                row_week = close_sast.strftime("%Y-W%W")
                row_month = close_sast.strftime("%Y-%m")
                try:
                    pnl = float(row.get("pnl", 0.0) or 0.0)
                except (ValueError, TypeError):
                    pnl = 0.0
                if row_day == today_str:
                    if pnl < 0: day_loss += abs(pnl)
                    elif pnl > 0: today_profit += pnl
                if row_week == self.current_week_str and pnl < 0: week_loss += abs(pnl)
                if row_month == self.current_month_str and pnl < 0: month_loss += abs(pnl)
            self.current_daily_loss = round(day_loss, 4)
            self.current_weekly_loss = round(week_loss, 4)
            self.current_monthly_loss = round(month_loss, 4)
            self.today_closed_profit = round(today_profit, 4)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Sizing
    # ------------------------------------------------------------------

    def _get_profile_band_risk_pct(self, profile: Dict[str, Any], zar_equity: float) -> float:
        bands = profile["bands_zar"]
        risks = profile["risk_pct_by_band"]
        if zar_equity < bands[0]: return risks[0]
        if zar_equity < bands[1]: return risks[1]
        if zar_equity < bands[2]: return risks[2]
        if zar_equity < bands[3]: return risks[3]
        return risks[4]

    def combined_risk_pct(
        self,
        current_equity: float,
        dow_mult: float = 1.0,
        ai_factor: float = 1.0,
        account_currency: Optional[str] = "USD",
        usd_zar_rate: Optional[float] = None
    ) -> float:
        if self.breaker_triggered:
            return 0.0

        if self.active_profile is not None and not self.active_profile.get("apply_dow_reduction", True):
            dow_mult = 1.0

        if self.active_profile is None:
            micro_mode = getattr(GLOBAL_PARAMS, 'micro_account_mode', False)
            if micro_mode:
                if current_equity < 60.0: base_risk = getattr(GLOBAL_PARAMS, 'micro_account_risk_pct', 25.0)
                elif current_equity < 200.0: base_risk = 12.5
                elif current_equity < 1000.0: base_risk = 5.0
                else: base_risk = 1.0
            else:
                base_risk = self.risk_per_trade_pct
                max_ceiling = getattr(GLOBAL_PARAMS, 'max_risk_per_trade_pct', 2.0)
                if base_risk > max_ceiling: base_risk = max_ceiling
            loss_threshold = getattr(GLOBAL_PARAMS, 'consecutive_loss_threshold', 3)
            streak_mult = 0.5 if self.consecutive_losses >= loss_threshold else 1.0
            raw_mult = streak_mult * dow_mult * ai_factor
            mult_floor = getattr(GLOBAL_PARAMS, 'min_risk_multiplier_floor', 0.25)
            final_mult = max(raw_mult, mult_floor)
            return base_risk * final_mult

        zar_equity = convert_equity_to_zar(current_equity, account_currency, usd_zar_rate)
        profile_band_risk = self._get_profile_band_risk_pct(self.active_profile, zar_equity)

        streak_mult = 0.5 if self.consecutive_losses >= 2 else 1.0
        safe_ai_factor = min(1.0, max(0.5, ai_factor))

        weekly_mult = 1.0
        if self.starting_week_equity > 0:
            week_dd_pct = max(0.0, (self.starting_week_equity - current_equity) / self.starting_week_equity * 100.0)
            half_weekly_stop = self.max_weekly_loss_pct * 0.5
            hard_weekly_stop = self.max_weekly_loss_pct * 0.8
            if week_dd_pct >= hard_weekly_stop:
                weekly_mult = 0.0
            elif week_dd_pct >= half_weekly_stop:
                weekly_mult = 0.5

        recovery_mult = 1.0
        if (self.starting_week_equity > 0
                and current_equity > self.starting_week_equity
                and self.current_daily_loss <= 0.0):
            recovery_mult = 1.15

        base_multiplier = streak_mult * dow_mult * safe_ai_factor * weekly_mult * recovery_mult
        effective_profile_risk = profile_band_risk * max(0.0, base_multiplier)

        if effective_profile_risk <= 0.0:
            return 0.0

        nominal_risk_cash = current_equity * (effective_profile_risk / 100.0)

        if self.today_closed_profit > 0:
            house_money_allowance = 0.50 * self.today_closed_profit
            max_cash_cap = current_equity * (profile_band_risk / 100.0)
            nominal_risk_cash = min(max_cash_cap, nominal_risk_cash + house_money_allowance)

        effective_day_start = self.starting_day_equity if self.starting_day_equity > 0 else current_equity
        max_daily_usd = self.max_daily_loss_usd if self.max_daily_loss_usd > 0 else (
            effective_day_start * (self.active_profile["daily_loss_stop_pct"] / 100.0)
        )
        daily_dd_usd = max(0.0, effective_day_start - current_equity)
        remaining_daily_cash = max(0.0, max_daily_usd - daily_dd_usd)

        if remaining_daily_cash > 0:
            final_risk_cash = min(nominal_risk_cash, remaining_daily_cash)
        else:
            final_risk_cash = 0.0

        final_pct = (final_risk_cash / current_equity) * 100.0 if current_equity > 0 else 0.0
        return max(0.0, final_pct)

    def get_sizing_snapshot(self, current_equity, account_currency=None, usd_zar_rate=None):
        curr = (account_currency or "USD").upper()
        if self.active_profile is not None:
            zar_eq = convert_equity_to_zar(current_equity, curr, usd_zar_rate)
            cap_pct = self._get_profile_band_risk_pct(self.active_profile, zar_eq)
            profile_label = self.active_profile_name
        else:
            cap_pct = self.risk_per_trade_pct
            profile_label = "None (Legacy)"
        try:
            chosen_pct = self.combined_risk_pct(current_equity=current_equity, account_currency=curr, usd_zar_rate=usd_zar_rate)
        except Exception:
            chosen_pct = 0.0
        effective_day_start = self.starting_day_equity if self.starting_day_equity > 0 else current_equity
        if self.max_daily_loss_usd > 0:
            daily_max = self.max_daily_loss_usd
        elif self.active_profile is not None:
            daily_max = effective_day_start * (self.active_profile["daily_loss_stop_pct"] / 100.0)
        else:
            daily_max = effective_day_start * (self.max_daily_loss_pct / 100.0)
        daily_used = max(0.0, effective_day_start - current_equity)
        daily_left = max(0.0, daily_max - daily_used)
        return {
            "profile": profile_label, "cap_pct": round(cap_pct, 3),
            "chosen_pct": round(chosen_pct, 3),
            "daily_max": round(daily_max, 4), "daily_used": round(daily_used, 4),
            "daily_left": round(daily_left, 4),
            "trades_today": self.trades_taken_today, "max_daily_trades": self.max_daily_trades,
            "currency": curr,
        }

    def _min_lot_tolerance_for_equity(self, equity: float) -> float:
        """
        Equity-banded min-lot oversizing tolerance.

        Problem this solves (from the 2026-10-14 backtest):
        GOLD and every FX pair produced ZERO trades because the min-lot
        cash risk ($3.50 to $15 per 0.01 lot) always exceeded the
        intended risk budget ($0.50 on a $10 account using Steady,
        $3.50 using Max Growth). The tolerance was a fixed 1.2x to
        1.5x, so even a $10 account with Steady could not open a
        single FX trade.

        On a $10 account the min-lot oversizing is not a bug: it is a
        physical constraint of the broker. Either the bot takes the
        min-lot-sized trade or the account never trades FX at all.
        The bands below permit the oversizing on small accounts and
        tighten as the account grows, so a $10k account still refuses
        trades where the min-lot forces risk above ~2x the budget.
        """
        if equity < 50.0:
            return 10.0
        if equity < 250.0:
            return 5.0
        if equity < 1000.0:
            return 3.0
        return 2.0

    def validate_min_lot_risk(self, min_lots, risk_per_lot, risk_cash, equity=None):
        """
        Decide whether a min-lot-sized trade is acceptable.

        Two gates, either of which passes the trade:

          1. Absolute gate: min-lot cash risk <= 50% of current equity.
             On a $10 account any min-lot trade under $5 is accepted.
             This is what finally unblocks GOLD, EURUSD, GBPUSD and
             GERMAN30 on small accounts.

          2. Tolerance gate: min-lot cash risk <= tolerance * risk_cash.
             Tolerance bands by equity (see _min_lot_tolerance_for_equity).

        `equity` is optional. When omitted, the absolute gate is skipped
        and only the tolerance gate applies. Both the simulator and the
        live engine pass equity. The bare call signature is preserved so
        any existing caller works unchanged.
        """
        min_lot_cash_risk = float(min_lots) * float(risk_per_lot)

        if equity is not None and equity > 0:
            absolute_ceiling = 0.50 * float(equity)
            if min_lot_cash_risk <= absolute_ceiling:
                return True, (
                    f"Min lot risk ${min_lot_cash_risk:.2f} within absolute "
                    f"ceiling (50% of equity ${float(equity):.2f})"
                )

        equity_for_band = float(equity) if (equity is not None and equity > 0) else 1000.0
        tolerance = self._min_lot_tolerance_for_equity(equity_for_band)
        allowed_max = tolerance * float(risk_cash)

        if min_lot_cash_risk <= allowed_max:
            return True, (
                f"Min lot risk ${min_lot_cash_risk:.2f} within tolerance "
                f"({tolerance:.1f}x budget ${float(risk_cash):.2f} -> ${allowed_max:.2f})"
            )

        return False, (
            f"Min-Lot Risk Rejection: ${min_lot_cash_risk:.2f} > "
            f"${allowed_max:.2f} (tolerance {tolerance:.1f}x on "
            f"${float(risk_cash):.2f} budget, equity ${equity_for_band:.2f})"
        )

    def can_trade_today(self, current_equity: float, current_balance: float = 0.0) -> Tuple[bool, str]:
        self.sync_ui_config()
        self.check_rollovers(current_equity, current_balance)
        if not self.master_execution or self.breaker_triggered:
            return False, f"Circuit Breaker [{self.active_trip_scope}]: {self.last_trigger_reason or 'halted'}"
        if self.trades_taken_today >= self.max_daily_trades:
            return False, f"Daily trade limit ({self.trades_taken_today}/{self.max_daily_trades})"
        daily_loss_pct = self.active_profile["daily_loss_stop_pct"] if self.active_profile else self.max_daily_loss_pct
        daily_dd_usd = max(0.0, self.starting_day_equity - current_equity) if self.starting_day_equity > 0 else self.current_daily_loss
        max_daily_usd = self.max_daily_loss_usd if self.max_daily_loss_usd > 0 else (self.starting_day_equity * (daily_loss_pct / 100.0))
        if daily_dd_usd >= max_daily_usd and max_daily_usd > 0:
            self._trip_breaker('DAY', f"Daily DD breached")
            return False, self.last_trigger_reason
        weekly_dd_usd = max(0.0, self.starting_week_equity - current_equity) if self.starting_week_equity > 0 else self.current_weekly_loss
        max_weekly_usd = self.max_weekly_loss_usd if self.max_weekly_loss_usd > 0 else (self.starting_week_equity * (self.max_weekly_loss_pct / 100.0))
        if weekly_dd_usd >= max_weekly_usd and max_weekly_usd > 0:
            self._trip_breaker('WEEK', f"Weekly DD breached")
            return False, self.last_trigger_reason
        monthly_dd_usd = max(0.0, self.starting_month_equity - current_equity) if self.starting_month_equity > 0 else self.current_monthly_loss
        max_monthly_usd = self.max_monthly_loss_usd if self.max_monthly_loss_usd > 0 else (self.starting_month_equity * (self.max_monthly_loss_pct / 100.0))
        if monthly_dd_usd >= max_monthly_usd and max_monthly_usd > 0:
            self._trip_breaker('MONTH', f"Monthly DD breached")
            return False, self.last_trigger_reason
        return True, "Risk gates clear"

    def validate_asset_stop_size(self, symbol: str, sl_distance: float) -> Tuple[bool, str]:
        if symbol == "NAS100":
            if not (GLOBAL_PARAMS.nas100_stop_range[0] <= sl_distance <= GLOBAL_PARAMS.nas100_stop_range[2]):
                return False, f"NAS100 Stop outside spec"
        elif symbol == "US30":
            if not (GLOBAL_PARAMS.us30_stop_range[0] <= sl_distance <= GLOBAL_PARAMS.us30_stop_range[2]):
                return False, f"US30 Stop outside spec"
        elif symbol == "GOLD":
            pips = sl_distance * 10.0
            if not (GLOBAL_PARAMS.gold_stop_range_pips[0] <= pips <= GLOBAL_PARAMS.gold_stop_range_pips[2]):
                return False, f"Gold Stop outside spec"
        return True, "Stop size valid"

    def _trip_breaker(self, scope: str, reason: str):
        self.breaker_triggered = True
        self.active_trip_scope = scope
        self.last_trigger_reason = reason
        self.breaker_halted_master = True
        self.master_execution = False
        log.critical(f"CIRCUIT BREAKER [{scope}]: {reason}")
        self.save_persistent_state()

    # ------------------------------------------------------------------
    # Test helpers
    # ------------------------------------------------------------------

    def reset_daily_counters(self, date_str: str, current_equity: float = 0.0) -> None:
        self.current_day_str = date_str
        self.trades_taken_today = 0
        self.current_daily_loss = 0.0
        self.today_closed_profit = 0.0
        self.consecutive_losses = 0
        if current_equity > 0:
            self.starting_day_equity = current_equity
        self.save_persistent_state()

    def get_effective_risk_pct(self, current_equity: float = None) -> float:
        equity = current_equity if current_equity is not None else (self.starting_day_equity or 1000.0)
        try:
            return self.combined_risk_pct(current_equity=equity, dow_mult=1.0, ai_factor=1.0)
        except Exception:
            return float(self.risk_per_trade_pct)


RiskState = RiskManager
InstitutionalRiskEngine = RiskManager