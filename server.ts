import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import archiver from 'archiver';
import { createServer as createViteServer } from 'vite';
import { spawn, ChildProcess } from 'child_process';
import { METRIC_DESCRIPTIONS, describe } from './shared/metricDescriptions';

// =============================================================================
// AI-FRIENDLY EXPORT
// =============================================================================
const SAMPLE_TRADES_PER_PAIR = 30;
const STALE_SUMMARY_HOURS = 24;

interface BotGatewayConfig {
  masterExecution: boolean; riskPerTradePct: number; minRr: number; adaptiveMode: boolean;
  stopOnDailyGoalReached: boolean; dailyGoalTarget: number; weeklyGoalTarget: number;
  monthlyGoalTarget: number; weeklyDepositBaseline: number; maxDailyTrades: number;
  trailingStopActive: boolean; autoBreakevenPips: number; currency: string;
  updatedAt: string; version: number;
  strategyModes?: Record<string, string>; limitsConfirmedAt?: string;
  riskProfile?: 'Steady' | 'Balanced' | 'Aggressive' | 'Max Growth' | null;
}
interface RiskLimitsConfig {
  maxDailyLossUsd: number; maxWeeklyLossUsd: number; maxMonthlyLossUsd: number;
  maxDailyDrawdownPct?: number; autoLiquidateAllOnTrip?: boolean;
  breakerAction: 'HALT_PREVENT_NEW'; useProfileDrawdownPct?: boolean;
}
interface RiskState {
  currentDailyLossUsd: number; currentWeeklyLossUsd: number; currentMonthlyLossUsd: number;
  breakerTriggered: boolean; activeTripScope: 'NONE' | 'DAY' | 'WEEK' | 'MONTH' | 'CURRENCY';
  lastTriggerReason?: string;
}
interface BrokerTelemetry {
  connected: boolean; provider: string; trades: any[]; accountNumber: string; server: string;
  currency: string; balance: number; equity: number; floatingPnL: number; netProfit: number;
  totalDeposits: number; winRate: number; totalTrades: number; winningTrades: number;
  losingTrades: number; lastPingMs: number; lastSyncTime: string; lastHeartbeat: string;
  openPositions: Array<{
    id: string; ticket: string; symbol: string; strategy: string;
    direction: 'BUY' | 'SELL'; lots: number; entry: number; currentPrice: number;
    sl?: number; tp?: number; floatingPnL: number; isRiskFree: boolean;
  }>;
}

const WHITELIST_ASSETS = ["US30", "GOLD", "NAS100", "GERMAN30", "EURUSD", "GBPUSD", "USDJPY"];

const SPEC_COVERAGE: Array<{ id: number; label: string; panel: boolean; txt: boolean; pdf: boolean; note?: string }> = [
  { id: 1,  label: 'Warm-up and history window',                panel: true,  txt: true,  pdf: true },
  { id: 2,  label: 'Zero-lookahead bar reconstruction',         panel: true,  txt: true,  pdf: true },
  { id: 3,  label: 'MFE / MAE per trade',                       panel: true,  txt: true,  pdf: true },
  { id: 4,  label: 'Profit-first flag',                         panel: false, txt: true,  pdf: true },
  { id: 5,  label: 'Post-SL noise recovery',                    panel: true,  txt: true,  pdf: true },
  { id: 6,  label: 'Post-TP extra movement',                    panel: true,  txt: true,  pdf: true },
  { id: 7,  label: 'Premature BE detection',                    panel: true,  txt: true,  pdf: true },
  { id: 8,  label: 'Structural BE variant',                     panel: false, txt: false, pdf: false },
  { id: 9,  label: 'EMA-9 / EMA-25 trail variants',             panel: false, txt: false, pdf: false },
  { id: 10, label: 'Fixed R:R target with structural room',      panel: true,  txt: true,  pdf: true },
  { id: 11, label: 'Twin-lot vs single-lot execution',          panel: false, txt: true,  pdf: false },
  { id: 12, label: 'Adaptive ADR stop clamping',                panel: true,  txt: true,  pdf: true },
  { id: 13, label: 'Structural target capping',                 panel: true,  txt: true,  pdf: true },
  { id: 14, label: 'Min R:R filter',                            panel: true,  txt: true,  pdf: true },
  { id: 15, label: 'Monotonic TP ordering',                     panel: true,  txt: true,  pdf: true },
  { id: 16, label: 'Post-SL continuation distance',             panel: true,  txt: true,  pdf: true },
  { id: 17, label: 'Post-TP extra pips',                        panel: true,  txt: true,  pdf: true },
  { id: 18, label: 'Premature BE exit rate',                    panel: true,  txt: true,  pdf: true },
  { id: 19, label: '24-hour hourly expectancy matrix',           panel: true,  txt: true,  pdf: true },
  { id: 20, label: 'Day-of-week performance table',              panel: true,  txt: true,  pdf: true },
  { id: 21, label: 'Session-rollover friction',                  panel: true,  txt: true,  pdf: true },
  { id: 22, label: 'Break-even variant comparison (A/B/C)',      panel: true,  txt: true,  pdf: true },
  { id: 23, label: 'Trail variant comparison',                   panel: false, txt: false, pdf: false },
  { id: 24, label: 'Position sizing comparison',                 panel: true,  txt: true,  pdf: true },
  { id: 25, label: 'Daily execution cap comparison',             panel: true,  txt: true,  pdf: true },
  { id: 26, label: 'ATR volatility tiering',                     panel: true,  txt: true,  pdf: true },
  { id: 27, label: '200 EMA alignment differential',             panel: true,  txt: true,  pdf: true },
  { id: 28, label: 'Confirmation type (close vs touch)',         panel: true,  txt: true,  pdf: true },
  { id: 29, label: 'News-window slippage profiling',             panel: true,  txt: true,  pdf: true },
  { id: 30, label: 'Portfolio correlation matrix',               panel: true,  txt: true,  pdf: true },
  { id: 31, label: 'Consecutive loss streak & recovery',         panel: true,  txt: true,  pdf: true },
  { id: 32, label: 'Circuit-breaker simulation',                 panel: true,  txt: true,  pdf: true },
  { id: 33, label: 'Daily max-drawdown cutoff simulation',       panel: true,  txt: true,  pdf: true },
  { id: 34, label: 'Slippage sensitivity curve',                 panel: true,  txt: true,  pdf: true },
  { id: 35, label: 'Parameter sensitivity sweep',                panel: true,  txt: true,  pdf: true },
  { id: 36, label: 'Outlier dependency removal',                 panel: true,  txt: true,  pdf: true },
  { id: 37, label: 'Bootstrap Monte Carlo resampling',           panel: true,  txt: true,  pdf: true },
  { id: 38, label: 'Buy-and-hold benchmark (alpha)',             panel: true,  txt: true,  pdf: true },
  { id: 39, label: 'Entry condition analysis (pooled, R:R 1:2.5, BE off)', panel: false, txt: true, pdf: false },
];

const DATA_DIR = (process.env.DATA_DIR || '').trim() || process.cwd();
if (!fs.existsSync(DATA_DIR)) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }

const BOT_CONFIG_FILE = path.join(DATA_DIR, 'bot_config.json');
const TRADES_DB_FILE = path.join(DATA_DIR, 'trades_db.json');
const CANDLES_CACHE_FILE = path.join(DATA_DIR, 'candles_cache.json');
const CLOSE_COMMAND_FILE = path.join(DATA_DIR, 'close_command.json');
const RISK_STATE_FILE = process.env.RISK_STATE_FILE || path.join(DATA_DIR, 'risk_state.json');
const storageBase = (process.env.BACKTEST_STORAGE_DIR || '').trim();
const BACKTEST_OUTPUT_DIR = storageBase ? path.join(storageBase, 'output') : path.join(process.cwd(), 'backtest', 'output');
const BACKTEST_DATA_DIR = storageBase ? path.join(storageBase, 'data') : path.join(process.cwd(), 'backtest', 'data');

const OPTIMIZER_STATUS_FILE = path.join(BACKTEST_DATA_DIR, 'optimizer_status.json');
const OPTIMIZER_SUMMARY_TXT = path.join(BACKTEST_OUTPUT_DIR, 'optimizer_summary.txt');
const OPTIMIZER_SUMMARY_JSON = path.join(BACKTEST_OUTPUT_DIR, 'optimizer_summary.json');

// -----------------------------------------------------------------------------
// STRATEGY RESEARCH state (existing mode, untouched)
// -----------------------------------------------------------------------------
let backtestRunning = false;
let backtestProgress = '';
let backtestLastError: string | null = null;
let backtestExitCode: number | null = null;
let activeBacktestProcesses: ChildProcess[] = [];
let backtestResults: Array<{ symbol: string; status: 'OK' | 'FAILED'; message: string; timing?: string; engine_line?: string; wrong_engine?: boolean }> = [];

let lastRunWallClockSeconds: number | null = null;
let lastRunConcurrentProcesses: number | null = null;
let lastRunStartingBalance: number | null = null;
let lastRunCurrency: string | null = null;
let lastRunProfile: string | null = null;

let compareRunning = false;
let compareProgress = '';
let compareSymbol = '';
let compareLastError: string | null = null;
let compareProcess: ChildProcess | null = null;

let optimizerRunning = false;
let optimizerProgress = '';
let optimizerLastError: string | null = null;
let optimizerProcess: ChildProcess | null = null;

// -----------------------------------------------------------------------------
// LIVE BOT REPLAY state (new mode)
// -----------------------------------------------------------------------------
let liveSimRunning = false;
let liveSimProgress = '';
let liveSimLastError: string | null = null;
let liveSimProcess: ChildProcess | null = null;
let liveSimLastParams: {
  symbols: string[];
  days: number;
  balance: number;
  currency: string;
  zarRate: number;
  profile: string;
} | null = null;

let activeBotConfig: BotGatewayConfig = {
  masterExecution: true, riskPerTradePct: 1.0, minRr: 3.0, adaptiveMode: false,
  stopOnDailyGoalReached: false, dailyGoalTarget: 5.0, weeklyGoalTarget: 20.0,
  monthlyGoalTarget: 50.0, weeklyDepositBaseline: 10.0, maxDailyTrades: 4,
  trailingStopActive: true, autoBreakevenPips: 15, currency: 'USD',
  updatedAt: new Date().toISOString(), version: 1,
  riskProfile: null,
};

let riskLimits: RiskLimitsConfig = {
  maxDailyLossUsd: 0.0, maxWeeklyLossUsd: 0.0, maxMonthlyLossUsd: 0.0,
  maxDailyDrawdownPct: 5.0, autoLiquidateAllOnTrip: false,
  breakerAction: 'HALT_PREVENT_NEW', useProfileDrawdownPct: true,
};

if (fs.existsSync(BOT_CONFIG_FILE)) {
  try {
    const content = fs.readFileSync(BOT_CONFIG_FILE, 'utf8').trim();
    if (content) {
      const saved = JSON.parse(content);
      activeBotConfig = { ...activeBotConfig, ...saved };
      if (saved.maxDailyLoss !== undefined || saved.maxDailyLossUsd !== undefined) riskLimits.maxDailyLossUsd = saved.maxDailyLoss ?? saved.maxDailyLossUsd;
      if (saved.maxWeeklyLoss !== undefined || saved.maxWeeklyLossUsd !== undefined) riskLimits.maxWeeklyLossUsd = saved.maxWeeklyLoss ?? saved.maxWeeklyLossUsd;
      if (saved.maxMonthlyLoss !== undefined || saved.maxMonthlyLossUsd !== undefined) riskLimits.maxMonthlyLossUsd = saved.maxMonthlyLoss ?? saved.maxMonthlyLossUsd;
      if (saved.useProfileDrawdownPct !== undefined) riskLimits.useProfileDrawdownPct = Boolean(saved.useProfileDrawdownPct);
    }
  } catch (e) { console.error('Failed to load bot_config.json:', e); }
}

let riskState: RiskState = {
  currentDailyLossUsd: 0, currentWeeklyLossUsd: 0, currentMonthlyLossUsd: 0,
  breakerTriggered: false, activeTripScope: 'NONE', lastTriggerReason: undefined,
};

function saveTradesToDisk(tradesList: any[]) {
  try {
    const tempPath = path.join(DATA_DIR, `.tmp_trades_${Date.now()}.json`);
    fs.writeFileSync(tempPath, JSON.stringify(tradesList, null, 2), 'utf8');
    fs.renameSync(tempPath, TRADES_DB_FILE);
  } catch (e) { console.error('Failed to save trades atomically:', e); }
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
  } catch {}
  return [];
}
function saveBotConfigAtomically(cfg: any) {
  try {
    const tempPath = path.join(DATA_DIR, `.tmp_bot_config_${Date.now()}.json`);
    fs.writeFileSync(tempPath, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tempPath, BOT_CONFIG_FILE);
  } catch (e) { console.error('Failed to write bot_config.json:', e); }
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
  } catch {}
}

let activeBrokerTelemetry: BrokerTelemetry = {
  connected: true, provider: 'Fusion Markets cTrader', accountNumber: '48868725',
  server: 'cTrader Open API', currency: 'USD', balance: 14.62, equity: 14.62,
  floatingPnL: 0.00, netProfit: 4.62, totalDeposits: 10.00, winRate: 75.0,
  totalTrades: 4, winningTrades: 3, losingTrades: 1, lastPingMs: 12,
  lastSyncTime: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
  openPositions: [], trades: [],
};

let botRestartTimestamps: number[] = [];
let botCrashLoopWarned = false;

