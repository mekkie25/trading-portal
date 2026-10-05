#!/usr/bin/env python3
"""
================================================================================
NEXUS MATRIX QUANTITATIVE ENGINE (CTRADER OPEN API / FUSION MARKETS)
================================================================================
Architecture: Master-Grade Institutional Multi-Strategy Execution Engine
Components:   - Dynamic Multi-Currency Support (USD, ZAR, EUR) via core/fx.py
              - Adaptive Volatility Engine Integration (ADR, AWR, AMR)
              - 150 D1 Bar Volatility Context & Sunday-Night ISO Weekly Open
              - Real Mark-to-Market Floating Equity Calculation
              - Live Broker Position Reconciliation (ProtoOAReconcile 2124)
              - Dynamic Breakeven Supervisor (80% R:R + 0.5x SL Distance)
              - SuperTrend 5M Trailing Stop & Fixed Target Exits
              - Institutional Drawdown Throttling & Auto Re-arming
================================================================================
"""

import sys
import os
import time
import json
import math
import logging
import asyncio
import tempfile
import warnings
import websockets
import urllib.request
import urllib.parse
import urllib.error
import pandas as pd
import numpy as np
from datetime import datetime, timezone, timedelta, time as dtime
from typing import Dict, List, Tuple, Optional, Any, Union, Callable
from dataclasses import dataclass, field
from enum import Enum
from core.session_levels import build_session_levels

warnings.filterwarnings("ignore", category=FutureWarning)

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import core.session_config
from core.session_config import MarketSessionManager, GLOBAL_PARAMS, TZ_SAST
from core.indicators import calculate_supertrend
from core.fx import get_fx_rate_to_account, FX_CONVERSION_ALIASES
from core.volatility_engine import volatility_engine
from core.targets import compute_fixed_target

try:
    import google.generativeai as genai
    GENAI_AVAILABLE = True
except ImportError:
    GENAI_AVAILABLE = False

from strategies.base import StrategySignal
from strategies.strategy_manager import StrategyManager
from risk.risk_manager import RiskManager

# PROPOSED: Support shared DATA_DIR persistent storage volume
DATA_DIR = os.getenv("DATA_DIR", "").strip() or PROJECT_ROOT
os.makedirs(DATA_DIR, exist_ok=True)

CONFIG_FILE = os.path.join(DATA_DIR, "bot_config.json")
TELEMETRY_FILE = os.path.join(DATA_DIR, "bot_telemetry.json")
TRADES_DB_FILE = os.path.join(DATA_DIR, "trades_db.json")
CANDLES_CACHE_FILE = os.path.join(DATA_DIR, "candles_cache.json")
CLOSE_COMMAND_FILE = os.path.join(DATA_DIR, "close_command.json")

# ==============================================================================
# 1. ADVANCED INSTITUTIONAL LOGGING
# ==============================================================================

class InstitutionalFormatter(logging.Formatter):
    fmt = "%(asctime)s.%(msecs)03d | %(levelname)-8s | %(name)-20s | %(message)s"
    datefmt = "%Y-%m-%d %H:%M:%S"

    def format(self, record):
        return logging.Formatter(self.fmt, datefmt=self.datefmt).format(record)

def setup_logger(name: str = "NexusMatrix", log_file: str = "matrix_ctrader.log", level=logging.INFO) -> logging.Logger:
    logger = logging.getLogger(name)
    logger.setLevel(level)
    logger.handlers.clear()

    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(level)
    ch.setFormatter(InstitutionalFormatter())
    logger.addHandler(ch)

    try:
        os.makedirs(os.path.join(PROJECT_ROOT, "logs"), exist_ok=True)
        fh = logging.FileHandler(os.path.join(PROJECT_ROOT, "logs", log_file))
        fh.setLevel(level)
        fh.setFormatter(logging.Formatter("%(asctime)s | %(levelname)-8s | %(name)-20s | %(message)s", "%Y-%m-%d %H:%M:%S"))
        logger.addHandler(fh)
    except Exception:
        pass

    return logger

log = setup_logger()

# ==============================================================================
# 2. WHATSAPP NOTIFICATION ENGINE
# ==============================================================================

class WhatsAppNotifier:
    def __init__(self):
        self.phone = os.getenv("WHATSAPP_PHONE", "").strip()
        self.api_key = os.getenv("WHATSAPP_API_KEY", "").strip()
        self.enabled = bool(self.phone and self.api_key)
        if self.enabled:
            log.info(f"WhatsApp Notification Engine Online for {self.phone}")
        else:
            log.info("WhatsApp Alerts standby (Set WHATSAPP_PHONE & WHATSAPP_API_KEY to activate).")

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
# 3. TELEMETRY & CACHING HELPERS
# ==============================================================================

def write_telemetry(balance: float, equity: float, regime: str, active_setup: str, ai_verdict: str, open_positions_list: list = None) -> None:
    data = {
        "balance": balance,
        "equity": equity,
        "regime": regime,
        "active_setup": active_setup,
        "ai_verdict": ai_verdict,
        "open_positions": open_positions_list or [],
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    try:
        dirname = os.path.dirname(TELEMETRY_FILE)
        fd, tmp_path = tempfile.mkstemp(dir=dirname, prefix="tmp_telem_", suffix=".json")
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)
        os.replace(tmp_path, TELEMETRY_FILE)
    except Exception as e:
        log.error(f"Failed to write telemetry atomically: {e}")

# PROPOSED: Loud error logging and safe reading
def read_ui_config() -> dict:
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            content = f.read().strip()
            if not content:
                return {}
            parsed = json.loads(content)
            if isinstance(parsed, dict):
                return parsed
            log.error(f"CRITICAL: {CONFIG_FILE} content is not a JSON object.")
            return {}
    except Exception as e:
        log.exception(f"CRITICAL: Failed reading {CONFIG_FILE}: {e}")
        return {}

def read_trade_history() -> List[dict]:
    if not os.path.exists(TRADES_DB_FILE):
        return []
    try:
        with open(TRADES_DB_FILE, "r", encoding="utf-8") as f:
            content = f.read().strip()
            if not content:
                return []
            parsed = json.loads(content)
            if isinstance(parsed, list):
                return parsed
            log.error(f"CRITICAL: {TRADES_DB_FILE} is not a JSON list. Refusing to overwrite.")
            return []
    except Exception as e:
        log.exception(f"CRITICAL: Failed reading {TRADES_DB_FILE}: {e}")
        return []

# PROPOSED: Atomic trade recording with tempfile and atomic replacement
def save_trade_record(trade_data: dict) -> None:
    try:
        trades = read_trade_history()
        existing_idx = next((i for i, t in enumerate(trades) if t.get("ticket") == trade_data.get("ticket")), None)
        if existing_idx is not None:
            trades[existing_idx].update(trade_data)
        else:
            trades.insert(0, trade_data)

        dirname = os.path.dirname(TRADES_DB_FILE)
        os.makedirs(dirname, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=dirname, prefix="tmp_trades_", suffix=".json")
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(trades, f, indent=2)
        os.replace(tmp_path, TRADES_DB_FILE)
    except Exception as e:
        log.exception(f"CRITICAL: Failed to record trade atomically to {TRADES_DB_FILE}: {e}")

def update_candle_cache(symbol: str, df: pd.DataFrame) -> None:
    if df.empty:
        return
    try:
        cache = {}
        if os.path.exists(CANDLES_CACHE_FILE):
            try:
                with open(CANDLES_CACHE_FILE, "r", encoding="utf-8") as f:
                    cache = json.load(f)
            except Exception:
                cache = {}

        candles = []
        for _, row in df.tail(150).iterrows():
            t_epoch = int(pd.to_datetime(row['time']).timestamp())
            candles.append({
                "time": t_epoch,
                "open": float(row['open']),
                "high": float(row['high']),
                "low": float(row['low']),
                "close": float(row['close']),
                "volume": int(row.get('tick_volume', 100))
            })

        cache[symbol] = candles
        dirname = os.path.dirname(CANDLES_CACHE_FILE)
        fd, tmp_path = tempfile.mkstemp(dir=dirname, prefix="tmp_candles_", suffix=".json")
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(cache, f)
        os.replace(tmp_path, CANDLES_CACHE_FILE)
    except Exception as e:
        log.debug(f"Candle cache write error: {e}")

# ==============================================================================
# 4. CONFIGURATION & ASSET METRICS
# ==============================================================================

class CTraderTrendbarPeriod(Enum):
    M1 = 1
    M5 = 5
    M15 = 7
    H1 = 9
    H4 = 10
    D1 = 12

@dataclass
class AssetConfig:
    symbol: str
    display_name: str
    quote_currency: str
    pip_size: float
    contract_size: float
    min_lots: float
    max_lots: float
    lot_step: float
    sector: str

