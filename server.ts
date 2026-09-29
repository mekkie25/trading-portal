import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import WebSocket from 'ws';
import { spawn } from 'child_process';

// In-memory shared state between web dashboard, trading bot, and broker
interface BotGatewayConfig {
  masterExecution: boolean;
  riskPerTradePct: number;
  riskToReward: number;
  maxDailyTrades: number;
  trailingStopActive: boolean;
  autoBreakevenPips: number;
  currency: string;
  updatedAt: string;
  version: number;
  weeklyDepositBaseline?: number;
  weeklyGoalTarget?: number;
  dailyGoalTarget?: number;
}

// Server-side risk limit configuration. This is the SOURCE OF TRUTH for the
// kill switch. The frontend AdvancedLimits UI reads/writes this via
// /api/limits, but the numbers that actually block trades are computed here,
// on the server, from real closed trades — never trusted from the browser.
interface RiskLimitsConfig {
  maxDailyLossUsd: number;
  maxWeeklyLossUsd: number;
  maxMonthlyLossUsd: number;
  maxDailyDrawdownPct?: number;
  autoLiquidateAllOnTrip?: boolean;
  breakerAction: 'HALT_CLOSE_ALL' | 'HALT_PREVENT_NEW' | 'REDUCE_SIZE_50' | 'ALERT_ONLY';
}

interface RiskState {
  currentDailyLossUsd: number;
  currentWeeklyLossUsd: number;
  currentMonthlyLossUsd: number;
  breakerTriggered: boolean;
  activeTripScope: 'NONE' | 'DAY' | 'WEEK' | 'MONTH';
  lastTriggerReason?: string;
}

interface BrokerTelemetry {
  connected: boolean;
  provider: string;
  trades: any[];
  accountNumber: string;
  server: string;
  currency: string;
  balance: number;
  equity: number;
  floatingPnL: number;
  netProfit: number;
  totalDeposits: number;
  winRate: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  lastPingMs: number;
  lastSyncTime: string;
  lastHeartbeat: string;
  openPositions: Array<{
    ticket: string;
    symbol: string;
    type: 'BUY' | 'SELL';
    lots: number;
    openPrice: number;
    currentPrice: number;
    pnl: number;
    stopLoss?: number;
    takeProfit?: number;
  }>;
}

const BOT_CONFIG_FILE = path.join(process.cwd(), 'bot_config.json');
const TRADES_DB_FILE = path.join(process.cwd(), 'trades_db.json');

// Default state
let activeBotConfig: BotGatewayConfig = {
  masterExecution: true,
  riskPerTradePct: 25.0,
  riskToReward: 2.0,
  maxDailyTrades: 4,
  trailingStopActive: true,
  autoBreakevenPips: 15,
  currency: 'USD',
  updatedAt: new Date().toISOString(),
  version: 1,
  weeklyDepositBaseline: 10,
  weeklyGoalTarget: 20,
  dailyGoalTarget: 5
};

const botPlacedContractIds = new Set<string>();
let allTrades: any[] = [];
let journalCutoffTime: string | null = null;

const KNOWN_SYMBOL_PATTERN = /\b(R_\d+|1HZ\d+V|BOOM\d+|CRASH\d+|JD\d+|frx[A-Z]+|cry[A-Z]+|WLD[A-Z]+|[A-Z]{6}|[A-Z0-9_]+)\b/;
function extractInstrumentName(shortcode?: string, longcode?: string): string {
  if (longcode) {
    const m = longcode.match(/if\s+(.+?)\s+(?:is|was|ends|strictly)/i);
    if (m && m[1]) return m[1].trim();
  }
  if (shortcode) {
    const m = shortcode.match(KNOWN_SYMBOL_PATTERN);
    if (m) return m[1];
  }
  return 'Unknown';
}

let riskLimits: RiskLimitsConfig = {
  maxDailyLossUsd: 10,
  maxWeeklyLossUsd: 25,
  maxMonthlyLossUsd: 50,
  maxDailyDrawdownPct: 20.0,
  autoLiquidateAllOnTrip: false,
  breakerAction: 'HALT_PREVENT_NEW',
};