function safeReadJson(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function holdoutVerdict(tune: any, val: any): string {
  const tCount = tune?.count ?? 0;
  const vCount = val?.count ?? 0;
  if (tCount < 30 || vCount < 30) return 'INCONCLUSIVE';
  const tPf = tune?.profit_factor ?? 0;
  const vPf = val?.profit_factor ?? 0;
  if (vPf < 0.95 || vPf < 0.70 * tPf) return 'FAILS';
  if (vPf < 1.10) return 'FLAT';
  return 'HOLDS';
}

function summariseNonDefaultSettings(): string[] {
  const out: string[] = [];
  try {
    const settingsPath = path.join(process.cwd(), 'config', 'pair_settings.json');
    if (!fs.existsSync(settingsPath)) return out;
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const pairs = raw?.pairs || {};
    const defaults: Record<string, any> = {
      enabled: true,
      session_window_sast: null,
      weekdays: null,
      min_stop_atr: 0.0,
      max_stop_atr: null,
      max_spread_in_r: null,
      rr: null,
      be_enabled: null,
      max_daily_trades: null,
    };
    for (const [pairName, block] of Object.entries<any>(pairs)) {
      const stratMap = block?.strategies || {};
      for (const [stratName, ss] of Object.entries<any>(stratMap)) {
        for (const key of Object.keys(defaults)) {
          const cur = ss?.[key];
          const def = defaults[key];
          if (JSON.stringify(cur) !== JSON.stringify(def)) {
            out.push(`${pairName}/${stratName}.${key} = ${JSON.stringify(cur)} (default ${JSON.stringify(def)})`);
          }
        }
      }
      if (block?.live_enabled === false) out.push(`${pairName}.live_enabled = false`);
      if (block?.risk_pct !== null && block?.risk_pct !== undefined) out.push(`${pairName}.risk_pct = ${block.risk_pct}`);
    }
  } catch {}
  return out;
}

function computeRuleBasedPairAdvice(pairPayload: any): Array<{ tag: string; text: string; impact: number; is_measured: boolean; type: string }> {
  const suggestions: any[] = [];
  const combos: any[] = pairPayload.combinations || [];
  const best = pairPayload.best_combination || {};
  const symbol = pairPayload.symbol;
  const totalTrades = best.total_trades || 0;

  const validCombos30 = combos.filter(c => (c.total_trades || 0) >= 30);
  if (validCombos30.length >= 4 && validCombos30.every(c => (c.profit_factor || 0) < 1.0)) {
    const totalLoss = validCombos30.reduce((acc, c) => acc + (c.net_pnl < 0 ? Math.abs(c.net_pnl) : 0), 0);
    const avgLoss = totalLoss / validCombos30.length;
    suggestions.push({
      tag: `[MEASURED $${avgLoss.toFixed(2)}]`,
      text: `Do not trade ${symbol} with current strategies. Average net loss: -$${avgLoss.toFixed(2)}.`,
      impact: Number(avgLoss.toFixed(2)), is_measured: true, type: 'PAIR_VIABILITY'
    });
  }
  combos.forEach((c: any) => {
    const tv = c.tune_validate || {};
    if (holdoutVerdict(tv.tune, tv.validate) === 'FAILS') {
      const loss = Math.abs((tv.validate?.net_pnl || 0));
      suggestions.push({
        tag: `[MEASURED $${loss.toFixed(2)}]`,
        text: `Combination '${c.label}' on ${symbol} FAILS hold-out.`,
        impact: Number(loss.toFixed(2)), is_measured: true, type: 'HOLD_OUT_FAIL'
      });
    }
  });
  if (totalTrades < 30) return suggestions;
  const stratKpis = best.strategy_kpis || {};
  Object.entries<any>(stratKpis).forEach(([sName, s]) => {
    if ((s.count || 0) >= 30 && (s.profit_factor || 0) < 1.0 && (s.net_pnl || 0) < 0) {
      suggestions.push({
        tag: `[MEASURED $${Math.abs(s.net_pnl).toFixed(2)}]`,
        text: `Disable or retune ${sName} on ${symbol}: PF ${(s.profit_factor || 0).toFixed(2)}, net -$${Math.abs(s.net_pnl).toFixed(2)}.`,
        impact: Number(Math.abs(s.net_pnl).toFixed(2)), is_measured: true, type: 'STRATEGY_RETUNE'
      });
    }
  });
  const dowKpis = best.dow_kpis || {};
  Object.entries<any>(dowKpis).forEach(([dow, d]) => {
    if ((d.count || 0) >= 30 && (d.net_pnl || 0) < 0) {
      suggestions.push({
        tag: `[MEASURED $${Math.abs(d.net_pnl).toFixed(2)}]`,
        text: `Avoid ${dow}s on ${symbol}: net -$${Math.abs(d.net_pnl).toFixed(2)}.`,
        impact: Number(Math.abs(d.net_pnl).toFixed(2)), is_measured: true, type: 'DAY_FILTER'
      });
    }
  });
  const beOffCombos = combos.filter(c => c.be === 'off' && (c.total_trades || 0) >= 30);
  const beOnCombos = combos.filter(c => c.be === 'on' && (c.total_trades || 0) >= 30);
  if (beOffCombos.length > 0 && beOnCombos.length > 0) {
    const bestBeOff = beOffCombos.reduce((b, curr) => curr.profit_factor > b.profit_factor ? curr : b, beOffCombos[0]);
    const bestBeOn = beOnCombos.reduce((b, curr) => curr.profit_factor > b.profit_factor ? curr : b, beOnCombos[0]);
    if (Math.abs((bestBeOn.profit_factor || 0) - (bestBeOff.profit_factor || 0)) >= 0.15) {
      const rec = (bestBeOn.profit_factor || 0) > (bestBeOff.profit_factor || 0) ? 'Breakeven On' : 'Breakeven Off';
      const diffPnl = Math.abs((bestBeOn.net_pnl || 0) - (bestBeOff.net_pnl || 0));
      suggestions.push({
        tag: `[MEASURED $${diffPnl.toFixed(2)}]`,
        text: `Recommend ${rec} for ${symbol}: $${diffPnl.toFixed(2)} P&L advantage.`,
        impact: Number(diffPnl.toFixed(2)), is_measured: true, type: 'BE_TUNING'
      });
    }
  }
  try {
    const wr = Number(best.win_rate || 0);
    const exp = Number(best.expectancy || 0);
    const w = Math.max(0.0, Math.min(100.0, wr)) / 100.0;
    const gapR = (w * 1.0) - ((1.0 - w) * 1.0) - exp;
    if (gapR > 0.07) {
      suggestions.push({
        tag: `[MEASURED ${gapR.toFixed(2)}R]`,
        text: `Estimated cost drag of ${gapR.toFixed(2)}R per trade on ${symbol}. Add a spread or minimum-stop filter.`,
        impact: 0.0, is_measured: true, type: 'COST_DRAG'
      });
    }
  } catch {}
  const bestTv = best.tune_validate || {};
  if (holdoutVerdict(bestTv.tune, bestTv.validate) === 'HOLDS' && totalTrades >= 30) {
    suggestions.push({
      tag: '[TEST NEEDED]',
      text: `Test target R:R 2.5 and 3.0 on ${symbol}: the best combination is HOLDS, so R:R expansion is worth testing.`,
      impact: 0.0, is_measured: false, type: 'RR_EXPANSION'
    });
  }
  const measured = suggestions.filter(s => s.is_measured);
  const testNeeded = suggestions.filter(s => !s.is_measured);
  measured.sort((a, b) => b.impact - a.impact);
  return [...measured, ...testNeeded];
}

function computePortfolioNextTests(all: Array<{ type: string }>): string[] {
  const tests: string[] = [];
  if (all.some(s => s.type === 'STRATEGY_RETUNE')) tests.push('Retest with underperforming setups disabled.');
  if (all.some(s => s.type === 'DAY_FILTER')) tests.push('Add a weekday blackout filter.');
  if (all.some(s => s.type === 'BE_TUNING')) tests.push('Lock in the better Breakeven policy per pair.');
  if (all.some(s => s.type === 'COST_DRAG')) tests.push('Add a spread or minimum-stop filter where cost drag exceeds 0.07R.');
  if (all.some(s => s.type === 'RR_EXPANSION')) tests.push('Test target R:R 2.5 and 3.0 on HOLDS pairs.');
  else tests.push('Run the Strategy Lab on the pairs with the highest PF.');
  return tests.slice(0, 5);
}

function generateExportDataPayload(): any {
  const result: any = {
    generated_at: new Date().toISOString(), days: 60, rr_values: [2.0, 2.5, 3.0],
    total_run_seconds: null,
    wall_clock_seconds: lastRunWallClockSeconds,
    concurrent_processes: lastRunConcurrentProcesses,
    starting_balance_input: lastRunStartingBalance,
    starting_balance_currency: lastRunCurrency,
    starting_balance_usd: null,
    profile_name: lastRunProfile,
    combinations_rollup: {}, pairs: [],
    portfolio_suggestions: [], what_to_test_next: [], portfolio_correlation: null,
    spec_coverage: SPEC_COVERAGE, descriptions: METRIC_DESCRIPTIONS,
    non_default_settings: summariseNonDefaultSettings(),
  };
  const allSummaryCombos: Record<string, { trades: number; pnl: number; win_count: number }> = {};
  let totalTime = 0.0; let hasValidTimes = false;
  const allPortfolioSuggestions: any[] = [];
  const portfolio = safeReadJson(path.resolve(BACKTEST_OUTPUT_DIR, 'portfolio_correlation.json'));
  if (portfolio) result.portfolio_correlation = portfolio;

  for (const sym of WHITELIST_ASSETS) {
    const summaryFile = path.resolve(BACKTEST_OUTPUT_DIR, `${sym}_summary.json`);
    if (!fs.existsSync(summaryFile)) {
      result.pairs.push({ symbol: sym, status: "NOT TESTED", error: "No backtest summary generated yet." });
      continue;
    }
    try {
      const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
      result.days = summary.days || result.days;
      if (summary.starting_balance_usd != null) result.starting_balance_usd = summary.starting_balance_usd;
      if (summary.profile_name) result.profile_name = summary.profile_name;
      if (summary.currency) result.starting_balance_currency = summary.currency;
      if (summary.starting_balance_input != null) result.starting_balance_input = summary.starting_balance_input;

      const pairSeconds = typeof summary.total_seconds === 'number' && summary.total_seconds > 0 ? summary.total_seconds : null;
      if (pairSeconds !== null) { totalTime += pairSeconds; hasValidTimes = true; }
      const combos: any[] = summary.combinations || [];
      combos.forEach(c => {
        const tv = c.tune_validate || {};
        c.holdout_verdict = holdoutVerdict(tv.tune, tv.validate);
        if (!allSummaryCombos[c.label]) allSummaryCombos[c.label] = { trades: 0, pnl: 0, win_count: 0 };
        allSummaryCombos[c.label].trades += c.total_trades || 0;
        allSummaryCombos[c.label].pnl += c.net_pnl || 0;
        allSummaryCombos[c.label].win_count += Math.round(((c.win_rate || 0) / 100) * (c.total_trades || 0));
      });
      let bestCombo: any = null;
      const qualifying = combos.filter(c => (c.total_trades || 0) >= 30);
      if (qualifying.length > 0) bestCombo = qualifying.reduce((b, curr) => curr.profit_factor > b.profit_factor ? curr : b, qualifying[0]);
      else if (combos.length > 0) bestCombo = combos.reduce((b, curr) => curr.total_trades > b.total_trades ? curr : b, combos[0]);
      let bestReportDetail: any = {};
      if (bestCombo && bestCombo.report_file) {
        const reportPath = path.resolve(BACKTEST_OUTPUT_DIR, bestCombo.report_file);
        if (fs.existsSync(reportPath)) bestReportDetail = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      }
      const labPayload = safeReadJson(path.resolve(BACKTEST_OUTPUT_DIR, `${sym}_lab.json`));
      const pairPayload: any = {
        symbol: sym, status: "OK", seconds_taken: pairSeconds,
        phase_seconds: summary.phase_seconds || null, cache: summary.cache || null,
        engine_line: summary.engine_line || null,
        wrong_engine: Boolean(summary.wrong_engine),
        engine_cache_hit: Boolean(summary.engine_cache_hit),
        precompute_s: typeof summary.precompute_s === 'number' ? summary.precompute_s : null,
        cache_built_at: summary.cache_built_at || null,
        cache_build_seconds: typeof summary.cache_build_seconds === 'number' ? summary.cache_build_seconds : null,
        starting_balance_usd: summary.starting_balance_usd ?? null,
        starting_balance_input: summary.starting_balance_input ?? null,
        starting_balance_currency: summary.currency ?? null,
        profile_name: summary.profile_name ?? null,
        generated_at: summary.generated_at || null,
        combinations: combos, lab: labPayload || null,
        best_combination: {
          ...(bestCombo || {}),
          strategy_kpis: bestReportDetail.strategy_kpis || {},
          dow_kpis: bestReportDetail.dow_kpis || {},
          skipped_summary: bestReportDetail.skipped_summary || {},
          skipped_detail: bestReportDetail.skipped_detail || null,
          warnings: bestReportDetail.warnings || [],
          adaptive_effective_pct: bestReportDetail.adaptive_effective_pct ?? 100,
          strategy_tune_validate: bestReportDetail.strategy_tune_validate || {},
          tune_validate: bestReportDetail.tune_validate || (bestCombo ? bestCombo.tune_validate : null) || {},
          diagnostics: bestReportDetail.diagnostics || null,
          improvement_tips: bestReportDetail.improvement_tips || [],
          all_trades: bestReportDetail.all_trades || [],
          run_settings: bestReportDetail.run_settings || '',
        }
      };
      const suggestions = computeRuleBasedPairAdvice(pairPayload);
      pairPayload.best_combination.rule_suggestions = suggestions;
      allPortfolioSuggestions.push(...suggestions);
      result.pairs.push(pairPayload);
    } catch (e: any) {
      result.pairs.push({ symbol: sym, status: "NOT TESTED", error: e.message });
    }
  }
  const measuredPort = allPortfolioSuggestions.filter(s => s.is_measured);
  const testNeededPort = allPortfolioSuggestions.filter(s => !s.is_measured);
  measuredPort.sort((a, b) => b.impact - a.impact);
  result.portfolio_suggestions = [...measuredPort, ...testNeededPort].slice(0, 10);
  result.what_to_test_next = computePortfolioNextTests(allPortfolioSuggestions);
  result.total_run_seconds = hasValidTimes ? Number(totalTime.toFixed(1)) : null;
  const rollup: Record<string, any> = {};
  Object.entries(allSummaryCombos).forEach(([label, s]) => {
    rollup[label] = {
      total_trades: s.trades, total_pnl: Number(s.pnl.toFixed(2)),
      weighted_win_rate: s.trades > 0 ? Number(((s.win_count / s.trades) * 100).toFixed(1)) : 0
    };
  });
  result.combinations_rollup = rollup;
  result.total_ledger_rows = (result.pairs || []).reduce(
    (acc: number, p: any) => acc + (Array.isArray(p?.best_combination?.all_trades) ? p.best_combination.all_trades.length : 0),
    0
  );
  return result;
}

function fmt(v: any, decimals = 2): string {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return 'n/a';
  return n.toFixed(decimals);
}

function csvEscape(v: any): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function renderSummaryCsv(pairs: any[]): string {
  const cols = [
    'pair','combo','trades','win_rate','avg_r','expectancy','profit_factor',
    'max_dd_money','net_pnl','tune_trades','tune_pf','validate_trades','validate_pf','verdict'
  ];
  const out: string[] = [cols.join(',')];
  for (const p of pairs) {
    if (p.status !== 'OK') continue;
    for (const c of (p.combinations || [])) {
      const tv = c.tune_validate || {};
      const t = tv.tune || {};
      const v = tv.validate || {};
      out.push([
        p.symbol,
        c.label || '',
        c.total_trades ?? 0,
        c.win_rate ?? 0,
        c.avg_r ?? c.expectancy ?? 0,
        c.expectancy ?? 0,
        c.profit_factor ?? 0,
        c.max_drawdown ?? 0,
        c.net_pnl ?? 0,
        t.count ?? 0,
        t.profit_factor ?? 0,
        v.count ?? 0,
        v.profit_factor ?? 0,
        c.holdout_verdict || 'INCONCLUSIVE',
      ].map(csvEscape).join(','));
    }
  }
  return out.join('\n');
}

function renderSampleCsv(pairs: any[], samplePerPair: number = SAMPLE_TRADES_PER_PAIR): string {
  const cols = [
    'pair','strategy','dir','entry_sast','exit_reason','r','pnl',
    'mfe_r','mae_r','regime','hour_sast','duration_min'
  ];
  const out: string[] = [cols.join(',')];
  for (const p of pairs) {
    if (p.status !== 'OK') continue;
    const b = p.best_combination || {};
    const trades: any[] = Array.isArray(b.all_trades) ? b.all_trades : [];
    if (trades.length === 0) continue;

    const sorted = [...trades].sort((a, b) =>
      String(a?.signal_time_utc || '').localeCompare(String(b?.signal_time_utc || ''))
    );

    let picked: any[] = [];
    if (samplePerPair <= 0 || trades.length <= samplePerPair) {
      picked = sorted;
    } else {
      const third = Math.max(1, Math.floor(samplePerPair / 3));
      const byR = [...sorted].sort((a, b) => (b.r_multiple || 0) - (a.r_multiple || 0));
      const topWins = byR.slice(0, third);
      const topLosses = byR.slice(-third).reverse();
      const spreadCount = samplePerPair - topWins.length - topLosses.length;
      const step = Math.max(1, Math.floor(sorted.length / Math.max(1, spreadCount)));
      const spread: any[] = [];
      for (let i = 0; i < sorted.length && spread.length < spreadCount; i += step) {
        spread.push(sorted[i]);
      }
      const seen = new Set<string>();
      for (const t of [...topWins, ...topLosses, ...spread]) {
        const key = String(t?.trade_id || `${t?.symbol}_${t?.signal_time_utc}_${t?.strategy}`);
        if (seen.has(key)) continue;
        seen.add(key);
        picked.push(t);
      }
      picked.sort((a, b) => String(a?.signal_time_utc || '').localeCompare(String(b?.signal_time_utc || '')));
    }

    for (const t of picked) {
      out.push([
        p.symbol,
        t.strategy || '',
        t.direction || '',
        (t.signal_time_sast || '').slice(0, 16),
        t.exit_reason || '',
        t.r_multiple ?? '',
        t.money_pnl ?? '',
        t.mfe_r ?? '',
        t.mae_r ?? '',
        t.regime || '',
        t.hour_sast ?? '',
        t.duration_minutes ?? '',
      ].map(csvEscape).join(','));
    }
  }
  return out.join('\n');
}

function renderLedgerCsv(pairs: any[]): string {
  const cols = [
    'pair','combination','ticket','entry_time_sast','exit_time_sast','strategy','direction','lots',
    'entry','sl','tp','exit_price','exit_reason','pnl_usd','pnl_r','duration_minutes',
    'htf_d1','htf_h4','ema200_dist_atr','ema_spread_atr','eff_ratio_30','atr_pctile','adr_used',
    'session','mins_since_open','room_atr','stop_atr','spread_r','trade_of_day','hour_sast','weekday','setup_tag',
    'result','mfe_r','mae_r','failure_reason','alignment_200ema','confirmation_type','is_in_news_window',
  ];
  const out: string[] = [cols.join(',')];
  for (const p of pairs) {
    if (p.status !== 'OK') continue;
    const b = p.best_combination || {};
    const trades: any[] = Array.isArray(b.all_trades) ? b.all_trades : [];
    const comboLabel = b.label || '';
    for (const t of trades) {
      const row = [
        p.symbol, comboLabel,
        t.trade_id || '', t.signal_time_sast || '', t.exit_time || '',
        t.strategy || '', t.direction || '', t.lots ?? '',
        t.entry_price ?? '', t.sl ?? '', t.tp ?? '',
        t.exit_price ?? '', t.exit_reason || '',
        t.money_pnl ?? '', t.r_multiple ?? '', t.duration_minutes ?? '',
        t.htf_d1 ?? '', t.htf_h4 ?? '', t.ema200_dist_atr ?? '',
        t.ema_spread_atr ?? '', t.eff_ratio_30 ?? '', t.atr_pctile ?? '',
        t.adr_used ?? '', t.session ?? '', t.mins_since_open ?? '',
        t.room_atr ?? '', t.stop_atr ?? '', t.spread_r ?? '',
        t.trade_of_day ?? '', t.hour_sast ?? '', t.weekday ?? '',
        t.setup_tag || '', t.result || '', t.mfe_r ?? '',
        t.mae_r ?? '', t.failure_reason || '',
        t.alignment_200ema || '', t.confirmation_type || '',
        t.is_in_news_window ?? '',
      ];
      out.push(row.map(csvEscape).join(','));
    }
  }
  return out.join('\n');
}

function humaniseBucketLabel(feature: string, bucket: string): string {
  if (feature === 'hour_sast' && bucket.startsWith('=')) {
    const n = parseInt(bucket.slice(1), 10);
    if (Number.isFinite(n) && n >= 0 && n <= 7) {
      const startH = n * 3;
      const endH = startH + 2;
      const pad = (h: number) => String(h).padStart(2, '0');
      return `${pad(startH)}:00-${pad(endH)}:59 SAST`;
    }
  }
  if (feature === 'mins_since_open' && bucket.startsWith('=')) {
    const n = parseInt(bucket.slice(1), 10);
    if (Number.isFinite(n) && n >= 0) return `${n}h-${n + 1}h after open`;
  }
  return bucket;
}

function renderToc(pairs: any[], hasOptimizer: boolean): string[] {
  const out: string[] = [];
  out.push('TABLE OF CONTENTS');
  out.push('  1. Legend');
  out.push('  2. Active settings differing from default');
  out.push('  3. Cross-pair rollup');
  out.push('  4. Per-pair sections:');
  for (const p of pairs) {
    out.push(`       ${p.symbol} — Summary, Six Combinations, Per-Strategy, Per-Weekday, Skipped, Ledger Summary, Diagnostics, Tips, Strategy Lab`);
  }
  out.push('  5. Portfolio correlation (full matrix)');
  out.push('  6. Ranked portfolio suggestions');
  out.push('  7. What to test next');
  out.push('  8. Entry condition analysis');
  out.push(`  9. Optimizer summary${hasOptimizer ? '' : ' (not generated)'}`);
  out.push(' 10. Not implemented');
  out.push('');
  out.push('COMPANION CSVs IN THIS ZIP:');
  out.push('  backtest_summary.csv  — one row per (pair x combo). Read this first.');
  out.push('  backtest_sample.csv   — 30 stratified trades per pair, 12 columns. Use for pattern spotting.');
  out.push('');
  return out;
}

function renderWeekdayTable(dowKpis: any): string[] {
  const out: string[] = [];
  if (!dowKpis || Object.keys(dowKpis).length === 0) {
    out.push('  (no weekday data)');
    return out;
  }
  out.push('  Weekday     | Trades | WR%   | PF    | PNL$');
  for (const [dow, k] of Object.entries<any>(dowKpis)) {
    const inc = (k.count < 30) ? '  [INCONCLUSIVE <30]' : '';
    out.push(`  ${dow.padEnd(11)} | ${String(k.count ?? 0).padStart(6)} | ${fmt(k.win_rate, 1).padStart(5)} | ${fmt(k.profit_factor).padStart(5)} | ${fmt(k.net_pnl).padStart(8)}${inc}`);
  }
  return out;
}

function renderLedgerSummary(trades: any[]): string[] {
  const out: string[] = [];
  if (!Array.isArray(trades) || trades.length === 0) {
    out.push('  (no trades)');
    return out;
  }
  const n = trades.length;
  const wins = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');
  const bes = trades.filter(t => t.result === 'BREAKEVEN');
  const avgWinR = wins.length > 0 ? wins.reduce((s, t) => s + (t.r_multiple || 0), 0) / wins.length : 0;
  const avgLossR = losses.length > 0 ? losses.reduce((s, t) => s + (t.r_multiple || 0), 0) / losses.length : 0;
  const totalR = trades.reduce((s, t) => s + (t.r_multiple || 0), 0);
  const totalPnl = trades.reduce((s, t) => s + (t.money_pnl || 0), 0);
  const avgWinUsd = wins.length > 0 ? wins.reduce((s, t) => s + (t.money_pnl || 0), 0) / wins.length : 0;
  const avgLossUsd = losses.length > 0 ? losses.reduce((s, t) => s + (t.money_pnl || 0), 0) / losses.length : 0;

  const ordered = [...trades].sort((a, b) => String(a.signal_time_utc || '').localeCompare(String(b.signal_time_utc || '')));
  let maxWinStreak = 0, maxLossStreak = 0, curW = 0, curL = 0;
  for (const t of ordered) {
    if (t.result === 'WIN') { curW++; curL = 0; if (curW > maxWinStreak) maxWinStreak = curW; }
    else if (t.result === 'LOSS') { curL++; curW = 0; if (curL > maxLossStreak) maxLossStreak = curL; }
  }

  out.push(`  Total trades: ${n}  |  Wins ${wins.length}  |  Losses ${losses.length}  |  BE ${bes.length}`);
  out.push(`  Avg win: ${fmt(avgWinR, 3)}R ($${fmt(avgWinUsd, 2)})  |  Avg loss: ${fmt(avgLossR, 3)}R ($${fmt(avgLossUsd, 2)})`);
  out.push(`  Total R: ${fmt(totalR, 2)}  |  Total PnL: $${fmt(totalPnl, 2)}`);
  out.push(`  Longest win streak: ${maxWinStreak}  |  Longest loss streak: ${maxLossStreak}`);

  const header = '  date_sast    symb   strat                              dir   entry       exit        R       PnL$    reason';
  const rowLine = (t: any) => `  ${String(t.date_sast || '').padEnd(12)} ${String(t.symbol || '').padEnd(6)} ${String(t.strategy || '').padEnd(34).slice(0,34)} ${String(t.direction || '').padEnd(4)}  ${fmt(t.entry_price, 5).padStart(11)} ${fmt(t.exit_price, 5).padStart(11)} ${fmt(t.r_multiple, 2).padStart(6)} ${fmt(t.money_pnl, 2).padStart(8)} ${String(t.exit_reason || '').slice(0, 22)}`;

  const byPnl = [...trades].sort((a, b) => (b.money_pnl || 0) - (a.money_pnl || 0));
  const top10 = byPnl.slice(0, 10);
  const worst10 = byPnl.slice(-10).reverse();

  out.push('');
  out.push('  Top 10 wins:');
  out.push(header);
  for (const t of top10) out.push(rowLine(t));

  out.push('');
  out.push('  Top 10 losses:');
  out.push(header);
  for (const t of worst10) out.push(rowLine(t));

  out.push('');
  out.push('  (Full sample of trades lives in backtest_sample.csv, not in this TXT.)');

  return out;
}

function renderAllDiagnostics(diag: any): string[] {
  const out: string[] = [];
  if (!diag) {
    out.push('  (no diagnostics in this report)');
    return out;
  }
  const kpiLine = (k: any): string => (!k ? 'n/a' : `TR ${k.count ?? 0} WR ${fmt(k.win_rate, 1)}% PF ${fmt(k.profit_factor)} $${fmt(k.net_pnl)}`);

  if (diag.post_sl) out.push(`§16 Post-SL continuation: n=${diag.post_sl.count} mean ${fmt(diag.post_sl.mean_pips, 1)} pips | median ${fmt(diag.post_sl.median_pips, 1)} | max ${fmt(diag.post_sl.max_pips, 1)} | mean_R ${fmt(diag.post_sl.mean_r, 2)} | recovered_to_TP ${diag.post_sl.recovered_count} (${fmt(diag.post_sl.recovered_pct, 1)}%)`);
  if (diag.post_tp) out.push(`§17 Post-TP extra: n=${diag.post_tp.count} mean ${fmt(diag.post_tp.mean_pips, 1)} pips | median ${fmt(diag.post_tp.median_pips, 1)} | max ${fmt(diag.post_tp.max_pips, 1)} | mean_R ${fmt(diag.post_tp.mean_r, 2)} | avg_missed_R ${fmt(diag.post_tp.avg_missed_r, 2)}`);
  if (diag.premature_be) out.push(`§18 Premature BE: moved ${diag.premature_be.total_be_moved} | premature ${diag.premature_be.premature_count} (${fmt(diag.premature_be.premature_pct, 1)}%) | total_missed_R ${fmt(diag.premature_be.total_missed_r, 2)} | avg_missed_R ${fmt(diag.premature_be.avg_missed_r, 2)}`);

  if (diag.hour_kpis) {
    out.push('§19 Hour matrix (SAST, one line per hour with trades):');
    for (let h = 0; h < 24; h++) {
      const k = diag.hour_kpis[String(h)];
      if (!k || k.count === 0) continue;
      out.push(`    ${String(h).padStart(2, '0')}: ${kpiLine(k)} exp ${fmt(k.expectancy, 3)}R`);
    }
  }
  if (diag.session_rollover) out.push(`§21 Session rollover: in_transition ${kpiLine(diag.session_rollover.in_transition)} | out_of_transition ${kpiLine(diag.session_rollover.out_of_transition)}`);
  if (diag.breakeven_variants) {
    const bv = diag.breakeven_variants;
    out.push(`§22 BE variants: A_current ${fmt(bv.A_current?.total_r, 2)}R (n=${bv.A_current?.count ?? 0}) | B_no_BE ${fmt(bv.B_no_be?.total_r, 2)}R (n=${bv.B_no_be?.count ?? 0}) | C_delayed ${fmt(bv.C_delayed_be?.total_r, 2)}R (n=${bv.C_delayed_be?.count ?? 0}) | best ${bv.best_variant} | ${bv.verdict}`);
  }
  if (diag.sizing_comparison) {
    const s = diag.sizing_comparison;
    out.push(`§24 Sizing: fixed net $${fmt(s.fixed?.net_pnl)} (final eq $${fmt(s.fixed?.final_equity)}) | compounding $${fmt(s.compounding?.net_pnl)} (final eq $${fmt(s.compounding?.final_equity)}) | diff $${fmt(s.difference)}`);
  }
  if (diag.daily_cap_comparison) {
    out.push('§25 Daily cap comparison:');
    for (const [k, v] of Object.entries<any>(diag.daily_cap_comparison)) out.push(`    ${k}: ${kpiLine(v)}`);
  }
  if (diag.atr_tier_kpis) {
    out.push('§26 ATR tiers:');
    for (const tier of ['LOW', 'NORMAL', 'HIGH', 'UNKNOWN']) {
      const k = diag.atr_tier_kpis[tier];
      if (!k || k.count === 0) continue;
      out.push(`    ${tier}: ${kpiLine(k)}`);
    }
  }
  if (diag.ema_200_alignment) out.push(`§27 EMA-200 alignment: aligned ${kpiLine(diag.ema_200_alignment.aligned)} | counter_trend ${kpiLine(diag.ema_200_alignment.counter_trend)} | unknown ${kpiLine(diag.ema_200_alignment.unknown)}`);
  if (diag.confirmation_type) out.push(`§28 Confirmation: close ${kpiLine(diag.confirmation_type.close)} | touch ${kpiLine(diag.confirmation_type.touch)}`);
  if (diag.news_window) out.push(`§29 News window: in_news ${kpiLine(diag.news_window.in_news)} | out_of_news ${kpiLine(diag.news_window.out_of_news)}`);
  if (diag.streak_analysis) {
    const s = diag.streak_analysis;
    out.push(`§31 Streaks: max ${s.max_consecutive_losses ?? 0} | avg ${fmt(s.average_streak, 2)} | streak count ${s.streak_count ?? 0} | recovery trades ${s.recovery_trades_from_peak_dd ?? 0} | peak DD -$${fmt(s.peak_drawdown)}`);
  }
  if (diag.circuit_breaker_sim) {
    const c = diag.circuit_breaker_sim;
    out.push(`§32 Breaker sim: orig $${fmt(c.original_net_pnl)} -> sim $${fmt(c.simulated_net_pnl)} | trades halved ${c.trades_halved ?? 0} | protection $${fmt(c.protection_delta)}`);
  }
  if (diag.daily_dd_cutoff) {
    const d = diag.daily_dd_cutoff;
    out.push(`§33 Daily DD cutoff: cutoff ${fmt(d.cutoff_pct, 1)}% | days triggered ${d.days_triggered} | trades blocked ${d.trades_blocked} | orig $${fmt(d.original_net_pnl)} -> cutoff $${fmt(d.cutoff_net_pnl)} | protection $${fmt(d.protection_delta)}`);
  }
  if (diag.slippage_sensitivity) {
    const parts: string[] = [];
    for (const [, pt] of Object.entries<any>(diag.slippage_sensitivity)) {
      parts.push(`${pt.slippage_pips}p: $${fmt(pt.net_pnl)} (WR ${fmt(pt.win_rate, 1)}%, cost ${fmt(pt.per_trade_cost_r, 3)}R)`);
    }
    out.push(`§34 Slippage: ${parts.join(' | ')}`);
  }
  if (diag.parameter_sensitivity && Array.isArray(diag.parameter_sensitivity.sweep) && diag.parameter_sensitivity.sweep.length > 0) {
    const p = diag.parameter_sensitivity;
    const parts = p.sweep.map((r: any) => `R:R ${fmt(r.rr, 2)}: $${fmt(r.net_pnl)} (n=${r.count})`);
    out.push(`§35 Parameter sweep: ${parts.join(' | ')} | best R:R ${fmt(p.best_rr, 2)} | ${p.verdict}`);
  }
  if (diag.outlier_removal) {
    const o = diag.outlier_removal;
    out.push(`§36 Outliers removed: ${o.outlier_count ?? 0} | full ${kpiLine(o.full)} | trimmed ${kpiLine(o.trimmed)} | impact ${fmt(o.impact_pct, 1)}%`);
  }
  if (diag.monte_carlo) {
    const m = diag.monte_carlo;
    out.push(`§37 Bootstrap MC: iterations ${m.iterations} | median final $${fmt(m.median_final_pnl)} (P5 $${fmt(m.p5_final_pnl)}, P95 $${fmt(m.p95_final_pnl)}) | median DD -$${fmt(m.median_max_dd)} (P5 -$${fmt(m.p5_max_dd)}, P95 -$${fmt(m.p95_max_dd)}) | median final eq $${fmt(m.median_final_equity)} | prob positive ${fmt(m.prob_positive, 1)}%`);
  }
  if (diag.buy_and_hold) {
    const b = diag.buy_and_hold;
    out.push(`§38 Alpha: first close ${fmt(b.first_close, 5)} | last close ${fmt(b.last_close, 5)} | hold return ${fmt(b.bh_return_pct, 2)}% ($ ${fmt(b.bh_net_pnl)}) | strategy $${fmt(b.strategy_net_pnl)} | alpha $${fmt(b.alpha)} | verdict ${b.verdict}`);
  }
  return out;
}

function renderPortfolioMatrix(pc: any): string[] {
  const out: string[] = [];
  if (!pc || !Array.isArray(pc.symbols) || pc.symbols.length === 0) {
    out.push('  (portfolio correlation matrix unavailable)');
    return out;
  }
  const syms: string[] = pc.symbols;
  const corr: Record<string, Record<string, number>> = pc.correlation_matrix || {};
  out.push('  ' + ['Symbol   ', ...syms.map(s => s.padStart(7))].join(' '));
  for (const row of syms) {
    const cells = syms.map(col => {
      const v = corr?.[row]?.[col];
      return (typeof v === 'number' ? v : 0).toFixed(2).padStart(7);
    });
    out.push(`  ${row.padEnd(9)}${cells.join(' ')}`);
  }
  out.push('');
  out.push(`  Portfolio max DD $${fmt(pc.portfolio_drawdown)} | Sum of individual DDs $${fmt(pc.sum_of_individual_drawdowns)} | Diversification ${fmt(pc.diversification_ratio, 2)}x | Avg daily corr ${fmt(pc.avg_daily_correlation, 3)} | Days ${pc.days}`);
  return out;
}

function renderCostTable(): string[] {
  const out: string[] = [];
  out.push('COST ASSUMPTIONS (from ASSETS in backtest/simulator.py and engine/matrix.py)');
  out.push('  Symbol    | pip_size | contract_size | spread');
  const rows: Array<[string, number, number, number]> = [
    ['GOLD',     0.01,    100.0,     0.30],
    ['US30',     1.0,     1.0,       2.50],
    ['NAS100',   0.1,     1.0,       1.50],
    ['GERMAN30', 0.1,     1.0,       1.80],
    ['EURUSD',   0.0001,  100000.0,  0.00010],
    ['USDJPY',   0.01,    100000.0,  0.012],
    ['GBPUSD',   0.0001,  100000.0,  0.00014],
  ];
  for (const [sym, pip, cs, spr] of rows) {
    out.push(`  ${sym.padEnd(10)}| ${String(pip).padEnd(9)}| ${String(cs).padEnd(14)}| ${spr}`);
  }
  out.push('  (These are used identically by the backtest and the live bot. Update in one place.)');
  return out;
}

function renderConsistencyChecks(pairs: any[]): string[] {
  const out: string[] = [];
  out.push('CONSISTENCY CHECKS');
  for (const p of pairs) {
    if (p.status !== 'OK') continue;
    const lines: string[] = [];
    if (p.wrong_engine) lines.push('WRONG ENGINE — combos run do not match the six-combination spec');
    if (p.engine_line) lines.push(p.engine_line);
    if (p.precompute_s != null) lines.push(`precompute this run: ${p.precompute_s}s`);
    if (p.cache_built_at && p.cache_build_seconds != null) lines.push(`cache built in ${Math.round(p.cache_build_seconds)}s on ${String(p.cache_built_at).slice(0,10)}`);
    if (p.starting_balance_usd != null) lines.push(`starting balance: $${p.starting_balance_usd} USD (input ${p.starting_balance_input ?? '?'} ${p.starting_balance_currency ?? ''})`);
    if (p.profile_name) lines.push(`profile: ${p.profile_name}`);
    if (lines.length === 0) continue;
    out.push(`  ${p.symbol}:`);
    for (const l of lines) out.push(`    ${l}`);
  }
  return out;
}

function renderEntryConditionAnalysis(): string[] {
  const analysisFile = path.resolve(BACKTEST_OUTPUT_DIR, 'entry_analysis.json');
  const header = 'ENTRY CONDITION ANALYSIS (pooled, R:R 1:2.5, BE off)';
  if (!fs.existsSync(analysisFile)) return [header, '  n/a - rerun to generate'];
  let payload: any;
  try { payload = JSON.parse(fs.readFileSync(analysisFile, 'utf8')); }
  catch { return [header, '  n/a - rerun to generate']; }

  const baselines: any[] = Array.isArray(payload.baselines) ? payload.baselines : [];
  const buckets: any[] = Array.isArray(payload.buckets) ? payload.buckets : [];
  const starPairs: any[] = Array.isArray(payload.star_pair_breakdown) ? payload.star_pair_breakdown : [];
  const totalBucketsTested: number = typeof payload.total_buckets_tested === 'number' ? payload.total_buckets_tested : buckets.length;
  const starBucketsCount: number = typeof payload.star_buckets_count === 'number'
    ? payload.star_buckets_count
    : buckets.filter((b: any) => b.is_star).length;
  const SECTION_CAP = 8000;
  const fmtR = (v: any): string => (v === null || v === undefined) ? 'n/a' : fmt(v, 2);

  const formatBucketLine = (b: any): string => {
    const star = b.is_star ? '*' : ' ';
    const label = humaniseBucketLabel(b.feature, String(b.bucket || ''));
    return `${star}[${b.group}] ${b.feature} ${label}: n=${b.trades} wr=${fmt(b.win_rate, 1)} pf=${fmt(b.profit_factor_1r)} q>1=${b.quarters_above_1 ?? 0}/4`;
  };

  const buildSection = (includeStarPairs: boolean, restrictBuckets: boolean): string[] => {
    const out: string[] = [];
    out.push(header);
    out.push(`Pooled: ${payload.total_trades ?? 0} trades | Window: ${payload.window_start ?? 'n/a'} to ${payload.window_end ?? 'n/a'}`);
    out.push(`Buckets tested: ${totalBucketsTested} | Starred: ${starBucketsCount}`);
    if (baselines.length > 0) {
      out.push('Baselines:');
      for (const b of baselines) out.push(`  [${b.group}] n=${b.trades} wr=${fmt(b.win_rate, 1)} pf=${fmt(b.profit_factor)} pf@1R=${fmt(b.profit_factor_1r)} q>1=${b.quarters_above_1 ?? 0}/4`);
    }
    if (buckets.length === 0) { out.push('  (no buckets meet the minimum trade count)'); return out; }
    let rows: any[] = buckets;
    let truncatedNote = '';
    if (restrictBuckets) {
      const stars = buckets.filter(b => b.is_star);
      const nonStars = buckets.filter(b => !b.is_star);
      const byGroup: Record<string, any[]> = {};
      for (const b of nonStars) {
        const g = b.group || 'ALL';
        if (!byGroup[g]) byGroup[g] = [];
        byGroup[g].push(b);
      }
      const keepNon: any[] = [];
      for (const g of Object.keys(byGroup)) {
        const base = baselines.find(x => x.group === g);
        const bpf = base ? (base.profit_factor_1r ?? 0) : 0;
        const sorted = [...byGroup[g]].sort((a, b) =>
          Math.abs((b.profit_factor_1r ?? 0) - bpf) - Math.abs((a.profit_factor_1r ?? 0) - bpf));
        keepNon.push(...sorted.slice(0, 3));
      }
      rows = [...stars, ...keepNon];
      rows.sort((a, b) => a.is_star !== b.is_star ? (a.is_star ? -1 : 1) : (b.profit_factor_1r ?? 0) - (a.profit_factor_1r ?? 0));
      const omitted = buckets.length - rows.length;
      if (omitted > 0) truncatedNote = `  (truncated to fit the ${SECTION_CAP}-char budget: ${omitted} bucket rows omitted)`;
    }
    out.push('Buckets:');
    for (const r of rows) out.push(formatBucketLine(r));
    if (truncatedNote) out.push(truncatedNote);
    if (includeStarPairs && starPairs.length > 0) {
      out.push('');
      out.push('Star bucket cross-pair check:');
      for (const sp of starPairs.slice(0, 20)) {
        const pp: Record<string, any> = sp.per_pair || {};
        const parts: string[] = [];
        for (const sym of Object.keys(pp)) {
          const row = pp[sym];
          if (!row || !row.trades) continue;
          parts.push(`${sym} n=${row.trades} pf=${fmt(row.profit_factor_1r)} q=${row.quarters_above_1 ?? 0}/4`);
        }
        out.push(`  [${sp.group}] ${sp.feature} ${sp.bucket} (pooled n=${sp.pooled?.trades ?? 0}) -> ${parts.join(' | ')}`);
      }
    }
    return out;
  };

  let section = buildSection(true, false);
  if (section.join('\n').length <= SECTION_CAP) return section;
  section = buildSection(true, true);
  if (section.join('\n').length <= SECTION_CAP) return section;
  return buildSection(false, true);
}

function renderTxtContent(data: any): string {
  const totalTimeStr = (typeof data.total_run_seconds === 'number' && data.total_run_seconds > 0) ? `${data.total_run_seconds}s` : 'n/a';
  const wallSeconds = (typeof data.wall_clock_seconds === 'number' && data.wall_clock_seconds > 0) ? data.wall_clock_seconds : null;
  const wallStr = wallSeconds !== null ? `${wallSeconds}s` : 'n/a';
  const concurrentStr = (typeof data.concurrent_processes === 'number' && data.concurrent_processes > 0) ? data.concurrent_processes : 'n/a';

  const lines: string[] = [];
  const okPairs = (data.pairs || []).filter((p: any) => p.status === 'OK');
  let bestCombo: any = null;
  for (const p of okPairs) for (const c of (p.combinations || [])) {
    if ((c.total_trades || 0) < 30) continue;
    if (!bestCombo || c.profit_factor > bestCombo.pf) bestCombo = { symbol: p.symbol, label: c.label, pf: c.profit_factor, net: c.net_pnl, trades: c.total_trades, verdict: c.holdout_verdict };
  }

  const hasOptimizer = fs.existsSync(OPTIMIZER_SUMMARY_TXT) || fs.existsSync(OPTIMIZER_SUMMARY_JSON);

  lines.push('AI BRIEF');
  if (bestCombo) lines.push(`Best: ${bestCombo.symbol} ${bestCombo.label} — PF ${fmt(bestCombo.pf)}, P&L $${fmt(bestCombo.net)}, ${bestCombo.trades} trades, ${bestCombo.verdict}.`);
  lines.push('Companion CSVs in this ZIP:');
  lines.push('  backtest_summary.csv  — one row per (pair x combo). Read this first.');
  lines.push('  backtest_sample.csv   — 30 stratified trades per pair, 12 columns. Use for pattern spotting.');

  const wrongEnginePairs = (data.pairs || []).filter((p: any) => p.wrong_engine);
  if (wrongEnginePairs.length > 0) {
    lines.push(`WARN: WRONG ENGINE on: ${wrongEnginePairs.map((p: any) => p.symbol).join(', ')} — results unreliable.`);
  }
  lines.push('');

  lines.push(...renderToc(data.pairs || [], hasOptimizer));

  lines.push('LEGEND');
  lines.push('  Six combinations: Adaptive only, BE off/on, R:R 1:2 / 1:2.5 / 1:3.');
  lines.push('  Ledger Summary shows streaks and the 10 best and 10 worst trades. The rest of the sample is in backtest_sample.csv.');
  lines.push('  Diagnostics sections use §N labels that match the Blueprint.');
  lines.push('  Any bucket or row with fewer than 30 trades is tagged INCONCLUSIVE.');
  lines.push(`RUN: ${data.generated_at.slice(0, 10)} | Days ${data.days} | Wall clock ${wallStr} (${concurrentStr} concurrent) | Sum of this-run pair times ${totalTimeStr}`);
  if (data.starting_balance_input != null) {
    lines.push(`STARTING BALANCE: ${data.starting_balance_input} ${data.starting_balance_currency || 'USD'} (USD-equivalent $${fmt(data.starting_balance_usd, 2)}) | Profile: ${data.profile_name || 'None'}`);
  }
  lines.push('');

  lines.push('ACTIVE SETTINGS DIFFERING FROM DEFAULT:');
  const nonDefault: string[] = Array.isArray(data.non_default_settings) ? data.non_default_settings : [];
  if (nonDefault.length === 0) lines.push('  (none — all pairs and strategies use schema defaults)');
  else for (const row of nonDefault) lines.push(`  ${row}`);
  lines.push('');

  lines.push('CROSS-PAIR ROLLUP');
  Object.entries(data.combinations_rollup || {}).forEach(([combo, r]: any) => {
    lines.push(`  ${combo.padEnd(32)} | TR ${String(r.total_trades).padStart(5)} | WR ${fmt(r.weighted_win_rate, 1)}% | PNL $${fmt(r.total_pnl)}`);
  });
  lines.push('');

  const nowMs = Date.now();
  for (const p of data.pairs || []) {
    if (p.status !== 'OK') { lines.push(`ASSET ${p.symbol} — NOT TESTED: ${p.error || 'unknown error'}`); lines.push(''); continue; }
    const ps = p.phase_seconds || {};
    const thisRunStr = p.seconds_taken != null ? `${p.seconds_taken}s` : 'n/a';
    const thisRunPrecompute = (typeof p.precompute_s === 'number') ? p.precompute_s : null;
    const cacheBuiltStr = (p.cache_built_at && typeof p.cache_build_seconds === 'number')
      ? `cache built in ${Math.round(p.cache_build_seconds)}s on ${String(p.cache_built_at).slice(0, 10)}`
      : 'cache build time n/a';

    let staleMarker = '';
    if (p.generated_at) {
      try {
        const genMs = Date.parse(p.generated_at);
        if (Number.isFinite(genMs)) {
          const ageHours = (nowMs - genMs) / 3600000;
          if (ageHours > STALE_SUMMARY_HOURS) staleMarker = ` [STALE: ${Math.round(ageHours)}h old]`;
        }
      } catch {}
    }

    lines.push('================================================================================');
    lines.push(`ASSET ${p.symbol}${staleMarker} | Generated: ${p.generated_at || 'unknown'} | This run: ${thisRunStr} | precompute this run: ${thisRunPrecompute != null ? thisRunPrecompute + 's' : 'n/a'} | sim: ${ps.simulator_s ?? 'n/a'}s`);
    lines.push(`  ${cacheBuiltStr}`);
    if (p.engine_line) lines.push(`  ${p.engine_line}`);
    if (p.wrong_engine) lines.push(`  WARN: WRONG ENGINE detected for ${p.symbol}`);

    lines.push('--- Summary: Six Combinations ---');
    for (const c of p.combinations || []) {
      const tv = c.tune_validate || {};
      lines.push(`  ${String(c.label).padEnd(28)} | TR ${String(c.total_trades).padStart(4)} | WR ${fmt(c.win_rate, 1)}% | PF ${fmt(c.profit_factor)} | PNL $${fmt(c.net_pnl)} | TUNE[${tv.tune?.count ?? 0}t PF ${fmt(tv.tune?.profit_factor)}] | VALIDATE[${tv.validate?.count ?? 0}t PF ${fmt(tv.validate?.profit_factor)}] | ${c.holdout_verdict}`);
    }

    const b = p.best_combination || {};
    lines.push('');
    lines.push(`--- Summary: Best = ${b.label || 'N/A'} ---`);
    lines.push('Per-strategy:');
    const stv: Record<string, any> = b.strategy_tune_validate || {};
    Object.entries(b.strategy_kpis || {}).forEach(([sName, s]: any) => {
      const tv = stv[sName] || {};
      const tn = tv.tune || {};
      const vd = tv.validate || {};
      const inc = ((s.count || 0) < 30) ? '  [INCONCLUSIVE <30]' : '';
      lines.push(`  ${sName.padEnd(28)} | TR ${String(s.count).padStart(3)} | WR ${fmt(s.win_rate, 1)}% | PF ${fmt(s.profit_factor)} | PNL $${fmt(s.net_pnl)} | TUNE[${tn.count ?? 0}t PF ${fmt(tn.profit_factor)}] | VALIDATE[${vd.count ?? 0}t PF ${fmt(vd.profit_factor)}]${inc}`);
    });

    lines.push('');
    lines.push('--- Summary: Per-Weekday ---');
    for (const l of renderWeekdayTable(b.dow_kpis || {})) lines.push(l);

    const skipSummary = b.skipped_summary || {};
    const skipEntries = Object.entries(skipSummary);
    lines.push('');
    lines.push('--- Summary: Skipped signals (candles / unique setups) ---');
    if (skipEntries.length > 0) {
      const parts = skipEntries.map(([reason, val]: [string, any]) => typeof val === 'object' && val !== null ? `${reason}: ${val.candle_skips ?? 0}/${val.unique_setups ?? 0}` : `${reason}: ${val}`);
      lines.push(`  ${parts.join(' | ')}`);
    } else {
      lines.push('  (none)');
    }
    const sd = b.skipped_detail;
    if (sd) {
      if (sd.by_strategy && Object.keys(sd.by_strategy).length > 0) {
        lines.push(`  By strategy: ${Object.entries(sd.by_strategy).map(([k, v]) => `${k}=${v}`).join(' | ')}`);
      }
      if (sd.by_hour_sast && Object.keys(sd.by_hour_sast).length > 0) {
        lines.push(`  By hour (SAST): ${Object.entries(sd.by_hour_sast).map(([k, v]) => `${String(k).padStart(2,'0')}=${v}`).join(' | ')}`);
      }
    }

    lines.push('');
    lines.push('--- Ledger: Summary (10 best + 10 worst) ---');
    const allTrades = Array.isArray(b.all_trades) ? b.all_trades : [];
    for (const l of renderLedgerSummary(allTrades)) lines.push(l);

    lines.push('');
    lines.push('--- Diagnostics (all cards) ---');
    for (const l of renderAllDiagnostics(b.diagnostics)) lines.push(l);

    const tips: any[] = b.improvement_tips || [];
    const ruleSuggestions: any[] = b.rule_suggestions || [];
    if (tips.length > 0 || ruleSuggestions.length > 0) {
      lines.push('');
      lines.push('--- Tips (advisor + rule-based) ---');
      const seen = new Set<string>();
      for (const t of tips) {
        const key = `${t.category}|${t.strategy}|${t.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sev = t.severity || 'INFO';
        const strat = t.strategy || 'ALL';
        lines.push(`  [${sev}] [${strat}] ${t.title || ''}`);
        if (t.description) lines.push(`      ${t.description}`);
        if (t.action) lines.push(`      ACTION: ${t.action}`);
      }
      for (const s of ruleSuggestions) {
        const key = `${s.type}|${s.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`  ${s.tag} ${s.text}`);
      }
    }

    if (p.lab && Array.isArray(p.lab.variants)) {
      lines.push('');
      lines.push(`--- Strategy Lab (${p.lab.days}-day window) ---`);
      lines.push(`Window: ${p.lab.window_start} to ${p.lab.window_end}`);
      for (const v of p.lab.variants) {
        const inc = (v.trades < 30) ? '  [INCONCLUSIVE <30]' : '';
        lines.push(`  ${String(v.label).padEnd(28)} | TR ${String(v.trades).padStart(4)} | WR ${fmt(v.win_rate, 1)}% | PF ${fmt(v.profit_factor)} | DD -$${fmt(v.max_drawdown)} | PNL $${fmt(v.net_pnl)} | TUNE PF ${fmt(v.tune_pf)} (${v.tune_trades}tr) | VALIDATE PF ${fmt(v.validate_pf)} (${v.validate_trades}tr) | ${v.verdict}${inc}`);
      }
    }

    lines.push('');
  }

  lines.push('================================================================================');
  lines.push('PORTFOLIO CORRELATION (full matrix)');
  if (data.portfolio_correlation) for (const l of renderPortfolioMatrix(data.portfolio_correlation)) lines.push(l);
  else lines.push('  (not generated — run at least one pair backtest to produce it)');
  lines.push('');

  if (data.portfolio_suggestions && data.portfolio_suggestions.length > 0) {
    lines.push('================================================================================');
    lines.push('RANKED PORTFOLIO SUGGESTIONS');
    for (const s of data.portfolio_suggestions) lines.push(`  ${s.tag} ${s.text}`);
    lines.push('');
  }

  if (data.what_to_test_next && data.what_to_test_next.length > 0) {
    lines.push('================================================================================');
    lines.push('WHAT TO TEST NEXT:');
    data.what_to_test_next.forEach((item: string, idx: number) => lines.push(`  ${idx + 1}. ${item}`));
    lines.push('');
  }

  lines.push('================================================================================');
  lines.push(...renderEntryConditionAnalysis());
  lines.push('================================================================================');
  lines.push('');

  lines.push('================================================================================');
  lines.push(...renderCostTable());
  lines.push('================================================================================');
  lines.push('');

  lines.push('================================================================================');
  lines.push(...renderConsistencyChecks(data.pairs || []));
  lines.push('================================================================================');
  lines.push('');

  lines.push('================================================================================');
  lines.push('OPTIMIZER SUMMARY');
  if (fs.existsSync(OPTIMIZER_SUMMARY_TXT)) {
    try { lines.push(fs.readFileSync(OPTIMIZER_SUMMARY_TXT, 'utf8').trimEnd()); }
    catch (e: any) { lines.push(`  (read error: ${e?.message || String(e)})`); }
  } else if (fs.existsSync(OPTIMIZER_SUMMARY_JSON)) {
    try {
      const p = JSON.parse(fs.readFileSync(OPTIMIZER_SUMMARY_JSON, 'utf8'));
      if (typeof p.text === 'string') lines.push(p.text.trimEnd());
      else lines.push('  (optimizer_summary.json has no "text" field)');
    } catch (e: any) { lines.push(`  (read error: ${e?.message || String(e)})`); }
  } else {
    lines.push('  n/a — click "Optimize settings" to generate it.');
  }
  lines.push('================================================================================');
  lines.push('');

  lines.push('NOT IMPLEMENTED:');
  const notImpl = (data.spec_coverage || []).filter((row: any) => !row.panel && !row.txt);
  if (notImpl.length === 0) lines.push('  (none)');
  else notImpl.forEach((row: any) => lines.push(`  #${row.id} ${row.label}`));

  return lines.join('\n');
}

function checkContainerMemory(): { ok: boolean; reason?: string } {
  if (process.platform !== 'linux') return { ok: true };
  try {
    const currentRaw = fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim();
    const maxRaw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (maxRaw === 'max') return { ok: true };
    const currentBytes = parseInt(currentRaw, 10);
    const maxBytes = parseInt(maxRaw, 10);
    if (!Number.isFinite(currentBytes) || !Number.isFinite(maxBytes) || maxBytes <= 0) return { ok: true };
    const ratio = currentBytes / maxBytes;
    if (ratio > 0.70) return { ok: false, reason: `Memory at ${(ratio * 100).toFixed(1)}%` };
    return { ok: true };
  } catch { return { ok: true }; }
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

  // ---------------------------------------------------------------------------
  // MARKET / POSITION endpoints (untouched)
  // ---------------------------------------------------------------------------
  app.get('/api/market/candles', (req, res) => {
    try {
      const symbol = String(req.query.symbol || 'US30').toUpperCase();
      if (fs.existsSync(CANDLES_CACHE_FILE)) {
        const cache = JSON.parse(fs.readFileSync(CANDLES_CACHE_FILE, 'utf8'));
        if (cache && cache[symbol]) return res.status(200).json({ status: 'success', symbol, data: cache[symbol] });
      }
      return res.status(200).json({ status: 'success', symbol, data: [] });
    } catch (err: any) { return res.status(500).json({ status: 'error', message: err?.message }); }
  });
  app.post('/api/positions/close/:id', (req, res) => {
    try { fs.writeFileSync(CLOSE_COMMAND_FILE, JSON.stringify({ positionId: req.params.id, requestedAt: new Date().toISOString() })); res.status(200).json({ status: 'success' }); }
    catch (err: any) { res.status(500).json({ status: 'error', message: err?.message }); }
  });

  // ---------------------------------------------------------------------------
  // STRATEGY RESEARCH endpoints (untouched)
  // ---------------------------------------------------------------------------
  app.get('/api/backtest/descriptions', (_req, res) => res.status(200).json({ status: 'success', data: METRIC_DESCRIPTIONS }));
  app.get('/api/backtest/export-data', (_req, res) => {
    try { res.status(200).json({ status: 'success', data: generateExportDataPayload() }); }
    catch (err: any) { res.status(500).json({ status: 'error', message: err?.message }); }
  });

  app.get('/api/backtest/export.txt', (req, res) => {
    try {
      const sampleRaw = parseInt(String(req.query.sample ?? ''), 10);
      const sampleSize = Number.isFinite(sampleRaw)
        ? Math.max(0, Math.min(200, sampleRaw))
        : SAMPLE_TRADES_PER_PAIR;

      const data = generateExportDataPayload();
      const txt = renderTxtContent(data);
      const summaryCsv = renderSummaryCsv(data.pairs || []);
      const sampleCsv = sampleSize > 0
        ? renderSampleCsv(data.pairs || [], sampleSize)
        : renderLedgerCsv(data.pairs || []);

      const bar = '='.repeat(78);
      const combined = [
        bar,
        'PART 1 OF 3  —  AI BRIEF AND DIAGNOSTICS',
        bar,
        '',
        txt,
        '',
        '',
        bar,
        'PART 2 OF 3  —  BACKTEST SUMMARY CSV',
        '(One row per pair x combination. Paste into a spreadsheet or read directly.)',
        bar,
        '',
        summaryCsv,
        '',
        '',
        bar,
        `PART 3 OF 3  —  BACKTEST ${sampleSize > 0 ? 'SAMPLE' : 'FULL LEDGER'} CSV`,
        sampleSize > 0
          ? `(${sampleSize} stratified trades per pair: top wins, top losses, spread evenly through time.)`
          : '(Full ledger dump. Add ?sample=30 to the URL to shrink it.)',
        bar,
        '',
        sampleCsv,
        '',
      ].join('\n');

      const dateStr = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="backtest_ai_${dateStr}.txt"`);
      res.status(200).send(combined);
    } catch (err: any) { res.status(500).send(`Export error: ${err?.message}`); }
  });

  app.get('/api/backtest/export-zip', (req, res) => {
    try {
      const sampleRaw = parseInt(String(req.query.sample ?? ''), 10);
      const sampleSize = Number.isFinite(sampleRaw)
        ? Math.max(0, Math.min(200, sampleRaw))
        : SAMPLE_TRADES_PER_PAIR;

      const data = generateExportDataPayload();
      const txt = renderTxtContent(data);
      const summaryCsv = renderSummaryCsv(data.pairs || []);
      const dateStr = new Date().toISOString().slice(0, 10);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="backtest_${dateStr}.zip"`);
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err: any) => {
        console.error('Archive error:', err);
        try { res.status(500).end(`Archive error: ${err?.message}`); } catch {}
      });
      archive.pipe(res);
      archive.append(txt, { name: 'backtest_ai.txt' });
      archive.append(summaryCsv, { name: 'backtest_summary.csv' });
      if (sampleSize > 0) {
        const sampleCsv = renderSampleCsv(data.pairs || [], sampleSize);
        archive.append(sampleCsv, { name: 'backtest_sample.csv' });
      } else {
        const fullCsv = renderLedgerCsv(data.pairs || []);
        archive.append(fullCsv, { name: 'backtest_ledger.csv' });
      }
      archive.finalize();
    } catch (err: any) {
      if (!res.headersSent) res.status(500).send(`Export error: ${err?.message}`);
    }
  });

  app.get('/api/backtest/entry-analysis', (_req, res) => {
    try {
      const analysisFile = path.resolve(BACKTEST_OUTPUT_DIR, 'entry_analysis.json');
      if (fs.existsSync(analysisFile)) return res.status(200).json({ status: 'success', data: JSON.parse(fs.readFileSync(analysisFile, 'utf8')) });
      return res.status(404).json({ status: 'error', message: 'entry_analysis.json not yet generated. Run a backtest first.' });
    } catch (err: any) { return res.status(500).json({ status: 'error', message: err?.message }); }
  });
  app.get('/api/backtest/reports', (_req, res) => {
    try {
      if (!fs.existsSync(BACKTEST_OUTPUT_DIR)) return res.status(200).json({ status: 'success', reports: [] });
      const files = fs.readdirSync(BACKTEST_OUTPUT_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'));
      res.status(200).json({ status: 'success', reports: files });
    } catch (err: any) { res.status(500).json({ status: 'error', message: err?.message }); }
  });
  app.get('/api/backtest/summary/:symbol', (req, res) => {
    try {
      const sym = req.params.symbol.toUpperCase();
      const summaryFile = path.resolve(BACKTEST_OUTPUT_DIR, `${sym}_summary.json`);
      if (fs.existsSync(summaryFile)) return res.status(200).json({ status: 'success', data: JSON.parse(fs.readFileSync(summaryFile, 'utf8')) });
      return res.status(404).json({ status: 'error', message: 'Summary not found' });
    } catch (err: any) { return res.status(500).json({ status: 'error', message: err?.message }); }
  });
  app.get('/api/backtest/report/:filename', (req, res) => {
    try {
      const safeFilename = path.basename(req.params.filename);
      if (!safeFilename.endsWith('.json')) return res.status(400).json({ status: 'error', message: 'Invalid file format' });
      const targetPath = path.resolve(BACKTEST_OUTPUT_DIR, safeFilename);
      if (!targetPath.startsWith(path.resolve(BACKTEST_OUTPUT_DIR)) || !fs.existsSync(targetPath)) return res.status(404).json({ status: 'error', message: 'Report not found' });
      const data = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
      if (data && data.day_data && data.symbol) {
        const daycandlesPath = path.resolve(BACKTEST_OUTPUT_DIR, `${data.symbol}_daycandles.json`);
        if (fs.existsSync(daycandlesPath)) {
          try {
            const dayCandles = JSON.parse(fs.readFileSync(daycandlesPath, 'utf8'));
            for (const [dateKey, dayObj] of Object.entries<any>(data.day_data)) {
              if ((!dayObj.candles || dayObj.candles.length === 0) && dayCandles[dateKey]) dayObj.candles = dayCandles[dateKey];
            }
          } catch {}
        }
      }
      res.status(200).json({ status: 'success', data });
    } catch (err: any) { res.status(500).json({ status: 'error', message: err?.message }); }
  });
  app.get('/api/backtest/portfolio', (_req, res) => {
    try {
      const portfolioFile = path.resolve(BACKTEST_OUTPUT_DIR, 'portfolio_correlation.json');
      if (fs.existsSync(portfolioFile)) return res.status(200).json({ status: 'success', data: JSON.parse(fs.readFileSync(portfolioFile, 'utf8')) });
      return res.status(404).json({ status: 'error', message: 'Portfolio correlation not yet generated.' });
    } catch (err: any) { return res.status(500).json({ status: 'error', message: err?.message }); }
  });
  app.get('/api/backtest/lab/:symbol', (req, res) => {
    try {
      const sym = String(req.params.symbol || '').toUpperCase();
      const labFile = path.resolve(BACKTEST_OUTPUT_DIR, `${sym}_lab.json`);
      if (fs.existsSync(labFile)) return res.status(200).json({ status: 'success', data: JSON.parse(fs.readFileSync(labFile, 'utf8')) });
      return res.status(404).json({ status: 'error', message: `No Strategy Lab file for ${sym}.` });
    } catch (err: any) { return res.status(500).json({ status: 'error', message: err?.message }); }
  });
  app.post('/api/backtest/lab', (req, res) => {
    if (backtestRunning) return res.status(409).json({ status: 'error', message: 'A backtest is running.' });
    const requested: any = req.body?.symbols ?? req.body?.symbol ?? 'US30';
    const symbolsArray: string[] = Array.isArray(requested) ? requested.map((s: string) => String(s).toUpperCase()).filter(Boolean) : String(requested).toUpperCase() === 'ALL' ? [...WHITELIST_ASSETS] : [String(requested).toUpperCase()];
    if (symbolsArray.length === 0) return res.status(400).json({ status: 'error', message: 'No symbols supplied.' });
    backtestResults = []; backtestRunning = true; backtestProgress = `Strategy Lab for ${symbolsArray.join(', ')}...`;
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const proc = spawn(pythonCmd, ['backtest/runner.py', '--symbols', symbolsArray.join(','), '--lab'], { env: { ...process.env, PYTHONPATH: process.cwd() } });
    activeBacktestProcesses.push(proc);
    let stdoutBuf = '';
    proc.stdout.on('data', data => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const l of lines) if (l.trim().startsWith('[LAB]')) backtestProgress = l.trim();
    });
    let stderrBuf = '';
    proc.stderr.on('data', data => {
      stderrBuf += data.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) console.error(`[LAB:ERR] ${l.trimEnd()}`);
    });
    proc.on('exit', code => {
      backtestRunning = false;
      activeBacktestProcesses = activeBacktestProcesses.filter(p => p !== proc);
      backtestProgress = code === 0 ? 'Strategy Lab complete.' : 'Strategy Lab failed.';
      if (code !== 0) backtestLastError = `Exited with code ${code}`;
    });
    res.status(200).json({ status: 'success', message: 'Strategy Lab started.' });
  });

  // ---------------------------------------------------------------------------
  // OPTIMIZER endpoints (untouched)
  // ---------------------------------------------------------------------------
  app.post('/api/backtest/optimize', (req, res) => {
    if (optimizerRunning) return res.status(409).json({ status: 'error', message: 'Optimizer already running.' });
    if (backtestRunning) return res.status(409).json({ status: 'error', message: 'A backtest is running. Wait for it to finish before starting the optimizer.' });
    const memCheck = checkContainerMemory();
    if (!memCheck.ok) return res.status(503).json({ status: 'error', message: memCheck.reason });
    const requested: any = req.body?.symbols ?? req.body?.symbol ?? 'ALL';
    const symbolsArray: string[] = Array.isArray(requested)
      ? requested.map((s: string) => String(s).toUpperCase()).filter(Boolean)
      : String(requested).toUpperCase() === 'ALL' ? [...WHITELIST_ASSETS] : [String(requested).toUpperCase()];
    if (symbolsArray.length === 0) return res.status(400).json({ status: 'error', message: 'No symbols supplied.' });
    optimizerRunning = true;
    optimizerProgress = `Launching optimizer for ${symbolsArray.join(', ')}...`;
    optimizerLastError = null;
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const proc = spawn(pythonCmd, ['backtest/runner.py', '--optimize', '--symbols', symbolsArray.join(',')], { env: { ...process.env, PYTHONPATH: process.cwd() } });
    optimizerProcess = proc;
    let stdoutBuf = '';
    proc.stdout.on('data', data => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const raw of lines) {
        const l = raw.trim();
        if (!l) continue;
        if (l.startsWith('[OPTIMIZE]')) { optimizerProgress = l.replace('[OPTIMIZE]', '').trim(); console.log(l); }
      }
    });
    let stderrBuf = '';
    proc.stderr.on('data', data => {
      stderrBuf += data.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const raw of lines) if (raw.trimEnd()) console.error(`[OPT:ERR] ${raw.trimEnd()}`);
    });
    proc.on('exit', code => {
      optimizerRunning = false;
      optimizerProcess = null;
      optimizerProgress = code === 0 ? 'Optimizer complete.' : 'Optimizer failed.';
      if (code !== 0) optimizerLastError = `Exited with code ${code}`;
    });
    proc.on('error', err => {
      optimizerRunning = false;
      optimizerProcess = null;
      optimizerLastError = `spawn error: ${err.message}`;
      optimizerProgress = 'Optimizer failed to start.';
    });
    res.status(200).json({ status: 'success', message: `Optimizer started for ${symbolsArray.join(', ')}.` });
  });
  app.get('/api/backtest/optimize-status', (_req, res) => {
    let details: any = null;
    if (fs.existsSync(OPTIMIZER_STATUS_FILE)) { try { details = JSON.parse(fs.readFileSync(OPTIMIZER_STATUS_FILE, 'utf8')); } catch {} }
    let summaryText: string | null = null;
    if (fs.existsSync(OPTIMIZER_SUMMARY_TXT)) { try { summaryText = fs.readFileSync(OPTIMIZER_SUMMARY_TXT, 'utf8'); } catch {} }
    else if (fs.existsSync(OPTIMIZER_SUMMARY_JSON)) {
      try { const p = JSON.parse(fs.readFileSync(OPTIMIZER_SUMMARY_JSON, 'utf8')); if (typeof p.text === 'string') summaryText = p.text; } catch {}
    }
    res.status(200).json({ status: 'success', isRunning: optimizerRunning, progress: optimizerProgress, lastError: optimizerLastError, details, summaryText });
  });
  app.post('/api/backtest/optimize/stop', (_req, res) => {
    if (optimizerProcess) { try { optimizerProcess.kill(); } catch {} }
    optimizerProcess = null;
    optimizerRunning = false;
    optimizerProgress = 'Optimizer cancelled.';
    res.status(200).json({ status: 'success', message: 'Optimizer stopped.' });
  });

  // ---------------------------------------------------------------------------
  // COMPARE endpoints (untouched)
  // ---------------------------------------------------------------------------
  app.post('/api/backtest/compare', (req, res) => {
    if (compareRunning) return res.status(409).json({ error: 'Comparison already running.' });
    if (backtestRunning) return res.status(409).json({ error: 'A backtest is running. Wait for it to finish.' });
    const symbol = String(req.body?.symbol || 'US30').toUpperCase();
    const days = parseInt(req.body?.days || '60', 10);
    compareRunning = true;
    compareProgress = `Starting comparison for ${symbol} (${days} days)...`;
    compareSymbol = symbol;
    compareLastError = null;
    const oldFile = path.resolve(BACKTEST_OUTPUT_DIR, `${symbol}_compare.json`);
    if (fs.existsSync(oldFile)) { try { fs.unlinkSync(oldFile); } catch {} }
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const proc = spawn(pythonCmd, ['backtest/compare_engines.py', '--symbol', symbol, '--days', String(days)], { env: { ...process.env, PYTHONPATH: process.cwd() } });
    compareProcess = proc;
    let stdoutBuf = '';
    proc.stdout.on('data', data => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const raw of lines) { const l = raw.trim(); if (l.startsWith('[COMPARE]')) { compareProgress = l; console.log(l); } }
    });
    let stderrBuf = '';
    proc.stderr.on('data', data => {
      stderrBuf += data.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const raw of lines) if (raw.trimEnd()) console.error(`[COMPARE:ERR] ${raw.trimEnd()}`);
    });
    proc.on('exit', code => {
      compareRunning = false; compareProcess = null;
      if (code !== 0) { compareLastError = `Exited with code ${code}`; compareProgress = 'Comparison failed.'; }
      else compareProgress = 'Comparison complete.';
    });
    proc.on('error', err => {
      compareRunning = false; compareProcess = null;
      compareLastError = `spawn error: ${err.message}`; compareProgress = 'Comparison failed.';
    });
    res.status(200).json({ status: 'success', message: `Comparison started for ${symbol}.`, symbol, days });
  });
  app.get('/api/backtest/compare/status', (_req, res) => {
    let result: any = null;
    if (compareSymbol) {
      const f = path.resolve(BACKTEST_OUTPUT_DIR, `${compareSymbol}_compare.json`);
      if (fs.existsSync(f)) { try { result = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} }
    }
    res.status(200).json({ status: 'success', isRunning: compareRunning, progress: compareProgress, symbol: compareSymbol, lastError: compareLastError, result });
  });
  app.post('/api/backtest/compare/stop', (_req, res) => {
    if (compareProcess) { try { compareProcess.kill(); } catch {} }
    compareProcess = null; compareRunning = false; compareProgress = 'Comparison cancelled.';
    res.status(200).json({ status: 'success' });
  });

  // ---------------------------------------------------------------------------
  // STRATEGY RESEARCH run endpoints (untouched)
  // ---------------------------------------------------------------------------
  app.post('/api/backtest/run', (req, res) => {
    if (backtestRunning) return res.status(409).json({ status: 'error', message: 'A backtest is already running.' });
    const memCheck = checkContainerMemory();
    if (!memCheck.ok) return res.status(503).json({ status: 'error', message: memCheck.reason });
    const requested: any = req.body?.symbol ?? 'US30';
    const symbolsArray: string[] = Array.isArray(requested) ? requested.map((s: string) => String(s).toUpperCase()).filter(Boolean) : String(requested).toUpperCase() === 'ALL' ? [...WHITELIST_ASSETS] : [String(requested).toUpperCase()];
    if (symbolsArray.length === 0) return res.status(400).json({ status: 'error', message: 'No symbols supplied.' });
    const days = parseInt(req.body?.days || '60', 10);

    const balanceRaw = parseFloat(String(req.body?.balance ?? '1000'));
    const currency = String(req.body?.currency || 'USD').toUpperCase();
    const zarRateRaw = parseFloat(String(req.body?.zarRate ?? '18'));
    const profile = String(req.body?.profile || 'Max Growth');
    const safeBalance = Number.isFinite(balanceRaw) && balanceRaw >= 1 ? balanceRaw : 1000;
    const safeZarRate = Number.isFinite(zarRateRaw) && zarRateRaw > 0 ? zarRateRaw : 18;

    lastRunStartingBalance = safeBalance;
    lastRunCurrency = currency;
    lastRunProfile = profile;
    lastRunWallClockSeconds = null;

    backtestResults = []; activeBacktestProcesses = []; backtestRunning = true;
    backtestProgress = `Initiating backtest matrix for ${symbolsArray.join(', ')}...`;
    backtestLastError = null; backtestExitCode = null;
    const runStartedAt = Date.now();
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const CONCURRENT_PAIRS = 2;
    lastRunConcurrentProcesses = CONCURRENT_PAIRS;
    async function executeMatrix() {
      let activeIndex = 0; let completedCount = 0;
      async function runWorker(sym: string): Promise<void> {
        let symTiming = ''; const stderrTail: string[] = [];
        let engineLine = ''; let wrongEngine = false;
        const args = [
          'backtest/runner.py', '--symbol', sym, '--days', String(days),
          '--balance', String(safeBalance),
          '--currency', currency,
          '--zar-rate', String(safeZarRate),
          '--profile', profile,
        ];
        await new Promise<void>((resolve) => {
          const proc = spawn(pythonCmd, args, { env: { ...process.env, PYTHONPATH: process.cwd(), BACKTEST_CONCURRENT_WORKERS: String(CONCURRENT_PAIRS) } });
          activeBacktestProcesses.push(proc);
          let stdoutBuffer = '';
          proc.stdout.on('data', data => {
            stdoutBuffer += data.toString();
            const lines = stdoutBuffer.split('\n');
            stdoutBuffer = lines.pop() ?? '';
            for (const rawLine of lines) {
              const t = rawLine.trim();
              if (!t) continue;
              if (t.startsWith('[time]')) symTiming = t.replace('[time]', '').trim();
              if (t.startsWith(`[${sym}]`)) {
                if (t.includes('engine:')) engineLine = t.replace(`[${sym}]`, '').trim();
                if (t.includes('WRONG ENGINE')) wrongEngine = true;
              }
              if (t.startsWith('[TOTAL]') && t.includes('wall_clock_seconds=')) {
                const m = t.match(/wall_clock_seconds=([0-9.]+)/);
                if (m) { const v = parseFloat(m[1]); if (Number.isFinite(v)) lastRunWallClockSeconds = Math.round(v); }
              }
            }
          });
          proc.stderr.on('data', data => {
            const lines = data.toString().split('\n');
            for (const raw of lines) { const line = raw.trimEnd(); if (!line) continue; stderrTail.push(line); if (stderrTail.length > 20) stderrTail.shift(); }
          });
          proc.on('exit', (code, signal) => {
            completedCount++;
            backtestProgress = `[Running] ${completedCount}/${symbolsArray.length} completed.`;
            const tailText = stderrTail.length > 0 ? `\n--- stderr (last ${stderrTail.length} lines) ---\n${stderrTail.join('\n')}` : '';
            const reason = signal ? `Killed by ${signal}` : `Exited with code ${code}`;
            if (!signal && code === 0) backtestResults.push({ symbol: sym, status: 'OK', message: 'Completed 6/6 matrix', timing: symTiming, engine_line: engineLine, wrong_engine: wrongEngine });
            else backtestResults.push({ symbol: sym, status: 'FAILED', message: `${reason}${tailText}`, timing: symTiming, engine_line: engineLine, wrong_engine: wrongEngine });
            resolve();
          });
          proc.on('error', err => {
            completedCount++;
            backtestResults.push({ symbol: sym, status: 'FAILED', message: `spawn error: ${err.message}`, engine_line: engineLine, wrong_engine: wrongEngine });
            resolve();
          });
        });
      }
      const activePool: Promise<void>[] = [];
      while (activeIndex < symbolsArray.length && backtestRunning) {
        while (activePool.length < CONCURRENT_PAIRS && activeIndex < symbolsArray.length) {
          const nextSym = symbolsArray[activeIndex++];
          const p = runWorker(nextSym).then(() => { const idx = activePool.indexOf(p); if (idx >= 0) activePool.splice(idx, 1); });
          activePool.push(p);
        }
        if (activePool.length > 0) await Promise.race(activePool);
      }
      await Promise.all(activePool);
      backtestRunning = false;
      const elapsed = Math.round((Date.now() - runStartedAt) / 1000);
      if (lastRunWallClockSeconds === null) lastRunWallClockSeconds = elapsed;
      backtestProgress = `Finished: ${backtestResults.filter(r => r.status === 'OK').length}/${backtestResults.length} assets completed. Wall clock ${elapsed}s.`;
    }
    executeMatrix().catch(e => { backtestRunning = false; backtestLastError = e.message; });
    res.status(200).json({ status: 'success', message: `Execution initiated for ${symbolsArray.join(', ')}` });
  });
  app.get('/api/backtest/status', (_req, res) => {
    res.status(200).json({
      status: 'success', isRunning: backtestRunning, progress: backtestProgress,
      lastError: backtestLastError, exitCode: backtestExitCode, results: backtestResults,
      wall_clock_seconds: lastRunWallClockSeconds, concurrent_processes: lastRunConcurrentProcesses,
      starting_balance_input: lastRunStartingBalance, starting_balance_currency: lastRunCurrency,
      profile_name: lastRunProfile,
    });
  });
  app.post('/api/backtest/stop', (_req, res) => {
    activeBacktestProcesses.forEach(p => { try { p.kill(); } catch {} });
    activeBacktestProcesses = []; backtestRunning = false; backtestProgress = 'Backtest canceled by user.'; backtestLastError = null;
    res.status(200).json({ status: 'success' });
  });

  // ---------------------------------------------------------------------------
  // STORAGE endpoints (untouched)
  // ---------------------------------------------------------------------------
  app.get('/api/backtest/storage', (_req, res) => {
    try {
      const volPath = storageBase || process.cwd();
      let total_mb = 0, free_mb = 0, used_mb = 0;
      try { const stats = fs.statfsSync(volPath); total_mb = Math.round((stats.bsize * stats.blocks) / (1024 * 1024)); free_mb = Math.round((stats.bsize * stats.bfree) / (1024 * 1024)); used_mb = total_mb - free_mb; } catch {}
      let market_data_bytes = 0;
      if (fs.existsSync(BACKTEST_DATA_DIR)) for (const f of fs.readdirSync(BACKTEST_DATA_DIR)) { try { const s = fs.statSync(path.join(BACKTEST_DATA_DIR, f)); if (s.isFile() && f.endsWith('.csv')) market_data_bytes += s.size; } catch {} }
      let reports_bytes = 0;
      if (fs.existsSync(BACKTEST_OUTPUT_DIR)) for (const f of fs.readdirSync(BACKTEST_OUTPUT_DIR)) { try { const s = fs.statSync(path.join(BACKTEST_OUTPUT_DIR, f)); if (s.isFile()) reports_bytes += s.size; } catch {} }
      res.status(200).json({ status: 'success', data: { total_mb, used_mb, free_mb, market_data_mb: Number((market_data_bytes / (1024 * 1024)).toFixed(2)), reports_mb: Number((reports_bytes / (1024 * 1024)).toFixed(2)) } });
    } catch (err: any) { res.status(500).json({ status: 'error', message: err?.message }); }
  });
  app.post('/api/backtest/storage/cleanup', (req, res) => {
    try {
      const scope = req.body?.scope || 'all_reports';
      const targetSym = (req.body?.symbol || '').toUpperCase().trim();
      let deletedCount = 0;
      if (fs.existsSync(BACKTEST_OUTPUT_DIR)) for (const f of fs.readdirSync(BACKTEST_OUTPUT_DIR)) {
        if (!f.endsWith('.json')) continue;
        const shouldDelete = scope === 'all_reports' || (scope === 'symbol' && targetSym && f.startsWith(`${targetSym}_`));
        if (shouldDelete) { try { fs.unlinkSync(path.join(BACKTEST_OUTPUT_DIR, f)); deletedCount++; } catch {} }
      }
      res.status(200).json({ status: 'success', message: `Deleted ${deletedCount} file(s).`, deletedCount });
    } catch (err: any) { res.status(500).json({ status: 'error', message: err?.message }); }
  });

  // ---------------------------------------------------------------------------
  // JOURNAL / BOT / LIMITS / BROKER endpoints (untouched)
  // ---------------------------------------------------------------------------
  app.get('/api/journal', async (_req, res) => {
    try { const diskTrades = loadTradesFromDisk(); activeBrokerTelemetry.trades = diskTrades; res.status(200).json(diskTrades); }
    catch { res.status(500).json({ error: "Failed to fetch journal entries" }); }
  });
  app.post('/api/journal', (req, res) => {
    try { const trades = loadTradesFromDisk(); trades.unshift(req.body); saveTradesToDisk(trades); activeBrokerTelemetry.trades = trades; recomputeRiskState(); res.status(200).json({ status: "success", trade: req.body }); }
    catch { res.status(500).json({ error: "Failed to save journal entry" }); }
  });
  app.delete('/api/journal/:id', (req, res) => {
    const tradeId = req.params.id;
    let trades = loadTradesFromDisk();
    trades = trades.filter(t => t.id !== tradeId && t.ticket !== tradeId);
    saveTradesToDisk(trades); activeBrokerTelemetry.trades = trades; recomputeRiskState();
    res.json({ status: 'success' });
  });
  app.post('/api/journal/reset', (_req, res) => { saveTradesToDisk([]); activeBrokerTelemetry.trades = []; recomputeRiskState(); res.json({ status: 'success' }); });
  app.get('/api/bot/config', (_req, res) => res.json({ status: 'success', data: activeBotConfig }));
  app.post('/api/bot/config', (req, res) => {
    try { activeBotConfig = { ...activeBotConfig, ...req.body, updatedAt: new Date().toISOString() }; saveBotConfigAtomically(activeBotConfig); res.json({ status: 'success', config: activeBotConfig }); }
    catch (error: any) { res.status(500).json({ status: 'error', message: error?.message }); }
  });
  app.get('/api/limits', (_req, res) => { recomputeRiskState(); res.json({ status: 'success', data: { ...riskLimits, ...riskState } }); });
  app.post('/api/limits', (req, res) => {
    try {
      const { maxDailyLossUsd, maxWeeklyLossUsd, maxMonthlyLossUsd, maxDailyDrawdownPct, autoLiquidateAllOnTrip, resetBreaker, useProfileDrawdownPct } = req.body;
      if (typeof maxDailyLossUsd === 'number') riskLimits.maxDailyLossUsd = maxDailyLossUsd;
      if (typeof maxWeeklyLossUsd === 'number') riskLimits.maxWeeklyLossUsd = maxWeeklyLossUsd;
      if (typeof maxMonthlyLossUsd === 'number') riskLimits.maxMonthlyLossUsd = maxMonthlyLossUsd;
      if (typeof maxDailyDrawdownPct === 'number') riskLimits.maxDailyDrawdownPct = maxDailyDrawdownPct;
      if (typeof autoLiquidateAllOnTrip === 'boolean') riskLimits.autoLiquidateAllOnTrip = autoLiquidateAllOnTrip;
      if (typeof useProfileDrawdownPct === 'boolean') riskLimits.useProfileDrawdownPct = useProfileDrawdownPct;
      if (resetBreaker) { riskState.breakerTriggered = false; riskState.activeTripScope = 'NONE'; riskState.lastTriggerReason = undefined; activeBotConfig.masterExecution = true; }
      saveBotConfigAtomically({ ...activeBotConfig, ...riskLimits, limitsConfirmedAt: new Date().toISOString() });
      res.json({ status: 'success', data: { ...riskLimits, ...riskState } });
    } catch (error: any) { res.status(500).json({ status: 'error', message: error?.message }); }
  });
  app.get('/api/broker/telemetry', (_req, res) => { recomputeRiskState(); res.json({ status: 'success', data: activeBrokerTelemetry }); });
  app.post('/api/broker/telemetry', (req, res) => { activeBrokerTelemetry = { ...activeBrokerTelemetry, ...req.body, lastHeartbeat: new Date().toISOString() }; res.json({ status: 'success', data: activeBrokerTelemetry, activeBotConfig }); });

  // ---------------------------------------------------------------------------
  // Python bot launcher (untouched)
  // ---------------------------------------------------------------------------
  function launchPythonBot() {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const bot = spawn(pythonCmd, ['engine/matrix.py'], { env: { ...process.env, PYTHONPATH: process.cwd() }, stdio: ['ignore', 'pipe', 'pipe'] });
    let restartScheduled = false; let stdoutBuffer = ''; let stderrBuffer = '';
    const scheduleRestart = (reason: string) => {
      if (restartScheduled) return; restartScheduled = true;
      const now = Date.now(); botRestartTimestamps.push(now); botRestartTimestamps = botRestartTimestamps.filter(t => now - t <= 120000);
      const count = botRestartTimestamps.length;
      if (count <= 1) botCrashLoopWarned = false;
      if (!botCrashLoopWarned && count > 5) { botCrashLoopWarned = true; console.error(`[BOT] CRASH LOOP — ${count} restarts within 2 minutes.`); }
      setTimeout(() => launchPythonBot(), 5000);
    };
    bot.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n'); stdoutBuffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim(); if (!line) continue;
        if (line.includes('[MATRIX_TELEMETRY]')) {
          try {
            const telem = JSON.parse(line.split('[MATRIX_TELEMETRY]')[1].trim());
            activeBrokerTelemetry.balance = telem.balance; activeBrokerTelemetry.equity = telem.equity;
            if (telem.currency) activeBrokerTelemetry.currency = telem.currency;
            if (telem.netProfit !== undefined) activeBrokerTelemetry.netProfit = telem.netProfit;
            if (telem.winRate !== undefined) activeBrokerTelemetry.winRate = telem.winRate;
            if (telem.totalTrades !== undefined) activeBrokerTelemetry.totalTrades = telem.totalTrades;
            if (telem.winningTrades !== undefined) activeBrokerTelemetry.winningTrades = telem.winningTrades;
            if (telem.losingTrades !== undefined) activeBrokerTelemetry.losingTrades = telem.losingTrades;
            if (Array.isArray(telem.openPositions)) activeBrokerTelemetry.openPositions = telem.openPositions;
            activeBrokerTelemetry.connected = true; activeBrokerTelemetry.lastHeartbeat = new Date().toISOString();
          } catch {}
          continue;
        }
        console.log(`[BOT] ${line}`);
      }
    });
    bot.stderr.on('data', chunk => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split('\n'); stderrBuffer = lines.pop() ?? '';
      for (const rawLine of lines) if (rawLine.trimEnd()) console.error(`[BOT:ERR] ${rawLine.trimEnd()}`);
    });
    bot.on('error', err => { console.error(`[BOT] spawn error: ${err.message}`); scheduleRestart(`spawn error`); });
    bot.on('exit', (code, signal) => { scheduleRestart(`exit code=${code} signal=${signal ?? 'null'}`); });
  }
  launchPythonBot();

  // ---------------------------------------------------------------------------
  // SPREAD CONFIG (untouched)
  // ---------------------------------------------------------------------------
  const SPREAD_CONFIG_FILE = path.join(process.cwd(), 'config', 'spread_config.json');

  app.get('/api/backtest/spread-config', (_req, res) => {
    try {
      if (!fs.existsSync(SPREAD_CONFIG_FILE)) {
        return res.status(200).json({ status: 'success', data: null });
      }
      const raw = fs.readFileSync(SPREAD_CONFIG_FILE, 'utf8').trim();
      if (!raw) return res.status(200).json({ status: 'success', data: null });
      return res.status(200).json({ status: 'success', data: JSON.parse(raw) });
    } catch (err: any) {
      return res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  app.post('/api/backtest/spread-config', (req, res) => {
    try {
      const payload = req.body;
      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ status: 'error', message: 'Invalid payload.' });
      }
      const dir = path.dirname(SPREAD_CONFIG_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = SPREAD_CONFIG_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, SPREAD_CONFIG_FILE);
      return res.status(200).json({ status: 'success', data: payload });
    } catch (err: any) {
      return res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  app.get('/api/backtest/profiles/:symbol', (req, res) => {
    try {
      const sym = String(req.params.symbol || '').toUpperCase();
      const file = path.resolve(BACKTEST_OUTPUT_DIR, `${sym}_profiles.json`);
      if (fs.existsSync(file)) {
        return res.status(200).json({ status: 'success', data: JSON.parse(fs.readFileSync(file, 'utf8')) });
      }
      return res.status(404).json({ status: 'error', message: `No profile matrix for ${sym}.` });
    } catch (err: any) {
      return res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  app.get('/api/backtest/portfolio-profiles', (_req, res) => {
    try {
      const file = path.resolve(BACKTEST_OUTPUT_DIR, 'portfolio_profiles.json');
      if (fs.existsSync(file)) {
        return res.status(200).json({ status: 'success', data: JSON.parse(fs.readFileSync(file, 'utf8')) });
      }
      return res.status(404).json({ status: 'error', message: 'Portfolio profile matrix not yet generated.' });
    } catch (err: any) {
      return res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  app.get('/api/backtest/pip-calculator', (_req, res) => {
    try {
      const file = path.join(process.cwd(), 'config', 'pip_calculator.json');
      if (!fs.existsSync(file)) {
        return res.status(404).json({ status: 'error', message: 'pip_calculator.json not yet generated. Run a backtest first.' });
      }
      return res.status(200).json({ status: 'success', data: JSON.parse(fs.readFileSync(file, 'utf8')) });
    } catch (err: any) {
      return res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  // ===========================================================================
  // LIVE BOT REPLAY endpoints (NEW)
  // ===========================================================================
  // POST /api/backtest/live-sim          — spawn the Python replay
  // GET  /api/backtest/live-sim/status   — poll progress
  // GET  /api/backtest/live-sim/report   — fetch the JSON report
  // POST /api/backtest/live-sim/stop     — kill the process
  // ===========================================================================

  app.post('/api/backtest/live-sim', (req, res) => {
    if (liveSimRunning) {
      return res.status(409).json({ status: 'error', message: 'A live bot replay is already running.' });
    }
    if (backtestRunning) {
      return res.status(409).json({
        status: 'error',
        message: 'A Strategy Research backtest is running. Wait for it to finish, or let it complete so the precompute caches exist.',
      });
    }
    const memCheck = checkContainerMemory();
    if (!memCheck.ok) {
      return res.status(503).json({ status: 'error', message: memCheck.reason });
    }

    const requested: any = req.body?.symbols ?? req.body?.symbol ?? WHITELIST_ASSETS;
    const symbolsArray: string[] = Array.isArray(requested)
      ? requested.map((s: string) => String(s).toUpperCase()).filter(Boolean)
      : String(requested).toUpperCase() === 'ALL'
        ? [...WHITELIST_ASSETS]
        : [String(requested).toUpperCase()];
    if (symbolsArray.length === 0) {
      return res.status(400).json({ status: 'error', message: 'No symbols supplied.' });
    }

    const days = parseInt(String(req.body?.days ?? '365'), 10);
    const safeDays = Number.isFinite(days) && days > 0 ? days : 365;

    const balanceRaw = parseFloat(String(req.body?.balance ?? '170'));
    const safeBalance = Number.isFinite(balanceRaw) && balanceRaw >= 1 ? balanceRaw : 170;

    const currency = String(req.body?.currency || 'USD').toUpperCase();
    const safeCurrency = (currency === 'ZAR') ? 'ZAR' : 'USD';

    const zarRateRaw = parseFloat(String(req.body?.zarRate ?? '18'));
    const safeZarRate = Number.isFinite(zarRateRaw) && zarRateRaw > 0 ? zarRateRaw : 18;

    const profile = String(req.body?.profile || 'Max Growth');

    liveSimLastParams = {
      symbols: symbolsArray,
      days: safeDays,
      balance: safeBalance,
      currency: safeCurrency,
      zarRate: safeZarRate,
      profile,
    };

    liveSimRunning = true;
    liveSimProgress = `Launching live bot replay for ${symbolsArray.join(', ')}...`;
    liveSimLastError = null;

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const args = [
      'backtest/live_sim_runner.py',
      '--symbols', symbolsArray.join(','),
      '--days', String(safeDays),
      '--balance', String(safeBalance),
      '--currency', safeCurrency,
      '--zar-rate', String(safeZarRate),
      '--profile', profile,
    ];

    const proc = spawn(pythonCmd, args, {
      env: { ...process.env, PYTHONPATH: process.cwd() },
    });
    liveSimProcess = proc;

    let stdoutBuf = '';
    proc.stdout.on('data', data => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const raw of lines) {
        const l = raw.trim();
        if (!l) continue;
        if (l.startsWith('[live-sim]')) {
          liveSimProgress = l.replace('[live-sim]', '').trim();
          console.log(l);
        }
      }
    });

    let stderrBuf = '';
    proc.stderr.on('data', data => {
      stderrBuf += data.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const raw of lines) {
        const l = raw.trimEnd();
        if (!l) continue;
        console.error(`[live-sim:ERR] ${l}`);
      }
    });

    proc.on('exit', code => {
      liveSimRunning = false;
      liveSimProcess = null;
      if (code === 0) {
        liveSimProgress = 'Live bot replay complete.';
      } else {
        liveSimLastError = `Exited with code ${code}`;
        liveSimProgress = `Live bot replay failed: ${liveSimLastError}`;
      }
    });

    proc.on('error', err => {
      liveSimRunning = false;
      liveSimProcess = null;
      liveSimLastError = `spawn error: ${err.message}`;
      liveSimProgress = `Live bot replay failed: ${liveSimLastError}`;
    });

    res.status(200).json({
      status: 'success',
      message: `Live bot replay started for ${symbolsArray.join(', ')}.`,
      params: liveSimLastParams,
    });
  });

  app.get('/api/backtest/live-sim/status', (_req, res) => {
    res.status(200).json({
      status: 'success',
      isRunning: liveSimRunning,
      progress: liveSimProgress,
      lastError: liveSimLastError,
      params: liveSimLastParams,
    });
  });

  app.get('/api/backtest/live-sim/report', (_req, res) => {
    try {
      const reportFile = path.resolve(BACKTEST_OUTPUT_DIR, 'live_sim_report.json');
      if (!fs.existsSync(reportFile)) {
        return res.status(404).json({
          status: 'error',
          message: 'No live sim report yet. Run a Live Bot Replay first.',
        });
      }
      const data = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      res.status(200).json({ status: 'success', data });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  app.post('/api/backtest/live-sim/stop', (_req, res) => {
    if (liveSimProcess) {
      try { liveSimProcess.kill(); } catch {}
    }
    liveSimProcess = null;
    liveSimRunning = false;
    liveSimProgress = 'Live bot replay cancelled.';
    res.status(200).json({ status: 'success', message: 'Live bot replay stopped.' });
  });

  // ---------------------------------------------------------------------------
  // 404 for /api/*
  // ---------------------------------------------------------------------------
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl}` });
  });

  // ---------------------------------------------------------------------------
  // Frontend
  // ---------------------------------------------------------------------------
  const distPath = path.join(process.cwd(), 'dist');
  if (fs.existsSync(path.join(distPath, 'index.html'))) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  } else {
    const vite = await createViteServer({ server: { middlewareMode: true, host: '0.0.0.0' }, appType: 'spa' });
    app.use(vite.middlewares);
  }

  app.use((err: any, req: any, res: any, _next: any) => {
    const message = err?.message || 'Server error';
    if (req.path && String(req.path).startsWith('/api/')) res.status(500).json({ error: message });
    else res.status(500).send(message);
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Trading Portal & API Gateway active on port ${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Server startup error:', err);
  process.exit(1);
});