class ConfigManager:
    CLIENT_ID: str = os.getenv("CTRADER_CLIENT_ID", "").strip()
    CLIENT_SECRET: str = os.getenv("CTRADER_CLIENT_SECRET", "").strip()

    _raw_token: str = os.getenv("CTRADER_ACCESS_TOKEN", "").strip()
    _cleaned_token: str = _raw_token.replace("AT:", "").replace("Bearer", "").strip()
    ACCESS_TOKEN: str = "".join(_cleaned_token.split())

    ACCOUNT_ID: int = int(os.getenv("CTRADER_ACCOUNT_ID", "0").strip() or 0)
    ENV: str = os.getenv("CTRADER_ENV", "demo").lower().strip()
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "").strip()

    WS_HOST = "live.ctraderapi.com" if ENV == "live" else "demo.ctraderapi.com"
    WS_PORT = 5036
    WS_URL = f"wss://{WS_HOST}:{WS_PORT}"

    # 7 Whitelist Execution Symbols
    SYMBOL_ALIASES: Dict[str, List[str]] = {
        "GOLD": ["XAUUSD", "GOLD", "XAUUSD.spot"],
        "US30": ["US30", "DJ30", "US30.cash", "WS30"],
        "NAS100": ["NAS100", "US100", "USTEC", "NAS100.cash"],
        "GERMAN30": ["DE40", "GER40", "GER30", "DE40.cash"],
        "EURUSD": ["EURUSD"],
        "USDJPY": ["USDJPY"],
        "GBPUSD": ["GBPUSD"]
    }

    ASSETS: Dict[str, AssetConfig] = {
        "GOLD": AssetConfig("XAUUSD", "Gold Spot (XAU/USD)", "USD", 0.01, 100.0, 0.01, 20.0, 0.01, "PRECIOUS_METAL"),
        "US30": AssetConfig("US30", "Wall Street 30 (Dow Jones)", "USD", 1.0, 1.0, 0.01, 50.0, 0.01, "EQUITY_INDEX"),
        "NAS100": AssetConfig("NAS100", "US Tech 100 (NASDAQ)", "USD", 0.1, 1.0, 0.01, 50.0, 0.01, "EQUITY_INDEX"),
        "GERMAN30": AssetConfig("DE40", "Germany 40 (DAX40)", "EUR", 0.1, 1.0, 0.01, 50.0, 0.01, "EQUITY_INDEX"),
        "EURUSD": AssetConfig("EURUSD", "EUR / USD", "USD", 0.0001, 100000.0, 0.01, 50.0, 0.01, "FOREX_MAJORS"),
        "USDJPY": AssetConfig("USDJPY", "USD / JPY", "JPY", 0.01, 100000.0, 0.01, 50.0, 0.01, "FOREX_MAJORS"),
        "GBPUSD": AssetConfig("GBPUSD", "GBP / USD", "USD", 0.0001, 100000.0, 0.01, 50.0, 0.01, "FOREX_MAJORS"),
    }

# ==============================================================================
# 5. CTRADER CLIENT WITH RECONCILIATION & AUTO-RECONNECT
# ==============================================================================

