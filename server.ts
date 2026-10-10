import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { spawn, ChildProcess } from 'child_process';
import { METRIC_DESCRIPTIONS, describe } from './shared/metricDescriptions';

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
  // PROPOSED: entry-condition analysis is a TXT-only addition per the prompt.
  { id: 39, label: 'Entry condition analysis (pooled, R:R 1:1, BE off)', panel: false, txt: true, pdf: false, note: 'TXT-only, follows the portfolio section.' },
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

let backtestRunning = false;
let backtestProgress = '';
let backtestLastError: string | null = null;
let backtestExitCode: number | null = null;
let activeBacktestProcesses: ChildProcess[] = [];
let backtestResults: Array<{ symbol: string; status: 'OK' | 'FAILED'; message: string; timing?: string }> = [];

let compareRunning = false;
let compareProgress = '';
let compareSymbol = '';
let compareLastError: string | null = null;
let compareProcess: ChildProcess | null = null;

let activeBotConfig: BotGatewayConfig = {
  masterExecution: true, riskPerTradePct: 1.0, minRr: 1.0, adaptiveMode: false,
  stopOnDailyGoalReached: false, dailyGoalTarget: 5.0, weeklyGoalTarget: 20.0,
  monthlyGoalTarget: 50.0, weeklyDepositBaseline: 10.0, maxDailyTrades: 4,
  trailingStopActive: true, autoBreakevenPips: 15, currency: 'USD',
  updatedAt: new Date().toISOString(), version: 1,
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
      text: `Test larger R:R targets on ${symbol}: best combination is HOLDS.`,
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
  if (all.some(s => s.type === 'RR_EXPANSION')) tests.push('Test larger R:R targets on HOLDS pairs.');
  else tests.push('Run the Strategy Lab on the pairs with the highest PF.');
  return tests.slice(0, 5);
}