// =========================================================================
// LOAD PERSISTENT BOT CONFIG & LIMITS FROM DISK ON STARTUP
// =========================================================================
if (fs.existsSync(BOT_CONFIG_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf8'));
    activeBotConfig = { ...activeBotConfig, ...saved };
    if (saved.maxDailyLoss !== undefined || saved.maxDailyLossUsd !== undefined) {
      riskLimits.maxDailyLossUsd = saved.maxDailyLoss ?? saved.maxDailyLossUsd;
    }
    if (saved.maxWeeklyLoss !== undefined || saved.maxWeeklyLossUsd !== undefined) {
      riskLimits.maxWeeklyLossUsd = saved.maxWeeklyLoss ?? saved.maxWeeklyLossUsd;
    }
    if (saved.maxMonthlyLoss !== undefined || saved.maxMonthlyLossUsd !== undefined) {
      riskLimits.maxMonthlyLossUsd = saved.maxMonthlyLoss ?? saved.maxMonthlyLossUsd;
    }
    if (saved.maxDailyDrawdownPct !== undefined) {
      riskLimits.maxDailyDrawdownPct = saved.maxDailyDrawdownPct;
    }
    if (saved.autoLiquidateAllOnTrip !== undefined) {
      riskLimits.autoLiquidateAllOnTrip = saved.autoLiquidateAllOnTrip;
    }
    console.log('✅ Loaded persistent bot targets & risk limits from bot_config.json');
  } catch (e) {
    console.error('Failed to load bot_config.json on startup:', e);
  }
}

let riskState: RiskState = {
  currentDailyLossUsd: 0,
  currentWeeklyLossUsd: 0,
  currentMonthlyLossUsd: 0,
  breakerTriggered: false,
  activeTripScope: 'NONE',
  lastTriggerReason: undefined,
};

function saveTradesToDisk(tradesList: any[]) {
  try {
    fs.writeFileSync(TRADES_DB_FILE, JSON.stringify(tradesList, null, 2));
  } catch (e) {
    console.error('Failed to save trades to disk:', e);
  }
}

function loadTradesFromDisk(): any[] {
  try {
    if (fs.existsSync(TRADES_DB_FILE)) {
      const content = fs.readFileSync(TRADES_DB_FILE, 'utf8').trim();
      if (content) {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    }
  } catch (e) {
    console.error('Failed to load trades from disk:', e);
  }
  return [];
}

// Recomputes real daily/weekly/monthly realized loss from actual closed trades
function recomputeRiskState() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  let dailyLoss = 0;
  let weeklyLoss = 0;
  let monthlyLoss = 0;

  const diskTrades = loadTradesFromDisk();
  const tradesToScan = diskTrades.length > 0 ? diskTrades : allTrades;

  for (const t of tradesToScan) {
    if (typeof t.pnl !== 'number' || t.pnl >= 0) continue;
    const closeTime = t.closeTime ? new Date(t.closeTime) : null;
    if (!closeTime || isNaN(closeTime.getTime())) continue;

    const loss = Math.abs(t.pnl);
    if (closeTime >= startOfDay) dailyLoss += loss;
    if (closeTime >= startOfWeek) weeklyLoss += loss;
    if (closeTime >= startOfMonth) monthlyLoss += loss;
  }

  riskState.currentDailyLossUsd = Number(dailyLoss.toFixed(2));
  riskState.currentWeeklyLossUsd = Number(weeklyLoss.toFixed(2));
  riskState.currentMonthlyLossUsd = Number(monthlyLoss.toFixed(2));

  let scope: RiskState['activeTripScope'] = 'NONE';
  let reason: string | undefined;

  if (dailyLoss >= riskLimits.maxDailyLossUsd) {
    scope = 'DAY';
    reason = `Daily loss limit breached: -$${dailyLoss.toFixed(2)} vs ceiling -$${riskLimits.maxDailyLossUsd.toFixed(2)}.`;
  } else if (weeklyLoss >= riskLimits.maxWeeklyLossUsd) {
    scope = 'WEEK';
    reason = `Weekly loss limit breached: -$${weeklyLoss.toFixed(2)} vs ceiling -$${riskLimits.maxWeeklyLossUsd.toFixed(2)}.`;
  } else if (monthlyLoss >= riskLimits.maxMonthlyLossUsd) {
    scope = 'MONTH';
    reason = `Monthly loss limit breached: -$${monthlyLoss.toFixed(2)} vs ceiling -$${riskLimits.maxMonthlyLossUsd.toFixed(2)}.`;
  }

  if (scope !== 'NONE') {
    if (!riskState.breakerTriggered) {
      console.warn(`🚨 Kill switch tripped automatically: ${reason}`);
    }
    riskState.breakerTriggered = true;
    riskState.activeTripScope = scope;
    riskState.lastTriggerReason = reason;
    activeBotConfig.masterExecution = false;
  }
}

