import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { spawn } from 'child_process';

interface BotGatewayConfig {
  masterExecution: boolean;
  riskPerTradePct: number;
  minRr: number;
  adaptiveMode: boolean;
  stopOnDailyGoalReached: boolean;
  dailyGoalTarget: number;
  weeklyGoalTarget: number;
  monthlyGoalTarget: number;
  weeklyDepositBaseline: number;
  maxDailyTrades: number;
  trailingStopActive: boolean;
  autoBreakevenPips: number;
  currency: string;
  updatedAt: string;
  version: number;
  strategyModes?: Record<string, string>;
  limitsConfirmedAt?: string;
}

interface RiskLimitsConfig {
  maxDailyLossUsd: number;
  maxWeeklyLossUsd: number;
  maxMonthlyLossUsd: number;
  maxDailyDrawdownPct?: number;
  autoLiquidateAllOnTrip?: boolean;
  breakerAction: 'HALT_PREVENT_NEW';
}

interface RiskState {
  currentDailyLossUsd: number;
  currentWeeklyLossUsd: number;
  currentMonthlyLossUsd: number;
  breakerTriggered: boolean;
  activeTripScope: 'NONE' | 'DAY' | 'WEEK' | 'MONTH' | 'CURRENCY';
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
const RISK_STATE_FILE = process.env.RISK_STATE_FILE || path.join(process.cwd(), 'risk_state.json');
const BACKTEST_OUTPUT_DIR = path.join(process.cwd(), 'backtest', 'output');
let backtestRunning = false;
let backtestProgress = '';


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
  riskPerTradePct: 1.0,
  minRr: 1.0,
  adaptiveMode: false,
  stopOnDailyGoalReached: false,
  dailyGoalTarget: 5.0,
  weeklyGoalTarget: 20.0,
  monthlyGoalTarget: 50.0,
  weeklyDepositBaseline: 10.0,
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
  }
};

