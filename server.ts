import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { spawn } from 'child_process';

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
  strategyModes?: Record<string, string>;
  weeklyDepositBaseline?: number;
  weeklyGoalTarget?: number;
  dailyGoalTarget?: number;
}

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
    id: string;
    ticket: string;
    symbol: string;
    strategy: string;
    direction: 'BUY' | 'SELL';
    lots: number;
    entry: number;
    currentPrice: number;
    sl?: number;
    tp?: number;
    floatingPnL: number;
    isRiskFree: boolean;
  }>;
}

const BOT_CONFIG_FILE = path.join(process.cwd(), 'bot_config.json');
const TRADES_DB_FILE = path.join(process.cwd(), 'trades_db.json');
const CANDLES_CACHE_FILE = path.join(process.cwd(), 'candles_cache.json');
const CLOSE_COMMAND_FILE = path.join(process.cwd(), 'close_command.json');

const SEED_TRADES = [
  {
    id: "deal-26686729",
    ticket: "#26686729",
    asset: "EURUSD",
    strategy: "STRATEGY_513",
    type: "BUY",
    lots: 0.02,
    openPrice: 1.11420,
    closePrice: 1.11660,
    pnl: 2.88,
    openTime: "2026-09-29 15:23:10",
    closeTime: "2026-09-29 16:02:45",
    status: "WIN",
    source: "Fusion cTrader"
  },
  {
    id: "deal-26685480",
    ticket: "#26685480",
    asset: "EURUSD",
    strategy: "STRATEGY_513",
    type: "BUY",
    lots: 0.02,
    openPrice: 1.11420,
    closePrice: 1.11660,
    pnl: 1.92,
    openTime: "2026-09-29 15:05:40",
    closeTime: "2026-09-29 16:01:30",
    status: "WIN",
    source: "Fusion cTrader"
  },
  {
    id: "deal-26668860",
    ticket: "#26668860",
    asset: "GBPUSD",
    strategy: "EMA_9_25_CROSS",
    type: "BUY",
    lots: 0.02,
    openPrice: 1.33520,
    closePrice: 1.33700,
    pnl: 0.36,
    openTime: "2026-09-29 10:51:15",
    closeTime: "2026-09-29 12:50:32",
    status: "WIN",
    source: "Fusion cTrader"
  },
  {
    id: "deal-26667829",
    ticket: "#26667829",
    asset: "AUDUSD",
    strategy: "MANUAL_TRADE",
    type: "SELL",
    lots: 0.01,
    openPrice: 0.68940,
    closePrice: 0.68994,
    pnl: -0.54,
    openTime: "2026-09-29 10:29:00",
    closeTime: "2026-09-29 12:47:10",
    status: "LOSS",
    source: "Fusion cTrader"
  }
];

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
  strategyModes: {
    "EMA_9_25_CROSS": "LIVE",
    "GRUBBER_KICK": "LIVE",
    "STRATEGY_513": "LIVE",
    "ORB_LIQUIDITY_SWEEP": "LIVE",
    "AVWAP_200EMA_CONTINUATION": "LIVE",
    "PDH_PDL_FAILED_BREAKOUT": "LIVE",
    "ORB_CRACKER": "DRY_RUN",
    "OES_4H_ORDER_BLOCK": "LIVE"
  },
  weeklyDepositBaseline: 10,
  weeklyGoalTarget: 20,
  dailyGoalTarget: 5
};

let riskLimits: RiskLimitsConfig = {
  maxDailyLossUsd: 10,
  maxWeeklyLossUsd: 25,
  maxMonthlyLossUsd: 50,
  maxDailyDrawdownPct: 20.0,
  autoLiquidateAllOnTrip: false,
  breakerAction: 'HALT_PREVENT_NEW',
};

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
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    }
  } catch (e) {
    console.error('Failed to load trades from disk:', e);
  }

  saveTradesToDisk(SEED_TRADES);
  return SEED_TRADES;
}

