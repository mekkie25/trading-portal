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

// Server-side risk limit configuration. This is the SOURCE OF TRUTH for the
// kill switch. The frontend AdvancedLimits UI reads/writes this via
// /api/limits, but the numbers that actually block trades are computed here,
// on the server, from real closed trades — never trusted from the browser.
interface RiskLimitsConfig {
  maxDailyLossUsd: number;
  maxWeeklyLossUsd: number;
  maxMonthlyLossUsd: number;
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

// Every trade Deriv has ever reported for this account, unfiltered. Risk
// calculations (recomputeRiskState) always read from THIS list, never from
// the journal-filtered one below — hiding old trades from the UI must never
// let real historical losses "disappear" from the kill switch's math.
// Contract IDs of trades WE placed via /api/bot/trade, so the journal can
// label them "Bot Engine" instead of lumping them in with pre-existing
// account history pulled from Deriv.
const botPlacedContractIds = new Set<string>();

let allTrades: any[] = [];

// Trades closed before this timestamp are hidden from the journal/UI (see
// POST /api/journal/reset). null = show everything.
let journalCutoffTime: string | null = null;

// Deriv's profit_table only includes shortcode/longcode (which contain the
// instrument name) if you explicitly ask for them via description:1. Even
// then, shortcode looks like "CALL_R_100_20_...", so we pull the readable
// name out of longcode's "... if <Instrument Name> is/was ..." phrasing,
// falling back to picking the known symbol code out of the shortcode.
const KNOWN_SYMBOL_PATTERN = /\b(R_\d+|1HZ\d+V|BOOM\d+|CRASH\d+|JD\d+|frx[A-Z]+|cry[A-Z]+|WLD[A-Z]+)\b/;
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
  maxDailyLossUsd: 2500,
  maxWeeklyLossUsd: 6500,
  maxMonthlyLossUsd: 15000,
  breakerAction: 'HALT_PREVENT_NEW',
};

let riskState: RiskState = {
  currentDailyLossUsd: 0,
  currentWeeklyLossUsd: 0,
  currentMonthlyLossUsd: 0,
  breakerTriggered: false,
  activeTripScope: 'NONE',
  lastTriggerReason: undefined,
};

// Recomputes real daily/weekly/monthly realized loss from actual closed
// Deriv trades (activeBrokerTelemetry.trades), and trips the kill switch
// automatically the moment any ceiling is breached. This replaces the old
// static placeholder numbers (820 / 1450 / 2180) that never changed.
function recomputeRiskState() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay()); // Sunday
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  let dailyLoss = 0;
  let weeklyLoss = 0;
  let monthlyLoss = 0;

  for (const t of allTrades) {
    if (typeof t.pnl !== 'number' || t.pnl >= 0) continue; // only realized losses count
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
    // The breaker is the real kill switch: force masterExecution off so
    // /api/bot/trade refuses new orders until a human resets it.
    activeBotConfig.masterExecution = false;
  }
}

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
  totalDeposits: 0.00,
  winRate: 0.0,
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
  lastPingMs: 0,
  lastSyncTime: new Date().toISOString(),
  lastHeartbeat: new Date().toISOString(),
  openPositions: [],
  trades: [],
};

// Module-level so the trade-execution endpoint (further down) can reach the
// live Deriv socket instead of each part of the file holding its own copy.
let derivSocket: WebSocket | null = null;

// Pending request/response tracking for req_id-correlated Deriv API calls
// (buy, proposal, etc. — anything that isn't a plain subscription).
const pendingDerivRequests = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
let nextReqId = 1000;

function sendDerivRequest(payload: Record<string, any>, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!derivSocket || derivSocket.readyState !== WebSocket.OPEN) {
      reject(new Error('Deriv WebSocket is not connected.'));
      return;
    }
    const req_id = nextReqId++;
    const timer = setTimeout(() => {
      pendingDerivRequests.delete(req_id);
      reject(new Error('Deriv API request timed out.'));
    }, timeoutMs);

    pendingDerivRequests.set(req_id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });

    derivSocket.send(JSON.stringify({ ...payload, req_id }));
  });
}