class CTraderClient:
    def __init__(self):
        self.ws_url = ConfigManager.WS_URL
        self.account_id = ConfigManager.ACCOUNT_ID
        self.client_id = ConfigManager.CLIENT_ID
        self.client_secret = ConfigManager.CLIENT_SECRET
        self.access_token = ConfigManager.ACCESS_TOKEN
        self.notified_closed_deals = set()
        self.position_strategies: Dict[str, str] = {}
        self._load_position_strategies()
        self._seed_notified_deals()

    def _seed_notified_deals(self):
        """Pre-seeds notified deals from trades_db.json so past trades are not re-processed on reboot."""
        for t in read_trade_history():
            tid = str(t.get("ticket", "")).replace("#", "").strip()
            if tid:
                self.notified_closed_deals.add(tid)
            did = str(t.get("id", "")).replace("deal-", "").strip()
            if did:
                self.notified_closed_deals.add(did)

        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.is_authorized: bool = False
        self.is_connecting: bool = False
        self.last_known_balance: float = 1000.0
        self.last_known_equity: float = 1000.0
        self.money_digits: int = 2
        self.account_currency: Optional[str] = None

        self.symbol_map: Dict[str, int] = {}
        self.symbol_details: Dict[int, dict] = {}
        self.live_quotes: Dict[int, Tuple[float, float]] = {}
        self.quote_timestamps: Dict[int, float] = {}
        self.asset_map: Dict[int, str] = {}

        self._pending_requests: Dict[str, asyncio.Future] = {}
        self._msg_counter: int = 0
        self._listen_task: Optional[asyncio.Task] = None
        self.risk_engine: Optional[Any] = None

    def _load_position_strategies(self):
        strat_file = os.path.join(DATA_DIR, "position_strategies.json")
        try:
            if os.path.exists(strat_file):
                with open(strat_file, "r") as f:
                    self.position_strategies = json.load(f)
        except Exception as e:
            log.warning(f"Could not load position strategies: {e}")
            self.position_strategies = {}

    def _save_position_strategy(self, position_id: str, strategy: str):
        self.position_strategies[str(position_id)] = strategy
        strat_file = os.path.join(DATA_DIR, "position_strategies.json")
        try:
            fd, tmp = tempfile.mkstemp(dir=DATA_DIR, prefix="tmp_strat_", suffix=".json")
            with os.fdopen(fd, 'w') as f:
                json.dump(self.position_strategies, f)
            os.replace(tmp, strat_file)
        except Exception as e:
            log.warning(f"Failed to save position strategy: {e}")

    def _next_id(self) -> str:
        self._msg_counter += 1
        return f"req_{self._msg_counter}_{int(time.time()*1000)}"

    def is_connection_open(self) -> bool:
        if self.ws is None:
            return False
        return getattr(self.ws, "open", False) or getattr(getattr(self.ws, "state", None), "name", "") == "OPEN"

    async def ensure_connection(self) -> bool:
        if self.is_connection_open() and self.is_authorized:
            return True
        if self.is_connecting:
            await asyncio.sleep(1.0)
            return self.is_authorized

        log.warning("Connection lost to cTrader. Engaging Auto-Reconnect Shield...")
        return await self.connect()

    async def ensure_account_currency(self) -> Optional[str]:
        if self.account_currency:
            return self.account_currency
        try:
            if not self.asset_map:
                asset_res = await self._send_and_wait(2112, {"ctidTraderAccountId": self.account_id}, timeout=4.0)
                if asset_res and "asset" in asset_res.get("payload", {}):
                    for a in asset_res["payload"]["asset"]:
                        self.asset_map[int(a["assetId"])] = str(a["name"]).upper()

            trader_res = await self._send_and_wait(2121, {"ctidTraderAccountId": self.account_id}, timeout=4.0)
            if trader_res and "trader" in trader_res.get("payload", {}):
                raw_asset_id = trader_res["payload"]["trader"].get("depositAssetId")
                if str(raw_asset_id).isdigit() and int(raw_asset_id) in self.asset_map:
                    self.account_currency = self.asset_map[int(raw_asset_id)]
                    log.info(f"Account currency resolved on retry: {self.account_currency}")
                else:
                    self.account_currency = None
        except Exception as e:
            log.warning(f"Account currency resolution retry failed: {e}")
        return self.account_currency

    async def reconcile_open_positions(self) -> List[dict]:
        if not self.is_authorized:
            return []
        try:
            res = await self._send_and_wait(2124, {
                "ctidTraderAccountId": self.account_id,
                "returnZeroSlice": False
            }, timeout=6.0)

            if not res or "position" not in res.get("payload", {}):
                return []

            broker_positions = res["payload"]["position"]
            reconciled = []
            for p in broker_positions:
                pid = str(p.get("positionId"))
                sid = p.get("symbolId")
                sym_name = self.symbol_details.get(sid, {}).get("name", "UNKNOWN")

                friendly = sym_name
                for f_name, aliases in ConfigManager.SYMBOL_ALIASES.items():
                    if sym_name in aliases or any(a in sym_name for a in aliases):
                        friendly = f_name
                        break

                entry = float(p.get("price", 0))
                sl = float(p.get("stopLoss", 0)) if p.get("stopLoss") else 0.0
                tp = float(p.get("takeProfit", 0)) if p.get("takeProfit") else 0.0

                comment = p.get("comment", "")
                strategy = self.position_strategies.get(pid)
                if not strategy:
                    strategy = comment if comment and comment not in ("NexusMatrix", "") else "QUANT_STRATEGY"

                direction = "BUY" if p.get("tradeSide") == 1 else "SELL"
                vol = p.get("volume", 0)
                cfg = ConfigManager.ASSETS.get(friendly)
                contract_size = cfg.contract_size if cfg else 100000.0
                lots = round(vol / (contract_size * 100.0), 2)

                reconciled.append({
                    "position_id": pid,
                    "symbol": friendly,
                    "strategy": strategy,
                    "direction": direction,
                    "entry_price": entry,
                    "stop_loss": sl,
                    "take_profit": tp,
                    "volume_cents": vol,
                    "lots": lots,
                    "contract_size": contract_size,
                    "is_be_moved": bool(sl == entry and entry > 0)
                })

            return reconciled
        except Exception as e:
            log.warning(f"Error reconciling positions with cTrader: {e}")
            return []

    async def sync_deals_from_ctrader(self) -> List[dict]:
        if not self.is_authorized:
            return []
        try:
            now_ms = int(time.time() * 1000)
            from_ms = now_ms - (30 * 86400 * 1000)
            deal_res = await self._send_and_wait(2133, {
                "ctidTraderAccountId": self.account_id,
                "fromTimestamp": from_ms,
                "toTimestamp": now_ms,
                "maxRows": 100
            }, timeout=6.0)

            if not deal_res or "deal" not in deal_res.get("payload", {}):
                return []

            deals = deal_res["payload"]["deal"]
            synced_trades = []

            for d in deals:
                pos_det = d.get("closePositionDetail")
                if pos_det:
                    deal_id_str = str(d.get('dealId'))
                    pnl_cents = pos_det.get("grossProfit", 0) + pos_det.get("commission", 0) + pos_det.get("swap", 0)
                    real_pnl = round(pnl_cents / (10 ** self.money_digits), 2)
                    t_ms = d.get("executionTimestamp", 0)
                    t_time = datetime.fromtimestamp(t_ms / 1000.0, timezone.utc).strftime("%Y-%m-%d %H:%M:%S") if t_ms else ""

                    sid = d.get("symbolId")
                    sym_name = self.symbol_details.get(sid, {}).get("name", "FOREX")
                    friendly = sym_name
                    for f_name, aliases in ConfigManager.SYMBOL_ALIASES.items():
                        if sym_name in aliases or any(a in sym_name for a in aliases):
                            friendly = f_name
                            break

                    pos_id_str = str(d.get("positionId", ""))
                    strategy = self.position_strategies.get(pos_id_str)
                    if not strategy:
                        comment = d.get("comment", "")
                        strategy = comment if comment and comment not in ("NexusMatrix", "") else "QUANT_STRATEGY"

                    cfg = ConfigManager.ASSETS.get(friendly)
                    contract_size = cfg.contract_size if cfg else 100000.0
                    lots = round(d.get("filledVolume", 0) / (contract_size * 100.0), 2)

                    record = {
                        "id": f"deal-{deal_id_str}",
                        "ticket": f"#{deal_id_str}",
                        "asset": friendly,
                        "strategy": strategy,
                        "type": "BUY" if d.get("tradeSide") == 1 else "SELL",
                        "lots": lots if lots > 0 else 0.01,
                        "openPrice": pos_det.get("entryPrice", 0),
                        "closePrice": d.get("executionPrice", 0),
                        "pnl": real_pnl,
                        "openTime": t_time,
                        "closeTime": t_time,
                        "status": "WIN" if real_pnl > 0 else ("LOSS" if real_pnl < 0 else "BREAKEVEN"),
                        "source": "Fusion cTrader"
                    }
                    save_trade_record(record)
                    synced_trades.append(record)
                    if deal_id_str not in self.notified_closed_deals:
                        self.notified_closed_deals.add(deal_id_str)
                        if hasattr(self, 'risk_engine') and self.risk_engine:
                            self.risk_engine.persistent_risk.record_trade_outcome(real_pnl)
                        curr_balance, _ = await self.get_balance_and_equity()
                        acc_str = self.account_currency or "USD"
                        curr_sym = "$" if acc_str == "USD" else f"{acc_str} "
                        if real_pnl > 0:
                            alert = (
                                f"🎯 *[TAKE PROFIT REACHED / TRADE WON]*\n"
                                f"• Asset: {friendly}\n"
                                f"• Strategy: {strategy}\n"
                                f"• Profit Banked: +{curr_sym}{real_pnl:.2f}\n"
                                f"• Account Balance: {curr_sym}{curr_balance:.2f}\n"
                                f"• Target Hit."
                            )
                        elif real_pnl < 0:
                            alert = (
                                f"🔴 *[STOP LOSS EXITED / TRADE CLOSED]*\n"
                                f"• Asset: {friendly}\n"
                                f"• Strategy: {strategy}\n"
                                f"• Realized Loss: -{curr_sym}{abs(real_pnl):.2f}\n"
                                f"• Account Balance: {curr_sym}{curr_balance:.2f}\n"
                                f"• Capital preserved."
                            )
                        else:
                            alert = (
                                f"⚪ *[EXIT AT BREAK-EVEN]*\n"
                                f"• Asset: {friendly}\n"
                                f"• Strategy: {strategy}\n"
                                f"• Result: 0.00 (Risk-Free Exit)"
                            )
                        await whatsapp.send_alert(alert)

            return synced_trades
        except Exception as e:
            log.warning(f"Error syncing deals from cTrader: {e}")
            return []

    def fetch_real_account_id_from_http(self) -> Optional[int]:
        try:
            url = f"https://api.spotware.com/connect/tradingaccounts?access_token={self.access_token}"
            req = urllib.request.Request(url, headers={"User-Agent": "NexusMatrix/1.0"})
            with urllib.request.urlopen(req, timeout=7) as resp:
                data = json.loads(resp.read().decode())
                accounts = data.get("data", [])
                log.info(f"Spotware Accounts API returned {len(accounts)} account(s).")
                for acc in accounts:
                    a_id = acc.get("accountId")
                    a_num = acc.get("accountNumber")
                    if self.account_id in (a_id, a_num):
                        log.info(f"Match found: Auto-binding account #{a_id} (Login #{a_num})")
                        return a_id
                if accounts:
                    is_live = (ConfigManager.ENV == "live")
                    matching = [a for a in accounts if a.get("live", False) == is_live]
                    chosen = matching[0] if matching else accounts[0]
                    log.info(f"Auto-selected account #{chosen.get('accountId')}")
                    return chosen.get("accountId")
        except Exception as e:
            log.warning(f"Spotware HTTP account query: {e}")
        return None

    async def connect(self) -> bool:
        if not self.client_id or not self.client_secret or not self.access_token:
            log.critical("Missing cTrader credentials in environment variables.")
            return False

        self.is_connecting = True
        try:
            resolved_id = await asyncio.to_thread(self.fetch_real_account_id_from_http)
            if resolved_id:
                self.account_id = resolved_id

            if self.ws:
                try:
                    await self.ws.close()
                except Exception:
                    pass

            log.info(f"Connecting to Fusion Markets cTrader ({ConfigManager.ENV.upper()}): {self.ws_url}...")
            self.ws = await websockets.connect(self.ws_url, ping_interval=20, ping_timeout=20)

            if self._listen_task and not self._listen_task.done():
                self._listen_task.cancel()
            self._listen_task = asyncio.create_task(self._listen_loop())

            app_auth_res = await self._send_and_wait(2100, {
                "clientId": self.client_id,
                "clientSecret": self.client_secret
            })
            if not app_auth_res or app_auth_res.get("payloadType") != 2101:
                log.critical(f"cTrader App Auth failed: {app_auth_res}")
                self.is_connecting = False
                return False

            acc_auth_res = await self._send_and_wait(2102, {
                "ctidTraderAccountId": self.account_id,
                "accessToken": self.access_token
            })
            if not acc_auth_res or acc_auth_res.get("payloadType") != 2103:
                err_desc = acc_auth_res.get("payload", {}).get("description") if acc_auth_res else "No response"
                log.critical(f"cTrader Account Auth failed for ID {self.account_id}: {err_desc}")
                self.is_connecting = False
                return False

            self.is_authorized = True

            asset_res = await self._send_and_wait(2112, {"ctidTraderAccountId": self.account_id}, timeout=6.0)
            if asset_res and "asset" in asset_res.get("payload", {}):
                for a in asset_res["payload"]["asset"]:
                    self.asset_map[int(a["assetId"])] = str(a["name"]).upper()

            trader_res = await self._send_and_wait(2121, {
                "ctidTraderAccountId": self.account_id
            })
            if trader_res and "trader" in trader_res.get("payload", {}):
                t_info = trader_res["payload"]["trader"]
                self.money_digits = t_info.get("moneyDigits", 2)
                raw_bal = float(t_info.get("balance", 0))
                self.last_known_balance = raw_bal / (10 ** self.money_digits)
                self.last_known_equity = self.last_known_balance
                raw_asset_id = t_info.get("depositAssetId")
                log.info(f"Raw depositAssetId received from cTrader: {raw_asset_id}")

                if str(raw_asset_id).isdigit() and int(raw_asset_id) in self.asset_map:
                    self.account_currency = self.asset_map[int(raw_asset_id)]
                    log.info(f"--- CTRADER ONLINE --- Currency: {self.account_currency} | Balance: {self.last_known_balance:,.2f}")
                else:
                    self.account_currency = None
                    log.error(f"CRITICAL: depositAssetId {raw_asset_id} not in broker asset_map. Account currency unknown.")

            await self._discover_symbols()
            await self.sync_deals_from_ctrader()
            self.is_connecting = False
            return True

        except Exception as e:
            log.error(f"Failed to connect to cTrader Gateway: {e}")
            self.is_authorized = False
            self.is_connecting = False
            return False

    async def _discover_symbols(self):
        res = await self._send_and_wait(2114, {
            "ctidTraderAccountId": self.account_id,
            "includeArchivedSymbols": False
        })
        if not res or "symbol" not in res.get("payload", {}):
            return

        symbols_list = res["payload"]["symbol"]
        for s in symbols_list:
            sid = s.get("symbolId")
            sname = s.get("symbolName", "").upper()
            digits = s.get("digits", 5)
            self.symbol_map[sname] = sid
            self.symbol_details[sid] = {"name": sname, "digits": digits}

        target_ids = []
        for friendly in ConfigManager.SYMBOL_ALIASES.keys():
            resolved_id = self.resolve_symbol_id(friendly)
            if resolved_id:
                target_ids.append(resolved_id)
                log.info(f"Mapped Whitelist Asset: {friendly} -> Symbol ID {resolved_id} ({self.symbol_details[resolved_id]['name']})")

        if self.account_currency == "ZAR":
            zar_id = self.resolve_symbol_id("USDZAR", use_fx_aliases=True)
            if zar_id and zar_id not in target_ids:
                target_ids.append(zar_id)
                log.info(f"Subscribed Conversion Pair: USDZAR -> Symbol ID {zar_id}")
        elif self.account_currency == "EUR":
            eur_id = self.resolve_symbol_id("EURUSD", use_fx_aliases=True)
            if eur_id and eur_id not in target_ids:
                target_ids.append(eur_id)
                log.info(f"Subscribed Conversion Pair: EURUSD -> Symbol ID {eur_id}")

        if target_ids:
            await self._send(2127, {
                "ctidTraderAccountId": self.account_id,
                "symbolId": target_ids
            })

    def resolve_symbol_id(self, friendly_name: str, use_fx_aliases: bool = False) -> Optional[int]:
        source_dict = FX_CONVERSION_ALIASES if use_fx_aliases else ConfigManager.SYMBOL_ALIASES
        aliases = source_dict.get(friendly_name.upper(), [friendly_name.upper()])
        for a in aliases:
            if a in self.symbol_map:
                return self.symbol_map[a]
        for sname, sid in self.symbol_map.items():
            for a in aliases:
                if a in sname:
                    return sid
        return None

    async def _send(self, payload_type: int, payload: dict, client_msg_id: str = None) -> str:
        msg_id = client_msg_id or self._next_id()
        data = {
            "clientMsgId": msg_id,
            "payloadType": payload_type,
            "payload": payload
        }
        await self.ws.send(json.dumps(data))
        return msg_id

    async def _send_and_wait(self, payload_type: int, payload: dict, timeout: float = 10.0) -> Optional[dict]:
        msg_id = self._next_id()
        fut = asyncio.get_event_loop().create_future()
        self._pending_requests[msg_id] = fut
        try:
            await self._send(payload_type, payload, client_msg_id=msg_id)
            return await asyncio.wait_for(fut, timeout=timeout)
        except Exception as e:
            log.warning(f"Request timeout or error (payloadType {payload_type}): {e}")
            return None
        finally:
            self._pending_requests.pop(msg_id, None)

    async def _listen_loop(self):
        try:
            while self.is_connection_open():
                raw = await self.ws.recv()
                msg = json.loads(raw)
                client_id = msg.get("clientMsgId")
                ptype = msg.get("payloadType")
                payload = msg.get("payload", {})

                if ptype == 51:
                    await self._send(51, {})
                    continue

                if ptype == 2131:
                    sid = payload.get("symbolId")
                    bid = payload.get("bid")
                    ask = payload.get("ask")
                    if sid and (bid or ask):
                        prev = self.live_quotes.get(sid, (0.0, 0.0))
                        digits = self.symbol_details.get(sid, {}).get("digits", 5)
                        new_bid = (bid / (10 ** digits)) if bid else prev[0]
                        new_ask = (ask / (10 ** digits)) if ask else prev[1]
                        self.live_quotes[sid] = (new_bid, new_ask)
                        self.quote_timestamps[sid] = time.time()

                if client_id and client_id in self._pending_requests:
                    self._pending_requests[client_id].set_result(msg)

        except Exception as e:
            log.warning(f"cTrader connection dropped: {e}")
            self.is_authorized = False

    async def get_balance_and_equity(self) -> Tuple[float, float]:
        if not self.is_authorized:
            return self.last_known_balance, self.last_known_equity
        try:
            res = await self._send_and_wait(2121, {"ctidTraderAccountId": self.account_id}, timeout=4.0)
            if res and "trader" in res.get("payload", {}):
                raw_bal = float(res["payload"]["trader"].get("balance", 0))
                self.last_known_balance = raw_bal / (10 ** self.money_digits)

                floating_sum = sum(p.get("floatingPnL", 0.0) for p in self.risk_engine.open_positions.values()) if hasattr(self, 'risk_engine') and self.risk_engine else 0.0
                self.last_known_equity = round(self.last_known_balance + floating_sum, 2)
        except Exception as e:
            log.warning(f"Error fetching balance and equity: {e}")
        return self.last_known_balance, self.last_known_equity

    async def get_live_quote(self, symbol_name: str) -> Tuple[float, float, float]:
        sid = self.resolve_symbol_id(symbol_name)
        if not sid or sid not in self.live_quotes:
            return 0.0, 0.0, 0.0
        bid, ask = self.live_quotes[sid]
        mid = (bid + ask) / 2.0
        return mid, bid, ask

    async def fetch_ohlc_candles(self, symbol_name: str, period: CTraderTrendbarPeriod, count: int = 60) -> pd.DataFrame:
        sid = self.resolve_symbol_id(symbol_name)
        if not sid or not self.is_authorized:
            return pd.DataFrame()

        digits = self.symbol_details.get(sid, {}).get("digits", 5)
        divisor = float(10 ** digits)

        period_minutes_map = {
            CTraderTrendbarPeriod.M1: 1,
            CTraderTrendbarPeriod.M5: 5,
            CTraderTrendbarPeriod.M15: 15,
            CTraderTrendbarPeriod.H1: 60,
            CTraderTrendbarPeriod.H4: 240,
            CTraderTrendbarPeriod.D1: 1440
        }
        bar_min = period_minutes_map.get(period, 5)

        now_ms = int(time.time() * 1000)
        from_ms = now_ms - (count * bar_min * 60 * 1000 * 3)

        res = await self._send_and_wait(2137, {
            "ctidTraderAccountId": self.account_id,
            "symbolId": sid,
            "period": period.value,
            "fromTimestamp": from_ms,
            "toTimestamp": now_ms
        }, timeout=8.0)

        if not res or "trendbar" not in res.get("payload", {}):
            return pd.DataFrame()

        bars = res["payload"]["trendbar"]
        if not bars:
            return pd.DataFrame()

        candles = []
        for b in bars:
            low = float(b.get("low", 0)) / divisor
            open_p = (float(b.get("low", 0)) + float(b.get("deltaOpen", 0))) / divisor
            close_p = (float(b.get("low", 0)) + float(b.get("deltaClose", 0))) / divisor
            high_p = (float(b.get("low", 0)) + float(b.get("deltaHigh", 0))) / divisor
            t_sec = b.get("utcTimestampInMinutes", 0) * 60

            candles.append({
                "time": pd.to_datetime(t_sec, unit="s", utc=True),
                "open": open_p,
                "high": high_p,
                "low": low,
                "close": close_p,
                "tick_volume": b.get("volume", 1)
            })

        df = pd.DataFrame(candles)
        df.sort_values("time", inplace=True)
        if len(df) > 1:
            df = df.iloc[:-1]
        return df.tail(count)

    async def execute_market_order(
        self,
        symbol_name: str,
        direction: str,
        lots: float,
        stop_loss: float,
        take_profit: float,
        strategy_name: str = "QUANT_STRATEGY"
    ) -> Optional[dict]:
        sid = self.resolve_symbol_id(symbol_name)
        if not sid or not self.is_authorized:
            return None

        trade_side = 1 if direction.upper() == "BUY" else 2
        cfg = ConfigManager.ASSETS.get(symbol_name)
        contract_size = cfg.contract_size if cfg else 100000.0

        volume_cents = int(round(lots * contract_size * 100))
        volume_cents = max(volume_cents, 100)

        order_comment = strategy_name[:16]

        order_payload = {
            "ctidTraderAccountId": self.account_id,
            "symbolId": sid,
            "orderType": 1,
            "tradeSide": trade_side,
            "volume": volume_cents,
            "stopLoss": round(stop_loss, 5),
            "takeProfit": round(take_profit, 5),
            "comment": order_comment
        }

        res = await self._send_and_wait(2106, order_payload, timeout=8.0)
        if res and res.get("payloadType") == 2126:
            deal = res.get("payload", {}).get("deal", {})
            pos_id = res.get("payload", {}).get("position", {}).get("positionId")
            log.info(f"CTRADER ORDER FILLED | {direction} {symbol_name} | Pos #{pos_id} | Lots: {lots:.2f} | Strat: {strategy_name}")
            return {
                "deal_id": deal.get("dealId"),
                "position_id": pos_id,
                "volume": volume_cents,
                "lots": lots
            }
        elif res and "errorMessage" in res.get("payload", {}):
            log.error(f"cTrader Order Error: {res['payload']['errorMessage']}")
        return None

    async def update_position_sl(self, position_id: int, new_sl: float) -> bool:
        res = await self._send_and_wait(2110, {
            "ctidTraderAccountId": self.account_id,
            "positionId": int(position_id),
            "stopLoss": round(new_sl, 5)
        }, timeout=6.0)
        return bool(res and res.get("payloadType") == 2126)

    async def close_position(self, position_id: int, volume_cents: int) -> bool:
        res = await self._send_and_wait(2111, {
            "ctidTraderAccountId": self.account_id,
            "positionId": int(position_id),
            "volume": volume_cents
        }, timeout=8.0)
        return bool(res and res.get("payloadType") == 2126)