let riskLimits: RiskLimitsConfig = {
  maxDailyLossUsd: 0.0,
  maxWeeklyLossUsd: 0.0,
  maxMonthlyLossUsd: 0.0,
  maxDailyDrawdownPct: 5.0,
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
  // Display-only relay: Reads authoritative breaker state written exclusively by Python engine
  try {
    if (fs.existsSync(RISK_STATE_FILE)) {
      const st = JSON.parse(fs.readFileSync(RISK_STATE_FILE, 'utf8'));
      riskState.currentDailyLossUsd = st.current_daily_loss || 0;
      riskState.currentWeeklyLossUsd = st.current_weekly_loss || 0;
      riskState.currentMonthlyLossUsd = st.current_monthly_loss || 0;
      riskState.breakerTriggered = Boolean(st.breaker_triggered);
      riskState.activeTripScope = st.active_trip_scope || 'NONE';
      riskState.lastTriggerReason = st.last_trigger_reason;
    }
  } catch (e) {
    // Retain cached state on file lock
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

  // READ-ONLY BACKTEST REPORT APIS
  app.get('/api/backtest/reports', (_req, res) => {
    try {
      if (!fs.existsSync(BACKTEST_OUTPUT_DIR)) {
        return res.status(200).json({ status: 'success', reports: [] });
      }
      const files = fs.readdirSync(BACKTEST_OUTPUT_DIR)
        .filter(f => f.endsWith('.json') && !f.startsWith('.'));
      res.status(200).json({ status: 'success', reports: files });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  app.get('/api/backtest/report/:filename', (req, res) => {
    try {
      const safeFilename = path.basename(req.params.filename);
      if (!safeFilename.endsWith('.json')) {
        return res.status(400).json({ status: 'error', message: 'Invalid file format' });
      }
      const targetPath = path.resolve(BACKTEST_OUTPUT_DIR, safeFilename);
      if (!targetPath.startsWith(path.resolve(BACKTEST_OUTPUT_DIR)) || !fs.existsSync(targetPath)) {
        return res.status(404).json({ status: 'error', message: 'Report not found' });
      }
      const data = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
      res.status(200).json({ status: 'success', data });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  app.get('/api/backtest/status', (_req, res) => {
    res.status(200).json({ status: 'success', isRunning: backtestRunning, progress: backtestProgress });
  });

  app.post('/api/backtest/run', (req, res) => {
    if (backtestRunning) {
      return res.status(409).json({ status: 'error', message: 'A backtest is already running.' });
    }

    const symbol = String(req.body?.symbol || 'US30').toUpperCase();
    const days = parseInt(req.body?.days || '60', 10);
    const adaptive = req.body?.adaptive !== false;

    backtestRunning = true;
    backtestProgress = `Starting simulation for ${symbol}...`;

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const runnerArgs = ['backtest/runner.py', '--symbol', symbol, '--days', String(days)];
    if (adaptive) runnerArgs.push('--adaptive');

    const runnerProc = spawn(pythonCmd, runnerArgs, {
      env: { ...process.env, PYTHONPATH: process.cwd() }
    });

    runnerProc.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        const lines = text.split('\n');
        backtestProgress = lines[lines.length - 1];
        console.log(`[Backtest Runner]: ${lines[lines.length - 1]}`);
      }
    });

    runnerProc.stderr.on('data', (data) => {
      console.error(`[Backtest Error]: ${data.toString().trim()}`);
    });

    runnerProc.on('exit', (code) => {
      backtestRunning = false;
      backtestProgress = code === 0 ? 'Completed successfully' : `Exited with code ${code}`;
      console.log(`[Backtest Finished]: ${backtestProgress}`);
    });

    res.status(200).json({ status: 'success', message: `Backtest initiated for ${symbol}` });
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
      activeBotConfig = { 
        ...activeBotConfig, 
        ...config,
        adaptiveMode: config.adaptiveMode !== undefined ? Boolean(config.adaptiveMode) : activeBotConfig.adaptiveMode,
        minRr: config.minRr !== undefined ? Number(config.minRr) : activeBotConfig.minRr,
        stopOnDailyGoalReached: config.stopOnDailyGoalReached !== undefined 
          ? Boolean(config.stopOnDailyGoalReached) 
          : (config.stop_on_daily_goal_reached !== undefined ? Boolean(config.stop_on_daily_goal_reached) : activeBotConfig.stopOnDailyGoalReached),
        dailyGoalTarget: config.dailyGoalTarget !== undefined ? Number(config.dailyGoalTarget) : activeBotConfig.dailyGoalTarget,
        weeklyGoalTarget: config.weeklyGoalTarget !== undefined ? Number(config.weeklyGoalTarget) : activeBotConfig.weeklyGoalTarget,
        monthlyGoalTarget: config.monthlyGoalTarget !== undefined ? Number(config.monthlyGoalTarget) : activeBotConfig.monthlyGoalTarget,
        updatedAt: new Date().toISOString() 
      };

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
      const { maxDailyLossUsd, maxWeeklyLossUsd, maxMonthlyLossUsd, maxDailyDrawdownPct, autoLiquidateAllOnTrip, resetBreaker } = req.body;

      if (typeof maxDailyLossUsd === 'number') riskLimits.maxDailyLossUsd = maxDailyLossUsd;
      if (typeof maxWeeklyLossUsd === 'number') riskLimits.maxWeeklyLossUsd = maxWeeklyLossUsd;
      if (typeof maxMonthlyLossUsd === 'number') riskLimits.maxMonthlyLossUsd = maxMonthlyLossUsd;
      if (typeof maxDailyDrawdownPct === 'number') riskLimits.maxDailyDrawdownPct = maxDailyDrawdownPct;
      if (typeof autoLiquidateAllOnTrip === 'boolean') riskLimits.autoLiquidateAllOnTrip = autoLiquidateAllOnTrip;

      const existingConfig = fs.existsSync(BOT_CONFIG_FILE) ? JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf8')) : {};
      const confirmedPayload = { 
        ...existingConfig, 
        ...riskLimits, 
        limitsConfirmedAt: new Date().toISOString() // Clears CURRENCY breaker in Python engine
      };

      if (resetBreaker) {
        riskState.breakerTriggered = false;
        riskState.activeTripScope = 'NONE';
        riskState.lastTriggerReason = undefined;
        activeBotConfig.masterExecution = true;
      }

      fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(confirmedPayload, null, 2));
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
          if (telem.currency) activeBrokerTelemetry.currency = telem.currency;
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