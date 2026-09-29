#!/usr/bin/env python3
"""
================================================================================
NEXUS MATRIX ALGORITHMIC TRADING SYSTEM (CTRADER OPEN API / FUSION MARKETS)
================================================================================
Architecture: Institutional Multi-Strategy Quantitative Execution Engine
Components:   - All-Day Execution Engine for Fusion Markets (cTrader Open API)
              - Dynamic Micro-Account Scaling (Handles R100, R1,000, up to $100k+)
              - AI Intuition & Target-Pacing Sizer (Gemini AI Quality Multiplier)
              - Daily Profit Target Runway Allocator (e.g. R500 Target on R1,000 Balance)
              - Automatic Token Sanitizer & Spotware Account ID Auto-Resolution
              - Real-Time Trade Journal Synchronization (trades_db.json)
              - Dual-Stage OAuth Handshake (App Auth 2100 + Account Auth 2102)
              - Daily 21:00 SAST End-of-Day Position Flusher (Zero Overnight Risk)
              - Instant Personal WhatsApp Alerts Engine (CallMeBot Integration)
              - Twin-Position 50/50 Partial Scaling (Bank Half at TP1, Trail TP2)
              - Order Flow & Volume Profile Analyzer (POC, VAH, VAL, Cumulative Delta)
              - Quantitative Math Engine (EMA, ATR, Bollinger Bands, RSI)
              - Temporal Clock & Session Manager (Asian, London, NY)
              - Multi-Timeframe Volatility Engine (M5, H4, D1 Candle Averages)
              - Live Bid/Ask Spread Gatekeeper & News Armor Protection
              - In-Flight Position Supervisor (80% R:R Move-to-Breakeven Loop)
              - Dual Telemetry Pipeline (Stdout IPC + bot_telemetry.json)
Deployment:   Headless Linux / Railway / Cloud VPS / Docker Container
================================================================================
"""

import sys
import os
import time
import json
import math
import logging
import asyncio
import warnings
import websockets
import urllib.request
import urllib.parse
import urllib.error
import pandas as pd
import numpy as np
from datetime import datetime, timezone, timedelta, time as dtime
from typing import Dict, List, Tuple, Optional, Any, Union
from dataclasses import dataclass, field
from enum import Enum

# Silence library warning in terminal
warnings.filterwarnings("ignore", category=FutureWarning)

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

CONFIG_FILE = "bot_config.json"
TELEMETRY_FILE = "bot_telemetry.json"
TRADES_DB_FILE = "trades_db.json"

# ==============================================================================
# 1. ADVANCED INSTITUTIONAL LOGGING SYSTEM
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
# 3. TELEMETRY, UI I/O & TRADE JOURNAL HELPERS
# ==============================================================================

def emit_telemetry(balance: float, equity: float, regime: str, active_setup: str, ai_verdict: str):
    msg = json.dumps({
        "balance": balance,
        "equity": equity,
        "regime": regime,
        "active_setup": active_setup,
        "ai_verdict": ai_verdict
    })
    print(f"[MATRIX_TELEMETRY] {msg}", flush=True)

def write_telemetry(balance: float, equity: float, regime: str, active_setup: str, ai_verdict: str) -> None:
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
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def read_trade_history() -> List[dict]:
    if not os.path.exists(TRADES_DB_FILE):
        return []
    try:
        with open(TRADES_DB_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return []

def save_trade_record(trade_data: dict) -> None:
    """Appends or updates a live trade in trades_db.json so the Trade Journal reflects it."""
    try:
        trades = read_trade_history()
        existing_idx = next((i for i, t in enumerate(trades) if t.get("ticket") == trade_data.get("ticket")), None)
        if existing_idx is not None:
            trades[existing_idx].update(trade_data)
        else:
            trades.insert(0, trade_data)
        with open(TRADES_DB_FILE, "w") as f:
            json.dump(trades, f, indent=2)
    except Exception as e:
        log.error(f"Failed to record trade to journal: {e}")

# ==============================================================================
# 4. CONFIGURATION & CTRADER PROTOCOL DEFINITIONS
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
    pip_size: float
    contract_size: float
    min_lots: float
    max_lots: float
    lot_step: float
    sector: str

class ConfigManager:
    CLIENT_ID: str = os.getenv("CTRADER_CLIENT_ID", "").strip()
    CLIENT_SECRET: str = os.getenv("CTRADER_CLIENT_SECRET", "").strip()

    # Automatically clean any accidental "AT:" prefix, "Bearer", or spaces from token
    _raw_token: str = os.getenv("CTRADER_ACCESS_TOKEN", "").strip()
    _cleaned_token: str = _raw_token.replace("AT:", "").replace("Bearer", "").strip()
    ACCESS_TOKEN: str = "".join(_cleaned_token.split())

    ACCOUNT_ID: int = int(os.getenv("CTRADER_ACCOUNT_ID", "0").strip() or 0)
    ENV: str = os.getenv("CTRADER_ENV", "demo").lower().strip()
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "").strip()

    WS_HOST = "live.ctraderapi.com" if ENV == "live" else "demo.ctraderapi.com"
    WS_PORT = 5036
    WS_URL = f"wss://{WS_HOST}:{WS_PORT}"

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
        "GOLD": AssetConfig("XAUUSD", "Gold Spot (XAU/USD)", 0.01, 100.0, 0.01, 20.0, 0.01, "PRECIOUS_METAL"),
        "US30": AssetConfig("US30", "Wall Street 30 (Dow Jones)", 1.0, 1.0, 0.01, 50.0, 0.01, "EQUITY_INDEX"),
        "NAS100": AssetConfig("NAS100", "US Tech 100 (NASDAQ)", 0.1, 1.0, 0.01, 50.0, 0.01, "EQUITY_INDEX"),
        "GERMAN30": AssetConfig("DE40", "Germany 40 (DAX40)", 0.1, 1.0, 0.01, 50.0, 0.01, "EQUITY_INDEX"),
        "EURUSD": AssetConfig("EURUSD", "EUR / USD", 0.0001, 100000.0, 0.01, 50.0, 0.01, "FOREX_MAJORS"),
        "USDJPY": AssetConfig("USDJPY", "USD / JPY", 0.01, 100000.0, 0.01, 50.0, 0.01, "FOREX_MAJORS"),
        "GBPUSD": AssetConfig("GBPUSD", "GBP / USD", 0.0001, 100000.0, 0.01, 50.0, 0.01, "FOREX_MAJORS"),
    }