# ==============================================================================
# 6. ORDER FLOW & VOLUME PROFILE ANALYZER
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
        target_vol = total_vol * 0.75

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
# 7. INSTITUTIONAL RISK ENGINE
# ==============================================================================

class InstitutionalRiskEngine:
    def __init__(self, config_file: str = CONFIG_FILE):
        self.config_file = config_file
        self.persistent_risk = RiskManager(config_file=config_file)

        self.master_execution: bool = True
        self.dry_run: bool = False
        self.risk_per_trade_pct: float = GLOBAL_PARAMS.base_risk_per_trade_pct
        self.risk_to_reward: float = 2.0
        self.daily_goal_target: float = 0.0
        self.weekly_deposit_baseline: float = 10.0
        self.weekly_goal_target: float = 20.0

        self.open_positions: Dict[str, dict] = {}
        self.last_signal_event: Dict[str, str] = {}

        self.max_spread_to_sl_ratio: float = GLOBAL_PARAMS.max_spread_to_sl_ratio
        self.spread_ranges = {
            "GOLD": {"standard": 0.30, "max_allowed": 0.85},
            "US30": {"standard": 2.50, "max_allowed": 6.50},
            "NAS100": {"standard": 1.50, "max_allowed": 3.80},
            "GERMAN30": {"standard": 1.80, "max_allowed": 4.50},
            "EURUSD": {"standard": 0.00010, "max_allowed": 0.00025},
            "USDJPY": {"standard": 0.012, "max_allowed": 0.025},
            "GBPUSD": {"standard": 0.00014, "max_allowed": 0.00030}
        }

        self.SECTOR_MAP = {
            "US30": "EQUITY_INDEX",
            "NAS100": "EQUITY_INDEX",
            "GERMAN30": "EQUITY_INDEX",
            "GOLD": "PRECIOUS_METAL",
            "EURUSD": "FOREX_MAJORS",
            "GBPUSD": "FOREX_MAJORS",
            "USDJPY": "FOREX_MAJORS"
        }

    @property
    def trades_taken_today(self) -> int:
        return self.persistent_risk.trades_taken_today

    @trades_taken_today.setter
    def trades_taken_today(self, val: int):
        self.persistent_risk.trades_taken_today = val
        self.persistent_risk.save_persistent_state()

    @property
    def consecutive_losses(self) -> int:
        return self.persistent_risk.consecutive_losses

    @property
    def max_daily_trades(self) -> int:
        return self.persistent_risk.max_daily_trades

    @max_daily_trades.setter
    def max_daily_trades(self, val: int):
        self.persistent_risk.max_daily_trades = val
        self.persistent_risk.save_persistent_state()

    def sync_ui_config(self) -> None:
        cfg = read_ui_config()
        if not cfg:
            return
        self.master_execution = cfg.get("masterExecution", self.master_execution)
        self.dry_run = cfg.get("dryRun", self.dry_run)
        GLOBAL_PARAMS.adaptive_mode = bool(cfg.get("adaptiveMode", GLOBAL_PARAMS.adaptive_mode))
        GLOBAL_PARAMS.min_rr = float(cfg.get("minRr", GLOBAL_PARAMS.min_rr))
        self.risk_per_trade_pct = float(cfg.get("riskPerTradePct", getattr(self, 'risk_per_trade_pct', GLOBAL_PARAMS.base_risk_per_trade_pct)))
        self.risk_to_reward = float(cfg.get("riskToReward", self.risk_to_reward))
        if "maxDailyTrades" in cfg:
            self.max_daily_trades = int(cfg["maxDailyTrades"])
        self.daily_goal_target = float(cfg.get("dailyGoalTarget", self.daily_goal_target))
        self.weekly_deposit_baseline = float(cfg.get("weeklyDepositBaseline", self.weekly_deposit_baseline or 10.0))
        self.weekly_goal_target = float(cfg.get("weeklyGoalTarget", self.weekly_goal_target or 20.0))

    def has_active_position(self, symbol: str) -> bool:
        for pid, pos in self.open_positions.items():
            if pos.get("symbol") == symbol:
                return True
        return False

    def is_red_folder_active(self) -> bool:
        is_active, _ = MarketSessionManager.is_blackout_active()
        return is_active

    def check_sector_exposure(self, symbol: str) -> Tuple[bool, str]:
        if not GLOBAL_PARAMS.enable_sector_limit:
            return True, ""
        sector = self.SECTOR_MAP.get(symbol, "OTHER")
        for ticket, pos in self.open_positions.items():
            open_sym = pos.get("symbol", "")
            if self.SECTOR_MAP.get(open_sym) == sector:
                return False, f"Sector limit: An open trade already exists in {sector} ({open_sym})."
        return True, ""

    def validate_asset_stop_size(self, symbol: str, sl_distance: float) -> Tuple[bool, str]:
        if symbol == "NAS100":
            if not (GLOBAL_PARAMS.nas100_stop_range[0] <= sl_distance <= GLOBAL_PARAMS.nas100_stop_range[2]):
                return False, f"NAS100 Stop ({sl_distance:.1f} pts) outside spec [35-60 pts]"
        elif symbol == "US30":
            if not (GLOBAL_PARAMS.us30_stop_range[0] <= sl_distance <= GLOBAL_PARAMS.us30_stop_range[2]):
                return False, f"US30 Stop ({sl_distance:.1f} pts) outside spec [30-50 pts]"
        elif symbol == "GOLD":
            pips = sl_distance * 10.0
            if not (GLOBAL_PARAMS.gold_stop_range_pips[0] <= pips <= GLOBAL_PARAMS.gold_stop_range_pips[2]):
                return False, f"Gold Stop ({pips:.1f} pips) outside spec [12-60 pips]"
        return True, "Stop size valid"

    def check_breakeven_trigger(self, entry: float, sl: float, tp: float, current_price: float, direction: str) -> bool:
        total_target_distance = abs(tp - entry)
        if total_target_distance <= 0:
            return False

        sl_distance = abs(entry - sl)
        if direction.upper() == "BUY":
            current_progress = current_price - entry
        else:
            current_progress = entry - current_price

        target_condition = (current_progress / total_target_distance) >= GLOBAL_PARAMS.breakeven_trigger_ratio
        noise_buffer_condition = current_progress >= (0.50 * sl_distance)
        return bool(target_condition and noise_buffer_condition)

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
        range_cfg = self.spread_ranges.get(symbol)

        if range_cfg:
            std_spread = range_cfg["standard"]
            max_allowed = range_cfg["max_allowed"]
            if spread > max_allowed:
                return False, f"Spread ({spread:.5f}) exceeds ceiling ({max_allowed:.5f})", spread
        else:
            if spread > 5.0:
                return False, f"Spread ({spread:.4f}) exceeds default ceiling (5.0)", spread

        if sl_distance > 0 and (spread / sl_distance) > self.max_spread_to_sl_ratio:
            return False, f"Spread is {(spread/sl_distance)*100:.1f}% of SL distance (Max: {self.max_spread_to_sl_ratio*100:.0f}%)", spread

        return True, "Spread optimal", spread

            def calculate_smart_lot_size(
        self,
        current_equity: float,
        sl_distance: float,
        symbol: str,
        current_price: float = 1.0,
        account_currency: Optional[str] = "USD",
        ai_quality_factor: float = 1.0,
        fx_rate_to_account: Optional[float] = 1.0
    ) -> float:
        if fx_rate_to_account is None or fx_rate_to_account <= 0:
            log.error(f"Sizing Engine Rejected: Missing or invalid FX conversion rate to {account_currency}.")
            return 0.0

        equity = current_equity if current_equity > 0 else 10.0

        # Delegate sizing % entirely through unified RiskManager.
        # PROPOSED: Pass account_currency so profile ZAR bands convert correctly.
        _, dow_mult, _ = MarketSessionManager.get_day_of_week_policy()
        final_risk_pct = self.persistent_risk.combined_risk_pct(
            current_equity=equity,
            dow_mult=dow_mult,
            ai_factor=ai_quality_factor,
            account_currency=account_currency,
        )
        risk_cash = equity * (final_risk_pct / 100.0)

        cfg = ConfigManager.ASSETS.get(symbol)
        pip_size = cfg.pip_size if cfg else 0.0001
        contract_size = cfg.contract_size if cfg else 100000.0
        min_lots = cfg.min_lots if cfg else 0.01
        max_lots = cfg.max_lots if cfg else 50.0
        lot_step = cfg.lot_step if cfg else 0.01

        pips_at_risk = (sl_distance / pip_size) if pip_size > 0 else 10.0
        pip_value_per_lot = (pip_size * contract_size) * fx_rate_to_account
        risk_per_lot = pips_at_risk * pip_value_per_lot

        # Min-lot risk ceiling check (cannot exceed tolerance * risk_cash)
        # PROPOSED: log symbol + reason so the UI/logs can show which instrument
        # was skipped for minimum-lot reasons.
        min_lot_ok, min_lot_msg = self.persistent_risk.validate_min_lot_risk(min_lots, risk_per_lot, risk_cash)
        if not min_lot_ok:
            log.warning(
                f"SIZING SKIP on {symbol}: {min_lot_msg} "
                f"(risk_cash=${risk_cash:.4f}, equity=${equity:.2f}, currency={account_currency})"
            )
            self.persistent_risk.last_trigger_reason = f"Min-lot skip on {symbol}: {min_lot_msg}"
            return 0.0

        raw_lots = risk_cash / (risk_per_lot + 1e-9)
        # Broker step quantisation (round before floor to eliminate precision errors)
        stepped_lots = math.floor(round(raw_lots / lot_step, 6)) * lot_step
        final_lots = round(max(min(stepped_lots, max_lots), min_lots), 4)
        return final_lots

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
        current_balance: float = 0.0,
        account_currency: Optional[str] = "USD",
        ai_quality_factor: float = 1.0,
        fx_rate_to_account: Optional[float] = 1.0
    ) -> Tuple[bool, str, dict]:
        self.sync_ui_config()

        can_trade, dd_reason = self.persistent_risk.can_trade_today(current_equity, current_balance)
        if not can_trade:
            return False, dd_reason, {}

        if not self.master_execution:
            return False, "Master execution switch is OFF in UI", {}

        is_blackout, blackout_reason = MarketSessionManager.is_blackout_active()
        if is_blackout:
            return False, f"Macro News Blackout: {blackout_reason}", {}

        can_trade_day, _, day_reason = MarketSessionManager.get_day_of_week_policy()
        if not can_trade_day:
            return False, f"Day-of-Week Policy: {day_reason}", {}

        if self.has_active_position(symbol):
            return False, f"Re-entry Blocked: A trade is already active on {symbol}.", {}

        sector_ok, sector_msg = self.check_sector_exposure(symbol)
        if not sector_ok:
            return False, sector_msg, {}

        if self.trades_taken_today >= self.max_daily_trades:
            return False, f"Daily trade quota reached ({self.trades_taken_today}/{self.max_daily_trades})", {}

        sl_distance = abs(entry_price - stop_loss)
        if sl_distance <= 0:
            return False, "Invalid Stop Loss distance", {}

        if not GLOBAL_PARAMS.adaptive_mode:
            stop_ok, stop_msg = self.validate_asset_stop_size(symbol, sl_distance)
            if not stop_ok:
                return False, f"Stop Range Rejection: {stop_msg}", {}

        final_tp = take_profit
        if final_tp is None or final_tp == 0:
            target_distance = sl_distance * self.risk_to_reward
            final_tp = (entry_price + target_distance) if direction.upper() == "BUY" else (entry_price - target_distance)

        spread_ok, spread_msg, spread_pts = self.evaluate_spread(symbol, current_bid, current_ask, sl_distance)
        if not spread_ok:
            return False, f"Spread Gate Rejection: {spread_msg}", {}

        adjusted_sl = (stop_loss - spread_pts) if direction.upper() == "BUY" else (stop_loss + spread_pts)
        effective_sl_dist = abs(entry_price - adjusted_sl)
        lots = self.calculate_smart_lot_size(
            current_equity, effective_sl_dist, symbol, entry_price, account_currency, ai_quality_factor, fx_rate_to_account
        )
        if lots <= 0.0:
            return False, "Sizing Engine Rejected: Risk exceeds capital allowance.", {}

        blueprint = {
            "symbol": symbol,
            "direction": direction.upper(),
            "lots": lots,
            "entry_price": entry_price,
            "stop_loss": round(adjusted_sl, 5),
            "take_profit": round(final_tp, 5),
            "spread_points": round(spread_pts, 5),
            "is_dry_run": self.dry_run
        }
        return True, "Approved", blueprint

