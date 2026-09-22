import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import WebSocket from 'ws';

// In-memory shared state between web dashboard, trading bot (VS Code), and broker
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

// Current live state
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
  accountNumber: 'Connecting...',
  server: 'Deriv WebSocket',
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

let pingInterval: NodeJS.Timeout | null = null;

// Connects server directly to Deriv API using Railway Environment Variables
function initDerivConnection() {
  const appId = process.env.DERIV_APP_ID || '1089';
  const token = process.env.DERIV_API_TOKEN;

  if (!token) {
    console.log('⚠️ No DERIV_API_TOKEN provided. Telemetry running in mock mode.');
    return;
  }

  console.log('🔌 Connecting to Deriv WebSocket gateway...');

  // Browser headers bypass Cloudflare 520 blocks when connecting from cloud hosts
  const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${appId}`, {
    headers: {
      'Origin': 'https://app.deriv.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });

  ws.on('open', () => {
    console.log('🔑 Authenticating with Deriv API Token...');
    ws.send(JSON.stringify({ authorize: token }));

    // Send a ping every 30 seconds to keep the Cloudflare connection alive
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 30000);
  });

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const res = JSON.parse(data.toString());

      // 1. Successful Authorization
      if (res.msg_type === 'authorize' && res.authorize) {
        console.log(`✅ Authorized Deriv Account: ${res.authorize.loginid}`);
        activeBrokerTelemetry = {
          ...activeBrokerTelemetry,
          connected: true,
          accountNumber: res.authorize.loginid,
          currency: res.authorize.currency || 'USD',
          balance: res.authorize.balance || activeBrokerTelemetry.balance,
          equity: res.authorize.balance || activeBrokerTelemetry.equity,
          lastSyncTime: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
        };
        // Subscribe to live balance updates
        ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      }

      // 2. Real-time Balance/Equity Update
      if (res.msg_type === 'balance' && res.balance) {
        activeBrokerTelemetry = {
          ...activeBrokerTelemetry,
          connected: true,
          balance: res.balance.balance,
          equity: res.balance.balance,
          currency: res.balance.currency,
          accountNumber: res.balance.loginid || activeBrokerTelemetry.accountNumber,
          lastSyncTime: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
        };
        console.log(`💰 Live Deriv Telemetry Updated: ${res.balance.currency} ${res.balance.balance}`);
      }
    } catch (err) {
      console.error('Error parsing Deriv response:', err);
    }
  });

  ws.on('error', (err) => console.error('Deriv WS Error:', err.message));

  ws.on('close', () => {
    if (pingInterval) clearInterval(pingInterval);
    console.log('Deriv WS disconnected. Reconnecting in 5s...');
    activeBrokerTelemetry.connected = false;
    setTimeout(initDerivConnection, 5000);
  });
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json());

  // CORS middleware for external bots / VS Code scripts
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Start live Deriv connection
  initDerivConnection();

  // 1. Health check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'Trading Portal Bot & Broker Gateway',
      time: new Date().toISOString(),
      botVersion: activeBotConfig.version,
    });
  });

  // 2. Bot Target Controls: GET (used by VS Code Python Bot, MT5 EA, or Web Portal)
  app.get('/api/bot/config', (req, res) => {
    res.json({
      status: 'success',
      data: activeBotConfig,
    });
  });

  // 3. Bot Target Controls: POST (updates active parameters from Web Dashboard or external bot)
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

    console.log(`[BOT GATEWAY] Updated config v${activeBotConfig.version}: Risk ${activeBotConfig.riskPerTradePct}%, R:R 1:${activeBotConfig.riskToReward}, MaxTrades ${activeBotConfig.maxDailyTrades}, Master: ${activeBotConfig.masterExecution}`);

    res.json({
      status: 'success',
      message: 'Bot parameters updated and active on gateway',
      data: activeBotConfig,
    });
  });

  // 4. Broker Telemetry: GET (returns real account values for the portal)
  app.get('/api/broker/telemetry', (req, res) => {
    res.json({
      status: 'success',
      data: activeBrokerTelemetry,
    });
  });

  // 5. Broker Telemetry: POST (endpoint where VS Code bot or MT5 EA pushes real live broker values)
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

    console.log(`[BROKER TELEMETRY] Received live push: Equity ${activeBrokerTelemetry.equity} ${activeBrokerTelemetry.currency}, Balance ${activeBrokerTelemetry.balance}, NetProfit ${activeBrokerTelemetry.netProfit}`);

    res.json({
      status: 'success',
      message: 'Broker telemetry synced successfully',
      data: activeBrokerTelemetry,
      activeBotConfig,
    });
  });

  // 6. Connect / Disconnect simulation or manual trigger
  app.post('/api/broker/connect', (req, res) => {
    activeBrokerTelemetry.connected = true;
    activeBrokerTelemetry.lastHeartbeat = new Date().toISOString();
    res.json({ status: 'success', message: 'Broker connected', data: activeBrokerTelemetry });
  });

  app.post('/api/broker/disconnect', (req, res) => {
    activeBrokerTelemetry.connected = false;
    res.json({ status: 'success', message: 'Broker disconnected', data: activeBrokerTelemetry });
  });

  // Vite middleware for development or static serve in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, host: '0.0.0.0' },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Trading Portal & Bot Gateway running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});