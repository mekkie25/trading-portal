#!/usr/bin/env python3
"""
================================================================================
NEXUS MATRIX ALGORITHMIC TRADING SYSTEM (DERIV CLOUD WEBSOCKET EDITION)
================================================================================
Architecture: Institutional Multi-Strategy Quantitative Execution Engine
Components:   - All-Day Unrestricted Execution (Trade Anytime Setup Appears)
              - Daily 21:00 SAST End-of-Day Position Flusher (Zero Overnight Risk)
              - Instant Personal WhatsApp Alerts Engine (CallMeBot Integration)
              - Twin-Position 50/50 Partial Scaling (Bank Half at TP1, Trail TP2)
              - Modular Strategies & Strategy Manager Integration
              - Native Asynchronous Deriv Cloud WebSocket & REST API
              - Gemini AI Overseer & Pre-Trade Prompt Verification
              - Order Flow Analyzer (POC, VAH, VAL, Cumulative Volume Delta)
              - Quantitative Math Engine (EMA, ATR, Bollinger Bands, RSI)
              - Temporal Clock & Session Manager (Asian, London, NY)
              - Multi-Timeframe Volatility Engine (M5, H4, D1 Candle Averages)
              - Range & Consolidation Detection Engine
              - Live Bid/Ask Spread Gatekeeper & News Armor Protection
              - Dynamic Auto Lot Sizing with Weekly Runway Budgeting
              - In-Flight Position Supervisor (80% R:R Move-to-Breakeven Loop)
              - Atomic Bracket Proposal Execution (No Naked Trades)
              - Dual Telemetry Pipeline (Stdout IPC + bot_telemetry.json)
              - Paced 60-Second Scan Cadence (Anti-Rate-Limiting Architecture)
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
import urllib.request
import urllib.parse
import urllib.error
import pandas as pd
import numpy as np
from datetime import datetime, timezone, timedelta, time as dtime
from typing import Dict, List, Tuple, Optional, Any, Union
from dataclasses import dataclass, field
from enum import Enum, auto

# Ensure project root is in Python search path
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

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
# 1. ADVANCED LOGGING SYSTEM (INITIALIZED FIRST)
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

    def format(self, record):
        return logging.Formatter(self.fmt, datefmt=self.datefmt).format(record)

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
    except Exception:
        pass

    return logger

log = setup_logger()

# ==============================================================================
# 2. WHATSAPP NOTIFICATION ENGINE (CallMeBot)
# ==============================================================================

class WhatsAppNotifier:
    """Sends instant alerts directly to your personal WhatsApp via CallMeBot."""
    def __init__(self):
        self.phone = os.getenv("WHATSAPP_PHONE", "").strip()
        self.api_key = os.getenv("WHATSAPP_API_KEY", "").strip()
        self.enabled = bool(self.phone and self.api_key)
        if self.enabled:
            log.info(f"WhatsApp Notification Engine Online for {self.phone}")
        else:
            log.info("WhatsApp Alerts standby (Set WHATSAPP_PHONE & WHATSAPP_API_KEY in Railway to activate).")

    async def send_alert(self, message: str) -> bool:
        if not self.enabled:
            return False
        try:
            clean_phone = self.phone.replace("+", "").replace(" ", "").strip()
            encoded_text = urllib.parse.quote(message)
            url = f"https://api.callmebot.com/whatsapp.php?phone={clean_phone}&text={encoded_text}&apikey={self.api_key}"

            def _call():
                req = urllib.request.Request(url, headers={"User-Agent": "NexusMatrix/1.0"})
                with urllib.request.urlopen(req, timeout=8) as resp:
                    return resp.read().decode('utf-8', errors='ignore')

            res = await asyncio.to_thread(_call)
            return "Message Sent" in res or "ok" in res.lower()
        except Exception as e:
            log.warning(f"Could not send WhatsApp alert: {e}")
            return False

whatsapp = WhatsAppNotifier()

# ==============================================================================
# 3. ADVANCED TELEMETRY & UI CONFIGURATION I/O HELPERS
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
# 4. GLOBAL CONSTANTS & ASSET CONFIGURATION (STRICT 7 ALLOWED ONLY)
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
    symbol: str               # Official Deriv symbol identifier
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

    SYMBOL_MAP: Dict[str, str] = {
        "GOLD": "frxXAUUSD",
        "US30": "OTC_DJI",
        "NAS100": "OTC_NDX",
        "GERMAN30": "OTC_GDAXI",
        "EURUSD": "frxEURUSD",
        "USDJPY": "frxUSDJPY",
        "GBPUSD": "frxGBPUSD"
    }

    ASSETS: Dict[str, AssetConfig] = {
        "frxXAUUSD": AssetConfig("frxXAUUSD", "Gold (XAU/USD)", 0.01, 1.0, 1.0, 1000.0, 50, False),
        "OTC_DJI": AssetConfig("OTC_DJI", "Wall Street 30 (US30)", 0.1, 1.0, 1.0, 2000.0, 100, False),
        "OTC_NDX": AssetConfig("OTC_NDX", "US Tech 100 (NAS100)", 0.1, 1.0, 1.0, 2000.0, 100, False),
        "OTC_GDAXI": AssetConfig("OTC_GDAXI", "Germany 40 (DAX40)", 0.1, 1.0, 1.0, 2000.0, 100, False),
        "frxEURUSD": AssetConfig("frxEURUSD", "EUR / USD", 0.0001, 100000.0, 1.0, 1000.0, 100, False),
        "frxUSDJPY": AssetConfig("frxUSDJPY", "USD / JPY", 0.001, 100000.0, 1.0, 1000.0, 100, False),
        "frxGBPUSD": AssetConfig("frxGBPUSD", "GBP / USD", 0.0001, 100000.0, 1.0, 1000.0, 100, False),
    }

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
# 5. NATIVE DERIV CLOUD WEBSOCKET CLIENT (REST+OTP COMPATIBLE)
# ==============================================================================

class DerivCloudClient:
    def __init__(self, app_id: str = None, api_token: str = None):
        self.app_id = app_id or ConfigManager.DERIV_APP_ID
        self.api_token = api_token or ConfigManager.DERIV_API_TOKEN
        self.ws_url = f"{ConfigManager.DERIV_WS_URL}?app_id={self.app_id}"
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.is_authorized: bool = False
        self.last_known_balance: float = 10051.99
        self.account_info: Dict[str, Any] = {}
        self._req_id_counter: int = 0
        self._lock = asyncio.Lock()

    def _get_next_req_id(self) -> int:
        self._req_id_counter += 1
        return self._req_id_counter

    def is_connection_open(self) -> bool:
        if self.ws is None:
            return False
        if hasattr(self.ws, "state"):
            return getattr(self.ws.state, "name", "") == "OPEN"
        return getattr(self.ws, "open", False)

    async def get_authenticated_ws_url(self) -> str:
        api_base = "https://api.derivws.com"
        try:
            headers = {
                "Authorization": f"Bearer {self.api_token}",
                "Deriv-App-ID": str(self.app_id),
                "User-Agent": "NexusMatrix/1.0"
            }
            
            def _fetch_accounts():
                req = urllib.request.Request(f"{api_base}/trading/v1/options/accounts", headers=headers)
                with urllib.request.urlopen(req, timeout=10) as resp:
                    return json.loads(resp.read().decode())

            accounts_data = await asyncio.to_thread(_fetch_accounts)
            accounts = accounts_data.get("data", [])
            if not accounts:
                raise ValueError("No accounts returned from Deriv.")

            demo_acc = next((a for a in accounts if a.get("account_type") == "demo"), accounts[0])
            account_id = demo_acc.get("account_id") or demo_acc.get("loginid") or demo_acc.get("id")
            log.info(f"Targeting Deriv Account: {account_id}")

            def _fetch_otp():
                otp_req = urllib.request.Request(
                    f"{api_base}/trading/v1/options/accounts/{account_id}/otp",
                    data=b"{}",
                    headers={**headers, "Content-Type": "application/json"},
                    method="POST"
                )
                with urllib.request.urlopen(otp_req, timeout=10) as resp:
                    return json.loads(resp.read().decode())

            otp_res = await asyncio.to_thread(_fetch_otp)
            ws_url = otp_res.get("data", {}).get("url")
            if ws_url:
                log.info("Obtained pre-authenticated WebSocket URL via Deriv OTP handshake.")
                return ws_url

        except Exception as e:
            log.warning(f"Deriv REST+OTP handshake warning: {e}. Trying fallback.")

        return f"{ConfigManager.DERIV_WS_URL}?app_id={self.app_id}"

    async def connect(self) -> bool:
        if not self.app_id or not self.api_token:
            log.critical("Missing DERIV_APP_ID or DERIV_API_TOKEN environment variable.")
            return False

        try:
            ws_url = await self.get_authenticated_ws_url()
            log.info(f"Connecting to Deriv WebSocket: {ws_url.split('?')[0]}...")
            self.ws = await websockets.connect(ws_url, ping_interval=20, ping_timeout=20)

            if "otp=" in ws_url:
                self.is_authorized = True
                req = {"balance": 1, "req_id": self._get_next_req_id()}
                await self.ws.send(json.dumps(req))
                res = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=10.0))
                val = float(res.get("balance", {}).get("balance", 0.0))
                if val > 0:
                    self.last_known_balance = val
                log.info(f"--- DERIV CLOUD ONLINE (NEW API) --- Balance: {self.last_known_balance} USD")
                return True

            auth_payload = {"authorize": self.api_token, "req_id": self._get_next_req_id()}
            await self.ws.send(json.dumps(auth_payload))
            res_data = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=10.0))

            if "error" in res_data:
                log.critical(f"Deriv Auth Failed: {res_data['error']['message']}")
                return False

            self.is_authorized = True
            bal_val = float(res_data.get("authorize", {}).get("balance", 0.0))
            if bal_val > 0:
                self.last_known_balance = bal_val
            log.info(f"--- DERIV CLOUD ONLINE --- Balance: {self.last_known_balance} USD")
            return True

        except Exception as e:
            log.error(f"Failed to connect to Deriv WebSocket Cloud: {str(e)}")
            self.is_authorized = False
            return False

    async def ensure_connected(self) -> bool:
        if not self.is_connection_open() or not self.is_authorized:
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
                res = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=5.0))
                data = json.loads(res)
                return data.get("ping") == "pong"
        except Exception as e:
            log.error(f"Deriv Ping Error: {e}")
            return False

    async def get_balance(self) -> float:
        if not await self.ensure_connected():
            return self.last_known_balance
        try:
            async with self._lock:
                req = {"balance": 1, "req_id": self._get_next_req_id()}
                await self.ws.send(json.dumps(req))
                res = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=5.0))
                val = float(res.get("balance", {}).get("balance", 0.0))
                if val > 0:
                    self.last_known_balance = val
                return self.last_known_balance
        except Exception:
            return self.last_known_balance

    async def fetch_ohlc_candles(self, symbol: str, granularity: DerivGranularity, count: int = 100) -> pd.DataFrame:
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
            log.error(f"Exception during candle fetch ({symbol}): {e}")
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
                await self.ws.send(json.dumps(proposal_req))
                prop_res = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=10.0))

                if "error" in prop_res:
                    log.error(f"Deriv Trade Proposal Error ({symbol}): {prop_res['error']['message']}")
                    return None

                proposal_id = prop_res.get("proposal", {}).get("id")
                if not proposal_id:
                    return None

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
        except Exception:
            return False

    async def close_market_contract(self, contract_id: str) -> bool:
        """Market closes an active contract immediately (Used by 21:00 SAST Flusher)."""
        try:
            async with self._lock:
                req = {
                    "sell": int(contract_id),
                    "price": 0,
                    "req_id": self._get_next_req_id()
                }
                await self.ws.send(json.dumps(req))
                res = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=8.0))
                return "sold" in res or "error" not in res
        except Exception as e:
            log.error(f"Error market closing contract {contract_id}: {e}")
            return False

# ==============================================================================
# 6. QUANTITATIVE MATH ENGINE & STATISTICAL INDICATORS
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
# 7. TEMPORAL CLOCK & SESSION MANAGER
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
# 8. ORDER FLOW & VOLUME PROFILE ANALYZER
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
# 9. INSTITUTIONAL RISK MANAGEMENT ENGINE (NEWS ARMOR & RUNWAY BUDGETING)
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

        # Targeted Red-Folder Windows (NFP & CPI announcements: 5 min before and after)
        self.RED_FOLDER_WINDOWS = [
            (dtime(12, 25), dtime(12, 35)),
            (dtime(17, 55), dtime(18, 5))
        ]

    def sync_ui_config(self) -> None:
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

    def is_red_folder_active(self) -> bool:
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
        
        if spread > max_allowed:
            return False, f"Spread ({spread:.4f}) exceeds threshold ({max_allowed:.4f})", spread

        if sl_distance > 0 and (spread / sl_distance) > self.max_spread_to_sl_ratio:
            return False, f"Spread is {(spread/sl_distance)*100:.1f}% of SL distance (Max allowed: {self.max_spread_to_sl_ratio*100:.0f}%)", spread

        return True, "Spread optimal", spread

    def calculate_lot_size(self, current_equity: float, sl_distance: float, point_value: float, min_stake: float, max_stake: float) -> float:
        equity = current_equity if current_equity > 0 else 10051.99
        active_risk_pct = self.risk_per_trade_pct

        if self.consecutive_losses >= 3:
            active_risk_pct = active_risk_pct * 0.5
            log.info(f"CONSECUTIVE LOSS CIRCUIT: Risk halved to {active_risk_pct:.2f}%")

        if self.is_red_folder_active():
            active_risk_pct = active_risk_pct * 0.5
            log.info(f"NEWS ARMOR ENGAGED: Red folder window active. Risk halved to {active_risk_pct:.2f}% to absorb volatility.")

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

        if self.max_daily_loss_usd > 0:
            remaining_daily_buffer = max(0.0, self.max_daily_loss_usd - self.current_daily_loss)
            max_daily_allowed_dollars = remaining_daily_buffer / 2.0 if remaining_daily_buffer > 0 else 0.0
        else:
            max_daily_allowed_dollars = float('inf')

        base_risk_dollars = equity * (active_risk_pct / 100.0)
        final_risk_dollars = min(base_risk_dollars, max_weekly_allowed_dollars, max_daily_allowed_dollars)

        denom = sl_distance * point_value
        calculated_stake = (final_risk_dollars / denom) if denom > 0 else min_stake

        if calculated_stake < min_stake and equity >= min_stake:
            log.info(f"MICRO-ACCOUNT GROWTH MODE: Small equity ({equity:.2f}). Using minimum broker stake ({min_stake}).")
            calculated_stake = min_stake

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

# Backward compatibility aliases
RiskState = InstitutionalRiskEngine
RiskManager = InstitutionalRiskEngine

# ==============================================================================
# 10. MARKET DATA PIPELINE & MULTI-TIMEFRAME MATRIX
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
# 11. PRESERVED ORIGINAL STRATEGY SETUPS & EVALUATOR MATRIX
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

    @property
    def stop_loss(self) -> float:
        return self.sl

    @property
    def take_profit(self) -> float:
        return self.tp1

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
# 12. AI OVERSEER & CLOUD EXECUTION (TWIN POSITION 50/50 PARTIAL SCALING)
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
        sl = getattr(signal, 'stop_loss', None) or getattr(signal, 'sl', 0.0)
        tp = getattr(signal, 'take_profit', None) or getattr(signal, 'tp1', 0.0)
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
        
        sl = getattr(signal, 'stop_loss', None) or getattr(signal, 'sl', 0.0)
        tp = getattr(signal, 'take_profit', None) or getattr(signal, 'tp1', None)

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

        is_dry_run = getattr(signal, 'is_dry_run', False) or bp.get("is_dry_run", False)

        # SIMULATOR PAPER TRADE
        if is_dry_run:
            msg = f"🔵 *[SIMULATED TRADE]*\n• Asset: {bp['symbol']}\n• Strategy: {strategy_name}\n• Dir: {bp['direction']}\n• Stake: ${bp['stake']}\n• Entry: {bp['entry_price']}\n• SL: {bp['stop_loss']}\n• TP: {bp['take_profit']}"
            log.info(f"[SIMULATOR DRY-RUN] Approved: {bp['direction']} {bp['symbol']} | Strategy: {strategy_name} | Stake: ${bp['stake']}")
            await whatsapp.send_alert(msg)
            return True

        # TWIN-POSITION 50/50 PARTIAL SCALING EXECUTION:
        total_stake = bp['stake']
        half_stake = round(max(total_stake / 2.0, min_stk), 2)
        sl_distance = abs(bp['entry_price'] - bp['stop_loss'])
        tp1_price = round(bp['entry_price'] + sl_distance if bp['direction'] == 'BUY' else bp['entry_price'] - sl_distance, 4)
        tp2_price = bp['take_profit']

        log.info(f"DISPATCHING TWIN 50/50 ORDERS | {bp['direction']} {bp['symbol']} | Total Stake: ${total_stake} | Contract A TP1: {tp1_price} | Contract B TP2: {tp2_price}")

        res_a = await self.deriv.execute_atomic_order(bp['symbol'], bp['direction'], half_stake, bp['entry_price'], bp['stop_loss'], tp1_price)
        res_b = await self.deriv.execute_atomic_order(bp['symbol'], bp['direction'], half_stake, bp['entry_price'], bp['stop_loss'], tp2_price)

        if res_a or res_b:
            self.risk.trades_taken_today += 1
            for res, target_price in [(res_a, tp1_price), (res_b, tp2_price)]:
                if res:
                    cid = str(res.get('contract_id'))
                    self.risk.open_positions[cid] = {
                        "symbol": bp['symbol'],
                        "direction": bp['direction'],
                        "entry_price": bp['entry_price'],
                        "stop_loss": bp['stop_loss'],
                        "take_profit": target_price,
                        "is_be_moved": False
                    }

            whatsapp_msg = (
                f"🟢 *[DERIV LIVE ORDER FILLED]*\n"
                f"• Asset: {bp['symbol']}\n"
                f"• Strategy: {strategy_name}\n"
                f"• Direction: {bp['direction']}\n"
                f"• Twin Stakes: 2x ${half_stake}\n"
                f"• Entry: {bp['entry_price']}\n"
                f"• Stop Loss: {bp['stop_loss']}\n"
                f"• TP1 (Bank 50%): {tp1_price}\n"
                f"• TP2 (Runner): {tp2_price}\n"
                f"• 80% R:R Break-Even Active."
            )
            await whatsapp.send_alert(whatsapp_msg)
            return True

        return False

# ==============================================================================
# 13. MASTER SYSTEM ORCHESTRATOR & CONCURRENT EVENT LOOPS
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
        
        # Concurrently launch:
        # 1. Paced 60-second market scan loop
        # 2. Fast 3-second 80% R:R position supervisor
        # 3. Daily 21:00 SAST End-of-Day position flusher
        await asyncio.gather(
            self._market_scan_loop(),
            self._position_supervisor_loop(),
            self._daily_eod_flusher_loop()
        )

    async def _position_supervisor_loop(self) -> None:
        """In-Flight Position Supervisor: Evaluates live exits (SL, TP, BE) and shifts SL at 80% R:R."""
        while True:
            try:
                for cid, pos in list(self.risk_mgr.open_positions.items()):
                    sym = pos["symbol"]
                    direction = pos["direction"]
                    entry = pos["entry_price"]
                    sl = pos["stop_loss"]
                    tp = pos["take_profit"]
                    be_moved = pos.get("is_be_moved", False)

                    quote, _, _ = await self.deriv_client.get_live_quote(sym)
                    if quote <= 0:
                        continue

                    # 1. NOTIFY IF STOP LOSS HIT
                    sl_hit = (direction == "BUY" and quote <= sl) or (direction == "SELL" and quote >= sl)
                    if sl_hit:
                        if be_moved:
                            sl_msg = f"⚪ *[EXIT AT BREAK-EVEN]*\n• Asset: {sym}\n• Closed at Entry: {quote:.2f}\n• P&L: $0.00 (Risk-Free Exit)\n• Capital 100% Protected."
                        else:
                            sl_msg = f"🔴 *[STOP LOSS HIT]*\n• Asset: {sym}\n• Direction: {direction}\n• Exit Price: {quote:.2f}\n• Stop Loss was respected. Risk gate active."
                        log.info(f"Contract #{cid} exited at SL/BE on {sym}")
                        await whatsapp.send_alert(sl_msg)
                        self.risk_mgr.open_positions.pop(cid, None)
                        continue

                    # 2. NOTIFY IF TAKE PROFIT HIT
                    tp_hit = (direction == "BUY" and quote >= tp) or (direction == "SELL" and quote <= tp)
                    if tp_hit:
                        tp_msg = f"🎯 *[TAKE PROFIT HIT]*\n• Asset: {sym}\n• Direction: {direction}\n• Exit Price: {quote:.2f}\n• Target reached! Profit banked."
                        log.info(f"Contract #{cid} exited at TP on {sym}")
                        await whatsapp.send_alert(tp_msg)
                        self.risk_mgr.open_positions.pop(cid, None)
                        continue

                    # 3. MOVE SL TO BREAK-EVEN AT 80% PROGRESS
                    if not be_moved and self.risk_mgr.check_breakeven_trigger(entry, sl, tp, quote, direction):
                        log.info(f"80% R:R TARGET HIT ON {sym} (Contract #{cid})! Moving Stop Loss to Break-Even.")
                        success = await self.deriv_client.update_contract_stop_loss(cid, new_sl_pts=0.01)
                        if success:
                            pos["is_be_moved"] = True
                            alert = f"🛡️ *[BREAK-EVEN MOVED]*\n• {direction} {sym} reached 80% of TP!\n• Stop Loss moved to Break-Even.\n• Trade is now 100% Risk-Free."
                            await whatsapp.send_alert(alert)

                await asyncio.sleep(3.0)
            except Exception as e:
                log.error(f"Error in Position Supervisor: {e}")
                await asyncio.sleep(5.0)

    async def _daily_eod_flusher_loop(self) -> None:
        """Daily 21:00 SAST Flusher: Flattens all open positions every night (zero overnight/weekend risk)."""
        while True:
            try:
                now_sast = datetime.now(timezone.utc) + timedelta(hours=2)
                hour = now_sast.hour
                minute = now_sast.minute

                if hour == 21 and minute == 0 and len(self.risk_mgr.open_positions) > 0:
                    log.warning(f"🌆 21:00 SAST LOCKDOWN: Flattening {len(self.risk_mgr.open_positions)} open positions to cash.")
                    for cid, pos in list(self.risk_mgr.open_positions.items()):
                        await self.deriv_client.close_market_contract(cid)
                    
                    flushed_count = len(self.risk_mgr.open_positions)
                    self.risk_mgr.open_positions.clear()
                    
                    eod_msg = f"🌆 *[DAILY 21:00 SAST LOCKDOWN]*\n• Flattened {flushed_count} open trades to cash.\n• Zero overnight holding risk.\n• Bot standing by for morning session."
                    await whatsapp.send_alert(eod_msg)
                    
                    await asyncio.sleep(65.0)

                await asyncio.sleep(10.0)
            except Exception as e:
                log.error(f"Error in EOD Flusher: {e}")
                await asyncio.sleep(30.0)

    async def _market_scan_loop(self) -> None:
        """Paced 60-Second Scan Loop: Evaluates setups all day across the 7 assets."""
        while True:
            try:
                start_time = time.time()
                current_balance = await self.deriv_client.get_balance()
                self.risk_mgr.sync_ui_config()

                last_signal: Optional[Any] = None

                for friendly_name, deriv_symbol in ConfigManager.SYMBOL_MAP.items():
                    await asyncio.sleep(0.20)

                    m5_df = await self.deriv_client.fetch_ohlc_candles(deriv_symbol, DerivGranularity.M5, count=60)
                    h4_df = await self.deriv_client.fetch_ohlc_candles(deriv_symbol, DerivGranularity.H4, count=30)
                    d1_df = await self.deriv_client.fetch_ohlc_candles(deriv_symbol, DerivGranularity.D1, count=15)

                    if m5_df.empty:
                        continue

                    candle_stats = self.risk_mgr.calculate_candle_metrics(m5_df, h4_df, d1_df)
                    recent_high = float(m5_df['high'].tail(24).max())
                    recent_low = float(m5_df['low'].tail(24).min())
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

                    signal = self.strategy_mgr.evaluate_all(friendly_name, m5_df, session_levels)

                    if not signal:
                        vp = self.matrix.volume_profiles.get(deriv_symbol)
                        signal = StrategyEvaluator.evaluate_symbol(deriv_symbol, {"M5": m5_df, "H1": m5_df}, vp)

                    if signal:
                        last_signal = signal
                        signal.symbol = ConfigManager.SYMBOL_MAP.get(signal.symbol, signal.symbol)
                        await self.execution_engine.process_signal(signal, current_balance)

                regime_status = "ACTIVE" if self.risk_mgr.master_execution else "HALTED"
                active_setup_str = getattr(last_signal, 'strategy', getattr(last_signal, 'setup_type', 'NONE')) if last_signal else "NONE"
                if isinstance(active_setup_str, Enum):
                    active_setup_str = active_setup_str.value
                verdict_str = getattr(last_signal, 'reason', getattr(last_signal, 'reasoning', '')) if last_signal else "Scanning all day. 21:00 SAST EOD Flusher active."

                emit_telemetry(current_balance, current_balance, regime_status, active_setup_str, verdict_str)
                write_telemetry(current_balance, current_balance, regime_status, active_setup_str, verdict_str)

                # Paced 60-second cycle: Only scan once per minute to respect candle closures and broker rate limits
                elapsed = time.time() - start_time
                await asyncio.sleep(max(1.0, 60.0 - elapsed))

            except asyncio.CancelledError:
                break
            except Exception as e:
                log.error(f"Scan loop error: {e}")
                await asyncio.sleep(5)

# ==============================================================================
# 14. CLOUD ENTRY POINT
# ==============================================================================

def start_bot() -> None:
    master = MatrixEngineMaster()
    try:
        asyncio.run(master.start())
    except KeyboardInterrupt:
        log.info("Shutdown signal received. Stopping Nexus Matrix Engine.")

if __name__ == "__main__":
    start_bot()