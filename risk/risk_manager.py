"""
risk/risk_manager.py
Institutional Risk Management & Volatility Engine
"""

import os
import json
import logging
import pandas as pd
import numpy as np
from datetime import datetime, timezone, timedelta, time
from typing import Dict, Tuple, Optional, Set

log = logging.getLogger("RiskManager")

class RiskManager:
    def __init__(self, config_file: str = "bot_config.json"):
        self.config_file = config_file
        
        # UI Synced Controls
        self.master_execution: bool = True
        self.dry_run: bool = False                 # Dry-run simulator mode
        self.risk_per_trade_pct: float = 1.0       # 1.0% risk per trade
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
        self.open_positions: Dict[str, dict] = {}   # ticket -> position info

        # Spread Gate Thresholds
        self.max_spread_to_sl_ratio: float = 0.15
        self.max_absolute_spread = {
            "frxXAUUSD": 0.50,
            "US30": 4.5,
            "NAS100": 2.5,
            "GERMAN30": 3.0,
            "frxEURUSD": 0.0003,
            "frxUSDJPY": 0.035,
            "frxGBPUSD": 0.00035
        }

        # Sector Correlation Grouping (Max 1 open position per sector)
        self.SECTOR_MAP = {
            "US30": "EQUITY_INDEX",
            "NAS100": "EQUITY_INDEX",
            "GERMAN30": "EQUITY_INDEX",
            "frxXAUUSD": "PRECIOUS_METAL",
            "GOLD": "PRECIOUS_METAL",
            "frxEURUSD": "FOREX_MAJORS",
            "frxGBPUSD": "FOREX_MAJORS",
            "frxUSDJPY": "FOREX_MAJORS"
        }

        # High-Impact Macro Schedule (UTC times: 15m blackout before & after)
        self.MACRO_BLACKOUT_WINDOWS = [
            # NFP / US CPI / Retail Sales recurring windows (12:30 - 13:00 UTC)
            (time(12, 15), time(13, 15)),
            # FOMC Rate Decision & Presser (18:00 - 19:30 UTC)
            (time(17, 45), time(19, 45)),
            # London Session Open Liquidity Rush (05:45 - 06:15 UTC)
            (time(5, 45), time(6, 15))
        ]

    # =========================================================================
    # 1. READ UI CONTROLS IN REAL TIME
    # =========================================================================
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
        except Exception as e:
            log.warning(f"Error parsing {self.config_file}: {e}")

    # =========================================================================
    # 2. MACRO NEWS & SECTOR CORRELATION GATES
    # =========================================================================
    def is_macro_news_blackout(self) -> Tuple[bool, str]:
        now_utc = datetime.now(timezone.utc).time()
        for start, end in self.MACRO_BLACKOUT_WINDOWS:
            if start <= now_utc <= end:
                return True, f"High-Impact Macro Event window active ({start.strftime('%H:%M')} - {end.strftime('%H:%M')} UTC). Trading paused."
        return False, ""

    def check_sector_exposure(self, symbol: str) -> Tuple[bool, str]:
        sector = self.SECTOR_MAP.get(symbol, "OTHER")
        for ticket, pos in self.open_positions.items():
            open_sym = pos.get("symbol", "")
            if self.SECTOR_MAP.get(open_sym) == sector:
                return False, f"Sector limit reached: An open trade already exists in {sector} ({open_sym})."
        return True, ""

    # =========================================================================
    # 3. 80% R:R BREAK-EVEN POSITION SUPERVISOR
    # =========================================================================
    def check_breakeven_trigger(self, entry: float, sl: float, tp: float, current_price: float, direction: str) -> bool:
        """
        Returns True if price has reached 80% of the distance from entry to Take Profit.
        """
        total_target_distance = abs(tp - entry)
        if total_target_distance <= 0:
            return False

        if direction.upper() == "BUY":
            current_progress = current_price - entry
        else:
            current_progress = entry - current_price

        progress_ratio = current_progress / total_target_distance
        return progress_ratio >= 0.80

    # =========================================================================
    # 4. MULTI-TF CANDLE SIZES & RANGE DETECTION
    # =========================================================================
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

    # =========================================================================
    # 5. SPREAD GATE & AUTO LOT SIZING
    # =========================================================================
    def evaluate_spread(self, symbol: str, current_bid: float, current_ask: float, sl_distance: float) -> Tuple[bool, str, float]:
        spread = abs(current_ask - current_bid)
        max_allowed = self.max_absolute_spread.get(symbol, 5.0)
        
        if spread > max_allowed:
            return False, f"Spread ({spread:.4f}) exceeds threshold ({max_allowed:.4f})", spread

        if sl_distance > 0 and (spread / sl_distance) > self.max_spread_to_sl_ratio:
            return False, f"Spread is {(spread/sl_distance)*100:.1f}% of SL distance (Max allowed: {self.max_spread_to_sl_ratio*100:.0f}%)", spread

        return True, "Spread optimal", spread

    def calculate_lot_size(self, current_equity: float, sl_distance: float, point_value: float, min_stake: float, max_stake: float) -> float:
        """
        Dynamic Drawdown-Adaptive Position Sizing & Buffer Budgeting Engine:
        1. Evaluates percentage of weekly and daily loss budgets consumed.
        2. Gradually tapers risk (100% -> 50% -> 25% -> 10% survival mode).
        3. Uses runway cap to guarantee remaining buffer is never wiped out in a single trade.
        4. Scales stake based on exact stop-loss distance and point value.
        """
        equity = current_equity if current_equity > 0 else 10051.99
        active_risk_pct = self.risk_per_trade_pct

        # 1. Consecutive Loss Protection
        if self.consecutive_losses >= 3:
            active_risk_pct = active_risk_pct * 0.5
            log.info(f"CONSECUTIVE LOSS CIRCUIT: Risk halved to {active_risk_pct:.2f}%")

        # 2. Dynamic Weekly Buffer Budgeting (Graduated Safety Ramp)
        if self.max_weekly_loss_usd > 0:
            weekly_used_ratio = self.current_weekly_loss / self.max_weekly_loss_usd
            remaining_weekly_buffer = max(0.0, self.max_weekly_loss_usd - self.current_weekly_loss)

            if weekly_used_ratio >= 0.90:
                active_risk_pct = min(active_risk_pct, 0.10)   # Survival Zone (0.10% micro-risk)
                log.warning(f"DRAWDOWN TAPER: 90%+ weekly budget used ({weekly_used_ratio*100:.1f}%). Survival risk: {active_risk_pct:.2f}%")
            elif weekly_used_ratio >= 0.75:
                active_risk_pct = min(active_risk_pct, 0.25)   # Taper Zone (0.25% risk)
                log.warning(f"DRAWDOWN TAPER: 75%+ weekly budget used ({weekly_used_ratio*100:.1f}%). Scaled risk: {active_risk_pct:.2f}%")
            elif weekly_used_ratio >= 0.50:
                active_risk_pct = min(active_risk_pct, 0.50)   # Caution Zone (0.50% risk)
                log.info(f"DRAWDOWN TAPER: 50%+ weekly budget used ({weekly_used_ratio*100:.1f}%). Scaled risk: {active_risk_pct:.2f}%")

            # Runway Cap: Never risk more than 1/4th of remaining weekly room on one trade
            max_weekly_allowed_dollars = remaining_weekly_buffer / 4.0 if remaining_weekly_buffer > 0 else 0.0
        else:
            max_weekly_allowed_dollars = float('inf')

        # 3. Dynamic Daily Buffer Budgeting
        if self.max_daily_loss_usd > 0:
            remaining_daily_buffer = max(0.0, self.max_daily_loss_usd - self.current_daily_loss)
            # Never risk more than 1/2 of remaining daily room on one trade
            max_daily_allowed_dollars = remaining_daily_buffer / 2.0 if remaining_daily_buffer > 0 else 0.0
        else:
            max_daily_allowed_dollars = float('inf')

        # Baseline percentage risk in dollars
        base_risk_dollars = equity * (active_risk_pct / 100.0)

        # Cap dollar risk by the tightest remaining runway budget
        final_risk_dollars = min(base_risk_dollars, max_weekly_allowed_dollars, max_daily_allowed_dollars)

        # Calculate exact stake matching stop loss distance
        denom = sl_distance * point_value
        calculated_stake = (final_risk_dollars / denom) if denom > 0 else min_stake

        return round(max(min(calculated_stake, max_stake), min_stake), 2)

    # =========================================================================
    # 6. MASTER PRE-TRADE GATE
    # =========================================================================
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

        # Macro News Blackout Gate
        in_blackout, news_msg = self.is_macro_news_blackout()
        if in_blackout:
            return False, news_msg, {}

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