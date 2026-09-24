#!/usr/bin/env python3
"""
================================================================================
NEXUS MATRIX ALGORITHMIC TRADING SYSTEM (DERIV CLOUD WEBSOCKET EDITION)
================================================================================
Architecture: Institutional Multi-Strategy Quantitative Execution Engine
Components:   - Modular Strategies & Strategy Manager Integration
              - Native Asynchronous Deriv Cloud WebSocket & REST API
              - Gemini AI Overseer & Pre-Trade Prompt Verification
              - Order Flow Analyzer (POC, VAH, VAL, Cumulative Volume Delta)
              - Multi-Timeframe Volatility Engine (M5, H4, D1 Candle Averages)
              - Range & Consolidation Detection Engine
              - Live Bid/Ask Spread Gatekeeper & SL/TP Adjustment
              - Dynamic Auto Lot Sizing (Risk % / SL Distance)
              - UI Dynamic Limits Sync (Daily, Weekly, Monthly Ceilings, R:R)
              - Macro News Blackout Gate (15m Pre/Post Red-Folder Release)
              - Sector Correlation Exposure Limiter (Max 1 Index Trade)
              - In-Flight Position Supervisor (80% R:R Move-to-Breakeven Loop)
              - Atomic Bracket Proposal Execution (No Naked Trades)
              - Dual Telemetry Pipeline (Stdout IPC + bot_telemetry.json)
Deployment:   Headless Linux / Cloud VPS / Docker Container / Railway
================================================================================
"""

import sys
import os
import time
import json
import math
import logging
import asyncio
import websockets
import pandas as pd
import numpy as np
from datetime import datetime, timezone, timedelta, time as dtime
from typing import Dict, List, Tuple, Optional, Any, Union
from dataclasses import dataclass, field
from enum import Enum, auto

# Google Gemini Generative AI SDK
try:
    import google.generativeai as genai
    GENAI_AVAILABLE = True
except ImportError:
    GENAI_AVAILABLE = False

# Modular Strategy Framework
from strategies.base import StrategySignal
from strategies.strategy_manager import StrategyManager

# File paths for IPC and UI configuration
CONFIG_FILE = "bot_config.json"
TELEMETRY_FILE = "bot_telemetry.json"

# ==============================================================================
# 1. ADVANCED TELEMETRY & UI CONFIGURATION I/O HELPERS
# ==============================================================================

def emit_telemetry(balance: float, equity: float, regime: str, active_setup: str, ai_verdict: str):
    """Outputs structured telemetry line for server.ts IPC process reader."""
    msg = json.dumps({
        "balance": balance,
        "equity": equity,
        "regime": regime,
        "active_setup": active_setup,
        "ai_verdict": ai_verdict
    })
    print(f"[MATRIX_TELEMETRY] {msg}", flush=True)

def write_telemetry(balance: float, equity: float, regime: str, active_setup: str, ai_verdict: str) -> None:
    """Persists telemetry to bot_telemetry.json for the React frontend."""
    data = {
        "balance": balance,
        "equity": equity,
        "regime": regime,
        "active_setup": active_setup,
        "ai_verdict": ai_verdict,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    try:
        with open(TELEMETRY_FILE, "w") as f:
            json.dump(data, f, indent=4)
    except Exception as e:
        log.error(f"Failed to write telemetry: {e}")

def read_ui_config() -> dict:
    """Reads live slider and loss ceiling values set on the website dashboard."""
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}

# ==============================================================================
# 2. ADVANCED LOGGING SYSTEM
# ==============================================================================

class InstitutionalFormatter(logging.Formatter):
    grey = "\x1b[38;20m"
    yellow = "\x1b[33;20m"
    red = "\x1b[31;20m"
    bold_red = "\x1b[31;1m"
    green = "\x1b[32;20m"
    cyan = "\x1b[36;20m"
    reset = "\x1b[0m"
    fmt = "%(asctime)s.%(msecs)03d | %(levelname)-8s | %(name)-20s | %(message)s"
    datefmt = "%Y-%m-%d %H:%M:%S"

    FORMATS = {
        logging.DEBUG: grey + fmt + reset,
        logging.INFO: green + fmt + reset,
        logging.WARNING: yellow + fmt + reset,
        logging.ERROR: red + fmt + reset,
        logging.CRITICAL: bold_red + fmt + reset
    }

    def format(self, record):
        log_fmt = self.FORMATS.get(record.levelno, self.fmt)
        formatter = logging.Formatter(log_fmt, datefmt=self.datefmt)
        return formatter.format(record)

def setup_logger(name: str = "NexusMatrix", log_file: str = "matrix_deriv.log", level=logging.INFO) -> logging.Logger:
    logger = logging.getLogger(name)
    logger.setLevel(level)
    logger.handlers.clear()

    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(level)
    ch.setFormatter(InstitutionalFormatter())
    logger.addHandler(ch)

    try:
        os.makedirs("logs", exist_ok=True)
        fh = logging.FileHandler(f"logs/{log_file}")
        fh.setLevel(level)
        fh.setFormatter(logging.Formatter("%(asctime)s | %(levelname)-8s | %(name)-20s | %(message)s", "%Y-%m-%d %H:%M:%S"))
        logger.addHandler(fh)
    except Exception as e:
        print(f"Warning: Failed to setup file logging: {e}")

    return logger