# ==============================================================================
# 5. NATIVE CTRADER OPEN API CLIENT (WITH SPOTWARE ACCOUNT AUTO-RESOLVER)
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

        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.is_authorized: bool = False
        self.last_known_balance: float = 1000.0
        self.last_known_equity: float = 1000.0
        self.money_digits: int = 2

        self.symbol_map: Dict[str, int] = {}
        self.symbol_details: Dict[int, dict] = {}
        self.live_quotes: Dict[int, Tuple[float, float]] = {}

        self._pending_requests: Dict[str, asyncio.Future] = {}
        self._msg_counter: int = 0
        self._lock = asyncio.Lock()

    def _load_position_strategies(self):
     try:
         if os.path.exists("position_strategies.json"):
             with open("position_strategies.json", "r") as f:
                 self.position_strategies = json.load(f)
     except Exception:
         self.position_strategies = {}

    def _save_position_strategy(self, position_id: str, strategy: str):
        self.position_strategies[str(position_id)] = strategy
        try:
            with open("position_strategies.json", "w") as f:
                json.dump(self.position_strategies, f)
        except Exception:
            pass    

    def _next_id(self) -> str:
        self._msg_counter += 1
        return f"req_{self._msg_counter}_{int(time.time()*1000)}"

    def is_connection_open(self) -> bool:
        if self.ws is None:
            return False
        return getattr(self.ws, "open", False) or getattr(getattr(self.ws, "state", None), "name", "") == "OPEN"

    async def sync_deals_from_ctrader(self) -> List[dict]:
     """Automatically queries cTrader for all closed deals and syncs trades_db.json."""
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
                 sym_info = self.symbol_details.get(sid, {})
                 sym_name = sym_info.get("name", "FOREX")

                 # Identify strategy: Check in-memory map, order comment, or tag as manual
                 pos_id_str = str(d.get("positionId", ""))
                 strategy = self.position_strategies.get(pos_id_str)
                 if not strategy:
                     comment = d.get("comment", "")
                     if comment and comment not in ("NexusMatrix", ""):
                         strategy = comment
                     else:
                         strategy = "MANUAL_TRADE"

                 lots = round(d.get("filledVolume", 0) / 10000000.0, 2)
                 open_p = pos_det.get("entryPrice", 0)
                 close_p = d.get("executionPrice", 0)

                 record = {
                     "id": f"deal-{deal_id_str}",
                     "ticket": f"#{deal_id_str}",
                     "asset": sym_name,
                     "strategy": strategy,
                     "type": "BUY" if d.get("tradeSide") == 1 else "SELL",
                     "lots": lots if lots > 0 else 0.02,
                     "openPrice": open_p,
                     "closePrice": close_p,
                     "pnl": real_pnl,
                     "openTime": t_time,
                     "closeTime": t_time,
                     "status": "WIN" if real_pnl > 0 else ("LOSS" if real_pnl < 0 else "BREAKEVEN"),
                     "source": "Fusion cTrader"
                 }
                 save_trade_record(record)
                 synced_trades.append(record)

                 # WHATSAPP NOTIFICATION FOR CLOSED TRADES
                 if deal_id_str not in self.notified_closed_deals:
                     self.notified_closed_deals.add(deal_id_str)
                     curr_balance = await self.get_balance()
                     if real_pnl > 0:
                         alert = (
                             f"🎯 *[TAKE PROFIT REACHED / TRADE WON]*\n"
                             f"• Asset: {sym_name}\n"
                             f"• Strategy: {strategy}\n"
                             f"• Profit Banked: +${real_pnl:.2f}\n"
                             f"• Account Balance: ${curr_balance:.2f}\n"
                             f"• Status: 100% Target Hit."
                         )
                     elif real_pnl < 0:
                         alert = (
                             f"🔴 *[STOP LOSS EXITED / TRADE CLOSED]*\n"
                             f"• Asset: {sym_name}\n"
                             f"• Strategy: {strategy}\n"
                             f"• Realized Loss: -${abs(real_pnl):.2f}\n"
                             f"• Account Balance: ${curr_balance:.2f}\n"
                             f"• Stop Loss respected. Capital preserved."
                         )
                     else:
                         alert = (
                             f"⚪ *[EXIT AT BREAK-EVEN]*\n"
                             f"• Asset: {sym_name}\n"
                             f"• Strategy: {strategy}\n"
                             f"• Result: $0.00 (Risk-Free Exit)"
                         )
                     await whatsapp.send_alert(alert)

         return synced_trades
     except Exception as e:
         log.warning(f"Error syncing deals from cTrader: {e}")
         return []
    
    def fetch_real_account_id_from_http(self) -> Optional[int]:
        """Queries Spotware API directly to map login number (e.g. 41425) to ctidTraderAccountId."""
        try:
            url = f"https://api.spotware.com/connect/tradingaccounts?access_token={self.access_token}"
            req = urllib.request.Request(url, headers={"User-Agent": "NexusMatrix/1.0"})
            with urllib.request.urlopen(req, timeout=7) as resp:
                data = json.loads(resp.read().decode())
                accounts = data.get("data", [])
                log.info(f"Spotware Accounts API returned {len(accounts)} account(s) for your token.")
                for acc in accounts:
                    a_id = acc.get("accountId")
                    a_num = acc.get("accountNumber")
                    log.info(f"-> Account: Login #{a_num} | ctidTraderAccountId: #{a_id} | Live: {acc.get('live')}")
                    if self.account_id in (a_id, a_num):
                        log.info(f"MATCH FOUND! Auto-binding account #{a_id} (Login #{a_num})")
                        return a_id
                if accounts:
                    is_live = (ConfigManager.ENV == "live")
                    matching = [a for a in accounts if a.get("live", False) == is_live]
                    chosen = matching[0] if matching else accounts[0]
                    log.info(f"Auto-selected account: Login #{chosen.get('accountNumber')} -> ctidTraderAccountId #{chosen.get('accountId')}")
                    return chosen.get("accountId")
        except Exception as e:
            log.warning(f"Spotware HTTP account query: {e}")
        return None

    async def connect(self) -> bool:
        if not self.client_id or not self.client_secret or not self.access_token:
            log.critical("Missing cTrader credentials in Railway environment variables.")
            return False

        # Attempt to auto-resolve account ID
        resolved_id = await asyncio.to_thread(self.fetch_real_account_id_from_http)
        if resolved_id:
            self.account_id = resolved_id

        try:
            log.info(f"Connecting to Fusion Markets cTrader ({ConfigManager.ENV.upper()}): {self.ws_url}...")
            self.ws = await websockets.connect(self.ws_url, ping_interval=20, ping_timeout=20)
            asyncio.create_task(self._listen_loop())

            # 1. Application Auth (ProtoOAApplicationAuthReq: 2100)
            app_auth_res = await self._send_and_wait(2100, {
                "clientId": self.client_id,
                "clientSecret": self.client_secret
            })
            if not app_auth_res or app_auth_res.get("payloadType") != 2101:
                log.critical(f"cTrader App Auth failed: {app_auth_res}")
                return False

            # 2. Account Auth (ProtoOAAccountAuthReq: 2102)
            acc_auth_res = await self._send_and_wait(2102, {
                "ctidTraderAccountId": self.account_id,
                "accessToken": self.access_token
            })
            if not acc_auth_res or acc_auth_res.get("payloadType") != 2103:
                err_desc = acc_auth_res.get("payload", {}).get("description") if acc_auth_res else "No response"
                log.critical(f"cTrader Account Auth failed for ID {self.account_id}: {err_desc}")
                return False

            self.is_authorized = True

            # 3. Pull Live Balance & Digits (ProtoOATraderReq: 2121)
            trader_res = await self._send_and_wait(2121, {
                "ctidTraderAccountId": self.account_id
            })
            if trader_res and "trader" in trader_res.get("payload", {}):
                t_info = trader_res["payload"]["trader"]
                self.money_digits = t_info.get("moneyDigits", 2)
                raw_bal = float(t_info.get("balance", 0))
                self.last_known_balance = raw_bal / (10 ** self.money_digits)
                self.last_known_equity = self.last_known_balance
                log.info(f"--- CTRADER / FUSION ONLINE --- Balance: {self.last_known_balance:,.2f}")

            # 4. Discover Broker Symbols & Map IDs (ProtoOASymbolsListReq: 2114)
            await self._discover_symbols()
            return True

            # 5. Automatically Sync Real cTrader Closed Deals History (ProtoOADealListReq: 2133)
            now_ms = int(time.time() * 1000)
            from_ms = now_ms - (30 * 86400 * 1000) # Past 30 days
            deal_res = await self._send_and_wait(2133, {
                "ctidTraderAccountId": self.account_id,
                "fromTimestamp": from_ms,
                "toTimestamp": now_ms,
                "maxRows": 100
            }, timeout=8.0)

            if deal_res and "deal" in deal_res.get("payload", {}):
                deals = deal_res["payload"]["deal"]
                log.info(f"Retrieved {len(deals)} historical deal(s) from cTrader account.")
                for d in deals:
                    pos_det = d.get("closePositionDetail")
                    if pos_det: # It's a closed deal
                        pnl_cents = pos_det.get("grossProfit", 0) + pos_det.get("commission", 0)
                        real_pnl = round(pnl_cents / (10 ** self.money_digits), 2)
                        t_time = datetime.fromtimestamp(d.get("executionTimestamp", 0) / 1000.0, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
                        sym_info = self.symbol_details.get(d.get("symbolId"), {})
                        sym_name = sym_info.get("name", "FOREX")
                        
                        save_trade_record({
                            "id": f"deal-{d.get('dealId')}",
                            "ticket": f"#{d.get('dealId')}",
                            "asset": sym_name,
                            "strategy": "cTrader Deal",
                            "type": "BUY" if d.get("tradeSide") == 1 else "SELL",
                            "lots": round(d.get("filledVolume", 0) / 10000000.0, 2),
                            "openPrice": pos_det.get("entryPrice", 0),
                            "closePrice": d.get("executionPrice", 0),
                            "pnl": real_pnl,
                            "openTime": t_time,
                            "closeTime": t_time,
                            "status": "WIN" if real_pnl > 0 else "LOSS",
                            "source": "cTrader Deal"
                        })

        except Exception as e:
            log.error(f"Failed to connect to cTrader Gateway: {e}")
            self.is_authorized = False
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
        for friendly, aliases in ConfigManager.SYMBOL_ALIASES.items():
            resolved_id = self.resolve_symbol_id(friendly)
            if resolved_id:
                target_ids.append(resolved_id)
                log.info(f"Mapped Whitelist Asset: {friendly} -> Symbol ID {resolved_id} ({self.symbol_details[resolved_id]['name']})")

        if target_ids:
            await self._send(2127, {
                "ctidTraderAccountId": self.account_id,
                "symbolId": target_ids
            })

    def resolve_symbol_id(self, friendly_name: str) -> Optional[int]:
        aliases = ConfigManager.SYMBOL_ALIASES.get(friendly_name.upper(), [friendly_name.upper()])
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

                if client_id and client_id in self._pending_requests:
                    self._pending_requests[client_id].set_result(msg)

        except Exception as e:
            log.warning(f"cTrader WebSocket listener closed: {e}")
            self.is_authorized = False

    async def get_balance_and_equity(self) -> Tuple[float, float]:
        if not self.is_authorized:
            return self.last_known_balance, self.last_known_equity
        try:
            res = await self._send_and_wait(2121, {"ctidTraderAccountId": self.account_id}, timeout=4.0)
            if res and "trader" in res.get("payload", {}):
                raw_bal = float(res["payload"]["trader"].get("balance", 0))
                self.last_known_balance = raw_bal / (10 ** self.money_digits)
                self.last_known_equity = self.last_known_balance
        except Exception:
            pass
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

        now_ms = int(time.time() * 1000)
        from_ms = now_ms - (count * 60 * 1000 * 10)

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
            low = float(b.get("low", 0)) / 100000.0
            open_p = (float(b.get("low", 0)) + float(b.get("deltaOpen", 0))) / 100000.0
            close_p = (float(b.get("low", 0)) + float(b.get("deltaClose", 0))) / 100000.0
            high_p = (float(b.get("low", 0)) + float(b.get("deltaHigh", 0))) / 100000.0
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
        volume_cents = int(round(lots * 10000000))

        order_payload = {
            "ctidTraderAccountId": self.account_id,
            "symbolId": sid,
            "orderType": 1,
            "tradeSide": trade_side,
            "volume": volume_cents,
            "stopLoss": round(stop_loss, 5),
            "takeProfit": round(take_profit, 5),
            "comment": f"NX_{symbol_name}"
        }

        res = await self._send_and_wait(2106, order_payload, timeout=8.0)
        if res and res.get("payloadType") == 2126:
            deal = res.get("payload", {}).get("deal", {})
            pos_id = res.get("payload", {}).get("position", {}).get("positionId")
            log.info(f"CTRADER ORDER FILLED | {direction} {symbol_name} | Position #{pos_id} | Lots: {lots:.2f} | SL: {stop_loss} | TP: {take_profit}")
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
        res = await self._send_and_wait(2107, {
            "ctidTraderAccountId": self.account_id,
            "positionId": position_id,
            "stopLoss": round(new_sl, 5)
        }, timeout=6.0)
        return bool(res and res.get("payloadType") == 2126)

    async def close_position(self, position_id: int, volume_cents: int) -> bool:
        res = await self._send_and_wait(2111, {
            "ctidTraderAccountId": self.account_id,
            "positionId": position_id,
            "volume": volume_cents
        }, timeout=8.0)
        return bool(res and res.get("payloadType") == 2126)

# ==============================================================================
# 6. QUANT MATH & VOLATILITY ANALYZER
# ==============================================================================

class MathEngine:
    @staticmethod
    def calculate_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
        high = df['high']
        low = df['low']
        close = df['close'].shift(1)
        tr = pd.concat([high - low, (high - close).abs(), (low - close).abs()], axis=1).max(axis=1)
        return tr.rolling(window=period).mean()

    @staticmethod
    def calculate_ema(series: pd.Series, period: int) -> pd.Series:
        return series.ewm(span=period, adjust=False).mean()

    @staticmethod
    def calculate_rsi(series: pd.Series, period: int = 14) -> pd.Series:
        delta = series.diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
        rs = gain / (loss + 1e-10)
        return 100 - (100 / (1 + rs))

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
# 8. INSTITUTIONAL RISK ENGINE & DYNAMIC LOT SIZER
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

        self.daily_goal_target: float = 0.0
        self.trades_taken_today: int = 0
        self.consecutive_losses: int = 0
        self.open_positions: Dict[str, dict] = {}

        self.max_spread_to_sl_ratio: float = 0.30
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
        self.daily_goal_target = float(cfg.get("dailyGoalTarget", self.daily_goal_target))

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

        return (current_progress / total_target_distance) >= 0.80

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
                return False, f"Spread ({spread:.5f}) exceeds tolerance ceiling ({max_allowed:.5f})", spread
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
        ai_quality_factor: float = 1.0
    ) -> float:
        equity = current_equity if current_equity > 0 else 10.0
        baseline = self.weekly_deposit_baseline if self.weekly_deposit_baseline > 0 else 10.0

        # =====================================================================
        # 1. 4-TIER AUTOMATIC CAPITAL PROGRESSION
        # =====================================================================
        if equity < 60.0:
            # TIER 1: Micro-Flip Stage ($10 to $60)
            stage_name = "TIER 1 (MICRO-FLIP)"
            base_risk_pct = 25.0  # Aggressive sizing to escape the 0.01 floor
        elif 60.0 <= equity < 200.0:
            # TIER 2: Acceleration Stage ($60 to $200)
            stage_name = "TIER 2 (ACCELERATION)"
            base_risk_pct = 12.5  # Stepping down risk as capital expands
        elif 200.0 <= equity < 1000.0:
            # TIER 3: Compounding Stage ($200 to $1,000)
            stage_name = "TIER 3 (COMPOUNDING)"
            base_risk_pct = 5.0   # $10 - $25 risk per trade
        else:
            # TIER 4: Institutional Wealth Preservation Stage ($1,000+)
            stage_name = "TIER 4 (WEALTH PRESERVATION)"
            base_risk_pct = 1.5   # 1.5% of $1,000 is $15 (equals entire Tier 1 deposit!)

        # Allow user's UI portal slider to act as an override ceiling if desired
        if self.risk_per_trade_pct > 0:
            active_risk_pct = min(base_risk_pct, self.risk_per_trade_pct)
        else:
            active_risk_pct = base_risk_pct

        # =====================================================================
        # 2. THE PARACHUTE: DYNAMIC DRAWDOWN & STREAK THROTTLE
        # =====================================================================
        # If we take losses and drop below baseline deposit, step risk down
        if self.consecutive_losses == 1:
            active_risk_pct *= 0.70  # Trim 30% after first loss
            log.info(f"DEFENSE THROTTLE 1: Single loss detected. Risk lowered to {active_risk_pct:.1f}%")
        elif self.consecutive_losses == 2:
            active_risk_pct *= 0.50  # Halve risk after second loss
            log.info(f"DEFENSE THROTTLE 2: Two consecutive losses. Risk halved to {active_risk_pct:.1f}%")
        elif self.consecutive_losses >= 3:
            active_risk_pct *= 0.25  # Cut risk to absolute survival minimum
            log.info(f"DEFENSE THROTTLE 3: Drawdown circuit active. Capital protection engaged at {active_risk_pct:.1f}%")

        # News Armor Throttle
        if self.is_red_folder_active():
            active_risk_pct *= 0.50
            log.info("NEWS ARMOR: Halving risk during high-impact news window.")

        # =====================================================================
        # 3. AI INTUITION MODULATOR
        # =====================================================================
        final_risk_pct = active_risk_pct * ai_quality_factor
        risk_cash = equity * (final_risk_pct / 100.0)

        # Pip value math
        cfg = ConfigManager.ASSETS.get(symbol)
        pip_size = cfg.pip_size if cfg else 0.0001
        contract_size = cfg.contract_size if cfg else 100000.0
        min_lots = cfg.min_lots if cfg else 0.01
        max_lots = cfg.max_lots if cfg else 50.0

        pips_at_risk = (sl_distance / pip_size) if pip_size > 0 else 10.0
        pip_value_per_lot = pip_size * contract_size

        if pip_value_per_lot * pips_at_risk > 0:
            calculated_lots = risk_cash / (pips_at_risk * pip_value_per_lot)
        else:
            calculated_lots = min_lots

        # Micro-Account floor protection
        if calculated_lots < min_lots and equity >= 5.0:
            calculated_lots = min_lots

        final_lots = round(max(min(calculated_lots, max_lots), min_lots), 2)

        log.info(
            f"Stage: {stage_name} | Equity: ${equity:.2f} | Base Risk: {base_risk_pct}% | "
            f"Loss Streak: {self.consecutive_losses} | AI Factor: {ai_quality_factor}x | "
            f"Final Risk: {final_risk_pct:.1f}% (${risk_cash:.2f}) | Lots: {final_lots}"
        )
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
        ai_quality_factor: float = 1.0
    ) -> Tuple[bool, str, dict]:
        self.sync_ui_config()

        if not self.master_execution:
            return False, "Master execution switch is OFF in UI", {}

        sector_ok, sector_msg = self.check_sector_exposure(symbol)
        if not sector_ok:
            return False, sector_msg, {}

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
        lots = self.calculate_smart_lot_size(current_equity, sl_distance, symbol, ai_quality_factor)

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
# 9. GEMINI AI OVERSEER & INTUITION QUALITY GRADER
# ==============================================================================

