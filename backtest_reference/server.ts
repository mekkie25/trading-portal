import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { spawn, ChildProcess } from 'child_process';
import { METRIC_DESCRIPTIONS, describe } from './shared/metricDescriptions';

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
  riskProfile?: 'Steady' | 'Balanced' | 'Aggressive' | 'Max Growth' | null;
}

interface RiskLimitsConfig {
  maxDailyLossUsd: number;
  maxWeeklyLossUsd: number;
  maxMonthlyLossUsd: number;
  maxDailyDrawdownPct?: number;
  autoLiquidateAllOnTrip?: boolean;
  breakerAction: 'HALT_PREVENT_NEW';
  useProfileDrawdownPct?: boolean;
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

const SPEC_COVERAGE: Array<{ id: number; label: string; panel: boolean; txt: boolean; pdf: boolean; note?: string }> = [
  { id: 1,  label: 'Warm-up and history window',                panel: true,  txt: true,  pdf: true },
  { id: 2,  label: 'Zero-lookahead bar reconstruction',         panel: true,  txt: true,  pdf: true },
  { id: 3,  label: 'MFE / MAE per trade',                       panel: true,  txt: true,  pdf: true },
  { id: 4,  label: 'Profit-first flag',                         panel: false, txt: true,  pdf: true,  note: 'Field exists in trade list, not shown in panel.' },
  { id: 5,  label: 'Post-SL noise recovery',                    panel: true,  txt: true,  pdf: true },
  { id: 6,  label: 'Post-TP extra movement',                    panel: true,  txt: true,  pdf: true },
  { id: 7,  label: 'Premature BE detection',                    panel: true,  txt: true,  pdf: true },
  { id: 8,  label: 'Structural BE variant',                     panel: true,  txt: true,  pdf: true },
  { id: 9,  label: 'EMA-9 / EMA-25 trail variants',             panel: true,  txt: true,  pdf: true },
  { id: 10, label: 'Fixed R:R target with structural room',      panel: true,  txt: true,  pdf: true },
  { id: 11, label: 'Twin-lot vs single-lot execution',          panel: false, txt: true,  pdf: false, note: 'Simulator now uses single order only.' },
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
  { id: 23, label: 'Trail variant comparison',                   panel: true,  txt: true,  pdf: true },
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
  { id: 37, label: 'Monte Carlo resampling',                     panel: true,  txt: true,  pdf: true },
  { id: 38, label: 'Buy-and-hold benchmark (alpha)',             panel: true,  txt: true,  pdf: true },
];

const DATA_DIR = (process.env.DATA_DIR || '').trim() || process.cwd();
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

const BOT_CONFIG_FILE = path.join(DATA_DIR, 'bot_config.json');
const TRADES_DB_FILE = path.join(DATA_DIR, 'trades_db.json');
const CANDLES_CACHE_FILE = path.join(DATA_DIR, 'candles_cache.json');
const CLOSE_COMMAND_FILE = path.join(DATA_DIR, 'close_command.json');
const RISK_STATE_FILE = process.env.RISK_STATE_FILE || path.join(DATA_DIR, 'risk_state.json');

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

let labRunning = false;
let labProgress = '';
let labLastError: string | null = null;
let activeLabProcess: ChildProcess | null = null;
let labResults: Array<{ symbol: string; status: 'OK' | 'FAILED'; message: string }> = [];

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
  useProfileDrawdownPct: true,
};

if (fs.existsSync(BOT_CONFIG_FILE)) {
  try {
    const content = fs.readFileSync(BOT_CONFIG_FILE, 'utf8').trim();
    if (content) {
      const saved = JSON.parse(content);
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
      if (saved.useProfileDrawdownPct !== undefined) {
        riskLimits.useProfileDrawdownPct = Boolean(saved.useProfileDrawdownPct);
      }
    }
  } catch (e) {
    console.error('CRITICAL: Failed to load bot_config.json on startup:', e);
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
    const tempPath = path.join(DATA_DIR, `.tmp_trades_${Date.now()}.json`);
    fs.writeFileSync(tempPath, JSON.stringify(tradesList, null, 2), 'utf8');
    fs.renameSync(tempPath, TRADES_DB_FILE);
  } catch (e) {
    console.error('CRITICAL: Failed to save trades to disk atomically:', e);
  }
}

function loadTradesFromDisk(): any[] {
  try {
    if (fs.existsSync(TRADES_DB_FILE)) {
      const content = fs.readFileSync(TRADES_DB_FILE, 'utf8').trim();
      if (content) {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) return parsed;
        console.error('CRITICAL: trades_db.json is not an array. Refusing to overwrite.');
      }
    }
  } catch (e) {
    console.error('CRITICAL: Failed to read or parse trades_db.json:', e);
  }
  return [];
}

