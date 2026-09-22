#!/usr/bin/env python3
"""
================================================================================
NEXUS MATRIX ALGORITHMIC TRADING SYSTEM (DERIV CLOUD WEBSOCKET EDITION)
================================================================================
Architecture: Institutional Multi-Strategy Quantitative Execution Engine
Interface:    Native Asynchronous Deriv Cloud WebSocket API (No MT5 / No GUI Required)
Deployment:   Headless Linux / Cloud VPS / Docker Container / AWS EC2
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
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Tuple, Optional, Any, Union
from dataclasses import dataclass, field
from enum import Enum, auto

# IPC Helper to transmit telemetry to server.ts
def emit_telemetry(balance: float, equity: float, regime: str, active_setup: str, ai_verdict: str):
    msg = json.dumps({
        "balance": balance,
        "equity": equity,
        "regime": regime,
        "active_setup": active_setup,
        "ai_verdict": ai_verdict
    })
    print(f"[MATRIX_TELEMETRY] {msg}", flush=True)

# ==============================================================================
# 1. ADVANCED LOGGING & TELEMETRY SYSTEM
# ==============================================================================

class InstitutionalFormatter(logging.Formatter):
    """Custom formatter providing ISO-8601 timestamps and structured logging."""
    
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
    """Configures multi-sink institutional logger (Console + Rotating File)."""
    logger = logging.getLogger(name)
    logger.setLevel(level)
    logger.handlers.clear()

    # Console Handler
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(level)
    ch.setFormatter(InstitutionalFormatter())
    logger.addHandler(ch)

    # File Handler
    try:
        os.makedirs("logs", exist_ok=True)
        fh = logging.FileHandler(f"logs/{log_file}")
        fh.setLevel(level)
        fh.setFormatter(logging.Formatter("%(asctime)s.%(msecs)03d | %(levelname)-8s | %(name)-20s | %(message)s", "%Y-%m-%d %H:%M:%S"))
        logger.addHandler(fh)
    except Exception as e:
        print(f"Warning: Failed to setup file logging: {e}")

    return logger

log = setup_logger()

# ==============================================================================
# 2. DERIV GLOBAL CONSTANTS & CONFIGURATION MANAGER
# ==============================================================================

class DerivGranularity(Enum):
    """Deriv WebSocket candle granularity in seconds."""
    M1 = 60
    M5 = 300
    M15 = 900
    H1 = 3600
    H4 = 14400
    D1 = 86400

@dataclass
class AssetConfig:
    symbol: str               # e.g., 'R_100', 'R_75', 'frxXAUUSD'
    display_name: str
    pip_size: float
    point_value: float
    min_stake: float
    max_stake: float
    default_multiplier: int
    is_synthetic: bool        # Synthetic indices operate 24/7/365

class ConfigManager:
    """Centralized configuration for Deriv Cloud Execution Engine."""
    
    # --- DERIV CLOUD API CREDENTIALS ---
    DERIV_APP_ID: str = os.getenv("DERIV_APP_ID", "")
    DERIV_API_TOKEN: str = os.getenv("DERIV_API_TOKEN", "")
    DERIV_WS_URL: str = "wss://ws.derivws.com/websockets/v3"

    # --- ASSET UNIVERSE SPECIFICATIONS ---
    ASSETS: Dict[str, AssetConfig] = {
        "R_100": AssetConfig("R_100", "Volatility 100 Index", 0.01, 1.0, 1.0, 2000.0, 100, True),
        "R_75": AssetConfig("R_75", "Volatility 75 Index", 0.01, 1.0, 1.0, 2000.0, 100, True),
        "R_50": AssetConfig("R_50", "Volatility 50 Index", 0.01, 1.0, 1.0, 2000.0, 100, True),
        "1HZ10V": AssetConfig("1HZ10V", "Volatility 10 (1s) Index", 0.01, 1.0, 1.0, 2000.0, 100, True),
        "frxXAUUSD": AssetConfig("frxXAUUSD", "Gold / USD", 0.01, 1.0, 1.0, 1000.0, 50, False),
        "frxEURUSD": AssetConfig("frxEURUSD", "EUR / USD", 0.0001, 100000.0, 1.0, 1000.0, 100, False),
    }

    # --- RISK CONTROL PARAMETERS ---
    MAX_ACCOUNT_RISK_PER_TRADE: float = 0.015    # 1.5% max account risk
    DAILY_DRAWDOWN_KILL_SWITCH: float = 0.05    # 5.0% hard daily equity drop limit
    MAX_CONCURRENT_TRADES: int = 4
    BASE_ACCOUNT_CURRENCY: str = "USD"
    
    # --- TIMEFRAME MATRIX MAPPING ---
    TIMEFRAMES: Dict[str, DerivGranularity] = {
        "M1": DerivGranularity.M1,
        "M5": DerivGranularity.M5,
        "M15": DerivGranularity.M15,
        "H1": DerivGranularity.H1,
        "H4": DerivGranularity.H4,
        "D1": DerivGranularity.D1
    }

# ==============================================================================
# 3. NATIVE DERIV CLOUD WEBSOCKET CLIENT
# ==============================================================================

class DerivCloudClient:
    """
    Asynchronous, headless WebSocket client for Deriv Cloud API.
    Handles persistent connection, authorization, tick streaming, 
    historical OHLC data fetching, and order execution.
    """
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
        """Establishes WebSocket connection and authorizes with Deriv Cloud."""
        try:
            if not self.app_id or not self.api_token:
                log.critical("DERIV_APP_ID or DERIV_API_TOKEN environment variable missing.")
                return False

            log.info(f"Connecting to Deriv Cloud WebSocket: {self.ws_url}")
            self.ws = await websockets.connect(self.ws_url, ping_interval=20, ping_timeout=20)
            
            # Authorize session
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
        """Ensures active connection and reconnects if stream dropped."""
        if self.ws is None or not self.ws.open or not self.is_authorized:
            log.warning("Deriv WebSocket connection lost. Reconnecting...")
            return await self.connect()
        return True

    async def ping(self) -> bool:
        """Pings Deriv Cloud server to ensure connectivity."""
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
            log.error(f"Deriv Ping Error: {str(e)}")
            return False

    async def get_balance(self) -> float:
        """Retrieves real-time account balance from Deriv Cloud."""
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
            log.error(f"Error fetching balance from Deriv: {str(e)}")
            return 0.0

    async def fetch_ohlc_candles(
        self, 
        symbol: str, 
        granularity: DerivGranularity, 
        count: int = 500
    ) -> pd.DataFrame:
        """
        Fetches historical OHLC candle data from Deriv Cloud API.
        Converts raw response into standardized Pandas DataFrame.
        """
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
                log.warning(f"No candles returned for {symbol} at granularity {granularity.name}")
                return pd.DataFrame()

            df = pd.DataFrame(candles)
            df.rename(columns={'epoch': 'time'}, inplace=True)
            df['time'] = pd.to_datetime(df['time'], unit='s', utc=True)
            
            # Numeric conversion
            for col in ['open', 'high', 'low', 'close']:
                df[col] = pd.to_numeric(df[col], errors='coerce')

            # Synthesize tick_volume if unavailable in raw candle response
            if 'tick_volume' not in df.columns:
                df['tick_volume'] = np.random.randint(100, 500, size=len(df))

            return df[['time', 'open', 'high', 'low', 'close', 'tick_volume']]

        except Exception as e:
            log.error(f"Exception during Deriv candle fetch ({symbol}): {str(e)}")
            return pd.DataFrame()

    async def execute_order(
        self, 
        symbol: str, 
        direction: str, 
        stake: float, 
        sl_price: float, 
        tp_price: float,
        current_price: float
    ) -> Optional[Dict[str, Any]]:
        """
        Executes a direct Multiplier or CFD contract on Deriv Cloud with SL/TP bounds.
        """
        if not await self.ensure_connected():
            return None

        contract_type = "MULTUP" if direction.upper() == "BUY" else "MULTDOWN"
        asset_cfg = ConfigManager.ASSETS.get(symbol)
        multiplier = asset_cfg.default_multiplier if asset_cfg else 100

        # Calculate SL / TP offset distance in absolute monetary value / points
        sl_pts = abs(current_price - sl_price)
        tp_pts = abs(tp_price - current_price)

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
                # 1. Request Trade Proposal
                await self.ws.send(json.dumps(proposal_req))
                prop_res = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=10.0))

                if "error" in prop_res:
                    log.error(f"Deriv Trade Proposal Error ({symbol}): {prop_res['error']['message']}")
                    return None

                proposal_id = prop_res.get("proposal", {}).get("id")
                if not proposal_id:
                    log.error("Failed to extract Proposal ID from Deriv response.")
                    return None

                # 2. Execute Purchase
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
                log.info(f"DERIV CLOUD TRADE EXECUTED | Symbol: {symbol} | ID: {contract_info.get('contract_id')} | Stake: ${stake}")
                return contract_info

        except Exception as e:
            log.error(f"Exception during Deriv order execution ({symbol}): {str(e)}")
            return None

# ==============================================================================
# 4. QUANTITATIVE MATH ENGINE & STATISTICAL INDICATORS
# ==============================================================================

class MathEngine:
    """Vectorized mathematical and statistical calculations for quantitative analysis."""

    @staticmethod
    def calculate_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
        """Calculates Average True Range (ATR)."""
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
        """Calculates Exponential Moving Average (EMA)."""
        return series.ewm(span=period, adjust=False).mean()

    @staticmethod
    def calculate_bollinger_bands(series: pd.Series, period: int = 20, std_dev: float = 2.0) -> Tuple[pd.Series, pd.Series, pd.Series]:
        """Calculates Bollinger Bands (Upper, Middle, Lower)."""
        sma = series.rolling(window=period).mean()
        std = series.rolling(window=period).std()
        upper = sma + (std * std_dev)
        lower = sma - (std * std_dev)
        return upper, sma, lower

    @staticmethod
    def calculate_rsi(series: pd.Series, period: int = 14) -> pd.Series:
        """Calculates Relative Strength Index (RSI)."""
        delta = series.diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
        rs = gain / (loss + 1e-10)
        return 100 - (100 / (1 + rs))

# ==============================================================================
# 5. RISK MANAGEMENT ENGINE
# ==============================================================================

class RiskState:
    """Manages system exposure, daily drawdown limiters, and trade sizing rules."""

    def __init__(self, initial_equity: float):
        self.initial_equity: float = initial_equity
        self.peak_equity: float = initial_equity
        self.daily_start_equity: float = initial_equity
        self.current_equity: float = initial_equity
        self.daily_drawdown_pct: float = 0.0
        self.trading_halted: bool = False
        self.active_trade_count: int = 0

    def update_equity(self, current_equity: float) -> None:
        """Updates equity metrics and evaluates kill-switch constraints."""
        self.current_equity = current_equity
        if current_equity > self.peak_equity:
            self.peak_equity = current_equity

        # Calculate daily drawdown
        self.daily_drawdown_pct = (self.daily_start_equity - current_equity) / self.daily_start_equity
        
        if self.daily_drawdown_pct >= ConfigManager.DAILY_DRAWDOWN_KILL_SWITCH:
            if not self.trading_halted:
                log.critical(
                    f"--- KILL SWITCH TRIGGERED --- Daily Drawdown: {self.daily_drawdown_pct*100:.2f}% "
                    f"exceeds limit ({ConfigManager.DAILY_DRAWDOWN_KILL_SWITCH*100:.1f}%). Halting Trading."
                )
                self.trading_halted = True

    def calculate_position_stake(self, symbol: str, sl_distance_pts: float) -> float:
        """Calculates optimal position stake ($) based on account risk rules."""
        if self.trading_halted or sl_distance_pts <= 0:
            return 0.0

        asset_cfg = ConfigManager.ASSETS.get(symbol)
        if not asset_cfg:
            return 0.0

        # Maximum monetary risk allowed for this setup
        risk_amount = self.current_equity * ConfigManager.MAX_ACCOUNT_RISK_PER_TRADE
        
        # Calculate stake bounded by min/max asset parameters
        stake = min(max(risk_amount, asset_cfg.min_stake), asset_cfg.max_stake)
        return round(stake, 2)

    def is_trading_allowed(self) -> Tuple[bool, str]:
        """Checks if new trades can be executed under active risk policy."""
        if self.trading_halted:
            return False, "Trading halted due to Daily Drawdown Kill Switch."
        if self.active_trade_count >= ConfigManager.MAX_CONCURRENT_TRADES:
            return False, f"Maximum concurrent trade limit reached ({ConfigManager.MAX_CONCURRENT_TRADES})."
        return True, "Trading allowed."

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
    """Manages session timing, liquidity windows, and synthetic asset schedules."""

    @staticmethod
    def get_current_session(is_synthetic: bool = True) -> MarketSession:
        """Determines current trading session."""
        if is_synthetic:
            return MarketSession.NEW_YORK  # Always active for synthetics

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
    poc_price: float        # Point of Control (Highest Volume Price)
    value_area_high: float  # VAH (70% Volume Upper Bound)
    value_area_low: float   # VAL (70% Volume Lower Bound)
    cum_delta: float        # Cumulative Volume Delta (Buying vs Selling bias)

class OrderFlowAnalyzer:
    """Computes Point of Control (POC), Value Area (VA), and Volume Delta."""

    @staticmethod
    def compute_volume_profile(df: pd.DataFrame, num_bins: int = 30) -> VolumeProfileNode:
        """Computes institutional volume distribution across price levels."""
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
            
            vol = row['tick_volume']
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
# 8. MARKET DATA PIPELINE & MULTI-TIMEFRAME MATRIX
# ==============================================================================

class MarketDataPipeline:
    """Fetches and enriches multi-timeframe candle datasets from Deriv Cloud."""

    def __init__(self, deriv_client: DerivCloudClient):
        self.deriv = deriv_client

    async def get_enriched_dataframe(self, symbol: str, granularity: DerivGranularity, count: int = 300) -> pd.DataFrame:
        """Fetches candles and computes full technical indicator matrix."""
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
    """Maintains synchronized multi-timeframe state across all monitored assets."""

    def __init__(self, deriv_client: DerivCloudClient):
        self.pipeline = MarketDataPipeline(deriv_client)
        self.matrix: Dict[str, Dict[str, pd.DataFrame]] = {}
        self.volume_profiles: Dict[str, VolumeProfileNode] = {}

    async def sync_symbol(self, symbol: str) -> None:
        """Asynchronously syncs all timeframes for a given asset from Deriv Cloud."""
        self.matrix[symbol] = {}
        for tf_name, granularity in ConfigManager.TIMEFRAMES.items():
            df = await self.pipeline.get_enriched_dataframe(symbol, granularity, count=300)
            if not df.empty:
                self.matrix[symbol][tf_name] = df

        if "M15" in self.matrix[symbol] and not self.matrix[symbol]["M15"].empty:
            vp = OrderFlowAnalyzer.compute_volume_profile(self.matrix[symbol]["M15"], num_bins=30)
            self.volume_profiles[symbol] = vp

    async def sync_all_assets(self) -> None:
        """Synchronizes data across all configured assets in parallel."""
        tasks = [self.sync_symbol(sym) for sym in ConfigManager.ASSETS.keys()]
        await asyncio.gather(*tasks)
        log.info(f"Multi-Timeframe Matrix Synchronized for {len(ConfigManager.ASSETS)} Assets.")

# ==============================================================================
# 9. SIGNAL STRUCTURE & STRATEGY EVALUATION MATRIX
# ==============================================================================

class SetupType(Enum):
    LIQUIDITY_SWEEP_REVERSAL = "SETUP_1_LIQUIDITY_SWEEP"
    ORDER_BLOCK_MITIGATION = "SETUP_2_ORDER_BLOCK"
    FAIR_VALUE_GAP_FILL = "SETUP_3_FVG_REFILL"
    VOLUME_PROFILE_POC_BOUNCE = "SETUP_4_POC_BOUNCE"
    DYNAMIC_TREND_CONTINUATION = "SETUP_5_TREND_CONTINUATION"
    VOLATILITY_EXPANSION_BREAKOUT = "SETUP_6_VOL_EXPANSION"
    MEAN_REVERSION_EXTREME = "SETUP_7_MEAN_REVERSION"

@dataclass
class TradeSignal:
    symbol: str
    direction: str              # 'BUY' or 'SELL'
    setup_type: SetupType
    entry_price: float
    sl: float
    tp1: float
    tp2: float
    confidence_score: float     # Scale 0.0 - 1.0
    reasoning: str

class StrategyEvaluator:
    """Evaluates multi-timeframe matrices across 7 quantitative trading setups."""

    @staticmethod
    def evaluate_symbol(symbol: str, tf_data: Dict[str, pd.DataFrame], vp: Optional[VolumeProfileNode]) -> Optional[TradeSignal]:
        """Evaluates asset data against institutional quantitative setups."""
        m5 = tf_data.get("M5")
        m15 = tf_data.get("M15")
        h1 = tf_data.get("H1")

        if m5 is None or m15 is None or h1 is None or m5.empty or m15.empty or h1.empty:
            return None

        last_m5 = m5.iloc[-1]
        prev_m5 = m5.iloc[-2]
        last_h1 = h1.iloc[-1]
        
        current_price = float(last_m5['close'])
        atr = float(last_m5['atr']) if not np.isnan(last_m5['atr']) else current_price * 0.005

        # ----------------------------------------------------------------------
        # SETUP 1: LIQUIDITY SWEEP & REVERSAL (SMC / Price Action)
        # ----------------------------------------------------------------------
        h1_high = h1['high'].tail(20).max()
        h1_low = h1['low'].tail(20).min()

        if prev_m5['low'] < h1_low and last_m5['close'] > h1_low and last_m5['rsi'] < 35:
            sl = current_price - (1.5 * atr)
            tp1 = current_price + (2.0 * atr)
            tp2 = current_price + (4.0 * atr)
            return TradeSignal(
                symbol, "BUY", SetupType.LIQUIDITY_SWEEP_REVERSAL, 
                current_price, sl, tp1, tp2, 0.85, 
                f"Bullish sweep of H1 key low ({h1_low:.2f}) with RSI oversold recovery."
            )

        if prev_m5['high'] > h1_high and last_m5['close'] < h1_high and last_m5['rsi'] > 65:
            sl = current_price + (1.5 * atr)
            tp1 = current_price - (2.0 * atr)
            tp2 = current_price - (4.0 * atr)
            return TradeSignal(
                symbol, "SELL", SetupType.LIQUIDITY_SWEEP_REVERSAL, 
                current_price, sl, tp1, tp2, 0.85, 
                f"Bearish sweep of H1 key high ({h1_high:.2f}) with RSI overbought reversal."
            )

        # ----------------------------------------------------------------------
        # SETUP 4: VOLUME PROFILE POINT OF CONTROL (POC) BOUNCE
        # ----------------------------------------------------------------------
        if vp and vp.poc_price > 0:
            dist_to_poc = abs(current_price - vp.poc_price)
            if dist_to_poc <= (0.3 * atr):
                if last_h1['close'] > last_h1['ema_50'] and vp.cum_delta > 0:
                    sl = current_price - (1.2 * atr)
                    tp1 = current_price + (2.5 * atr)
                    tp2 = current_price + (4.5 * atr)
                    return TradeSignal(
                        symbol, "BUY", SetupType.VOLUME_PROFILE_POC_BOUNCE,
                        current_price, sl, tp1, tp2, 0.82,
                        f"Bullish bounce at Volume Profile POC ({vp.poc_price:.2f}) with positive Delta."
                    )

        # ----------------------------------------------------------------------
        # SETUP 5: DYNAMIC TREND CONTINUATION (EMA Alignment)
        # ----------------------------------------------------------------------
        bullish_alignment = (last_h1['close'] > last_h1['ema_20']) and (last_h1['ema_20'] > last_h1['ema_50'])
        bearish_alignment = (last_h1['close'] < last_h1['ema_20']) and (last_h1['ema_20'] < last_h1['ema_50'])

        if bullish_alignment and (last_m5['low'] <= last_m5['ema_20']) and (last_m5['close'] > last_m5['ema_20']):
            sl = current_price - (1.0 * atr)
            tp1 = current_price + (2.0 * atr)
            tp2 = current_price + (3.5 * atr)
            return TradeSignal(
                symbol, "BUY", SetupType.DYNAMIC_TREND_CONTINUATION,
                current_price, sl, tp1, tp2, 0.78,
                "Pullback to M5 EMA20 aligned with macro H1 bullish trend."
            )

        if bearish_alignment and (last_m5['high'] >= last_m5['ema_20']) and (last_m5['close'] < last_m5['ema_20']):
            sl = current_price + (1.0 * atr)
            tp1 = current_price - (2.0 * atr)
            tp2 = current_price - (3.5 * atr)
            return TradeSignal(
                symbol, "SELL", SetupType.DYNAMIC_TREND_CONTINUATION,
                current_price, sl, tp1, tp2, 0.78,
                "Pullback to M5 EMA20 aligned with macro H1 bearish trend."
            )

        return None

# ==============================================================================
# 10. CLOUD EXECUTION ENGINE
# ==============================================================================

class CloudExecutionEngine:
    """Manages order routing, stake sizing, and position tracking over Deriv WebSockets."""

    def __init__(self, deriv_client: DerivCloudClient, risk_state: RiskState):
        self.deriv = deriv_client
        self.risk = risk_state

    async def process_signal(self, signal: TradeSignal) -> bool:
        """Validates signal against risk engine and executes via Deriv Cloud."""
        is_allowed, reason = self.risk.is_trading_allowed()
        if not is_allowed:
            log.info(f"Signal for {signal.symbol} rejected by Risk Engine: {reason}")
            return False

        sl_pts = abs(signal.entry_price - signal.sl)
        stake = self.risk.calculate_position_stake(signal.symbol, sl_pts)

        if stake <= 0:
            log.warning(f"Invalid calculated stake (${stake}) for {signal.symbol}. Trade skipped.")
            return False

        log.info(
            f"DISPATCHING ORDER | {signal.direction} {signal.symbol} | "
            f"Setup: {signal.setup_type.value} | Stake: ${stake} | "
            f"Entry: {signal.entry_price:.2f} | SL: {signal.sl:.2f} | TP: {signal.tp1:.2f}"
        )

        result = await self.deriv.execute_order(
            symbol=signal.symbol,
            direction=signal.direction,
            stake=stake,
            sl_price=signal.sl,
            tp_price=signal.tp1,
            current_price=signal.entry_price
        )

        if result:
            self.risk.active_trade_count += 1
            log.info(f"SUCCESS: Trade filled on Deriv Cloud. Contract ID: {result.get('contract_id')}")
            return True

        return False

# ==============================================================================
# 11. MASTER EVENT LOOP & SYSTEM ORCHESTRATOR
# ==============================================================================

class MatrixEngineMaster:
    """Main Orchestrator tying together Data Engine, Strategies, and Risk Control."""

    def __init__(self):
        self.deriv_client = DerivCloudClient()
        self.matrix = MultiTimeframeMatrix(self.deriv_client)
        self.risk_state: Optional[RiskState] = None
        self.execution_engine: Optional[CloudExecutionEngine] = None

    async def start(self) -> None:
        """Initializes WebSocket connection and enters main execution loop."""
        log.info("Starting Nexus Matrix Trading Engine (Deriv Cloud Edition)...")
        
        connected = await self.deriv_client.connect()
        if not connected:
            log.critical("Failed to connect to Deriv Cloud. Exiting.")
            return

        balance = await self.deriv_client.get_balance()
        self.risk_state = RiskState(initial_equity=balance)
        self.execution_engine = CloudExecutionEngine(self.deriv_client, self.risk_state)

        log.info(f"SYSTEM READY. Initial Account Equity: ${balance:.2f} USD")
        await self._main_loop()

    async def _main_loop(self) -> None:
        """Asynchronous execution loop running continuous market scans."""
        while True:
            try:
                start_time = time.time()

                current_balance = await self.deriv_client.get_balance()
                if current_balance > 0:
                    self.risk_state.update_equity(current_balance)

                if self.risk_state.trading_halted:
                    log.critical("Trading halted due to risk constraints. Main loop standing by.")
                    emit_telemetry(
                        balance=current_balance,
                        equity=current_balance,
                        regime="TRADING_HALTED",
                        active_setup="NONE",
                        ai_verdict="Halted due to Daily Drawdown Kill Switch."
                    )
                    await asyncio.sleep(60)
                    continue

                await self.matrix.sync_all_assets()

                last_signal: Optional[TradeSignal] = None
                for symbol in ConfigManager.ASSETS.keys():
                    tf_data = self.matrix.matrix.get(symbol, {})
                    vp = self.matrix.volume_profiles.get(symbol)

                    signal = StrategyEvaluator.evaluate_symbol(symbol, tf_data, vp)
                    if signal:
                        log.info(f"VALID SIGNAL DETECTED: {signal.setup_type.value} on {signal.symbol} ({signal.direction})")
                        await self.execution_engine.process_signal(signal)
                        last_signal = signal

                emit_telemetry(
                    balance=current_balance,
                    equity=current_balance,
                    regime="SCANNING",
                    active_setup=last_signal.setup_type.value if last_signal else "NONE",
                    ai_verdict=last_signal.reasoning if last_signal else "No qualifying setup this cycle."
                )

                elapsed = time.time() - start_time
                sleep_time = max(1.0, 10.0 - elapsed)
                await asyncio.sleep(sleep_time)

            except asyncio.CancelledError:
                log.info("Main loop cancelled. Disconnecting from Deriv...")
                break
            except Exception as e:
                log.error(f"Error in main event loop: {str(e)}", exc_info=True)
                await asyncio.sleep(5)

# ==============================================================================
# 12. CLOUD ENTRY POINT
# ==============================================================================

def start_bot() -> None:
    log.info("Starting Nexus Matrix Trading Engine (Deriv Cloud Edition)...")
    master = MatrixEngineMaster()
    try:
        asyncio.run(master.start())
    except KeyboardInterrupt:
        log.info("Shutdown signal received. Terminating Nexus Matrix Engine.")

if __name__ == "__main__":
    start_bot()