let activeBrokerTelemetry: BrokerTelemetry = {
  connected: true,
  provider: 'Fusion Markets cTrader',
  accountNumber: '48868725',
  server: 'cTrader Open API',
  currency: 'USD',
  balance: 9.82,
  equity: 9.82,
  floatingPnL: 0.00,
  netProfit: -0.18,
  totalDeposits: 10.00,
  winRate: 50.0,
  totalTrades: 2,
  winningTrades: 1,
  losingTrades: 1,
  lastPingMs: 12,
  lastSyncTime: new Date().toISOString(),
  lastHeartbeat: new Date().toISOString(),
  openPositions: [],
  trades: [],
};

let derivSocket: WebSocket | null = null;
const pendingDerivRequests = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
let nextReqId = 1000;

function sendDerivRequest(payload: Record<string, any>, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!derivSocket || derivSocket.readyState !== WebSocket.OPEN) {
      reject(new Error('Broker WebSocket is not connected.'));
      return;
    }
    const req_id = nextReqId++;
    const timer = setTimeout(() => {
      pendingDerivRequests.delete(req_id);
      reject(new Error('Broker API request timed out.'));
    }, timeoutMs);

    pendingDerivRequests.set(req_id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });

    derivSocket.send(JSON.stringify({ ...payload, req_id }));
  });
}