function saveBotConfigAtomically(cfg: any) {
  try {
    const tempPath = path.join(DATA_DIR, `.tmp_bot_config_${Date.now()}.json`);
    fs.writeFileSync(tempPath, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tempPath, BOT_CONFIG_FILE);
  } catch (e) {
    console.error('CRITICAL: Failed to write bot_config.json atomically:', e);
  }
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

let botRestartTimestamps: number[] = [];
let botCrashLoopWarned = false;

function safeReadJson(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Three-state hold-out verdict.
 *   HOLDS        VALIDATE PF >= 1.10 AND VALIDATE PF >= 70% of TUNE PF
 *   FLAT         VALIDATE PF between 0.95 and 1.10
 *   FAILS        VALIDATE PF < 0.95 OR VALIDATE PF < 70% of TUNE PF
 *   INCONCLUSIVE Fewer than 30 trades in TUNE or VALIDATE
 */
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
  const suggestions: Array<{ tag: string; text: string; impact: number; is_measured: boolean; type: string }> = [];
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
      text: `Do not trade ${symbol} with current strategies: produced Profit Factor below 1.0 across all tested combinations (average net loss: -$${avgLoss.toFixed(2)}).`,
      impact: Number(avgLoss.toFixed(2)),
      is_measured: true,
      type: 'PAIR_VIABILITY'
    });
  }

  combos.forEach((c: any) => {
    const tv = c.tune_validate || {};
    const tune = tv.tune || {};
    const val = tv.validate || {};
    const verdict = holdoutVerdict(tune, val);
    if (verdict === 'FAILS') {
      const loss = Math.abs(val.net_pnl || 0);
      suggestions.push({
        tag: `[MEASURED $${loss.toFixed(2)}]`,
        text: `Combination '${c.label}' on ${symbol} FAILS hold-out: TUNE PF ${(tune.profit_factor || 0).toFixed(2)} -> VALIDATE PF ${(val.profit_factor || 0).toFixed(2)} (TUNE ${tune.count || 0} trades / VALIDATE ${val.count || 0} trades).`,
        impact: Number(loss.toFixed(2)),
        is_measured: true,
        type: 'HOLD_OUT_FAIL'
      });
    }
  });

  const stratTv: Record<string, any> = best.strategy_tune_validate || {};
  Object.entries(stratTv).forEach(([sName, tvRow]: [string, any]) => {
    const tune = tvRow?.tune || {};
    const val = tvRow?.validate || {};
    const verdict = holdoutVerdict(tune, val);
    if (verdict === 'FAILS') {
      const loss = Math.abs(val.net_pnl || 0);
      suggestions.push({
        tag: `[MEASURED $${loss.toFixed(2)}]`,
        text: `${sName} on ${symbol} FAILS hold-out: TUNE PF ${(tune.profit_factor || 0).toFixed(2)} -> VALIDATE PF ${(val.profit_factor || 0).toFixed(2)} (TUNE ${tune.count || 0} / VALIDATE ${val.count || 0}).`,
        impact: Number(loss.toFixed(2)),
        is_measured: true,
        type: 'HOLD_OUT_FAIL'
      });
    }
  });

  if (totalTrades < 30) return suggestions;

  const stratKpis = best.strategy_kpis || {};
  const adpCov = best.adaptive_effective_pct ?? 100;

  Object.entries<any>(stratKpis).forEach(([sName, s]) => {
    const count = s.count || 0;
    const pf = s.profit_factor || 0;
    const net = s.net_pnl || 0;
    if (count >= 30 && pf < 1.0 && net < 0) {
      const lossAmt = Math.abs(net);
      suggestions.push({
        tag: `[MEASURED $${lossAmt.toFixed(2)}]`,
        text: `Disable or retune ${sName} on ${symbol}: produced PF ${pf.toFixed(2)} with a net loss of -$${lossAmt.toFixed(2)}.`,
        impact: Number(lossAmt.toFixed(2)),
        is_measured: true,
        type: 'STRATEGY_RETUNE'
      });
    }
  });

  Object.entries<any>(stratKpis).forEach(([sName, s]) => {
    const count = s.count || 0;
    const pf = s.profit_factor || 0;
    const net = s.net_pnl || 0;
    if (count >= 30 && pf >= 1.3 && net > 0) {
      suggestions.push({
        tag: '[TEST NEEDED]',
        text: `Keep ${sName} on ${symbol} as core edge (current contribution: +$${net.toFixed(2)}, PF ${pf.toFixed(2)}) and test increased risk allocation.`,
        impact: 0.0,
        is_measured: false,
        type: 'STRATEGY_EXPAND'
      });
    }
  });

  const dowKpis = best.dow_kpis || {};
  Object.entries<any>(dowKpis).forEach(([dow, d]) => {
    const count = d.count || 0;
    const exp = d.expectancy || 0;
    const net = d.net_pnl || 0;
    if (count >= 30 && (exp < 0 || net < 0)) {
      const lossAmt = Math.abs(net);
      suggestions.push({
        tag: `[MEASURED $${lossAmt.toFixed(2)}]`,
        text: `Avoid entries on ${dow}s for ${symbol}: negative expectancy (${exp.toFixed(2)}R) producing -$${lossAmt.toFixed(2)} in net loss.`,
        impact: Number(lossAmt.toFixed(2)),
        is_measured: true,
        type: 'DAY_FILTER'
      });
    }
  });

  const adpCombos = combos.filter(c => c.mode === 'adaptive' && (c.total_trades || 0) >= 30);
  const legCombos = combos.filter(c => c.mode === 'legacy' && (c.total_trades || 0) >= 30);
  if (adpCombos.length > 0 && legCombos.length > 0) {
    const bestAdp = adpCombos.reduce((b, curr) => curr.profit_factor > b.profit_factor ? curr : b, adpCombos[0]);
    const bestLeg = legCombos.reduce((b, curr) => curr.profit_factor > b.profit_factor ? curr : b, legCombos[0]);
    const gap = bestAdp.profit_factor - bestLeg.profit_factor;
    if (Math.abs(gap) >= 0.20) {
      const diffPnl = Math.abs((bestAdp.net_pnl || 0) - (bestLeg.net_pnl || 0));
      const caution = adpCov < 90.0 ? " (Caution: Adaptive result includes unadapted bars; confirm after the history extension.)" : "";
      if (gap > 0) {
        suggestions.push({
          tag: `[MEASURED $${diffPnl.toFixed(2)}]`,
          text: `Prefer Adaptive Mode over Legacy for ${symbol}: delivers higher PF (${bestAdp.profit_factor.toFixed(2)} vs ${bestLeg.profit_factor.toFixed(2)}) with a +$${diffPnl.toFixed(2)} profit advantage.${caution}`,
          impact: Number(diffPnl.toFixed(2)),
          is_measured: true,
          type: 'MODE_SELECTION'
        });
      } else {
        suggestions.push({
          tag: `[MEASURED $${diffPnl.toFixed(2)}]`,
          text: `Prefer Legacy Mode over Adaptive for ${symbol}: delivers higher PF (${bestLeg.profit_factor.toFixed(2)} vs ${bestAdp.profit_factor.toFixed(2)}) with a +$${diffPnl.toFixed(2)} profit advantage.${caution}`,
          impact: Number(diffPnl.toFixed(2)),
          is_measured: true,
          type: 'MODE_SELECTION'
        });
      }
    }
  }

  const beOffCombos = combos.filter(c => c.be === 'off' && (c.total_trades || 0) >= 30);
  const beOnCombos = combos.filter(c => c.be === 'on' && (c.total_trades || 0) >= 30);
  if (beOffCombos.length > 0 && beOnCombos.length > 0) {
    const bestBeOff = beOffCombos.reduce((b, curr) => curr.profit_factor > b.profit_factor ? curr : b, beOffCombos[0]);
    const bestBeOn = beOnCombos.reduce((b, curr) => curr.profit_factor > b.profit_factor ? curr : b, beOnCombos[0]);

    let trailIdentical = true;
    for (const c1 of combos) {
      if (c1.trail === 'off') {
        const match = combos.find(c2 => c2.mode === c1.mode && c2.be === c1.be && c2.trail === 'on');
        if (match && (match.total_trades !== c1.total_trades || match.net_pnl !== c1.net_pnl)) {
          trailIdentical = false;
          break;
        }
      }
    }

    if (trailIdentical) {
      suggestions.push({
        tag: '[TEST NEEDED]',
        text: `Trail on and Trail off produce identical results on ${symbol} because target or stop boundaries are hit before the trail can engage.`,
        impact: 0.0,
        is_measured: false,
        type: 'TRAIL_ANALYSIS'
      });
    }

    if (Math.abs(bestBeOn.profit_factor - bestBeOff.profit_factor) >= 0.15) {
      const rec = bestBeOn.profit_factor > bestBeOff.profit_factor ? 'Breakeven On' : 'Breakeven Off';
      const better = rec === 'Breakeven On' ? bestBeOn : bestBeOff;
      const worse = rec === 'Breakeven On' ? bestBeOff : bestBeOn;
      const diffPnl = Math.abs(better.net_pnl - worse.net_pnl);
      suggestions.push({
        tag: `[MEASURED $${diffPnl.toFixed(2)}]`,
        text: `Recommend ${rec} for ${symbol}: better profit factor (${better.profit_factor.toFixed(2)} vs ${worse.profit_factor.toFixed(2)}) and lower drawdown (-$${better.max_drawdown.toFixed(2)}).`,
        impact: Number(diffPnl.toFixed(2)),
        is_measured: true,
        type: 'BE_TUNING'
      });
    }
  }

  const skipSummary = best.skipped_summary || {};
  let totalUniqueSkips = 0;
  if (typeof skipSummary === 'object' && skipSummary !== null) {
    Object.values<any>(skipSummary).forEach(val => {
      const uCnt = typeof val === 'object' && val !== null ? (val.unique_setups || 0) : (typeof val === 'number' ? val : 0);
      totalUniqueSkips += uCnt;
    });
    if (totalUniqueSkips >= 30) {
      Object.entries<any>(skipSummary).forEach(([reason, val]) => {
        const uCnt = typeof val === 'object' && val !== null ? (val.unique_setups || 0) : (typeof val === 'number' ? val : 0);
        const cCnt = typeof val === 'object' && val !== null ? (val.candle_skips || uCnt) : uCnt;
        const pct = (uCnt / totalUniqueSkips) * 100;
        if (pct >= 30.0) {
          suggestions.push({
            tag: '[TEST NEEDED]',
            text: `Test looser limits for '${reason}' on ${symbol}: accounts for ${uCnt} of ${totalUniqueSkips} unique skipped setups (${pct.toFixed(0)}% of unique skips, ${cCnt} candle-skips).`,
            impact: 0.0,
            is_measured: false,
            type: 'SKIP_TUNING'
          });
        }
      });
    }
  }

  if (adpCov < 90.0) {
    suggestions.push({
      tag: '[TEST NEEDED]',
      text: `Adaptive results for ${symbol} include unadapted bars (${adpCov.toFixed(1)}% coverage); extend stored history to 500 days for full warmup.`,
      impact: 0.0,
      is_measured: false,
      type: 'DATA_WARMUP'
    });
  }

  // ------------------------------------------------------------------
  // Rule 9: Estimated cost drag in R per trade
  // ------------------------------------------------------------------
  try {
    const wr = Number(best.win_rate || 0);
    const exp = Number(best.expectancy || 0);
    const w = Math.max(0.0, Math.min(100.0, wr)) / 100.0;
    const expectedAt1to1 = (w * 1.0) - ((1.0 - w) * 1.0);
    const gapR = expectedAt1to1 - exp;
    if (gapR > 0.07) {
      suggestions.push({
        tag: `[MEASURED ${gapR.toFixed(2)}R]`,
        text: `Estimated cost drag of ${gapR.toFixed(2)}R per trade on ${symbol} at ${wr.toFixed(1)}% win rate. Add a spread filter or a minimum-stop filter on the affected strategies.`,
        impact: 0.0,
        is_measured: true,
        type: 'COST_DRAG'
      });
    }
  } catch {}

  // ------------------------------------------------------------------
  // Rule 10: Trailing cuts winners without improving profit
  // ------------------------------------------------------------------
  try {
    for (const c of combos) {
      if (c.trail !== 'off') continue;
      if ((c.total_trades || 0) < 30) continue;
      const trailOn = combos.find(x => x.mode === c.mode && x.be === c.be && x.trail === 'on');
      if (!trailOn || (trailOn.total_trades || 0) < 30) continue;
      const wrDrop = Number(c.win_rate || 0) - Number(trailOn.win_rate || 0);
      const pfDiff = Math.abs(Number(trailOn.profit_factor || 0) - Number(c.profit_factor || 0));
      if (wrDrop >= 5.0 && pfDiff < 0.05) {
        suggestions.push({
          tag: '[TEST NEEDED]',
          text: `Trailing lowers the win rate on ${symbol} by ${wrDrop.toFixed(1)} points (${c.mode} · BE ${c.be}) but PF changes by only ${pfDiff.toFixed(2)}. Trailing is cutting winners without improving profit.`,
          impact: 0.0,
          is_measured: false,
          type: 'TRAIL_CUTTING'
        });
        break;
      }
    }
  } catch {}

  // ------------------------------------------------------------------
  // Rule 11: R:R expansion on HOLDS
  // ------------------------------------------------------------------
  const bestTv = best.tune_validate || {};
  const bestVerdict = holdoutVerdict(bestTv.tune, bestTv.validate);
  if (bestVerdict === 'HOLDS' && totalTrades >= 30) {
    suggestions.push({
      tag: '[TEST NEEDED]',
      text: `Test target R:R 1.5 and 2.0 on ${symbol}: the best combination is HOLDS, so R:R expansion is worth testing.`,
      impact: 0.0,
      is_measured: false,
      type: 'RR_EXPANSION'
    });
  }

  const measured = suggestions.filter(s => s.is_measured);
  const testNeeded = suggestions.filter(s => !s.is_measured);
  measured.sort((a, b) => b.impact - a.impact);

  return [...measured, ...testNeeded];
}

