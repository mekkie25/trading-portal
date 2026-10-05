import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createServer as createViteServer } from 'vite';
import { spawn, ChildProcess } from 'child_process';

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

const WHITELIST_ASSETS = ["US30", "GOLD", "NAS100", "GERMAN30", "EURUSD", "GBPUSD", "USDJPY"];

const BOT_CONFIG_FILE = path.join(process.cwd(), 'bot_config.json');
const TRADES_DB_FILE = path.join(process.cwd(), 'trades_db.json');
const CANDLES_CACHE_FILE = path.join(process.cwd(), 'candles_cache.json');
const CLOSE_COMMAND_FILE = path.join(process.cwd(), 'close_command.json');
const RISK_STATE_FILE = process.env.RISK_STATE_FILE || path.join(process.cwd(), 'risk_state.json');

const storageBase = (process.env.BACKTEST_STORAGE_DIR || '').trim();
const BACKTEST_OUTPUT_DIR = storageBase
  ? path.join(storageBase, 'output')
  : path.join(process.cwd(), 'backtest', 'output');
const BACKTEST_DATA_DIR = storageBase
  ? path.join(storageBase, 'data')
  : path.join(process.cwd(), 'backtest', 'data');

let backtestRunning = false;
let backtestProgress = '';
let backtestLastError: string | null = null;
let backtestExitCode: number | null = null;
let activeBacktestProcesses: ChildProcess[] = [];
let backtestResults: Array<{ symbol: string; status: 'OK' | 'FAILED'; message: string; timing?: string }> = [];

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
        if (Array.isArray(parsed)) return parsed;
      }
    }
  } catch (e) {
    console.error('Failed to load trades from disk:', e);
  }
  return [];
}

function recomputeRiskState() {
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
  } catch (e) {}
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
  trades: [],
};

function generateExportDataPayload(): any {
  const result: any = {
    generated_at: new Date().toISOString(),
    days: 60,
    target_rr: 1.0,
    combinations_rollup: {},
    pairs: []
  };

  const allSummaryCombos: Record<string, { trades: number; pnl: number; win_count: number }> = {};

  for (const sym of WHITELIST_ASSETS) {
    const summaryFile = path.resolve(BACKTEST_OUTPUT_DIR, `${sym}_summary.json`);
    if (!fs.existsSync(summaryFile)) {
      result.pairs.push({
        symbol: sym,
        status: "NOT TESTED",
        error: "No backtest summary generated yet."
      });
      continue;
    }

    try {
      const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
      result.days = summary.days || result.days;
      result.target_rr = summary.target_rr || result.target_rr;
      const combos: any[] = summary.combinations || [];

      combos.forEach(c => {
        if (!allSummaryCombos[c.label]) {
          allSummaryCombos[c.label] = { trades: 0, pnl: 0, win_count: 0 };
        }
        allSummaryCombos[c.label].trades += c.total_trades || 0;
        allSummaryCombos[c.label].pnl += c.net_pnl || 0;
        allSummaryCombos[c.label].win_count += Math.round(((c.win_rate || 0) / 100) * (c.total_trades || 0));
      });

      // Select best combination: highest PF with trades >= 30, else highest trades
      let bestCombo: any = null;
      const qualifying = combos.filter(c => (c.total_trades || 0) >= 30);
      if (qualifying.length > 0) {
        bestCombo = qualifying.reduce((b, curr) => (curr.profit_factor > b.profit_factor ? curr : b), qualifying[0]);
      } else if (combos.length > 0) {
        bestCombo = combos.reduce((b, curr) => (curr.total_trades > b.total_trades ? curr : b), combos[0]);
      }

      let bestReportDetail: any = {};
      if (bestCombo && bestCombo.report_file) {
        const reportPath = path.resolve(BACKTEST_OUTPUT_DIR, bestCombo.report_file);
        if (fs.existsSync(reportPath)) {
          bestReportDetail = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        }
      }

      const pairPayload: any = {
        symbol: sym,
        status: "OK",
        combinations: combos,
        best_combination: {
          ...(bestCombo || {}),
          strategy_kpis: bestReportDetail.strategy_kpis || {},
          dow_kpis: bestReportDetail.dow_kpis || {},
          skipped_summary: bestReportDetail.skipped_summary || {},
          warnings: bestReportDetail.warnings || [],
          adaptive_effective_pct: bestReportDetail.adaptive_effective_pct ?? 100,
          improvement_tips: bestReportDetail.improvement_tips || []
        }
      };

      result.pairs.push(pairPayload);
    } catch (e: any) {
      result.pairs.push({ symbol: sym, status: "NOT TESTED", error: e.message });
    }
  }

  // Cross-pair rollup per combination
  const rollup: Record<string, any> = {};
  Object.entries(allSummaryCombos).forEach(([label, s]) => {
    rollup[label] = {
      total_trades: s.trades,
      total_pnl: Number(s.pnl.toFixed(2)),
      weighted_win_rate: s.trades > 0 ? Number(((s.win_count / s.trades) * 100).toFixed(1)) : 0
    };
  });
  result.combinations_rollup = rollup;

  return result;
}

