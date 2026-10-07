import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import { createChart, IChartApi, ColorType, LineStyle, UTCTimestamp } from 'lightweight-charts';
import {
  Calendar, TrendingUp, RefreshCw, Play, AlertTriangle, Lightbulb, Trash2, RotateCcw,
  Sparkles, Layers, Square, Copy, Check, Table, Database, Clock, ShieldCheck, Download, Printer,
  FileText, Activity, Network, GitBranch, Info, FlaskConical, CheckSquare, Square as SquareOff
} from 'lucide-react';
import {
  ThemeMode, BacktestReportPayload, BacktestKPIs, ImprovementTip,
  PortfolioCorrelation, BacktestVariants, BacktestVariantRow
} from '../../types';
import { formatCurrency } from '../../utils/currency';
import { describe } from '../../../shared/metricDescriptions';

interface BacktestViewProps {
  themeMode?: ThemeMode;
  brokerCurrency?: string;
}

interface SummaryCombination {
  label: string;
  mode: string;
  be: string;
  trail: string;
  report_file: string;
  total_trades: number;
  win_rate: number;
  expectancy: number;
  profit_factor: number;
  max_drawdown: number;
  net_pnl: number;
  adaptive_effective_pct: number;
  holdout_verdict?: string;
  tune_validate?: any;
  funnel?: {
    raw_signals_fired: number;
    adapted_signals_passed: number;
    vol_filters_blocked: number;
    sim_trades_attempted: number;
    sim_trades_filled: number;
  };
}

interface SymbolSummaryPayload {
  symbol: string;
  days: number;
  target_rr: number;
  generated_at: string;
  total_seconds?: number;
  phase_seconds?: any;
  cpu_cores?: number;
  concurrent_processes?: number;
  combinations: SummaryCombination[];
}

interface StorageInfo {
  total_mb: number;
  used_mb: number;
  free_mb: number;
  market_data_mb: number;
  reports_mb: number;
}

interface RunResultItem {
  symbol: string;
  status: 'OK' | 'FAILED';
  message: string;
  timing?: string;
}

interface LabVariantRow {
  label: string;
  trades: number;
  win_rate: number;
  profit_factor: number;
  max_drawdown: number;
  net_pnl: number;
  expectancy: number;
  tune_pf: number;
  tune_trades: number;
  validate_pf: number;
  validate_trades: number;
  verdict: 'IMPROVES' | 'NO' | 'INCONCLUSIVE';
}

interface LabPayload {
  symbol: string;
  days: number;
  generated_at: string;
  window_start: string;
  window_end: string;
  baseline_label: string;
  variants: LabVariantRow[];
}

const WHITELIST_ASSETS = ["US30", "GOLD", "NAS100", "GERMAN30", "EURUSD", "GBPUSD", "USDJPY"];

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

function prettifyReportName(filename: string): string {
  if (!filename) return 'Report';
  if (filename.includes('_summary.json')) return `${filename.replace('_summary.json', '')} · 8-Combo Summary`;
  const clean = filename.replace('_report.json', '');
  const parts = clean.split('_');
  if (parts.length >= 4) {
    const sym = parts[0];
    const mode = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    const be = parts[2].replace('be', 'BE ');
    const trail = parts[3].replace('trail', 'Trail ');
    return `${sym} · ${mode} · ${be} · ${trail}`;
  }
  return filename;
}

function corrColor(v: number): string {
  if (v >= 0.7) return 'bg-rose-500/40 text-rose-900 dark:text-rose-100 border-rose-500/50';
  if (v >= 0.4) return 'bg-amber-500/30 text-amber-900 dark:text-amber-100 border-amber-500/40';
  if (v >= 0.15) return 'bg-slate-400/20 text-slate-800 dark:text-slate-200 border-slate-400/30';
  if (v > -0.15) return 'bg-slate-200/40 dark:bg-[#0d1017] text-slate-600 dark:text-slate-300 border-slate-300 dark:border-[#1a2030]';
  if (v > -0.4) return 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 border-emerald-500/30';
  return 'bg-emerald-500/40 text-emerald-900 dark:text-emerald-100 border-emerald-500/50';
}

// -----------------------------------------------------------------------------
// Shared description UI primitives
// -----------------------------------------------------------------------------

const InfoTip: React.FC<{ metricKey: string }> = ({ metricKey }) => {
  const [open, setOpen] = useState(false);
  const d = describe(metricKey);
  return (
    <span
      className="relative inline-flex items-center ml-1 align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={`Info: ${d.title}`}
        tabIndex={0}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="text-slate-400 hover:text-blue-500 focus:text-blue-500 cursor-help outline-none"
      >
        <Info className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 z-[60] w-64 p-3 rounded-xl bg-slate-900 text-white text-[11px] leading-relaxed shadow-2xl border border-slate-700 pointer-events-none">
          <div className="font-bold text-blue-300 mb-1">{d.title}</div>
          <div className="text-slate-200">{d.description}</div>
          <div className="mt-1.5 pt-1.5 border-t border-slate-700 text-slate-400 italic">
            {d.howToRead}
          </div>
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
      <span>
        <strong className="not-italic text-blue-500">How to read this:</strong> {d.howToRead}
      </span>
    </p>
  );
};

