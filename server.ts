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
    const tuneCnt = tune.count || 0;
    const valCnt = val.count || 0;
    if (tuneCnt >= 30 && valCnt >= 30) {
      const tunePf = tune.profit_factor || 0;
      const valPf = val.profit_factor || 0;
      if (valPf < 1.0 || valPf < 0.7 * tunePf) {
        const loss = Math.abs(val.net_pnl || 0);
        suggestions.push({
          tag: `[MEASURED $${loss.toFixed(2)}]`,
          text: `Combination '${c.label}' on ${symbol} does not hold on unseen data: TUNE PF ${tunePf.toFixed(2)} -> VALIDATE PF ${valPf.toFixed(2)} (TUNE ${tuneCnt} trades / VALIDATE ${valCnt} trades).`,
          impact: Number(loss.toFixed(2)),
          is_measured: true,
          type: 'HOLD_OUT_FAIL'
        });
      }
    } else if (tuneCnt > 0 || valCnt > 0) {
      suggestions.push({
        tag: '[INCONCLUSIVE]',
        text: `Combination '${c.label}' on ${symbol} hold-out: TUNE ${tuneCnt} trades, VALIDATE ${valCnt} trades. Both need >= 30 for a valid hold-out test.`,
        impact: 0.0,
        is_measured: false,
        type: 'HOLD_OUT_INCONCLUSIVE'
      });
    }
  });

  const stratTv: Record<string, any> = best.strategy_tune_validate || {};
  Object.entries(stratTv).forEach(([sName, tvRow]) => {
    const tune = (tvRow as any).tune || {};
    const val = (tvRow as any).validate || {};
    const tuneCnt = tune.count || 0;
    const valCnt = val.count || 0;
    if (tuneCnt >= 30 && valCnt >= 30) {
      const tunePf = tune.profit_factor || 0;
      const valPf = val.profit_factor || 0;
      if (valPf < 1.0 || valPf < 0.7 * tunePf) {
        const loss = Math.abs(val.net_pnl || 0);
        suggestions.push({
          tag: `[MEASURED $${loss.toFixed(2)}]`,
          text: `${sName} on ${symbol} does not hold on unseen data: TUNE PF ${tunePf.toFixed(2)} -> VALIDATE PF ${valPf.toFixed(2)} (TUNE ${tuneCnt} / VALIDATE ${valCnt}).`,
          impact: Number(loss.toFixed(2)),
          is_measured: true,
          type: 'HOLD_OUT_FAIL'
        });
      }
    } else if (tuneCnt >= 15 || valCnt >= 15) {
      suggestions.push({
        tag: '[INCONCLUSIVE]',
        text: `${sName} on ${symbol} hold-out: TUNE ${tuneCnt} trades, VALIDATE ${valCnt} trades. Both need >= 30.`,
        impact: 0.0,
        is_measured: false,
        type: 'HOLD_OUT_INCONCLUSIVE'
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
  const holdOut = allSuggestions.filter(s => s.type === 'HOLD_OUT_FAIL');
  if (holdOut.length > 0) {
    tests.push(`Retest with hold-out separation: ${holdOut.length} setup(s) failed on VALIDATE (unseen) data — review ${holdOut[0].text.split(':')[0]}.`);
  }
  tests.push(`Test expanding target R:R from 1.0 to 1.5 on pairs demonstrating profit factor above 1.3.`);
  return tests.slice(0, 5);
}

function generateExportDataPayload(): any {
  const result: any = {
    generated_at: new Date().toISOString(),
    days: 60,
    target_rr: 1.0,
    total_run_seconds: null,
    combinations_rollup: {},
    pairs: [],
    portfolio_suggestions: [],
    what_to_test_next: []
  };

  const allSummaryCombos: Record<string, { trades: number; pnl: number; win_count: number }> = {};
  let totalTime = 0.0;
  let hasValidTimes = false;
  const allPortfolioSuggestions: Array<{ tag: string; text: string; impact: number; is_measured: boolean; type: string }> = [];

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

      const pairPayload: any = {
        symbol: sym,
        status: "OK",
        seconds_taken: pairSeconds,
        phase_seconds: (summary as any).phase_seconds || null,
        cpu_cores: (summary as any).cpu_cores || null,
        concurrent_processes: (summary as any).concurrent_processes || null,
        combinations: combos,
        best_combination: {
          ...(bestCombo || {}),
          strategy_kpis: bestReportDetail.strategy_kpis || {},
          dow_kpis: bestReportDetail.dow_kpis || {},
          skipped_summary: bestReportDetail.skipped_summary || {},
          warnings: bestReportDetail.warnings || [],
          adaptive_effective_pct: bestReportDetail.adaptive_effective_pct ?? 100,
          strategy_tune_validate: bestReportDetail.strategy_tune_validate || {},
          tune_validate: bestReportDetail.tune_validate || (bestCombo ? bestCombo.tune_validate : null) || {}
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

function renderTxtContent(data: any, options: { maxSuggestionsPerPair?: number; minDowTrades?: number } = {}): string {
  const maxSugg = options.maxSuggestionsPerPair ?? 999;
  const minDow = options.minDowTrades ?? 0;

  const totalTimeStr = (typeof data.total_run_seconds === 'number' && data.total_run_seconds > 0) ? `${data.total_run_seconds}s` : 'n/a';

  const lines: string[] = [];
  lines.push(`LEGEND: [TR]=Trades | [WR]=WinRate% | [EXP]=Expectancy(R) | [PF]=ProfitFactor | [DD]=MaxDrawdown | [PNL]=NetRealized$ | [COV]=AdaptiveCover% | [TUNE]/[VALIDATE]=70/30 date split`);
  lines.push(`RUN: Date: ${data.generated_at.slice(0, 10)} | Days: ${data.days} | Target R:R: 1:${data.target_rr} | Total Run Time: ${totalTimeStr}`);
  let coresSeen: number | null = null;
  let concurrentSeen: number | null = null;
  for (const p of (data.pairs || [])) {
    if (p && p.cpu_cores && coresSeen === null) coresSeen = p.cpu_cores;
    if (p && p.concurrent_processes && concurrentSeen === null) concurrentSeen = p.concurrent_processes;
  }
  lines.push(`HOST: CPU cores detected: ${coresSeen ?? 'n/a'} | Pair processes ran concurrently: ${concurrentSeen ?? 'n/a'}`);
  lines.push(`RULES: Trades < 30 tagged INCONCLUSIVE | Hold-out rules require >= 30 trades in BOTH TUNE and VALIDATE\n`);

  lines.push(`=== CROSS-PAIR ROLLUP PER COMBINATION ===`);
  Object.entries(data.combinations_rollup || {}).forEach(([combo, r]: any) => {
    lines.push(`${combo.padEnd(32)} | TR: ${String(r.total_trades).padStart(5)} | WR: ${r.weighted_win_rate.toFixed(1).padStart(5)}% | PNL: $${r.total_pnl.toFixed(2)}`);
  });
  lines.push(``);

  for (const p of data.pairs || []) {
    const runTimeStr = (typeof p.seconds_taken === 'number' && p.seconds_taken > 0) ? `${p.seconds_taken}s` : 'n/a';
    const ps = p.phase_seconds || {};
    const phaseStr = `aggregator ${ps.aggregator_s ?? 'n/a'}s, volatility ${ps.volatility_s ?? 'n/a'}s, session_levels ${ps.session_levels_s ?? 'n/a'}s, strategies ${ps.strategies_s ?? 'n/a'}s, simulator ${ps.simulator_s ?? 'n/a'}s, report_writing ${ps.report_writing_s ?? 'n/a'}s`;
    lines.push(`================================================================================`);
    lines.push(`ASSET: ${p.symbol} (${p.status}) | Run Time: ${runTimeStr}`);
    lines.push(`PHASES: ${phaseStr}`);
    if (p.status !== "OK") {
      lines.push(`STATUS: ${p.error || 'Not tested'}\n`);
      continue;
    }

    lines.push(`--- 8 Combinations ---`);
    for (const c of p.combinations || []) {
      const incon = (c.total_trades || 0) < 30 ? " [INCONCLUSIVE]" : "";
      const ctv: any = c.tune_validate || {};
      const cTune: any = ctv.tune || {};
      const cVal: any = ctv.validate || {};
      const cTuneStr = `TUNE[TR:${cTune.count ?? 0} WR:${(cTune.win_rate ?? 0).toFixed(1)}% PF:${(cTune.profit_factor ?? 0).toFixed(2)}]`;
      const cValStr = `VALIDATE[TR:${cVal.count ?? 0} WR:${(cVal.win_rate ?? 0).toFixed(1)}% PF:${(cVal.profit_factor ?? 0).toFixed(2)}]`;
      lines.push(`${c.label.padEnd(32)} | TR: ${String(c.total_trades).padStart(4)} | WR: ${c.win_rate.toFixed(1)}% | EXP: ${c.expectancy.toFixed(2)}R | PF: ${c.profit_factor.toFixed(2)} | DD: -$${c.max_drawdown.toFixed(2)} | PNL: $${c.net_pnl.toFixed(2)} | COV: ${c.adaptive_effective_pct.toFixed(0)}% | ${cTuneStr} | ${cValStr}${incon}`);
    }

    const b = p.best_combination || {};
    lines.push(`\n--- Best Combination: ${b.label || 'N/A'} ---`);
    lines.push(`Performance by Strategy:`);
    const bStv: Record<string, any> = (b as any).strategy_tune_validate || {};
    Object.entries(b.strategy_kpis || {}).forEach(([sName, s]: any) => {
      const stv: any = bStv[sName] || {};
      const sTune: any = stv.tune || {};
      const sVal: any = stv.validate || {};
      const sTuneStr = `TUNE[TR:${sTune.count ?? 0} WR:${(sTune.win_rate ?? 0).toFixed(1)}% PF:${(sTune.profit_factor ?? 0).toFixed(2)}]`;
      const sValStr = `VALIDATE[TR:${sVal.count ?? 0} WR:${(sVal.win_rate ?? 0).toFixed(1)}% PF:${(sVal.profit_factor ?? 0).toFixed(2)}]`;
      lines.push(`  ${sName.padEnd(28)} | TR: ${String(s.count).padStart(3)} | WR: ${s.win_rate.toFixed(1)}% | PF: ${s.profit_factor.toFixed(2)} | PNL: $${s.net_pnl.toFixed(2)} | ${sTuneStr} | ${sValStr}`);
    });

    lines.push(`Performance by Day of Week:`);
    Object.entries(b.dow_kpis || {}).forEach(([dow, s]: any) => {
      if ((s.count || 0) >= minDow) {
        lines.push(`  ${dow.padEnd(12)} | TR: ${String(s.count).padStart(3)} | WR: ${s.win_rate.toFixed(1)}% | EXP: ${s.expectancy.toFixed(2)}R | PNL: $${s.net_pnl.toFixed(2)}`);
      }
    });

    const skipSummary = b.skipped_summary || {};
    const skipEntries = Object.entries(skipSummary);
    if (skipEntries.length > 0) {
      lines.push(`Skipped Signals Summary:`);
      const skipParts = skipEntries.map(([reason, val]: [string, any]) => {
        if (typeof val === 'object' && val !== null) {
          return `${reason}: ${val.candle_skips ?? 0} candle-skips, ${val.unique_setups ?? 0} unique setups`;
        }
        return `${reason}: ${val} candle-skips`;
      });
      lines.push(`  ${skipParts.join(' | ')}`);
    }

    if (b.warnings && b.warnings.length > 0) {
      lines.push(`Warnings: ${b.warnings.join(' | ')}`);
    }

    const suggestions: any[] = b.rule_suggestions || [];
    if (suggestions.length > 0) {
      lines.push(`Actionable Suggestions (Impact Ranked):`);
      suggestions.slice(0, maxSugg).forEach((s: any) => {
        lines.push(`  • ${s.tag} ${s.text}`);
      });
    }
    lines.push(``);
  }

  if (data.what_to_test_next && data.what_to_test_next.length > 0) {
    lines.push(`================================================================================`);
    lines.push(`WHAT TO TEST NEXT:`);
    data.what_to_test_next.forEach((item: string, idx: number) => {
      lines.push(`  ${idx + 1}. ${item}`);
    });
    lines.push(`================================================================================\n`);
  }

  return lines.join('\n');
}

function formatExportTxtWithLengthRule(data: any): string {
  let text = renderTxtContent(data);
  if (text.length <= 15000) return text;

  text = renderTxtContent(data, { maxSuggestionsPerPair: 3, minDowTrades: 0 });
  if (text.length <= 15000) return text;

  text = renderTxtContent(data, { maxSuggestionsPerPair: 3, minDowTrades: 30 });
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

  // PROPOSED: Phase-4 cross-pair correlation matrix (Section 7 item 30).
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

  // PROPOSED: Phase-3 variant matrix (Section 5 items 22 / 23 / 25).
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

    const requestedSymbol = String(req.body?.symbol || 'US30').toUpperCase();
    const days = parseInt(req.body?.days || '60', 10);
    const rr = parseFloat(req.body?.rr || 1.0);
    // PROPOSED: Phase-3 flag. When true, the Python runner also executes the
    // five variant combos and saves <symbol>_variants.json.
    const variants = Boolean(req.body?.variants ?? false);

    backtestResults = [];
    activeBacktestProcesses = [];
    backtestRunning = true;
    backtestProgress = `Initiating backtest matrix...`;
    backtestLastError = null;
    backtestExitCode = null;

    const symbolsQueue = requestedSymbol === 'ALL' ? WHITELIST_ASSETS : [requestedSymbol];
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    async function executeMatrix() {
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

      const maxWorkers = 1;
      let activeIndex = 0;
      let completedCount = 0;

      async function runWorker(sym: string): Promise<void> {
        let symTiming = '';
        const stderrTail: string[] = [];

        const args = ['backtest/runner.py', '--symbol', sym, '--days', String(days), '--rr', String(rr)];
        if (requestedSymbol === 'ALL') args.push('--skip-download');
        if (variants) args.push('--variants');

        await new Promise<void>((resolve) => {
          const proc = spawn(pythonCmd, args, { env: { ...process.env, PYTHONPATH: process.cwd(), BACKTEST_CONCURRENT_WORKERS: String(maxWorkers) } });
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
            backtestProgress = `[Phase 2/2] ${completedCount}/${symbolsQueue.length} assets completed.`;

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