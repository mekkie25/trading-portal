import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import {
  TrendingUp, RefreshCw, Play, Lightbulb, Trash2,
  Layers, Square, Copy, Check, Database, Clock, ShieldCheck, Download, Printer, Sliders,
  FileText, Activity, Network, Info, FlaskConical, Wand2,
  DollarSign, Calculator, Save, RotateCcw, Globe
} from 'lucide-react';
import {
  ThemeMode, BacktestReportPayload, BacktestKPIs, ImprovementTip,
  PortfolioCorrelation
} from '../../types';
import { formatCurrency } from '../../utils/currency';
import { describe } from '../../../shared/metricDescriptions';

interface BacktestViewProps {
  themeMode?: ThemeMode;
  brokerCurrency?: string;
}

interface SummaryCombination {
  label: string; mode: string; be: string; trail: string;
  rr: number; rr_label: string; report_file: string;
  total_trades: number; win_rate: number; expectancy: number;
  profit_factor: number; max_drawdown: number; net_pnl: number;
  adaptive_effective_pct: number; holdout_verdict?: string;
  tune_validate?: any; funnel?: any;
}

interface SymbolSummaryPayload {
  symbol: string; days: number; target_rr?: number | null;
  rr_values?: number[]; generated_at: string;
  total_seconds?: number; phase_seconds?: any; cache?: any;
  starting_balance_usd?: number; starting_balance_input?: number;
  currency?: string; zar_per_usd?: number; profile_name?: string;
  combinations: SummaryCombination[];
}

interface StorageInfo {
  total_mb: number; used_mb: number; free_mb: number;
  market_data_mb: number; reports_mb: number;
}

interface RunResultItem {
  symbol: string; status: 'OK' | 'FAILED'; message: string; timing?: string;
  engine_line?: string; wrong_engine?: boolean;
}

interface LabVariantRow {
  label: string; trades: number; win_rate: number; profit_factor: number;
  max_drawdown: number; net_pnl: number; expectancy: number;
  tune_pf: number; tune_trades: number; validate_pf: number; validate_trades: number;
  verdict: 'IMPROVES' | 'NO' | 'INCONCLUSIVE';
}

interface LabPayload {
  symbol: string; days: number; generated_at: string;
  window_start: string; window_end: string; baseline_label: string;
  variants: LabVariantRow[];
}

interface OptimizerDetails {
  isRunning?: boolean;
  pair?: string;
  strategy?: string;
  elapsed_s?: number;
  variants_tested?: number;
  suggested_file?: string;
  summary_file?: string;
}

interface ProfileReplayResult {
  profile: string;
  starting_balance: number;
  final_equity: number;
  net_pnl: number;
  net_pnl_pct: number;
  max_dd: number;
  trades_taken: number;
  trades_skipped_min_lot: number;
  wins: number;
  losses: number;
  win_rate: number;
}

interface SpreadConfig {
  broker?: string;
  notes?: string;
  updated?: string;
  symbols: Record<string, { spread: number }>;
}

interface PipCalculatorEntry {
  base_sl_pips: number;
  post_sl_R: number;
  sl_factor: number;
  min_sl_pips: number;
  sample_trades: number;
  source: string;
}

interface PipCalculatorPayload {
  pairs: Record<string, {
    pair_level: PipCalculatorEntry | null;
    strategies: Record<string, PipCalculatorEntry>;
  }>;
}

const WHITELIST_ASSETS = ["US30", "GOLD", "NAS100", "GERMAN30", "EURUSD", "GBPUSD", "USDJPY"];

const PROFILE_BANDS_ZAR = [500, 2000, 10000, 50000];
const PROFILE_NAMES = ["None", "Steady", "Balanced", "Aggressive", "Max Growth"] as const;
const PROFILE_RISK_BY_BAND: Record<string, number[] | null> = {
  'None': null,
  'Steady':     [5, 3, 2, 1.5, 1],
  'Balanced':   [10, 6, 4, 3, 2],
  'Aggressive': [30, 15, 8, 5, 3],
  'Max Growth': [35, 25, 12, 6, 4],
};
const DEFAULT_BALANCES = [10, 50, 100, 500, 1000];

function bandRiskPct(profile: string, equityZar: number): number {
  const risks = PROFILE_RISK_BY_BAND[profile];
  if (!risks) return 0;
  const b = PROFILE_BANDS_ZAR;
  if (equityZar < b[0]) return risks[0];
  if (equityZar < b[1]) return risks[1];
  if (equityZar < b[2]) return risks[2];
  if (equityZar < b[3]) return risks[3];
  return risks[4];
}

function replayProfileClient(
  trades: any[],
  startingBalance: number,
  profile: string,
  zarPerUsd: number,
  flatRiskPct: number = 1.0,
): ProfileReplayResult {
  let equity = startingBalance;
  let peak = equity;
  let maxDD = 0;
  let taken = 0;
  let skipped = 0;
  let wins = 0;
  let losses = 0;

  for (const t of trades) {
    const r = Number(t?.r_multiple ?? 0) || 0;
    const minLotCash = Number(t?.min_lot_cash_risk_usd ?? 0) || 0;

    let riskPct: number;
    if (profile === 'None') {
      riskPct = flatRiskPct;
    } else {
      const eqZar = equity * zarPerUsd;
      riskPct = bandRiskPct(profile, eqZar);
    }
    const riskCash = equity * (riskPct / 100);

    if (minLotCash > 0 && minLotCash > 1.5 * riskCash) {
      skipped++;
      continue;
    }

    equity += r * riskCash;
    taken++;
    if (r > 0.1) wins++;
    else if (r < -0.1) losses++;

    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    profile,
    starting_balance: startingBalance,
    final_equity: Number(equity.toFixed(2)),
    net_pnl: Number((equity - startingBalance).toFixed(2)),
    net_pnl_pct: startingBalance > 0
      ? Number((((equity - startingBalance) / startingBalance) * 100).toFixed(2))
      : 0,
    max_dd: Number(maxDD.toFixed(2)),
    trades_taken: taken,
    trades_skipped_min_lot: skipped,
    wins,
    losses,
    win_rate: taken > 0 ? Number(((wins / taken) * 100).toFixed(1)) : 0,
  };
}

function formatNum(val: any, decimals = 2): string {
  const num = typeof val === 'number' ? val : parseFloat(val);
  return isNaN(num) ? '0.00' : num.toFixed(decimals);
}

function formatPriceBySymbol(price: any, symbol?: string): string {
  const num = parseFloat(price);
  if (isNaN(num)) return '--';
  const sym = (symbol || '').toUpperCase();
  if (sym.includes('EURUSD') || sym.includes('GBPUSD')) return num.toFixed(5);
  if (sym.includes('USDJPY')) return num.toFixed(3);
  return num.toFixed(2);
}

function corrColor(v: number): string {
  if (v >= 0.7) return 'bg-rose-500/40 text-rose-900 dark:text-rose-100 border-rose-500/50';
  if (v >= 0.4) return 'bg-amber-500/30 text-amber-900 dark:text-amber-100 border-amber-500/40';
  if (v >= 0.15) return 'bg-slate-400/20 text-slate-800 dark:text-slate-200 border-slate-400/30';
  if (v > -0.15) return 'bg-slate-200/40 dark:bg-[#0d1017] text-slate-600 dark:text-slate-300 border-slate-300 dark:border-[#1a2030]';
  if (v > -0.4) return 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 border-emerald-500/30';
  return 'bg-emerald-500/40 text-emerald-900 dark:text-emerald-100 border-emerald-500/50';
}

const InfoTip: React.FC<{ metricKey: string }> = ({ metricKey }) => {
  const [open, setOpen] = useState(false);
  const d = describe(metricKey);
  return (
    <span className="relative inline-flex items-center ml-1 align-middle"
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={`Info: ${d.title}`} tabIndex={0}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        className="text-slate-400 hover:text-blue-500 focus:text-blue-500 cursor-help outline-none">
        <Info className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 z-[60] w-64 p-3 rounded-xl bg-slate-900 text-white text-[11px] leading-relaxed shadow-2xl border border-slate-700 pointer-events-none">
          <div className="font-bold text-blue-300 mb-1">{d.title}</div>
          <div className="text-slate-200">{d.description}</div>
          <div className="mt-1.5 pt-1.5 border-t border-slate-700 text-slate-400 italic">{d.howToRead}</div>
        </div>
      )}
    </span>
  );
};