const VerdictPill: React.FC<{ verdict?: string; className?: string }> = ({ verdict, className = '' }) => {
  const v = verdict || 'INCONCLUSIVE';
  const cfg: Record<string, string> = {
    HOLDS: 'bg-emerald-500/15 text-emerald-600 border border-emerald-500/30',
    FLAT: 'bg-slate-500/15 text-slate-500 border border-slate-400/30',
    FAILS: 'bg-rose-500/15 text-rose-600 border border-rose-500/30',
    INCONCLUSIVE: 'bg-slate-400/15 text-slate-500 border border-slate-400/30',
    IMPROVES: 'bg-emerald-500/15 text-emerald-600 border border-emerald-500/30',
    NO: 'bg-slate-500/15 text-slate-500 border border-slate-400/30',
  };
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold ${cfg[v] || cfg.INCONCLUSIVE} ${className}`}>
      {v}
    </span>
  );
};

// Local mirror of the server-side three-state verdict, used only for optimistic display
// before the summary file is regenerated. Falls back to INCONCLUSIVE when either window
// is too thin.
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

export const BacktestView: React.FC<BacktestViewProps> = ({ themeMode = 'dark', brokerCurrency = 'USD' }) => {
  const [reportFiles, setReportFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [reportData, setReportData] = useState<BacktestReportPayload | null>(null);
  const [summaryData, setSummaryData] = useState<SymbolSummaryPayload | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<'summary' | 'diagnostics' | 'portfolio' | 'variants' | 'chart' | 'ledger' | 'tips'>('summary');
  const [selectedDay, setSelectedDay] = useState<string>('');

  // Multi-select pair UI. Single-pair testSymbol is kept in sync so the summary
  // loader and other single-symbol actions keep working.
  const [testSymbol, setTestSymbol] = useState<string>('US30');
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(['US30']);
  const [multiSelectOpen, setMultiSelectOpen] = useState<boolean>(false);

  const [testDays, setTestDays] = useState<number>(60);
  const [testRr, setTestRr] = useState<number>(1.0);
  const [includeVariants, setIncludeVariants] = useState<boolean>(false);

  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [isCleaning, setIsCleaning] = useState<boolean>(false);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [progressText, setProgressText] = useState<string>('');
  const [runResults, setRunResults] = useState<RunResultItem[]>([]);

  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [verifyCopyStatus, setVerifyCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [isExportingPdf, setIsExportingPdf] = useState<boolean>(false);

  const [strategyFilter, setStrategyFilter] = useState<string>('ALL');
  const [outcomeFilter, setOutcomeFilter] = useState<string>('ALL');
  const [tipFilter, setTipFilter] = useState<string>('ALL');

  const [portfolioData, setPortfolioData] = useState<PortfolioCorrelation | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [isLoadingPortfolio, setIsLoadingPortfolio] = useState<boolean>(false);

  const [variantsData, setVariantsData] = useState<BacktestVariants | null>(null);
  const [variantsError, setVariantsError] = useState<string | null>(null);
  const [isLoadingVariants, setIsLoadingVariants] = useState<boolean>(false);

  // ---- Strategy Lab state ----
  const [labRunning, setLabRunning] = useState<boolean>(false);
  const [labProgress, setLabProgress] = useState<string>('');
  const [labError, setLabError] = useState<string | null>(null);
  const [labResults, setLabResults] = useState<Array<{ symbol: string; status: 'OK' | 'FAILED'; message: string }>>([]);
  const [labPayloadBySymbol, setLabPayloadBySymbol] = useState<Record<string, LabPayload | null>>({});
  const [isLoadingLab, setIsLoadingLab] = useState<boolean>(false);
  const [labCopyStatus, setLabCopyStatus] = useState<Record<string, 'idle' | 'copied'>>({});

  const [dismissedTipIds, setDismissedTipIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('dismissed_improvement_tips');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);

  const fetchStorageInfo = useCallback(async () => {
    try {
      const res = await fetch('/api/backtest/storage');
      if (res.ok) {
        const json = await res.json();
        if (json.data) setStorageInfo(json.data);
      }
    } catch {}
  }, []);

  useEffect(() => { fetchStorageInfo(); }, [fetchStorageInfo]);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/backtest/status');
        if (res.ok) {
          const json = await res.json();
          if (json.isRunning) {
            setIsRunning(true);
            setProgressText(json.progress || 'Simulation in progress...');
          }
          if (Array.isArray(json.results) && json.results.length > 0) setRunResults(json.results);
        }
      } catch {}
      try {
        const res = await fetch('/api/backtest/lab-status');
        if (res.ok) {
          const json = await res.json();
          if (json.isRunning) {
            setLabRunning(true);
            setLabProgress(json.progress || 'Strategy Lab in progress...');
          }
          if (Array.isArray(json.results) && json.results.length > 0) setLabResults(json.results);
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
      if (res.ok) {
        const json = await res.json();
        setSummaryData(json.data || null);
      } else { setSummaryData(null); }
    } catch { setSummaryData(null); }
  }, []);

  useEffect(() => { fetchSummaryData(testSymbol); }, [testSymbol, fetchSummaryData]);

  const fetchLabForSymbol = useCallback(async (sym: string) => {
    setIsLoadingLab(true);
    try {
      const res = await fetch(`/api/backtest/lab/${sym}`);
      if (res.ok) {
        const json = await res.json();
        setLabPayloadBySymbol(prev => ({ ...prev, [sym]: json.data || null }));
      } else {
        setLabPayloadBySymbol(prev => ({ ...prev, [sym]: null }));
      }
    } catch {
      setLabPayloadBySymbol(prev => ({ ...prev, [sym]: null }));
    } finally {
      setIsLoadingLab(false);
    }
  }, []);

  useEffect(() => {
    // Load lab payload for the currently focused symbol on demand.
    if (labPayloadBySymbol[testSymbol] === undefined) {
      fetchLabForSymbol(testSymbol);
    }
  }, [testSymbol, labPayloadBySymbol, fetchLabForSymbol]);

  const fetchPortfolio = useCallback(async () => {
    setIsLoadingPortfolio(true);
    setPortfolioError(null);
    try {
      const res = await fetch('/api/backtest/portfolio');
      if (res.ok) {
        const json = await res.json();
        setPortfolioData(json.data || null);
      } else {
        const err = await res.json().catch(() => ({}));
        setPortfolioError(err.message || 'Portfolio correlation unavailable.');
        setPortfolioData(null);
      }
    } catch (e: any) {
      setPortfolioError(`Network error: ${e.message}`);
      setPortfolioData(null);
    } finally {
      setIsLoadingPortfolio(false);
    }
  }, []);

  const fetchVariants = useCallback(async (sym: string) => {
    setIsLoadingVariants(true);
    setVariantsError(null);
    try {
      const res = await fetch(`/api/backtest/variants/${sym}`);
      if (res.ok) {
        const json = await res.json();
        setVariantsData(json.data || null);
      } else {
        const err = await res.json().catch(() => ({}));
        setVariantsError(err.message || `No variants for ${sym}.`);
        setVariantsData(null);
      }
    } catch (e: any) {
      setVariantsError(`Network error: ${e.message}`);
      setVariantsData(null);
    } finally {
      setIsLoadingVariants(false);
    }
  }, []);

  useEffect(() => {
    if (activeSubTab === 'portfolio') fetchPortfolio();
    if (activeSubTab === 'variants') fetchVariants(testSymbol);
  }, [activeSubTab, testSymbol, fetchPortfolio, fetchVariants]);

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
            if (activeSubTab === 'variants') fetchVariants(testSymbol);
          }
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [isRunning, fetchReportList, fetchSummaryData, fetchStorageInfo, fetchPortfolio, fetchVariants, testSymbol, activeSubTab]);

  useEffect(() => {
    if (!labRunning) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/backtest/lab-status');
        if (res.ok) {
          const json = await res.json();
          if (json.progress) setLabProgress(json.progress);
          if (Array.isArray(json.results)) setLabResults(json.results);
          if (!json.isRunning) {
            setLabRunning(false);
            // Refresh the lab payloads for every symbol we just tested.
            for (const sym of selectedSymbols) {
              await fetchLabForSymbol(sym);
            }
          }
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [labRunning, selectedSymbols, fetchLabForSymbol]);

  const currentSymbolReports = useMemo(() => {
    return reportFiles.filter(f => f.startsWith(`${testSymbol}_`) && !f.endsWith('_variants.json') && !f.endsWith('_lab.json') && f !== 'portfolio_correlation.json');
  }, [reportFiles, testSymbol]);

  // ---- Multi-select pair handlers ----
  const toggleSymbol = (sym: string) => {
    setSelectedSymbols(prev => {
      const has = prev.includes(sym);
      const next = has ? prev.filter(s => s !== sym) : [...prev, sym];
      // Keep testSymbol pointing at a valid selection so the summary tab has data.
      if (has && testSymbol === sym && next.length > 0) {
        setTestSymbol(next[0]);
      }
      if (!has && next.length === 1) {
        setTestSymbol(sym);
      }
      return next;
    });
  };

  const selectAllSymbols = () => {
    setSelectedSymbols([...WHITELIST_ASSETS]);
  };
  const clearAllSymbols = () => {
    setSelectedSymbols([]);
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
          setSelectedFile('');
          setReportData(null);
        }
      }
    } finally { setIsCleaning(false); }
  };

  const handleRunSelected = async () => {
    if (isRunning) return;
    if (selectedSymbols.length === 0) {
      alert('Tick at least one pair first.');
      return;
    }
    setIsRunning(true);
    setRunResults([]);
    setProgressText(`Preparing matrix for ${selectedSymbols.join(', ')}${includeVariants ? ' + variants' : ''}...`);
    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selectedSymbols.length === 1 ? selectedSymbols[0] : selectedSymbols,
          days: testDays,
          rr: testRr,
          variants: includeVariants,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
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
    setIsRunning(true);
    setRunResults([]);
    setProgressText(`Preparing matrix for all 7 pairs${includeVariants ? ' + variants' : ''}...`);
    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'ALL', days: testDays, rr: testRr, variants: includeVariants }),
      });
      if (!res.ok) {
        const err = await res.json();
        setRunResults([{ symbol: 'ALL', status: 'FAILED', message: err.message || 'Run failed' }]);
        setIsRunning(false);
      }
    } catch {
      setRunResults([{ symbol: 'ALL', status: 'FAILED', message: 'Network error connecting to runner' }]);
      setIsRunning(false);
    }
  };

  const handleRunBacktestSingle = async (targetSym: string, withVariants: boolean = false) => {
    if (isRunning) return;
    setIsRunning(true);
    setRunResults([]);
    setProgressText(`Preparing matrix for ${targetSym}${withVariants ? ' + variants' : ''}...`);
    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: targetSym, days: testDays, rr: testRr, variants: withVariants }),
      });
      if (!res.ok) {
        const err = await res.json();
        setRunResults([{ symbol: targetSym, status: 'FAILED', message: err.message || 'Run failed' }]);
        setIsRunning(false);
      }
    } catch {
      setRunResults([{ symbol: targetSym, status: 'FAILED', message: 'Network error connecting to runner' }]);
      setIsRunning(false);
    }
  };

  const handleStopBacktest = async () => {
    try {
      await fetch('/api/backtest/stop', { method: 'POST' });
      setIsRunning(false);
      setProgressText('Cancelled.');
      await fetchStorageInfo();
    } catch {}
  };

  const handleRunStrategyLab = async () => {
    if (labRunning) return;
    if (selectedSymbols.length === 0) {
      alert('Tick at least one pair before running the Strategy Lab.');
      return;
    }
    setLabRunning(true);
    setLabResults([]);
    setLabError(null);
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
    } catch (e: any) {
      setLabError(`Network error: ${e.message}`);
      setLabRunning(false);
    }
  };

  const handleStopStrategyLab = async () => {
    try {
      await fetch('/api/backtest/lab-stop', { method: 'POST' });
      setLabRunning(false);
      setLabProgress('Strategy Lab cancelled.');
    } catch {}
  };

  const handleCopyLabForAI = (sym: string) => {
    const lab = labPayloadBySymbol[sym];
    if (!lab) return;
    const lines: string[] = [];
    lines.push(`STRATEGY LAB — ${sym} (${lab.days}-day window: ${lab.window_start} → ${lab.window_end})`);
    lines.push(`Baseline = Adaptive · BE on · Trail off. Each other variant changes ONE setting.`);
    lines.push('');
    lines.push('Label                          | TR   | WR    | PF    | DD      | PNL      | TUNE PF (TR) | VALIDATE PF (TR) | Verdict');
    lines.push('-------------------------------|------|-------|-------|---------|----------|--------------|------------------|----------');
    const sorted = [...lab.variants].sort((a, b) => {
      const rank = (v: string) => v === 'IMPROVES' ? 0 : v === 'NO' ? 1 : 2;
      return rank(a.verdict) - rank(b.verdict);
    });
    for (const v of sorted) {
      lines.push(
        `${v.label.padEnd(30)} | ${String(v.trades).padStart(4)} | ${formatNum(v.win_rate, 1).padStart(5)}% | ${formatNum(v.profit_factor).padStart(5)} | $${formatNum(v.max_drawdown).padStart(6)} | $${formatNum(v.net_pnl).padStart(7)} | ${formatNum(v.tune_pf).padStart(5)} (${String(v.tune_trades).padStart(3)}) | ${formatNum(v.validate_pf).padStart(5)} (${String(v.validate_trades).padStart(3)}) | ${v.verdict}`
      );
    }
    const copyText = lines.join('\n');
    navigator.clipboard.writeText(copyText).catch(() => {});
    setLabCopyStatus(prev => ({ ...prev, [sym]: 'copied' }));
    setTimeout(() => setLabCopyStatus(prev => ({ ...prev, [sym]: 'idle' })), 2500);
  };

  const handleVerifyVsOriginal = async () => {
    setIsVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch('/api/backtest/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: testSymbol, days: 30 })
      });
      const json = await res.json();
      setVerifyResult(res.ok && json.diff ? json.diff : (json.message || 'Verification failed.'));
    } catch (e: any) {
      setVerifyResult(`Verification network error: ${e.message}`);
    } finally { setIsVerifying(false); }
  };

  const handleExportPDF = async () => {
    setIsExportingPdf(true);
    try {
      const res = await fetch('/api/backtest/export-data');
      if (!res.ok) throw new Error('Could not fetch export data.');
      const json = await res.json();
      const exp = json.data;

      let jsPdfLoaded = false;
      try {
        const jsPdfModule = await import('jspdf');
        const autoTableModule = await import('jspdf-autotable');
        const jsPDFConstructor = (jsPdfModule as any).default || (jsPdfModule as any).jsPDF;
        const autoTable = (autoTableModule as any).default || autoTableModule;

        if (jsPDFConstructor) {
          const doc = new jsPDFConstructor('portrait', 'mm', 'a4');
          const totalPagesExp = '{total_pages_count_string}';
          const pageWidth = doc.internal.pageSize.getWidth();
          const pageHeight = doc.internal.pageSize.getHeight();

          const addHeaderFooter = (pageTitle: string) => {
            doc.setFontSize(8);
            doc.setTextColor(100, 116, 139);
            doc.text('NEXUS MATRIX - AUDITED QUANTITATIVE BACKTEST REPORT', 14, 10);
            doc.text(pageTitle, pageWidth - 14, 10, { align: 'right' });
            doc.setDrawColor(203, 213, 225);
            doc.setLineWidth(0.3);
            doc.line(14, 13, pageWidth - 14, 13);
            const str = `Page ${doc.internal.pages.length - 1} of ${totalPagesExp}`;
            doc.text(str, pageWidth / 2, pageHeight - 8, { align: 'center' });
          };

          const addHowToRead = (key: string, yPos: number) => {
            const d = describe(key);
            doc.setFontSize(8);
            doc.setTextColor(100, 116, 139);
            doc.text(`How to read this: ${d.howToRead}`, 14, yPos, { maxWidth: pageWidth - 28 });
            return yPos + 6;
          };

          doc.setFillColor(15, 23, 42);
          doc.rect(0, 0, pageWidth, pageHeight, 'F');
          doc.setTextColor(255, 255, 255);
          doc.setFontSize(28);
          doc.text('NEXUS MATRIX', 20, 50);
          doc.setFontSize(16);
          doc.setTextColor(59, 130, 246);
          doc.text('Institutional Backtest & Portfolio Audit', 20, 60);

          doc.setFontSize(10);
          doc.setTextColor(203, 213, 225);
          doc.text(`Run Date: ${exp.generated_at.slice(0, 10)}`, 20, 80);
          doc.text(`Window Duration: ${exp.days} Days`, 20, 87);
          doc.text(`Risk-to-Reward Target: 1:${exp.target_rr}`, 20, 94);
          doc.text(`Total Run Time: ${exp.total_run_seconds || 0}s`, 20, 101);
          doc.text(`Whitelist Coverage: 7 Multi-Asset Instruments`, 20, 108);

          doc.setFillColor(30, 41, 59);
          doc.roundedRect(20, 125, pageWidth - 40, 62, 4, 4, 'F');
          doc.setTextColor(248, 250, 252);
          doc.setFontSize(11);
          doc.text('AUDIT METHODOLOGY & CONVENTIONS:', 26, 135);
          doc.setFontSize(9);
          doc.setTextColor(148, 163, 184);
          doc.text('1. Tests 8 combinations per asset across Adaptive/Legacy, Breakeven, and SuperTrend trail.', 26, 143);
          doc.text('2. Every rule in the suggestion engine strictly requires at least 30 trades before firing.', 26, 150);
          doc.text('3. TUNE = first 70% of window. VALIDATE = last 30%. HOLDS / FLAT / FAILS are the verdicts.', 26, 157);
          doc.text('4. Identifies the statistically superior setup per asset ranked by estimated dollar impact.', 26, 164);
          doc.text('5. Zero look-ahead bias: higher timeframe candles are reconstructed bar-by-bar at time T.', 26, 171);
          doc.text('6. All values are post-hoc; the backtester does not modify the live bot.', 26, 178);

          doc.addPage();
          addHeaderFooter('Portfolio Overview');
          doc.setFontSize(16);
          doc.setTextColor(15, 23, 42);
          doc.text('Portfolio Executive Summary', 14, 22);
          let yAfterHowTo = addHowToRead('sec_summary', 28);

          const overviewRows = (exp.pairs || []).map((p: any) => {
            if (p.status !== 'OK') return [p.symbol, 'NOT TESTED', '--', '--', '--', p.error || ''];
            const b = p.best_combination || {};
            return [p.symbol, b.label || 'N/A', b.total_trades || 0, `${formatNum(b.win_rate)}%`, formatNum(b.profit_factor), `$${formatNum(b.net_pnl)}`];
          });

          autoTable(doc, {
            startY: yAfterHowTo,
            head: [['Asset', 'Best Combination', 'Trades', 'Win Rate', 'Profit Factor', 'Net P&L']],
            body: overviewRows,
            theme: 'striped',
            headStyles: { fillColor: [37, 99, 235], fontSize: 8 },
            bodyStyles: { fontSize: 8 }
          });

          let chartY = (doc as any).lastAutoTable.finalY + 12;
          doc.setFontSize(12);
          doc.setTextColor(15, 23, 42);
          doc.text('Net Realized P&L by Instrument ($)', 14, chartY);

          const validPairs = (exp.pairs || []).filter((p: any) => p.status === 'OK');
          const maxPnl = Math.max(50, ...validPairs.map((p: any) => Math.abs(p.best_combination?.net_pnl || 0)));
          const barBaseY = chartY + 10;
          const barHeight = 6;
          const maxBarWidth = 70;

          validPairs.forEach((p: any, idx: number) => {
            const currentBarY = barBaseY + (idx * 10);
            const pnl = p.best_combination?.net_pnl || 0;
            const w = Math.min(maxBarWidth, (Math.abs(pnl) / maxPnl) * maxBarWidth);

            doc.setFontSize(8);
            doc.setTextColor(51, 65, 85);
            doc.text(p.symbol, 14, currentBarY + 5);

            if (pnl >= 0) {
              doc.setFillColor(16, 185, 129);
              doc.rect(40, currentBarY, Math.max(1, w), barHeight, 'F');
              doc.setTextColor(16, 185, 129);
              doc.text(`+$${formatNum(pnl)}`, 42 + w, currentBarY + 5);
            } else {
              doc.setFillColor(239, 68, 68);
              doc.rect(40, currentBarY, Math.max(1, w), barHeight, 'F');
              doc.setTextColor(239, 68, 68);
              doc.text(`-$${formatNum(Math.abs(pnl))}`, 42 + w, currentBarY + 5);
            }
          });

          for (const p of (exp.pairs || [])) {
            if (p.status !== 'OK') continue;
            doc.addPage();
            addHeaderFooter(`${p.symbol} Deep Dive`);
            doc.setFontSize(14);
            doc.setTextColor(15, 23, 42);
            doc.text(`${p.symbol} - 8-Combination Matrix Performance (${p.seconds_taken || 0}s)`, 14, 22);
            addHowToRead('col_combination', 28);

            const bLabel = p.best_combination?.label || '';
            const comboRows = (p.combinations || []).map((c: any) => {
              const tv = c.tune_validate || {};
              const cTune = tv.tune || {};
              const cVal = tv.validate || {};
              const tStr = `${cTune.count || 0}/${formatNum(cTune.profit_factor)}/${formatNum(cTune.win_rate)}%`;
              const vStr = `${cVal.count || 0}/${formatNum(cVal.profit_factor)}/${formatNum(cVal.win_rate)}%`;
              return [
                (c.label === bLabel ? `★ ${c.label}` : c.label),
                c.total_trades || 0, `${formatNum(c.win_rate)}%`, `${formatNum(c.expectancy)}R`,
                formatNum(c.profit_factor), `-$${formatNum(c.max_drawdown)}`, `$${formatNum(c.net_pnl)}`, `${formatNum(c.adaptive_effective_pct)}%`,
                tStr, vStr, c.holdout_verdict || 'INCONCLUSIVE'
              ];
            });

            autoTable(doc, {
              startY: 32,
              head: [['Combination', 'Trades', 'Win Rate', 'Exp (R)', 'PF', 'Max DD', 'Net P&L', 'Coverage', 'TUNE (TR/PF/WR)', 'VALIDATE (TR/PF/WR)', 'Verdict']],
              body: comboRows,
              theme: 'grid',
              headStyles: { fillColor: [15, 23, 42], fontSize: 6.5 },
              bodyStyles: { fontSize: 6.5 }
            });

            let currentY = (doc as any).lastAutoTable.finalY + 8;
            const bStv: Record<string, any> = p.best_combination?.strategy_tune_validate || {};
            const stratRows = Object.entries(p.best_combination?.strategy_kpis || {}).map(([sName, s]: any) => {
              const stv = bStv[sName] || {};
              const sTune = stv.tune || {};
              const sVal = stv.validate || {};
              const tStr = `${sTune.count || 0}/${formatNum(sTune.profit_factor)}/${formatNum(sTune.win_rate)}%`;
              const vStr = `${sVal.count || 0}/${formatNum(sVal.profit_factor)}/${formatNum(sVal.win_rate)}%`;
              return [sName, s.count, `${formatNum(s.win_rate)}%`, `${formatNum(s.avg_r)}R`, formatNum(s.profit_factor), `$${formatNum(s.net_pnl)}`, tStr, vStr, holdoutVerdictLocal(sTune, sVal)];
            });

            if (stratRows.length > 0) {
              doc.setFontSize(10);
              doc.setTextColor(15, 23, 42);
              doc.text(`Strategy Breakdown (${bLabel})`, 14, currentY);
              autoTable(doc, {
                startY: currentY + 3,
                head: [['Strategy', 'Trades', 'Win Rate', 'Avg R', 'PF', 'Net P&L', 'TUNE (TR/PF/WR)', 'VALIDATE (TR/PF/WR)', 'Verdict']],
                body: stratRows,
                theme: 'striped',
                headStyles: { fillColor: [71, 85, 105], fontSize: 6.5 },
                bodyStyles: { fontSize: 6.5 }
              });
              currentY = (doc as any).lastAutoTable.finalY + 8;
            }

            const skipMap = p.best_combination?.skipped_summary || {};
            const skipEntries = Object.entries(skipMap);
            if (skipEntries.length > 0) {
              doc.setFontSize(8);
              doc.setTextColor(100, 116, 139);
              const skipStr = skipEntries.map(([r, c]) => {
                if (typeof c === 'object' && c !== null) {
                  const cc = c as any;
                  return `${r}: ${cc.candle_skips ?? 0} candle-skips / ${cc.unique_setups ?? 0} unique`;
                }
                return `${r}: ${c}`;
              }).join(' | ');
              doc.text(`Skipped Signals: ${skipStr}`, 14, currentY, { maxWidth: pageWidth - 28 });
              currentY += 6;
            }

            const diag = p.best_combination?.diagnostics;
            if (diag) {
              doc.setFontSize(11);
              doc.setTextColor(37, 99, 235);
              doc.text('Blueprint Diagnostics Highlights', 14, currentY);
              currentY += 6;
              doc.setFontSize(8);
              doc.setTextColor(51, 65, 85);

              const st = diag.streak_analysis || {};
              doc.text(`Streaks: max ${st.max_consecutive_losses ?? 0}, avg ${formatNum(st.average_streak)}, peak DD -$${formatNum(st.peak_drawdown)}.`, 16, currentY); currentY += 5;
              const cb = diag.circuit_breaker_sim || {};
              doc.text(`Breaker sim: protection $${formatNum(cb.protection_delta)} across ${cb.trades_halved ?? 0} halved trades.`, 16, currentY); currentY += 5;
              const orr = diag.outlier_removal || {};
              doc.text(`Outlier dependency: ${formatNum(orr.impact_pct, 1)}% of net P&L came from the top 5% of trades.`, 16, currentY); currentY += 5;
              const mc = diag.monte_carlo || {};
              doc.text(`Monte Carlo: median DD -$${formatNum(mc.median_max_dd)}, P95 -$${formatNum(mc.p95_max_dd)}, prob positive ${formatNum(mc.prob_positive, 1)}%.`, 16, currentY); currentY += 5;
              const bh = diag.buy_and_hold || {};
              doc.text(`Alpha vs buy-and-hold: $${formatNum(bh.alpha)} (${bh.verdict}).`, 16, currentY); currentY += 5;
              const bv = diag.breakeven_variants || {};
              if (bv.A_current) {
                doc.text(`BE variants (est): A ${formatNum(bv.A_current.total_r)}R | B ${formatNum(bv.B_no_be.total_r)}R | C ${formatNum(bv.C_delayed_be.total_r)}R — best ${bv.best_variant}.`, 16, currentY); currentY += 5;
              }
              const param = diag.parameter_sensitivity || {};
              if (param.sweep && param.sweep.length > 0) {
                doc.text(`Parameter sweep peak at R:R 1:${formatNum(param.best_rr)} (net $${formatNum(param.best_net_pnl)}).`, 16, currentY); currentY += 5;
              }
              currentY += 3;
            }

            // Strategy Lab (if present)
            const lab = p.lab;
            if (lab && Array.isArray(lab.variants) && lab.variants.length > 0) {
              doc.setFontSize(11);
              doc.setTextColor(37, 99, 235);
              doc.text('Strategy Lab (single-setting variants, 365-day window)', 14, currentY);
              currentY += 6;

              const labRows = [...lab.variants].sort((a: any, b: any) => {
                const rank = (v: string) => v === 'IMPROVES' ? 0 : v === 'NO' ? 1 : 2;
                return rank(a.verdict) - rank(b.verdict);
              }).map((v: any) => [
                v.label, v.trades, `${formatNum(v.win_rate, 1)}%`, formatNum(v.profit_factor),
                `-$${formatNum(v.max_drawdown)}`, `$${formatNum(v.net_pnl)}`,
                `${formatNum(v.tune_pf)} (${v.tune_trades})`,
                `${formatNum(v.validate_pf)} (${v.validate_trades})`,
                v.verdict
              ]);
              autoTable(doc, {
                startY: currentY,
                head: [['Variant', 'TR', 'WR', 'PF', 'Max DD', 'Net P&L', 'TUNE PF (TR)', 'VALIDATE PF (TR)', 'Verdict']],
                body: labRows,
                theme: 'grid',
                headStyles: { fillColor: [37, 99, 235], fontSize: 6.5 },
                bodyStyles: { fontSize: 6.5 }
              });
              currentY = (doc as any).lastAutoTable.finalY + 8;
            }

            const ruleSuggestions = p.best_combination?.rule_suggestions || [];
            if (ruleSuggestions.length > 0) {
              doc.setFontSize(10);
              doc.setTextColor(37, 99, 235);
              doc.text('Actionable Rule Suggestions (Impact Ranked):', 14, currentY);
              doc.setFontSize(8);
              doc.setTextColor(51, 65, 85);
              ruleSuggestions.slice(0, 6).forEach((t: any, i: number) => {
                doc.text(`• ${t.tag} ${t.text}`, 16, currentY + 5 + (i * 5), { maxWidth: pageWidth - 32 });
              });
            }
          }

          if (exp.portfolio_correlation) {
            doc.addPage();
            addHeaderFooter('Portfolio Correlation');
            doc.setFontSize(16);
            doc.setTextColor(15, 23, 42);
            doc.text('Cross-Pair Correlation & Diversification', 14, 22);
            addHowToRead('sec_portfolio', 28);

            const pc = exp.portfolio_correlation;
            doc.setFontSize(9);
            doc.setTextColor(51, 65, 85);
            doc.text(`Portfolio max DD $${formatNum(pc.portfolio_drawdown)} | Sum of individual DDs $${formatNum(pc.sum_of_individual_drawdowns)} | Diversification ratio ${formatNum(pc.diversification_ratio)}x | Avg daily correlation ${formatNum(pc.avg_daily_correlation, 3)} | Days ${pc.days}.`, 14, 36, { maxWidth: pageWidth - 28 });

            const symbols = pc.symbols || [];
            const headRow = ['', ...symbols];
            const bodyRows = symbols.map((r: string) => [
              r,
              ...symbols.map((c: string) => formatNum(pc.correlation_matrix?.[r]?.[c] ?? 0, 2))
            ]);
            autoTable(doc, {
              startY: 44,
              head: [headRow],
              body: bodyRows,
              theme: 'grid',
              headStyles: { fillColor: [37, 99, 235], fontSize: 8 },
              bodyStyles: { fontSize: 8 }
            });
          }

          doc.addPage();
          addHeaderFooter('Strategic Recommendations');
          doc.setFontSize(16);
          doc.setTextColor(15, 23, 42);
          doc.text('Portfolio Strategic Optimization (Top 10 Actions)', 14, 22);
          addHowToRead('sec_tips', 28);

          const portSuggestions = exp.portfolio_suggestions || [];
          const suggRows = portSuggestions.map((s: any, idx: number) => [
            `#${idx + 1}`, s.tag || '', s.type, s.text
          ]);

          if (suggRows.length > 0) {
            autoTable(doc, {
              startY: 34,
              head: [['Rank', 'Tag', 'Category', 'Recommended Action']],
              body: suggRows,
              theme: 'striped',
              headStyles: { fillColor: [37, 99, 235], fontSize: 8 },
              bodyStyles: { fontSize: 8 },
              columnStyles: { 0: { cellWidth: 12 }, 1: { cellWidth: 28 } }
            });
          }

          let nextTestY = (doc as any).lastAutoTable ? (doc as any).lastAutoTable.finalY + 12 : 40;
          doc.setFontSize(12);
          doc.setTextColor(15, 23, 42);
          doc.text('What to Test Next (Prioritized Actions):', 14, nextTestY);

          const whatToTest = exp.what_to_test_next || [];
          doc.setFontSize(9);
          doc.setTextColor(71, 85, 105);
          whatToTest.forEach((item: string, i: number) => {
            doc.text(`${i + 1}. ${item}`, 16, nextTestY + 7 + (i * 6), { maxWidth: pageWidth - 32 });
          });

          doc.addPage();
          addHeaderFooter('Not Implemented');
          doc.setFontSize(16);
          doc.setTextColor(15, 23, 42);
          doc.text('Blueprint Items Not Currently Produced', 14, 22);
          addHowToRead('not_implemented', 28);
          const notImpl = (exp.spec_coverage || []).filter((row: any) => !(row.panel && row.txt && row.pdf));
          autoTable(doc, {
            startY: 34,
            head: [['#', 'Item', 'Note']],
            body: notImpl.map((r: any) => [`#${r.id}`, r.label, r.note || 'not produced']),
            theme: 'grid',
            headStyles: { fillColor: [15, 23, 42], fontSize: 8 },
            bodyStyles: { fontSize: 8 }
          });

          doc.addPage();
          addHeaderFooter('Glossary');
          doc.setFontSize(16);
          doc.setTextColor(15, 23, 42);
          doc.text('Glossary & Methodological Definitions', 14, 22);

          const glossaryItems: Array<[string, string]> = [
            ['Profit Factor (PF)', describe('profit_factor').description],
            ['Expectancy (R)', describe('expectancy').description],
            ['Maximum Drawdown', describe('max_drawdown').description],
            ['Adaptive Coverage', describe('adaptive_coverage').description],
            ['TUNE / VALIDATE split', describe('col_tune').description + ' ' + describe('col_validate').description],
            ['HOLDS', describe('tag_holds').description],
            ['FLAT', describe('tag_flat').description],
            ['FAILS', describe('tag_fails').description],
            ['INCONCLUSIVE tag', describe('tag_inconclusive').description],
            ['Blueprint Diagnostics', describe('sec_diagnostics').description],
            ['Portfolio Correlation', describe('sec_portfolio').description],
            ['Slippage Sensitivity', describe('diag_slippage').description],
            ['Break-even Variants A/B/C', describe('diag_breakeven_variants').description],
            ['Parameter Sensitivity', describe('diag_parameter_sensitivity').description],
            ['Buy-and-Hold Alpha', describe('diag_buy_and_hold').description],
            ['Premature BE Exit', describe('diag_premature_be').description],
            ['Post-SL Continuation', describe('diag_post_sl').description],
            ['Post-TP Movement', describe('diag_post_tp').description],
            ['Monte Carlo Resampling', describe('diag_monte_carlo').description],
            ['Outlier Dependency', describe('diag_outlier_removal').description],
            ['Circuit-Breaker Simulation', describe('diag_circuit_breaker').description],
            ['Strategy Lab', describe('sec_strategy_lab').description],
          ];

          autoTable(doc, {
            startY: 28,
            head: [['Metric / Concept', 'Quantitative Definition']],
            body: glossaryItems,
            theme: 'grid',
            headStyles: { fillColor: [15, 23, 42], fontSize: 8 },
            bodyStyles: { fontSize: 8 },
            columnStyles: { 0: { cellWidth: 45, fontStyle: 'bold' } }
          });

          if (typeof doc.putTotalPages === 'function') doc.putTotalPages(totalPagesExp);
          doc.save(`backtest_${exp.generated_at.slice(0, 10)}.pdf`);
          jsPdfLoaded = true;
        }
      } catch (importErr) {
        console.warn('jsPDF dynamic import error:', importErr);
      }

      if (!jsPdfLoaded) {
        const printWindow = window.open('', '_blank');
        if (printWindow) {
          const overviewHtml = (exp.pairs || []).map((p: any) => `
            <tr>
              <td><strong>${p.symbol}</strong></td>
              <td>${p.best_combination?.label || 'N/A'}</td>
              <td>${p.best_combination?.total_trades || 0}</td>
              <td style="color:${(p.best_combination?.win_rate || 0) >= 50 ? '#10b981' : '#ef4444'}; font-weight:bold;">${formatNum(p.best_combination?.win_rate)}%</td>
              <td>${formatNum(p.best_combination?.profit_factor)}</td>
              <td style="color:${(p.best_combination?.net_pnl || 0) >= 0 ? '#10b981' : '#ef4444'}; font-weight:bold;">$${formatNum(p.best_combination?.net_pnl)}</td>
            </tr>
          `).join('');

          printWindow.document.write(`
            <html><head><title>Nexus Matrix Audit Report</title>
            <style>body{font-family:sans-serif;padding:30px;color:#0f172a;} table{width:100%;border-collapse:collapse;margin:20px 0;font-size:11px;} th,td{padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:left;} th{background:#f1f5f9;}</style>
            </head><body>
            <h1>NEXUS MATRIX - AUDITED BACKTEST REPORT</h1>
            <p>Run Date: ${exp.generated_at.slice(0, 10)} | Window: ${exp.days} Days | Target: 1:${exp.target_rr} | Total Run Time: ${exp.total_run_seconds || 0}s</p>
            <h2>Portfolio Overview</h2>
            <table><thead><tr><th>Asset</th><th>Best Combination</th><th>Trades</th><th>Win Rate</th><th>PF</th><th>Net P&L</th></tr></thead><tbody>${overviewHtml}</tbody></table>
            <script>window.onload = function() { window.print(); };</script>
            </body></html>
          `);
          printWindow.document.close();
        }
      }
    } catch (err: any) {
      alert(`PDF Export Notice: ${err.message}`);
    } finally {
      setIsExportingPdf(false);
    }
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

  // Count pairs that will be included by the next export. Matches server logic:
  // any pair with a summary file is included; the panel dropdown does not filter.
  const exportPairCount = reportFiles.filter(f => f.endsWith('_summary.json') && !f.startsWith('.')).length;

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-6 max-w-7xl mx-auto">
      <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-300 dark:border-[#1a2030]">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-black dark:text-white flex items-center gap-2.5">
            Backtest & Replay Suite
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
              Zero Look-Ahead Matrix
            </span>
          </h1>
          <p className="text-sm text-black dark:text-slate-400 mt-1">
            Replays 5-minute broker candles across all strategies with actionable improvement advice.
          </p>
          <HowToRead metricKey="sec_summary" />
        </div>
      </motion.div>

      {/* Multi-select pair row + Run controls */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-4 space-y-3"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-blue-500" />
            <span className="text-xs font-bold text-black dark:text-white">Pairs to test</span>
            <span className="text-[10px] font-mono text-slate-500">
              ({selectedSymbols.length} of {WHITELIST_ASSETS.length} selected)
            </span>
            <InfoTip metricKey="sec_summary" />
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMultiSelectOpen(v => !v)}
              className="text-[11px] font-mono font-bold px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#141722] dark:hover:bg-[#1a202c] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] cursor-pointer transition-colors"
            >
              {multiSelectOpen ? 'Hide pairs' : 'Show pairs'}
            </button>
            <button
              type="button"
              onClick={selectAllSymbols}
              className="text-[11px] font-mono font-bold px-2.5 py-1 rounded-lg bg-white dark:bg-[#08090d] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] hover:border-blue-400 cursor-pointer transition-colors"
            >
              All
            </button>
            <button
              type="button"
              onClick={clearAllSymbols}
              className="text-[11px] font-mono font-bold px-2.5 py-1 rounded-lg bg-white dark:bg-[#08090d] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] hover:border-rose-400 cursor-pointer transition-colors"
            >
              None
            </button>
          </div>
        </div>

        {multiSelectOpen && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 pt-1">
            {WHITELIST_ASSETS.map((sym) => {
              const checked = selectedSymbols.includes(sym);
              const focused = testSymbol === sym;
              return (
                <button
                  key={sym}
                  type="button"
                  onClick={() => toggleSymbol(sym)}
                  className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs font-mono font-bold transition-colors cursor-pointer border ${
                    checked
                      ? 'bg-blue-600/15 border-blue-500/40 text-blue-700 dark:text-blue-300'
                      : 'bg-slate-50 dark:bg-[#08090d] border-slate-300 dark:border-[#1a2030] text-slate-600 dark:text-slate-400 hover:border-slate-400'
                  }`}
                  title={focused ? `${sym} is the focused pair shown in the tabs below` : `Tick to include ${sym} in the next run`}
                >
                  <span className="flex items-center gap-1.5">
                    {checked ? <CheckSquare className="w-3.5 h-3.5" /> : <SquareOff className="w-3.5 h-3.5 opacity-50" />}
                    <span>{sym}</span>
                  </span>
                  {focused && <span className="text-[8px] px-1 py-0.5 rounded bg-slate-500/15 text-slate-500 font-normal">focused</span>}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-100 dark:border-[#1a2030]">
          <select value={testDays} onChange={(e) => setTestDays(parseInt(e.target.value, 10))} disabled={isRunning || labRunning} className="px-2.5 py-1.5 rounded-lg bg-transparent text-xs font-mono font-bold text-black dark:text-white cursor-pointer focus:outline-none border border-slate-300 dark:border-[#1a2030]">
            <option value={60}>60 Days</option>
            <option value={90}>90 Days</option>
            <option value={180}>180 Days</option>
            <option value={365}>365 Days</option>
          </select>
          <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
            <span className="text-[10px] font-bold text-slate-500">R:R</span>
            <input type="number" step="0.1" min="0.5" max="5.0" value={testRr} onChange={(e) => setTestRr(parseFloat(e.target.value) || 1.0)} disabled={isRunning || labRunning} className="w-12 text-xs font-mono font-bold text-center bg-transparent text-black dark:text-white focus:outline-none" />
          </div>

          <label className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeVariants}
              onChange={(e) => setIncludeVariants(e.target.checked)}
              disabled={isRunning || labRunning}
              className="accent-blue-600"
            />
            <span className="text-[10px] font-bold text-slate-600 dark:text-slate-300">+ Variants</span>
          </label>

          {!isRunning ? (
            <>
              <button
                type="button"
                onClick={handleRunSelected}
                disabled={selectedSymbols.length === 0 || labRunning}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Run Selected ({selectedSymbols.length})</span>
              </button>
              <button
                type="button"
                onClick={handleRunAll}
                disabled={labRunning}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Run All</span>
              </button>
              {!labRunning && (
                <button
                  type="button"
                  onClick={handleRunStrategyLab}
                  disabled={selectedSymbols.length === 0}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50"
                  title="Runs 12 single-setting variants on the 365-day window for every ticked pair."
                >
                  <FlaskConical className="w-3.5 h-3.5" />
                  <span>Strategy Lab</span>
                </button>
              )}
            </>
          ) : (
            <button type="button" onClick={handleStopBacktest} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-rose-600 hover:bg-rose-500 text-white">
              <Square className="w-3.5 h-3.5" />
              <span>Stop</span>
            </button>
          )}
          {labRunning && (
            <button type="button" onClick={handleStopStrategyLab} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-rose-600 hover:bg-rose-500 text-white">
              <Square className="w-3.5 h-3.5" />
              <span>Stop Lab</span>
            </button>
          )}
        </div>
      </motion.div>

      {/* Export row + N pairs indicator */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs"
      >
        <div className="flex items-center gap-2 text-[11px] font-mono text-slate-600 dark:text-slate-300">
          <FileText className="w-3.5 h-3.5 text-blue-500" />
          <span>Exporting <strong className="text-black dark:text-white">{exportPairCount}</strong> pair{exportPairCount === 1 ? '' : 's'} (every pair with a saved summary — the dropdown does not filter the export)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <a href="/api/backtest/export.txt" download className="px-3 py-2 rounded-xl bg-white hover:bg-slate-100 dark:bg-[#0f1118] dark:hover:bg-[#141722] border border-slate-300 dark:border-[#1a2030] text-xs font-semibold text-black dark:text-slate-200 flex items-center gap-1.5 cursor-pointer transition-colors shadow-xs">
            <Download className="w-3.5 h-3.5 text-blue-500" />
            <span>Export for AI (.txt)</span>
          </a>
          <button type="button" onClick={handleExportPDF} disabled={isExportingPdf} className="px-3 py-2 rounded-xl bg-white hover:bg-slate-100 dark:bg-[#0f1118] dark:hover:bg-[#141722] border border-slate-300 dark:border-[#1a2030] text-xs font-semibold text-black dark:text-slate-200 flex items-center gap-1.5 cursor-pointer transition-colors shadow-xs disabled:opacity-50">
            <Printer className="w-3.5 h-3.5 text-emerald-500" />
            <span>{isExportingPdf ? 'Building PDF...' : 'Export PDF'}</span>
          </button>
          <button type="button" disabled={isVerifying || isRunning || labRunning} onClick={handleVerifyVsOriginal} className="px-3 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-50 transition-colors">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>{isVerifying ? 'Verifying...' : 'Verify vs original (60 days)'}</span>
          </button>
        </div>
      </motion.div>

      {verifyResult && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-purple-500/40 shadow-xs space-y-3 animate-in fade-in">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-purple-500" />
              <span className="text-xs font-bold text-black dark:text-white">Verification Difference Report (Prompt F Fixed Boundary)</span>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => { navigator.clipboard.writeText(verifyResult); setVerifyCopyStatus('copied'); setTimeout(() => setVerifyCopyStatus('idle'), 2000); }} className="px-3 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer">
                {verifyCopyStatus === 'copied' ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{verifyCopyStatus === 'copied' ? 'Copied' : 'Copy Result'}</span>
              </button>
              <button type="button" onClick={() => setVerifyResult(null)} className="text-xs text-slate-400 hover:text-black dark:hover:text-white cursor-pointer ml-1">Dismiss</button>
            </div>
          </div>
          <textarea readOnly value={verifyResult} rows={14} onFocus={(e) => e.target.select()} className="w-full p-3.5 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-xs text-black dark:text-slate-200 focus:outline-none" />
        </div>
      )}

      {labRunning && (
        <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-xs animate-in fade-in">
          <div className="flex items-center gap-3">
            <FlaskConical className="w-4 h-4 text-amber-500 animate-pulse shrink-0" />
            <div>
              <div className="font-bold text-amber-700 dark:text-amber-400">Strategy Lab in Progress</div>
              <div className="text-slate-500 font-mono text-[11px] mt-0.5">{labProgress || 'Testing single-setting variants on the 365-day window...'}</div>
            </div>
          </div>
          <button type="button" onClick={handleStopStrategyLab} className="px-3 py-1.5 rounded-lg text-[11px] font-bold font-mono bg-rose-600 hover:bg-rose-500 text-white transition-colors cursor-pointer">Stop Lab</button>
        </div>
      )}

      {labError && (
        <div className="p-3 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-700 dark:text-rose-300 flex items-center justify-between">
          <span className="font-mono">Strategy Lab error: {labError}</span>
          <button type="button" onClick={() => setLabError(null)} className="text-xs text-slate-400 hover:text-rose-600 cursor-pointer">Dismiss</button>
        </div>
      )}

      {/* Per-pair Strategy Lab results table */}
      {(labPayloadBySymbol[testSymbol] || labResults.length > 0) && (
        <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-amber-500/30 shadow-xs p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FlaskConical className="w-4 h-4 text-amber-500" />
              <h3 className="text-sm font-bold text-black dark:text-white">
                Strategy Lab {labPayloadBySymbol[testSymbol] ? `— ${testSymbol} · ${labPayloadBySymbol[testSymbol]!.days}-day window` : ''}
              </h3>
              <InfoTip metricKey="sec_strategy_lab" />
            </div>
            <div className="flex items-center gap-2">
              {labPayloadBySymbol[testSymbol] && (
                <button
                  type="button"
                  onClick={() => handleCopyLabForAI(testSymbol)}
                  className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer"
                >
                  {labCopyStatus[testSymbol] === 'copied' ? <Check className="w-3.5 h-3.5 text-emerald-200" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{labCopyStatus[testSymbol] === 'copied' ? 'Copied' : 'Copy for AI'}</span>
                </button>
              )}
              {isLoadingLab && <RefreshCw className="w-3.5 h-3.5 text-amber-500 animate-spin" />}
            </div>
          </div>

          <HowToRead metricKey="sec_strategy_lab" />

          {labPayloadBySymbol[testSymbol] ? (
            <>
              <div className="text-[10px] font-mono text-slate-500">
                Window: {labPayloadBySymbol[testSymbol]!.window_start} → {labPayloadBySymbol[testSymbol]!.window_end} · Baseline = {labPayloadBySymbol[testSymbol]!.baseline_label}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                      <th className="py-2.5 px-3">Variant</th>
                      <th className="py-2.5 px-3 text-center">Trades</th>
                      <th className="py-2.5 px-3 text-center">Win Rate</th>
                      <th className="py-2.5 px-3 text-center">PF</th>
                      <th className="py-2.5 px-3 text-right">Max DD</th>
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
                          <td className="py-2.5 px-3 text-right text-rose-500">-${formatNum(v.max_drawdown)}</td>
                          <td className={`py-2.5 px-3 text-right font-bold ${v.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${formatNum(v.net_pnl)}</td>
                          <td className={`py-2.5 px-3 text-center ${v.tune_trades < 30 ? 'text-slate-400' : ''}`}>{formatNum(v.tune_pf)} ({v.tune_trades})</td>
                          <td className={`py-2.5 px-3 text-center ${v.validate_trades < 30 ? 'text-slate-400' : ''}`}>{formatNum(v.validate_pf)} ({v.validate_trades})</td>
                          <td className="py-2.5 px-3 text-center"><VerdictPill verdict={v.verdict} /></td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div className="text-[10px] font-mono text-slate-500">
                IMPROVES = PF above baseline by at least 0.05 in both TUNE and VALIDATE with at least 30 trades in each. INCONCLUSIVE = fewer than 30 trades in either window.
              </div>
            </>
          ) : (
            <div className="py-4 text-center text-xs text-slate-500 font-mono">
              No lab file for {testSymbol}. Click <strong className="text-amber-600">Strategy Lab</strong> above to generate one.
            </div>
          )}
        </div>
      )}

      {storageInfo && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <Database className="w-4 h-4 text-blue-500 shrink-0" />
              <span className="font-bold text-black dark:text-white">Storage Volume:</span>
              <span className="font-mono text-slate-600 dark:text-slate-300">{storageInfo.used_mb} MB used / {storageInfo.free_mb} MB free (Total: {storageInfo.total_mb} MB)</span>
              <span className="text-slate-400 hidden sm:inline">|</span>
              <span className="font-mono text-[11px] text-slate-500">Reports: <strong className="text-blue-500">{storageInfo.reports_mb} MB</strong> · Market Data: <strong className="text-emerald-500">{storageInfo.market_data_mb} MB</strong></span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button type="button" disabled={isCleaning || isRunning || labRunning} onClick={() => handleCleanup('symbol')} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#141722] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
                <Trash2 className="w-3 h-3 text-amber-500" /><span>Clear {testSymbol} reports</span>
              </button>
              <button type="button" disabled={isCleaning || isRunning || labRunning} onClick={() => handleCleanup('all_reports')} className="px-3 py-1.5 rounded-lg bg-rose-600/10 hover:bg-rose-600/20 text-rose-600 border border-rose-500/30 text-[11px] font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
                <Trash2 className="w-3 h-3 text-rose-500" /><span>Clear all reports</span>
              </button>
            </div>
          </div>
          {(() => {
            const usedPct = storageInfo.total_mb > 0 ? Math.min(100, Math.round((storageInfo.used_mb / storageInfo.total_mb) * 100)) : 0;
            return (
              <div className="w-full bg-slate-100 dark:bg-[#08090d] rounded-full h-2 overflow-hidden border border-slate-200 dark:border-[#1a2030]">
                <div className={`h-full rounded-full transition-all duration-500 ${usedPct >= 85 ? 'bg-rose-500' : 'bg-blue-600'}`} style={{ width: `${usedPct}%` }} />
              </div>
            );
          })()}
        </div>
      )}

      {runResults.length > 0 && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs space-y-2 animate-in fade-in">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-black dark:text-white">Backtest Run Results</span>
            <button onClick={() => setRunResults([])} className="text-xs text-slate-400 hover:text-black dark:hover:text-white cursor-pointer">Dismiss</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 pt-1">
            {runResults.map((r, i) => (
              <div key={i} className={`p-3 rounded-xl border flex flex-col justify-between gap-1.5 text-xs font-mono ${r.status === 'OK' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/10 border-rose-500/30 text-rose-600'}`}>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-black dark:text-white">{r.symbol}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${r.status === 'OK' ? 'bg-emerald-500/20 text-emerald-600' : 'bg-rose-500/20 text-rose-600'}`}>{r.status}</span>
                </div>
                <div className="text-[11px] break-words whitespace-pre-wrap">{r.message}</div>
                {r.timing && (
                  <div className="pt-1.5 mt-0.5 border-t border-slate-200 dark:border-[#1a2030] text-[10px] text-slate-600 dark:text-slate-400 break-words flex items-start gap-1">
                    <Clock className="w-3 h-3 text-blue-500 shrink-0 mt-0.5" />
                    <span>{r.timing}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {isRunning && (
        <div className="p-4 rounded-2xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-between text-xs animate-in fade-in">
          <div className="flex items-center gap-3">
            <RefreshCw className="w-4 h-4 text-blue-500 animate-spin shrink-0" />
            <div>
              <div className="font-bold text-blue-600 dark:text-blue-400">Simulation in Progress</div>
              <div className="text-slate-500 font-mono text-[11px] mt-0.5">{progressText || 'Stepping through historical candles...'}</div>
            </div>
          </div>
          <button type="button" onClick={handleStopBacktest} className="px-3 py-1.5 rounded-lg text-[11px] font-bold font-mono bg-rose-600 hover:bg-rose-500 text-white transition-colors cursor-pointer">Cancel Run</button>
        </div>
      )}

      {summaryData?.combinations && summaryData.combinations.length > 0 && (
        <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Table className="w-4 h-4 text-blue-500" />
              <h3 className="text-sm font-bold text-black dark:text-white">Results by Combination ({summaryData.symbol} · {summaryData.days} Days · R:R {summaryData.target_rr})</h3>
              <InfoTip metricKey="col_combination" />
            </div>
          </div>
          <HowToRead metricKey="sec_summary" />

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                  <th className="py-2.5 px-3">Combination <InfoTip metricKey="col_combination" /></th>
                  <th className="py-2.5 px-3 text-center">Trades <InfoTip metricKey="col_trades" /></th>
                  <th className="py-2.5 px-3 text-center">Win Rate <InfoTip metricKey="win_rate" /></th>
                  <th className="py-2.5 px-3 text-center">Exp (R) <InfoTip metricKey="col_exp_r" /></th>
                  <th className="py-2.5 px-3 text-center">PF <InfoTip metricKey="col_pf" /></th>
                  <th className="py-2.5 px-3 text-right">Max DD <InfoTip metricKey="col_max_dd" /></th>
                  <th className="py-2.5 px-3 text-right">Net P&L <InfoTip metricKey="col_net_pnl" /></th>
                  <th className="py-2.5 px-3 text-center">Adp Cov <InfoTip metricKey="col_adp_cov" /></th>
                  <th className="py-2.5 px-3 text-center">TUNE (PF / WR / TR) <InfoTip metricKey="col_tune" /></th>
                  <th className="py-2.5 px-3 text-center">VALIDATE (PF / WR / TR) <InfoTip metricKey="col_validate" /></th>
                  <th className="py-2.5 px-3 text-center">Verdict <InfoTip metricKey="col_holdout_verdict" /></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                {summaryData.combinations.map((c: any, idx: number) => {
                  const tv = c.tune_validate || {};
                  const cTune = tv.tune || {};
                  const cVal = tv.validate || {};
                  const inconTune = (cTune.count ?? 0) < 30;
                  const inconVal = (cVal.count ?? 0) < 30;
                  const holdout = c.holdout_verdict || holdoutVerdictLocal(cTune, cVal);
                  const isFail = holdout === 'FAILS';
                  return (
                    <tr key={idx} onClick={() => setSelectedFile(c.report_file)} className={`cursor-pointer transition-colors ${selectedFile === c.report_file ? 'bg-blue-500/15' : idx === bestComboIdx ? 'bg-amber-500/10 hover:bg-amber-500/20' : 'hover:bg-slate-50 dark:hover:bg-[#121520]'} ${isFail ? 'ring-1 ring-rose-500/40' : ''}`}>
                      <td className="py-3 px-3 font-bold text-black dark:text-white">
                        <div className="flex items-center gap-2">
                          {idx === bestComboIdx && <span className="text-amber-500">★</span>}
                          <span>{c.label}</span>
                        </div>
                      </td>
                      <td className="py-3 px-3 text-center font-bold">{c.total_trades}</td>
                      <td className={`py-3 px-3 text-center font-bold ${c.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{c.win_rate}%</td>
                      <td className="py-3 px-3 text-center">{c.expectancy}R</td>
                      <td className="py-3 px-3 text-center">{c.profit_factor}</td>
                      <td className="py-3 px-3 text-right text-rose-500">-${c.max_drawdown}</td>
                      <td className={`py-3 px-3 text-right font-bold ${c.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${c.net_pnl}</td>
                      <td className="py-3 px-3 text-center text-blue-500">{c.adaptive_effective_pct}%</td>
                      <td className={`py-3 px-3 text-center font-mono text-[11px] ${inconTune ? 'text-slate-400' : ((cTune.profit_factor ?? 0) >= 1.0 ? 'text-emerald-600' : 'text-rose-500')}`}>
                        {inconTune ? 'INCONCLUSIVE' : `${(cTune.profit_factor ?? 0).toFixed(2)} / ${(cTune.win_rate ?? 0).toFixed(0)}% / ${cTune.count}`}
                      </td>
                      <td className={`py-3 px-3 text-center font-mono text-[11px] ${inconVal ? 'text-slate-400' : ((cVal.profit_factor ?? 0) >= 1.0 ? 'text-emerald-600' : 'text-rose-500')}`}>
                        {inconVal ? 'INCONCLUSIVE' : `${(cVal.profit_factor ?? 0).toFixed(2)} / ${(cVal.win_rate ?? 0).toFixed(0)}% / ${cVal.count}`}
                      </td>
                      <td className="py-3 px-3 text-center">
                        <VerdictPill verdict={holdout} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {reportData && (
        <div className="p-4 rounded-2xl bg-slate-100 dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-500">Active Report:</span>
            <select value={selectedFile} onChange={(e) => setSelectedFile(e.target.value)} className="px-3 py-1.5 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono font-bold text-blue-600 dark:text-blue-400 cursor-pointer max-w-sm truncate">
              {currentSymbolReports.map((f) => (<option key={f} value={f}>{prettifyReportName(f)}</option>))}
            </select>
          </div>
          <span className="font-mono text-blue-600 dark:text-blue-400 flex items-center">
            Coverage: {(reportData as any).adaptive_effective_pct ?? 100}%
            <InfoTip metricKey="adaptive_coverage" />
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-[#1a2030] pb-2">
        <button onClick={() => setActiveSubTab('summary')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'summary' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <TrendingUp className="w-3.5 h-3.5" /><span>Summary Dashboard</span>
        </button>
        <button onClick={() => setActiveSubTab('diagnostics')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'diagnostics' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <Activity className="w-3.5 h-3.5 text-purple-400" /><span>Blueprint Diagnostics</span>
        </button>
        <button onClick={() => setActiveSubTab('portfolio')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'portfolio' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <Network className="w-3.5 h-3.5 text-emerald-400" /><span>Portfolio Correlation</span>
        </button>
        <button onClick={() => setActiveSubTab('variants')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'variants' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <GitBranch className="w-3.5 h-3.5 text-amber-400" /><span>Variant Matrix</span>
        </button>
        <button onClick={() => setActiveSubTab('tips')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'tips' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <Lightbulb className="w-3.5 h-3.5 text-amber-400" /><span>Actionable Improvement Tips</span>
        </button>
        <button onClick={() => setActiveSubTab('chart')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'chart' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <Calendar className="w-3.5 h-3.5" /><span>Day Chart Inspector</span>
        </button>
        <button onClick={() => setActiveSubTab('ledger')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'ledger' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <FileText className="w-3.5 h-3.5" /><span>Full Trade Ledger ({reportData?.all_trades?.length || 0})</span>
        </button>
      </div>

      {activeSubTab === 'summary' && (
        <div className="space-y-6">
          <HowToRead metricKey="sec_summary" />
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Total Trades <InfoTip metricKey="total_trades" /></div>
              <div className="text-2xl font-bold font-mono text-blue-600 dark:text-blue-400 mt-1">{kpis.count}</div>
              <div className="mt-1">
                {kpis.is_inconclusive ? (
                  <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-amber-500/15 text-amber-500">INCONCLUSIVE (&lt;30)</span>
                ) : (
                  <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-emerald-500/15 text-emerald-500">VALID SAMPLE</span>
                )}
              </div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Win Rate <InfoTip metricKey="win_rate" /></div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{kpis.win_rate}%</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Expectancy <InfoTip metricKey="expectancy" /></div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.expectancy > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{kpis.expectancy}R</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Profit Factor <InfoTip metricKey="profit_factor" /></div>
              <div className="text-2xl font-bold font-mono text-black dark:text-white mt-1">{kpis.profit_factor}</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Max Drawdown <InfoTip metricKey="max_drawdown" /></div>
              <div className="text-2xl font-bold font-mono text-rose-600 mt-1">-${kpis.max_dd_money}</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Net Realized P&L <InfoTip metricKey="net_pnl" /></div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{formatCurrency(kpis.net_pnl, brokerCurrency)}</div>
            </div>
          </div>

          <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
            <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">Performance by Strategy <InfoTip metricKey="strat_513" /></h3>
            <HowToRead metricKey="win_rate" />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                    <th className="py-2.5 px-3">Strategy Name</th>
                    <th className="py-2.5 px-3 text-center">Trades <InfoTip metricKey="col_trades" /></th>
                    <th className="py-2.5 px-3 text-center">Win Rate <InfoTip metricKey="win_rate" /></th>
                    <th className="py-2.5 px-3 text-center">Avg R <InfoTip metricKey="expectancy" /></th>
                    <th className="py-2.5 px-3 text-center">PF <InfoTip metricKey="profit_factor" /></th>
                    <th className="py-2.5 px-3 text-right">Net P&L <InfoTip metricKey="net_pnl" /></th>
                    <th className="py-2.5 px-3 text-center">TUNE (PF / WR / TR) <InfoTip metricKey="col_tune" /></th>
                    <th className="py-2.5 px-3 text-center">VALIDATE (PF / WR / TR) <InfoTip metricKey="col_validate" /></th>
                    <th className="py-2.5 px-3 text-center">Verdict <InfoTip metricKey="col_holdout_verdict" /></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                  {Object.entries(reportData?.strategy_kpis || {}).map(([sName, sKpi]: any) => {
                    const tv = (reportData as any)?.strategy_tune_validate?.[sName] || {};
                    const sTune = tv.tune || {};
                    const sVal = tv.validate || {};
                    const inconTune = (sTune.count ?? 0) < 30;
                    const inconVal = (sVal.count ?? 0) < 30;
                    const verdict = holdoutVerdictLocal(sTune, sVal);
                    const isFail = verdict === 'FAILS';
                    return (
                      <tr key={sName} className={`hover:bg-slate-50 dark:hover:bg-[#121520] ${isFail ? 'ring-1 ring-rose-500/30' : ''}`}>
                        <td className="py-3 px-3 font-bold text-black dark:text-white">{sName}</td>
                        <td className="py-3 px-3 text-center font-bold">{sKpi.count}</td>
                        <td className={`py-3 px-3 text-center font-bold ${sKpi.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{sKpi.win_rate}%</td>
                        <td className="py-3 px-3 text-center">{sKpi.avg_r}R</td>
                        <td className="py-3 px-3 text-center">{sKpi.profit_factor}</td>
                        <td className={`py-3 px-3 text-right font-bold ${sKpi.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${sKpi.net_pnl}</td>
                        <td className={`py-3 px-3 text-center font-mono text-[11px] ${inconTune ? 'text-slate-400' : ((sTune.profit_factor ?? 0) >= 1.0 ? 'text-emerald-600' : 'text-rose-500')}`}>
                          {inconTune ? 'INCONCLUSIVE' : `${(sTune.profit_factor ?? 0).toFixed(2)} / ${(sTune.win_rate ?? 0).toFixed(0)}% / ${sTune.count}`}
                        </td>
                        <td className={`py-3 px-3 text-center font-mono text-[11px] ${inconVal ? 'text-slate-400' : ((sVal.profit_factor ?? 0) >= 1.0 ? 'text-emerald-600' : 'text-rose-500')}`}>
                          {inconVal ? 'INCONCLUSIVE' : `${(sVal.profit_factor ?? 0).toFixed(2)} / ${(sVal.win_rate ?? 0).toFixed(0)}% / ${sVal.count}`}
                        </td>
                        <td className="py-3 px-3 text-center"><VerdictPill verdict={verdict} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeSubTab === 'portfolio' && (
        <div className="space-y-6">
          <HowToRead metricKey="sec_portfolio" />
          {isLoadingPortfolio ? (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center">
              <RefreshCw className="w-6 h-6 text-blue-500 animate-spin mx-auto" />
              <div className="text-xs text-slate-500 mt-2 font-mono">Loading cross-pair correlation matrix...</div>
            </div>
          ) : portfolioError ? (
            <div className="p-6 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-center">
              <Network className="w-7 h-7 text-amber-500 mx-auto" />
              <div className="text-sm font-bold text-amber-700 dark:text-amber-400 mt-2">Portfolio Correlation Not Available</div>
              <div className="text-xs text-amber-600/80 mt-1 font-mono">{portfolioError}</div>
              <button type="button" onClick={fetchPortfolio} className="mt-3 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold cursor-pointer">Refresh</button>
            </div>
          ) : portfolioData ? (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
                  <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Portfolio Max DD (concurrent) <InfoTip metricKey="max_drawdown" /></div>
                  <div className="text-2xl font-bold font-mono text-rose-500 mt-1">-${portfolioData.portfolio_drawdown}</div>
                </div>
                <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
                  <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Sum of Individual DDs <InfoTip metricKey="max_drawdown" /></div>
                  <div className="text-2xl font-bold font-mono text-slate-500 mt-1">-${portfolioData.sum_of_individual_drawdowns}</div>
                </div>
                <div className={`p-4 rounded-2xl border shadow-xs ${portfolioData.diversification_ratio >= 1.5 ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-white dark:bg-[#0f1118] border-slate-300 dark:border-[#1a2030]'}`}>
                  <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Diversification Ratio <InfoTip metricKey="sec_portfolio" /></div>
                  <div className={`text-2xl font-bold font-mono mt-1 ${portfolioData.diversification_ratio >= 1.5 ? 'text-emerald-500' : portfolioData.diversification_ratio >= 1.0 ? 'text-blue-500' : 'text-rose-500'}`}>
                    {portfolioData.diversification_ratio.toFixed(2)}x
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1 font-mono">Higher = better diversification</div>
                </div>
                <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
                  <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Avg Daily Correlation <InfoTip metricKey="sec_portfolio" /></div>
                  <div className={`text-2xl font-bold font-mono mt-1 ${Math.abs(portfolioData.avg_daily_correlation) < 0.3 ? 'text-emerald-500' : 'text-amber-500'}`}>
                    {portfolioData.avg_daily_correlation.toFixed(3)}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1 font-mono">{portfolioData.days} overlapping days</div>
                </div>
              </div>

              <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-black dark:text-white flex items-center">§30 · Cross-Pair Daily P&L Correlation Matrix <InfoTip metricKey="sec_portfolio" /></h3>
                  <div className="flex items-center gap-3 text-[10px] font-mono text-slate-500">
                    <span><span className="inline-block w-3 h-3 rounded bg-emerald-500/40 mr-1 align-middle" />neg (diversifying)</span>
                    <span><span className="inline-block w-3 h-3 rounded bg-slate-400/30 mr-1 align-middle" />neutral</span>
                    <span><span className="inline-block w-3 h-3 rounded bg-rose-500/40 mr-1 align-middle" />pos (concentrated)</span>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="text-[11px] font-mono border-separate border-spacing-0.5">
                    <thead>
                      <tr>
                        <th className="px-2 py-1.5 text-slate-500 text-left sticky left-0 bg-white dark:bg-[#0f1118] z-10"></th>
                        {portfolioData.symbols.map((s) => (
                          <th key={s} className="px-2 py-1.5 text-black dark:text-white font-bold text-center">{s}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {portfolioData.symbols.map((rowSym) => (
                        <tr key={rowSym}>
                          <td className="px-2 py-1.5 text-black dark:text-white font-bold sticky left-0 bg-white dark:bg-[#0f1118] z-10 text-right pr-3">{rowSym}</td>
                          {portfolioData.symbols.map((colSym) => {
                            const v = portfolioData.correlation_matrix?.[rowSym]?.[colSym];
                            const num = typeof v === 'number' ? v : 0;
                            const isSelf = rowSym === colSym;
                            return (
                              <td key={colSym} className={`px-2 py-1.5 text-center rounded border ${isSelf ? 'bg-blue-500/20 text-blue-900 dark:text-blue-100 border-blue-500/40 font-bold' : corrColor(num)}`}>
                                {isSelf ? '1.00' : num.toFixed(2)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-4 p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030] text-[11px] font-mono text-slate-600 dark:text-slate-300">
                  <strong className="text-blue-600 dark:text-blue-400">Interpretation:</strong>{' '}
                  {portfolioData.avg_daily_correlation < 0.2
                    ? 'Portfolio is well diversified. Pair drawdowns rarely coincide.'
                    : portfolioData.avg_daily_correlation < 0.5
                    ? 'Moderate concentration. Consider reducing risk on the highest-correlated pairs.'
                    : 'High concentration. Concurrent drawdowns likely. The strategy may be one directional bet across multiple symbols.'}
                </div>

                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-[10px] font-mono">
                  {portfolioData.symbols.map((s) => (
                    <div key={s} className="flex justify-between p-2 rounded-lg bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                      <span className="text-black dark:text-white font-bold">{s}</span>
                      <span className="text-slate-500">{portfolioData.trade_counts[s] || 0} trades</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center">
              <Network className="w-8 h-8 text-emerald-400 mx-auto" />
              <div className="text-sm font-bold text-black dark:text-white mt-2">No portfolio correlation yet</div>
              <div className="text-xs text-slate-500 mt-1">Run a symbol backtest first; the correlation file is written automatically.</div>
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'variants' && (
        <div className="space-y-6">
          <HowToRead metricKey="sec_variants" />
          {isLoadingVariants ? (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center">
              <RefreshCw className="w-6 h-6 text-amber-500 animate-spin mx-auto" />
              <div className="text-xs text-slate-500 mt-2 font-mono">Loading variants for {testSymbol}...</div>
            </div>
          ) : variantsError ? (
            <div className="p-6 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-center">
              <GitBranch className="w-7 h-7 text-amber-500 mx-auto" />
              <div className="text-sm font-bold text-amber-700 dark:text-amber-400 mt-2">No Variant Matrix for {testSymbol}</div>
              <div className="text-xs text-amber-600/80 mt-1 font-mono">{variantsError}</div>
              <div className="text-xs text-slate-500 mt-2">Tick the <strong>+ Variants</strong> checkbox above and click Run.</div>
              <button type="button" onClick={() => fetchVariants(testSymbol)} className="mt-3 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold cursor-pointer">Refresh</button>
            </div>
          ) : variantsData ? (
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-amber-500" />
                  <h3 className="text-sm font-bold text-black dark:text-white">
                    Variant Matrix — {variantsData.symbol} · {variantsData.days} Days · R:R {variantsData.target_rr}
                  </h3>
                  <InfoTip metricKey="sec_variants" />
                </div>
                <span className="text-[10px] font-mono text-slate-500">Generated {variantsData.generated_at}</span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                      <th className="py-2.5 px-3">Variant</th>
                      <th className="py-2.5 px-3 text-center">Trades</th>
                      <th className="py-2.5 px-3 text-center">Win Rate</th>
                      <th className="py-2.5 px-3 text-center">Exp (R)</th>
                      <th className="py-2.5 px-3 text-center">PF</th>
                      <th className="py-2.5 px-3 text-right">Max DD</th>
                      <th className="py-2.5 px-3 text-right">Net P&L</th>
                      <th className="py-2.5 px-3 text-center">Overrides</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                    {(variantsData.variants || []).map((v: BacktestVariantRow, idx: number) => {
                      const isErr = Boolean(v.error);
                      const overrides: string[] = [];
                      if (v.be_mode && v.be_mode !== 'FIXED_80') overrides.push(`BE:${v.be_mode}`);
                      if (v.trail_override) overrides.push(`Trail:${v.trail_override}`);
                      if (v.max_daily_override !== null && v.max_daily_override !== undefined) overrides.push(`Cap:${v.max_daily_override}`);

                      return (
                        <tr key={idx} className={`hover:bg-slate-50 dark:hover:bg-[#121520] ${isErr ? 'bg-rose-500/10' : ''}`}>
                          <td className="py-3 px-3 font-bold text-black dark:text-white">{v.label}</td>
                          {isErr ? (
                            <td colSpan={6} className="py-3 px-3 text-rose-500 italic text-[11px]">{v.error}</td>
                          ) : (
                            <>
                              <td className="py-3 px-3 text-center font-bold">{v.total_trades}</td>
                              <td className={`py-3 px-3 text-center font-bold ${v.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{v.win_rate}%</td>
                              <td className="py-3 px-3 text-center">{v.expectancy}R</td>
                              <td className="py-3 px-3 text-center">{v.profit_factor}</td>
                              <td className="py-3 px-3 text-right text-rose-500">-${v.max_drawdown}</td>
                              <td className={`py-3 px-3 text-right font-bold ${v.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${v.net_pnl}</td>
                            </>
                          )}
                          <td className="py-3 px-3 text-center text-[10px] text-slate-500">
                            {overrides.length > 0 ? overrides.join(' · ') : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030] text-[11px] font-mono text-slate-600 dark:text-slate-300">
                Compare the variant rows against the same symbol's baseline combos in the <strong className="text-blue-600 dark:text-blue-400">Summary Dashboard</strong> tab. If a variant beats the matching baseline (same Adaptive/Legacy mode), it should replace the default rule set in the live bot.
              </div>
            </div>
          ) : (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center">
              <GitBranch className="w-8 h-8 text-amber-400 mx-auto" />
              <div className="text-sm font-bold text-black dark:text-white mt-2">No variants loaded</div>
              <div className="text-xs text-slate-500 mt-1">Tick the + Variants checkbox above and run a backtest to generate them.</div>
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'diagnostics' && (() => {
        const diag = reportData?.diagnostics;
        if (!diag) {
          return (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center">
              <Activity className="w-8 h-8 text-purple-400 mx-auto" />
              <div className="text-sm font-bold text-black dark:text-white mt-2">No diagnostics yet</div>
              <div className="text-xs text-slate-500 mt-1">Run a backtest to generate the Blueprint analytics block. Older reports lack the new fields; rerun once.</div>
            </div>
          );
        }

        const kpiColor = (v: number) => v >= 0 ? 'text-emerald-500' : 'text-rose-500';

        return (
          <div className="space-y-6">
            <HowToRead metricKey="sec_diagnostics" />

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-black dark:text-white flex items-center">§19 · 24-Hour Hourly Expectancy Matrix (SAST) <InfoTip metricKey="diag_hour_matrix" /></h3>
                <span className="text-[10px] font-mono text-slate-500">Unbiased · all 24 hours scanned</span>
              </div>
              <HowToRead metricKey="diag_hour_matrix" />
              <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-12 gap-2 mt-3">
                {Array.from({ length: 24 }, (_, h) => {
                  const k = diag.hour_kpis?.[String(h)];
                  const hasData = k && k.count > 0;
                  const isWin = hasData && k.net_pnl >= 0;
                  const isThin = hasData && k.count < 30;
                  return (
                    <div key={h}
                      title={hasData ? `Hour ${String(h).padStart(2,'0')}:00 SAST\n${k.count} trades · ${k.win_rate}% WR · ${k.expectancy}R · PF ${k.profit_factor}\nNet P&L: $${k.net_pnl}` : `Hour ${String(h).padStart(2,'0')}:00 SAST — no trades`}
                      className={`p-2 rounded-xl border text-[10px] font-mono ${
                        !hasData
                          ? 'bg-slate-50 dark:bg-[#08090d] border-slate-200 dark:border-[#1a2030] text-slate-400'
                          : isWin
                            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600'
                            : 'bg-rose-500/10 border-rose-500/30 text-rose-600'
                      }`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-bold">{String(h).padStart(2,'0')}</span>
                        {isThin && <span className="text-[8px] px-1 rounded bg-amber-500/20 text-amber-600">thin</span>}
                      </div>
                      {hasData ? (
                        <>
                          <div className="truncate">n={k.count}</div>
                          <div className="truncate font-bold">{k.win_rate}%</div>
                          <div className="truncate">{k.net_pnl >= 0 ? '+' : ''}${k.net_pnl}</div>
                        </>
                      ) : <div className="text-center text-slate-300 dark:text-slate-600">—</div>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§20 · Performance by Day of Week <InfoTip metricKey="diag_hour_matrix" /></h3>
              <HowToRead metricKey="diag_hour_matrix" />
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                      <th className="py-2.5 px-3">Weekday</th>
                      <th className="py-2.5 px-3 text-center">Trades</th>
                      <th className="py-2.5 px-3 text-center">Win Rate</th>
                      <th className="py-2.5 px-3 text-center">Exp (R)</th>
                      <th className="py-2.5 px-3 text-center">PF</th>
                      <th className="py-2.5 px-3 text-right">Net P&L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                    {["Monday","Tuesday","Wednesday","Thursday","Friday"].map((dow) => {
                      const k = reportData?.dow_kpis?.[dow];
                      if (!k) return (
                        <tr key={dow}>
                          <td className="py-2.5 px-3 text-slate-400 italic">{dow}</td>
                          <td colSpan={5} className="py-2.5 px-3 text-slate-400 italic">no trades</td>
                        </tr>
                      );
                      return (
                        <tr key={dow} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                          <td className="py-3 px-3 font-bold text-black dark:text-white">{dow}</td>
                          <td className="py-3 px-3 text-center font-bold">{k.count}</td>
                          <td className={`py-3 px-3 text-center font-bold ${k.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{k.win_rate}%</td>
                          <td className={`py-3 px-3 text-center ${kpiColor(k.expectancy)}`}>{k.expectancy}R</td>
                          <td className="py-3 px-3 text-center">{k.profit_factor}</td>
                          <td className={`py-3 px-3 text-right font-bold ${kpiColor(k.net_pnl)}`}>${k.net_pnl}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§21 · Session-Rollover Friction <InfoTip metricKey="diag_session_rollover" /></h3>
              <HowToRead metricKey="diag_session_rollover" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                {[
                  { label: 'Inside Rollover Windows', d: diag.session_rollover.in_transition },
                  { label: 'Outside Rollover Windows', d: diag.session_rollover.out_of_transition },
                ].map(({ label, d }) => (
                  <div key={label} className="p-4 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030] text-xs font-mono">
                    <div className="font-bold text-black dark:text-white mb-2">{label}</div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>Trades: <span className="font-bold">{d.count}</span></div>
                      <div>WR: <span className={`font-bold ${d.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{d.win_rate}%</span></div>
                      <div>Exp: <span className={`font-bold ${kpiColor(d.expectancy)}`}>{d.expectancy}R</span></div>
                      <div>PF: <span className="font-bold">{d.profit_factor}</span></div>
                      <div className="col-span-2">Net: <span className={`font-bold ${kpiColor(d.net_pnl)}`}>${d.net_pnl}</span></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§26 · ATR Volatility Tiering <InfoTip metricKey="diag_atr_tier" /></h3>
              <HowToRead metricKey="diag_atr_tier" />
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono mt-3">
                {['LOW','NORMAL','HIGH','UNKNOWN'].map((tier) => {
                  const k = diag.atr_tier_kpis?.[tier];
                  if (!k || k.count === 0) {
                    return (
                      <div key={tier} className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030] opacity-50">
                        <div className="font-bold text-slate-500">{tier}</div>
                        <div className="text-slate-400 text-[10px] mt-1">no data</div>
                      </div>
                    );
                  }
                  return (
                    <div key={tier} className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                      <div className="font-bold text-black dark:text-white">{tier}</div>
                      <div className="mt-1 text-[11px]">n={k.count} · WR {k.win_rate}%</div>
                      <div className={`text-[11px] font-bold ${kpiColor(k.net_pnl)}`}>${k.net_pnl}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
                <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§31 · Consecutive Loss Streak <InfoTip metricKey="diag_streak" /></h3>
                <HowToRead metricKey="diag_streak" />
                <div className="grid grid-cols-2 gap-3 text-xs font-mono mt-3">
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="text-[10px] text-slate-500 uppercase">Max Streak</div>
                    <div className="text-lg font-bold text-rose-500">{diag.streak_analysis.max_consecutive_losses}</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="text-[10px] text-slate-500 uppercase">Avg Streak</div>
                    <div className="text-lg font-bold text-black dark:text-white">{diag.streak_analysis.average_streak}</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="text-[10px] text-slate-500 uppercase">Peak Drawdown</div>
                    <div className="text-lg font-bold text-rose-500">-${diag.streak_analysis.peak_drawdown}</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="text-[10px] text-slate-500 uppercase">Recovery Trades</div>
                    <div className="text-lg font-bold text-blue-500">{diag.streak_analysis.recovery_trades_from_peak_dd}</div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
                <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§32 · Circuit-Breaker Simulation <InfoTip metricKey="diag_circuit_breaker" /></h3>
                <HowToRead metricKey="diag_circuit_breaker" />
                <div className="space-y-2 text-xs font-mono mt-3">
                  <div className="flex justify-between p-2 rounded-lg bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <span className="text-slate-500">Original Net P&L</span>
                    <span className={`font-bold ${kpiColor(diag.circuit_breaker_sim.original_net_pnl)}`}>${diag.circuit_breaker_sim.original_net_pnl}</span>
                  </div>
                  <div className="flex justify-between p-2 rounded-lg bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <span className="text-slate-500">With Halving</span>
                    <span className={`font-bold ${kpiColor(diag.circuit_breaker_sim.simulated_net_pnl)}`}>${diag.circuit_breaker_sim.simulated_net_pnl}</span>
                  </div>
                  <div className="flex justify-between p-2 rounded-lg bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <span className="text-slate-500">Trades Halved</span>
                    <span className="font-bold text-black dark:text-white">{diag.circuit_breaker_sim.trades_halved}</span>
                  </div>
                  <div className="flex justify-between p-2 rounded-lg bg-blue-500/10 border border-blue-500/30">
                    <span className="text-blue-600 font-bold">Protection Delta</span>
                    <span className={`font-bold ${kpiColor(diag.circuit_breaker_sim.protection_delta)}`}>
                      {diag.circuit_breaker_sim.protection_delta >= 0 ? '+' : ''}${diag.circuit_breaker_sim.protection_delta}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§36 · Outlier Dependency Removal <InfoTip metricKey="diag_outlier_removal" /></h3>
              <HowToRead metricKey="diag_outlier_removal" />
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                      <th className="py-2 px-3">Scenario</th>
                      <th className="py-2 px-3 text-center">Trades</th>
                      <th className="py-2 px-3 text-center">WR</th>
                      <th className="py-2 px-3 text-center">PF</th>
                      <th className="py-2 px-3 text-right">Net P&L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                    <tr>
                      <td className="py-3 px-3 font-bold text-black dark:text-white">Full Set</td>
                      <td className="py-3 px-3 text-center">{diag.outlier_removal.full.count}</td>
                      <td className="py-3 px-3 text-center">{diag.outlier_removal.full.win_rate}%</td>
                      <td className="py-3 px-3 text-center">{diag.outlier_removal.full.profit_factor}</td>
                      <td className={`py-3 px-3 text-right font-bold ${kpiColor(diag.outlier_removal.full.net_pnl)}`}>${diag.outlier_removal.full.net_pnl}</td>
                    </tr>
                    <tr>
                      <td className="py-3 px-3 font-bold text-black dark:text-white">Top 5% Removed ({diag.outlier_removal.outlier_count})</td>
                      <td className="py-3 px-3 text-center">{diag.outlier_removal.trimmed.count}</td>
                      <td className="py-3 px-3 text-center">{diag.outlier_removal.trimmed.win_rate}%</td>
                      <td className="py-3 px-3 text-center">{diag.outlier_removal.trimmed.profit_factor}</td>
                      <td className={`py-3 px-3 text-right font-bold ${kpiColor(diag.outlier_removal.trimmed.net_pnl)}`}>${diag.outlier_removal.trimmed.net_pnl}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="mt-3 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] font-mono text-amber-600">
                Dependency on top 5%: <strong>{diag.outlier_removal.impact_pct}%</strong> of net P&L.
                {diag.outlier_removal.impact_pct > 50 && ' ⚠ Highly concentrated — strategy relies on rare outliers.'}
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§37 · Monte Carlo Resampling <InfoTip metricKey="diag_monte_carlo" /></h3>
              <HowToRead metricKey="diag_monte_carlo" />
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 text-xs font-mono mt-3">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Median Max DD</div>
                  <div className="text-lg font-bold text-rose-500">-${diag.monte_carlo.median_max_dd}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">P5 Max DD</div>
                  <div className="text-lg font-bold text-emerald-500">-${diag.monte_carlo.p5_max_dd}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">P95 Max DD</div>
                  <div className="text-lg font-bold text-rose-500">-${diag.monte_carlo.p95_max_dd}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Median Final Eq</div>
                  <div className="text-lg font-bold text-blue-500">${diag.monte_carlo.median_final_equity}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Prob Positive</div>
                  <div className={`text-lg font-bold ${diag.monte_carlo.prob_positive >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{diag.monte_carlo.prob_positive}%</div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§38 · Buy-and-Hold Benchmark (Alpha) <InfoTip metricKey="diag_buy_and_hold" /></h3>
              <HowToRead metricKey="diag_buy_and_hold" />
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono mt-3">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Hold Return</div>
                  <div className={`text-lg font-bold ${kpiColor(diag.buy_and_hold.bh_return_pct)}`}>{diag.buy_and_hold.bh_return_pct}%</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Hold P&L</div>
                  <div className={`text-lg font-bold ${kpiColor(diag.buy_and_hold.bh_net_pnl)}`}>${diag.buy_and_hold.bh_net_pnl}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Strategy P&L</div>
                  <div className={`text-lg font-bold ${kpiColor(diag.buy_and_hold.strategy_net_pnl)}`}>${diag.buy_and_hold.strategy_net_pnl}</div>
                </div>
                <div className={`p-3 rounded-xl border ${diag.buy_and_hold.alpha >= 0 ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-rose-500/10 border-rose-500/30'}`}>
                  <div className="text-[10px] text-slate-500 uppercase">Alpha</div>
                  <div className={`text-lg font-bold ${kpiColor(diag.buy_and_hold.alpha)}`}>${diag.buy_and_hold.alpha}</div>
                </div>
              </div>
              <div className={`mt-3 p-2 rounded-lg border text-[11px] font-mono font-bold ${
                diag.buy_and_hold.verdict === 'STRATEGY_BEATS_HOLD'
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-600'
              }`}>
                Verdict: {diag.buy_and_hold.verdict.replace(/_/g, ' ')}
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§16 · Post-SL Continuation Distance <InfoTip metricKey="diag_post_sl" /></h3>
              <HowToRead metricKey="diag_post_sl" />
              {diag.post_sl.count === 0 ? (
                <div className="text-xs text-slate-400 italic mt-3">No SL exits with post-exit tracking available.</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono mt-3">
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                      <div className="text-[10px] text-slate-500 uppercase">Sample</div>
                      <div className="text-lg font-bold text-black dark:text-white">{diag.post_sl.count}</div>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                      <div className="text-[10px] text-slate-500 uppercase">Mean Overshoot</div>
                      <div className="text-lg font-bold text-rose-500">{diag.post_sl.mean_pips} pips</div>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                      <div className="text-[10px] text-slate-500 uppercase">Median</div>
                      <div className="text-lg font-bold text-black dark:text-white">{diag.post_sl.median_pips} pips</div>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                      <div className="text-[10px] text-slate-500 uppercase">Worst</div>
                      <div className="text-lg font-bold text-rose-500">{diag.post_sl.max_pips} pips</div>
                    </div>
                  </div>
                  <div className="mt-3 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] font-mono text-amber-600">
                    <strong>{diag.post_sl.recovered_count}</strong> of {diag.post_sl.count} SL exits ({diag.post_sl.recovered_pct}%) would have recovered to the original TP within 2 hours.
                  </div>
                </>
              )}
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§17 · Post-TP Movement <InfoTip metricKey="diag_post_tp" /></h3>
              <HowToRead metricKey="diag_post_tp" />
              {diag.post_tp.count === 0 ? (
                <div className="text-xs text-slate-400 italic mt-3">No TP exits with post-exit tracking available.</div>
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono mt-3">
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="text-[10px] text-slate-500 uppercase">Sample</div>
                    <div className="text-lg font-bold text-black dark:text-white">{diag.post_tp.count}</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="text-[10px] text-slate-500 uppercase">Mean Extra</div>
                    <div className="text-lg font-bold text-emerald-500">{diag.post_tp.mean_pips} pips</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="text-[10px] text-slate-500 uppercase">Best Case</div>
                    <div className="text-lg font-bold text-emerald-500">{diag.post_tp.max_pips} pips</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="text-[10px] text-slate-500 uppercase">Avg Missed</div>
                    <div className="text-lg font-bold text-blue-500">{diag.post_tp.avg_missed_r}R</div>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§18 · Premature BE Exit Detection <InfoTip metricKey="diag_premature_be" /></h3>
              <HowToRead metricKey="diag_premature_be" />
              {diag.premature_be.total_be_moved === 0 ? (
                <div className="text-xs text-slate-400 italic mt-3">No BE-moved trades in this run.</div>
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono mt-3">
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="text-[10px] text-slate-500 uppercase">BE Moved</div>
                    <div className="text-lg font-bold text-black dark:text-white">{diag.premature_be.total_be_moved}</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="text-[10px] text-slate-500 uppercase">Premature</div>
                    <div className="text-lg font-bold text-amber-500">{diag.premature_be.premature_count}</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="text-[10px] text-slate-500 uppercase">Rate</div>
                    <div className="text-lg font-bold text-amber-500">{diag.premature_be.premature_pct}%</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="text-[10px] text-slate-500 uppercase">Missed R</div>
                    <div className="text-lg font-bold text-rose-500">{diag.premature_be.total_missed_r}R</div>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§27 · 200 EMA Trend-Alignment Differential <InfoTip metricKey="diag_ema_200" /></h3>
              <HowToRead metricKey="diag_ema_200" />
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-mono mt-3">
                {[
                  { label: 'Trend-Aligned', d: diag.ema_200_alignment.aligned },
                  { label: 'Counter-Trend', d: diag.ema_200_alignment.counter_trend },
                  { label: 'Unknown', d: diag.ema_200_alignment.unknown },
                ].map(({ label, d }) => (
                  <div key={label} className="p-4 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="font-bold text-black dark:text-white mb-2">{label}</div>
                    {d.count === 0 ? (
                      <div className="text-slate-400 italic text-[11px]">no data</div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        <div>Trades: <span className="font-bold">{d.count}</span></div>
                        <div>WR: <span className={`font-bold ${d.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{d.win_rate}%</span></div>
                        <div>Exp: <span className={`font-bold ${kpiColor(d.expectancy)}`}>{d.expectancy}R</span></div>
                        <div>PF: <span className="font-bold">{d.profit_factor}</span></div>
                        <div className="col-span-2">Net: <span className={`font-bold ${kpiColor(d.net_pnl)}`}>${d.net_pnl}</span></div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§28 · Candle-Close vs Touch Confirmation <InfoTip metricKey="diag_confirmation" /></h3>
              <HowToRead metricKey="diag_confirmation" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono mt-3">
                {[
                  { label: 'Close Confirmation', d: diag.confirmation_type.close },
                  { label: 'Touch Confirmation', d: diag.confirmation_type.touch },
                ].map(({ label, d }) => (
                  <div key={label} className="p-4 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="font-bold text-black dark:text-white mb-2">{label}</div>
                    {d.count === 0 ? (
                      <div className="text-slate-400 italic text-[11px]">no data</div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        <div>Trades: <span className="font-bold">{d.count}</span></div>
                        <div>WR: <span className={`font-bold ${d.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{d.win_rate}%</span></div>
                        <div>Exp: <span className={`font-bold ${kpiColor(d.expectancy)}`}>{d.expectancy}R</span></div>
                        <div>PF: <span className="font-bold">{d.profit_factor}</span></div>
                        <div className="col-span-2">Net: <span className={`font-bold ${kpiColor(d.net_pnl)}`}>${d.net_pnl}</span></div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§29 · News-Event Slippage Profiling <InfoTip metricKey="diag_news" /></h3>
              <HowToRead metricKey="diag_news" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono mt-3">
                {[
                  { label: 'Inside News Window', d: diag.news_window.in_news },
                  { label: 'Outside News Window', d: diag.news_window.out_of_news },
                ].map(({ label, d }) => (
                  <div key={label} className="p-4 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="font-bold text-black dark:text-white mb-2">{label}</div>
                    {d.count === 0 ? (
                      <div className="text-slate-400 italic text-[11px]">no data</div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        <div>Trades: <span className="font-bold">{d.count}</span></div>
                        <div>WR: <span className={`font-bold ${d.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{d.win_rate}%</span></div>
                        <div>Exp: <span className={`font-bold ${kpiColor(d.expectancy)}`}>{d.expectancy}R</span></div>
                        <div>PF: <span className="font-bold">{d.profit_factor}</span></div>
                        <div className="col-span-2">Net: <span className={`font-bold ${kpiColor(d.net_pnl)}`}>${d.net_pnl}</span></div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§22 · Break-even Variants A / B / C (post-hoc estimate) <InfoTip metricKey="diag_breakeven_variants" /></h3>
              <HowToRead metricKey="diag_breakeven_variants" />
              {!diag.breakeven_variants || !diag.breakeven_variants.A_current ? (
                <div className="text-xs text-slate-400 italic mt-3">n/a — rerun the backtest to generate this estimate.</div>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-mono mt-3">
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                      <div className="text-[10px] text-slate-500 uppercase">A · Current</div>
                      <div className="text-lg font-bold text-blue-500">{diag.breakeven_variants.A_current.total_r}R</div>
                      <div className="text-[10px] text-slate-500 mt-1">avg {diag.breakeven_variants.A_current.avg_r}R across {diag.breakeven_variants.A_current.count}</div>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                      <div className="text-[10px] text-slate-500 uppercase">B · No BE</div>
                      <div className="text-lg font-bold text-emerald-500">{diag.breakeven_variants.B_no_be.total_r}R</div>
                      <div className="text-[10px] text-slate-500 mt-1">avg {diag.breakeven_variants.B_no_be.avg_r}R across {diag.breakeven_variants.B_no_be.count}</div>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                      <div className="text-[10px] text-slate-500 uppercase">C · Delayed BE (after 1.0R)</div>
                      <div className="text-lg font-bold text-amber-500">{diag.breakeven_variants.C_delayed_be.total_r}R</div>
                      <div className="text-[10px] text-slate-500 mt-1">avg {diag.breakeven_variants.C_delayed_be.avg_r}R across {diag.breakeven_variants.C_delayed_be.count}</div>
                    </div>
                  </div>
                  <div className="mt-3 p-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-[11px] font-mono text-blue-600">
                    Best variant: <strong>{diag.breakeven_variants.best_variant}</strong> — {diag.breakeven_variants.verdict}
                  </div>
                </>
              )}
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§35 · Parameter Sensitivity (Target R:R sweep) <InfoTip metricKey="diag_parameter_sensitivity" /></h3>
              <HowToRead metricKey="diag_parameter_sensitivity" />
              {!diag.parameter_sensitivity || !diag.parameter_sensitivity.sweep || diag.parameter_sensitivity.sweep.length === 0 ? (
                <div className="text-xs text-slate-400 italic mt-3">n/a — rerun the backtest to generate this estimate.</div>
              ) : (
                <div className="overflow-x-auto mt-3">
                  <table className="w-full text-left text-xs font-mono">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                        <th className="py-2 px-3">R:R</th>
                        <th className="py-2 px-3 text-right">Net P&L</th>
                        <th className="py-2 px-3 text-center">Total R</th>
                        <th className="py-2 px-3 text-center">Trades</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                      {diag.parameter_sensitivity.sweep.map((row: any, i: number) => {
                        const isBest = Math.abs(row.rr - diag.parameter_sensitivity.best_rr) < 1e-6;
                        return (
                          <tr key={i} className={isBest ? 'bg-blue-500/5' : ''}>
                            <td className="py-2.5 px-3 font-bold text-black dark:text-white">1:{row.rr.toFixed(2)}{isBest && ' ★'}</td>
                            <td className={`py-2.5 px-3 text-right font-bold ${kpiColor(row.net_pnl)}`}>${row.net_pnl}</td>
                            <td className="py-2.5 px-3 text-center">{row.total_r}R</td>
                            <td className="py-2.5 px-3 text-center">{row.count}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="mt-3 p-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-[11px] font-mono text-blue-600">
                    {diag.parameter_sensitivity.verdict}
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§24 · Position Sizing Comparison <InfoTip metricKey="diag_sizing" /></h3>
              <HowToRead metricKey="diag_sizing" />
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-mono mt-3">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Fixed Risk</div>
                  <div className={`text-lg font-bold ${kpiColor(diag.sizing_comparison.fixed.net_pnl)}`}>${diag.sizing_comparison.fixed.net_pnl}</div>
                  <div className="text-[10px] text-slate-500 mt-1">Final: ${diag.sizing_comparison.fixed.final_equity}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Compounding</div>
                  <div className={`text-lg font-bold ${kpiColor(diag.sizing_comparison.compounding.net_pnl)}`}>${diag.sizing_comparison.compounding.net_pnl}</div>
                  <div className="text-[10px] text-slate-500 mt-1">Final: ${diag.sizing_comparison.compounding.final_equity}</div>
                </div>
                <div className={`p-3 rounded-xl border ${diag.sizing_comparison.difference >= 0 ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-rose-500/10 border-rose-500/30'}`}>
                  <div className="text-[10px] text-slate-500 uppercase">Compounding Advantage</div>
                  <div className={`text-lg font-bold ${kpiColor(diag.sizing_comparison.difference)}`}>
                    {diag.sizing_comparison.difference >= 0 ? '+' : ''}${diag.sizing_comparison.difference}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1">
                    {diag.sizing_comparison.difference > 0 ? 'Compounding wins' : diag.sizing_comparison.difference < 0 ? 'Fixed wins' : 'Tied'}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§25 · Daily Execution Cap Comparison <InfoTip metricKey="diag_daily_caps" /></h3>
              <HowToRead metricKey="diag_daily_caps" />
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono mt-3">
                {[
                  { label: 'Cap = 1', d: diag.daily_cap_comparison.cap_1 },
                  { label: 'Cap = 2', d: diag.daily_cap_comparison.cap_2 },
                  { label: 'Cap = 4', d: diag.daily_cap_comparison.cap_4 },
                  { label: 'Unlimited', d: diag.daily_cap_comparison.unlimited },
                ].map(({ label, d }) => (
                  <div key={label} className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                    <div className="font-bold text-black dark:text-white">{label}</div>
                    <div className="mt-1 text-[11px]">n={d.count} · WR {d.win_rate}%</div>
                    <div className={`text-[11px] font-bold ${kpiColor(d.net_pnl)}`}>${d.net_pnl}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§33 · Daily Max-Drawdown Cutoff Simulation <InfoTip metricKey="diag_dd_cutoff" /></h3>
              <HowToRead metricKey="diag_dd_cutoff" />
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 text-xs font-mono mt-3">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Days Triggered</div>
                  <div className="text-lg font-bold text-amber-500">{diag.daily_dd_cutoff.days_triggered}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Trades Blocked</div>
                  <div className="text-lg font-bold text-amber-500">{diag.daily_dd_cutoff.trades_blocked}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Original P&L</div>
                  <div className={`text-lg font-bold ${kpiColor(diag.daily_dd_cutoff.original_net_pnl)}`}>${diag.daily_dd_cutoff.original_net_pnl}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">With Cutoff</div>
                  <div className={`text-lg font-bold ${kpiColor(diag.daily_dd_cutoff.cutoff_net_pnl)}`}>${diag.daily_dd_cutoff.cutoff_net_pnl}</div>
                </div>
                <div className={`p-3 rounded-xl border ${diag.daily_dd_cutoff.protection_delta >= 0 ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-rose-500/10 border-rose-500/30'}`}>
                  <div className="text-[10px] text-slate-500 uppercase">Protection Δ</div>
                  <div className={`text-lg font-bold ${kpiColor(diag.daily_dd_cutoff.protection_delta)}`}>
                    {diag.daily_dd_cutoff.protection_delta >= 0 ? '+' : ''}${diag.daily_dd_cutoff.protection_delta}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1 flex items-center">§34 · Slippage Sensitivity Curve <InfoTip metricKey="diag_slippage" /></h3>
              <HowToRead metricKey="diag_slippage" />
              {Object.keys(diag.slippage_sensitivity || {}).length === 0 ? (
                <div className="text-xs text-slate-400 italic mt-3">No slippage data.</div>
              ) : (
                <div className="overflow-x-auto mt-3">
                  <table className="w-full text-left text-xs font-mono">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                        <th className="py-2 px-3">Slippage</th>
                        <th className="py-2 px-3 text-right">Net P&L</th>
                        <th className="py-2 px-3 text-center">Win Rate</th>
                        <th className="py-2 px-3 text-right">Δ vs Baseline</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                      {Object.values(diag.slippage_sensitivity).map((pt: any, i: number) => {
                        const baseline = diag.slippage_sensitivity.baseline?.net_pnl ?? 0;
                        const delta = (pt.net_pnl || 0) - baseline;
                        const isBaseline = pt.slippage_pips === 0;
                        return (
                          <tr key={i} className={isBaseline ? 'bg-blue-500/5' : ''}>
                            <td className="py-2.5 px-3 font-bold text-black dark:text-white">
                              {isBaseline ? 'Baseline (0 pips)' : `${pt.slippage_pips} pip${pt.slippage_pips > 1 ? 's' : ''}`}
                            </td>
                            <td className={`py-2.5 px-3 text-right font-bold ${kpiColor(pt.net_pnl)}`}>${pt.net_pnl}</td>
                            <td className="py-2.5 px-3 text-center">{pt.win_rate}%</td>
                            <td className={`py-2.5 px-3 text-right font-bold ${isBaseline ? 'text-slate-400' : kpiColor(delta)}`}>
                              {isBaseline ? '—' : `${delta >= 0 ? '+' : ''}$${delta.toFixed(2)}`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

          </div>
        );
      })()}

      {activeSubTab === 'tips' && (
        <div className="space-y-4">
          <HowToRead metricKey="sec_tips" />
          {activeTips.length === 0 ? (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center">
              <Sparkles className="w-8 h-8 text-amber-400 mx-auto" />
              <div className="text-sm font-bold text-black dark:text-white mt-2">No tip rules triggered</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {activeTips.map((tip) => (
                <div key={tip.id} className="p-5 rounded-2xl border bg-white dark:bg-[#0f1118] shadow-xs flex flex-col justify-between space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[9px] font-mono font-bold bg-blue-500/15 text-blue-600">{tip.severity}</span>
                    <button type="button" onClick={() => setDismissedTipIds(prev => [...prev, tip.id])} className="text-slate-400 hover:text-rose-600"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                  <h4 className="text-sm font-bold text-black dark:text-white">{tip.title}</h4>
                  <p className="text-xs text-slate-600 dark:text-slate-400">{tip.description}</p>
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] text-xs text-slate-700 dark:text-slate-300">
                    <strong className="text-blue-500">Action: </strong>{tip.action}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'chart' && (
        <div className="space-y-4">
          <HowToRead metricKey="sec_chart" />
          <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] flex items-center justify-between">
            <select value={selectedDay} onChange={(e) => setSelectedDay(e.target.value)} className="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-[#08090d] font-mono font-bold text-blue-600 dark:text-blue-400">
              {(reportData?.trading_dates || []).map((d) => (<option key={d} value={d}>{d}</option>))}
            </select>
          </div>
          <div ref={chartContainerRef} className="w-full h-[480px] rounded-2xl bg-white dark:bg-[#07090e] border border-slate-300 dark:border-[#1a2030]" />
        </div>
      )}

      {activeSubTab === 'ledger' && (
        <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs overflow-hidden">
          <div className="p-4 border-b border-slate-200 dark:border-[#1a2030]">
            <HowToRead metricKey="sec_ledger" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500 bg-slate-50 dark:bg-[#08090d]/50">
                  <th className="py-3 px-3">Date</th><th className="py-3 px-3">Strategy</th><th className="py-3 px-3">Dir</th><th className="py-3 px-3">Lots</th><th className="py-3 px-3">Entry</th><th className="py-3 px-3">Exit</th><th className="py-3 px-3">R</th><th className="py-3 px-3 text-right">Net P&L</th><th className="py-3 px-3">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                {filteredTrades.map((t: any, idx: number) => (
                  <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                    <td className="py-2.5 px-3 text-slate-400">{t.date_sast || t.date}</td>
                    <td className="py-2.5 px-3 font-bold text-black dark:text-white">{t.strategy}</td>
                    <td className={`py-2.5 px-3 font-bold ${t.direction === 'BUY' ? 'text-emerald-500' : 'text-rose-500'}`}>{t.direction}</td>
                    <td className="py-2.5 px-3">{t.lots}</td>
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