function formatExportTxt(data: any): string {
  const lines: string[] = [];
  lines.push(`LEGEND: [TR]=Trades | [WR]=WinRate% | [EXP]=Expectancy(R) | [PF]=ProfitFactor | [DD]=MaxDrawdown | [PNL]=NetRealized$ | [COV]=AdaptiveCover%`);
  lines.push(`RUN: Date: ${data.generated_at.slice(0, 10)} | Days: ${data.days} | Target R:R: 1:${data.target_rr}`);
  lines.push(`RULES: Trades < 30 tagged as INCONCLUSIVE | All numbers rounded to 2 decimals\n`);

  lines.push(`=== CROSS-PAIR ROLLUP PER COMBINATION ===`);
  Object.entries(data.combinations_rollup || {}).forEach(([combo, r]: any) => {
    lines.push(`${combo.padEnd(32)} | TR: ${String(r.total_trades).padStart(5)} | WR: ${r.weighted_win_rate.toFixed(1).padStart(5)}% | PNL: $${r.total_pnl.toFixed(2)}`);
  });
  lines.push(``);

  for (const p of data.pairs || []) {
    lines.push(`================================================================================`);
    lines.push(`ASSET: ${p.symbol} (${p.status})`);
    if (p.status !== "OK") {
      lines.push(`STATUS: ${p.error || 'Not tested'}\n`);
      continue;
    }

    lines.push(`--- 8 Combinations ---`);
    for (const c of p.combinations || []) {
      const incon = (c.total_trades || 0) < 30 ? " [INCONCLUSIVE]" : "";
      lines.push(`${c.label.padEnd(32)} | TR: ${String(c.total_trades).padStart(4)} | WR: ${c.win_rate.toFixed(1)}% | EXP: ${c.expectancy.toFixed(2)}R | PF: ${c.profit_factor.toFixed(2)} | DD: -$${c.max_drawdown.toFixed(2)} | PNL: $${c.net_pnl.toFixed(2)} | COV: ${c.adaptive_effective_pct.toFixed(0)}%${incon}`);
    }

    const b = p.best_combination || {};
    lines.push(`\n--- Best Combination: ${b.label || 'N/A'} ---`);
    lines.push(`Performance by Strategy:`);
    Object.entries(b.strategy_kpis || {}).forEach(([sName, s]: any) => {
      lines.push(`  ${sName.padEnd(28)} | TR: ${String(s.count).padStart(3)} | WR: ${s.win_rate.toFixed(1)}% | PF: ${s.profit_factor.toFixed(2)} | PNL: $${s.net_pnl.toFixed(2)}`);
    });

    lines.push(`Performance by Day of Week:`);
    Object.entries(b.dow_kpis || {}).forEach(([dow, s]: any) => {
      lines.push(`  ${dow.padEnd(12)} | TR: ${String(s.count).padStart(3)} | WR: ${s.win_rate.toFixed(1)}% | EXP: ${s.expectancy.toFixed(2)}R | PNL: $${s.net_pnl.toFixed(2)}`);
    });

    if (b.warnings && b.warnings.length > 0) {
      lines.push(`Warnings: ${b.warnings.join(' | ')}`);
    }

    const tips = b.improvement_tips || [];
    if (tips.length > 0) {
      lines.push(`Suggestions:`);
      tips.slice(0, 5).forEach((t: any) => {
        lines.push(`  • [${t.severity}] ${t.title}: ${t.action}`);
      });
    }
    lines.push(``);
  }

  return lines.join('\n');
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json());

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

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

  app.post('/api/positions/close/:id', (req, res) => {
    try {
      const positionId = req.params.id;
      fs.writeFileSync(CLOSE_COMMAND_FILE, JSON.stringify({ positionId, requestedAt: new Date().toISOString() }));
      res.status(200).json({ status: 'success', message: `Close command queued for position #${positionId}` });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  // BACKTEST EXPORT APIS
  app.get('/api/backtest/export-data', (_req, res) => {
    try {
      const data = generateExportDataPayload();
      res.status(200).json({ status: 'success', data });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  app.get('/api/backtest/export.txt', (_req, res) => {
    try {
      const data = generateExportDataPayload();
      const txt = formatExportTxt(data);
      const dateStr = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="backtest_${dateStr}.txt"`);
      res.status(200).send(txt);
    } catch (err: any) {
      res.status(500).send(`Export error: ${err?.message}`);
    }
  });

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

  app.get('/api/backtest/summary/:symbol', (req, res) => {
    try {
      const sym = req.params.symbol.toUpperCase();
      const summaryFile = path.resolve(BACKTEST_OUTPUT_DIR, `${sym}_summary.json`);
      if (fs.existsSync(summaryFile)) {
        const data = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
        return res.status(200).json({ status: 'success', data });
      }
      return res.status(404).json({ status: 'error', message: 'Summary not found' });
    } catch (err: any) {
      return res.status(500).json({ status: 'error', message: err?.message });
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

      if (data && data.day_data && data.symbol) {
        const daycandlesPath = path.resolve(BACKTEST_OUTPUT_DIR, `${data.symbol}_daycandles.json`);
        if (fs.existsSync(daycandlesPath)) {
          try {
            const dayCandles = JSON.parse(fs.readFileSync(daycandlesPath, 'utf8'));
            for (const [dateKey, dayObj] of Object.entries<any>(data.day_data)) {
              if ((!dayObj.candles || dayObj.candles.length === 0) && dayCandles[dateKey]) {
                dayObj.candles = dayCandles[dateKey];
              }
            }
          } catch (e) {
            console.warn(`Could not load shared daycandles for ${data.symbol}:`, e);
          }
        }
      }

      res.status(200).json({ status: 'success', data });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  app.get('/api/backtest/status', (_req, res) => {
    res.status(200).json({
      status: 'success',
      isRunning: backtestRunning,
      progress: backtestProgress,
      lastError: backtestLastError,
      exitCode: backtestExitCode,
      results: backtestResults
    });
  });

  app.post('/api/backtest/stop', (_req, res) => {
    activeBacktestProcesses.forEach(p => {
      try { p.kill(); } catch {}
    });
    activeBacktestProcesses = [];
    backtestRunning = false;
    backtestProgress = 'Backtest canceled by user.';
    backtestLastError = null;
    res.status(200).json({ status: 'success', message: 'Backtest stopped.' });
  });

  app.get('/api/backtest/storage', (_req, res) => {
    try {
      const volPath = storageBase || process.cwd();
      let total_mb = 0, free_mb = 0, used_mb = 0;
      try {
        const stats = fs.statfsSync(volPath);
        total_mb = Math.round((stats.bsize * stats.blocks) / (1024 * 1024));
        free_mb = Math.round((stats.bsize * stats.bfree) / (1024 * 1024));
        used_mb = total_mb - free_mb;
      } catch (e) {}

      let market_data_bytes = 0;
      const allFiles: Array<{ name: string; path: string; size_mb: number; type: string }> = [];

      if (fs.existsSync(BACKTEST_DATA_DIR)) {
        for (const f of fs.readdirSync(BACKTEST_DATA_DIR)) {
          const fPath = path.join(BACKTEST_DATA_DIR, f);
          try {
            const stat = fs.statSync(fPath);
            if (stat.isFile()) {
              if (f.endsWith('.csv')) market_data_bytes += stat.size;
              allFiles.push({
                name: f, path: fPath,
                size_mb: Number((stat.size / (1024 * 1024)).toFixed(2)),
                type: f.endsWith('.csv') ? 'market_data' : 'data_other'
              });
            }
          } catch {}
        }
      }

      let reports_bytes = 0;
      if (fs.existsSync(BACKTEST_OUTPUT_DIR)) {
        for (const f of fs.readdirSync(BACKTEST_OUTPUT_DIR)) {
          const fPath = path.join(BACKTEST_OUTPUT_DIR, f);
          try {
            const stat = fs.statSync(fPath);
            if (stat.isFile()) {
              reports_bytes += stat.size;
              allFiles.push({
                name: f, path: fPath,
                size_mb: Number((stat.size / (1024 * 1024)).toFixed(2)),
                type: 'report'
              });
            }
          } catch {}
        }
      }

      allFiles.sort((a, b) => b.size_mb - a.size_mb);
      const largest_files = allFiles.slice(0, 20);

      res.status(200).json({
        status: 'success',
        data: {
          total_mb, used_mb, free_mb,
          market_data_mb: Number((market_data_bytes / (1024 * 1024)).toFixed(2)),
          reports_mb: Number((reports_bytes / (1024 * 1024)).toFixed(2)),
          largest_files
        }
      });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  app.post('/api/backtest/storage/cleanup', (req, res) => {
    try {
      const scope = req.body?.scope || 'all_reports';
      const targetSym = (req.body?.symbol || '').toUpperCase().trim();
      let deletedCount = 0;

      if (fs.existsSync(BACKTEST_OUTPUT_DIR)) {
        for (const f of fs.readdirSync(BACKTEST_OUTPUT_DIR)) {
          if (!f.endsWith('.json')) continue;
          let shouldDelete = (scope === 'all_reports') || (scope === 'symbol' && targetSym && f.startsWith(`${targetSym}_`));
          if (shouldDelete) {
            try { fs.unlinkSync(path.join(BACKTEST_OUTPUT_DIR, f)); deletedCount++; } catch {}
          }
        }
      }

      if (fs.existsSync(BACKTEST_DATA_DIR)) {
        for (const f of fs.readdirSync(BACKTEST_DATA_DIR)) {
          if (f.endsWith('_M5.csv') || f.endsWith('_H1.csv') || f.endsWith('_H4.csv') || f.endsWith('_D1.csv')) continue;
          const isLeftover = f.includes('_trades.csv') || f.includes('_trades.json') || f.includes('_skipped_signals.csv') || f === 'report.html';
          if (isLeftover) {
            let shouldDelete = (scope === 'all_reports') || (scope === 'symbol' && targetSym && f.startsWith(`${targetSym}_`));
            if (shouldDelete) {
              try { fs.unlinkSync(path.join(BACKTEST_DATA_DIR, f)); deletedCount++; } catch {}
            }
          }
        }
      }

      res.status(200).json({ status: 'success', message: `Cleanup completed. Deleted ${deletedCount} file(s).`, deletedCount });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  app.post('/api/backtest/compare', async (req, res) => {
    try {
      const symbol = String(req.body?.symbol || 'US30').toUpperCase();
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      const proc = spawn(pythonCmd, ['backtest/runner.py', '--symbol', symbol, '--compare'], {
        env: { ...process.env, PYTHONPATH: process.cwd() }
      });

      let output = '';
      let errText = '';
      proc.stdout.on('data', d => { output += d.toString(); });
      proc.stderr.on('data', d => { errText += d.toString(); });

      proc.on('exit', code => {
        if (code === 0) res.status(200).json({ status: 'success', diff: output.trim() });
        else res.status(500).json({ status: 'error', message: errText || output || `Exited code ${code}` });
      });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  // RUN ALL WITH PARALLEL WORKERS & PREPARE-ONLY STAGE
  app.post('/api/backtest/run', (req, res) => {
    if (backtestRunning) {
      return res.status(409).json({ status: 'error', message: 'A backtest is already running.' });
    }

    const requestedSymbol = String(req.body?.symbol || 'US30').toUpperCase();
    const days = parseInt(req.body?.days || '60', 10);
    const rr = parseFloat(req.body?.rr || 1.0);

    backtestResults = [];
    activeBacktestProcesses = [];
    backtestRunning = true;
    backtestProgress = `Initiating backtest matrix...`;
    backtestLastError = null;
    backtestExitCode = null;

    const symbolsQueue = requestedSymbol === 'ALL' ? WHITELIST_ASSETS : [requestedSymbol];
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    async function executeMatrix() {
      // 1. Preparation Phase (Sequential download)
      if (requestedSymbol === 'ALL') {
        for (let idx = 0; idx < symbolsQueue.length; idx++) {
          if (!backtestRunning) return;
          const sym = symbolsQueue[idx];
          backtestProgress = `[Phase 1/2: Preparing Data ${idx + 1}/${symbolsQueue.length}] ${sym}...`;

          await new Promise<void>((resolve) => {
            const prepProc = spawn(pythonCmd, ['backtest/runner.py', '--symbol', sym, '--prepare-only'], {
              env: { ...process.env, PYTHONPATH: process.cwd() }
            });
            prepProc.on('exit', () => resolve());
            prepProc.on('error', () => resolve());
          });
        }
      }

      // 2. Parallel Execution Phase
      const maxWorkers = Math.min(4, os.cpus().length || 2);
      let activeIndex = 0;
      let completedCount = 0;

      async function runWorker(sym: string): Promise<void> {
        let symTiming = '';
        let symError = '';

        const args = ['backtest/runner.py', '--symbol', sym, '--days', String(days), '--rr', String(rr)];
        if (requestedSymbol === 'ALL') args.push('--skip-download');

        await new Promise<void>((resolve) => {
          const proc = spawn(pythonCmd, args, { env: { ...process.env, PYTHONPATH: process.cwd() } });
          activeBacktestProcesses.push(proc);

          proc.stdout.on('data', data => {
            const lines = data.toString().split('\n');
            for (const l of lines) {
              const trimmed = l.trim();
              if (trimmed.startsWith('[time]')) symTiming = trimmed.replace('[time]', '').trim();
              if (trimmed.startsWith('ERROR:')) symError = trimmed;
            }
          });

          proc.stderr.on('data', data => {
            const errLines = data.toString().split('\n').filter(Boolean);
            if (errLines.length > 0) symError = `ERROR in ${sym}: ${errLines[errLines.length - 1].trim()}`;
          });

          proc.on('exit', code => {
            completedCount++;
            backtestProgress = `[Phase 2/2] ${completedCount}/${symbolsQueue.length} assets completed.`;
            if (code === 0) {
              backtestResults.push({ symbol: sym, status: 'OK', message: 'Completed 8/8 matrix', timing: symTiming });
            } else {
              backtestResults.push({ symbol: sym, status: 'FAILED', message: symError || `Exited with code ${code}`, timing: symTiming });
            }
            resolve();
          });

          proc.on('error', err => {
            completedCount++;
            backtestResults.push({ symbol: sym, status: 'FAILED', message: err.message });
            resolve();
          });
        });
      }

      const activePool: Promise<void>[] = [];
      while (activeIndex < symbolsQueue.length && backtestRunning) {
        while (activePool.length < maxWorkers && activeIndex < symbolsQueue.length) {
          const nextSym = symbolsQueue[activeIndex++];
          const p = runWorker(nextSym).then(() => {
            activePool.splice(activePool.indexOf(p), 1);
          });
          activePool.push(p);
        }
        if (activePool.length > 0) {
          await Promise.race(activePool);
        }
      }
      await Promise.all(activePool);

      backtestRunning = false;
      backtestProgress = `Finished: ${backtestResults.filter(r => r.status === 'OK').length}/${backtestResults.length} assets completed.`;
    }

    executeMatrix().catch(e => {
      backtestRunning = false;
      backtestLastError = e.message;
    });

    res.status(200).json({ status: 'success', message: `Execution initiated for ${requestedSymbol}` });
  });

  app.get('/api/journal', async (_req, res) => {
    try {
      const diskTrades = loadTradesFromDisk();
      activeBrokerTelemetry.trades = diskTrades;
      res.status(200).json(diskTrades);
    } catch {
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
    } catch {
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

  app.post('/api/journal/reset', (_req, res) => {
    saveTradesToDisk([]);
    activeBrokerTelemetry.trades = [];
    recomputeRiskState();
    res.json({ status: 'success', message: 'Journal reset.' });
  });

  app.get('/api/bot/config', (_req, res) => {
    res.json({ status: 'success', data: activeBotConfig });
  });

  app.post('/api/bot/config', (req, res) => {
    try {
      const config = req.body;
      activeBotConfig = { ...activeBotConfig, ...config, updatedAt: new Date().toISOString() };
      fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(activeBotConfig, null, 2));
      res.json({ status: 'success', config: activeBotConfig });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error?.message });
    }
  });

  app.get('/api/limits', (_req, res) => {
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

      if (resetBreaker) {
        riskState.breakerTriggered = false;
        riskState.activeTripScope = 'NONE';
        riskState.lastTriggerReason = undefined;
        activeBotConfig.masterExecution = true;
      }

      fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify({ ...activeBotConfig, ...riskLimits, limitsConfirmedAt: new Date().toISOString() }, null, 2));
      res.json({ status: 'success', data: { ...riskLimits, ...riskState } });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error?.message });
    }
  });

  app.get('/api/broker/telemetry', (_req, res) => {
    recomputeRiskState();
    res.json({ status: 'success', data: activeBrokerTelemetry });
  });

  app.post('/api/broker/telemetry', (req, res) => {
    activeBrokerTelemetry = { ...activeBrokerTelemetry, ...req.body, lastHeartbeat: new Date().toISOString() };
    res.json({ status: 'success', data: activeBrokerTelemetry, activeBotConfig });
  });

  function launchPythonBot() {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const bot = spawn(pythonCmd, ['engine/matrix.py'], {
      env: { ...process.env, PYTHONPATH: process.cwd() },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    bot.stdout.on('data', chunk => {
      const line = chunk.toString().trim();
      if (line.includes('[MATRIX_TELEMETRY]')) {
        try {
          const telem = JSON.parse(line.split('[MATRIX_TELEMETRY]')[1].trim());
          activeBrokerTelemetry.balance = telem.balance;
          activeBrokerTelemetry.equity = telem.equity;
          if (telem.currency) activeBrokerTelemetry.currency = telem.currency;
          if (telem.netProfit !== undefined) activeBrokerTelemetry.netProfit = telem.netProfit;
          if (telem.winRate !== undefined) activeBrokerTelemetry.winRate = telem.winRate;
          if (telem.totalTrades !== undefined) activeBrokerTelemetry.totalTrades = telem.totalTrades;
          if (telem.winningTrades !== undefined) activeBrokerTelemetry.winningTrades = telem.winningTrades;
          if (telem.losingTrades !== undefined) activeBrokerTelemetry.losingTrades = telem.losingTrades;
          if (Array.isArray(telem.openPositions)) activeBrokerTelemetry.openPositions = telem.openPositions;
          activeBrokerTelemetry.connected = true;
          activeBrokerTelemetry.lastHeartbeat = new Date().toISOString();
        } catch {}
      }
    });

    bot.on('exit', () => {
      setTimeout(launchPythonBot, 5000);
    });
  }

  launchPythonBot();

  const distPath = path.join(process.cwd(), 'dist');
  if (fs.existsSync(path.join(distPath, 'index.html'))) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  } else {
    const vite = await createViteServer({ server: { middlewareMode: true, host: '0.0.0.0' }, appType: 'spa' });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Trading Portal & API Gateway active on port ${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Server startup error:', err);
  process.exit(1);
});