function computePortfolioNextTests(allSuggestions: Array<{ tag: string; text: string; impact: number; is_measured: boolean; type: string }>): string[] {
  const tests: string[] = [];
  const retunes = allSuggestions.filter(s => s.type === 'STRATEGY_RETUNE');
  if (retunes.length > 0) tests.push(`Retest matrix with underperforming setups disabled (${retunes[0].text.split(':')[0]}).`);
  const days = allSuggestions.filter(s => s.type === 'DAY_FILTER');
  if (days.length > 0) tests.push(`Implement weekday blackout filter based on negative expectancy days (${days[0].text.split(':')[0]}).`);
  const bes = allSuggestions.filter(s => s.type === 'BE_TUNING');
  if (bes.length > 0) tests.push(`Lock in the statistically dominant Breakeven policy across validated pairs.`);
  const skips = allSuggestions.filter(s => s.type === 'SKIP_TUNING');
  if (skips.length > 0) tests.push(`Run simulation with loosened daily cap and spread tolerance to test whether skipped setups hold edge.`);
  const costItems = allSuggestions.filter(s => s.type === 'COST_DRAG');
  if (costItems.length > 0) tests.push(`Add a spread or minimum-stop filter on the pairs showing a measured cost drag above 0.07R per trade.`);
  const trailCuts = allSuggestions.filter(s => s.type === 'TRAIL_CUTTING');
  if (trailCuts.length > 0) tests.push(`Retest with trailing disabled on the pairs where it cuts winners without improving profit factor.`);
  const rrItems = allSuggestions.filter(s => s.type === 'RR_EXPANSION');
  if (rrItems.length > 0) {
    tests.push(`Test target R:R 1.5 and 2.0 on any pair whose best combination is HOLDS.`);
  } else {
    tests.push(`Run the Strategy Lab on the pairs with the highest PF to find a variant that holds out.`);
  }
  return tests.slice(0, 5);
}

/**
 * Builds the full export payload: every pair, every combination, best-combination
 * detail (including diagnostics, TUNE/VALIDATE, hold-out verdict, skipped signals,
 * warnings, run times), portfolio correlation, variants, strategy lab, ranked
 * suggestions.
 */
function generateExportDataPayload(): any {
  const result: any = {
    generated_at: new Date().toISOString(),
    days: 60,
    target_rr: 1.0,
    total_run_seconds: null,
    combinations_rollup: {},
    pairs: [],
    portfolio_suggestions: [],
    what_to_test_next: [],
    portfolio_correlation: null,
    spec_coverage: SPEC_COVERAGE,
    descriptions: METRIC_DESCRIPTIONS,
  };

  const allSummaryCombos: Record<string, { trades: number; pnl: number; win_count: number }> = {};
  let totalTime = 0.0;
  let hasValidTimes = false;
  const allPortfolioSuggestions: Array<{ tag: string; text: string; impact: number; is_measured: boolean; type: string }> = [];

  const portfolioFile = path.resolve(BACKTEST_OUTPUT_DIR, 'portfolio_correlation.json');
  const portfolio = safeReadJson(portfolioFile);
  if (portfolio) result.portfolio_correlation = portfolio;

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

      const pairSeconds = (typeof summary.total_seconds === 'number' && summary.total_seconds > 0) ? summary.total_seconds : null;
      if (pairSeconds !== null) {
        totalTime += pairSeconds;
        hasValidTimes = true;
      }

      const combos: any[] = summary.combinations || [];

      combos.forEach(c => {
        const tv = c.tune_validate || {};
        c.holdout_verdict = holdoutVerdict(tv.tune, tv.validate);

        if (!allSummaryCombos[c.label]) {
          allSummaryCombos[c.label] = { trades: 0, pnl: 0, win_count: 0 };
        }
        allSummaryCombos[c.label].trades += c.total_trades || 0;
        allSummaryCombos[c.label].pnl += c.net_pnl || 0;
        allSummaryCombos[c.label].win_count += Math.round(((c.win_rate || 0) / 100) * (c.total_trades || 0));
      });

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

      const variantFile = path.resolve(BACKTEST_OUTPUT_DIR, `${sym}_variants.json`);
      const variantsPayload = safeReadJson(variantFile);

      const labFile = path.resolve(BACKTEST_OUTPUT_DIR, `${sym}_lab.json`);
      const labPayload = safeReadJson(labFile);

      const pairPayload: any = {
        symbol: sym,
        status: "OK",
        seconds_taken: pairSeconds,
        phase_seconds: (summary as any).phase_seconds || null,
        cpu_cores: (summary as any).cpu_cores || null,
        concurrent_processes: (summary as any).concurrent_processes || null,
        combinations: combos,
        variants: variantsPayload?.variants || null,
        lab: labPayload || null,
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
          run_settings: bestReportDetail.run_settings || '',
          funnel: bestReportDetail.funnel || null,
          vol_block_reasons: bestReportDetail.vol_block_reasons || null,
          rejection_stats: bestReportDetail.rejection_stats || null,
          generated_at: bestReportDetail.generated_at || null,
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
      total_trades: s.trades,
      total_pnl: Number(s.pnl.toFixed(2)),
      weighted_win_rate: s.trades > 0 ? Number(((s.win_count / s.trades) * 100).toFixed(1)) : 0
    };
  });
  result.combinations_rollup = rollup;

  return result;
}

// -----------------------------------------------------------------------------
// TXT export
// -----------------------------------------------------------------------------

