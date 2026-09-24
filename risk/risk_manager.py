"""
risk/risk_manager.py
Institutional Risk Management & Volatility Engine
"""

import os
import json
import logging
import pandas as pd
import numpy as np
from datetime import datetime, timezone
from typing import Dict, Tuple, Optional

log = logging.getLogger("RiskManager")

class RiskManager:
    def __init__(self, config_file: str = "bot_config.json"):
        self.config_file = config_file
        
        # Default fallback limits (overwritten dynamically by bot_config.json from UI)
        self.master_execution: bool = True
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
        self.last_reset_day: int = datetime.now(timezone.utc).day

        # Maximum spread allowed as percentage of the trade's Stop Loss distance
        # e.g., If stop loss is 40 points, spread cannot exceed 15% (6 points)
        self.max_spread_to_sl_ratio: float = 0.15

        # Asset-specific spread absolute caps (in points/pips)
        self.max_absolute_spread = {
            "frxXAUUSD": 0.50,   # Gold: max $0.50 spread
            "US30": 4.5,         # US30: max 4.5 points
            "NAS100": 2.5,       # Nasdaq: max 2.5 points
            "GERMAN30": 3.0,     # DAX: max 3.0 points
            "frxEURUSD": 0.0003, # EUR/USD: max 3 pips
            "frxUSDJPY": 0.035,  # USD/JPY: max 3.5 pips
            "frxGBPUSD": 0.00035 # GBP/USD: max 3.5 pips
        }

    # =========================================================================
    # 1. READ UI CONTROLS IN REAL TIME (FROM YOUR DASHBOARD SLIDERS)
    # =========================================================================
    def sync_ui_config(self) -> None:
        """Reads dynamic settings pushed by the React UI into bot_config.json."""
        if not os.path.exists(self.config_file):
            return

        try:
            with open(self.config_file, "r") as f:
                cfg = json.load(f)

            self.master_execution = cfg.get("masterExecution", self.master_execution)
            self.risk_per_trade_pct = float(cfg.get("riskPerTradePct", self.risk_per_trade_pct))
            self.risk_to_reward = float(cfg.get("riskToReward", self.risk_to_reward))
            self.max_daily_trades = int(cfg.get("maxDailyTrades", self.max_daily_trades))
            
            # Loss ceilings set on Advanced Limits screen
            self.max_daily_loss_usd = float(cfg.get("maxDailyLoss", cfg.get("maxDailyLossUsd", self.max_daily_loss_usd)))
            self.max_weekly_loss_usd = float(cfg.get("maxWeeklyLoss", cfg.get("maxWeeklyLossUsd", self.max_weekly_loss_usd)))
            self.max_monthly_loss_usd = float(cfg.get("maxMonthlyLoss", cfg.get("maxMonthlyLossUsd", self.max_monthly_loss_usd)))

        except Exception as e:
            log.warning(f"Could not parse {self.config_file}: {e}")

    # =========================================================================
    # 2. CANDLE AVERAGE SIZES & RANGE DETECTION (M5, H4, D1)
    # =========================================================================
    @staticmethod
    def calculate_candle_metrics(m5_df: pd.DataFrame, h4_df: pd.DataFrame, d1_df: pd.DataFrame) -> dict:
        """
        Calculates:
          - Average 5-Minute candle size (M5 ATR)
          - Average 4-Hourly candle size (H4 ATR)
          - Average Daily candle size (D1 ATR)
          - Range bounds and whether market is consolidating
        """
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

        # Range detection: Analyze high-low span over recent 20 periods on M5
        is_ranging = False
        range_high = 0.0
        range_low = 0.0
        range_span = 0.0

        if m5_df is not None and len(m5_df) >= 20:
            recent_20 = m5_df.tail(20)
            range_high = float(recent_20['high'].max())
            range_low = float(recent_20['low'].min())
            range_span = range_high - range_low
            
            # If the entire 20-candle span is smaller than 2.5x the average M5 candle, price is in consolidation
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
    # 3. SPREAD GATEKEEPER & SL/TP SPREAD ADJUSTMENT
    # =========================================================================
    def evaluate_spread(self, symbol: str, current_bid: float, current_ask: float, sl_distance: float) -> Tuple[bool, str, float]:
        """
        Calculates spread in points and verifies if it is within institutional limits.
        Returns: (is_allowed, reason, spread_points)
        """
        spread = abs(current_ask - current_bid)
        
        # Check against absolute asset maximum limit
        max_allowed_spread = self.max_absolute_spread.get(symbol, 5.0)
        if spread > max_allowed_spread:
            return False, f"Spread ({spread:.4f}) exceeds asset max threshold ({max_allowed_spread:.4f})", spread

        # Check against Stop Loss ratio (spread cannot consume more than 15% of your SL)
        if sl_distance > 0:
            spread_ratio = spread / sl_distance
            if spread_ratio > self.max_spread_to_sl_ratio:
                return False, f"Spread is {spread_ratio*100:.1f}% of SL distance (Max allowed is {self.max_spread_to_sl_ratio*100:.0f}%)", spread

        return True, "Spread is optimal", spread

    # =========================================================================
    # 4. AUTO POSITION / LOT SIZING FORMULA
    # =========================================================================
    def calculate_lot_size(self, current_equity: float, sl_distance: float, point_value: float, min_stake: float, max_stake: float) -> float:
        """
        Dynamically sizes the trade based on account equity and exact stop loss distance:
        Risk $ = Account Equity * (Risk % / 100)
        Stake = Risk $ / (SL distance * point_value)
        """
        if current_equity <= 0 or sl_distance <= 0:
            return 0.0

        # Enforce consecutive loss protection:
        # If the bot loses 3 trades in a row, temporarily reduce risk by 50%
        active_risk_pct = self.risk_per_trade_pct
        if self.consecutive_losses >= 3:
            active_risk_pct = self.risk_per_trade_pct * 0.5
            log.info(f"CONSECUTIVE LOSS PROTECTION: Risk reduced from {self.risk_per_trade_pct}% to {active_risk_pct:.2f}%")

        risk_dollars = current_equity * (active_risk_pct / 100.0)

        # Calculate position size directly linked to stop-loss distance
        calculated_stake = risk_dollars / (sl_distance * point_value)
        
        # Bound within broker parameters
        final_stake = max(min(calculated_stake, max_stake), min_stake)
        return round(final_stake, 2)

    # =========================================================================
    # 5. MASTER PRE-TRADE EVALUATION GATE
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
        """
        Comprehensive pre-trade gate:
        - Verifies UI kill switch
        - Verifies daily/weekly/monthly loss limits
        - Verifies spread
        - Enforces automatic lot sizing
        - Adjusts SL/TP with spread buffer
        """
        self.sync_ui_config()

        # 1. Master Kill Switch
        if not self.master_execution:
            return False, "Trade blocked: Master execution switch is OFF in UI.", {}

        # 2. Daily Loss Ceiling
        if self.current_daily_loss >= self.max_daily_loss_usd:
            return False, f"Trade blocked: Daily loss ceiling breached (-${self.current_daily_loss:.2f} / ${self.max_daily_loss_usd:.2f})", {}

        # 3. Weekly Loss Ceiling
        if self.current_weekly_loss >= self.max_weekly_loss_usd:
            return False, f"Trade blocked: Weekly loss ceiling breached (-${self.current_weekly_loss:.2f} / ${self.max_weekly_loss_usd:.2f})", {}

        # 4. Monthly Loss Ceiling
        if self.current_monthly_loss >= self.max_monthly_loss_usd:
            return False, f"Trade blocked: Monthly loss ceiling breached (-${self.current_monthly_loss:.2f} / ${self.max_monthly_loss_usd:.2f})", {}

        # 5. Daily Trade Count Quota
        if self.trades_taken_today >= self.max_daily_trades:
            return False, f"Trade blocked: Reached max daily trades quota ({self.trades_taken_today}/{self.max_daily_trades})", {}

        # 6. Stop Loss & Take Profit Validation
        sl_distance = abs(entry_price - stop_loss)
        if sl_distance <= 0:
            return False, "Trade blocked: Invalidation distance (SL) is 0 or negative.", {}

        # If strategy did not supply a TP, automatically calculate based on UI Risk-to-Reward ratio
        final_tp = take_profit
        if final_tp is None or final_tp == 0:
            target_distance = sl_distance * self.risk_to_reward
            final_tp = (entry_price + target_distance) if direction.upper() == "BUY" else (entry_price - target_distance)

        # 7. Spread Gate Check
        spread_ok, spread_msg, spread_pts = self.evaluate_spread(symbol, current_bid, current_ask, sl_distance)
        if not spread_ok:
            return False, f"Trade blocked by Spread Gate: {spread_msg}", {}

        # 8. Spread Adjustment to SL/TP:
        # Buffer SL slightly so normal bid-ask bounce does not prematurely stop out the trade
        adjusted_sl = stop_loss
        adjusted_tp = final_tp
        if direction.upper() == "BUY":
            adjusted_sl = stop_loss - spread_pts
        else:
            adjusted_sl = stop_loss + spread_pts

        # 9. Dynamic Auto Lot / Stake Sizing
        stake = self.calculate_lot_size(current_equity, sl_distance, point_value, min_stake, max_stake)
        if stake <= 0:
            return False, "Calculated position size is 0.", {}

        order_blueprint = {
            "symbol": symbol,
            "direction": direction.upper(),
            "stake": stake,
            "entry_price": entry_price,
            "stop_loss": round(adjusted_sl, 4),
            "take_profit": round(adjusted_tp, 4),
            "spread_points": round(spread_pts, 4),
            "risk_dollars": round(current_equity * (self.risk_per_trade_pct / 100.0), 2)
        }

        return True, "Pre-trade validation successful", order_blueprint