function generateExportDataPayload(): any {
  const result: any = {
    generated_at: new Date().toISOString(), days: 60, rr_values: [1.0, 2.0, 3.0],
    total_run_seconds: null, combinations_rollup: {}, pairs: [],
    portfolio_suggestions: [], what_to_test_next: [], portfolio_correlation: null,
    spec_coverage: SPEC_COVERAGE, descriptions: METRIC_DESCRIPTIONS,
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
        combinations: combos, lab: labPayload || null,
        best_combination: {
          ...(bestCombo || {}),
          strategy_kpis: bestReportDetail.strategy_kpis || {},
          dow_kpis: bestReportDetail.dow_kpis || {},
          skipped_summary: bestReportDetail.skipped_summary || {},
          warnings: bestReportDetail.warnings || [],
          adaptive_effective_pct: bestReportDetail.adaptive_effective_pct ?? 100,
          strategy_tune_validate: bestReportDetail.strategy_tune_validate || {},
          tune_validate: bestReportDetail.tune_validate || (bestCombo ? bestCombo.tune_validate : null) || {},
          diagnostics: bestReportDetail.diagnostics || null,
          improvement_tips: bestReportDetail.improvement_tips || [],
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
  return result;
}

function fmt(v: any, decimals = 2): string {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return 'n/a';
  return n.toFixed(decimals);
}

// ---------------------------------------------------------------------------
// PROPOSED: ENTRY CONDITION ANALYSIS (TXT-only section).
// Reads backtest/output/entry_analysis.json, produces a compact block with
// a hard 8,000 character cap and a "n/a - rerun to generate" fallback.
// ---------------------------------------------------------------------------
function renderEntryConditionAnalysis(): string[] {
  const analysisFile = path.resolve(BACKTEST_OUTPUT_DIR, 'entry_analysis.json');
  const header = 'ENTRY CONDITION ANALYSIS (pooled, R:R 1:1, BE off)';

  if (!fs.existsSync(analysisFile)) {
    return [header, '  n/a - rerun to generate'];
  }
  let payload: any;
  try {
    payload = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
  } catch {
    return [header, '  n/a - rerun to generate'];
  }

  const baselines: any[] = Array.isArray(payload.baselines) ? payload.baselines : [];
  const buckets: any[] = Array.isArray(payload.buckets) ? payload.buckets : [];
  const starPairs: any[] = Array.isArray(payload.star_pair_breakdown) ? payload.star_pair_breakdown : [];
  const SECTION_CAP = 8000;

  const fmtR = (v: any): string => (v === null || v === undefined) ? 'n/a' : fmt(v, 2);

  const formatBucketLine = (b: any): string => {
    const star = b.is_star ? '*' : ' ';
    return `${star}[${b.group}] ${b.feature} ${b.bucket}: n=${b.trades} wr=${fmt(b.win_rate, 1)} pf=${fmt(b.profit_factor_1r)} R@1/1.5/2/3=${fmtR(b.avg_r_1)}/${fmtR(b.avg_r_15)}/${fmtR(b.avg_r_2)}/${fmtR(b.avg_r_3)} q>1=${b.quarters_above_1 ?? 0}/4`;
  };

  const buildSection = (includeStarPairs: boolean, restrictBuckets: boolean): string[] => {
    const out: string[] = [];
    out.push(header);
    out.push(`Pooled: ${payload.total_trades ?? 0} trades | Window: ${payload.window_start ?? 'n/a'} to ${payload.window_end ?? 'n/a'}`);

    if (baselines.length > 0) {
      out.push('Baselines:');
      for (const b of baselines) {
        out.push(`  [${b.group}] n=${b.trades} wr=${fmt(b.win_rate, 1)} pf=${fmt(b.profit_factor)} pf@1R=${fmt(b.profit_factor_1r)} q>1=${b.quarters_above_1 ?? 0}/4`);
      }
    }

    if (buckets.length === 0) {
      out.push('  (no buckets meet the minimum trade count)');
      return out;
    }

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
      rows.sort((a, b) => {
        if (a.is_star !== b.is_star) return a.is_star ? -1 : 1;
        return (b.profit_factor_1r ?? 0) - (a.profit_factor_1r ?? 0);
      });
      const omitted = buckets.length - rows.length;
      if (omitted > 0) {
        truncatedNote = `  (truncated to fit the ${SECTION_CAP}-char budget: ${omitted} bucket rows omitted)`;
      }
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

  // Attempt 1: full section.
  let section = buildSection(true, false);
  if (section.join('\n').length <= SECTION_CAP) return section;

  // Attempt 2: restrict buckets to stars + 3 largest deviations per group.
  section = buildSection(true, true);
  if (section.join('\n').length <= SECTION_CAP) return section;

  // Attempt 3: also drop the star cross-pair check.
  section = buildSection(false, true);
  return section;
}

function renderTxtContent(data: any): string {
  const totalTimeStr = (typeof data.total_run_seconds === 'number' && data.total_run_seconds > 0) ? `${data.total_run_seconds}s` : 'n/a';
  const lines: string[] = [];
  const okPairs = (data.pairs || []).filter((p: any) => p.status === 'OK');
  let bestCombo: any = null;
  for (const p of okPairs) for (const c of (p.combinations || [])) {
    if ((c.total_trades || 0) < 30) continue;
    if (!bestCombo || c.profit_factor > bestCombo.pf) bestCombo = { symbol: p.symbol, label: c.label, pf: c.profit_factor, net: c.net_pnl, trades: c.total_trades, verdict: c.holdout_verdict };
  }
  lines.push('AI BRIEF');
  if (bestCombo) lines.push(`Best: ${bestCombo.symbol} ${bestCombo.label} — PF ${fmt(bestCombo.pf)}, P&L $${fmt(bestCombo.net)}, ${bestCombo.trades} trades, ${bestCombo.verdict}.`);
  lines.push('');
  lines.push('LEGEND');
  lines.push('  Six combinations: Adaptive only, BE off/on, R:R 1:1 / 1:2 / 1:3.');
  lines.push('  ENTRY CONDITION ANALYSIS marks a bucket with * when PF@1R is >= baseline + 0.20 AND PF@1R > 1.0 AND it holds in at least 3 of 4 date quarters.');
  lines.push(`RUN: ${data.generated_at.slice(0, 10)} | Days ${data.days} | Time ${totalTimeStr}`);
  lines.push('');
  lines.push('CROSS-PAIR ROLLUP');
  Object.entries(data.combinations_rollup || {}).forEach(([combo, r]: any) => {
    lines.push(`  ${combo.padEnd(24)} | TR ${String(r.total_trades).padStart(5)} | WR ${fmt(r.weighted_win_rate, 1)}% | PNL $${fmt(r.total_pnl)}`);
  });
  lines.push('');
  for (const p of data.pairs || []) {
    if (p.status !== 'OK') { lines.push(`ASSET ${p.symbol} — NOT TESTED`); lines.push(''); continue; }
    const ps = p.phase_seconds || {}; const cache = p.cache || {};
    lines.push('================================================================================');
    lines.push(`ASSET ${p.symbol} | Run Time ${p.seconds_taken || 'n/a'}s | precompute ${ps.precompute_s ?? 'n/a'}s | sim ${ps.simulator_s ?? 'n/a'}s | cache hit ${cache.hits ?? 'n/a'}`);
    lines.push('--- Six Combinations ---');
    for (const c of p.combinations || []) {
      const tv = c.tune_validate || {};
      lines.push(`  ${String(c.label).padEnd(18)} | TR ${String(c.total_trades).padStart(4)} | WR ${fmt(c.win_rate, 1)}% | PF ${fmt(c.profit_factor)} | PNL $${fmt(c.net_pnl)} | TUNE[${tv.tune?.count ?? 0}t PF ${fmt(tv.tune?.profit_factor)}] | VALIDATE[${tv.validate?.count ?? 0}t PF ${fmt(tv.validate?.profit_factor)}] | ${c.holdout_verdict}`);
    }
    const b = p.best_combination || {};
    lines.push('');
    lines.push(`--- Best: ${b.label || 'N/A'} ---`);
    lines.push('Per-strategy:');
    Object.entries(b.strategy_kpis || {}).forEach(([sName, s]: any) => {
      lines.push(`  ${sName.padEnd(28)} | TR ${String(s.count).padStart(3)} | WR ${fmt(s.win_rate, 1)}% | PF ${fmt(s.profit_factor)} | PNL $${fmt(s.net_pnl)}`);
    });
    const skipSummary = b.skipped_summary || {};
    const skipEntries = Object.entries(skipSummary);
    if (skipEntries.length > 0) {
      const parts = skipEntries.map(([reason, val]: [string, any]) => typeof val === 'object' && val !== null ? `${reason}: ${val.candle_skips ?? 0}/${val.unique_setups ?? 0}` : `${reason}: ${val}`);
      lines.push(`Skipped: ${parts.join(' | ')}`);
    }
    const diag = b.diagnostics;
    if (diag) {
      lines.push('');
      lines.push('--- Diagnostics ---');
      if (diag.hour_kpis) {
        const hp: string[] = [];
        for (let h = 0; h < 24; h++) { const k = diag.hour_kpis[String(h)]; if (!k || k.count === 0) continue; hp.push(`${String(h).padStart(2, '0')}:n=${k.count} wr=${fmt(k.win_rate, 1)} pf=${fmt(k.profit_factor)} $${fmt(k.net_pnl)}`); }
        lines.push(`§19 Hour matrix: ${hp.join(' | ')}`);
      }
      const st = diag.streak_analysis || {};
      lines.push(`§31 Streaks: max ${st.max_consecutive_losses ?? 0} | peak DD -$${fmt(st.peak_drawdown)}`);
      const mc = diag.monte_carlo || {};
      lines.push(`§37 Bootstrap MC: median final $${fmt(mc.median_final_pnl)} | median DD -$${fmt(mc.median_max_dd)} | prob pos ${fmt(mc.prob_positive, 1)}%`);
      const bh = diag.buy_and_hold || {};
      lines.push(`§38 Alpha: $${fmt(bh.alpha)} (${bh.verdict})`);
      const slip = diag.slippage_sensitivity || {};
      const slipParts = Object.values(slip).map((pt: any) => `${pt.slippage_pips}p $${fmt(pt.net_pnl)}`).join(' | ');
      if (slipParts) lines.push(`§34 Slippage: ${slipParts}`);
    }
    const suggestions: any[] = b.rule_suggestions || [];
    if (suggestions.length > 0) {
      lines.push('');
      lines.push(`Suggestions for ${p.symbol}:`);
      suggestions.forEach((s: any) => lines.push(`  ${s.tag} ${s.text}`));
    }
    lines.push('');
  }
  if (data.portfolio_correlation) {
    lines.push('PORTFOLIO CORRELATION');
    const pc = data.portfolio_correlation;
    lines.push(`Portfolio DD $${fmt(pc.portfolio_drawdown)} | Div ratio ${fmt(pc.diversification_ratio)}x | avg corr ${fmt(pc.avg_daily_correlation, 3)}`);
    lines.push('');
  }

  // PROPOSED: entry condition analysis block, after the portfolio section.
  lines.push('================================================================================');
  lines.push(...renderEntryConditionAnalysis());
  lines.push('================================================================================');
  lines.push('');

  lines.push('NOT IMPLEMENTED:');
  const notImpl = (data.spec_coverage || []).filter((row: any) => !(row.panel && row.txt && row.pdf));
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

  // ---- market candles, position close ----
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

  // ---- backtest data ----
  app.get('/api/backtest/descriptions', (_req, res) => res.status(200).json({ status: 'success', data: METRIC_DESCRIPTIONS }));
  app.get('/api/backtest/export-data', (_req, res) => {
    try { res.status(200).json({ status: 'success', data: generateExportDataPayload() }); }
    catch (err: any) { res.status(500).json({ status: 'error', message: err?.message }); }
  });
  app.get('/api/backtest/export.txt', (_req, res) => {
    try {
      const txt = renderTxtContent(generateExportDataPayload());
      const dateStr = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="backtest_${dateStr}.txt"`);
      res.status(200).send(txt);
    } catch (err: any) { res.status(500).send(`Export error: ${err?.message}`); }
  });
  // PROPOSED: expose the raw entry_analysis.json so the panel or a curl can verify it.
  app.get('/api/backtest/entry-analysis', (_req, res) => {
    try {
      const analysisFile = path.resolve(BACKTEST_OUTPUT_DIR, 'entry_analysis.json');
      if (fs.existsSync(analysisFile)) {
        return res.status(200).json({ status: 'success', data: JSON.parse(fs.readFileSync(analysisFile, 'utf8')) });
      }
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

  // ---- compare vs reference (frozen old engine in backtest_reference/) ----
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
    const proc = spawn(pythonCmd, ['backtest/compare_engines.py', '--symbol', symbol, '--days', String(days)], {
      env: { ...process.env, PYTHONPATH: process.cwd() },
    });
    compareProcess = proc;

    let stdoutBuf = '';
    proc.stdout.on('data', data => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const raw of lines) {
        const l = raw.trim();
        if (!l) continue;
        if (l.startsWith('[COMPARE]')) { compareProgress = l; console.log(l); }
      }
    });
    let stderrBuf = '';
    proc.stderr.on('data', data => {
      stderrBuf += data.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const raw of lines) if (raw.trimEnd()) console.error(`[COMPARE:ERR] ${raw.trimEnd()}`);
    });
    proc.on('exit', code => {
      compareRunning = false;
      compareProcess = null;
      if (code !== 0) { compareLastError = `Exited with code ${code}`; compareProgress = 'Comparison failed.'; }
      else compareProgress = 'Comparison complete.';
    });
    proc.on('error', err => {
      compareRunning = false;
      compareProcess = null;
      compareLastError = `spawn error: ${err.message}`;
      compareProgress = 'Comparison failed.';
    });

    res.status(200).json({ status: 'success', message: `Comparison started for ${symbol}.`, symbol, days });
  });

  app.get('/api/backtest/compare/status', (_req, res) => {
    let result: any = null;
    if (compareSymbol) {
      const f = path.resolve(BACKTEST_OUTPUT_DIR, `${compareSymbol}_compare.json`);
      if (fs.existsSync(f)) {
        try { result = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      }
    }
    res.status(200).json({
      status: 'success',
      isRunning: compareRunning,
      progress: compareProgress,
      symbol: compareSymbol,
      lastError: compareLastError,
      result,
    });
  });

  app.post('/api/backtest/compare/stop', (_req, res) => {
    if (compareProcess) { try { compareProcess.kill(); } catch {} }
    compareProcess = null;
    compareRunning = false;
    compareProgress = 'Comparison cancelled.';
    res.status(200).json({ status: 'success' });
  });

  // ---- run / status / stop ----
  app.post('/api/backtest/run', (req, res) => {
    if (backtestRunning) return res.status(409).json({ status: 'error', message: 'A backtest is already running.' });
    const memCheck = checkContainerMemory();
    if (!memCheck.ok) return res.status(503).json({ status: 'error', message: memCheck.reason });
    const requested: any = req.body?.symbol ?? 'US30';
    const symbolsArray: string[] = Array.isArray(requested) ? requested.map((s: string) => String(s).toUpperCase()).filter(Boolean) : String(requested).toUpperCase() === 'ALL' ? [...WHITELIST_ASSETS] : [String(requested).toUpperCase()];
    if (symbolsArray.length === 0) return res.status(400).json({ status: 'error', message: 'No symbols supplied.' });
    const days = parseInt(req.body?.days || '60', 10);
    backtestResults = []; activeBacktestProcesses = []; backtestRunning = true;
    backtestProgress = `Initiating backtest matrix for ${symbolsArray.join(', ')}...`;
    backtestLastError = null; backtestExitCode = null;
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const CONCURRENT_PAIRS = 2;

    async function executeMatrix() {
      let activeIndex = 0; let completedCount = 0;
      async function runWorker(sym: string): Promise<void> {
        let symTiming = ''; const stderrTail: string[] = [];
        const args = ['backtest/runner.py', '--symbol', sym, '--days', String(days)];
        await new Promise<void>((resolve) => {
          const proc = spawn(pythonCmd, args, { env: { ...process.env, PYTHONPATH: process.cwd() } });
          activeBacktestProcesses.push(proc);
          proc.stdout.on('data', data => {
            const lines = data.toString().split('\n');
            for (const l of lines) { const t = l.trim(); if (t.startsWith('[time]')) symTiming = t.replace('[time]', '').trim(); }
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
            if (!signal && code === 0) backtestResults.push({ symbol: sym, status: 'OK', message: 'Completed 6/6 matrix', timing: symTiming });
            else backtestResults.push({ symbol: sym, status: 'FAILED', message: `${reason}${tailText}`, timing: symTiming });
            resolve();
          });
          proc.on('error', err => {
            completedCount++;
            backtestResults.push({ symbol: sym, status: 'FAILED', message: `spawn error: ${err.message}` });
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
      backtestProgress = `Finished: ${backtestResults.filter(r => r.status === 'OK').length}/${backtestResults.length} assets completed.`;
    }
    executeMatrix().catch(e => { backtestRunning = false; backtestLastError = e.message; });
    res.status(200).json({ status: 'success', message: `Execution initiated for ${symbolsArray.join(', ')}` });
  });
  app.get('/api/backtest/status', (_req, res) => {
    res.status(200).json({ status: 'success', isRunning: backtestRunning, progress: backtestProgress, lastError: backtestLastError, exitCode: backtestExitCode, results: backtestResults });
  });
  app.post('/api/backtest/stop', (_req, res) => {
    activeBacktestProcesses.forEach(p => { try { p.kill(); } catch {} });
    activeBacktestProcesses = []; backtestRunning = false; backtestProgress = 'Backtest canceled by user.'; backtestLastError = null;
    res.status(200).json({ status: 'success' });
  });

  // ---- storage ----
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

  // ---- journal, bot config, limits, telemetry ----
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

  // ---- JSON 404 for any unmatched /api/* ----
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl}` });
  });

  // ---- SPA fallback ----
  const distPath = path.join(process.cwd(), 'dist');
  if (fs.existsSync(path.join(distPath, 'index.html'))) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  } else {
    const vite = await createViteServer({ server: { middlewareMode: true, host: '0.0.0.0' }, appType: 'spa' });
    app.use(vite.middlewares);
  }

  // ---- Global error handler: JSON for /api/* ----
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