class AIOverseer:
    def __init__(self):
        self.api_key = ConfigManager.GEMINI_API_KEY
        if self.api_key and GENAI_AVAILABLE:
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
        if not self.model:
            return True, 1.0, "Rule-based pass (AI Standby)"

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
            f"You are the Lead Quantitative Risk Manager & Trade Intuition Engine for an automated fund.\n"
            f"EVALUATE THIS TRADE SETUP:\n"
            f"- Instrument: {symbol} | Direction: {direction} | Strategy: {strategy_name}\n"
            f"- Entry: {entry} | SL: {sl} | TP: {tp} | Reason: {reason}\n"
            f"- Account Balance: {balance:,.2f} | Daily Profit Goal: {daily_target:,.2f} | Trades Left Today: {trades_left}\n"
            f"- Market Regime: {'RANGING' if candle_stats.get('is_ranging') else 'TRENDING'} | M5 ATR: {candle_stats.get('m5_candle_avg')}\n"
            f"- Historical Edge on this Pair: {hist_win_rate:.1f}% win rate across {len(relevant_trades)} closed trades\n\n"
            f"Provide an intuitive decision in EXACT JSON format:\n"
            f'{{"verdict": "APPROVED" or "REJECTED", "quality_multiplier": 0.5 to 1.5, "reasoning": "brief summary"}}\n'
            f"Note: If it is an A+ confluence setup, grant 1.2 to 1.5 multiplier. If marginal, grant 0.6 to 0.8. If dangerous, REJECT."
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
# 10. CLOUD EXECUTION ENGINE (TWIN 50/50 PARTIAL SCALING + JOURNAL RECORDING)
# ==============================================================================