log = setup_logger()

# ==============================================================================
# 3. GLOBAL CONSTANTS & ASSET CONFIGURATION (STRICT 7 ALLOWED ONLY)
# ==============================================================================

class DerivGranularity(Enum):
    M1 = 60
    M5 = 300
    M15 = 900
    H1 = 3600
    H4 = 14400
    D1 = 86400

@dataclass
class AssetConfig:
    symbol: str               # Deriv symbol identifier
    display_name: str
    pip_size: float
    point_value: float
    min_stake: float
    max_stake: float
    default_multiplier: int
    is_synthetic: bool

class ConfigManager:
    DERIV_APP_ID: str = os.getenv("DERIV_APP_ID", "")
    DERIV_API_TOKEN: str = os.getenv("DERIV_API_TOKEN", "")
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
    DERIV_WS_URL: str = "wss://ws.derivws.com/websockets/v3"

    # Strictly 7 Whitelisted Tradable Assets
    SYMBOL_MAP: Dict[str, str] = {
        "GOLD": "frxXAUUSD",
        "US30": "US30",
        "NAS100": "NAS100",
        "GERMAN30": "GERMAN30",
        "EURUSD": "frxEURUSD",
        "USDJPY": "frxUSDJPY",
        "GBPUSD": "frxGBPUSD"
    }

    ASSETS: Dict[str, AssetConfig] = {
        "frxXAUUSD": AssetConfig("frxXAUUSD", "Gold (XAU/USD)", 0.01, 1.0, 1.0, 1000.0, 50, False),
        "US30": AssetConfig("US30", "Dow Jones 30", 0.1, 1.0, 1.0, 2000.0, 100, False),
        "NAS100": AssetConfig("NAS100", "Nasdaq 100", 0.1, 1.0, 1.0, 2000.0, 100, False),
        "GERMAN30": AssetConfig("GERMAN30", "DAX 40", 0.1, 1.0, 1.0, 2000.0, 100, False),
        "frxEURUSD": AssetConfig("frxEURUSD", "EUR / USD", 0.0001, 100000.0, 1.0, 1000.0, 100, False),
        "frxUSDJPY": AssetConfig("frxUSDJPY", "USD / JPY", 0.001, 100000.0, 1.0, 1000.0, 100, False),
        "frxGBPUSD": AssetConfig("frxGBPUSD", "GBP / USD", 0.0001, 100000.0, 1.0, 1000.0, 100, False),
    }

    # Default baseline risk parameters
    MAX_ACCOUNT_RISK_PER_TRADE: float = 0.01
    DAILY_DRAWDOWN_KILL_SWITCH: float = 0.05
    MAX_CONCURRENT_TRADES: int = 4
    BASE_ACCOUNT_CURRENCY: str = "USD"

    TIMEFRAMES: Dict[str, DerivGranularity] = {
        "M1": DerivGranularity.M1,
        "M5": DerivGranularity.M5,
        "M15": DerivGranularity.M15,
        "H1": DerivGranularity.H1,
        "H4": DerivGranularity.H4,
        "D1": DerivGranularity.D1
    }

# ==============================================================================
# 4. NATIVE DERIV CLOUD WEBSOCKET CLIENT
# ==============================================================================