# ==============================================================================
# 8. GEMINI AI OVERSEER
# ==============================================================================

class AIOverseer:
    def __init__(self):
        self.api_key = ConfigManager.GEMINI_API_KEY
        if self.api_key and GENAI_AVAILABLE and GLOBAL_PARAMS.ai_overseer_enabled:
            genai.configure(api_key=self.api_key)
            self.model = genai.GenerativeModel('gemini-1.5-flash')
            log.info("Gemini AI Intuition & Overseer Engine initialized.")
        else:
            self.model = None

    async def evaluate_trade_intuition(
        self,
        signal: Any,
        balance: float,
        daily_target: float,
        trades_left: int,
        candle_stats: dict,
        history: List[dict]
    ) -> Tuple[bool, float, str]:
        if not self.model or not GLOBAL_PARAMS.ai_overseer_enabled:
            return True, 1.0, "Rule-based pass (AI Overseer bypassed per spec)"

        direction = getattr(signal, 'direction', 'BUY')
        symbol = getattr(signal, 'symbol', 'UNKNOWN')
        strategy_name = getattr(signal, 'strategy', getattr(signal, 'setup_type', 'QUANT_SETUP'))
        entry = getattr(signal, 'entry_price', 0.0)
        sl = getattr(signal, 'stop_loss', None) or getattr(signal, 'sl', 0.0)
        tp = getattr(signal, 'take_profit', None) or getattr(signal, 'tp1', 0.0)
        reason = getattr(signal, 'reason', getattr(signal, 'reasoning', ''))

        relevant_trades = [t for t in history if t.get('asset') == symbol or t.get('strategy') == strategy_name]
        wins = [t for t in relevant_trades if t.get('status') == 'WIN']
        hist_win_rate = (len(wins) / len(relevant_trades) * 100) if relevant_trades else 50.0

        prompt = (
            f"You are the Lead Quantitative Risk Manager for an automated fund.\n"
            f"EVALUATE THIS TRADE SETUP:\n"
            f"- Instrument: {symbol} | Direction: {direction} | Strategy: {strategy_name}\n"
            f"- Entry: {entry} | SL: {sl} | TP: {tp} | Reason: {reason}\n"
            f"- Account Balance: {balance:,.2f} | Daily Profit Goal: {daily_target:,.2f} | Trades Left Today: {trades_left}\n"
            f"- Market Regime: {'RANGING' if candle_stats.get('is_ranging') else 'TRENDING'} | M5 ATR: {candle_stats.get('m5_candle_avg')}\n"
            f"- Historical Edge on Pair: {hist_win_rate:.1f}% win rate across {len(relevant_trades)} trades\n\n"
            f"Provide decision in EXACT JSON format:\n"
            f'{{"verdict": "APPROVED" or "REJECTED", "quality_multiplier": 0.5 to 1.5, "reasoning": "brief summary"}}'
        )

        try:
            res = await asyncio.to_thread(self.model.generate_content, prompt)
            text = res.text.strip()
            start = text.find('{')
            end = text.rfind('}') + 1
            if start != -1 and end != 0:
                data = json.loads(text[start:end])
                approved = data.get("verdict", "APPROVED").upper() == "APPROVED"
                multiplier = float(data.get("quality_multiplier", 1.0))
                multiplier = max(0.5, min(multiplier, 1.5))
                reasoning = data.get("reasoning", "AI Validated")
                return approved, multiplier, reasoning
        except Exception as e:
            log.warning(f"AI Intuition fallback: {e}")

        return True, 1.0, "Approved by Quantitative Edge"