const HowToRead: React.FC<{ metricKey: string }> = ({ metricKey }) => {
  const d = describe(metricKey);
  return (
    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 flex items-start gap-1.5">
      <Info className="w-3 h-3 mt-0.5 shrink-0 text-blue-500" />
      <span><strong className="not-italic text-blue-500">How to read this:</strong> {d.howToRead}</span>
    </p>
  );
};

const VerdictPill: React.FC<{ verdict?: string }> = ({ verdict }) => {
  const v = verdict || 'INCONCLUSIVE';
  const cfg: Record<string, string> = {
    HOLDS: 'bg-emerald-500/15 text-emerald-600 border border-emerald-500/30',
    FLAT: 'bg-slate-500/15 text-slate-500 border border-slate-400/30',
    FAILS: 'bg-rose-500/15 text-rose-600 border border-rose-500/30',
    INCONCLUSIVE: 'bg-slate-400/15 text-slate-500 border border-slate-400/30',
    IMPROVES: 'bg-emerald-500/15 text-emerald-600 border border-emerald-500/30',
    NO: 'bg-slate-500/15 text-slate-500 border border-slate-400/30',
    ROBUST: 'bg-emerald-500/15 text-emerald-600 border border-emerald-500/30',
    'NO CHANGE': 'bg-slate-500/15 text-slate-500 border border-slate-400/30',
    SKIPPED: 'bg-amber-500/15 text-amber-600 border border-amber-500/30',
  };
  return <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold ${cfg[v] || cfg.INCONCLUSIVE}`}>{v}</span>;
};

function holdoutVerdictLocal(tune: any, val: any): string {
  const tCount = tune?.count ?? 0;
  const vCount = val?.count ?? 0;
  if (tCount < 30 || vCount < 30) return 'INCONCLUSIVE';
  const tPf = tune?.profit_factor ?? 0;
  const vPf = val?.profit_factor ?? 0;
  if (vPf < 0.95 || vPf < 0.7 * tPf) return 'FAILS';
  if (vPf < 1.10) return 'FLAT';
  return 'HOLDS';
}

export const BacktestResearchPanel: React.FC<BacktestViewProps> = ({ themeMode = 'dark', brokerCurrency = 'USD' }) => {
  const [reportFiles, setReportFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [reportData, setReportData] = useState<BacktestReportPayload | null>(null);
  const [summaryData, setSummaryData] = useState<SymbolSummaryPayload | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<
    'summary' | 'profiles' | 'diagnostics' | 'portfolio' | 'lab' | 'spreads' | 'pipcalc' | 'tips' | 'ledger'
  >('summary');
  const [selectedDay, setSelectedDay] = useState<string>('');

  const [testSymbol, setTestSymbol] = useState<string>('US30');
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(['US30']);
  const [testDays, setTestDays] = useState<number>(365);

  const [startingBalance, setStartingBalance] = useState<string>('1000');
  const [backtestProfile, setBacktestProfile] = useState<string>('Max Growth');

  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [isCleaning, setIsCleaning] = useState<boolean>(false);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [progressText, setProgressText] = useState<string>('');
  const [runResults, setRunResults] = useState<RunResultItem[]>([]);

  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [verifyCopyStatus, setVerifyCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [verifyProgress, setVerifyProgress] = useState<string>('');
  const [isExportingPdf, setIsExportingPdf] = useState<boolean>(false);

  const [strategyFilter, setStrategyFilter] = useState<string>('ALL');
  const [outcomeFilter, setOutcomeFilter] = useState<string>('ALL');
  const [tipFilter, setTipFilter] = useState<string>('ALL');

  const [portfolioData, setPortfolioData] = useState<PortfolioCorrelation | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [isLoadingPortfolio, setIsLoadingPortfolio] = useState<boolean>(false);

  const [labRunning, setLabRunning] = useState<boolean>(false);
  const [labProgress, setLabProgress] = useState<string>('');
  const [labError, setLabError] = useState<string | null>(null);
  const [labPayloadBySymbol, setLabPayloadBySymbol] = useState<Record<string, LabPayload | null>>({});
  const [isLoadingLab, setIsLoadingLab] = useState<boolean>(false);
  const [labCopyStatus, setLabCopyStatus] = useState<Record<string, 'idle' | 'copied'>>({});

  const [optimizerRunning, setOptimizerRunning] = useState<boolean>(false);
  const [optimizerServerRunning, setOptimizerServerRunning] = useState<boolean>(false);
  const [optimizerProgress, setOptimizerProgress] = useState<string>('');
  const [optimizerError, setOptimizerError] = useState<string | null>(null);
  const [optimizerDetails, setOptimizerDetails] = useState<OptimizerDetails | null>(null);
  const [optimizerSummaryText, setOptimizerSummaryText] = useState<string | null>(null);
  const [optimizerCopyStatus, setOptimizerCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [showOptimizerSummary, setShowOptimizerSummary] = useState<boolean>(false);

  const [spreadConfig, setSpreadConfig] = useState<SpreadConfig | null>(null);
  const [spreadDraft, setSpreadDraft] = useState<Record<string, string>>({});
  const [spreadSaveStatus, setSpreadSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const [pipCalcData, setPipCalcData] = useState<PipCalculatorPayload | null>(null);
  const [pipCalcError, setPipCalcError] = useState<string | null>(null);

  const [customBalance, setCustomBalance] = useState<string>('');
  const [accountCurrency, setAccountCurrency] = useState<'USD' | 'ZAR'>('USD');
  const [zarPerUsd, setZarPerUsd] = useState<number>(18.0);

  const [dismissedTipIds, setDismissedTipIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('dismissed_improvement_tips');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  const fetchStorageInfo = useCallback(async () => {
    try {
      const res = await fetch('/api/backtest/storage');
      if (res.ok) { const json = await res.json(); if (json.data) setStorageInfo(json.data); }
    } catch {}
  }, []);

  useEffect(() => { fetchStorageInfo(); }, [fetchStorageInfo]);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/backtest/status');
        if (res.ok) {
          const json = await res.json();
          if (json.isRunning) { setIsRunning(true); setProgressText(json.progress || 'Simulation in progress...'); }
          if (Array.isArray(json.results) && json.results.length > 0) setRunResults(json.results);
        }
      } catch {}
    };
    checkStatus();
  }, []);

  const fetchReportList = useCallback(async () => {
    try {
      const res = await fetch('/api/backtest/reports');
      if (res.ok) {
        const json = await res.json();
        if (json.reports && json.reports.length > 0) {
          setReportFiles(json.reports);
          setSelectedFile(prev => json.reports.includes(prev) ? prev : json.reports[0]);
        }
      }
    } catch {}
  }, []);

  useEffect(() => { fetchReportList(); }, [fetchReportList]);

  const fetchSummaryData = useCallback(async (sym: string) => {
    try {
      const res = await fetch(`/api/backtest/summary/${sym}`);
      if (res.ok) { const json = await res.json(); setSummaryData(json.data || null); }
      else setSummaryData(null);
    } catch { setSummaryData(null); }
  }, []);

  useEffect(() => { fetchSummaryData(testSymbol); }, [testSymbol, fetchSummaryData]);

  const fetchLabForSymbol = useCallback(async (sym: string) => {
    setIsLoadingLab(true);
    try {
      const res = await fetch(`/api/backtest/lab/${sym}`);
      if (res.ok) { const json = await res.json(); setLabPayloadBySymbol(prev => ({ ...prev, [sym]: json.data || null })); }
      else setLabPayloadBySymbol(prev => ({ ...prev, [sym]: null }));
    } catch { setLabPayloadBySymbol(prev => ({ ...prev, [sym]: null })); }
    finally { setIsLoadingLab(false); }
  }, []);

  useEffect(() => {
    if (labPayloadBySymbol[testSymbol] === undefined) fetchLabForSymbol(testSymbol);
  }, [testSymbol, labPayloadBySymbol, fetchLabForSymbol]);

  const fetchPortfolio = useCallback(async () => {
    setIsLoadingPortfolio(true);
    setPortfolioError(null);
    try {
      const res = await fetch('/api/backtest/portfolio');
      if (res.ok) { const json = await res.json(); setPortfolioData(json.data || null); }
      else {
        const err = await res.json().catch(() => ({}));
        setPortfolioError(err.message || 'Portfolio correlation unavailable.');
        setPortfolioData(null);
      }
    } catch (e: any) { setPortfolioError(`Network error: ${e.message}`); setPortfolioData(null); }
    finally { setIsLoadingPortfolio(false); }
  }, []);

  useEffect(() => { if (activeSubTab === 'portfolio') fetchPortfolio(); }, [activeSubTab, fetchPortfolio]);

  const fetchSpreadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/backtest/spread-config');
      if (res.ok) {
        const json = await res.json();
        if (json.data) {
          setSpreadConfig(json.data);
          const draft: Record<string, string> = {};
          const symbols = json.data.symbols || {};
          for (const sym of WHITELIST_ASSETS) {
            draft[sym] = String(symbols[sym]?.spread ?? '');
          }
          setSpreadDraft(draft);
        }
      }
    } catch {}
  }, []);

  useEffect(() => { fetchSpreadConfig(); }, [fetchSpreadConfig]);

  const fetchPipCalculator = useCallback(async () => {
    setPipCalcError(null);
    try {
      const res = await fetch('/api/backtest/pip-calculator');
      if (res.ok) { const json = await res.json(); setPipCalcData(json.data || null); }
      else {
        const err = await res.json().catch(() => ({}));
        setPipCalcError(err.message || 'Pip calculator not yet generated.');
        setPipCalcData(null);
      }
    } catch (e: any) { setPipCalcError(`Network error: ${e.message}`); setPipCalcData(null); }
  }, []);

  useEffect(() => { if (activeSubTab === 'pipcalc') fetchPipCalculator(); }, [activeSubTab, fetchPipCalculator]);

  useEffect(() => {
    if (!selectedFile) return;
    const loadReport = async () => {
      try {
        const res = await fetch(`/api/backtest/report/${encodeURIComponent(selectedFile)}`);
        if (res.ok) {
          const json = await res.json();
          if (json.data) {
            setReportData(json.data);
            if (json.data.trading_dates?.length > 0) setSelectedDay(json.data.trading_dates[0]);
          }
        }
      } catch {}
    };
    loadReport();
  }, [selectedFile]);

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/backtest/status');
        if (res.ok) {
          const json = await res.json();
          if (json.progress) setProgressText(json.progress);
          if (Array.isArray(json.results)) setRunResults(json.results);
          if (!json.isRunning) {
            setIsRunning(false);
            await fetchReportList();
            await fetchSummaryData(testSymbol);
            await fetchStorageInfo();
            if (activeSubTab === 'portfolio') fetchPortfolio();
          }
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [isRunning, fetchReportList, fetchSummaryData, fetchStorageInfo, fetchPortfolio, testSymbol, activeSubTab]);

  useEffect(() => {
    if (!labRunning) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/backtest/status');
        if (res.ok) {
          const json = await res.json();
          if (json.progress) setLabProgress(json.progress);
          if (!json.isRunning) {
            setLabRunning(false);
            for (const sym of selectedSymbols) await fetchLabForSymbol(sym);
          }
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [labRunning, selectedSymbols, fetchLabForSymbol]);

  useEffect(() => {
    const fetchOptimizerStatus = async () => {
      try {
        const res = await fetch('/api/backtest/optimize-status');
        if (!res.ok) return;
        const json = await res.json();
        if (json.progress) setOptimizerProgress(json.progress);
        if (json.details) setOptimizerDetails(json.details);
        if (json.lastError) setOptimizerError(json.lastError);
        if (typeof json.summaryText === 'string' && json.summaryText.length > 0) setOptimizerSummaryText(json.summaryText);
        const serverRunning = Boolean(json.isRunning);
        setOptimizerServerRunning(serverRunning);
        if (serverRunning && !optimizerRunning) { setOptimizerRunning(true); setOptimizerError(null); }
        if (!serverRunning && optimizerRunning) { setOptimizerRunning(false); setShowOptimizerSummary(true); }
      } catch {}
    };
    fetchOptimizerStatus();
    const interval = setInterval(fetchOptimizerStatus, 3000);
    return () => clearInterval(interval);
  }, [optimizerRunning]);

  const toggleSymbol = (sym: string) => {
    setSelectedSymbols(prev => {
      const has = prev.includes(sym);
      const next = has ? prev.filter(s => s !== sym) : [...prev, sym];
      if (has && testSymbol === sym && next.length > 0) setTestSymbol(next[0]);
      if (!has && next.length === 1) setTestSymbol(sym);
      return next;
    });
  };

  const handleCleanup = async (scope: 'all_reports' | 'symbol') => {
    const sym = testSymbol;
    if (!window.confirm(scope === 'all_reports' ? 'Clear ALL reports and summaries?' : `Clear all reports for ${sym}?`)) return;
    setIsCleaning(true);
    try {
      const res = await fetch('/api/backtest/storage/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, symbol: sym }),
      });
      if (res.ok) {
        await fetchStorageInfo();
        await fetchReportList();
        await fetchSummaryData(testSymbol);
        if (scope === 'all_reports' || selectedFile.startsWith(`${sym}_`)) {
          setSelectedFile(''); setReportData(null);
        }
      }
    } finally { setIsCleaning(false); }
  };

  const buildRunBody = (symbolsPayload: string | string[]) => ({
    symbol: symbolsPayload,
    days: testDays,
    balance: parseFloat(startingBalance) || 1000,
    currency: accountCurrency,
    zarRate: zarPerUsd,
    profile: backtestProfile,
  });

  const handleRunSelected = async () => {
    if (isRunning || selectedSymbols.length === 0) return;
    setIsRunning(true); setRunResults([]);
    setProgressText(`Preparing matrix for ${selectedSymbols.join(', ')}...`);
    try {
      const payload = selectedSymbols.length === 1 ? selectedSymbols[0] : selectedSymbols;
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildRunBody(payload)),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setRunResults(selectedSymbols.map(s => ({ symbol: s, status: 'FAILED' as const, message: err.message || 'Run failed' })));
        setIsRunning(false);
      }
    } catch {
      setRunResults(selectedSymbols.map(s => ({ symbol: s, status: 'FAILED' as const, message: 'Network error connecting to runner' })));
      setIsRunning(false);
    }
  };

  const handleRunAll = async () => {
    if (isRunning) return;
    setIsRunning(true); setRunResults([]);
    setProgressText(`Preparing matrix for all 7 pairs...`);
    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildRunBody('ALL')),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setRunResults([{ symbol: 'ALL', status: 'FAILED', message: err.message || 'Run failed' }]);
        setIsRunning(false);
      }
    } catch {
      setRunResults([{ symbol: 'ALL', status: 'FAILED', message: 'Network error connecting to runner' }]);
      setIsRunning(false);
    }
  };

  const handleStopBacktest = async () => {
    try {
      await fetch('/api/backtest/stop', { method: 'POST' });
      setIsRunning(false); setProgressText('Cancelled.');
      await fetchStorageInfo();
    } catch {}
  };

  const handleRunStrategyLab = async () => {
    if (labRunning || selectedSymbols.length === 0) return;
    setLabRunning(true); setLabError(null);
    setLabProgress(`Launching Strategy Lab for ${selectedSymbols.join(', ')}...`);
    try {
      const res = await fetch('/api/backtest/lab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: selectedSymbols }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setLabError(err.message || 'Lab launch failed.');
        setLabRunning(false);
      }
    } catch (e: any) { setLabError(`Network error: ${e.message}`); setLabRunning(false); }
  };

  const handleRunOptimizer = async () => {
    if (optimizerRunning || optimizerServerRunning || isRunning || labRunning) return;
    if (!window.confirm(
      'Run the settings optimizer?\n\nIt will test many setting variations per strategy per pair on the cached signals. ' +
      'This takes up to 20 minutes. The live bot is NOT affected while it runs.\n\n' +
      'It writes config/pair_settings.suggested.json. Your live settings file is never touched.'
    )) return;
    setOptimizerRunning(true); setOptimizerError(null);
    setOptimizerSummaryText(null); setShowOptimizerSummary(false);
    setOptimizerProgress(`Launching optimizer for all ${WHITELIST_ASSETS.length} pairs...`);
    try {
      const res = await fetch('/api/backtest/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: 'ALL' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setOptimizerError(err.message || 'Optimizer launch failed.');
        setOptimizerRunning(false);
      }
    } catch (e: any) { setOptimizerError(`Network error: ${e.message}`); setOptimizerRunning(false); }
  };

  const handleStopOptimizer = async () => {
    try {
      await fetch('/api/backtest/optimize/stop', { method: 'POST' });
      setOptimizerRunning(false); setOptimizerServerRunning(false);
      setOptimizerProgress('Optimizer cancelled.');
    } catch {}
  };

  const handleCopyOptimizerSummary = () => {
    if (!optimizerSummaryText) return;
    navigator.clipboard.writeText(optimizerSummaryText).then(() => {
      setOptimizerCopyStatus('copied'); setTimeout(() => setOptimizerCopyStatus('idle'), 2500);
    }).catch(() => {});
  };

  const handleCopyLabForAI = (sym: string) => {
    const lab = labPayloadBySymbol[sym];
    if (!lab) return;
    const lines: string[] = [];
    lines.push(`STRATEGY LAB — ${sym} (${lab.days}-day window)`);
    lines.push(`Baseline: ${lab.baseline_label}`);
    lines.push('');
    const sorted = [...lab.variants].sort((a, b) => {
      const rank = (v: string) => v === 'IMPROVES' ? 0 : v === 'NO' ? 1 : 2;
      return rank(a.verdict) - rank(b.verdict);
    });
    for (const v of sorted) {
      lines.push(`${v.label.padEnd(28)} | TR ${String(v.trades).padStart(4)} | WR ${formatNum(v.win_rate, 1)}% | PF ${formatNum(v.profit_factor)} | TUNE PF ${formatNum(v.tune_pf)} (${v.tune_trades}) | VALIDATE PF ${formatNum(v.validate_pf)} (${v.validate_trades}) | ${v.verdict}`);
    }
    navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
    setLabCopyStatus(prev => ({ ...prev, [sym]: 'copied' }));
    setTimeout(() => setLabCopyStatus(prev => ({ ...prev, [sym]: 'idle' })), 2500);
  };

  const handleSaveSpreads = async () => {
    setSpreadSaveStatus('saving');
    try {
      const payload: SpreadConfig = {
        broker: spreadConfig?.broker || 'Custom',
        notes: spreadConfig?.notes || 'Edited in panel',
        updated: new Date().toISOString().slice(0, 10),
        symbols: {},
      };
      for (const sym of WHITELIST_ASSETS) {
        const raw = spreadDraft[sym];
        const num = parseFloat(raw);
        if (!isNaN(num) && num > 0) {
          payload.symbols[sym] = { spread: num };
        }
      }
      const res = await fetch('/api/backtest/spread-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSpreadConfig(payload);
        setSpreadSaveStatus('saved');
        setTimeout(() => setSpreadSaveStatus('idle'), 2500);
      } else {
        setSpreadSaveStatus('error');
        setTimeout(() => setSpreadSaveStatus('idle'), 2500);
      }
    } catch {
      setSpreadSaveStatus('error');
      setTimeout(() => setSpreadSaveStatus('idle'), 2500);
    }
  };

  const handleResetSpreads = () => {
    const fusion: Record<string, string> = {
      US30: '1.00', NAS100: '0.80', GERMAN30: '1.20', GOLD: '0.225',
      EURUSD: '0.00005', GBPUSD: '0.000061', USDJPY: '0.0053',
    };
    setSpreadDraft(fusion);
  };

  const handleExportPDF = async () => {
    setIsExportingPdf(true);
    try {
      const res = await fetch('/api/backtest/export-data');
      if (!res.ok) throw new Error('Could not fetch export data.');
      const json = await res.json();
      const exp = json.data;
      const txt = JSON.stringify(exp, null, 2);
      const blob = new Blob([txt], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `backtest_export_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`Export Notice: ${err?.message || String(err)}`);
    } finally { setIsExportingPdf(false); }
  };

  const kpis: BacktestKPIs = reportData?.global_kpis || {
    count: 0, win_rate: 0, avg_r: 0, expectancy: 0, profit_factor: 0, max_dd_money: 0,
    avg_duration: 0, best_r: 0, worst_r: 0, net_pnl: 0, is_inconclusive: true,
  };

  const filteredTrades = (reportData?.all_trades || []).filter((tr) => {
    return (strategyFilter === 'ALL' || tr.strategy === strategyFilter) &&
           (outcomeFilter === 'ALL' || tr.result === outcomeFilter);
  });

  const rawTips: ImprovementTip[] = reportData?.improvement_tips || [];
  const activeTips = rawTips.filter((tip) => {
    return !dismissedTipIds.includes(tip.id) &&
           (tipFilter === 'ALL' || tip.strategy === tipFilter || tip.category === tipFilter);
  });

  const bestComboIdx = summaryData?.combinations?.reduce((bestIdx, curr, currIdx, arr) => {
    if (curr.total_trades < 30) return bestIdx;
    if (bestIdx === -1) return currIdx;
    return curr.profit_factor > arr[bestIdx].profit_factor ? currIdx : bestIdx;
  }, -1) ?? -1;

  const exportPairCount = reportFiles.filter(f => f.endsWith('_summary.json') && !f.startsWith('.')).length;
  const anyJobRunning = isRunning || labRunning || optimizerRunning || optimizerServerRunning;

  const profileBalances = useMemo(() => {
    const arr = [...DEFAULT_BALANCES];
    const custom = parseFloat(customBalance);
    if (!isNaN(custom) && custom > 0 && !arr.includes(custom)) {
      arr.push(custom);
    }
    return arr;
  }, [customBalance]);

  const profileMatrix = useMemo(() => {
    const trades = reportData?.all_trades || [];
    if (trades.length === 0) return null;
    const ordered = [...trades].sort((a, b) =>
      String(a?.signal_time_utc || '').localeCompare(String(b?.signal_time_utc || ''))
    );
    const out: Record<string, Record<string, ProfileReplayResult>> = {};
    for (const pname of PROFILE_NAMES) {
      out[pname] = {};
      for (const bal of profileBalances) {
        out[pname][String(bal)] = replayProfileClient(ordered, bal, pname, zarPerUsd);
      }
    }
    return out;
  }, [reportData, profileBalances, zarPerUsd]);

  const usdEquivalent = useMemo(() => {
    const bal = parseFloat(startingBalance) || 1000;
    if (accountCurrency === 'ZAR' && zarPerUsd > 0) {
      return bal / zarPerUsd;
    }
    return bal;
  }, [startingBalance, accountCurrency, zarPerUsd]);

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-6 max-w-7xl mx-auto">
      <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-300 dark:border-[#1a2030]">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-black dark:text-white flex items-center gap-2.5">
            Backtest & Replay Suite
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
              Six Combinations
            </span>
          </h1>
          <p className="text-sm text-black dark:text-slate-400 mt-1">
            Adaptive only. BE off/on × R:R 1:2, 1:2.5, 1:3. Any starting balance. Live-identical profile sizing.
          </p>
        </div>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-blue-500" />
            <span className="text-xs font-bold text-black dark:text-white">Pairs to test</span>
            <span className="text-[10px] font-mono text-slate-500">({selectedSymbols.length} of {WHITELIST_ASSETS.length} selected)</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setSelectedSymbols([...WHITELIST_ASSETS])} className="text-[11px] font-mono font-bold px-2.5 py-1 rounded-lg bg-white dark:bg-[#08090d] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] hover:border-blue-400 cursor-pointer">All</button>
            <button type="button" onClick={() => setSelectedSymbols([])} className="text-[11px] font-mono font-bold px-2.5 py-1 rounded-lg bg-white dark:bg-[#08090d] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] hover:border-rose-400 cursor-pointer">None</button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 pt-1">
          {WHITELIST_ASSETS.map((sym) => {
            const checked = selectedSymbols.includes(sym);
            const focused = testSymbol === sym;
            return (
              <button key={sym} type="button" onClick={() => toggleSymbol(sym)}
                className={`px-3 py-2 rounded-xl text-xs font-mono font-bold transition-colors cursor-pointer border ${checked ? 'bg-blue-600/15 border-blue-500/40 text-blue-700 dark:text-blue-300' : 'bg-slate-50 dark:bg-[#08090d] border-slate-300 dark:border-[#1a2030] text-slate-600 dark:text-slate-400 hover:border-slate-400'}`}>
                {sym}{focused && <span className="ml-1 text-[8px] opacity-60">•</span>}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 dark:border-[#1a2030]">
          <select value={testDays} onChange={(e) => setTestDays(parseInt(e.target.value, 10))} disabled={anyJobRunning}
            className="px-2.5 py-1.5 rounded-lg bg-transparent text-xs font-mono font-bold text-black dark:text-white cursor-pointer focus:outline-none border border-slate-300 dark:border-[#1a2030]">
            <option value={60}>60 Days</option>
            <option value={90}>90 Days</option>
            <option value={180}>180 Days</option>
            <option value={365}>365 Days</option>
          </select>

          <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-[#1a2030] bg-white dark:bg-[#08090d]">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Start</span>
            <input
              type="number"
              step="any"
              min="1"
              value={startingBalance}
              onChange={(e) => setStartingBalance(e.target.value)}
              disabled={anyJobRunning}
              placeholder="1000"
              className="w-20 px-1.5 py-0.5 text-xs font-mono text-black dark:text-white bg-transparent focus:outline-none"
              title="Starting balance. Values >= 1."
            />
          </div>

          <select
            value={backtestProfile}
            onChange={(e) => setBacktestProfile(e.target.value)}
            disabled={anyJobRunning}
            className="px-2.5 py-1.5 rounded-lg bg-transparent text-xs font-mono font-bold text-black dark:text-white cursor-pointer focus:outline-none border border-slate-300 dark:border-[#1a2030]"
            title="Risk profile used for position sizing. Same profiles as the live bot."
          >
            <option value="Max Growth">Max Growth (35%)</option>
            <option value="Aggressive">Aggressive (30%)</option>
            <option value="Balanced">Balanced (10%)</option>
            <option value="Steady">Steady (5%)</option>
            <option value="None">None (flat 1%)</option>
          </select>

          <div className="flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-300 dark:border-[#1a2030] bg-white dark:bg-[#08090d]">
            <Globe className="w-3.5 h-3.5 text-blue-500" />
            <select value={accountCurrency} onChange={(e) => setAccountCurrency(e.target.value as 'USD' | 'ZAR')}
              className="bg-transparent text-xs font-mono font-bold text-black dark:text-white cursor-pointer focus:outline-none">
              <option value="USD">USD</option>
              <option value="ZAR">ZAR</option>
            </select>
            {accountCurrency === 'ZAR' && (
              <input type="number" step="0.1" value={zarPerUsd}
                onChange={(e) => setZarPerUsd(parseFloat(e.target.value) || 18.0)}
                className="w-16 px-1.5 py-0.5 text-xs font-mono text-black dark:text-white bg-transparent border-l border-slate-300 dark:border-[#1a2030] focus:outline-none"
                title="ZAR per USD for the profile replay and profile bands" />
            )}
          </div>

          {accountCurrency === 'ZAR' && (
            <span className="text-[10px] font-mono text-slate-500 px-1">
              ≈ ${usdEquivalent.toFixed(2)} USD
            </span>
          )}

          {!isRunning ? (
            <>
              <button type="button" onClick={handleRunSelected} disabled={selectedSymbols.length === 0 || labRunning || optimizerRunning || optimizerServerRunning}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50">
                <Play className="w-3.5 h-3.5" /><span>Run Selected ({selectedSymbols.length})</span>
              </button>
              <button type="button" onClick={handleRunAll} disabled={labRunning || optimizerRunning || optimizerServerRunning}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">
                <Layers className="w-3.5 h-3.5" /><span>Run All</span>
              </button>
              <button type="button" onClick={handleRunStrategyLab} disabled={selectedSymbols.length === 0 || optimizerRunning || optimizerServerRunning}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50">
                <FlaskConical className="w-3.5 h-3.5" /><span>Strategy Lab</span>
              </button>
              <button type="button" onClick={handleRunOptimizer} disabled={labRunning || optimizerRunning || optimizerServerRunning}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50">
                <Wand2 className="w-3.5 h-3.5" /><span>Optimize settings</span>
              </button>
            </>
          ) : (
            <button type="button" onClick={handleStopBacktest}
              className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-rose-600 hover:bg-rose-500 text-white">
              <Square className="w-3.5 h-3.5" /><span>Stop</span>
            </button>
          )}
        </div>
      </motion.div>

      {(optimizerRunning || optimizerServerRunning || optimizerError || optimizerSummaryText) && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-purple-500/40 shadow-xs space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-purple-500" />
              <span className="text-xs font-bold text-black dark:text-white">Optimizer</span>
              {(optimizerRunning || optimizerServerRunning) && <RefreshCw className="w-3.5 h-3.5 text-purple-500 animate-spin" />}
            </div>
            <div className="flex items-center gap-2">
              {(optimizerRunning || optimizerServerRunning) && (
                <button type="button" onClick={handleStopOptimizer} className="px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold cursor-pointer">Stop optimizer</button>
              )}
              {optimizerSummaryText && !optimizerRunning && !optimizerServerRunning && (
                <>
                  <button type="button" onClick={handleCopyOptimizerSummary} className="px-3 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer">
                    {optimizerCopyStatus === 'copied' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{optimizerCopyStatus === 'copied' ? 'Copied' : 'Copy summary'}</span>
                  </button>
                  <button type="button" onClick={() => setShowOptimizerSummary(v => !v)} className="px-3 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#141722] dark:hover:bg-[#1a2030] border border-slate-300 dark:border-[#1a2030] text-slate-700 dark:text-slate-200 text-xs font-semibold cursor-pointer">
                    {showOptimizerSummary ? 'Hide summary' : 'Show summary'}
                  </button>
                </>
              )}
            </div>
          </div>
          {(optimizerRunning || optimizerServerRunning) && (
            <div className="text-xs text-slate-500 font-mono">
              {optimizerProgress || 'Working...'}
              {optimizerDetails?.variants_tested != null && <span className="ml-2">Variants tested: {optimizerDetails.variants_tested}</span>}
              {optimizerDetails?.elapsed_s != null && <span className="ml-2">Elapsed: {Math.round(optimizerDetails.elapsed_s)}s</span>}
            </div>
          )}
          {optimizerError && !optimizerRunning && !optimizerServerRunning && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-700 dark:text-rose-300 font-mono">{optimizerError}</div>
          )}
          {optimizerSummaryText && !optimizerRunning && !optimizerServerRunning && (
            <div className="space-y-2">
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-800 dark:text-emerald-300">
                Optimizer finished. Suggested file: <code className="font-mono">config/pair_settings.suggested.json</code>. Live settings untouched.
              </div>
              {showOptimizerSummary && (
                <textarea readOnly value={optimizerSummaryText} rows={24} onFocus={(e) => e.target.select()}
                  className="w-full p-3.5 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-[11px] text-black dark:text-slate-200 focus:outline-none" />
              )}
            </div>
          )}
        </div>
      )}

      <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}
        className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
        <div className="flex items-center gap-2 text-[11px] font-mono text-slate-600 dark:text-slate-300">
          <FileText className="w-3.5 h-3.5 text-blue-500" />
          <span>Exporting <strong className="text-black dark:text-white">{exportPairCount}</strong> pair{exportPairCount === 1 ? '' : 's'}</span>
          {startingBalance && (
            <span className="text-slate-400">
              · start {startingBalance} {accountCurrency} · {backtestProfile}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <a href="/api/backtest/export.txt" download className="px-3 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors shadow-xs">
            <Download className="w-3.5 h-3.5" /><span>Export for AI (.txt)</span>
          </a>
          <a href="/api/backtest/export-zip" download className="px-3 py-2 rounded-xl bg-white hover:bg-slate-100 dark:bg-[#0f1118] dark:hover:bg-[#141722] border border-slate-300 dark:border-[#1a2030] text-xs font-semibold text-black dark:text-slate-200 flex items-center gap-1.5 cursor-pointer transition-colors shadow-xs">
            <Download className="w-3.5 h-3.5 text-blue-500" /><span>Export for AI (.zip)</span>
          </a>
          <button type="button" onClick={handleExportPDF} disabled={isExportingPdf}
            className="px-3 py-2 rounded-xl bg-white hover:bg-slate-100 dark:bg-[#0f1118] dark:hover:bg-[#141722] border border-slate-300 dark:border-[#1a2030] text-xs font-semibold text-black dark:text-slate-200 flex items-center gap-1.5 cursor-pointer transition-colors shadow-xs disabled:opacity-50">
            <Printer className="w-3.5 h-3.5 text-emerald-500" /><span>{isExportingPdf ? 'Building...' : 'Export JSON'}</span>
          </button>
        </div>
      </motion.div>

      {runResults.length > 0 && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-black dark:text-white">Run Results</span>
            <button onClick={() => setRunResults([])} className="text-xs text-slate-400 hover:text-black dark:hover:text-white cursor-pointer">Dismiss</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 pt-1">
            {runResults.map((r, i) => (
              <div key={i} className={`p-3 rounded-xl border text-xs font-mono ${r.status === 'OK' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600' : 'bg-rose-500/10 border-rose-500/30 text-rose-600'}`}>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-black dark:text-white">{r.symbol}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${r.status === 'OK' ? 'bg-emerald-500/20 text-emerald-600' : 'bg-rose-500/20 text-rose-600'}`}>{r.status}</span>
                </div>
                <div className="text-[11px] break-words whitespace-pre-wrap mt-1">{r.message}</div>
                {r.timing && (
                  <div className="pt-1.5 mt-1 border-t border-slate-200 dark:border-[#1a2030] text-[10px] text-slate-600 dark:text-slate-400 flex items-start gap-1">
                    <Clock className="w-3 h-3 text-blue-500 shrink-0 mt-0.5" /><span>{r.timing}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {isRunning && (
        <div className="p-4 rounded-2xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-between text-xs">
          <div className="flex items-center gap-3">
            <RefreshCw className="w-4 h-4 text-blue-500 animate-spin shrink-0" />
            <div>
              <div className="font-bold text-blue-600 dark:text-blue-400">Simulation in Progress</div>
              <div className="text-slate-500 font-mono text-[11px] mt-0.5">{progressText}</div>
            </div>
          </div>
          <button type="button" onClick={handleStopBacktest} className="px-3 py-1.5 rounded-lg text-[11px] font-bold font-mono bg-rose-600 hover:bg-rose-500 text-white cursor-pointer">Cancel</button>
        </div>
      )}

      {storageInfo && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <Database className="w-4 h-4 text-blue-500 shrink-0" />
              <span className="font-bold text-black dark:text-white">Storage:</span>
              <span className="font-mono text-slate-600 dark:text-slate-300">{storageInfo.used_mb} MB used / {storageInfo.free_mb} MB free</span>
              <span className="font-mono text-[11px] text-slate-500">Reports: <strong className="text-blue-500">{storageInfo.reports_mb} MB</strong> · Data: <strong className="text-emerald-500">{storageInfo.market_data_mb} MB</strong></span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button type="button" disabled={isCleaning || anyJobRunning} onClick={() => handleCleanup('symbol')}
                className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#141722] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
                <Trash2 className="w-3 h-3 text-amber-500" /><span>Clear {testSymbol} reports</span>
              </button>
              <button type="button" disabled={isCleaning || anyJobRunning} onClick={() => handleCleanup('all_reports')}
                className="px-3 py-1.5 rounded-lg bg-rose-600/10 hover:bg-rose-600/20 text-rose-600 border border-rose-500/30 text-[11px] font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
                <Trash2 className="w-3 h-3 text-rose-500" /><span>Clear all</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {summaryData?.combinations && summaryData.combinations.length > 0 && (
        <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-sm font-bold text-black dark:text-white">Results by Combination ({summaryData.symbol} · {summaryData.days} Days)</h3>
            {summaryData.starting_balance_usd != null && (
              <span className="text-[10px] font-mono text-slate-500">
                start {summaryData.starting_balance_input ?? '?'} {summaryData.currency ?? 'USD'} (≈ ${summaryData.starting_balance_usd}) · profile {summaryData.profile_name ?? 'None'}
              </span>
            )}
          </div>
          <HowToRead metricKey="sec_combinations" />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                  <th className="py-2.5 px-3">Combination</th>
                  <th className="py-2.5 px-3 text-center">Trades</th>
                  <th className="py-2.5 px-3 text-center">Win Rate</th>
                  <th className="py-2.5 px-3 text-center">Exp (R)</th>
                  <th className="py-2.5 px-3 text-center">PF</th>
                  <th className="py-2.5 px-3 text-right">Max DD</th>
                  <th className="py-2.5 px-3 text-right">Net P&L</th>
                  <th className="py-2.5 px-3 text-center">TUNE</th>
                  <th className="py-2.5 px-3 text-center">VALIDATE</th>
                  <th className="py-2.5 px-3 text-center">Verdict</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                {summaryData.combinations.map((c: any, idx: number) => {
                  const tv = c.tune_validate || {};
                  const cTune = tv.tune || {};
                  const cVal = tv.validate || {};
                  const holdout = c.holdout_verdict || holdoutVerdictLocal(cTune, cVal);
                  return (
                    <tr key={idx} onClick={() => setSelectedFile(c.report_file)}
                      className={`cursor-pointer transition-colors ${selectedFile === c.report_file ? 'bg-blue-500/15' : idx === bestComboIdx ? 'bg-amber-500/10' : 'hover:bg-slate-50 dark:hover:bg-[#121520]'}`}>
                      <td className="py-3 px-3 font-bold text-black dark:text-white">
                        {idx === bestComboIdx && <span className="text-amber-500 mr-1">★</span>}{c.label}
                      </td>
                      <td className="py-3 px-3 text-center font-bold">{c.total_trades}</td>
                      <td className={`py-3 px-3 text-center font-bold ${c.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{c.win_rate}%</td>
                      <td className="py-3 px-3 text-center">{c.expectancy}R</td>
                      <td className="py-3 px-3 text-center">{c.profit_factor}</td>
                      <td className="py-3 px-3 text-right text-rose-500">-${c.max_drawdown}</td>
                      <td className={`py-3 px-3 text-right font-bold ${c.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${c.net_pnl}</td>
                      <td className="py-3 px-3 text-center text-[11px]">{cTune.count ?? 0}t / PF {formatNum(cTune.profit_factor)}</td>
                      <td className="py-3 px-3 text-center text-[11px]">{cVal.count ?? 0}t / PF {formatNum(cVal.profit_factor)}</td>
                      <td className="py-3 px-3 text-center"><VerdictPill verdict={holdout} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-[#1a2030] pb-2">
        {([
          ['summary', 'Summary', TrendingUp],
          ['profiles', 'Profiles', DollarSign],
          ['diagnostics', 'Diagnostics', Activity],
          ['portfolio', 'Portfolio', Network],
          ['lab', 'Strategy Lab', FlaskConical],
          ['spreads', 'Spreads', Sliders],
          ['pipcalc', 'Pip Calculator', Calculator],
          ['tips', 'Tips', Lightbulb],
          ['ledger', `Ledger (${reportData?.all_trades?.length || 0})`, FileText],
        ] as const).map(([key, label, Icon]) => (
          <button key={key} onClick={() => setActiveSubTab(key as any)}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === key ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
            <Icon className="w-3.5 h-3.5" /><span>{label}</span>
          </button>
        ))}
      </div>

      {activeSubTab === 'summary' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Total Trades <InfoTip metricKey="total_trades" /></div>
              <div className="text-2xl font-bold font-mono text-blue-600 dark:text-blue-400 mt-1">{kpis.count}</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Win Rate <InfoTip metricKey="win_rate" /></div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{kpis.win_rate}%</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Expectancy <InfoTip metricKey="expectancy" /></div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.expectancy > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{kpis.expectancy}R</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Profit Factor <InfoTip metricKey="profit_factor" /></div>
              <div className="text-2xl font-bold font-mono text-black dark:text-white mt-1">{kpis.profit_factor}</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Max DD <InfoTip metricKey="max_drawdown" /></div>
              <div className="text-2xl font-bold font-mono text-rose-600 mt-1">-${kpis.max_dd_money}</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Net P&L <InfoTip metricKey="net_pnl" /></div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{formatCurrency(kpis.net_pnl, brokerCurrency)}</div>
            </div>
          </div>

          {reportData?.strategy_kpis && Object.keys(reportData.strategy_kpis).length > 0 && (
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3">Per-Strategy</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                      <th className="py-2.5 px-3">Strategy</th>
                      <th className="py-2.5 px-3 text-center">Trades</th>
                      <th className="py-2.5 px-3 text-center">Win Rate</th>
                      <th className="py-2.5 px-3 text-center">PF</th>
                      <th className="py-2.5 px-3 text-right">Net P&L</th>
                      <th className="py-2.5 px-3 text-center">Verdict</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                    {Object.entries(reportData.strategy_kpis).map(([sName, sKpi]: any) => {
                      const tv = (reportData as any)?.strategy_tune_validate?.[sName] || {};
                      const verdict = holdoutVerdictLocal(tv.tune, tv.validate);
                      return (
                        <tr key={sName} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                          <td className="py-3 px-3 font-bold text-black dark:text-white">{sName}</td>
                          <td className="py-3 px-3 text-center font-bold">{sKpi.count}</td>
                          <td className={`py-3 px-3 text-center font-bold ${sKpi.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{sKpi.win_rate}%</td>
                          <td className="py-3 px-3 text-center">{sKpi.profit_factor}</td>
                          <td className={`py-3 px-3 text-right font-bold ${sKpi.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${sKpi.net_pnl}</td>
                          <td className="py-3 px-3 text-center"><VerdictPill verdict={verdict} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {reportData?.dow_kpis && Object.keys(reportData.dow_kpis).length > 0 && (
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3">Per-Weekday</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                      <th className="py-2.5 px-3">Weekday</th>
                      <th className="py-2.5 px-3 text-center">Trades</th>
                      <th className="py-2.5 px-3 text-center">Win Rate</th>
                      <th className="py-2.5 px-3 text-center">PF</th>
                      <th className="py-2.5 px-3 text-right">Net P&L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                    {Object.entries(reportData.dow_kpis).map(([dow, sKpi]: any) => (
                      <tr key={dow} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                        <td className="py-3 px-3 font-bold text-black dark:text-white">{dow}</td>
                        <td className="py-3 px-3 text-center font-bold">{sKpi.count}</td>
                        <td className={`py-3 px-3 text-center font-bold ${sKpi.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{sKpi.win_rate}%</td>
                        <td className="py-3 px-3 text-center">{sKpi.profit_factor}</td>
                        <td className={`py-3 px-3 text-right font-bold ${sKpi.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${sKpi.net_pnl}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'profiles' && (
        <div className="space-y-4">
          <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-black dark:text-white flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-emerald-500" />
                  Risk Profile Matrix
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Same trades, five profiles, five starting balances. Computed live from the current report's trade list.
                  Cells with a dash mean the min-lot cash risk exceeds that profile's per-trade budget at that balance.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Custom balance</label>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-mono text-slate-500">{accountCurrency === 'ZAR' ? 'R' : '$'}</span>
                  <input
                    type="number" step="1" min="1"
                    value={customBalance}
                    onChange={(e) => setCustomBalance(e.target.value)}
                    placeholder="e.g. 2500"
                    className="w-24 px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-xs text-black dark:text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
            </div>

            {!profileMatrix ? (
              <div className="p-6 text-center text-xs text-slate-500">Load a report with trades to compute the matrix.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[11px] font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                      <th className="py-2.5 px-3">Profile</th>
                      {profileBalances.map(b => (
                        <th key={b} className="py-2.5 px-3 text-center">
                          {accountCurrency === 'ZAR' ? `R${(b * zarPerUsd).toFixed(0)}` : `$${b}`}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                    {PROFILE_NAMES.map((pname) => (
                      <tr key={pname} className={pname === 'None' ? 'bg-slate-50/40 dark:bg-[#0a0d14]/40' : ''}>
                        <td className="py-2.5 px-3 font-bold text-black dark:text-white">{pname}</td>
                        {profileBalances.map(b => {
                          const r = profileMatrix[pname]?.[String(b)];
                          if (!r || r.trades_taken === 0) {
                            return <td key={b} className="py-2.5 px-3 text-center text-slate-400">—</td>;
                          }
                          const pnl = r.net_pnl;
                          const color = pnl >= 0 ? 'text-emerald-500' : 'text-rose-500';
                          return (
                            <td key={b} className="py-2.5 px-3 text-center">
                              <div className={`font-bold ${color}`}>{pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</div>
                              <div className="text-[9px] text-slate-500">
                                {r.trades_taken}t {r.trades_skipped_min_lot > 0 && `· ${r.trades_skipped_min_lot} skip`}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {activeSubTab === 'diagnostics' && reportData?.diagnostics && (
        <div className="space-y-4">
          <HowToRead metricKey="sec_diagnostics" />
          <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
            <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§19 Hour Matrix <InfoTip metricKey="diag_hour_matrix" /></h3>
            <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-12 gap-2">
              {Array.from({ length: 24 }, (_, h) => {
                const k = reportData.diagnostics?.hour_kpis?.[String(h)];
                const hasData = k && k.count > 0;
                const isWin = hasData && k.net_pnl >= 0;
                return (
                  <div key={h} className={`p-2 rounded-xl border text-[10px] font-mono ${!hasData ? 'bg-slate-50 dark:bg-[#08090d] border-slate-200 dark:border-[#1a2030] text-slate-400' : isWin ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600' : 'bg-rose-500/10 border-rose-500/30 text-rose-600'}`}>
                    <div className="flex items-center justify-between mb-1"><span className="font-bold">{String(h).padStart(2, '0')}</span></div>
                    {hasData ? (
                      <><div className="truncate">n={k.count}</div><div className="truncate font-bold">{k.win_rate}%</div><div className="truncate">{k.net_pnl >= 0 ? '+' : ''}${k.net_pnl}</div></>
                    ) : <div className="text-center text-slate-300 dark:text-slate-600">—</div>}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§31 Streaks <InfoTip metricKey="diag_streak" /></h3>
              <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Max Streak</div>
                  <div className="text-lg font-bold text-rose-500">{reportData.diagnostics.streak_analysis.max_consecutive_losses}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Peak DD</div>
                  <div className="text-lg font-bold text-rose-500">-${reportData.diagnostics.streak_analysis.peak_drawdown}</div>
                </div>
              </div>
            </div>

            <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§37 Bootstrap Monte Carlo <InfoTip metricKey="diag_monte_carlo" /></h3>
              <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Median Final P&L</div>
                  <div className={`text-lg font-bold ${(reportData.diagnostics.monte_carlo.median_final_pnl ?? 0) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${reportData.diagnostics.monte_carlo.median_final_pnl}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Prob Positive</div>
                  <div className={`text-lg font-bold ${(reportData.diagnostics.monte_carlo.prob_positive ?? 0) >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{reportData.diagnostics.monte_carlo.prob_positive}%</div>
                </div>
              </div>
            </div>
          </div>

          {reportData.diagnostics.slippage_sensitivity && Object.keys(reportData.diagnostics.slippage_sensitivity).length > 0 && (
            <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§34 Slippage <InfoTip metricKey="diag_slippage" /></h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                      <th className="py-2 px-3">Slippage</th>
                      <th className="py-2 px-3 text-right">Net P&L</th>
                      <th className="py-2 px-3 text-center">Win Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                    {Object.values(reportData.diagnostics.slippage_sensitivity).map((pt: any, i: number) => (
                      <tr key={i}>
                        <td className="py-2.5 px-3 font-bold text-black dark:text-white">{pt.slippage_pips === 0 ? 'Baseline' : `${pt.slippage_pips} pip${pt.slippage_pips > 1 ? 's' : ''}`}</td>
                        <td className={`py-2.5 px-3 text-right font-bold ${pt.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${pt.net_pnl}</td>
                        <td className="py-2.5 px-3 text-center">{pt.win_rate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'portfolio' && (
        <div className="space-y-4">
          {isLoadingPortfolio ? (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center">
              <RefreshCw className="w-6 h-6 text-blue-500 animate-spin mx-auto" />
            </div>
          ) : portfolioData ? (
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3">Portfolio Correlation</h3>
              <div className="overflow-x-auto">
                <table className="text-[11px] font-mono border-separate border-spacing-0.5">
                  <thead>
                    <tr>
                      <th className="px-2 py-1.5"></th>
                      {portfolioData.symbols.map((s) => <th key={s} className="px-2 py-1.5 text-center">{s}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {portfolioData.symbols.map((rowSym) => (
                      <tr key={rowSym}>
                        <td className="px-2 py-1.5 font-bold text-right">{rowSym}</td>
                        {portfolioData.symbols.map((colSym) => {
                          const v = portfolioData.correlation_matrix?.[rowSym]?.[colSym];
                          const num = typeof v === 'number' ? v : 0;
                          const isSelf = rowSym === colSym;
                          return (
                            <td key={colSym} className={`px-2 py-1.5 text-center rounded border ${isSelf ? 'bg-blue-500/20' : corrColor(num)}`}>
                              {isSelf ? '1.00' : num.toFixed(2)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center text-xs text-slate-500">
              {portfolioError || 'No portfolio correlation yet'}
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'lab' && (
        <div className="space-y-4">
          {labPayloadBySymbol[testSymbol] ? (
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-amber-500/30 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-black dark:text-white">
                  Strategy Lab — {testSymbol} · Baseline: {labPayloadBySymbol[testSymbol]!.baseline_label}
                </h3>
                <button type="button" onClick={() => handleCopyLabForAI(testSymbol)}
                  className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer">
                  {labCopyStatus[testSymbol] === 'copied' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{labCopyStatus[testSymbol] === 'copied' ? 'Copied' : 'Copy for AI'}</span>
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                      <th className="py-2.5 px-3">Variant</th>
                      <th className="py-2.5 px-3 text-center">Trades</th>
                      <th className="py-2.5 px-3 text-center">Win Rate</th>
                      <th className="py-2.5 px-3 text-center">PF</th>
                      <th className="py-2.5 px-3 text-right">Net P&L</th>
                      <th className="py-2.5 px-3 text-center">TUNE PF (TR)</th>
                      <th className="py-2.5 px-3 text-center">VALIDATE PF (TR)</th>
                      <th className="py-2.5 px-3 text-center">Verdict</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                    {[...labPayloadBySymbol[testSymbol]!.variants]
                      .sort((a, b) => {
                        const rank = (v: string) => v === 'IMPROVES' ? 0 : v === 'NO' ? 1 : 2;
                        return rank(a.verdict) - rank(b.verdict);
                      })
                      .map((v, i) => (
                        <tr key={i} className={`hover:bg-slate-50 dark:hover:bg-[#121520] ${v.verdict === 'IMPROVES' ? 'bg-emerald-500/5' : ''}`}>
                          <td className="py-2.5 px-3 font-bold text-black dark:text-white">{v.label}</td>
                          <td className="py-2.5 px-3 text-center">{v.trades}</td>
                          <td className={`py-2.5 px-3 text-center font-bold ${v.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{formatNum(v.win_rate, 1)}%</td>
                          <td className="py-2.5 px-3 text-center">{formatNum(v.profit_factor)}</td>
                          <td className={`py-2.5 px-3 text-right font-bold ${v.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${formatNum(v.net_pnl)}</td>
                          <td className="py-2.5 px-3 text-center">{formatNum(v.tune_pf)} ({v.tune_trades})</td>
                          <td className="py-2.5 px-3 text-center">{formatNum(v.validate_pf)} ({v.validate_trades})</td>
                          <td className="py-2.5 px-3 text-center"><VerdictPill verdict={v.verdict} /></td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center text-xs text-slate-500">
              {isLoadingLab ? 'Loading...' : `No lab for ${testSymbol}. Click Strategy Lab above.`}
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'spreads' && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-black dark:text-white flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-blue-500" /> Broker Spread Editor
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  All-in spread in price terms: raw spread + commission converted to price. Applies to the next backtest.
                  You can add more broker presets by editing <code className="font-mono">config/spread_config.json</code> directly.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={handleResetSpreads}
                  className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#141722] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer">
                  <RotateCcw className="w-3 h-3" /><span>Reset to Fusion</span>
                </button>
                <button type="button" onClick={handleSaveSpreads} disabled={spreadSaveStatus === 'saving'}
                  className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
                  <Save className="w-3 h-3" />
                  <span>{spreadSaveStatus === 'saving' ? 'Saving...' : spreadSaveStatus === 'saved' ? 'Saved' : spreadSaveStatus === 'error' ? 'Error' : 'Save'}</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {WHITELIST_ASSETS.map((sym) => (
                <div key={sym} className="p-3 rounded-xl bg-slate-50 dark:bg-[#0a0d14] border border-slate-200 dark:border-[#1a2030]">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">{sym}</label>
                  <input
                    type="number" step="any" min="0"
                    value={spreadDraft[sym] ?? ''}
                    onChange={(e) => setSpreadDraft(prev => ({ ...prev, [sym]: e.target.value }))}
                    className="mt-1.5 w-full px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-xs text-black dark:text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeSubTab === 'pipcalc' && (
        <div className="space-y-4">
          {pipCalcError ? (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center text-xs text-slate-500">
              {pipCalcError}
            </div>
          ) : !pipCalcData ? (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center text-xs text-slate-500">
              <RefreshCw className="w-6 h-6 text-blue-500 animate-spin mx-auto mb-2" />
              Loading pip calculator...
            </div>
          ) : (
            Object.entries(pipCalcData.pairs || {}).map(([pair, block]) => {
              const pairLevel = block.pair_level;
              return (
                <div key={pair} className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <h3 className="text-sm font-bold text-black dark:text-white flex items-center gap-2">
                      <Calculator className="w-4 h-4 text-emerald-500" /> {pair}
                    </h3>
                    {pairLevel && (
                      <div className="flex items-center gap-3 text-[10px] font-mono text-slate-500">
                        <span>Pair-level: <strong className="text-black dark:text-white">{pairLevel.min_sl_pips} pips</strong></span>
                        <span>·</span>
                        <span>Post-SL R: {pairLevel.post_sl_R}</span>
                        <span>·</span>
                        <span>Factor: {pairLevel.sl_factor}×</span>
                        <span>·</span>
                        <span>Sample: {pairLevel.sample_trades}t</span>
                      </div>
                    )}
                  </div>
                  {Object.keys(block.strategies || {}).length === 0 ? (
                    <div className="text-xs text-slate-500 italic">No strategies qualified for {pair}.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs font-mono">
                        <thead>
                          <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                            <th className="py-2 px-3">Strategy</th>
                            <th className="py-2 px-3 text-right">Base SL (pips)</th>
                            <th className="py-2 px-3 text-right">Post-SL R</th>
                            <th className="py-2 px-3 text-right">Factor</th>
                            <th className="py-2 px-3 text-right">Min SL (pips)</th>
                            <th className="py-2 px-3 text-right">TP at 1:3 (pips)</th>
                            <th className="py-2 px-3 text-center">Sample</th>
                            <th className="py-2 px-3 text-center">Source</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                          {Object.entries(block.strategies).map(([strat, e]) => (
                            <tr key={strat} className={e.source === 'pair_fallback' ? 'opacity-70' : ''}>
                              <td className="py-2.5 px-3 font-bold text-black dark:text-white">{strat}</td>
                              <td className="py-2.5 px-3 text-right">{e.base_sl_pips}</td>
                              <td className="py-2.5 px-3 text-right">{e.post_sl_R}</td>
                              <td className="py-2.5 px-3 text-right">{e.sl_factor}×</td>
                              <td className="py-2.5 px-3 text-right text-emerald-500 font-bold">{e.min_sl_pips}</td>
                              <td className="py-2.5 px-3 text-right text-blue-500 font-bold">{(e.min_sl_pips * 3).toFixed(1)}</td>
                              <td className="py-2.5 px-3 text-center">{e.sample_trades}t</td>
                              <td className="py-2.5 px-3 text-center">
                                <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                                  e.source === 'per_strategy' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-amber-500/15 text-amber-600'
                                }`}>
                                  {e.source === 'per_strategy' ? 'PER-STRATEGY' : 'PAIR-FALLBACK'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {activeSubTab === 'tips' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {activeTips.map((tip) => (
            <div key={tip.id} className="p-5 rounded-2xl border bg-white dark:bg-[#0f1118] flex flex-col justify-between space-y-3">
              <div className="flex items-center justify-between">
                <span className="px-2 py-0.5 rounded text-[9px] font-mono font-bold bg-blue-500/15 text-blue-600">{tip.severity}</span>
                <button type="button" onClick={() => setDismissedTipIds(prev => [...prev, tip.id])} className="text-slate-400 hover:text-rose-600"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
              <h4 className="text-sm font-bold text-black dark:text-white">{tip.title}</h4>
              <p className="text-xs text-slate-600 dark:text-slate-400">{tip.description}</p>
            </div>
          ))}
          {activeTips.length === 0 && (
            <div className="col-span-full p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center text-xs text-slate-500">
              No tips for this report.
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'ledger' && (
        <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500 bg-slate-50 dark:bg-[#08090d]/50">
                  <th className="py-3 px-3">Date</th><th className="py-3 px-3">Strategy</th><th className="py-3 px-3">Dir</th>
                  <th className="py-3 px-3">Entry</th><th className="py-3 px-3">Exit</th><th className="py-3 px-3">R</th>
                  <th className="py-3 px-3 text-right">Net P&L</th><th className="py-3 px-3">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                {filteredTrades.slice(0, 500).map((t: any, idx: number) => (
                  <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                    <td className="py-2.5 px-3 text-slate-400">{t.date_sast || t.date}</td>
                    <td className="py-2.5 px-3 font-bold text-black dark:text-white">{t.strategy}</td>
                    <td className={`py-2.5 px-3 font-bold ${t.direction === 'BUY' ? 'text-emerald-500' : 'text-rose-500'}`}>{t.direction}</td>
                    <td className="py-2.5 px-3">{formatPriceBySymbol(t.entry_price, t.symbol)}</td>
                    <td className="py-2.5 px-3">{formatPriceBySymbol(t.exit_price, t.symbol)}</td>
                    <td className={`py-2.5 px-3 font-bold ${t.r_multiple > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{t.r_multiple}R</td>
                    <td className={`py-2.5 px-3 text-right font-bold ${t.money_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${t.money_pnl}</td>
                    <td className="py-2.5 px-3"><span className={`text-[9px] px-2 py-0.5 rounded font-bold ${t.result === 'WIN' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'}`}>{t.result}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};