function fmt(v: any, decimals = 2): string {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return 'n/a';
  return n.toFixed(decimals);
}

function buildAiBrief(data: any): string[] {
  const lines: string[] = [];
  const okPairs = (data.pairs || []).filter((p: any) => p.status === 'OK');
  const failedPairs = (data.pairs || []).filter((p: any) => p.status !== 'OK');

  let bestCombo: any = null;
  for (const p of okPairs) {
    for (const c of (p.combinations || [])) {
      if ((c.total_trades || 0) < 30) continue;
      if (!bestCombo || c.profit_factor > bestCombo.pf) {
        bestCombo = { symbol: p.symbol, label: c.label, pf: c.profit_factor, net: c.net_pnl, trades: c.total_trades, wr: c.win_rate, verdict: c.holdout_verdict };
      }
    }
  }

  let worstCombo: any = null;
  for (const p of okPairs) {
    for (const c of (p.combinations || [])) {
      if ((c.total_trades || 0) < 30) continue;
      if (!worstCombo || c.profit_factor < worstCombo.pf) {
        worstCombo = { symbol: p.symbol, label: c.label, pf: c.profit_factor, net: c.net_pnl, trades: c.total_trades };
      }
    }
  }

  const holds: string[] = [];
  const flat: string[] = [];
  const fails: string[] = [];
  for (const p of okPairs) {
    for (const c of (p.combinations || [])) {
      const v = c.holdout_verdict || 'INCONCLUSIVE';
      if (v === 'HOLDS') holds.push(`${p.symbol}/${c.label}`);
      else if (v === 'FLAT') flat.push(`${p.symbol}/${c.label}`);
      else if (v === 'FAILS') fails.push(`${p.symbol}/${c.label}`);
    }
  }

  const labImprovers: string[] = [];
  for (const p of okPairs) {
    if (!p.lab || !Array.isArray(p.lab.variants)) continue;
    for (const v of p.lab.variants) {
      if (v.verdict === 'IMPROVES') labImprovers.push(`${p.symbol}/${v.label}`);
    }
  }

  lines.push(`AI BRIEF`);
  if (bestCombo) lines.push(`Best combination: ${bestCombo.symbol} ${bestCombo.label} — PF ${fmt(bestCombo.pf)}, WR ${fmt(bestCombo.wr, 1)}%, P&L $${fmt(bestCombo.net)}, ${bestCombo.trades} trades, ${bestCombo.verdict || 'n/a'}.`);
  if (worstCombo) lines.push(`Worst qualifying combination: ${worstCombo.symbol} ${worstCombo.label} — PF ${fmt(worstCombo.pf)}, P&L $${fmt(worstCombo.net)}, ${worstCombo.trades} trades.`);
  if (failedPairs.length > 0) lines.push(`Pairs not tested: ${failedPairs.map((p: any) => p.symbol).join(', ')}.`);
  if (holds.length > 0) lines.push(`HOLDS on hold-out (${holds.length}): ${holds.slice(0, 5).join('; ')}${holds.length > 5 ? ` (+${holds.length - 5} more)` : ''}.`);
  if (flat.length > 0) lines.push(`FLAT (no real edge either way) on hold-out (${flat.length}): ${flat.slice(0, 4).join('; ')}${flat.length > 4 ? ` (+${flat.length - 4} more)` : ''}.`);
  if (fails.length > 0) lines.push(`FAILS on hold-out (${fails.length}): ${fails.slice(0, 5).join('; ')}${fails.length > 5 ? ` (+${fails.length - 5} more)` : ''}.`);
  if (labImprovers.length > 0) lines.push(`Strategy Lab IMPROVES variants: ${labImprovers.slice(0, 5).join('; ')}${labImprovers.length > 5 ? ` (+${labImprovers.length - 5} more)` : ''}.`);
  if (data.portfolio_correlation) {
    lines.push(`Portfolio avg daily correlation: ${fmt(data.portfolio_correlation.avg_daily_correlation, 3)}; diversification ratio ${fmt(data.portfolio_correlation.diversification_ratio, 2)}x.`);
  }
  lines.push('');
  lines.push('STANDING INSTRUCTION TO THE AI READING THIS FILE:');
  lines.push('Review this backtest. Suggest concrete improvements to the strategies and to how the bot uses trends,');
  lines.push('session hours, stops, breakeven and trailing. Use only numbers in this file. Treat anything under 30 trades');
  lines.push('as inconclusive. Prefer changes that hold on the VALIDATE data. HOLDS is the only verdict worth promoting.');
  lines.push('FLAT means no real edge either way. FAILS means do not promote.');
  lines.push('');
  return lines;
}

function buildToc(data: any): string[] {
  const lines: string[] = [];
  lines.push('TABLE OF CONTENTS');
  lines.push('  AI BRIEF');
  lines.push('  LEGEND');
  lines.push('  CROSS-PAIR ROLLUP');
  for (const p of data.pairs || []) {
    lines.push(`  ASSET ${p.symbol} — 8 combos, per-strategy, per-weekday, hour matrix, rollover, ATR tiers, trade-path §16-18, BE variants §22, sizing §24, caps §25, streak §31, breaker §32, DD cutoff §33, slippage §34, param sweep §35, outliers §36, MC §37, alpha §38, skipped signals${p.lab ? ', STRATEGY LAB' : ''}`);
  }
  lines.push('  PORTFOLIO CORRELATION');
  lines.push('  RANKED SUGGESTIONS');
  lines.push('  NOT IMPLEMENTED');
  lines.push('');
  return lines;
}

function summarizeHourMatrix(hourKpis: any): string {
  if (!hourKpis) return 'n/a';
  const parts: string[] = [];
  for (let h = 0; h < 24; h++) {
    const k = hourKpis[String(h)];
    if (!k || k.count === 0) continue;
    parts.push(`${String(h).padStart(2, '0')}:n=${k.count} wr=${fmt(k.win_rate, 1)} pf=${fmt(k.profit_factor)} $${fmt(k.net_pnl)}`);
  }
  return parts.length > 0 ? parts.join(' | ') : 'no trades in any hour';
}

function renderStrategyLab(lab: any, compact: boolean): string[] {
  if (!lab || !Array.isArray(lab.variants) || lab.variants.length === 0) return [];
  const lines: string[] = [];
  lines.push('');
  lines.push(`--- STRATEGY LAB (${lab.variants.length} variants, ${lab.days}-day window) ---`);
  if (!compact) {
    lines.push(`Window: ${lab.window_start} to ${lab.window_end}`);
  }
  const sorted = [...lab.variants].sort((a: any, b: any) => {
    const rank = (v: string) => v === 'IMPROVES' ? 0 : v === 'NO' ? 1 : 2;
    return rank(a.verdict) - rank(b.verdict);
  });
  for (const v of sorted) {
    lines.push(`  ${String(v.label).padEnd(28)} | TR ${String(v.trades).padStart(4)} | WR ${fmt(v.win_rate, 1)}% | PF ${fmt(v.profit_factor)} | DD -$${fmt(v.max_drawdown)} | PNL $${fmt(v.net_pnl)} | TUNE PF ${fmt(v.tune_pf)} (${v.tune_trades}tr) | VALIDATE PF ${fmt(v.validate_pf)} (${v.validate_trades}tr) | ${v.verdict}`);
  }
  return lines;
}