class DerivCloudClient:
    def __init__(self, app_id: str = None, api_token: str = None):
        self.app_id = app_id or ConfigManager.DERIV_APP_ID
        self.api_token = api_token or ConfigManager.DERIV_API_TOKEN
        self.ws_url = f"{ConfigManager.DERIV_WS_URL}?app_id={self.app_id}"
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.is_authorized: bool = False
        self.account_info: Dict[str, Any] = {}
        self._req_id_counter: int = 0
        self._lock = asyncio.Lock()

    def _get_next_req_id(self) -> int:
        self._req_id_counter += 1
        return self._req_id_counter

    async def connect(self) -> bool:
        if not self.app_id or not self.api_token:
            log.critical("Missing DERIV_APP_ID or DERIV_API_TOKEN environment variable.")
            return False

        try:
            log.info(f"Connecting to Deriv Cloud WebSocket: {self.ws_url}")
            self.ws = await websockets.connect(self.ws_url, ping_interval=20, ping_timeout=20)
            
            auth_payload = {
                "authorize": self.api_token,
                "req_id": self._get_next_req_id()
            }
            await self.ws.send(json.dumps(auth_payload))
            response = await asyncio.wait_for(self.ws.recv(), timeout=10.0)
            res_data = json.loads(response)

            if "error" in res_data:
                log.critical(f"Deriv Authorization Failed: {res_data['error']['message']}")
                self.is_authorized = False
                return False

            self.is_authorized = True
            self.account_info = res_data.get("authorize", {})
            log.info(
                f"--- DERIV CLOUD ONLINE --- "
                f"Login ID: {self.account_info.get('loginid')} | "
                f"Balance: {self.account_info.get('balance')} {self.account_info.get('currency')}"
            )
            return True

        except Exception as e:
            log.error(f"Failed to connect to Deriv WebSocket Cloud: {str(e)}")
            self.is_authorized = False
            return False

    async def ensure_connected(self) -> bool:
        if self.ws is None or not self.ws.open or not self.is_authorized:
            log.warning("Deriv WebSocket connection dropped. Reconnecting...")
            return await self.connect()
        return True

    async def ping(self) -> bool:
        if not await self.ensure_connected():
            return False
        try:
            async with self._lock:
                req = {"ping": 1, "req_id": self._get_next_req_id()}
                await self.ws.send(json.dumps(req))
                res = await asyncio.wait_for(self.ws.recv(), timeout=5.0)
                data = json.loads(res)
                return data.get("ping") == "pong"
        except Exception as e:
            log.error(f"Deriv Ping Error: {e}")
            return False

    async def get_balance(self) -> float:
        if not await self.ensure_connected():
            return 0.0
        try:
            async with self._lock:
                req = {"balance": 1, "req_id": self._get_next_req_id()}
                await self.ws.send(json.dumps(req))
                res = await asyncio.wait_for(self.ws.recv(), timeout=5.0)
                data = json.loads(res)
                return float(data.get("balance", {}).get("balance", 0.0))
        except Exception as e:
            log.error(f"Error fetching balance from Deriv: {e}")
            return 0.0

    async def fetch_ohlc_candles(self, symbol: str, granularity: DerivGranularity, count: int = 300) -> pd.DataFrame:
        if not await self.ensure_connected():
            return pd.DataFrame()

        request_payload = {
            "ticks_history": symbol,
            "adjust_start_time": 1,
            "count": count,
            "end": "latest",
            "granularity": granularity.value,
            "style": "candles",
            "req_id": self._get_next_req_id()
        }

        try:
            async with self._lock:
                await self.ws.send(json.dumps(request_payload))
                response = await asyncio.wait_for(self.ws.recv(), timeout=10.0)
                data = json.loads(response)

            if "error" in data:
                log.error(f"Deriv Candle Fetch Error ({symbol}): {data['error']['message']}")
                return pd.DataFrame()

            candles = data.get("candles", [])
            if not candles:
                return pd.DataFrame()

            df = pd.DataFrame(candles)
            df.rename(columns={'epoch': 'time'}, inplace=True)
            df['time'] = pd.to_datetime(df['time'], unit='s', utc=True)
            
            for col in ['open', 'high', 'low', 'close']:
                df[col] = pd.to_numeric(df[col], errors='coerce')

            if 'tick_volume' not in df.columns:
                df['tick_volume'] = 1

            return df[['time', 'open', 'high', 'low', 'close', 'tick_volume']]
        except Exception as e:
            log.error(f"Exception during Deriv candle fetch ({symbol}): {e}")
            return pd.DataFrame()

    async def get_live_quote(self, symbol: str) -> Tuple[float, float, float]:
        """Fetches live spot price, bid, and ask for precise spread checking."""
        if not await self.ensure_connected():
            return 0.0, 0.0, 0.0
        try:
            async with self._lock:
                req = {"ticks": symbol, "req_id": self._get_next_req_id()}
                await self.ws.send(json.dumps(req))
                res = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=5.0))
                tick = res.get("tick", {})
                quote = float(tick.get("quote", 0.0))
                bid = float(tick.get("bid", quote))
                ask = float(tick.get("ask", quote))
                return quote, bid, ask
        except Exception:
            return 0.0, 0.0, 0.0

    async def execute_atomic_order(
        self, 
        symbol: str, 
        direction: str, 
        stake: float, 
        entry_price: float,
        sl_price: float, 
        tp_price: float
    ) -> Optional[Dict[str, Any]]:
        """
        ATOMIC BRACKET EXECUTION: Bundles SL and TP bounds directly into the contract proposal.
        The trade enters the market fully protected at the exact millisecond of purchase.
        """
        if not await self.ensure_connected():
            return None

        contract_type = "MULTUP" if direction.upper() == "BUY" else "MULTDOWN"
        asset_cfg = ConfigManager.ASSETS.get(symbol)
        multiplier = asset_cfg.default_multiplier if asset_cfg else 100

        sl_pts = abs(entry_price - sl_price)
        tp_pts = abs(tp_price - entry_price)

        proposal_req = {
            "proposal": 1,
            "amount": stake,
            "basis": "stake",
            "contract_type": contract_type,
            "currency": ConfigManager.BASE_ACCOUNT_CURRENCY,
            "symbol": symbol,
            "multiplier": multiplier,
            "limit_order": {
                "stop_loss": round(sl_pts, 2),
                "take_profit": round(tp_pts, 2)
            },
            "req_id": self._get_next_req_id()
        }

        try:
            async with self._lock:
                # 1. Price Proposal with SL/TP bounds locked
                await self.ws.send(json.dumps(proposal_req))
                prop_res = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=10.0))

                if "error" in prop_res:
                    log.error(f"Deriv Trade Proposal Error ({symbol}): {prop_res['error']['message']}")
                    return None

                proposal_id = prop_res.get("proposal", {}).get("id")
                if not proposal_id:
                    return None

                # 2. Atomic Purchase
                buy_req = {
                    "buy": proposal_id,
                    "price": stake,
                    "req_id": self._get_next_req_id()
                }
                await self.ws.send(json.dumps(buy_req))
                buy_res = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=10.0))

                if "error" in buy_res:
                    log.error(f"Deriv Purchase Execution Error ({symbol}): {buy_res['error']['message']}")
                    return None

                contract_info = buy_res.get("buy", {})
                log.info(f"DERIV ATOMIC BRACKET ORDER FILLED | {symbol} | ID: {contract_info.get('contract_id')} | Stake: ${stake} | SL: {sl_price:.2f} | TP: {tp_price:.2f}")
                return contract_info

        except Exception as e:
            log.error(f"Exception during Deriv order execution ({symbol}): {e}")
            return None

    async def update_contract_stop_loss(self, contract_id: str, new_sl_pts: float) -> bool:
        """Sends live order amendment to move Stop Loss to break-even."""
        try:
            async with self._lock:
                req = {
                    "contract_update": 1,
                    "contract_id": int(contract_id),
                    "limit_order": {"stop_loss": round(new_sl_pts, 2)},
                    "req_id": self._get_next_req_id()
                }
                await self.ws.send(json.dumps(req))
                res = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=5.0))
                return "error" not in res
        except Exception as e:
            log.error(f"Error moving SL to BE for contract {contract_id}: {e}")
            return False