async function startDerivGateway() {
 const DERIV_APP_ID = process.env.DERIV_APP_ID!;
const DERIV_API_TOKEN = process.env.DERIV_API_TOKEN!;
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
      derivSocket = ws;

      ws.on('open', () => {
        console.log('✅ Connected to Deriv API (new options endpoint)');
        reconnectAttempts = 0;
        activeBrokerTelemetry.connected = true;

        ws!.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 1 }));
        ws!.send(JSON.stringify({ portfolio: 1, req_id: 2 }));
        ws!.send(JSON.stringify({ statement: 1, limit: 100, req_id: 3 }));
        ws!.send(JSON.stringify({ profit_table: 1, limit: 50, sort: 'DESC', description: 1, req_id: 4 }));
      });

      ws.on('message', (raw) => {
        const data = JSON.parse(raw.toString());

        // If this message answers a specific request we're waiting on
        // (e.g. a buy order or a price proposal), resolve/reject that
        // promise instead of falling through to the telemetry handlers.
        if (data.req_id && pendingDerivRequests.has(data.req_id)) {
          const pending = pendingDerivRequests.get(data.req_id)!;
          pendingDerivRequests.delete(data.req_id);
          if (data.error) {
            pending.reject(new Error(data.error.message || 'Deriv API error'));
          } else {
            pending.resolve(data);
          }
          return;
        }

        if (data.error) {
          console.error('Deriv API error:', data.error.message);
          return;
        }

                if (data.msg_type === 'balance') {
          activeBrokerTelemetry.balance = data.balance.balance;
          // Approximation: equity = balance for now. Once we subscribe to live
          // open-contract pricing (proposal_open_contract), this should become
          // balance + sum of floating P&L on open positions instead.
          activeBrokerTelemetry.equity = data.balance.balance;
          activeBrokerTelemetry.currency = data.balance.currency || activeBrokerTelemetry.currency;
          activeBrokerTelemetry.lastSyncTime = new Date().toISOString();
          activeBrokerTelemetry.lastHeartbeat = new Date().toISOString();
        }

        if (data.msg_type === 'profit_table') {
          const txs = data.profit_table?.transactions || [];
          allTrades = txs.map((t: any) => {
            const pnl = (t.sell_price ?? 0) - (t.buy_price ?? 0);
            const openMs = (t.purchase_time ?? 0) * 1000;
            const closeMs = (t.sell_time ?? 0) * 1000;
            const durationMin = Math.max(0, Math.round((closeMs - openMs) / 60000));
            return {
              id: String(t.transaction_id ?? t.contract_id),
              ticket: String(t.contract_id ?? t.transaction_id),
              asset: extractInstrumentName(t.shortcode, t.longcode),
              type: 'BUY',
              lots: t.payout || 0,
              openPrice: t.buy_price ?? 0,
              closePrice: t.sell_price ?? 0,
              pnl: Number(pnl.toFixed(2)),
              pnlPct: t.buy_price ? Number(((pnl / t.buy_price) * 100).toFixed(2)) : 0,
              openTime: t.purchase_time ? new Date(openMs).toISOString() : '',
              closeTime: t.sell_time ? new Date(closeMs).toISOString() : '',
              duration: `${durationMin}m`,
              status: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BREAKEVEN',
              source: botPlacedContractIds.has(String(t.contract_id)) ? 'Bot Engine' : 'Deriv Live',
            };
          });

          activeBrokerTelemetry.trades = journalCutoffTime
            ? allTrades.filter((t) => !t.closeTime || t.closeTime >= journalCutoffTime!)
            : allTrades;

          console.log(`📒 Loaded ${allTrades.length} real trades from Deriv profit_table (${activeBrokerTelemetry.trades.length} visible in journal)`);
          recomputeRiskState();
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

          // Real "total injections" — sum of actual deposit transactions on
          // this account, replacing the old hardcoded $125,000 placeholder.
          const deposits = txs.filter((t: any) => t.action_type === 'deposit');
          activeBrokerTelemetry.totalDeposits = Number(
            deposits.reduce((sum: number, t: any) => sum + (t.amount || 0), 0).toFixed(2)
          );
        }
      });

      ws.on('close', () => {
        activeBrokerTelemetry.connected = false;
        derivSocket = null;
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

  // 2. Journal and Analysis API Endpoints
app.get('/api/journal', async (req, res) => {
    try {
        const trades: any[] = activeBrokerTelemetry.trades;
        res.status(200).json(trades);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch journal entries" });
    }
});

// "Reset" the journal view. This does NOT delete anything from Deriv (that's
// real broker history and can't be erased) — it just hides everything closed
// before right now from the dashboard, so old/unrelated trades stop showing
// up as if the bot placed them. Real risk/kill-switch math still accounts
// for ALL historical trades regardless of this cutoff.
app.post('/api/journal/reset', (req, res) => {
    journalCutoffTime = new Date().toISOString();
    activeBrokerTelemetry.trades = allTrades.filter((t) => !t.closeTime || t.closeTime >= journalCutoffTime!);
    res.json({
      status: 'success',
      message: 'Journal view cleared. New trades from this point on will appear normally.',
      cutoff: journalCutoffTime,
    });
});

app.post('/api/analysis', async (req, res) => {
    try {
        const analysisResult = { status: "success", message: "Live analysis executed." };
        res.status(200).json(analysisResult);
    } catch (error) {
        res.status(500).json({ error: "Analysis execution failed" });
    }
});

  // 2. Get Bot Configuration
  app.get('/api/bot/config', (req, res) => {
    res.json({
      status: 'success',
      data: activeBotConfig,
    });
  });

  // 3. Update Bot Configuration
  // 3. Update Bot Configuration
app.post('/api/bot/config', (req, res) => {
  try {
    const config = req.body;

    // 1. Update active in-memory configuration
    const {
      masterExecution,
      riskPerTradePct,
      riskToReward,
      maxDailyTrades,
      trailingStopActive,
      autoBreakevenPips,
      currency
    } = config;

    if (typeof masterExecution === 'boolean') activeBotConfig.masterExecution = masterExecution;
    if (typeof riskPerTradePct === 'number') activeBotConfig.riskPerTradePct = riskPerTradePct;
    if (typeof riskToReward === 'number') activeBotConfig.riskToReward = riskToReward;
    if (typeof maxDailyTrades === 'number') activeBotConfig.maxDailyTrades = maxDailyTrades;
    if (typeof trailingStopActive === 'boolean') activeBotConfig.trailingStopActive = trailingStopActive;
    if (typeof autoBreakevenPips === 'number') activeBotConfig.autoBreakevenPips = autoBreakevenPips;
    if (typeof currency === 'string') activeBotConfig.currency = currency;

    activeBotConfig.updatedAt = new Date().toISOString();

    // 2. Persist to bot_config.json for matrix.py to read
    fs.writeFileSync('bot_config.json', JSON.stringify(config, null, 2));

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
    
  // 3b. Get / Update Risk Limits (max daily/weekly/monthly loss ceilings)
  app.get('/api/limits', (req, res) => {
    recomputeRiskState();
    res.json({
      status: 'success',
      data: { ...riskLimits, ...riskState },
    });
  });

  app.post('/api/limits', (req, res) => {
    const { maxDailyLossUsd, maxWeeklyLossUsd, maxMonthlyLossUsd, breakerAction, resetBreaker } = req.body;

    if (typeof maxDailyLossUsd === 'number') riskLimits.maxDailyLossUsd = maxDailyLossUsd;
    if (typeof maxWeeklyLossUsd === 'number') riskLimits.maxWeeklyLossUsd = maxWeeklyLossUsd;
    if (typeof maxMonthlyLossUsd === 'number') riskLimits.maxMonthlyLossUsd = maxMonthlyLossUsd;
    const validActions = ['HALT_CLOSE_ALL', 'HALT_PREVENT_NEW', 'REDUCE_SIZE_50', 'ALERT_ONLY'];
    if (typeof breakerAction === 'string' && validActions.includes(breakerAction)) {
      riskLimits.breakerAction = breakerAction as RiskLimitsConfig['breakerAction'];
    }

    app.post('/api/limits', (req, res) => {
  try {
    const { maxDailyLossUsd, maxWeeklyLossUsd, maxMonthlyLossUsd, breakerAction } = req.body;

    if (typeof maxDailyLossUsd === 'number') riskLimits.maxDailyLossUsd = maxDailyLossUsd;
    if (typeof maxWeeklyLossUsd === 'number') riskLimits.maxWeeklyLossUsd = maxWeeklyLossUsd;
    if (typeof maxMonthlyLossUsd === 'number') riskLimits.maxMonthlyLossUsd = maxMonthlyLossUsd;
    
    const validActions = ['HALT_CLOSE_ALL', 'HALT_PREVENT_NEW', 'REDUCE_SIZE_50', 'ALERT_ONLY'];
    if (typeof breakerAction === 'string' && validActions.includes(breakerAction)) {
      riskLimits.breakerAction = breakerAction as RiskLimitsConfig['breakerAction'];
    }

    // Persist full configuration payload for matrix.py
    const currentConfig = fs.existsSync('bot_config.json') 
      ? JSON.parse(fs.readFileSync('bot_config.json', 'utf8')) 
      : {};

    const updatedConfig = {
      ...currentConfig,
      maxDailyLoss: riskLimits.maxDailyLossUsd,
      maxWeeklyLoss: riskLimits.maxWeeklyLossUsd,
      maxMonthlyLoss: riskLimits.maxMonthlyLossUsd,
      breakerAction: riskLimits.breakerAction,
    };

    fs.writeFileSync('bot_config.json', JSON.stringify(updatedConfig, null, 2));

    res.json({
      status: 'success',
      data: { ...riskLimits, ...riskState },
    });
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error?.message || 'Failed to update limits' });
  }
});
    res.json({
      status: 'success',
      message: 'Risk limits updated',
      data: { ...riskLimits, ...riskState },
    });
  });

  // 3c. Get Risk Status (real computed daily/weekly/monthly loss + breaker state)
  app.get('/api/risk/status', (req, res) => {
    recomputeRiskState();
    res.json({ status: 'success', data: { ...riskLimits, ...riskState } });
  });

  // 3d. Place a real trade on Deriv — the actual "execute" call that was
  // previously missing entirely. Gated by the kill switch: refuses to fire
  // if masterExecution is off or the risk breaker has tripped.
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

    const { symbol, contractType, stakeUsd, durationValue, durationUnit } = req.body;
    if (!symbol || !contractType || typeof stakeUsd !== 'number') {
      return res.status(400).json({
        status: 'error',
        message: 'Required: symbol (e.g. "R_100"), contractType ("CALL" or "PUT"), stakeUsd (number).',
      });
    }

    try {
      // Step 1: price the contract
      const proposal = await sendDerivRequest({
        proposal: 1,
        amount: stakeUsd,
        basis: 'stake',
        contract_type: contractType,
        currency: activeBrokerTelemetry.currency || 'USD',
        duration: durationValue ?? 5,
        duration_unit: durationUnit ?? 'm',
        symbol,
      });

      if (!proposal.proposal?.id) {
        throw new Error('No proposal id returned from Deriv.');
      }

      // Step 2: buy the priced contract
      const bought = await sendDerivRequest({
        buy: proposal.proposal.id,
        price: stakeUsd,
      });

      res.json({ status: 'success', message: 'Trade placed on Deriv.', data: bought.buy });
      if (bought.buy?.contract_id) {
        botPlacedContractIds.add(String(bought.buy.contract_id));
      }
    } catch (err: any) {
      console.error('Trade execution failed:', err.message);
      res.status(502).json({ status: 'error', message: `Trade execution failed: ${err.message}` });
    }
  });

  // 4. Get Live Telemetry
  app.get('/api/broker/telemetry', (req, res) => {
    recomputeRiskState(); // keep the kill switch fresh on every poll, not just on new trades
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