function renderTxtContent(data: any, options: { maxSuggestionsPerPair?: number; minDowTrades?: number; compact?: boolean } = {}): string {
  const maxSugg = options.maxSuggestionsPerPair ?? 999;
  const minDow = options.minDowTrades ?? 0;
  const compact = options.compact ?? false;

  const totalTimeStr = (typeof data.total_run_seconds === 'number' && data.total_run_seconds > 0) ? `${data.total_run_seconds}s` : 'n/a';

  const lines: string[] = [];

  lines.push(...buildAiBrief(data));
  lines.push(...buildToc(data));

  lines.push('LEGEND');
  lines.push('  TR=Trades, WR=WinRate%, EXP=Expectancy(R), PF=ProfitFactor, DD=MaxDrawdown$');
  lines.push('  PNL=Net Realised $, COV=AdaptiveCover%, TUNE=first 70% window, VALIDATE=last 30% window');
  lines.push('  HOLDS = VALIDATE PF >= 1.10 and >= 70% of TUNE. FLAT = VALIDATE PF 0.95-1.10 (no real edge either way).');
  lines.push('  FAILS = VALIDATE PF < 0.95 or < 70% of TUNE. INCONCLUSIVE = fewer than 30 trades in TUNE or VALIDATE.');
  lines.push(`RUN: Date ${data.generated_at.slice(0, 10)} | Days ${data.days} | Target R:R 1:${data.target_rr} | Total Run Time ${totalTimeStr}`);

  let coresSeen: number | null = null;
  let concurrentSeen: number | null = null;
  for (const p of (data.pairs || [])) {
    if (p?.cpu_cores && coresSeen === null) coresSeen = p.cpu_cores;
    if (p?.concurrent_processes && concurrentSeen === null) concurrentSeen = p.concurrent_processes;
  }
  lines.push(`HOST: CPU cores ${coresSeen ?? 'n/a'} | Pair processes concurrent ${concurrentSeen ?? 'n/a'}`);
  lines.push('');

  lines.push('CROSS-PAIR ROLLUP');
  Object.entries(data.combinations_rollup || {}).forEach(([combo, r]: any) => {
    lines.push(`  ${combo.padEnd(34)} | TR ${String(r.total_trades).padStart(5)} | WR ${fmt(r.weighted_win_rate, 1).padStart(5)}% | PNL $${fmt(r.total_pnl)}`);
  });
  lines.push('');

  for (const p of data.pairs || []) {
    if (p.status !== 'OK') {
      lines.push(`ASSET ${p.symbol} — NOT TESTED — ${p.error || 'unknown error'}`);
      lines.push('');
      continue;
    }

    const runTimeStr = (typeof p.seconds_taken === 'number' && p.seconds_taken > 0) ? `${p.seconds_taken}s` : 'n/a';
    const ps = p.phase_seconds || {};
    const phaseStr = `agg ${ps.aggregator_s ?? 'n/a'}s | vol ${ps.volatility_s ?? 'n/a'}s | levels ${ps.session_levels_s ?? 'n/a'}s | strat ${ps.strategies_s ?? 'n/a'}s | sim ${ps.simulator_s ?? 'n/a'}s | report ${ps.report_writing_s ?? 'n/a'}s`;

    lines.push('================================================================================');
    lines.push(`ASSET ${p.symbol} | Run Time ${runTimeStr} | ${phaseStr}`);
    lines.push('--- 8 Combinations ---');

    for (const c of p.combinations || []) {
      const incon = (c.total_trades || 0) < 30 ? ' [INCONCLUSIVE]' : '';
      const tv = c.tune_validate || {};
      const tune = tv.tune || {};
      const val = tv.validate || {};
      lines.push(
        `  ${String(c.label).padEnd(32)} | TR ${String(c.total_trades).padStart(4)} | WR ${fmt(c.win_rate, 1)}% | EXP ${fmt(c.expectancy)}R | PF ${fmt(c.profit_factor)} | DD -$${fmt(c.max_drawdown)} | PNL $${fmt(c.net_pnl)} | COV ${fmt(c.adaptive_effective_pct, 0)}% | TUNE[TR ${tune.count ?? 0} PF ${fmt(tune.profit_factor)} WR ${fmt(tune.win_rate, 1)}%] | VALIDATE[TR ${val.count ?? 0} PF ${fmt(val.profit_factor)} WR ${fmt(val.win_rate, 1)}%] | ${c.holdout_verdict || 'INCONCLUSIVE'}${incon}`
      );
    }

    const b = p.best_combination || {};
    lines.push('');
    lines.push(`--- Best Combination: ${b.label || 'N/A'} (${b.total_trades || 0} trades) ---`);

    // ALWAYS print the per-strategy table.
    lines.push('Per-strategy:');
    const bStv: Record<string, any> = b.strategy_tune_validate || {};
    const stratEntries = Object.entries(b.strategy_kpis || {});
    if (stratEntries.length === 0) {
      lines.push('  (n/a - rerun to generate)');
    } else {
      stratEntries.forEach(([sName, s]: any) => {
        const stv = bStv[sName] || {};
        const tune = stv.tune || {};
        const val = stv.validate || {};
        const verdict = holdoutVerdict(tune, val);
        lines.push(
          `  ${sName.padEnd(28)} | TR ${String(s.count).padStart(3)} | WR ${fmt(s.win_rate, 1)}% | PF ${fmt(s.profit_factor)} | PNL $${fmt(s.net_pnl)} | TUNE[TR ${tune.count ?? 0} PF ${fmt(tune.profit_factor)}] | VALIDATE[TR ${val.count ?? 0} PF ${fmt(val.profit_factor)}] | ${verdict}`
        );
      });
    }

    // ALWAYS print the per-weekday table.
    lines.push(`Per-weekday (>= ${minDow} trades):`);
    const dowEntries = Object.entries(b.dow_kpis || {});
    if (dowEntries.length === 0) {
      lines.push('  (n/a - rerun to generate)');
    } else {
      let printed = 0;
      dowEntries.forEach(([dow, s]: any) => {
        if ((s.count || 0) < minDow) return;
        printed++;
        lines.push(`  ${dow.padEnd(12)} | TR ${String(s.count).padStart(3)} | WR ${fmt(s.win_rate, 1)}% | EXP ${fmt(s.expectancy)}R | PF ${fmt(s.profit_factor)} | PNL $${fmt(s.net_pnl)}`);
      });
      if (printed === 0) lines.push('  (no weekday rows met the trade threshold)');
    }

    // ALWAYS print the skipped-signal summary.
    const skipSummary = b.skipped_summary || {};
    const skipEntries = Object.entries(skipSummary);
    if (skipEntries.length > 0) {
      const parts = skipEntries.map(([reason, val]: [string, any]) => {
        if (typeof val === 'object' && val !== null) {
          return `${reason}: ${val.candle_skips ?? 0} candles / ${val.unique_setups ?? 0} unique setups`;
        }
        return `${reason}: ${val} candles`;
      });
      lines.push(`Skipped signals: ${parts.join(' | ')}`);
    } else {
      lines.push(`Skipped signals: n/a - rerun to generate`);
    }

    if (b.warnings && b.warnings.length > 0) {
      lines.push(`Warnings: ${b.warnings.join(' | ')}`);
    }

    // ALWAYS print the diagnostics block. Compact only collapses detail.
    const diag = b.diagnostics;
    if (diag) {
      lines.push('');
      lines.push(`--- Diagnostics (${diag.version || 'n/a'}) ---`);
      lines.push(`§19 Hour matrix: ${summarizeHourMatrix(diag.hour_kpis)}`);

      if (diag.session_rollover) {
        const it = diag.session_rollover.in_transition || {};
        const ot = diag.session_rollover.out_of_transition || {};
        lines.push(`§21 Rollover: in TR ${it.count ?? 0} PF ${fmt(it.profit_factor)} $${fmt(it.net_pnl)} | out TR ${ot.count ?? 0} PF ${fmt(ot.profit_factor)} $${fmt(ot.net_pnl)}`);
      }

      if (diag.atr_tier_kpis) {
        const tierStr = ['LOW', 'NORMAL', 'HIGH', 'UNKNOWN']
          .map(t => {
            const k = diag.atr_tier_kpis[t];
            if (!k || k.count === 0) return `${t}: none`;
            return `${t}: TR ${k.count} WR ${fmt(k.win_rate, 1)}% PF ${fmt(k.profit_factor)} $${fmt(k.net_pnl)}`;
          })
          .join(' | ');
        lines.push(`§26 ATR tiers: ${tierStr}`);
      }

      const st = diag.streak_analysis || {};
      lines.push(`§31 Streaks: max ${st.max_consecutive_losses ?? 0} | avg ${fmt(st.average_streak)} | peak DD -$${fmt(st.peak_drawdown)} | recovery ${st.recovery_trades_from_peak_dd ?? 0} trades`);

      const cb = diag.circuit_breaker_sim || {};
      lines.push(`§32 Breaker sim: orig $${fmt(cb.original_net_pnl)} -> sim $${fmt(cb.simulated_net_pnl)} | halved ${cb.trades_halved ?? 0} | protection $${fmt(cb.protection_delta)}`);

      const or = diag.outlier_removal || {};
      lines.push(`§36 Outliers: drop ${or.outlier_count ?? 0} top trades | impact ${fmt(or.impact_pct, 1)}% | full $${fmt(or.full?.net_pnl)} -> trimmed $${fmt(or.trimmed?.net_pnl)}`);

      const mc = diag.monte_carlo || {};
      lines.push(`§37 Monte Carlo: median DD -$${fmt(mc.median_max_dd)} | P5 -$${fmt(mc.p5_max_dd)} | P95 -$${fmt(mc.p95_max_dd)} | prob positive ${fmt(mc.prob_positive, 1)}%`);

      const bh = diag.buy_and_hold || {};
      lines.push(`§38 Alpha: hold ${fmt(bh.bh_return_pct)}% $${fmt(bh.bh_net_pnl)} | strat $${fmt(bh.strategy_net_pnl)} | alpha $${fmt(bh.alpha)} | verdict ${bh.verdict}`);

      const ps16 = diag.post_sl || {};
      if (ps16.count > 0) {
        lines.push(`§16 Post-SL: n=${ps16.count} mean ${fmt(ps16.mean_pips, 1)} pips | max ${fmt(ps16.max_pips, 1)} pips | recovered ${ps16.recovered_count} (${fmt(ps16.recovered_pct, 1)}%)`);
      } else {
        lines.push(`§16 Post-SL: n/a - rerun to generate`);
      }
      const pt = diag.post_tp || {};
      if (pt.count > 0) {
        lines.push(`§17 Post-TP: n=${pt.count} mean ${fmt(pt.mean_pips, 1)} pips | avg missed ${fmt(pt.avg_missed_r)}R`);
      } else {
        lines.push(`§17 Post-TP: n/a - rerun to generate`);
      }
      const pbe = diag.premature_be || {};
      if (pbe.total_be_moved > 0) {
        lines.push(`§18 Premature BE: moved ${pbe.total_be_moved} | premature ${pbe.premature_count} (${fmt(pbe.premature_pct, 1)}%) | missed ${fmt(pbe.total_missed_r)}R`);
      } else {
        lines.push(`§18 Premature BE: n/a - rerun to generate`);
      }

      const ema = diag.ema_200_alignment || {};
      if (ema.aligned || ema.counter_trend) {
        lines.push(`§27 EMA-200 alignment: aligned TR ${ema.aligned?.count ?? 0} PF ${fmt(ema.aligned?.profit_factor)} | counter TR ${ema.counter_trend?.count ?? 0} PF ${fmt(ema.counter_trend?.profit_factor)}`);
      }

      const ct = diag.confirmation_type || {};
      lines.push(`§28 Confirmation: close TR ${ct.close?.count ?? 0} PF ${fmt(ct.close?.profit_factor)} | touch TR ${ct.touch?.count ?? 0} PF ${fmt(ct.touch?.profit_factor)}`);

      const nw = diag.news_window || {};
      lines.push(`§29 News: inside TR ${nw.in_news?.count ?? 0} PF ${fmt(nw.in_news?.profit_factor)} | outside TR ${nw.out_of_news?.count ?? 0} PF ${fmt(nw.out_of_news?.profit_factor)}`);

      const sz = diag.sizing_comparison || {};
      lines.push(`§24 Sizing: fixed $${fmt(sz.fixed?.net_pnl)} | compounding $${fmt(sz.compounding?.net_pnl)} | diff $${fmt(sz.difference)}`);

      const dc = diag.daily_cap_comparison || {};
      lines.push(`§25 Daily caps: cap1 TR ${dc.cap_1?.count ?? 0} PNL $${fmt(dc.cap_1?.net_pnl)} | cap2 $${fmt(dc.cap_2?.net_pnl)} | cap4 $${fmt(dc.cap_4?.net_pnl)} | unlimited $${fmt(dc.unlimited?.net_pnl)}`);

      const dd = diag.daily_dd_cutoff || {};
      lines.push(`§33 DD cutoff: triggered ${dd.days_triggered ?? 0} days | blocked ${dd.trades_blocked ?? 0} trades | protection $${fmt(dd.protection_delta)}`);

      const slip = diag.slippage_sensitivity || {};
      const slipParts = Object.values(slip).map((pt: any) => `${pt.slippage_pips}p $${fmt(pt.net_pnl)}`).join(' | ');
      if (slipParts) lines.push(`§34 Slippage: ${slipParts}`);

      const bv = diag.breakeven_variants || {};
      if (bv.A_current) {
        lines.push(`§22 BE variants: A(current) ${fmt(bv.A_current.total_r)}R | B(no BE) ${fmt(bv.B_no_be.total_r)}R | C(delayed) ${fmt(bv.C_delayed_be.total_r)}R | best ${bv.best_variant} | ${bv.verdict}`);
      } else {
        lines.push(`§22 BE variants: n/a - rerun to generate`);
      }

      const param = diag.parameter_sensitivity || {};
      if (Array.isArray(param.sweep) && param.sweep.length > 0) {
        const sweepStr = param.sweep.map((row: any) => `R:R ${fmt(row.rr, 2)} $${fmt(row.net_pnl)}`).join(' | ');
        lines.push(`§35 Parameter sweep: ${sweepStr} | best ${fmt(param.best_rr, 2)} | ${param.verdict}`);
      } else {
        lines.push(`§35 Parameter sweep: n/a - rerun to generate`);
      }
    } else {
      lines.push('');
      lines.push(`--- Diagnostics ---`);
      lines.push(`n/a - rerun to generate (older report lacks the diagnostics block)`);
    }

    const tips: any[] = b.improvement_tips || [];
    if (tips.length > 0) {
      lines.push('');
      lines.push('Improvement tips (from trade list):');
      tips.forEach((tip: any) => {
        lines.push(`  [${tip.severity}] ${tip.strategy} — ${tip.title} | Action: ${tip.action}`);
      });
    }

    const suggestions: any[] = b.rule_suggestions || [];
    if (suggestions.length > 0) {
      lines.push('');
      lines.push(`Rule-based suggestions for ${p.symbol} (ranked, impact first):`);
      suggestions.slice(0, maxSugg).forEach((s: any) => {
        lines.push(`  ${s.tag} ${s.text}`);
      });
    }

    // Strategy Lab per pair
    const labLines = renderStrategyLab(p.lab, compact);
    if (labLines.length > 0) {
      lines.push(...labLines);
    }

    lines.push('');
  }

  if (data.portfolio_correlation) {
    lines.push('================================================================================');
    lines.push('PORTFOLIO CORRELATION');
    const pc = data.portfolio_correlation;
    lines.push(`Symbols: ${(pc.symbols || []).join(', ')}`);
    lines.push(`Portfolio max DD $${fmt(pc.portfolio_drawdown)} | Sum of individual DDs $${fmt(pc.sum_of_individual_drawdowns)} | Diversification ratio ${fmt(pc.diversification_ratio)}x | avg daily correlation ${fmt(pc.avg_daily_correlation, 3)} | days ${pc.days}`);
    lines.push(`Trade counts: ${Object.entries(pc.trade_counts || {}).map(([s, c]) => `${s}=${c}`).join(' | ')}`);
    lines.push('');
  }

  if (data.portfolio_suggestions && data.portfolio_suggestions.length > 0) {
    lines.push('================================================================================');
    lines.push('RANKED PORTFOLIO SUGGESTIONS');
    data.portfolio_suggestions.forEach((s: any) => {
      lines.push(`  ${s.tag} ${s.text}`);
    });
    lines.push('');
  }

  if (data.what_to_test_next && data.what_to_test_next.length > 0) {
    lines.push('================================================================================');
    lines.push('WHAT TO TEST NEXT:');
    data.what_to_test_next.forEach((item: string, idx: number) => {
      lines.push(`  ${idx + 1}. ${item}`);
    });
    lines.push('');
  }

  lines.push('================================================================================');
  lines.push('NOT IMPLEMENTED IN THE BACKTESTER');
  const notImpl = (data.spec_coverage || []).filter((row: any) => !(row.panel && row.txt && row.pdf));
  if (notImpl.length === 0) {
    lines.push('  (none — every specification item is produced by the panel, the TXT and the PDF.)');
  } else {
    notImpl.forEach((row: any) => {
      lines.push(`  #${row.id} ${row.label} — ${row.note || 'not produced'}`);
    });
  }
  lines.push('================================================================================');

  return lines.join('\n');
}