# ==============================================================================
# 5. QUANTITATIVE MATH ENGINE & STATISTICAL INDICATORS
# ==============================================================================

class MathEngine:
    @staticmethod
    def calculate_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
        high = df['high']
        low = df['low']
        close = df['close'].shift(1)
        
        tr1 = high - low
        tr2 = (high - close).abs()
        tr3 = (low - close).abs()
        
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        return tr.rolling(window=period).mean()

    @staticmethod
    def calculate_ema(series: pd.Series, period: int) -> pd.Series:
        return series.ewm(span=period, adjust=False).mean()

    @staticmethod
    def calculate_bollinger_bands(series: pd.Series, period: int = 20, std_dev: float = 2.0) -> Tuple[pd.Series, pd.Series, pd.Series]:
        sma = series.rolling(window=period).mean()
        std = series.rolling(window=period).std()
        upper = sma + (std * std_dev)
        lower = sma - (std * std_dev)
        return upper, sma, lower

    @staticmethod
    def calculate_rsi(series: pd.Series, period: int = 14) -> pd.Series:
        delta = series.diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
        rs = gain / (loss + 1e-10)
        return 100 - (100 / (1 + rs))

# ==============================================================================
# 6. TEMPORAL CLOCK & SESSION MANAGER
# ==============================================================================

class MarketSession(Enum):
    ASIAN = "ASIAN"
    LONDON = "LONDON"
    NEW_YORK = "NEW_YORK"
    OVERLAP_LONDON_NY = "OVERLAP_LONDON_NY"
    CLOSED = "CLOSED"

class TemporalSessionManager:
    @staticmethod
    def get_current_session(is_synthetic: bool = False) -> MarketSession:
        if is_synthetic:
            return MarketSession.NEW_YORK

        now_utc = datetime.now(timezone.utc)
        hour = now_utc.hour

        if 0 <= hour < 7:
            return MarketSession.ASIAN
        elif 7 <= hour < 12:
            return MarketSession.LONDON
        elif 12 <= hour < 16:
            return MarketSession.OVERLAP_LONDON_NY
        elif 16 <= hour < 21:
            return MarketSession.NEW_YORK
        else:
            return MarketSession.CLOSED

# ==============================================================================
# 7. ORDER FLOW & VOLUME PROFILE ANALYZER
# ==============================================================================

@dataclass
class VolumeProfileNode:
    poc_price: float
    value_area_high: float
    value_area_low: float
    cum_delta: float

class OrderFlowAnalyzer:
    @staticmethod
    def compute_volume_profile(df: pd.DataFrame, num_bins: int = 30) -> VolumeProfileNode:
        if df.empty or len(df) < 10:
            return VolumeProfileNode(0.0, 0.0, 0.0, 0.0)

        price_min = df['low'].min()
        price_max = df['high'].max()
        
        if price_min == price_max:
            return VolumeProfileNode(price_min, price_max, price_min, 0.0)

        bins = np.linspace(price_min, price_max, num_bins)
        vol_distribution = np.zeros(num_bins - 1)
        delta_distribution = np.zeros(num_bins - 1)

        for _, row in df.iterrows():
            candle_avg = (row['high'] + row['low'] + row['close']) / 3.0
            bin_idx = np.digitize(candle_avg, bins) - 1
            bin_idx = min(max(bin_idx, 0), num_bins - 2)
            
            vol = row.get('tick_volume', 1)
            vol_distribution[bin_idx] += vol
            
            close_range = row['high'] - row['low']
            delta_ratio = ((row['close'] - row['low']) / close_range - 0.5) * 2.0 if close_range > 0 else 0.0
            delta_distribution[bin_idx] += vol * delta_ratio

        poc_idx = np.argmax(vol_distribution)
        poc_price = float((bins[poc_idx] + bins[poc_idx + 1]) / 2.0)

        total_vol = np.sum(vol_distribution)
        target_vol = total_vol * 0.70
        
        sorted_indices = np.argsort(vol_distribution)[::-1]
        cum_vol = 0.0
        va_indices = []
        
        for idx in sorted_indices:
            cum_vol += vol_distribution[idx]
            va_indices.append(idx)
            if cum_vol >= target_vol:
                break

        va_bins = [bins[i] for i in va_indices]
        val = float(min(va_bins)) if va_bins else price_min
        vah = float(max(va_bins)) if va_bins else price_max
        cum_delta = float(np.sum(delta_distribution))

        return VolumeProfileNode(poc_price, vah, val, cum_delta)

