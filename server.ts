import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';

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
}

interface BrokerTelemetry {
  connected: boolean;
  provider: string;
  accountNumber: string;
  server: string;
  currency: string;
  balance: number;
  equity: number;
  floatingPnL: number;
  netProfit: number;
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

// Default state
let activeBotConfig: BotGatewayConfig = {
  masterExecution: true,
  riskPerTradePct: 1.25,
  riskToReward: 2.5,
  maxDailyTrades: 4,
  trailingStopActive: true,
  autoBreakevenPips: 15,
  currency: 'USD',
  updatedAt: new Date().toISOString(),
  version: 1,
};

let activeBrokerTelemetry: BrokerTelemetry = {
  connected: false,
  provider: 'Deriv API',
  accountNumber: 'Awaiting Connection',
  server: 'Deriv Gateway',
  currency: 'USD',
  balance: 0.00,
  equity: 0.00,
  floatingPnL: 0.00,
  netProfit: 0.00,
  winRate: 0.0,
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
  lastPingMs: 0,
  lastSyncTime: new Date().toISOString(),
  lastHeartbeat: new Date().toISOString(),
  openPositions: [],
};

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

  // 1. Health check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'Trading Portal Gateway',
      time: new Date().toISOString(),
      botVersion: activeBotConfig.version,
    });
  });

  // 2. Get Bot Configuration
  app.get('/api/bot/config', (req, res) => {
    res.json({
      status: 'success',
      data: activeBotConfig,
    });
  });

  // 3. Update Bot Configuration
  app.post('/api/bot/config', (req, res) => {
    const {
      masterExecution,
      riskPerTradePct,
      riskToReward,
      maxDailyTrades,
      trailingStopActive,
      autoBreakevenPips,
      currency,
    } = req.body;

    if (typeof masterExecution === 'boolean') activeBotConfig.masterExecution = masterExecution;
    if (typeof riskPerTradePct === 'number') activeBotConfig.riskPerTradePct = riskPerTradePct;
    if (typeof riskToReward === 'number') activeBotConfig.riskToReward = riskToReward;
    if (typeof maxDailyTrades === 'number') activeBotConfig.maxDailyTrades = maxDailyTrades;
    if (typeof trailingStopActive === 'boolean') activeBotConfig.trailingStopActive = trailingStopActive;
    if (typeof autoBreakevenPips === 'number') activeBotConfig.autoBreakevenPips = autoBreakevenPips;
    if (typeof currency === 'string') activeBotConfig.currency = currency;

    activeBotConfig.updatedAt = new Date().toISOString();
    activeBotConfig.version += 1;

    res.json({
      status: 'success',
      message: 'Bot parameters updated',
      data: activeBotConfig,
    });
  });

  // 4. Get Live Telemetry
  app.get('/api/broker/telemetry', (req, res) => {
    res.json({
      status: 'success',
      data: activeBrokerTelemetry,
    });
  });

  // 5. Receive Live Telemetry (Pushed from Browser or Local Bot Script)
  app.post('/api/broker/telemetry', (req, res) => {
    const {
      provider,
      accountNumber,
      server,
      currency,
      balance,
      equity,
      floatingPnL,
      netProfit,
      winRate,
      totalTrades,
      winningTrades,
      losingTrades,
      lastPingMs,
      openPositions,
      connected,
    } = req.body;

    if (provider !== undefined) activeBrokerTelemetry.provider = provider;
    if (accountNumber !== undefined) activeBrokerTelemetry.accountNumber = accountNumber;
    if (server !== undefined) activeBrokerTelemetry.server = server;
    if (currency !== undefined) {
      activeBrokerTelemetry.currency = currency.toUpperCase();
      activeBotConfig.currency = currency.toUpperCase();
    }
    if (typeof balance === 'number') activeBrokerTelemetry.balance = balance;
    if (typeof equity === 'number') activeBrokerTelemetry.equity = equity;
    if (typeof floatingPnL === 'number') activeBrokerTelemetry.floatingPnL = floatingPnL;
    if (typeof netProfit === 'number') activeBrokerTelemetry.netProfit = netProfit;
    if (typeof winRate === 'number') activeBrokerTelemetry.winRate = winRate;
    if (typeof totalTrades === 'number') activeBrokerTelemetry.totalTrades = totalTrades;
    if (typeof winningTrades === 'number') activeBrokerTelemetry.winningTrades = winningTrades;
    if (typeof losingTrades === 'number') activeBrokerTelemetry.losingTrades = losingTrades;
    if (typeof lastPingMs === 'number') activeBrokerTelemetry.lastPingMs = lastPingMs;
    if (Array.isArray(openPositions)) activeBrokerTelemetry.openPositions = openPositions;
    if (typeof connected === 'boolean') activeBrokerTelemetry.connected = connected;

    activeBrokerTelemetry.lastSyncTime = new Date().toISOString();
    activeBrokerTelemetry.lastHeartbeat = new Date().toISOString();

    res.json({
      status: 'success',
      message: 'Telemetry updated',
      data: activeBrokerTelemetry,
      activeBotConfig,
    });
  });

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