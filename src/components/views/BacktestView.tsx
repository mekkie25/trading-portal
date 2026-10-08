import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import {
  TrendingUp, RefreshCw, Play, Lightbulb, Trash2,
  Layers, Square, Copy, Check, Database, Clock, ShieldCheck, Download, Printer,
  FileText, Activity, Network, Info, FlaskConical
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
  combinations: SummaryCombination[];
}

interface StorageInfo {
  total_mb: number; used_mb: number; free_mb: number;
  market_data_mb: number; reports_mb: number;
}

interface RunResultItem {
  symbol: string; status: 'OK' | 'FAILED'; message: string; timing?: string;
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

const VerdictPill: React.FC<{ verdict?: string }> = ({ verdict }) => {
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
    <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold ${cfg[v] || cfg.INCONCLUSIVE}`}>
      {v}
    </span>
  );
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

export const BacktestView: React.FC<BacktestViewProps> = ({ themeMode = 'dark', brokerCurrency = 'USD' }) => {
  const [reportFiles, setReportFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [reportData, setReportData] = useState<BacktestReportPayload | null>(null);
  const [summaryData, setSummaryData] = useState<SymbolSummaryPayload | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<'summary' | 'diagnostics' | 'portfolio' | 'lab' | 'tips' | 'ledger'>('summary');
  const [selectedDay, setSelectedDay] = useState<string>('');

  const [testSymbol, setTestSymbol] = useState<string>('US30');
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(['US30']);
  const [testDays, setTestDays] = useState<number>(365);

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

  useEffect(() => {
    if (activeSubTab === 'portfolio') fetchPortfolio();
  }, [activeSubTab, fetchPortfolio]);

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
    return reportFiles.filter(f => f.startsWith(`${testSymbol}_`) && f !== 'portfolio_correlation.json' && !f.endsWith('_lab.json') && !f.endsWith('_verify.json') && !f.endsWith('_compare.json'));
  }, [reportFiles, testSymbol]);

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
          setSelectedFile('');
          setReportData(null);
        }
      }
    } finally { setIsCleaning(false); }
  };

  const handleRunSelected = async () => {
    if (isRunning || selectedSymbols.length === 0) return;
    setIsRunning(true);
    setRunResults([]);
    setProgressText(`Preparing matrix for ${selectedSymbols.join(', ')}...`);
    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selectedSymbols.length === 1 ? selectedSymbols[0] : selectedSymbols,
          days: testDays,
        }),
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
    setIsRunning(true);
    setRunResults([]);
    setProgressText(`Preparing matrix for all 7 pairs...`);
    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'ALL', days: testDays }),
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
      setIsRunning(false);
      setProgressText('Cancelled.');
      await fetchStorageInfo();
    } catch {}
  };

  const handleRunStrategyLab = async () => {
    if (labRunning || selectedSymbols.length === 0) return;
    setLabRunning(true);
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

  const formatVerifyResult = (r: any): string => {
    if (r.error) return `Error: ${r.error}`;
    const lines: string[] = [];
    lines.push(`VERIFY ${r.symbol} — ${r.days} days`);
    lines.push(`Old combo: ${r.old_combo || 'n/a'}`);
    lines.push(`New combo: ${r.new_combo || 'n/a'}`);
    lines.push(`Old trades: ${r.old_trades_count ?? 'n/a'} | New trades: ${r.new_trades_count ?? 'n/a'}`);
    if (r.old_kpis) lines.push(`Old KPIs: WR ${r.old_kpis.win_rate}%, PF ${r.old_kpis.profit_factor}, PnL $${r.old_kpis.net_pnl}, Max DD $${r.old_kpis.max_dd_money}`);
    if (r.new_kpis) lines.push(`New KPIs: WR ${r.new_kpis.win_rate}%, PF ${r.new_kpis.profit_factor}, PnL $${r.new_kpis.net_pnl}, Max DD $${r.new_kpis.max_dd_money}`);
    lines.push(`Verdict: ${r.verdict}`);
    if (r.old_run && r.old_run.error) lines.push(`Old engine run: ${r.old_run.error}`);
    if (r.new_run && r.new_run.error) lines.push(`New engine run: ${r.new_run.error}`);
    if (r.csv_copied && r.csv_copied.length > 0) lines.push(`CSVs copied to reference: ${r.csv_copied.join(', ')}`);
    if (Array.isArray(r.divergences_sample) && r.divergences_sample.length > 0) {
      lines.push('');
      lines.push(`First ${r.divergences_sample.length} divergent trades:`);
      for (const d of r.divergences_sample) {
        lines.push(`  [${d.stage}] index ${d.index}`);
        if (d.old) lines.push(`    old : ${d.old.signal_time_utc} ${d.old.direction} ${d.old.strategy} entry ${d.old.entry_price} sl ${d.old.sl} tp ${d.old.tp} exit ${d.old.exit_time} @ ${d.old.exit_price} (${d.old.exit_reason}) PnL $${d.old.money_pnl}`);
        if (d.new) lines.push(`    new : ${d.new.signal_time_utc} ${d.new.direction} ${d.new.strategy} entry ${d.new.entry_price} sl ${d.new.sl} tp ${d.new.tp} exit ${d.new.exit_time} @ ${d.new.exit_price} (${d.new.exit_reason}) PnL $${d.new.money_pnl}`);
      }
    }
    if (r.cost_assumptions) {
      lines.push('');
      lines.push('Cost assumptions:');
      if (r.cost_assumptions.old) lines.push(`  old: ${JSON.stringify(r.cost_assumptions.old)}`);
      if (r.cost_assumptions.new) lines.push(`  new: ${JSON.stringify(r.cost_assumptions.new)}`);
    }
    return lines.join('\n');
  };

  const handleVerifyVsOriginal = async () => {
    setIsVerifying(true);
    setVerifyResult(null);
    setVerifyProgress(`Starting comparison for ${testSymbol}...`);
    try {
      const start = await fetch('/api/backtest/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: testSymbol, days: 60 }),
      });
      const text = await start.text();
      let startJson: any = {};
      try { startJson = JSON.parse(text); } catch {
        setVerifyResult(`Non-JSON response (HTTP ${start.status}): ${text.slice(0, 200)}`);
        setIsVerifying(false);
        return;
      }
      if (!start.ok) {
        setVerifyResult(`Failed to start (HTTP ${start.status}): ${startJson.error || 'unknown'}`);
        setIsVerifying(false);
        return;
      }
      setVerifyProgress(startJson.message || 'Comparison running...');

      const pollId = window.setInterval(async () => {
        try {
          const statusRes = await fetch('/api/backtest/compare/status');
          const statusText = await statusRes.text();
          let statusJson: any = {};
          try { statusJson = JSON.parse(statusText); } catch {
            window.clearInterval(pollId);
            setIsVerifying(false);
            setVerifyResult(`Non-JSON poll (HTTP ${statusRes.status}): ${statusText.slice(0, 200)}`);
            return;
          }
          if (statusJson.progress) setVerifyProgress(statusJson.progress);
          if (!statusJson.isRunning) {
            window.clearInterval(pollId);
            setIsVerifying(false);
            if (statusJson.lastError) {
              setVerifyResult(`Comparison failed: ${statusJson.lastError}`);
            } else if (statusJson.result) {
              setVerifyResult(formatVerifyResult(statusJson.result));
            } else {
              setVerifyResult('Comparison finished but no result file was produced.');
            }
          }
        } catch (e: any) {
          window.clearInterval(pollId);
          setIsVerifying(false);
          setVerifyResult(`Poll error: ${e.message}`);
        }
      }, 3000);
    } catch (e: any) {
      setVerifyResult(`Network error: ${e.message}`);
      setIsVerifying(false);
    }
  };

  const handleExportPDF = async () => {
    setIsExportingPdf(true);
    try {
      const res = await fetch('/api/backtest/export-data');
      if (!res.ok) throw new Error('Could not fetch export data.');
      const json = await res.json();
      const exp = json.data;
      const overviewHtml = (exp.pairs || []).map((p: any) => `
        <tr>
          <td><strong>${p.symbol}</strong></td>
          <td>${p.best_combination?.label || 'N/A'}</td>
          <td>${p.best_combination?.total_trades || 0}</td>
          <td>${formatNum(p.best_combination?.win_rate)}%</td>
          <td>${formatNum(p.best_combination?.profit_factor)}</td>
          <td>$${formatNum(p.best_combination?.net_pnl)}</td>
        </tr>
      `).join('');
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(`
          <html><head><title>Nexus Matrix Audit Report</title>
          <style>body{font-family:sans-serif;padding:30px;} table{width:100%;border-collapse:collapse;} th,td{padding:8px;border-bottom:1px solid #e2e8f0;}</style>
          </head><body>
          <h1>NEXUS MATRIX - SIX-COMBINATION REPORT</h1>
          <p>Run Date: ${exp.generated_at.slice(0, 10)} | Window: ${exp.days} Days</p>
          <h2>Portfolio Overview</h2>
          <table><thead><tr><th>Asset</th><th>Best Combination</th><th>Trades</th><th>Win Rate</th><th>PF</th><th>Net P&L</th></tr></thead><tbody>${overviewHtml}</tbody></table>
          <script>window.onload = function() { window.print(); };</script>
          </body></html>
        `);
        printWindow.document.close();
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

  const exportPairCount = reportFiles.filter(f => f.endsWith('_summary.json') && !f.startsWith('.')).length;

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
            Adaptive only. BE off/on × R:R 1:1, 1:2, 1:3.
          </p>
        </div>
      </motion.div>

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
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedSymbols([...WHITELIST_ASSETS])}
              className="text-[11px] font-mono font-bold px-2.5 py-1 rounded-lg bg-white dark:bg-[#08090d] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] hover:border-blue-400 cursor-pointer"
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setSelectedSymbols([])}
              className="text-[11px] font-mono font-bold px-2.5 py-1 rounded-lg bg-white dark:bg-[#08090d] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] hover:border-rose-400 cursor-pointer"
            >
              None
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 pt-1">
          {WHITELIST_ASSETS.map((sym) => {
            const checked = selectedSymbols.includes(sym);
            const focused = testSymbol === sym;
            return (
              <button
                key={sym}
                type="button"
                onClick={() => toggleSymbol(sym)}
                className={`px-3 py-2 rounded-xl text-xs font-mono font-bold transition-colors cursor-pointer border ${
                  checked
                    ? 'bg-blue-600/15 border-blue-500/40 text-blue-700 dark:text-blue-300'
                    : 'bg-slate-50 dark:bg-[#08090d] border-slate-300 dark:border-[#1a2030] text-slate-600 dark:text-slate-400 hover:border-slate-400'
                }`}
              >
                {sym}
                {focused && <span className="ml-1 text-[8px] opacity-60">•</span>}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 dark:border-[#1a2030]">
          <select value={testDays} onChange={(e) => setTestDays(parseInt(e.target.value, 10))} disabled={isRunning || labRunning} className="px-2.5 py-1.5 rounded-lg bg-transparent text-xs font-mono font-bold text-black dark:text-white cursor-pointer focus:outline-none border border-slate-300 dark:border-[#1a2030]">
            <option value={60}>60 Days</option>
            <option value={90}>90 Days</option>
            <option value={180}>180 Days</option>
            <option value={365}>365 Days</option>
          </select>

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
              <button
                type="button"
                onClick={handleRunStrategyLab}
                disabled={selectedSymbols.length === 0}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50"
              >
                <FlaskConical className="w-3.5 h-3.5" />
                <span>Strategy Lab</span>
              </button>
            </>
          ) : (
            <button type="button" onClick={handleStopBacktest} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-rose-600 hover:bg-rose-500 text-white">
              <Square className="w-3.5 h-3.5" />
              <span>Stop</span>
            </button>
          )}
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs"
      >
        <div className="flex items-center gap-2 text-[11px] font-mono text-slate-600 dark:text-slate-300">
          <FileText className="w-3.5 h-3.5 text-blue-500" />
          <span>Exporting <strong className="text-black dark:text-white">{exportPairCount}</strong> pair{exportPairCount === 1 ? '' : 's'}</span>
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
            <span>{isVerifying ? 'Verifying...' : 'Verify vs Reference (60 days)'}</span>
          </button>
        </div>
      </motion.div>

      {(isVerifying || verifyResult) && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-purple-500/40 shadow-xs space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-purple-500" />
              <span className="text-xs font-bold text-black dark:text-white">
                Verify vs Reference ({testSymbol} · 60 days)
              </span>
              {isVerifying && <RefreshCw className="w-3.5 h-3.5 text-purple-500 animate-spin" />}
            </div>
            <div className="flex items-center gap-2">
              {verifyResult && !isVerifying && (
                <button
                  type="button"
                  onClick={() => { navigator.clipboard.writeText(verifyResult); setVerifyCopyStatus('copied'); setTimeout(() => setVerifyCopyStatus('idle'), 2000); }}
                  className="px-3 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer"
                >
                  {verifyCopyStatus === 'copied' ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{verifyCopyStatus === 'copied' ? 'Copied' : 'Copy Result'}</span>
                </button>
              )}
              {!isVerifying && (
                <button type="button" onClick={() => { setVerifyResult(null); setVerifyProgress(''); }} className="text-xs text-slate-400 hover:text-black dark:hover:text-white cursor-pointer ml-1">Dismiss</button>
              )}
            </div>
          </div>
          {isVerifying && (
            <div className="text-xs text-slate-500 font-mono">{verifyProgress || 'Comparison running...'}</div>
          )}
          {verifyResult && (
            <textarea readOnly value={verifyResult} rows={20} onFocus={(e) => e.target.select()} className="w-full p-3.5 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-xs text-black dark:text-slate-200 focus:outline-none" />
          )}
        </div>
      )}

      {labRunning && (
        <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-xs">
          <div className="flex items-center gap-3">
            <FlaskConical className="w-4 h-4 text-amber-500 animate-pulse shrink-0" />
            <div>
              <div className="font-bold text-amber-700 dark:text-amber-400">Strategy Lab in Progress</div>
              <div className="text-slate-500 font-mono text-[11px] mt-0.5">{labProgress || 'Testing variants...'}</div>
            </div>
          </div>
        </div>
      )}

      {labError && (
        <div className="p-3 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-700 dark:text-rose-300 flex items-center justify-between">
          <span className="font-mono">Strategy Lab error: {labError}</span>
          <button type="button" onClick={() => setLabError(null)} className="text-xs text-slate-400 hover:text-rose-600 cursor-pointer">Dismiss</button>
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
              <button type="button" disabled={isCleaning || isRunning || labRunning} onClick={() => handleCleanup('symbol')} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#141722] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
                <Trash2 className="w-3 h-3 text-amber-500" /><span>Clear {testSymbol} reports</span>
              </button>
              <button type="button" disabled={isCleaning || isRunning || labRunning} onClick={() => handleCleanup('all_reports')} className="px-3 py-1.5 rounded-lg bg-rose-600/10 hover:bg-rose-600/20 text-rose-600 border border-rose-500/30 text-[11px] font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
                <Trash2 className="w-3 h-3 text-rose-500" /><span>Clear all</span>
              </button>
            </div>
          </div>
        </div>
      )}

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

      {summaryData?.combinations && summaryData.combinations.length > 0 && (
        <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5 space-y-3">
          <h3 className="text-sm font-bold text-black dark:text-white">
            Results by Combination ({summaryData.symbol} · {summaryData.days} Days)
          </h3>
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
                  <th className="py-2.5 px-3 text-center">Cov</th>
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
                    <tr key={idx} onClick={() => setSelectedFile(c.report_file)} className={`cursor-pointer transition-colors ${selectedFile === c.report_file ? 'bg-blue-500/15' : idx === bestComboIdx ? 'bg-amber-500/10' : 'hover:bg-slate-50 dark:hover:bg-[#121520]'}`}>
                      <td className="py-3 px-3 font-bold text-black dark:text-white">
                        {idx === bestComboIdx && <span className="text-amber-500 mr-1">★</span>}
                        {c.label}
                      </td>
                      <td className="py-3 px-3 text-center font-bold">{c.total_trades}</td>
                      <td className={`py-3 px-3 text-center font-bold ${c.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{c.win_rate}%</td>
                      <td className="py-3 px-3 text-center">{c.expectancy}R</td>
                      <td className="py-3 px-3 text-center">{c.profit_factor}</td>
                      <td className="py-3 px-3 text-right text-rose-500">-${c.max_drawdown}</td>
                      <td className={`py-3 px-3 text-right font-bold ${c.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${c.net_pnl}</td>
                      <td className="py-3 px-3 text-center text-blue-500">{c.adaptive_effective_pct}%</td>
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
        <button onClick={() => setActiveSubTab('summary')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'summary' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <TrendingUp className="w-3.5 h-3.5" /><span>Summary</span>
        </button>
        <button onClick={() => setActiveSubTab('diagnostics')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'diagnostics' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <Activity className="w-3.5 h-3.5" /><span>Diagnostics</span>
        </button>
        <button onClick={() => setActiveSubTab('portfolio')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'portfolio' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <Network className="w-3.5 h-3.5" /><span>Portfolio</span>
        </button>
        <button onClick={() => setActiveSubTab('lab')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'lab' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <FlaskConical className="w-3.5 h-3.5" /><span>Strategy Lab</span>
        </button>
        <button onClick={() => setActiveSubTab('tips')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'tips' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <Lightbulb className="w-3.5 h-3.5" /><span>Tips</span>
        </button>
        <button onClick={() => setActiveSubTab('ledger')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'ledger' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <FileText className="w-3.5 h-3.5" /><span>Ledger ({reportData?.all_trades?.length || 0})</span>
        </button>
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
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold">{String(h).padStart(2, '0')}</span>
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

          <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
            <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§38 Alpha <InfoTip metricKey="diag_buy_and_hold" /></h3>
            <div className="text-xs font-mono">
              <div>Strategy P&L: <span className={`font-bold ${(reportData.diagnostics.buy_and_hold.strategy_net_pnl ?? 0) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${reportData.diagnostics.buy_and_hold.strategy_net_pnl}</span></div>
              <div>Hold P&L: <span className="font-bold">${reportData.diagnostics.buy_and_hold.bh_net_pnl}</span></div>
              <div>Alpha: <span className={`font-bold ${(reportData.diagnostics.buy_and_hold.alpha ?? 0) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${reportData.diagnostics.buy_and_hold.alpha}</span></div>
              <div className="mt-2 text-[11px] text-slate-500">Verdict: {reportData.diagnostics.buy_and_hold.verdict}</div>
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
                        <td className="py-2.5 px-3 font-bold text-black dark:text-white">
                          {pt.slippage_pips === 0 ? 'Baseline' : `${pt.slippage_pips} pip${pt.slippage_pips > 1 ? 's' : ''}`}
                        </td>
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
                <button
                  type="button"
                  onClick={() => handleCopyLabForAI(testSymbol)}
                  className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer"
                >
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
                  <th className="py-3 px-3">Date</th><th className="py-3 px-3">Strategy</th><th className="py-3 px-3">Dir</th><th className="py-3 px-3">Entry</th><th className="py-3 px-3">Exit</th><th className="py-3 px-3">R</th><th className="py-3 px-3 text-right">Net P&L</th><th className="py-3 px-3">Result</th>
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