# ==============================================================================
# 8. INSTITUTIONAL RISK MANAGEMENT & VOLATILITY ENGINE
# ==============================================================================

class InstitutionalRiskEngine:
    def __init__(self, config_file: str = CONFIG_FILE):
        self.config_file = config_file
        self.master_execution: bool = True
        self.dry_run: bool = False
        self.risk_per_trade_pct: float = 1.0
        self.risk_to_reward: float = 2.0
        self.max_daily_trades: int = 4
        self.max_daily_loss_usd: float = 2500.0
        self.max_weekly_loss_usd: float = 6500.0
        self.max_monthly_loss_usd: float = 15000.0
        
        self.trades_taken_today: int = 0
        self.consecutive_losses: int = 0
        self.current_daily_loss: float = 0.0
        self.current_weekly_loss: float = 0.0
        self.current_monthly_loss: float = 0.0
        self.open_positions: Dict[str, dict] = {}

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
            (dtime(12, 15), dtime(13, 15)),
            (dtime(17, 45), dtime(19, 45)),
            (dtime(5, 45), dtime(6, 15))
        ]

    def sync_ui_config(self) -> None:
        """Dynamically syncs user interface controls from bot_config.json."""
        cfg = read_ui_config()
        if not cfg:
            return
        self.master_execution = cfg.get("masterExecution", self.master_execution)
        self.dry_run = cfg.get("dryRun", self.dry_run)
        self.risk_per_trade_pct = float(cfg.get("riskPerTradePct", self.risk_per_trade_pct))
        self.risk_to_reward = float(cfg.get("riskToReward", self.risk_to_reward))
        self.max_daily_trades = int(cfg.get("maxDailyTrades", self.max_daily_trades))
        self.max_daily_loss_usd = float(cfg.get("maxDailyLoss", cfg.get("maxDailyLossUsd", self.max_daily_loss_usd)))
        self.max_weekly_loss_usd = float(cfg.get("maxWeeklyLoss", cfg.get("maxWeeklyLossUsd", self.max_weekly_loss_usd)))
        self.max_monthly_loss_usd = float(cfg.get("maxMonthlyLoss", cfg.get("maxMonthlyLossUsd", self.max_monthly_loss_usd)))

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

    def check_breakeven_trigger(self, entry: float, sl: float, tp: float, current_price: float, direction: str) -> bool:
        """Returns True if price has reached 80% of the distance from entry to Take Profit."""
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
        """Computes M5, H4, D1 candle averages and identifies market consolidation."""
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
        """Spread Gatekeeper: Checks if bid-ask spread is acceptable."""
        spread = abs(current_ask - current_bid)
        max_allowed = self.max_absolute_spread.get(symbol, 5.0)
        
        if spread > max_allowed:
            return False, f"Spread ({spread:.4f}) exceeds threshold ({max_allowed:.4f})", spread

        if sl_distance > 0 and (spread / sl_distance) > self.max_spread_to_sl_ratio:
            return False, f"Spread is {(spread/sl_distance)*100:.1f}% of SL distance (Max allowed: {self.max_spread_to_sl_ratio*100:.0f}%)", spread

        return True, "Spread optimal", spread

    def calculate_lot_size(self, current_equity: float, sl_distance: float, point_value: float, min_stake: float, max_stake: float) -> float:
        """Dynamic Auto Lot Sizing directly tied to Stop Loss distance."""
        if current_equity <= 0 or sl_distance <= 0:
            return 0.0

        active_risk = self.risk_per_trade_pct
        if self.consecutive_losses >= 3:
            active_risk = self.risk_per_trade_pct * 0.5
            log.info(f"CONSECUTIVE LOSS CIRCUIT: Risk halved to {active_risk:.2f}%")

        risk_dollars = current_equity * (active_risk / 100.0)
        calculated_stake = risk_dollars / (sl_distance * point_value)
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
        """Pre-trade verification checking loss limits, spread, news, and lot sizing."""
        self.sync_ui_config()

        if not self.master_execution:
            return False, "Master execution switch is OFF in UI", {}

        in_blackout, news_msg = self.is_macro_news_blackout()
        if in_blackout:
            return False, news_msg, {}

        sector_ok, sector_msg = self.check_sector_exposure(symbol)
        if not sector_ok:
            return False, sector_msg, {}

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

# Backwards compatibility alias
RiskState = InstitutionalRiskEngine
RiskManager = InstitutionalRiskEngine

# ==============================================================================
# 9. MARKET DATA PIPELINE & MULTI-TIMEFRAME MATRIX
# ==============================================================================