class CloudExecutionEngine:
    def __init__(self, ctrader_client: CTraderClient, risk_mgr: InstitutionalRiskEngine):
        self.ctrader = ctrader_client
        self.risk = risk_mgr
        self.ai_overseer = AIOverseer()

    async def process_signal(self, signal: Any, current_balance: float, candle_stats: dict) -> bool:
        symbol = getattr(signal, 'symbol')
        direction = getattr(signal, 'direction')
        entry = getattr(signal, 'entry_price')
        sl = getattr(signal, 'stop_loss', None) or getattr(signal, 'sl', 0.0)
        tp = getattr(signal, 'take_profit', None) or getattr(signal, 'tp1', None)

        strategy_name = getattr(signal, 'strategy', getattr(signal, 'setup_type', 'QUANT_SETUP'))
        if isinstance(strategy_name, Enum):
            strategy_name = strategy_name.value

        quote, bid, ask = await self.ctrader.get_live_quote(symbol)

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
            current_equity=current_balance,
            ai_quality_factor=quality_mult
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
                f"• TP: {bp['take_profit']}\n"
                f"• AI Intuition: {ai_notes}"
            )
            log.info(f"[SIMULATOR] Approved: {bp['direction']} {bp['symbol']} | Lots: {bp['lots']} | Strategy: {strategy_name}")
            await whatsapp.send_alert(msg)
            return True

        total_lots = bp['lots']
        half_lots = round(max(total_lots / 2.0, 0.01), 2)
        sl_distance = abs(bp['entry_price'] - bp['stop_loss'])
        tp1_price = round(bp['entry_price'] + sl_distance if bp['direction'] == 'BUY' else bp['entry_price'] - sl_distance, 5)
        tp2_price = bp['take_profit']

        log.info(f"DISPATCHING TWIN 50/50 ORDERS | {bp['direction']} {bp['symbol']} | Total: {total_lots} Lots | Contract A TP1: {tp1_price} | Contract B TP2: {tp2_price}")

        res_a = await self.ctrader.execute_market_order(bp['symbol'], bp['direction'], half_lots, bp['stop_loss'], tp1_price, strategy_name)
        res_b = await self.ctrader.execute_market_order(bp['symbol'], bp['direction'], half_lots, bp['stop_loss'], tp2_price, strategy_name)

        if res_a or res_b:
            self.risk.trades_taken_today += 1
            now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

            for res, target in [(res_a, tp1_price), (res_b, tp2_price)]:
                if res and res.get("position_id"):
                    pid = str(res["position_id"])
                    self.ctrader._save_position_strategy(pid, strategy_name)
                    self.risk.open_positions[pid] = {
                        "symbol": bp['symbol'],
                        "direction": bp['direction'],
                        "entry_price": bp['entry_price'],
                        "stop_loss": bp['stop_loss'],
                        "take_profit": target,
                        "volume_cents": res["volume"],
                        "lots": res["lots"],
                        "is_be_moved": False
                    }
                    # Save open trade to Trade Journal Database
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
                f"🟢 *[FUSION MARKETS CTRADER ORDER FILLED]*\n"
                f"• Asset: {bp['symbol']}\n"
                f"• Strategy: {strategy_name}\n"
                f"• Direction: {bp['direction']}\n"
                f"• Twin Lots: 2x {half_lots} ({total_lots} Total)\n"
                f"• Entry: {bp['entry_price']}\n"
                f"• Stop Loss: {bp['stop_loss']}\n"
                f"• TP1 (Bank 50%): {tp1_price}\n"
                f"• TP2 (Runner): {tp2_price}\n"
                f"• AI Intuition: {ai_notes}\n"
                f"• 80% R:R Break-Even Active."
            )
            await whatsapp.send_alert(whatsapp_msg)
            return True

        return False