function recomputeRiskState() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  let dailyLoss = 0;
  let weeklyLoss = 0;
  let monthlyLoss = 0;

  const currentTrades = loadTradesFromDisk();

  for (const t of currentTrades) {
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
  balance: 14.62,
  equity: 14.62,
  floatingPnL: 0.00,
  netProfit: 4.62,
  totalDeposits: 10.00,
  winRate: 75.0,
  totalTrades: 4,
  winningTrades: 3,
  losingTrades: 1,
  lastPingMs: 12,
  lastSyncTime: new Date().toISOString(),
  lastHeartbeat: new Date().toISOString(),
  openPositions: [],
  trades: SEED_TRADES,
};

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json());

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // 1. CANDLE FEED ENDPOINT
  app.get('/api/market/candles', (req, res) => {
    try {
      const symbol = String(req.query.symbol || 'US30').toUpperCase();
      if (fs.existsSync(CANDLES_CACHE_FILE)) {
        const cache = JSON.parse(fs.readFileSync(CANDLES_CACHE_FILE, 'utf8'));
        if (cache && cache[symbol]) {
          return res.status(200).json({ status: 'success', symbol, data: cache[symbol] });
        }
      }
      return res.status(200).json({ status: 'success', symbol, data: [] });
    } catch (err: any) {
      return res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  // 2. CLOSE POSITION ON DEMAND
  app.post('/api/positions/close/:id', (req, res) => {
    try {
      const positionId = req.params.id;
      fs.writeFileSync(CLOSE_COMMAND_FILE, JSON.stringify({ positionId, requestedAt: new Date().toISOString() }));
      res.status(200).json({ status: 'success', message: `Close command queued for position #${positionId}` });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  // 3. TRADE JOURNAL APIS
  app.get('/api/journal', async (req, res) => {
    try {
      const diskTrades = loadTradesFromDisk();
      activeBrokerTelemetry.trades = diskTrades;
      res.status(200).json(diskTrades);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch journal entries" });
    }
  });

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

  app.delete('/api/journal/:id', (req, res) => {
    const tradeId = req.params.id;
    let trades = loadTradesFromDisk();
    trades = trades.filter(t => t.id !== tradeId && t.ticket !== tradeId);
    saveTradesToDisk(trades);
    activeBrokerTelemetry.trades = trades;
    recomputeRiskState();
    res.json({ status: 'success', message: `Trade ${tradeId} deleted.` });
  });

  app.post('/api/journal/reset', (req, res) => {
    saveTradesToDisk([]);
    activeBrokerTelemetry.trades = [];
    recomputeRiskState();
    res.json({ status: 'success', message: 'Journal reset.' });
  });

  // 4. BOT CONFIG APIS
  app.get('/api/bot/config', (req, res) => {
    res.json({ status: 'success', data: activeBotConfig });
  });

  app.post('/api/bot/config', (req, res) => {
    try {
      const config = req.body;
      activeBotConfig = { ...activeBotConfig, ...config, updatedAt: new Date().toISOString() };
      const existingConfig = fs.existsSync(BOT_CONFIG_FILE) ? JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf8')) : {};
      fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify({ ...existingConfig, ...activeBotConfig }, null, 2));
      res.json({ status: 'success', config: activeBotConfig });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error?.message });
    }
  });

  // 5. RISK LIMITS APIS
  app.get('/api/limits', (req, res) => {
    recomputeRiskState();
    res.json({ status: 'success', data: { ...riskLimits, ...riskState } });
  });

  app.post('/api/limits', (req, res) => {
    try {
      const { maxDailyLossUsd, maxWeeklyLossUsd, maxMonthlyLossUsd, maxDailyDrawdownPct, autoLiquidateAllOnTrip, breakerAction, resetBreaker } = req.body;

      if (typeof maxDailyLossUsd === 'number') riskLimits.maxDailyLossUsd = maxDailyLossUsd;
      if (typeof maxWeeklyLossUsd === 'number') riskLimits.maxWeeklyLossUsd = maxWeeklyLossUsd;
      if (typeof maxMonthlyLossUsd === 'number') riskLimits.maxMonthlyLossUsd = maxMonthlyLossUsd;
      if (typeof maxDailyDrawdownPct === 'number') riskLimits.maxDailyDrawdownPct = maxDailyDrawdownPct;
      if (typeof autoLiquidateAllOnTrip === 'boolean') riskLimits.autoLiquidateAllOnTrip = autoLiquidateAllOnTrip;
      if (breakerAction) riskLimits.breakerAction = breakerAction;

      if (resetBreaker) {
        riskState.breakerTriggered = false;
        riskState.activeTripScope = 'NONE';
        riskState.lastTriggerReason = undefined;
        activeBotConfig.masterExecution = true;
      }

      const existingConfig = fs.existsSync(BOT_CONFIG_FILE) ? JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf8')) : {};
      fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify({ ...existingConfig, ...riskLimits }, null, 2));

      res.json({ status: 'success', data: { ...riskLimits, ...riskState } });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error?.message });
    }
  });

  // 6. TELEMETRY APIS
  app.get('/api/broker/telemetry', (req, res) => {
    recomputeRiskState();
    res.json({ status: 'success', data: activeBrokerTelemetry });
  });

  app.post('/api/broker/telemetry', (req, res) => {
    const payload = req.body;
    activeBrokerTelemetry = { ...activeBrokerTelemetry, ...payload, lastHeartbeat: new Date().toISOString() };
    res.json({ status: 'success', data: activeBrokerTelemetry, activeBotConfig });
  });

  // 7. LAUNCH PYTHON BOT ENGINE
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
          if (telem.netProfit !== undefined) activeBrokerTelemetry.netProfit = telem.netProfit;
          if (telem.winRate !== undefined) activeBrokerTelemetry.winRate = telem.winRate;
          if (telem.totalTrades !== undefined) activeBrokerTelemetry.totalTrades = telem.totalTrades;
          if (telem.winningTrades !== undefined) activeBrokerTelemetry.winningTrades = telem.winningTrades;
          if (telem.losingTrades !== undefined) activeBrokerTelemetry.losingTrades = telem.losingTrades;
          if (Array.isArray(telem.openPositions)) {
            activeBrokerTelemetry.openPositions = telem.openPositions;
          }
          activeBrokerTelemetry.connected = true;
          activeBrokerTelemetry.lastHeartbeat = new Date().toISOString();
        } catch (e) {
          // Ignore parsing noise
        }
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