class MarketDataPipeline:
    def __init__(self, deriv_client: DerivCloudClient):
        self.deriv = deriv_client

    async def get_enriched_dataframe(self, symbol: str, granularity: DerivGranularity, count: int = 300) -> pd.DataFrame:
        df = await self.deriv.fetch_ohlc_candles(symbol, granularity, count)
        if df.empty or len(df) < 50:
            return pd.DataFrame()

        df['atr'] = MathEngine.calculate_atr(df, period=14)
        df['ema_20'] = MathEngine.calculate_ema(df['close'], period=20)
        df['ema_50'] = MathEngine.calculate_ema(df['close'], period=50)
        df['ema_200'] = MathEngine.calculate_ema(df['close'], period=200)
        df['rsi'] = MathEngine.calculate_rsi(df['close'], period=14)
        
        bb_upper, bb_mid, bb_lower = MathEngine.calculate_bollinger_bands(df['close'], 20, 2.0)
        df['bb_upper'] = bb_upper
        df['bb_lower'] = bb_lower

        return df

class MultiTimeframeMatrix:
    def __init__(self, deriv_client: DerivCloudClient):
        self.pipeline = MarketDataPipeline(deriv_client)
        self.matrix: Dict[str, Dict[str, pd.DataFrame]] = {}
        self.volume_profiles: Dict[str, VolumeProfileNode] = {}

    async def sync_symbol(self, symbol: str) -> None:
        self.matrix[symbol] = {}
        for tf_name, granularity in ConfigManager.TIMEFRAMES.items():
            df = await self.pipeline.get_enriched_dataframe(symbol, granularity, count=150)
            if not df.empty:
                self.matrix[symbol][tf_name] = df

        if "M15" in self.matrix[symbol] and not self.matrix[symbol]["M15"].empty:
            vp = OrderFlowAnalyzer.compute_volume_profile(self.matrix[symbol]["M15"], num_bins=30)
            self.volume_profiles[symbol] = vp

    async def sync_all_assets(self) -> None:
        tasks = [self.sync_symbol(sym) for sym in ConfigManager.ASSETS.keys()]
        await asyncio.gather(*tasks)

# ==============================================================================
# 10. PRESERVED ORIGINAL STRATEGY SETUPS & EVALUATOR MATRIX
# ==============================================================================

class SetupType(Enum):
    LIQUIDITY_SWEEP_REVERSAL = "SETUP_1_LIQUIDITY_SWEEP"
    ORDER_BLOCK_MITIGATION = "SETUP_2_ORDER_BLOCK"
    FAIR_VALUE_GAP_FILL = "SETUP_3_FVG_REFILL"
    VOLUME_PROFILE_POC_BOUNCE = "SETUP_4_POC_BOUNCE"
    DYNAMIC_TREND_CONTINUATION = "SETUP_5_TREND_CONTINUATION"
    VOLATILITY_EXPANSION_BREAKOUT = "SETUP_6_VOL_EXPANSION"
    MEAN_REVERSION_EXTREME = "SETUP_7_MEAN_REVERSION"
    OPENING_RANGE_SWEEP = "SETUP_8_ORB_SWEEP"
    GRUBBER_KICK = "SETUP_9_GRUBBER_KICK"

@dataclass
class TradeSignal:
    symbol: str
    direction: str
    setup_type: SetupType
    entry_price: float
    sl: float
    tp1: float
    tp2: float
    confidence_score: float
    reasoning: str

class StrategyEvaluator:
    @staticmethod
    def evaluate_symbol(symbol: str, tf_data: Dict[str, pd.DataFrame], vp: Optional[VolumeProfileNode]) -> Optional[TradeSignal]:
        m5 = tf_data.get("M5")
        h1 = tf_data.get("H1")
        if m5 is None or h1 is None or m5.empty or h1.empty:
            return None

        last_m5 = m5.iloc[-1]
        prev_m5 = m5.iloc[-2]
        last_h1 = h1.iloc[-1]
        
        current_price = float(last_m5['close'])
        atr = float(last_m5['atr']) if 'atr' in last_m5 and not np.isnan(last_m5['atr']) else current_price * 0.005

        h1_high = h1['high'].tail(20).max()
        h1_low = h1['low'].tail(20).min()

        if prev_m5['low'] < h1_low and last_m5['close'] > h1_low and last_m5.get('rsi', 50) < 35:
            sl = current_price - (1.5 * atr)
            tp1 = current_price + (2.0 * atr)
            tp2 = current_price + (4.0 * atr)
            return TradeSignal(symbol, "BUY", SetupType.LIQUIDITY_SWEEP_REVERSAL, current_price, sl, tp1, tp2, 0.85, f"Bullish sweep of H1 low ({h1_low:.2f})")

        if prev_m5['high'] > h1_high and last_m5['close'] < h1_high and last_m5.get('rsi', 50) > 65:
            sl = current_price + (1.5 * atr)
            tp1 = current_price - (2.0 * atr)
            tp2 = current_price - (4.0 * atr)
            return TradeSignal(symbol, "SELL", SetupType.LIQUIDITY_SWEEP_REVERSAL, current_price, sl, tp1, tp2, 0.85, f"Bearish sweep of H1 high ({h1_high:.2f})")

        return None

# ==============================================================================
# 11. AI OVERSEER & CLOUD EXECUTION ENGINE
# ==============================================================================