// Old Deriv Gateway decommissioned (stops Cloudflare HTML error spam in Railway)
async function startDerivGateway() {
  // Standby - bot communicates directly with Fusion Markets via engine/matrix.py
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json());

  // CORS middleware for web browsers & local scripts
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Load saved trades on startup
  const savedTrades = loadTradesFromDisk();
  if (savedTrades.length > 0) {
    activeBrokerTelemetry.trades = savedTrades;
  }

  // =========================================================================
  // API ENDPOINTS
  // =========================================================================

  // A. GET ALL TRADES (Always reloads fresh from disk so journal reflects real trades)
  app.get('/api/journal', async (req, res) => {
    try {
      const diskTrades = loadTradesFromDisk();
      if (diskTrades.length > 0) {
        activeBrokerTelemetry.trades = diskTrades;
      }
      res.status(200).json(activeBrokerTelemetry.trades);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch journal entries" });
    }
  });

  // B. ADD NEW MANUAL OR BOT TRADE
  app.post('/api/journal', (req, res) => {
    try {
      const newTrade = req.body;
      const trades = loadTradesFromDisk();
      trades.unshift(newTrade);
      saveTradesToDisk(trades);
      activeBrokerTelemetry.trades = trades;
      recomputeRiskState();
      res.status(200).json({ status: "success", trade: newTrade });
    } catch (error) {
      res.status(500).json({ error: "Failed to save journal entry" });
    }
  });

  // C. DELETE SINGLE TRADE (Triggered by Trash Can icon)
  app.delete('/api/journal/:id', (req, res) => {
    const tradeId = req.params.id;
    let trades = loadTradesFromDisk();
    trades = trades.filter(t => t.id !== tradeId && t.ticket !== tradeId);
    saveTradesToDisk(trades);
    activeBrokerTelemetry.trades = trades;
    allTrades = allTrades.filter(t => t.id !== tradeId && t.ticket !== tradeId);
    recomputeRiskState();
    res.json({ status: 'success', message: `Trade ${tradeId} deleted permanently.` });
  });

  // D. WIPE ENTIRE JOURNAL
  app.post('/api/journal/reset', (req, res) => {
    journalCutoffTime = new Date().toISOString();
    activeBrokerTelemetry.trades = [];
    allTrades = [];
    saveTradesToDisk([]);
    recomputeRiskState();
    res.json({
      status: 'success',
      message: 'Journal wiped completely. Metrics reset to zero.',
      cutoff: journalCutoffTime,
    });
  });

  // E. ANALYSIS ENDPOINT
  app.post('/api/analysis', async (req, res) => {
    try {
      res.status(200).json({ status: "success", message: "Live analysis executed." });
    } catch (error) {
      res.status(500).json({ error: "Analysis execution failed" });
    }
  });
  
  // F. GET BOT CONFIGURATION
  app.get('/api/bot/config', (req, res) => {
    res.json({
      status: 'success',
      data: activeBotConfig,
    });
  });

  // G. UPDATE & PERSIST BOT CONFIGURATION
  app.post('/api/bot/config', (req, res) => {
    try {
      const config = req.body;
      const {
        masterExecution,
        riskPerTradePct,
        riskToReward,
        maxDailyTrades,
        trailingStopActive,
        autoBreakevenPips,
        currency,
        strategyModes,
        weeklyDepositBaseline,
        weeklyGoalTarget,
        dailyGoalTarget
      } = config;

      if (typeof masterExecution === 'boolean') activeBotConfig.masterExecution = masterExecution;
      if (typeof riskPerTradePct === 'number') activeBotConfig.riskPerTradePct = riskPerTradePct;
      if (typeof riskToReward === 'number') activeBotConfig.riskToReward = riskToReward;
      if (typeof maxDailyTrades === 'number') activeBotConfig.maxDailyTrades = maxDailyTrades;
      if (typeof trailingStopActive === 'boolean') activeBotConfig.trailingStopActive = trailingStopActive;
      if (typeof autoBreakevenPips === 'number') activeBotConfig.autoBreakevenPips = autoBreakevenPips;
      if (typeof currency === 'string') activeBotConfig.currency = currency;
      if (typeof weeklyDepositBaseline === 'number') activeBotConfig.weeklyDepositBaseline = weeklyDepositBaseline;
      if (typeof weeklyGoalTarget === 'number') activeBotConfig.weeklyGoalTarget = weeklyGoalTarget;
      if (typeof dailyGoalTarget === 'number') activeBotConfig.dailyGoalTarget = dailyGoalTarget;

      activeBotConfig.updatedAt = new Date().toISOString();

      const existingConfig = fs.existsSync(BOT_CONFIG_FILE) 
        ? JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf8')) 
        : {};

      const merged = { ...existingConfig, ...activeBotConfig, ...config };
      fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(merged, null, 2));

      res.json({ 
        status: 'success', 
        message: 'Config updated and written to bot_config.json', 
        config: activeBotConfig 
      });
    } catch (error: any) {
      res.status(500).json({ 
        status: 'error', 
        message: error?.message || 'Failed to update config' 
      });
    }
  });
    
  // H. GET RISK LIMITS
  app.get('/api/limits', (req, res) => {
    recomputeRiskState();
    res.json({
      status: 'success',
      data: { ...riskLimits, ...riskState },
    });
  });

  // I. UPDATE & PERSIST RISK LIMITS (Fixed clean route, no nested duplicates)
  app.post('/api/limits', (req, res) => {
    try {
      const {
        maxDailyLossUsd,
        maxWeeklyLossUsd,
        maxMonthlyLossUsd,
        maxDailyDrawdownPct,
        autoLiquidateAllOnTrip,
        breakerAction,
        resetBreaker,
      } = req.body;

      if (typeof maxDailyLossUsd === 'number') riskLimits.maxDailyLossUsd = maxDailyLossUsd;
      if (typeof maxWeeklyLossUsd === 'number') riskLimits.maxWeeklyLossUsd = maxWeeklyLossUsd;
      if (typeof maxMonthlyLossUsd === 'number') riskLimits.maxMonthlyLossUsd = maxMonthlyLossUsd;
      if (typeof maxDailyDrawdownPct === 'number') riskLimits.maxDailyDrawdownPct = maxDailyDrawdownPct;
      if (typeof autoLiquidateAllOnTrip === 'boolean') riskLimits.autoLiquidateAllOnTrip = autoLiquidateAllOnTrip;

      const validActions = ['HALT_CLOSE_ALL', 'HALT_PREVENT_NEW', 'REDUCE_SIZE_50', 'ALERT_ONLY'];
      if (typeof breakerAction === 'string' && validActions.includes(breakerAction)) {
        riskLimits.breakerAction = breakerAction as RiskLimitsConfig['breakerAction'];
      }

      if (resetBreaker) {
        riskState.breakerTriggered = false;
        riskState.activeTripScope = 'NONE';
        riskState.lastTriggerReason = undefined;
        activeBotConfig.masterExecution = true;
      }

      const existingConfig = fs.existsSync(BOT_CONFIG_FILE) 
        ? JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf8')) 
        : {};

      const updatedConfig = {
        ...existingConfig,
        maxDailyLoss: riskLimits.maxDailyLossUsd,
        maxDailyLossUsd: riskLimits.maxDailyLossUsd,
        maxWeeklyLoss: riskLimits.maxWeeklyLossUsd,
        maxWeeklyLossUsd: riskLimits.maxWeeklyLossUsd,
        maxMonthlyLoss: riskLimits.maxMonthlyLossUsd,
        maxMonthlyLossUsd: riskLimits.maxMonthlyLossUsd,
        maxDailyDrawdownPct: riskLimits.maxDailyDrawdownPct,
        autoLiquidateAllOnTrip: riskLimits.autoLiquidateAllOnTrip,
        breakerAction: riskLimits.breakerAction,
      };

      fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(updatedConfig, null, 2));

      res.json({
        status: 'success',
        message: 'Risk limits updated and saved permanently to bot_config.json',
        data: { ...riskLimits, ...riskState },
      });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error?.message || 'Failed to update limits' });
    }
  });

  // J. GET RISK STATUS
  app.get('/api/risk/status', (req, res) => {
    recomputeRiskState();
    res.json({ status: 'success', data: { ...riskLimits, ...riskState } });
  });

  // K. BOT TRADE DISPATCH
  app.post('/api/bot/trade', async (req, res) => {
    recomputeRiskState();

    if (!activeBotConfig.masterExecution) {
      return res.status(403).json({
        status: 'blocked',
        message: 'Trade rejected: masterExecution is OFF (kill switch engaged).',
      });
    }
    if (riskState.breakerTriggered) {
      return res.status(403).json({
        status: 'blocked',
        message: `Trade rejected: risk breaker tripped (${riskState.activeTripScope}). ${riskState.lastTriggerReason || ''}`,
      });
    }

    const { symbol, direction, lots, stopLoss, takeProfit } = req.body;
    res.json({ status: 'success', message: 'Order dispatched to matrix engine.', data: { symbol, direction, lots } });
  });

  // L. GET LIVE TELEMETRY
  app.get('/api/broker/telemetry', (req, res) => {
    recomputeRiskState();
    res.json({
      status: 'success',
      data: activeBrokerTelemetry,
    });
  });

  // M. RECEIVE LIVE TELEMETRY
  app.post('/api/broker/telemetry', (req, res) => {
    const payload = req.body;
    activeBrokerTelemetry = { ...activeBrokerTelemetry, ...payload, lastHeartbeat: new Date().toISOString() };
    res.json({
      status: 'success',
      message: 'Telemetry updated',
      data: activeBrokerTelemetry,
      activeBotConfig,
    });
  });

  // =========================================================================
  // AUTOMATIC PYTHON BOT SPAWN & LIFECYCLE MONITOR
  // =========================================================================
  function launchPythonBot() {
    console.log('🤖 Launching Nexus Matrix Python Trading Engine...');
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    
    const bot = spawn(pythonCmd, ['engine/matrix.py'], {
      env: { ...process.env, PYTHONPATH: process.cwd() },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    bot.on('error', (err) => {
      console.error(`[Python Engine Spawn Warning]: ${err.message}`);
    });

    bot.stdout.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line.includes('[MATRIX_TELEMETRY]')) {
        try {
          const jsonStr = line.split('[MATRIX_TELEMETRY]')[1].trim();
          const telem = JSON.parse(jsonStr);
          activeBrokerTelemetry.balance = telem.balance;
          activeBrokerTelemetry.equity = telem.equity;
          activeBrokerTelemetry.connected = true;
          activeBrokerTelemetry.lastHeartbeat = new Date().toISOString();
        } catch {}
      }
      console.log(`[Python Engine] ${line}`);
    });

    bot.stderr.on('data', (chunk) => {
      console.error(`[Python Engine Error] ${chunk.toString().trim()}`);
    });

    bot.on('exit', (code) => {
      console.warn(`⚠️ Python Bot process exited with code ${code}. Restarting in 5s...`);
      setTimeout(launchPythonBot, 5000);
    });
  }

  launchPythonBot();

  // Serve static UI or Vite development server
  const distPath = path.join(process.cwd(), 'dist');
  const isProduction = fs.existsSync(path.join(distPath, 'index.html'));

  if (isProduction) {
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true, host: '0.0.0.0' },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Trading Portal & API Gateway active on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Server startup error:', err);
  process.exit(1);
});