# ==============================================================================
# 9. EXECUTION ENGINE
# ==============================================================================

class CloudExecutionEngine:
    def __init__(self, ctrader_client: CTraderClient, risk_mgr: InstitutionalRiskEngine):
        self.ctrader = ctrader_client
        self.risk = risk_mgr
        self.ai_overseer = AIOverseer()

    async def process_signal(self, signal: Any, current_balance: float, current_equity: float, candle_stats: dict) -> bool:
        symbol = getattr(signal, 'symbol')
        direction = getattr(signal, 'direction')
        entry = getattr(signal, 'entry_price')
        sl = getattr(signal, 'stop_loss', None) or getattr(signal, 'sl', 0.0)
        tp = getattr(signal, 'take_profit', None) or getattr(signal, 'tp1', None)
        trail_mode = getattr(signal, 'trail_mode', 'MOVE_TO_BE_80')

        strategy_name = getattr(signal, 'strategy', getattr(signal, 'setup_type', 'QUANT_SETUP'))
        if isinstance(strategy_name, Enum):
            strategy_name = strategy_name.value

        fixed_tp = compute_fixed_target(signal, GLOBAL_PARAMS.target_rr)
        if fixed_tp is None:
            log.info(f"ORDER BLOCKED: no room for target on {symbol} with strategy {strategy_name}.")
            return False
        tp = fixed_tp

        quote, bid, ask = await self.ctrader.get_live_quote(symbol)

        if not is_ok:
            log.warning(f"ORDER BLOCKED BY RISK GATE: {reason}")
            # PROPOSED: Capture last risk block reason for status reporting
            self.risk.persistent_risk.last_trigger_reason = reason
            return False

        def quote_lookup(pair: str) -> Optional[Tuple[float, float, float]]:
            sid = self.ctrader.resolve_symbol_id(pair, use_fx_aliases=True)
            if not sid or sid not in self.ctrader.live_quotes:
                return None
            b, a = self.ctrader.live_quotes[sid]
            age = time.time() - self.ctrader.quote_timestamps.get(sid, 0.0)
            return (b, a, age)

        fx_rate = get_fx_rate_to_account(symbol, self.ctrader.account_currency, quote_lookup)
        if fx_rate is None:
            log.error(f"ORDER BLOCKED: Failed FX quote conversion for {symbol} to {self.ctrader.account_currency}.")
            return False

        history = read_trade_history()
        trades_left = max(1, self.risk.max_daily_trades - self.risk.trades_taken_today)
        ai_approved, quality_mult, ai_notes = await self.ai_overseer.evaluate_trade_intuition(
            signal, current_balance, self.risk.daily_goal_target, trades_left, candle_stats, history
        )

        if not ai_approved:
            log.info(f"AI INTUITION REJECTED TRADE: {ai_notes}")
            return False

        is_ok, reason, bp = self.risk.validate_pre_trade(
            symbol=symbol,
            direction=direction,
            entry_price=entry,
            stop_loss=sl,
            take_profit=tp,
            current_bid=bid,
            current_ask=ask,
            current_equity=current_equity,
            current_balance=current_balance,
            account_currency=self.ctrader.account_currency,
            ai_quality_factor=quality_mult,
            fx_rate_to_account=fx_rate
        )

        if not is_ok:
            log.warning(f"ORDER BLOCKED BY RISK GATE: {reason}")
            return False

        is_dry_run = getattr(signal, 'is_dry_run', False) or bp.get("is_dry_run", False)

        if is_dry_run:
            msg = (
                f"🔵 *[SIMULATED TRADE]*\n"
                f"• Asset: {bp['symbol']}\n"
                f"• Strategy: {strategy_name}\n"
                f"• Direction: {bp['direction']}\n"
                f"• Lots: {bp['lots']}\n"
                f"• Entry: {bp['entry_price']}\n"
                f"• SL: {bp['stop_loss']}\n"
                f"• TP: {bp['take_profit']}"
            )
            log.info(f"[SIMULATOR] Approved: {bp['direction']} {bp['symbol']} | Lots: {bp['lots']}")
            await whatsapp.send_alert(msg)
            return True

        total_lots = bp['lots']
        log.info(f"DISPATCHING ORDER | {bp['direction']} {bp['symbol']} | Lots: {total_lots} | Strat: {strategy_name}")

        res = await self.ctrader.execute_market_order(bp['symbol'], bp['direction'], total_lots, bp['stop_loss'], bp['take_profit'], strategy_name)

        if res:
            self.risk.trades_taken_today += 1
            now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

            pid = str(res["position_id"])
            contract_size = ConfigManager.ASSETS[bp['symbol']].contract_size if bp['symbol'] in ConfigManager.ASSETS else 100000.0

            self.ctrader._save_position_strategy(pid, strategy_name)
            self.risk.open_positions[pid] = {
                "symbol": bp['symbol'],
                "strategy": strategy_name,
                "direction": bp['direction'],
                "entry_price": bp['entry_price'],
                "stop_loss": bp['stop_loss'],
                "take_profit": bp['take_profit'],
                "volume_cents": res["volume"],
                "lots": res["lots"],
                "contract_size": contract_size,
                "is_be_moved": False,
                "trail_mode": trail_mode
            }
            save_trade_record({
                "id": f"pos-{pid}",
                "ticket": f"#{pid}",
                "asset": bp['symbol'],
                "strategy": strategy_name,
                "type": bp['direction'],
                "lots": res["lots"],
                "openPrice": bp['entry_price'],
                "closePrice": bp['entry_price'],
                "pnl": 0.0,
                "openTime": now_iso,
                "closeTime": "OPEN",
                "status": "OPEN",
                "source": "Fusion cTrader"
            })

            whatsapp_msg = (
                f"🟢 *[FUSION CTRADER ORDER FILLED]*\n"
                f"• Asset: {bp['symbol']}\n"
                f"• Strategy: {strategy_name}\n"
                f"• Direction: {bp['direction']}\n"
                f"• Lots: {total_lots}\n"
                f"• Entry: {bp['entry_price']}\n"
                f"• SL: {bp['stop_loss']}\n"
                f"• TP: {bp['take_profit']}"
            )
            await whatsapp.send_alert(whatsapp_msg)
            return True

# ==============================================================================
# 10. MASTER ORCHESTRATOR
# ==============================================================================