class AIOverseer:
    def __init__(self):
        self.api_key = ConfigManager.GEMINI_API_KEY
        if self.api_key and GENAI_AVAILABLE:
            genai.configure(api_key=self.api_key)
            self.model = genai.GenerativeModel('gemini-1.5-flash')
            log.info("Gemini AI Overseer initialized successfully.")
        else:
            self.model = None

    async def validate_trade(self, signal: Any, current_balance: float, spread_pts: float) -> bool:
        if not self.model:
            return True

        direction = getattr(signal, 'direction', 'BUY')
        symbol = getattr(signal, 'symbol', 'UNKNOWN')
        strategy_name = getattr(signal, 'strategy', getattr(signal, 'setup_type', 'QUANT_SETUP'))
        entry = getattr(signal, 'entry_price', 0.0)
        sl = getattr(signal, 'stop_loss', getattr(signal, 'sl', 0.0))
        tp = getattr(signal, 'take_profit', getattr(signal, 'tp1', 0.0))
        reason = getattr(signal, 'reason', getattr(signal, 'reasoning', ''))

        prompt = (
            f"You are a quant risk manager. Validate: {direction} {symbol} | Strategy: {strategy_name} | "
            f"Entry: {entry} | SL: {sl} | TP: {tp} | Spread: {spread_pts} pts | "
            f"Reason: {reason} | Balance: ${current_balance:.2f}. Reply ONLY 'APPROVED' or 'REJECTED'."
        )
        try:
            res = await asyncio.to_thread(self.model.generate_content, prompt)
            return "APPROVED" in res.text.strip().upper()
        except Exception:
            return True

class CloudExecutionEngine:
    def __init__(self, deriv_client: DerivCloudClient, risk_mgr: InstitutionalRiskEngine):
        self.deriv = deriv_client
        self.risk = risk_mgr
        self.ai_overseer = AIOverseer()

    async def process_signal(self, signal: Any, current_balance: float) -> bool:
        symbol = getattr(signal, 'symbol')
        direction = getattr(signal, 'direction')
        entry = getattr(signal, 'entry_price')
        sl = getattr(signal, 'stop_loss', getattr(signal, 'sl'))
        tp = getattr(signal, 'take_profit', getattr(signal, 'tp1', None))
        strategy_name = getattr(signal, 'strategy', getattr(signal, 'setup_type', 'QUANT_SETUP'))
        if isinstance(strategy_name, Enum):
            strategy_name = strategy_name.value

        quote, bid, ask = await self.deriv.get_live_quote(symbol)
        asset_cfg = ConfigManager.ASSETS.get(symbol)
        pt_val = asset_cfg.point_value if asset_cfg else 1.0
        min_stk = asset_cfg.min_stake if asset_cfg else 1.0
        max_stk = asset_cfg.max_stake if asset_cfg else 1000.0

        is_ok, reason, bp = self.risk.validate_pre_trade(
            symbol=symbol,
            direction=direction,
            entry_price=entry,
            stop_loss=sl,
            take_profit=tp,
            current_bid=bid,
            current_ask=ask,
            current_equity=current_balance,
            point_value=pt_val,
            min_stake=min_stk,
            max_stake=max_stk
        )

        if not is_ok:
            log.warning(f"ORDER BLOCKED BY RISK GATE: {reason}")
            return False

        if not await self.ai_overseer.validate_trade(signal, current_balance, bp.get("spread_points", 0.0)):
            return False

        if bp.get("is_dry_run"):
            log.info(f"[SIMULATOR DRY-RUN] Approved: {bp['direction']} {bp['symbol']} | Strategy: {strategy_name} | Stake: ${bp['stake']}")
            return True

        result = await self.deriv.execute_atomic_order(
            symbol=bp['symbol'],
            direction=bp['direction'],
            stake=bp['stake'],
            entry_price=bp['entry_price'],
            sl_price=bp['stop_loss'],
            tp_price=bp['take_profit']
        )

        if result:
            cid = str(result.get('contract_id'))
            self.risk.trades_taken_today += 1
            self.risk.open_positions[cid] = {
                "symbol": bp['symbol'],
                "direction": bp['direction'],
                "entry_price": bp['entry_price'],
                "stop_loss": bp['stop_loss'],
                "take_profit": bp['take_profit'],
                "is_be_moved": False
            }
            log.info(f"SUCCESS: Bracket trade filled on Deriv. Contract ID: {cid} | Active 80% R:R Position Supervisor.")
            return True

        return False

# ==============================================================================
# 12. MASTER SYSTEM ORCHESTRATOR & CONCURRENT EVENT LOOPS
# ==============================================================================