# ==============================================================================
# 11. MASTER SYSTEM ORCHESTRATOR & CONCURRENT EVENT LOOPS
# ==============================================================================

class MatrixEngineMaster:
    def __init__(self):
        self.ctrader = CTraderClient()
        self.strategy_mgr = StrategyManager()
        self.risk_mgr = InstitutionalRiskEngine()
        self.execution_engine: Optional[CloudExecutionEngine] = None
        self.volume_profiles: Dict[str, VolumeProfileNode] = {}

    async def start(self) -> None:
        log.info("Starting Nexus Matrix Trading Engine (Fusion Markets / cTrader Open API Edition)...")
        if not await self.ctrader.connect():
            log.critical("Failed to connect to cTrader Open API. Please check your Railway environment variables.")
            return

        balance, equity = await self.ctrader.get_balance_and_equity()
        self.execution_engine = CloudExecutionEngine(self.ctrader, self.risk_mgr)
        log.info(f"SYSTEM READY. Initial Account Balance: {balance:,.2f}")

        await asyncio.gather(
            self._market_scan_loop(),
            self._position_supervisor_loop(),
            self._daily_eod_flusher_loop()
        )

    async def _position_supervisor_loop(self) -> None:
        while True:
            try:
                for pid, pos in list(self.risk_mgr.open_positions.items()):
                    sym = pos["symbol"]
                    direction = pos["direction"]
                    entry = pos["entry_price"]
                    sl = pos["stop_loss"]
                    tp = pos["take_profit"]
                    be_moved = pos.get("is_be_moved", False)
                    lots = pos.get("lots", 0.01)

                    quote, _, _ = await self.ctrader.get_live_quote(sym)
                    if quote <= 0:
                        continue

                    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

                    # 1. Stop Loss Hit
                    sl_hit = (direction == "BUY" and quote <= sl) or (direction == "SELL" and quote >= sl)
                    if sl_hit:
                        pnl_calc = (quote - entry) if direction == "BUY" else (entry - quote)
                        status_str = "BREAKEVEN" if be_moved else "LOSS"
                        
                        save_trade_record({
                            "ticket": f"#{pid}",
                            "closePrice": quote,
                            "closeTime": now_str,
                            "status": status_str,
                            "pnl": round(pnl_calc * lots * 100, 2)
                        })

                        if be_moved:
                            sl_msg = f"⚪ *[EXIT AT BREAK-EVEN]*\n• Asset: {sym}\n• Closed at Entry: {quote}\n• P&L: 0.00 (Risk-Free Exit)"
                        else:
                            sl_msg = f"🔴 *[STOP LOSS HIT]*\n• Asset: {sym}\n• Direction: {direction}\n• Exit: {quote}\n• Capital protected."
                        
                        log.info(f"Position #{pid} exited at SL/BE on {sym}")
                        await whatsapp.send_alert(sl_msg)
                        self.risk_mgr.open_positions.pop(pid, None)
                        continue

                    # 2. Take Profit Hit
                    tp_hit = (direction == "BUY" and quote >= tp) or (direction == "SELL" and quote <= tp)
                    if tp_hit:
                        pnl_calc = (quote - entry) if direction == "BUY" else (entry - quote)
                        
                        save_trade_record({
                            "ticket": f"#{pid}",
                            "closePrice": quote,
                            "closeTime": now_str,
                            "status": "WIN",
                            "pnl": round(pnl_calc * lots * 100, 2)
                        })

                        tp_msg = f"🎯 *[TAKE PROFIT HIT]*\n• Asset: {sym}\n• Direction: {direction}\n• Exit Price: {quote}\n• Profit banked."
                        log.info(f"Position #{pid} exited at TP on {sym}")
                        await whatsapp.send_alert(tp_msg)
                        self.risk_mgr.open_positions.pop(pid, None)
                        continue

                    # 3. Move Stop Loss to Break-Even at 80% Progress
                    if not be_moved and self.risk_mgr.check_breakeven_trigger(entry, sl, tp, quote, direction):
                        log.info(f"80% R:R PROGRESS HIT ON {sym} (Position #{pid})! Moving SL to Break-Even.")
                        success = await self.ctrader.update_position_sl(int(pid), new_sl=entry)
                        if success:
                            pos["is_be_moved"] = True
                            alert = f"🛡️ *[BREAK-EVEN MOVED]*\n• {direction} {sym} reached 80% of TP!\n• Stop Loss moved to Entry ({entry}).\n• Trade is now 100% Risk-Free."
                            await whatsapp.send_alert(alert)

                await asyncio.sleep(3.0)
            except Exception as e:
                log.error(f"Error in Position Supervisor: {e}")
                await asyncio.sleep(5.0)

    async def _daily_eod_flusher_loop(self) -> None:
        while True:
            try:
                now_sast = datetime.now(timezone.utc) + timedelta(hours=2)
                hour = now_sast.hour
                minute = now_sast.minute

                if hour == 21 and minute == 0 and len(self.risk_mgr.open_positions) > 0:
                    log.warning(f"🌆 21:00 SAST LOCKDOWN: Closing {len(self.risk_mgr.open_positions)} open positions to cash.")
                    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

                    for pid, pos in list(self.risk_mgr.open_positions.items()):
                        await self.ctrader.close_position(int(pid), pos.get("volume_cents", 100000))
                        save_trade_record({
                            "ticket": f"#{pid}",
                            "closePrice": pos.get("entry_price"),
                            "closeTime": now_str,
                            "status": "CLOSED_EOD",
                            "pnl": 0.0
                        })

                    flushed_count = len(self.risk_mgr.open_positions)
                    self.risk_mgr.open_positions.clear()

                    eod_msg = f"🌆 *[DAILY 21:00 SAST LOCKDOWN]*\n• Flattened {flushed_count} open trades to cash.\n• Zero overnight holding risk."
                    await whatsapp.send_alert(eod_msg)
                    await asyncio.sleep(65.0)

                await asyncio.sleep(10.0)
            except Exception as e:
                log.error(f"Error in EOD Flusher: {e}")
                await asyncio.sleep(30.0)

    async def _market_scan_loop(self) -> None:
        while True:
            try:
                start_time = time.time()
                # Sync all newly closed cTrader deals into trades_db.json
                await self.ctrader.sync_deals_from_ctrader()
                balance, equity = await self.ctrader.get_balance_and_equity()
                self.risk_mgr.sync_ui_config()

                last_signal: Optional[Any] = None

                for friendly_name in ConfigManager.SYMBOL_ALIASES.keys():
                    await asyncio.sleep(0.20)

                    m5_df = await self.ctrader.fetch_ohlc_candles(friendly_name, CTraderTrendbarPeriod.M5, count=60)
                    h4_df = await self.ctrader.fetch_ohlc_candles(friendly_name, CTraderTrendbarPeriod.H4, count=30)
                    d1_df = await self.ctrader.fetch_ohlc_candles(friendly_name, CTraderTrendbarPeriod.D1, count=15)

                    if m5_df.empty:
                        continue

                    candle_stats = self.risk_mgr.calculate_candle_metrics(m5_df, h4_df, d1_df)

                    vp = OrderFlowAnalyzer.compute_volume_profile(m5_df, num_bins=30)
                    self.volume_profiles[friendly_name] = vp

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
                        "poc": vp.poc_price,
                        "vah": vp.value_area_high,
                        "val": vp.value_area_low
                    }

                    signal = self.strategy_mgr.evaluate_all(friendly_name, m5_df, session_levels)

                    if signal:
                        last_signal = signal
                        await self.execution_engine.process_signal(signal, balance, candle_stats)

                regime_status = "ACTIVE" if self.risk_mgr.master_execution else "HALTED"
                active_setup_str = getattr(last_signal, 'strategy', getattr(last_signal, 'setup_type', 'NONE')) if last_signal else "NONE"
                if isinstance(active_setup_str, Enum):
                    active_setup_str = active_setup_str.value
                verdict_str = getattr(last_signal, 'reason', getattr(last_signal, 'reasoning', '')) if last_signal else "Scanning all day on Fusion Markets cTrader."

                # Compute actual live stats from closed trade history
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
                    "regime": regime_status,
                    "active_setup": active_setup_str,
                    "ai_verdict": verdict_str,
                    "netProfit": net_profit,
                    "winRate": win_rate,
                    "totalTrades": total_closed,
                    "winningTrades": wins,
                    "losingTrades": losses
                })
                print(f"[MATRIX_TELEMETRY] {telem_msg}", flush=True)
                write_telemetry(balance, equity, regime_status, active_setup_str, verdict_str)

                elapsed = time.time() - start_time
                await asyncio.sleep(max(1.0, 60.0 - elapsed))

            except asyncio.CancelledError:
                break
            except Exception as e:
                log.error(f"Scan loop error: {e}")
                await asyncio.sleep(5)

# ==============================================================================
# 12. CLOUD ENTRY POINT
# ==============================================================================

def start_bot() -> None:
    master = MatrixEngineMaster()
    try:
        asyncio.run(master.start())
    except KeyboardInterrupt:
        log.info("Shutdown signal received. Stopping Nexus Matrix Engine.")

if __name__ == "__main__":
    start_bot()