function formatExportTxtWithLengthRule(data: any): string {
  let text = renderTxtContent(data);
  if (text.length <= 45000) return text;

  // Compact: reduce suggestions per pair, require 30-trade weekday rows.
  text = renderTxtContent(data, { maxSuggestionsPerPair: 3, minDowTrades: 30 });
  if (text.length <= 45000) return text;

  // Last resort: still compact, drop the "compact" flag onto the lab writer.
  text = renderTxtContent(data, { maxSuggestionsPerPair: 2, minDowTrades: 30, compact: true });
  return text;
}

function checkContainerMemory(): { ok: boolean; reason?: string; warning?: string } {
  if (process.platform !== 'linux') {
    return { ok: true, warning: 'Memory guard skipped (non-Linux platform).' };
  }

  try {
    const currentRaw = fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim();
    const maxRaw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();

    if (maxRaw === 'max') {
      return { ok: true, warning: 'Memory guard skipped (cgroup memory.max is "max").' };
    }

    const currentBytes = parseInt(currentRaw, 10);
    const maxBytes = parseInt(maxRaw, 10);
    if (!Number.isFinite(currentBytes) || !Number.isFinite(maxBytes) || maxBytes <= 0) {
      return { ok: true, warning: 'Memory guard skipped (unreadable cgroup values).' };
    }

    const ratio = currentBytes / maxBytes;
    if (ratio > 0.70) {
      const pct = (ratio * 100).toFixed(1);
      const maxMb = Math.round(maxBytes / (1024 * 1024));
      return {
        ok: false,
        reason: `Container memory is at ${pct}% of its ${maxMb} MB limit. Refusing to start the backtest to protect the live bot. Try again once memory has recovered.`,
      };
    }

    return { ok: true };
  } catch (e: any) {
    return { ok: true, warning: `Memory guard skipped (read failed: ${e?.message || String(e)}).` };
  }
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

  app.get('/api/backtest/descriptions', (_req, res) => {
    res.status(200).json({ status: 'success', data: METRIC_DESCRIPTIONS });
  });

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
      const txt = formatExportTxtWithLengthRule(data);
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

  app.get('/api/backtest/portfolio', (_req, res) => {
    try {
      const portfolioFile = path.resolve(BACKTEST_OUTPUT_DIR, 'portfolio_correlation.json');
      if (fs.existsSync(portfolioFile)) {
        const data = JSON.parse(fs.readFileSync(portfolioFile, 'utf8'));
        return res.status(200).json({ status: 'success', data });
      }
      return res.status(404).json({ status: 'error', message: 'Portfolio correlation not yet generated. Run a pair backtest first.' });
    } catch (err: any) {
      return res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  app.get('/api/backtest/variants/:symbol', (req, res) => {
    try {
      const sym = String(req.params.symbol || '').toUpperCase();
      const variantsFile = path.resolve(BACKTEST_OUTPUT_DIR, `${sym}_variants.json`);
      if (fs.existsSync(variantsFile)) {
        const data = JSON.parse(fs.readFileSync(variantsFile, 'utf8'));
        return res.status(200).json({ status: 'success', data });
      }
      return res.status(404).json({ status: 'error', message: `No variants file for ${sym}. Re-run with "Include Variants" enabled.` });
    } catch (err: any) {
      return res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  // ---- Strategy Lab endpoints ----
  app.get('/api/backtest/lab/:symbol', (req, res) => {
    try {
      const sym = String(req.params.symbol || '').toUpperCase();
      const labFile = path.resolve(BACKTEST_OUTPUT_DIR, `${sym}_lab.json`);
      if (fs.existsSync(labFile)) {
        const data = JSON.parse(fs.readFileSync(labFile, 'utf8'));
        return res.status(200).json({ status: 'success', data });
      }
      return res.status(404).json({ status: 'error', message: `No Strategy Lab file for ${sym}. Click Strategy Lab to generate it.` });
    } catch (err: any) {
      return res.status(500).json({ status: 'error', message: err?.message });
    }
  });

  app.post('/api/backtest/lab', (req, res) => {
    if (labRunning) {
      return res.status(409).json({ status: 'error', message: 'Strategy Lab is already running.' });
    }
    if (backtestRunning) {
      return res.status(409).json({ status: 'error', message: 'A backtest is running. Wait for it to finish before starting the Strategy Lab.' });
    }

    const memCheck = checkContainerMemory();
    if (!memCheck.ok) {
      console.warn(`[LAB] ${memCheck.reason}`);
      return res.status(503).json({ status: 'error', message: memCheck.reason });
    }

    const requested: any = req.body?.symbols ?? req.body?.symbol ?? 'US30';
    const symbolsArray: string[] = Array.isArray(requested)
      ? requested.map((s: string) => String(s).toUpperCase()).filter(Boolean)
      : String(requested).toUpperCase() === 'ALL'
        ? [...WHITELIST_ASSETS]
        : [String(requested).toUpperCase()];

    if (symbolsArray.length === 0) {
      return res.status(400).json({ status: 'error', message: 'No symbols supplied.' });
    }

    labResults = [];
    labRunning = true;
    labProgress = `Launching Strategy Lab for ${symbolsArray.join(', ')}...`;
    labLastError = null;

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const args = ['backtest/runner.py', '--symbols', symbolsArray.join(','), '--lab'];
    const proc = spawn(pythonCmd, args, {
      env: { ...process.env, PYTHONPATH: process.cwd() },
    });
    activeLabProcess = proc;

    let stdoutBuf = '';
    proc.stdout.on('data', data => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const raw of lines) {
        const l = raw.trim();
        if (!l) continue;
        if (l.startsWith('[LAB]')) {
          labProgress = l.replace('[LAB]', '').trim();
          const m = l.match(/^\[LAB\]\s+([A-Z0-9]+):\s+saved lab results/);
          if (m) {
            labResults.push({ symbol: m[1], status: 'OK', message: 'Lab results saved.' });
          }
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
        console.error(`[LAB:ERR] ${l}`);
      }
    });

    proc.on('exit', code => {
      labRunning = false;
      activeLabProcess = null;
      if (code === 0) {
        labProgress = `Strategy Lab complete.`;
        // Any symbol that never pushed an OK result is a failure.
        for (const s of symbolsArray) {
          if (!labResults.find(r => r.symbol === s)) {
            labResults.push({ symbol: s, status: 'FAILED', message: 'No lab output written.' });
          }
        }
      } else {
        labLastError = `Exited with code ${code}`;
        labProgress = `Strategy Lab failed: ${labLastError}`;
      }
    });

    proc.on('error', err => {
      labRunning = false;
      activeLabProcess = null;
      labLastError = `spawn error: ${err.message}`;
      labProgress = `Strategy Lab failed: ${labLastError}`;
    });

    res.status(200).json({ status: 'success', message: `Strategy Lab started for ${symbolsArray.join(', ')}.` });
  });

  app.get('/api/backtest/lab-status', (_req, res) => {
    res.status(200).json({
      status: 'success',
      isRunning: labRunning,
      progress: labProgress,
      lastError: labLastError,
      results: labResults,
    });
  });

  app.post('/api/backtest/lab-stop', (_req, res) => {
    if (activeLabProcess) {
      try { activeLabProcess.kill(); } catch {}
    }
    activeLabProcess = null;
    labRunning = false;
    labProgress = 'Strategy Lab cancelled.';
    res.status(200).json({ status: 'success', message: 'Lab stopped.' });
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
      } catch {}

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

  app.post('/api/backtest/run', (req, res) => {
    if (backtestRunning) {
      return res.status(409).json({ status: 'error', message: 'A backtest is already running.' });
    }

    const memCheck = checkContainerMemory();
    if (!memCheck.ok) {
      console.warn(`[BT] ${memCheck.reason}`);
      return res.status(503).json({ status: 'error', message: memCheck.reason });
    }
    if (memCheck.warning) {
      console.warn(`[BT] ${memCheck.warning}`);
    }

    const requested: any = req.body?.symbol ?? 'US30';
    const symbolsArray: string[] = Array.isArray(requested)
      ? requested.map((s: string) => String(s).toUpperCase()).filter(Boolean)
      : String(requested).toUpperCase() === 'ALL'
        ? [...WHITELIST_ASSETS]
        : [String(requested).toUpperCase()];

    if (symbolsArray.length === 0) {
      return res.status(400).json({ status: 'error', message: 'No symbols supplied.' });
    }

    const days = parseInt(req.body?.days || '60', 10);
    const rr = parseFloat(req.body?.rr || 1.0);
    const variants = Boolean(req.body?.variants ?? false);

    backtestResults = [];
    activeBacktestProcesses = [];
    backtestRunning = true;
    backtestProgress = `Initiating backtest matrix for ${symbolsArray.join(', ')}...`;
    backtestLastError = null;
    backtestExitCode = null;

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    async function executeMatrix() {
      // Phase 1: prepare each symbol's data (only when more than one symbol is
      // requested; single-symbol runs skip the extra pass so the runner handles
      // its own ensure step).
      if (symbolsArray.length > 1) {
        for (let idx = 0; idx < symbolsArray.length; idx++) {
          if (!backtestRunning) return;
          const sym = symbolsArray[idx];
          backtestProgress = `[Phase 1/2: Preparing Data ${idx + 1}/${symbolsArray.length}] ${sym}...`;

          await new Promise<void>((resolve) => {
            const prepProc = spawn(pythonCmd, ['backtest/runner.py', '--symbol', sym, '--prepare-only'], {
              env: { ...process.env, PYTHONPATH: process.cwd() }
            });
            prepProc.on('exit', () => resolve());
            prepProc.on('error', () => resolve());
          });
        }
      }

      const maxWorkers = 1;
      let activeIndex = 0;
      let completedCount = 0;

      async function runWorker(sym: string): Promise<void> {
        let symTiming = '';
        const stderrTail: string[] = [];

        const args = ['backtest/runner.py', '--symbol', sym, '--days', String(days), '--rr', String(rr)];
        // When running across multiple symbols we already prepared data above,
        // so ask the runner to skip its own download step.
        if (symbolsArray.length > 1) args.push('--skip-download');
        if (variants) args.push('--variants');

        await new Promise<void>((resolve) => {
          const proc = spawn(pythonCmd, args, {
            env: {
              ...process.env,
              PYTHONPATH: process.cwd(),
              BACKTEST_CONCURRENT_WORKERS: String(maxWorkers)
            }
          });
          activeBacktestProcesses.push(proc);

          proc.stdout.on('data', data => {
            const lines = data.toString().split('\n');
            for (const l of lines) {
              const trimmed = l.trim();
              if (trimmed.startsWith('[time]')) symTiming = trimmed.replace('[time]', '').trim();
            }
          });

          proc.stderr.on('data', data => {
            const lines = data.toString().split('\n');
            for (const raw of lines) {
              const line = raw.trimEnd();
              if (!line) continue;
              stderrTail.push(line);
              if (stderrTail.length > 20) stderrTail.shift();
            }
          });

          proc.on('exit', (code, signal) => {
            completedCount++;
            backtestProgress = `[Phase 2/2] ${completedCount}/${symbolsArray.length} assets completed.`;

            const tailText = stderrTail.length > 0
              ? `\n--- stderr (last ${stderrTail.length} lines) ---\n${stderrTail.join('\n')}`
              : '';
            const reason = signal
              ? `Killed by ${signal}${signal === 'SIGKILL' ? ' (likely out of memory)' : ''}`
              : `Exited with code ${code}`;

            if (!signal && code === 0) {
              backtestResults.push({ symbol: sym, status: 'OK', message: 'Completed 8/8 matrix', timing: symTiming });
            } else {
              console.error(`[BT] ${sym}: ${reason}${tailText}`);
              backtestResults.push({ symbol: sym, status: 'FAILED', message: `${reason}${tailText}`, timing: symTiming });
            }
            resolve();
          });

          proc.on('error', err => {
            completedCount++;
            const reason = `spawn error: ${err.message}`;
            const tailText = stderrTail.length > 0
              ? `\n--- stderr (last ${stderrTail.length} lines) ---\n${stderrTail.join('\n')}`
              : '';
            console.error(`[BT] ${sym}: ${reason}${tailText}`);
            backtestResults.push({ symbol: sym, status: 'FAILED', message: `${reason}${tailText}` });
            resolve();
          });
        });
      }

      const activePool: Promise<void>[] = [];
      while (activeIndex < symbolsArray.length && backtestRunning) {
        while (activePool.length < maxWorkers && activeIndex < symbolsArray.length) {
          const nextSym = symbolsArray[activeIndex++];
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

    res.status(200).json({ status: 'success', message: `Execution initiated for ${symbolsArray.join(', ')}` });
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
      saveBotConfigAtomically(activeBotConfig);
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
      const { maxDailyLossUsd, maxWeeklyLossUsd, maxMonthlyLossUsd, maxDailyDrawdownPct, autoLiquidateAllOnTrip, resetBreaker, useProfileDrawdownPct } = req.body;
      if (typeof maxDailyLossUsd === 'number') riskLimits.maxDailyLossUsd = maxDailyLossUsd;
      if (typeof maxWeeklyLossUsd === 'number') riskLimits.maxWeeklyLossUsd = maxWeeklyLossUsd;
      if (typeof maxMonthlyLossUsd === 'number') riskLimits.maxMonthlyLossUsd = maxMonthlyLossUsd;
      if (typeof maxDailyDrawdownPct === 'number') riskLimits.maxDailyDrawdownPct = maxDailyDrawdownPct;
      if (typeof autoLiquidateAllOnTrip === 'boolean') riskLimits.autoLiquidateAllOnTrip = autoLiquidateAllOnTrip;
      if (typeof useProfileDrawdownPct === 'boolean') riskLimits.useProfileDrawdownPct = useProfileDrawdownPct;

      if (resetBreaker) {
        riskState.breakerTriggered = false;
        riskState.activeTripScope = 'NONE';
        riskState.lastTriggerReason = undefined;
        activeBotConfig.masterExecution = true;
      }

      saveBotConfigAtomically({ ...activeBotConfig, ...riskLimits, limitsConfirmedAt: new Date().toISOString() });
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

    let restartScheduled = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const scheduleRestart = (reason: string) => {
      if (restartScheduled) return;
      restartScheduled = true;

      const now = Date.now();
      botRestartTimestamps.push(now);
      botRestartTimestamps = botRestartTimestamps.filter(t => now - t <= 120000);
      const count = botRestartTimestamps.length;

      if (count <= 1) {
        botCrashLoopWarned = false;
      }

      if (!botCrashLoopWarned && count > 5) {
        botCrashLoopWarned = true;
        console.error(`[BOT] CRASH LOOP — ${count} restarts within 2 minutes. Still restarting.`);
      }

      console.log(`[BOT] Restarting in 5s (${reason}).`);
      setTimeout(() => {
        launchPythonBot();
      }, 5000);
    };

    bot.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

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
          continue;
        }

        console.log(`[BOT] ${line}`);
      }
    });

    bot.stderr.on('data', chunk => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!line) continue;
        console.error(`[BOT:ERR] ${line}`);
      }
    });

    bot.on('error', err => {
      console.error(`[BOT] spawn error: ${err.message}`);
      scheduleRestart(`spawn error: ${err.message}`);
    });

    bot.on('exit', (code, signal) => {
      console.log(`[BOT] exited code=${code} signal=${signal ?? 'null'}`);
      scheduleRestart(`exit code=${code} signal=${signal ?? 'null'}`);
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