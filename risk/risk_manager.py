"""
risk/risk_manager.py
Institutional Risk Management & Volatility Engine with "News Armor"
"""

import os
import json
import logging
import pandas as pd
import numpy as np
from datetime import datetime, timezone, time as dtime
from typing import Dict, Tuple, Optional

log = logging.getLogger("RiskManager")

class RiskManager:
    def __init__(self, config_file: str = "bot_config.json"):
        self.config_file = config_file
        
        # UI Synced Controls
        self.master_execution: bool = True
        self.dry_run: bool = False
        self.risk_per_trade_pct: float = 1.0       # 1.0% base risk
        self.risk_to_reward: float = 2.0           # 1 : 2 default target
        self.max_daily_trades: int = 4
        self.max_daily_loss_usd: float = 2500.0
        self.max_weekly_loss_usd: float = 6500.0
        self.max_monthly_loss_usd: float = 15000.0
        
        # Operational State
        self.trades_taken_today: int = 0
        self.consecutive_losses: int = 0
        self.current_daily_loss: float = 0.0
        self.current_weekly_loss: float = 0.0
        self.current_monthly_loss: float = 0.0
        self.open_positions: Dict[str, dict] = {}

        # Weekly Growth Goal Engine
        self.weekly_deposit_baseline: float = 0.0
        self.weekly_goal_target: float = 0.0

        # Spread Gate Thresholds
        self.max_spread_to_sl_ratio: float = 0.15
        self.max_absolute_spread = {
            "frxXAUUSD": 0.50,
            "OTC_DJI": 4.5,
            "OTC_NDX": 2.5,
            "OTC_GDAXI": 3.0,
            "frxEURUSD": 0.0003,
            "frxUSDJPY": 0.035,
            "frxGBPUSD": 0.00035
        }

        # Sector Correlation Grouping (Max 1 open position per sector)
        self.SECTOR_MAP = {
            "OTC_DJI": "EQUITY_INDEX",
            "OTC_NDX": "EQUITY_INDEX",
            "OTC_GDAXI": "EQUITY_INDEX",
            "frxXAUUSD": "PRECIOUS_METAL",
            "GOLD": "PRECIOUS_METAL",
            "frxEURUSD": "FOREX_MAJORS",
            "frxGBPUSD": "FOREX_MAJORS",
            "frxUSDJPY": "FOREX_MAJORS"
        }

        # Targeted Red-Folder Windows (Only high-impact NFP/CPI releases: 5 min before & after)
        # Note: We do NOT block trading; we apply "News Armor" (cut size by 50% & require tight spread)
        self.RED_FOLDER_WINDOWS = [
            (dtime(12, 25), dtime(12, 35)),  # US CPI / NFP release window (12:30 UTC)
            (dtime(17, 55), dtime(18, 05))   # FOMC Rate Decision announcement (18:00 UTC)
        ]

    def sync_ui_config(self) -> None:
        if not os.path.exists(self.config_file):
            return
        try:
            with open(self.config_file, "r") as f:
                cfg = json.load(f)
            self.master_execution = cfg.get("masterExecution", self.master_execution)
            self.dry_run = cfg.get("dryRun", self.dry_run)
            self.risk_per_trade_pct = float(cfg.get("riskPerTradePct", self.risk_per_trade_pct))
            self.risk_to_reward = float(cfg.get("riskToReward", self.risk_to_reward))
            self.max_daily_trades = int(cfg.get("maxDailyTrades", self.max_daily_trades))
            self.max_daily_loss_usd = float(cfg.get("maxDailyLoss", cfg.get("maxDailyLossUsd", self.max_daily_loss_usd)))
            self.max_weekly_loss_usd = float(cfg.get("maxWeeklyLoss", cfg.get("maxWeeklyLossUsd", self.max_weekly_loss_usd)))
            self.max_monthly_loss_usd = float(cfg.get("maxMonthlyLoss", cfg.get("maxMonthlyLossUsd", self.max_monthly_loss_usd)))
            # Read Weekly Growth Goal targets from UI
            self.weekly_deposit_baseline = float(cfg.get("weeklyDepositBaseline", self.weekly_deposit_baseline))
            self.weekly_goal_target = float(cfg.get("weeklyGoalTarget", self.weekly_goal_target))
            log.warning(f"Error parsing {self.config_file}: {e}")

    def is_red_folder_active(self) -> bool:
        """Checks if current time is inside a high-impact red folder release window."""
        now_utc = datetime.now(timezone.utc).time()
        for start, end in self.RED_FOLDER_WINDOWS:
            if start <= now_utc <= end:
                return True
        return False

    def check_sector_exposure(self, symbol: str) -> Tuple[bool, str]:
        sector = self.SECTOR_MAP.get(symbol, "OTHER")
        for ticket, pos in self.open_positions.items():
            open_sym = pos.get("symbol", "")
            if self.SECTOR_MAP.get(open_sym) == sector:
                return False, f"Sector limit: An open trade already exists in {sector} ({open_sym})."
        return True, ""

    def check_breakeven_trigger(self, entry: float, sl: float, tp: float, current_price: float, direction: str) -> bool:
        total_target_distance = abs(tp - entry)
        if total_target_distance <= 0:
            return False

        if direction.upper() == "BUY":
            current_progress = current_price - entry
        else:
            current_progress = entry - current_price

        progress_ratio = current_progress / total_target_distance
        return progress_ratio >= 0.80

    @staticmethod
    def calculate_candle_metrics(m5_df: pd.DataFrame, h4_df: pd.DataFrame, d1_df: pd.DataFrame) -> dict:
        def get_atr(df: pd.DataFrame, period: int = 14) -> float:
            if df is None or df.empty or len(df) < 2:
                return 0.0
            high_low = df['high'] - df['low']
            high_close = (df['high'] - df['close'].shift(1)).abs()
            low_close = (df['low'] - df['close'].shift(1)).abs()
            tr = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)
            return float(tr.tail(period).mean())

        m5_avg = get_atr(m5_df, 14)
        h4_avg = get_atr(h4_df, 14)
        d1_avg = get_atr(d1_df, 14)

        is_ranging = False
        range_high, range_low, range_span = 0.0, 0.0, 0.0

        if m5_df is not None and len(m5_df) >= 20:
            recent_20 = m5_df.tail(20)
            range_high = float(recent_20['high'].max())
            range_low = float(recent_20['low'].min())
            range_span = range_high - range_low
            if m5_avg > 0 and range_span < (m5_avg * 2.5):
                is_ranging = True

        return {
            "m5_candle_avg": round(m5_avg, 4),
            "h4_candle_avg": round(h4_avg, 4),
            "d1_candle_avg": round(d1_avg, 4),
            "is_ranging": is_ranging,
            "range_high": round(range_high, 4),
            "range_low": round(range_low, 4),
            "range_span": round(range_span, 4),
        }

    def evaluate_spread(self, symbol: str, current_bid: float, current_ask: float, sl_distance: float) -> Tuple[bool, str, float]:
        spread = abs(current_ask - current_bid)
        max_allowed = self.max_absolute_spread.get(symbol, 5.0)
        
        # News protection: During high-impact news, spreads blow out. If spread is too wide, pause.
        if spread > max_allowed:
            return False, f"Spread ({spread:.4f}) exceeds safety ceiling ({max_allowed:.4f})", spread

        if sl_distance > 0 and (spread / sl_distance) > self.max_spread_to_sl_ratio:
            return False, f"Spread is {(spread/sl_distance)*100:.1f}% of SL distance (Max allowed: {self.max_spread_to_sl_ratio*100:.0f}%)", spread

        return True, "Spread optimal", spread

    def calculate_lot_size(self, current_equity: float, sl_distance: float, point_value: float, min_stake: float, max_stake: float) -> float:
        """
        Adapts dynamically to ANY account size:
        - Micro-Account Mode (R100 / $5-$10): Uses broker min stake to build small deposits.
        - Goal Shield: When weekly target is 90%+ reached, cuts risk in half to protect gains.
        """
        equity = current_equity if current_equity > 0 else 10051.99
        active_risk_pct = self.risk_per_trade_pct

        # 1. Weekly Goal Shield (Lock in profits when goal is almost reached)
        if self.weekly_goal_target > 0 and self.weekly_deposit_baseline > 0:
            target_gain = self.weekly_goal_target - self.weekly_deposit_baseline
            current_gain = equity - self.weekly_deposit_baseline
            if target_gain > 0 and (current_gain / target_gain) >= 0.90:
                active_risk_pct = active_risk_pct * 0.5
                log.info(f"CAPITAL SHIELD ENGAGED: 90%+ of Weekly Goal achieved! Risk halved to {active_risk_pct:.2f}% to lock in gains.")

        # 2. Consecutive Loss Protection
        if self.consecutive_losses >= 3:
            active_risk_pct = active_risk_pct * 0.5
            log.info(f"CONSECUTIVE LOSS CIRCUIT: Risk halved to {active_risk_pct:.2f}%")

        # 3. News Armor
        if self.is_red_folder_active():
            active_risk_pct = active_risk_pct * 0.5

        # 4. Weekly & Daily Buffer Budgeting
        if self.max_weekly_loss_usd > 0:
            weekly_used_ratio = self.current_weekly_loss / self.max_weekly_loss_usd
            remaining_weekly_buffer = max(0.0, self.max_weekly_loss_usd - self.current_weekly_loss)
            if weekly_used_ratio >= 0.75:
                active_risk_pct = min(active_risk_pct, 0.25)
            elif weekly_used_ratio >= 0.50:
                active_risk_pct = min(active_risk_pct, 0.50)
            max_weekly_allowed_dollars = remaining_weekly_buffer / 4.0 if remaining_weekly_buffer > 0 else 0.0
        else:
            max_weekly_allowed_dollars = float('inf')

        base_risk_dollars = equity * (active_risk_pct / 100.0)
        final_risk_dollars = min(base_risk_dollars, max_weekly_allowed_dollars)

        # 5. Micro-Account Scaling
        # If account is small (R100 / $5 - $10) and standard % yields less than min_stake:
        denom = sl_distance * point_value
        calculated_stake = (final_risk_dollars / denom) if denom > 0 else min_stake

        # Micro-Account Growth Rule:
        # If balance is small but greater than min_stake, allow min_stake so the account can grow!
        if calculated_stake < min_stake and equity >= min_stake:
            log.info(f"MICRO-ACCOUNT GROWTH MODE: Balance is small ({equity:.2f}). Floor stake set to broker minimum ({min_stake}).")
            calculated_stake = min_stake

        return round(max(min(calculated_stake, max_stake), min_stake), 2)

        # Consecutive loss protection
        if self.consecutive_losses >= 3:
            active_risk_pct = active_risk_pct * 0.5
            log.info(f"CONSECUTIVE LOSS CIRCUIT: Risk halved to {active_risk_pct:.2f}%")

        # News Armor: If trading during a red-folder event, halve risk to protect against slippage
        if self.is_red_folder_active():
            active_risk_pct = active_risk_pct * 0.5
            log.info(f"NEWS ARMOR ENGAGED: Red folder window active. Risk halved to {active_risk_pct:.2f}% to absorb volatility.")

        # Weekly Buffer Budgeting
        if self.max_weekly_loss_usd > 0:
            weekly_used_ratio = self.current_weekly_loss / self.max_weekly_loss_usd
            remaining_weekly_buffer = max(0.0, self.max_weekly_loss_usd - self.current_weekly_loss)

            if weekly_used_ratio >= 0.90:
                active_risk_pct = min(active_risk_pct, 0.10)
            elif weekly_used_ratio >= 0.75:
                active_risk_pct = min(active_risk_pct, 0.25)
            elif weekly_used_ratio >= 0.50:
                active_risk_pct = min(active_risk_pct, 0.50)

            max_weekly_allowed_dollars = remaining_weekly_buffer / 4.0 if remaining_weekly_buffer > 0 else 0.0
        else:
            max_weekly_allowed_dollars = float('inf')

        # Daily Buffer Budgeting
        if self.max_daily_loss_usd > 0:
            remaining_daily_buffer = max(0.0, self.max_daily_loss_usd - self.current_daily_loss)
            max_daily_allowed_dollars = remaining_daily_buffer / 2.0 if remaining_daily_buffer > 0 else 0.0
        else:
            max_daily_allowed_dollars = float('inf')

        base_risk_dollars = equity * (active_risk_pct / 100.0)
        final_risk_dollars = min(base_risk_dollars, max_weekly_allowed_dollars, max_daily_allowed_dollars)
        denom = sl_distance * point_value
        calculated_stake = (final_risk_dollars / denom) if denom > 0 else min_stake

        return round(max(min(calculated_stake, max_stake), min_stake), 2)

    def validate_pre_trade(
        self,
        symbol: str,
        direction: str,
        entry_price: float,
        stop_loss: float,
        take_profit: float,
        current_bid: float,
        current_ask: float,
        current_equity: float,
        point_value: float,
        min_stake: float,
        max_stake: float
    ) -> Tuple[bool, str, dict]:
        self.sync_ui_config()

        if not self.master_execution:
            return False, "Master execution switch is OFF in UI", {}

        # Sector Correlation Limit Gate
        sector_ok, sector_msg = self.check_sector_exposure(symbol)
        if not sector_ok:
            return False, sector_msg, {}

        # Ceilings
        if self.current_daily_loss >= self.max_daily_loss_usd:
            return False, f"Daily loss ceiling breached (-${self.current_daily_loss:.2f})", {}
        if self.current_weekly_loss >= self.max_weekly_loss_usd:
            return False, f"Weekly loss ceiling breached (-${self.current_weekly_loss:.2f})", {}
        if self.current_monthly_loss >= self.max_monthly_loss_usd:
            return False, f"Monthly loss ceiling breached (-${self.current_monthly_loss:.2f})", {}
        if self.trades_taken_today >= self.max_daily_trades:
            return False, f"Daily trade quota reached ({self.trades_taken_today}/{self.max_daily_trades})", {}

        sl_distance = abs(entry_price - stop_loss)
        if sl_distance <= 0:
            return False, "Invalid Stop Loss distance", {}

        final_tp = take_profit
        if final_tp is None or final_tp == 0:
            target_distance = sl_distance * self.risk_to_reward
            final_tp = (entry_price + target_distance) if direction.upper() == "BUY" else (entry_price - target_distance)

        # Spread Gate (Primary shield during news volatility)
        spread_ok, spread_msg, spread_pts = self.evaluate_spread(symbol, current_bid, current_ask, sl_distance)
        if not spread_ok:
            return False, f"Spread Gate Rejection: {spread_msg}", {}

        adjusted_sl = (stop_loss - spread_pts) if direction.upper() == "BUY" else (stop_loss + spread_pts)
        stake = self.calculate_lot_size(current_equity, sl_distance, point_value, min_stake, max_stake)
        if stake <= 0:
            return False, "Calculated stake is 0", {}

        blueprint = {
            "symbol": symbol,
            "direction": direction.upper(),
            "stake": stake,
            "entry_price": entry_price,
            "stop_loss": round(adjusted_sl, 4),
            "take_profit": round(final_tp, 4),
            "spread_points": round(spread_pts, 4),
            "is_dry_run": self.dry_run
        }
        return True, "Approved", blueprint

RiskState = RiskManager
InstitutionalRiskEngine = RiskManager