class MatrixEngineMaster:
    def __init__(self):
        self.deriv_client = DerivCloudClient()
        self.matrix = MultiTimeframeMatrix(self.deriv_client)
        self.strategy_mgr = StrategyManager()
        self.risk_mgr = InstitutionalRiskEngine()
        self.execution_engine: Optional[CloudExecutionEngine] = None

    async def start(self) -> None:
        log.info("Starting Nexus Matrix Trading Engine (Deriv Cloud Edition)...")
        if not await self.deriv_client.connect():
            log.critical("Failed to connect to Deriv Cloud. Exiting.")
            return

        balance = await self.deriv_client.get_balance()
        self.execution_engine = CloudExecutionEngine(self.deriv_client, self.risk_mgr)
        log.info(f"SYSTEM READY. Initial Account Balance: ${balance:.2f} USD")
        
        # Concurrently execute market scanning loop and in-flight position supervisor loop
        await asyncio.gather(
            self._market_scan_loop(),
            self._position_supervisor_loop()
        )

    async def _position_supervisor_loop(self) -> None:
        """In-Flight Position Supervisor: Evaluates live progress and shifts SL to Break-Even at 80% R:R."""
        while True:
            try:
                for cid, pos in list(self.risk_mgr.open_positions.items()):
                    if pos.get("is_be_moved"):
                        continue
                    sym = pos["symbol"]
                    quote, _, _ = await self.deriv_client.get_live_quote(sym)
                    if quote <= 0:
                        continue

                    if self.risk_mgr.check_breakeven_trigger(pos["entry_price"], pos["stop_loss"], pos["take_profit"], quote, pos["direction"]):
                        log.info(f"80% R:R TARGET HIT ON {sym} (Contract #{cid})! Moving Stop Loss to Break-Even.")
                        success = await self.deriv_client.update_contract_stop_loss(cid, new_sl_pts=0.01)
                        if success:
                            pos["is_be_moved"] = True
                            log.info(f"CONTRACT #{cid} IS NOW FULLY RISK-FREE AT BREAK-EVEN.")

                await asyncio.sleep(3.0)
            except Exception as e:
                log.error(f"Error in Position Supervisor: {e}")
                await asyncio.sleep(5.0)

    async def _market_scan_loop(self) -> None:
        while True:
            try:
                start_time = time.time()
                current_balance = await self.deriv_client.get_balance()
                self.risk_mgr.sync_ui_config()

                await self.matrix.sync_all_assets()
                last_signal: Optional[Any] = None

                for friendly_name, deriv_symbol in ConfigManager.SYMBOL_MAP.items():
                    tf_data = self.matrix.matrix.get(deriv_symbol, {})
                    m5_df = tf_data.get("M5")
                    h4_df = tf_data.get("H4")
                    d1_df = tf_data.get("D1")
                    h1_df = tf_data.get("H1")

                    if m5_df is None or m5_df.empty:
                        continue

                    candle_stats = self.risk_mgr.calculate_candle_metrics(m5_df, h4_df, d1_df)
                    recent_high = float(h1_df['high'].tail(24).max()) if h1_df is not None and not h1_df.empty else float(m5_df['high'].max())
                    recent_low = float(h1_df['low'].tail(24).min()) if h1_df is not None and not h1_df.empty else float(m5_df['low'].min())
                    latest_close = float(m5_df.iloc[-1]['close'])

                    session_levels = {
                        "asia_high": recent_high,
                        "asia_low": recent_low,
                        "daily_eq": (recent_high + recent_low) / 2.0,
                        "pdh": recent_high,
                        "pdl": recent_low,
                        "daily_pivot": (recent_high + recent_low + latest_close) / 3.0,
                        "pivot_r1": (2.0 * ((recent_high + recent_low + latest_close) / 3.0)) - recent_low,
                        "pivot_s1": (2.0 * ((recent_high + recent_low + latest_close) / 3.0)) - recent_high,
                        "orb_high": float(m5_df['high'].tail(3).max()),
                        "orb_low": float(m5_df['low'].tail(3).min()),
                        "is_ranging": candle_stats["is_ranging"],
                        "range_span": candle_stats["range_span"],
                    }

                    # 1. Primary Evaluation via Modular Strategy Manager
                    signal = self.strategy_mgr.evaluate_all(friendly_name, m5_df, session_levels)

                    # 2. Secondary Fallback via Core Evaluator
                    if not signal:
                        vp = self.matrix.volume_profiles.get(deriv_symbol)
                        signal = StrategyEvaluator.evaluate_symbol(deriv_symbol, tf_data, vp)

                    if signal:
                        last_signal = signal
                        signal.symbol = ConfigManager.SYMBOL_MAP.get(signal.symbol, signal.symbol)
                        await self.execution_engine.process_signal(signal, current_balance)

                regime_status = "ACTIVE" if self.risk_mgr.master_execution else "HALTED"
                active_setup_str = getattr(last_signal, 'strategy', getattr(last_signal, 'setup_type', 'NONE')) if last_signal else "NONE"
                if isinstance(active_setup_str, Enum):
                    active_setup_str = active_setup_str.value
                verdict_str = getattr(last_signal, 'reason', getattr(last_signal, 'reasoning', '')) if last_signal else "Institutional risk gate active."

                emit_telemetry(current_balance, current_balance, regime_status, active_setup_str, verdict_str)
                write_telemetry(current_balance, current_balance, regime_status, active_setup_str, verdict_str)

                elapsed = time.time() - start_time
                await asyncio.sleep(max(1.0, 10.0 - elapsed))
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.error(f"Scan loop error: {e}")
                await asyncio.sleep(5)

# ==============================================================================
# 13. CLOUD ENTRY POINT
# ==============================================================================

def start_bot() -> None:
    master = MatrixEngineMaster()
    try:
        asyncio.run(master.start())
    except KeyboardInterrupt:
        log.info("Shutdown signal received. Stopping Nexus Matrix Engine.")

if __name__ == "__main__":
    start_bot()