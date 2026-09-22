import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import WebSocket from 'ws';

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

async function startDerivGateway() {
  const DERIV_APP_ID = process.env.DERIV_APP_ID;
  const DERIV_API_TOKEN = process.env.DERIV_API_TOKEN;
  const API_BASE = 'https://api.derivws.com';

  if (!DERIV_APP_ID || !DERIV_API_TOKEN) {
    console.warn('⚠️ DERIV_APP_ID or DERIV_API_TOKEN not set — telemetry stays at placeholder values.');
    return;
  }

  let ws: WebSocket | null = null;
  let reconnectAttempts = 0;

  async function getAuthenticatedWsUrl(): Promise<string> {
    // Step 1: Get the account ID for the demo account
    const accountsRes = await fetch(`${API_BASE}/trading/v1/options/accounts`, {
      headers: {
        'Authorization': `Bearer ${DERIV_API_TOKEN}`,
        'Deriv-App-ID': DERIV_APP_ID,
      },
    });
    if (!accountsRes.ok) {
      throw new Error(`Failed to fetch accounts: ${accountsRes.status} ${await accountsRes.text()}`);
    }
    const accountsData = await accountsRes.json();
    const accounts = accountsData.data || [];
    const demoAccount = accounts.find((a: any) => a.account_type === 'demo') || accounts[0];

    if (!demoAccount) {
      throw new Error('No Deriv accounts found for this token.');
    }

    const accountId = demoAccount.account_id || demoAccount.loginid || demoAccount.id;
    activeBrokerTelemetry.accountNumber = accountId;
    activeBrokerTelemetry.currency = demoAccount.currency || activeBrokerTelemetry.currency;
    activeBotConfig.currency = demoAccount.currency || activeBotConfig.currency;

    // Step 2: Get a one-time authenticated WebSocket URL for that account
    const otpRes = await fetch(`${API_BASE}/trading/v1/options/accounts/${accountId}/otp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DERIV_API_TOKEN}`,
        'Deriv-App-ID': DERIV_APP_ID,
      },
    });
    if (!otpRes.ok) {
      throw new Error(`Failed to fetch OTP: ${otpRes.status} ${await otpRes.text()}`);
    }
    const otpData = await otpRes.json();
    return otpData.data.url;
  }

  async function connect() {
    try {
      const wsUrl = await getAuthenticatedWsUrl();
      ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        console.log('✅ Connected to Deriv API (new options endpoint)');
        reconnectAttempts = 0;
        activeBrokerTelemetry.connected = true;

        ws!.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 1 }));
        ws!.send(JSON.stringify({ portfolio: 1, req_id: 2 }));
        ws!.send(JSON.stringify({ statement: 1, limit: 100, req_id: 3 }));
      });

      ws.on('message', (raw) => {
        const data = JSON.parse(raw.toString());

        if (data.error) {
          console.error('Deriv API error:', data.error.message);
          return;
        }

        if (data.msg_type === 'balance') {
          activeBrokerTelemetry.balance = data.balance.balance;
          activeBrokerTelemetry.currency = data.balance.currency || activeBrokerTelemetry.currency;
          activeBrokerTelemetry.lastSyncTime = new Date().toISOString();
          activeBrokerTelemetry.lastHeartbeat = new Date().toISOString();
        }

        if (data.msg_type === 'portfolio') {
          const contracts = data.portfolio?.contracts || [];
          activeBrokerTelemetry.openPositions = contracts.map((c: any) => ({
            ticket: String(c.contract_id),
            symbol: c.symbol,
            type: c.contract_type?.includes('PUT') || c.contract_type?.includes('DOWN') ? 'SELL' : 'BUY',
            lots: c.payout || 0,
            openPrice: c.buy_price,
            currentPrice: c.buy_price,
            pnl: 0,
          }));
        }

        if (data.msg_type === 'statement') {
          const txs = data.statement?.transactions || [];
          const closed = txs.filter((t: any) => t.action_type === 'sell');
          const wins = closed.filter((t: any) => t.amount > 0).length;
          activeBrokerTelemetry.totalTrades = closed.length;
          activeBrokerTelemetry.winningTrades = wins;
          activeBrokerTelemetry.losingTrades = closed.length - wins;
          activeBrokerTelemetry.winRate = closed.length ? Number(((wins / closed.length) * 100).toFixed(1)) : 0;
          activeBrokerTelemetry.netProfit = closed.reduce((sum: number, t: any) => sum + t.amount, 0);
        }
      });

      ws.on('close', () => {
        activeBrokerTelemetry.connected = false;
        const timeout = Math.min(1000 * 2 ** reconnectAttempts, 30000);
        reconnectAttempts++;
        console.log(`Deriv WebSocket closed — reconnecting in ${timeout / 1000}s`);
        setTimeout(connect, timeout);
      });

      ws.on('error', (err) => {
        console.error('Deriv WebSocket error:', err.message);
      });
    } catch (err: any) {
      console.error('Deriv Gateway setup failed:', err.message);
      const timeout = Math.min(1000 * 2 ** reconnectAttempts, 30000);
      reconnectAttempts++;
      setTimeout(connect, timeout);
    }
  }

  connect();
}

async function startServer() {
  const app = express();
   startDerivGateway();
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