class MatrixEngineMaster:
    def __init__(self):
        self.ctrader = CTraderClient()
        self.strategy_mgr = StrategyManager()
        self.risk_mgr = InstitutionalRiskEngine()
        self.ctrader.risk_engine = self.risk_mgr
        self.execution_engine: Optional[CloudExecutionEngine] = None
        self.volume_profiles: Dict[str, VolumeProfileNode] = {}
        self.frozen_opening_ranges: Dict[Tuple[str, str], Dict[str, Any]] = {}
        # PROPOSED: Read-only periodic status logging timer
        self._last_status_log_time: float = 0.0
        self._last_risk_block_reason: str = "None"

    async def start(self) -> None:
        log.info("Starting Nexus Matrix Trading Engine (Fusion Markets / cTrader Edition)...")
        while not await self.ctrader.connect():
            log.warning("Connection attempt failed. Retrying in 10s...")
            await asyncio.sleep(10.0)

        broker_positions = await self.ctrader.reconcile_open_positions()
        for bp in broker_positions:
            pid = bp["position_id"]
            self.risk_mgr.open_positions[pid] = bp
            log.info(f"Reconciled Existing In-Flight Position: #{pid} ({bp['direction']} {bp['symbol']}) | Strategy: {bp['strategy']}")

        balance, equity = await self.ctrader.get_balance_and_equity()
        self.execution_engine = CloudExecutionEngine(self.ctrader, self.risk_mgr)
        log.info(f"SYSTEM READY. Currency: {self.ctrader.account_currency or 'UNKNOWN'} | Balance: {balance:,.2f}")

        await asyncio.gather(
            self._market_scan_loop(),
            self._position_supervisor_loop(),
            self._daily_eod_flusher_loop(),
            self._manual_close_listener_loop()
        )

    # PROPOSED: Verify broker close confirmation and log exceptions with log.exception
    async def _manual_close_listener_loop(self) -> None:
        while True:
            try:
                if os.path.exists(CLOSE_COMMAND_FILE):
                    try:
                        with open(CLOSE_COMMAND_FILE, "r", encoding="utf-8") as f:
                            cmd = json.load(f)
                        os.remove(CLOSE_COMMAND_FILE)
                        pid = str(cmd.get("positionId"))
                        if pid and pid in self.risk_mgr.open_positions:
                            pos = self.risk_mgr.open_positions[pid]
                            log.info(f"Manual close command received for Position #{pid} ({pos['symbol']})")
                            closed = await self.ctrader.close_position(int(pid), pos.get("volume_cents", 100))
                            if closed:
                                self.risk_mgr.open_positions.pop(pid, None)
                                log.info(f"Position #{pid} confirmed closed on broker and removed from supervision.")
                            else:
                                log.error(f"Broker rejected close for Position #{pid}. Retaining under active supervision.")
                    except Exception as e:
                        log.exception(f"Error executing manual position close: {e}")
                await asyncio.sleep(1.0)
            except Exception as e:
                log.exception(f"Unexpected error in _manual_close_listener_loop: {e}")
                await asyncio.sleep(3.0)

    async def _position_supervisor_loop(self) -> None:
        while True:
            try:
                await self.ctrader.ensure_connection()

                for pid, pos in list(self.risk_mgr.open_positions.items()):
                    sym = pos["symbol"]
                    direction = pos["direction"]
                    entry = pos["entry_price"]
                    sl = pos["stop_loss"]
                    tp = pos["take_profit"]
                    be_moved = pos.get("is_be_moved", False)
                    trail_mode = pos.get("trail_mode", "MOVE_TO_BE_80")

                    quote, bid, ask = await self.ctrader.get_live_quote(sym)
                    if quote <= 0:
                        continue

                    if GLOBAL_PARAMS.use_supertrend_trail and trail_mode == "SUPERTREND":
                        m5_candles = await self.ctrader.fetch_ohlc_candles(sym, CTraderTrendbarPeriod.M5, count=25)
                        if not m5_candles.empty and len(m5_candles) >= 12:
                            st_df = calculate_supertrend(m5_candles, period=10, factor=1.6)
                            curr_dir = int(st_df['supertrend_direction'].iloc[-1])
                            if (direction == "BUY" and curr_dir == -1) or (direction == "SELL" and curr_dir == 1):
                                log.info(f"SUPERTREND TRAIL FLIP on {sym} (Pos #{pid})! Closing position.")
                                closed = await self.ctrader.close_position(int(pid), pos.get("volume_cents", 100))
                                if closed:
                                    self.risk_mgr.open_positions.pop(pid, None)
                                    alert = f"🛑 *[SUPERTREND TRAIL EXIT]*\n• {direction} {sym} closed as SuperTrend flipped against trend."
                                    await whatsapp.send_alert(alert)
                                continue

                    if GLOBAL_PARAMS.use_breakeven and not be_moved and self.risk_mgr.check_breakeven_trigger(entry, sl, tp, quote, direction):
                        log.info(f"DYNAMIC BREAKEVEN HIT ON {sym} (Pos #{pid})! Moving SL to Break-Even.")
                        success = await self.ctrader.update_position_sl(int(pid), new_sl=entry)
                        if success:
                            pos["is_be_moved"] = True
                            alert = f"🛡️ *[BREAK-EVEN MOVED]*\n• {direction} {sym} progressed >=80% of TP!\n• SL moved to Entry ({entry}).\n• Trade is now Risk-Free."
                            await whatsapp.send_alert(alert)

                await asyncio.sleep(2.0)
            except Exception as e:
                log.error(f"Error in Position Supervisor: {e}")
                await asyncio.sleep(4.0)

    async def _daily_eod_flusher_loop(self) -> None:
        while True:
            try:
                now_sast = datetime.now(timezone.utc).astimezone(TZ_SAST)
                hour = now_sast.hour
                minute = now_sast.minute

                if hour == 21 and minute == 0 and len(self.risk_mgr.open_positions) > 0:
                    log.warning(f"21:00 SAST LOCKDOWN: Closing {len(self.risk_mgr.open_positions)} open positions to cash.")
                    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

                    for pid, pos in list(self.risk_mgr.open_positions.items()):
                        closed = await self.ctrader.close_position(int(pid), pos.get("volume_cents", 100))
                        if closed:
                            save_trade_record({
                                "ticket": f"#{pid}",
                                "closePrice": pos.get("entry_price"),
                                "closeTime": now_str,
                                "status": "CLOSED_EOD",
                                "pnl": 0.0
                            })
                            self.risk_mgr.open_positions.pop(pid, None)

                    eod_msg = f"🌆 *[DAILY 21:00 SAST LOCKDOWN]*\n• Flattened open trades to cash.\n• Zero overnight holding risk."
                    await whatsapp.send_alert(eod_msg)
                    await asyncio.sleep(65.0)

                await asyncio.sleep(10.0)
            except Exception as e:
                log.error(f"Error in EOD Flusher: {e}")
                await asyncio.sleep(30.0)

    def _compute_frozen_opening_range(self, symbol: str, m5_df: pd.DataFrame) -> Tuple[float, float, bool, float, float, bool]:
        now = datetime.now(timezone.utc)
        today_str = now.strftime("%Y-%m-%d")
        cache_key = (symbol, today_str)

        if cache_key in self.frozen_opening_ranges:
            entry = self.frozen_opening_ranges[cache_key]
            return entry['high'], entry['low'], True, entry.get('cracker_high', entry['high']), entry.get('cracker_low', entry['low']), True

        times = MarketSessionManager.get_current_times(now)
        in_london = MarketSessionManager.is_in_london_open(now)
        in_ny = MarketSessionManager.is_in_ny_open(now)

        if not (in_london or in_ny):
            h, l = float(m5_df['high'].tail(12).max()), float(m5_df['low'].tail(12).min())
            return h, l, True, h, l, True

        m5_df_time = pd.to_datetime(m5_df['time'])
        if in_london:
            t_open_local = times["LONDON"].replace(hour=8, minute=0, second=0, microsecond=0)
            t_open_utc = t_open_local.astimezone(timezone.utc)
        else:
            t_open_local = times["NEWYORK"].replace(hour=9, minute=30, second=0, microsecond=0)
            t_open_utc = t_open_local.astimezone(timezone.utc)

        session_candles = m5_df[m5_df_time >= t_open_utc]

        cracker_h = float(session_candles.head(1)['high'].max()) if len(session_candles) >= 1 else 0.0
        cracker_l = float(session_candles.head(1)['low'].min()) if len(session_candles) >= 1 else 0.0
        cracker_established = len(session_candles) >= 1

        if len(session_candles) < 3:
            return 0.0, 0.0, False, cracker_h, cracker_l, cracker_established

        first_3_candles = session_candles.head(3)
        orb_h = float(first_3_candles['high'].max())
        orb_l = float(first_3_candles['low'].min())

        self.frozen_opening_ranges[cache_key] = {
            'high': orb_h, 
            'low': orb_l,
            'cracker_high': cracker_h,
            'cracker_low': cracker_l
        }
        log.info(f"FROZEN 15M OPENING RANGE for {symbol}: High = {orb_h:.5f}, Low = {orb_l:.5f} | 5M Cracker: High = {cracker_h:.5f}, Low = {cracker_l:.5f}")
        return orb_h, orb_l, True, cracker_h, cracker_l, True

    async def _market_scan_loop(self) -> None:
        while True:
            try:
                start_time = time.time()
                await self.ctrader.ensure_connection()

                await self.ctrader.ensure_account_currency()
                self.risk_mgr.persistent_risk.check_currency_change(self.ctrader.account_currency)

                def quote_lookup(pair: str) -> Optional[Tuple[float, float, float]]:
                    sid = self.ctrader.resolve_symbol_id(pair, use_fx_aliases=True)
                    if not sid or sid not in self.ctrader.live_quotes:
                        return None
                    b, a = self.ctrader.live_quotes[sid]
                    age = time.time() - self.ctrader.quote_timestamps.get(sid, 0.0)
                    return (b, a, age)

                for pid, p in self.risk_mgr.open_positions.items():
                    q, bid, ask = await self.ctrader.get_live_quote(p["symbol"])
                    if q > 0:
                        pos_price = bid if p["direction"] == "BUY" else ask
                        diff = (pos_price - p["entry_price"]) if p["direction"] == "BUY" else (p["entry_price"] - pos_price)
                        c_size = ConfigManager.ASSETS[p["symbol"]].contract_size if p["symbol"] in ConfigManager.ASSETS else 100000.0
                        fx_rate = get_fx_rate_to_account(p["symbol"], self.ctrader.account_currency, quote_lookup) or 1.0
                        p["floatingPnL"] = round(diff * p["lots"] * c_size * fx_rate, 2)

                broker_positions = await self.ctrader.reconcile_open_positions()
                broker_pids = set()
                for bp in broker_positions:
                    pid = bp["position_id"]
                    broker_pids.add(pid)
                    if pid not in self.risk_mgr.open_positions:
                        self.risk_mgr.open_positions[pid] = bp

                for local_pid in list(self.risk_mgr.open_positions.keys()):
                    if local_pid not in broker_pids:
                        self.risk_mgr.open_positions.pop(local_pid, None)

                await self.ctrader.sync_deals_from_ctrader()
                balance, equity = await self.ctrader.get_balance_and_equity()
                self.risk_mgr.sync_ui_config()

                last_signal: Optional[Any] = None

                for friendly_name in ConfigManager.SYMBOL_ALIASES.keys():
                    await asyncio.sleep(0.20)

                    if self.risk_mgr.has_active_position(friendly_name):
                        continue

                    m5_df = await self.ctrader.fetch_ohlc_candles(friendly_name, CTraderTrendbarPeriod.M5, count=120)
                    h1_df = await self.ctrader.fetch_ohlc_candles(friendly_name, CTraderTrendbarPeriod.H1, count=30)
                    h4_df = await self.ctrader.fetch_ohlc_candles(friendly_name, CTraderTrendbarPeriod.H4, count=30)
                    d1_df = await self.ctrader.fetch_ohlc_candles(friendly_name, CTraderTrendbarPeriod.D1, count=150)

                    if m5_df.empty:
                        continue

                    update_candle_cache(friendly_name, m5_df)

                    vol_metrics = {"valid": False}
                    adr_val = None
                    if GLOBAL_PARAMS.adaptive_mode:
                        q_mid, _, _ = await self.ctrader.get_live_quote(friendly_name)
                        vol_metrics = volatility_engine.compute_symbol_volatility(d1_df, m5_df, q_mid, friendly_name)
                        if vol_metrics.get("valid", False):
                            adr_val = vol_metrics["adr"]

                    candle_stats = self.risk_mgr.calculate_candle_metrics(m5_df, h4_df, d1_df)
                    vp = OrderFlowAnalyzer.compute_volume_profile(m5_df, num_bins=30)
                    self.volume_profiles[friendly_name] = vp

                    if len(d1_df) >= 2:
                        prev_d1 = d1_df.iloc[-2]
                        pdh = float(prev_d1['high'])
                        pdl = float(prev_d1['low'])
                        pdc = float(prev_d1['close'])
                    else:
                        pdh = float(m5_df['high'].max())
                        pdl = float(m5_df['low'].min())
                        pdc = float(m5_df.iloc[-1]['close'])

                    daily_pivot = (pdh + pdl + pdc) / 3.0
                    pivot_r1 = (2.0 * daily_pivot) - pdl
                    pivot_s1 = (2.0 * daily_pivot) - pdh
                    pivot_r2 = daily_pivot + (pdh - pdl)
                    pivot_s2 = daily_pivot - (pdh - pdl)
                    daily_eq = (pdh + pdl) / 2.0

                    m5_df['utc_time'] = pd.to_datetime(m5_df['time'])
                    asia_candles = m5_df[(m5_df['utc_time'].dt.hour >= 23) | (m5_df['utc_time'].dt.hour < 4)]
                    if not asia_candles.empty:
                        asia_high = float(asia_candles['high'].max())
                        asia_low = float(asia_candles['low'].min())
                    else:
                        asia_high = float(m5_df['high'].tail(36).max())
                        asia_low = float(m5_df['low'].tail(36).min())

                    weekly_open = float(d1_df.iloc[-1]['open']) if not d1_df.empty else float(m5_df.iloc[-1]['open'])
                    if not d1_df.empty:
                        d1_times_shifted = pd.to_datetime(d1_df['time'], utc=True) + pd.Timedelta(hours=3)
                        curr_week = d1_times_shifted.iloc[-1].isocalendar().week
                        curr_year = d1_times_shifted.iloc[-1].isocalendar().year
                        week_bars = d1_df[(d1_times_shifted.dt.isocalendar().week == curr_week) & (d1_times_shifted.dt.isocalendar().year == curr_year)]
                        if not week_bars.empty:
                            weekly_open = float(week_bars.iloc[0]['open'])

                    avwap_anchor_idx = 0
                    if not m5_df.empty:
                        mon_candles = m5_df[m5_df['utc_time'].dt.weekday == 0]
                        if not mon_candles.empty:
                            avwap_anchor_idx = int(m5_df.index.get_loc(mon_candles.index[0]))

                    orb_h, orb_l, orb_established, cracker_h, cracker_l, cracker_established = self._compute_frozen_opening_range(friendly_name, m5_df)

                    session_levels = build_session_levels(
                        symbol=friendly_name,
                        m5_df=m5_df,
                        d1_df=d1_df,
                        vp_node=vp,
                        frozen_orbs=self.frozen_opening_ranges,
                        as_of=None,
                        adr_val=adr_val
                    )
                    session_levels["is_ranging"] = candle_stats["is_ranging"]
                    session_levels["range_span"] = candle_stats["range_span"]

                    signal = self.strategy_mgr.evaluate_all(
                        symbol=friendly_name, 
                        data_5m=m5_df, 
                        data_h4=h4_df, 
                        data_d1=d1_df, 
                        session_levels=session_levels,
                        data_h1=h1_df
                    )

                    if signal and GLOBAL_PARAMS.adaptive_mode:
                        if not vol_metrics.get("valid", False):
                            log.warning(f"Vol metrics invalid for {friendly_name}; skipping setup under adaptive_mode.")
                            continue

                        adapted = volatility_engine.adapt_signal(signal, vol_metrics, self.risk_mgr.risk_to_reward, session_levels)
                        if not adapted:
                            continue

                        quote, bid, ask = await self.ctrader.get_live_quote(friendly_name)
                        spread = abs(ask - bid)
                        adapted_sl_dist = abs(adapted.entry_price - adapted.stop_loss)
                        adapted_tp_dist = abs(adapted.take_profit_2 - adapted.entry_price)
                        vol_ok, vol_msg = volatility_engine.evaluate_volatility_filters(
                            vol_metrics, spread, adapted_sl_dist, adapted_tp_dist, adapted.direction, adapted.entry_price, adapted.strategy
                        )
                        if not vol_ok:
                            continue
                        signal = adapted

                    if signal:
                        latest_candle_time = str(m5_df.iloc[-1]['time'])
                        event_key = f"{friendly_name}_{signal.strategy}_{latest_candle_time}"

                        if self.risk_mgr.last_signal_event.get(friendly_name) != event_key:
                            self.risk_mgr.last_signal_event[friendly_name] = event_key
                            last_signal = signal
                            await self.execution_engine.process_signal(signal, balance, equity, candle_stats)

                regime_status = "ACTIVE" if self.risk_mgr.master_execution else "HALTED"
                active_setup_str = getattr(last_signal, 'strategy', getattr(last_signal, 'setup_type', 'NONE')) if last_signal else "NONE"
                if isinstance(active_setup_str, Enum):
                    active_setup_str = active_setup_str.value
                verdict_str = getattr(last_signal, 'reason', getattr(last_signal, 'reasoning', '')) if last_signal else "Scanning all day on Fusion Markets cTrader."

                open_positions_telemetry = []
                for pid, p in self.risk_mgr.open_positions.items():
                    q, _, _ = await self.ctrader.get_live_quote(p["symbol"])
                    entry = p["entry_price"]
                    direction = p["direction"]
                    lots = p["lots"]

                    open_positions_telemetry.append({
                        "id": pid,
                        "ticket": f"#{pid}",
                        "symbol": p["symbol"],
                        "strategy": p.get("strategy", self.ctrader.position_strategies.get(pid, "QUANT_STRATEGY")),
                        "direction": direction,
                        "lots": lots,
                        "entry": entry,
                        "currentPrice": q,
                        "sl": p["stop_loss"],
                        "tp": p["take_profit"],
                        "floatingPnL": p.get("floatingPnL", 0.0),
                        "isRiskFree": p.get("is_be_moved", False)
                    })

                history = read_trade_history()
                closed_history = [t for t in history if t.get('status') in ('WIN', 'LOSS', 'BREAKEVEN')]
                total_closed = len(closed_history)
                wins = len([t for t in closed_history if t.get('status') == 'WIN'])
                losses = len([t for t in closed_history if t.get('status') == 'LOSS'])
                win_rate = round((wins / total_closed * 100.0), 1) if total_closed > 0 else 0.0
                net_profit = round(sum(t.get('pnl', 0.0) for t in closed_history), 2)

                telem_msg = json.dumps({
                    "balance": balance,
                    "equity": equity,
                    "currency": self.ctrader.account_currency or "UNKNOWN",
                    "regime": regime_status,
                    "active_setup": active_setup_str,
                    "ai_verdict": verdict_str,
                    "netProfit": net_profit,
                    "winRate": win_rate,
                    "totalTrades": total_closed,
                    "winningTrades": wins,
                    "losingTrades": losses,
                    "openPositions": open_positions_telemetry
                })
                # PROPOSED: Periodic read-only status log every 5 minutes (300 seconds)
                if (time.time() - self._last_status_log_time) >= 300.0:
                    self._last_status_log_time = time.time()
                    b_state = self.risk_mgr.persistent_risk
                    breaker_str = "TRIGGERED" if b_state.breaker_triggered else "CLEAR"
                    master_str = "ARMED" if self.risk_mgr.master_execution else "HALTED"
                    block_msg = b_state.last_trigger_reason or "None"
                    log.info(
                        f"[BOT_STATUS] Master: {master_str} | Breaker: {breaker_str} (Scope: {b_state.active_trip_scope}) | "
                        f"Trades: {b_state.trades_taken_today}/{b_state.max_daily_trades} | "
                        f"Currency: {self.ctrader.account_currency or 'UNKNOWN'} | Equity: ${equity:.2f} | "
                        f"Last Block: {block_msg}"
                    )
                    
                print(f"[MATRIX_TELEMETRY] {telem_msg}", flush=True)
                write_telemetry(balance, equity, regime_status, active_setup_str, verdict_str, open_positions_telemetry)

                elapsed = time.time() - start_time
                await asyncio.sleep(max(1.0, 60.0 - elapsed))

            except asyncio.CancelledError:
                break
            except Exception as e:
                log.error(f"Scan loop error: {e}")
                await asyncio.sleep(5)

# ==============================================================================
# 11. ENTRY POINT
# ==============================================================================

def start_bot() -> None:
    master = MatrixEngineMaster()
    try:
        asyncio.run(master.start())
    except KeyboardInterrupt:
        log.info("Shutdown signal received. Stopping Nexus Matrix.")

if __name__ == "__main__":
    start_bot()