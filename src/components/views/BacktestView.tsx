import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'motion/react';
import { 
  createChart, 
  IChartApi, 
  ColorType, 
  LineStyle, 
  UTCTimestamp 
// @ts-ignore
} from 'lightweight-charts';
import { 
  Calendar, 
  TrendingUp, 
  RefreshCw, 
  FileText, 
  Play, 
  CheckCircle2, 
  AlertTriangle, 
  Lightbulb, 
  Trash2, 
  RotateCcw,
  Sparkles,
  Layers,
  Square,
  Copy,
  Check,
  Table,
  Database
} from 'lucide-react';
import { ThemeMode, BacktestReportPayload, BacktestKPIs, ImprovementTip } from '../../types';
import { formatCurrency } from '../../utils/currency';

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
  combinations: SummaryCombination[];
}

interface StorageInfo {
  total_mb: number;
  used_mb: number;
  free_mb: number;
  market_data_mb: number;
  reports_mb: number;
  largest_files?: Array<{ name: string; size_mb: number; type: string }>;
}

const WHITELIST_ASSETS = ["US30", "GOLD", "NAS100", "GERMAN30", "EURUSD", "GBPUSD", "USDJPY"];

function formatNum(val: any, decimals = 2): string {
  if (typeof val === 'number') {
    return isNaN(val) ? '0.00' : val.toFixed(decimals);
  }
  const parsed = parseFloat(val);
  return isNaN(parsed) ? '0.00' : parsed.toFixed(decimals);
}

function formatPriceBySymbol(price: any, symbol?: string): string {
  const num = parseFloat(price);
  if (isNaN(num)) return '--';
  const sym = (symbol || '').toUpperCase();
  if (sym.includes('EURUSD') || sym.includes('GBPUSD')) {
    return num.toFixed(5);
  }
  if (sym.includes('USDJPY')) {
    return num.toFixed(3);
  }
  return num.toFixed(2);
}

function prettifyReportName(filename: string): string {
  if (filename.includes('_summary.json')) {
    const sym = filename.replace('_summary.json', '');
    return `${sym} · 8-Combination Summary Matrix`;
  }
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

export const BacktestView: React.FC<BacktestViewProps> = ({
  themeMode = 'dark',
  brokerCurrency = 'USD'
}) => {
  const [reportFiles, setReportFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [reportData, setReportData] = useState<BacktestReportPayload | null>(null);
  const [summaryData, setSummaryData] = useState<SymbolSummaryPayload | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<'summary' | 'chart' | 'ledger' | 'tips'>('summary');
  const [selectedDay, setSelectedDay] = useState<string>('');

  // Runner Controls
  const [testSymbol, setTestSymbol] = useState<string>('US30');
  const [testDays, setTestDays] = useState<number>(60);
  const [testRr, setTestRr] = useState<number>(1.0);

  // Storage Stats
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [isCleaning, setIsCleaning] = useState<boolean>(false);

  // Execution & Status
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [progressText, setProgressText] = useState<string>('');
  const [runResults, setRunResults] = useState<Array<{ symbol: string; status: 'OK' | 'FAILED'; message: string }>>([]);

  // Copy for AI State
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [fallbackCopyText, setFallbackCopyText] = useState<string>('');

  // Table Filters
  const [strategyFilter, setStrategyFilter] = useState<string>('ALL');
  const [outcomeFilter, setOutcomeFilter] = useState<string>('ALL');
  const [tipFilter, setTipFilter] = useState<string>('ALL');

  const [dismissedTipIds, setDismissedTipIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('dismissed_improvement_tips');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);

  // 1. Storage Info Fetcher
  const fetchStorageInfo = useCallback(async () => {
    try {
      const res = await fetch('/api/backtest/storage');
      if (res.ok) {
        const json = await res.json();
        if (json.data) {
          setStorageInfo(json.data);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchStorageInfo();
  }, [fetchStorageInfo]);

  // 2. Initial status poll
  useEffect(() => {
    const checkInitialStatus = async () => {
      try {
        const res = await fetch('/api/backtest/status');
        if (res.ok) {
          const json = await res.json();
          if (json.isRunning) {
            setIsRunning(true);
            setProgressText(json.progress || 'Simulation in progress...');
          }
          if (Array.isArray(json.results) && json.results.length > 0) {
            setRunResults(json.results);
          }
        }
      } catch {}
    };
    checkInitialStatus();
  }, []);

  // 3. Fetch list of reports
  const fetchReportList = useCallback(async () => {
    try {
      const res = await fetch('/api/backtest/reports');
      if (res.ok) {
        const json = await res.json();
        if (json.reports && json.reports.length > 0) {
          setReportFiles(json.reports);
          setSelectedFile((prev) => (json.reports.includes(prev) ? prev : json.reports[0]));
        }
      }
    } catch (err) {
      console.warn('Could not fetch backtest report list:', err);
    }
  }, []);

  useEffect(() => {
    fetchReportList();
  }, [fetchReportList]);

  // 4. Load summary payload for current pair
  const fetchSummaryData = useCallback(async (sym: string) => {
    try {
      const res = await fetch(`/api/backtest/summary/${sym}`);
      if (res.ok) {
        const json = await res.json();
        if (json.data) {
          setSummaryData(json.data);
        }
      } else {
        setSummaryData(null);
      }
    } catch {
      setSummaryData(null);
    }
  }, []);

  useEffect(() => {
    fetchSummaryData(testSymbol);
  }, [testSymbol, fetchSummaryData]);

  // 5. Fetch selected individual report JSON
  useEffect(() => {
    if (!selectedFile) return;
    const loadReport = async () => {
      try {
        const res = await fetch(`/api/backtest/report/${encodeURIComponent(selectedFile)}`);
        if (res.ok) {
          const json = await res.json();
          if (json.data) {
            setReportData(json.data);
            if (json.data.trading_dates && json.data.trading_dates.length > 0) {
              setSelectedDay(json.data.trading_dates[0]);
            }
          }
        }
      } catch (err) {
        console.warn('Could not load report payload:', err);
      }
    };
    loadReport();
  }, [selectedFile]);

  // 6. Polling while running
  useEffect(() => {
    if (!isRunning) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/backtest/status');
        if (res.ok) {
          const json = await res.json();
          if (json.progress) {
            setProgressText(json.progress);
          }
          if (Array.isArray(json.results) && json.results.length > 0) {
            setRunResults(json.results);
          }
          if (!json.isRunning) {
            setIsRunning(false);
            await fetchReportList();
            await fetchSummaryData(testSymbol);
            await fetchStorageInfo();
          }
        }
      } catch (err) {
        console.warn('Status poll error:', err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [isRunning, fetchReportList, fetchSummaryData, fetchStorageInfo, testSymbol]);

  // 7. Cleanup Action
  const handleCleanup = async (scope: 'all_reports' | 'symbol') => {
    const sym = testSymbol;
    const confirmMsg = scope === 'all_reports'
      ? 'Clear ALL backtest reports, summaries, and day candles? (Market data CSVs will NOT be deleted)'
      : `Clear all backtest reports and summaries for ${sym}? (Market data CSVs will NOT be deleted)`;

    if (!window.confirm(confirmMsg)) return;

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
        if (scope === 'all_reports' || (scope === 'symbol' && selectedFile.startsWith(`${sym}_`))) {
          setSelectedFile('');
          setReportData(null);
        }
      }
    } catch (err) {
      console.warn('Storage cleanup error:', err);
    } finally {
      setIsCleaning(false);
    }
  };

  // 8. Trigger Run
  const handleRunBacktest = async (targetSym: string) => {
    if (isRunning) return;
    setIsRunning(true);
    setRunResults([]);
    setProgressText(`Preparing 8-combination matrix for ${targetSym}...`);

    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          symbol: targetSym, 
          days: testDays, 
          rr: testRr
        }),
      });

      if (!res.ok) {
        const errJson = await res.json();
        setRunResults([{ symbol: targetSym, status: 'FAILED', message: errJson.message || 'Run request failed' }]);
        setIsRunning(false);
      }
    } catch {
      setRunResults([{ symbol: targetSym, status: 'FAILED', message: 'Network error connecting to backtest server' }]);
      setIsRunning(false);
    }
  };

  const handleStopBacktest = async () => {
    try {
      await fetch('/api/backtest/stop', { method: 'POST' });
      setIsRunning(false);
      setProgressText('Backtest cancelled.');
      await fetchStorageInfo();
    } catch {}
  };

  // 9. Copy for AI Builder
  const handleCopyForAI = async () => {
    const lines: string[] = [];

    lines.push(`# BACKTEST REPORT FOR AI REVIEW`);
    lines.push(`Pair: ${testSymbol} | Days: ${testDays} | Target R:R: ${testRr}`);
    lines.push(`Generated: ${new Date().toUTCString()}`);
    lines.push(``);
    lines.push(`## All 8 Parameter Combinations Matrix`);

    if (summaryData && summaryData.combinations && summaryData.combinations.length > 0) {
      lines.push(`| Combination | Trades | Win Rate | Exp (R) | PF | Max DD | Net P&L | Adp Cov | Signals Fired | Vol Blocked | Filled |`);
      lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
      summaryData.combinations.forEach((c) => {
        const f = c.funnel || { raw_signals_fired: 0, vol_filters_blocked: 0, sim_trades_filled: 0 };
        lines.push(
          `| ${c.label} | ${c.total_trades} | ${formatNum(c.win_rate)}% | ${formatNum(c.expectancy)}R | ${formatNum(c.profit_factor)} | $${formatNum(c.max_drawdown)} | $${formatNum(c.net_pnl)} | ${formatNum(c.adaptive_effective_pct)}% | ${f.raw_signals_fired} | ${f.vol_filters_blocked} | ${f.sim_trades_filled} |`
        );
      });
    } else {
      lines.push(`*(No summary combinations loaded yet)*`);
    }

    lines.push(``);
    lines.push(`## Active Selected Report Details (${selectedFile || 'None'})`);

    if (reportData) {
      const g = reportData.global_kpis;
      lines.push(`- Total Trades: ${g?.count ?? 0}`);
      lines.push(`- Win Rate: ${formatNum(g?.win_rate)}%`);
      lines.push(`- Net P&L: $${formatNum(g?.net_pnl)}`);
      lines.push(`- Run Settings: ${(reportData as any).run_settings || 'N/A'}`);
      
      const reportWarnings = (reportData as any).warnings || [];
      lines.push(`- Warnings: ${reportWarnings.length > 0 ? reportWarnings.join(' | ') : 'None'}`);

      const skipped = (reportData as any).skipped_summary || {};
      lines.push(`- Skipped Reasons: ${JSON.stringify(skipped)}`);

      const funnelData = (reportData as any).funnel || {};
      lines.push(`- Funnel Metrics: ${JSON.stringify(funnelData)}`);
    } else {
      lines.push(`*(No individual report selected)*`);
    }

    lines.push(``);
    lines.push(`QUESTION: What are the 3 most credible weaknesses in this data, and what is the smallest change to test for each?`);

    const fullText = lines.join('\n');

    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(fullText);
        setCopyStatus('copied');
        setFallbackCopyText('');
        setTimeout(() => setCopyStatus('idle'), 2000);
      } else {
        setFallbackCopyText(fullText);
      }
    } catch {
      setFallbackCopyText(fullText);
    }
  };

  const handleDismissTip = (tipId: string) => {
    const updated = [...dismissedTipIds, tipId];
    setDismissedTipIds(updated);
    try {
      localStorage.setItem('dismissed_improvement_tips', JSON.stringify(updated));
    } catch {}
  };

  const handleResetDismissedTips = () => {
    setDismissedTipIds([]);
    try {
      localStorage.removeItem('dismissed_improvement_tips');
    } catch {}
  };

  // 10. Candlestick Chart Rendering
  useEffect(() => {
    if (activeSubTab !== 'chart' || !reportData || !selectedDay || !chartContainerRef.current) return;

    const container = chartContainerRef.current;
    container.innerHTML = '';

    const isLight = themeMode !== 'dark';
    const dayData = reportData.day_data?.[selectedDay];
    if (!dayData || !dayData.candles || dayData.candles.length === 0) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: 480,
      layout: {
        background: { type: ColorType.Solid, color: isLight ? '#ffffff' : '#07090e' },
        textColor: isLight ? '#334155' : '#94a3b8',
      },
      grid: {
        vertLines: { color: isLight ? '#f1f5f9' : '#141a26' },
        horzLines: { color: isLight ? '#f1f5f9' : '#141a26' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: isLight ? '#cbd5e1' : '#212838',
      },
      rightPriceScale: {
        borderColor: isLight ? '#cbd5e1' : '#212838',
      },
    });

    chartApiRef.current = chart;

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });

    const formattedCandles = dayData.candles.map((c) => ({
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    candleSeries.setData(formattedCandles);

    const lvls = dayData.levels || {};
    if (lvls.asia_high) {
      candleSeries.createPriceLine({ price: lvls.asia_high, color: '#3b82f6', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'ASIA HIGH' });
    }
    if (lvls.asia_low) {
      candleSeries.createPriceLine({ price: lvls.asia_low, color: '#3b82f6', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'ASIA LOW' });
    }
    if (lvls.daily_eq) {
      candleSeries.createPriceLine({ price: lvls.daily_eq, color: '#f59e0b', lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'DAILY EQ' });
    }
    if (lvls.pdh) {
      candleSeries.createPriceLine({ price: lvls.pdh, color: '#a855f7', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'PDH' });
    }
    if (lvls.pdl) {
      candleSeries.createPriceLine({ price: lvls.pdl, color: '#a855f7', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'PDL' });
    }

    if (dayData.trades && dayData.trades.length > 0) {
      const markers: any[] = [];
      dayData.trades.forEach((t) => {
        const openEpoch = Math.floor(new Date(t.signal_time_utc).getTime() / 1000);
        markers.push({
          time: openEpoch as UTCTimestamp,
          position: t.direction === 'BUY' ? 'belowBar' : 'aboveBar',
          color: t.direction === 'BUY' ? '#10b981' : '#ef4444',
          shape: t.direction === 'BUY' ? 'arrowUp' : 'arrowDown',
          text: `${t.direction} (${t.strategy})`,
        });
      });
      markers.sort((a, b) => (a.time as number) - (b.time as number));
      candleSeries.setMarkers(markers);
    }

    const handleResize = () => {
      if (chart && container) {
        chart.applyOptions({ width: container.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartApiRef.current = null;
    };
  }, [activeSubTab, reportData, selectedDay, themeMode]);

  const kpis: BacktestKPIs = reportData?.global_kpis || {
    count: 0,
    win_rate: 0,
    avg_r: 0,
    expectancy: 0,
    profit_factor: 0,
    max_dd_money: 0,
    avg_duration: 0,
    best_r: 0,
    worst_r: 0,
    net_pnl: 0,
    is_inconclusive: true,
  };

  const filteredTrades = (reportData?.all_trades || []).filter((tr) => {
    const matchStrat = strategyFilter === 'ALL' || tr.strategy === strategyFilter;
    const matchOutcome = outcomeFilter === 'ALL' || tr.result === outcomeFilter;
    return matchStrat && matchOutcome;
  });

  const rawTips: ImprovementTip[] = reportData?.improvement_tips || [];
  const activeTips = rawTips.filter((tip) => {
    const isDismissed = dismissedTipIds.includes(tip.id);
    const matchFilter = tipFilter === 'ALL' || tip.strategy === tipFilter || tip.category === tipFilter;
    return !isDismissed && matchFilter;
  });

  const skippedDetail = (reportData as any)?.skipped_detail || {};
  const funnel = (reportData as any)?.funnel;
  const warnings = (reportData as any)?.warnings || [];

  const bestComboIdx = summaryData?.combinations?.reduce((bestIdx, curr, currIdx, arr) => {
    if (curr.total_trades < 30) return bestIdx;
    if (bestIdx === -1) return currIdx;
    return curr.profit_factor > arr[bestIdx].profit_factor ? currIdx : bestIdx;
  }, -1) ?? -1;

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Top Header */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-300 dark:border-[#1a2030]"
      >
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
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 dark:bg-[#0f1118] p-1.5 rounded-xl border border-slate-300 dark:border-[#1a2030]">
            <select
              value={testSymbol}
              onChange={(e) => setTestSymbol(e.target.value)}
              disabled={isRunning}
              className="px-2.5 py-1.5 rounded-lg bg-transparent text-xs font-mono font-bold text-black dark:text-white cursor-pointer focus:outline-none"
            >
              {WHITELIST_ASSETS.map((sym) => (
                <option key={sym} value={sym}>{sym}</option>
              ))}
            </select>

            <select
              value={testDays}
              onChange={(e) => setTestDays(parseInt(e.target.value, 10))}
              disabled={isRunning}
              className="px-2.5 py-1.5 rounded-lg bg-transparent text-xs font-mono font-bold text-black dark:text-white cursor-pointer focus:outline-none"
            >
              <option value={60}>60 Days</option>
              <option value={90}>90 Days</option>
              <option value={180}>180 Days</option>
              <option value={365}>365 Days</option>
            </select>

            <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
              <span className="text-[10px] font-bold text-slate-500">R:R</span>
              <input
                type="number"
                step="0.1"
                min="0.5"
                max="5.0"
                value={testRr}
                onChange={(e) => setTestRr(parseFloat(e.target.value) || 1.0)}
                disabled={isRunning}
                className="w-12 text-xs font-mono font-bold text-center bg-transparent text-black dark:text-white focus:outline-none"
              />
            </div>

            {!isRunning ? (
              <>
                <button
                  type="button"
                  onClick={() => handleRunBacktest(testSymbol)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-emerald-600 hover:bg-emerald-500 text-white"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Run {testSymbol}</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleRunBacktest('ALL')}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-blue-600 hover:bg-blue-500 text-white"
                  title="Runs 8-combination matrix across all whitelist pairs"
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>Run All</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleStopBacktest}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-rose-600 hover:bg-rose-500 text-white"
              >
                <Square className="w-3.5 h-3.5" />
                <span>Stop</span>
              </button>
            )}
          </div>

          <div className="h-6 w-px bg-slate-300 dark:border-[#1a2030] hidden sm:block" />

          {/* Report Viewer & Copy for AI */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-500">Report:</span>
            <select
              value={selectedFile}
              onChange={(e) => setSelectedFile(e.target.value)}
              disabled={isRunning}
              className="px-3 py-2 rounded-xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-xs font-mono font-bold text-blue-600 dark:text-blue-400 cursor-pointer max-w-xs truncate"
            >
              {reportFiles.length === 0 ? (
                <option value="">No reports found</option>
              ) : (
                reportFiles.map((f) => (
                  <option key={f} value={f}>{prettifyReportName(f)}</option>
                ))
              )}
            </select>

            <button
              type="button"
              onClick={handleCopyForAI}
              className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-[#0f1118] dark:hover:bg-[#141722] border border-slate-300 dark:border-[#1a2030] text-xs font-semibold text-black dark:text-slate-200 flex items-center gap-1.5 cursor-pointer shadow-xs transition-colors shrink-0"
              title="Copy markdown summary of all combinations and funnel for AI review"
            >
              {copyStatus === 'copied' ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="text-emerald-500 font-bold">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-blue-500" />
                  <span>Copy for AI</span>
                </>
              )}
            </button>
          </div>
        </div>
      </motion.div>

      {/* STORAGE STRIP */}
      {storageInfo && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <Database className="w-4 h-4 text-blue-500 shrink-0" />
              <span className="font-bold text-black dark:text-white">Storage Volume:</span>
              <span className="font-mono text-slate-600 dark:text-slate-300">
                {storageInfo.used_mb} MB used / {storageInfo.free_mb} MB free (Total: {storageInfo.total_mb} MB)
              </span>
              <span className="text-slate-400 hidden sm:inline">|</span>
              <span className="font-mono text-[11px] text-slate-500">
                Reports: <strong className="text-blue-500">{storageInfo.reports_mb} MB</strong> • Market Data: <strong className="text-emerald-500">{storageInfo.market_data_mb} MB</strong>
              </span>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={isCleaning || isRunning}
                onClick={() => handleCleanup('symbol')}
                className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#141722] dark:hover:bg-[#1c2130] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-colors"
              >
                <Trash2 className="w-3 h-3 text-amber-500" />
                <span>Clear {testSymbol} reports</span>
              </button>

              <button
                type="button"
                disabled={isCleaning || isRunning}
                onClick={() => handleCleanup('all_reports')}
                className="px-3 py-1.5 rounded-lg bg-rose-600/10 hover:bg-rose-600/20 text-rose-600 dark:text-rose-400 border border-rose-500/30 text-[11px] font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-colors"
              >
                <Trash2 className="w-3 h-3 text-rose-500" />
                <span>Clear all reports</span>
              </button>
            </div>
          </div>

          {/* Volume progress bar (turns red when used capacity exceeds 85%) */}
          {(() => {
            const usedPct = storageInfo.total_mb > 0 
              ? Math.min(100, Math.round((storageInfo.used_mb / storageInfo.total_mb) * 100)) 
              : 0;
            const isHighUsage = usedPct >= 85;

            return (
              <div className="w-full bg-slate-100 dark:bg-[#08090d] rounded-full h-2 overflow-hidden border border-slate-200 dark:border-[#1a2030]">
                <div 
                  className={`h-full rounded-full transition-all duration-500 ${
                    isHighUsage ? 'bg-rose-500' : 'bg-blue-600'
                  }`} 
                  style={{ width: `${usedPct}%` }}
                />
              </div>
            );
          })()}
        </div>
      )}

      {/* Per-Symbol Results Box (Wrapped Error Output) */}
      {runResults.length > 0 && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs space-y-2 animate-in fade-in">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-black dark:text-white">Backtest Run Results</span>
            <button
              onClick={() => setRunResults([])}
              className="text-xs text-slate-400 hover:text-black dark:hover:text-white cursor-pointer"
            >
              Dismiss
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 pt-1">
            {runResults.map((r, i) => (
              <div key={i} className={`p-3 rounded-xl border flex flex-col sm:flex-row sm:items-start justify-between gap-2 text-xs font-mono ${
                r.status === 'OK'
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-600'
              }`}>
                <span className="font-bold shrink-0">{r.symbol}</span>
                <span className="text-[11px] break-words whitespace-pre-wrap flex-1">{r.status}: {r.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fallback Textarea if Clipboard is Blocked */}
      {fallbackCopyText && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-amber-500/40 shadow-xs space-y-2 animate-in fade-in">
          <div className="flex items-center justify-between text-xs font-bold text-amber-600 dark:text-amber-400">
            <span>Clipboard write blocked. Select all and copy below:</span>
            <button
              type="button"
              onClick={() => setFallbackCopyText('')}
              className="text-slate-400 hover:text-black dark:hover:text-white cursor-pointer text-xs"
            >
              Dismiss
            </button>
          </div>
          <textarea
            readOnly
            value={fallbackCopyText}
            rows={10}
            onFocus={(e) => e.target.select()}
            className="w-full p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-xs text-black dark:text-slate-200 focus:outline-none"
          />
        </div>
      )}

      {/* Live Running Banner */}
      {isRunning && (
        <div className="p-4 rounded-2xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-between text-xs animate-in fade-in">
          <div className="flex items-center gap-3">
            <RefreshCw className="w-4 h-4 text-blue-500 animate-spin shrink-0" />
            <div>
              <div className="font-bold text-blue-600 dark:text-blue-400">Simulation in Progress</div>
              <div className="text-slate-500 font-mono text-[11px] mt-0.5">{progressText || 'Stepping through historical candles...'}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleStopBacktest}
            className="px-3 py-1.5 rounded-lg text-[11px] font-bold font-mono bg-rose-600 hover:bg-rose-500 text-white transition-colors cursor-pointer"
          >
            Cancel Run
          </button>
        </div>
      )}

      {/* RESULTS BY COMBINATION MATRIX TABLE */}
      {summaryData && summaryData.combinations && summaryData.combinations.length > 0 && (
        <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Table className="w-4 h-4 text-blue-500" />
              <h3 className="text-sm font-bold text-black dark:text-white">
                Results by Combination ({summaryData.symbol} · {summaryData.days} Days · R:R {summaryData.target_rr})
              </h3>
            </div>
            <span className="text-[11px] text-slate-500 font-mono">
              Click any row to view its detailed report
            </span>
          </div>

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
                  <th className="py-2.5 px-3 text-center">Adp Cov</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                {summaryData.combinations.map((c, idx) => {
                  const isBest = idx === bestComboIdx;
                  const isSelected = selectedFile === c.report_file;

                  return (
                    <tr
                      key={idx}
                      onClick={() => setSelectedFile(c.report_file)}
                      className={`cursor-pointer transition-colors ${
                        isSelected 
                          ? 'bg-blue-500/15 dark:bg-blue-500/20' 
                          : isBest 
                          ? 'bg-amber-500/10 dark:bg-amber-500/15 hover:bg-amber-500/20' 
                          : 'hover:bg-slate-50 dark:hover:bg-[#121520]'
                      }`}
                    >
                      <td className="py-3 px-3 font-bold text-black dark:text-white flex items-center gap-2">
                        {isBest && <span className="text-amber-500" title="Best PF with ≥ 30 trades">★</span>}
                        <span>{c.label}</span>
                      </td>
                      <td className="py-3 px-3 text-center font-bold">{c.total_trades}</td>
                      <td className={`py-3 px-3 text-center font-bold ${c.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {c.win_rate}%
                      </td>
                      <td className="py-3 px-3 text-center">{c.expectancy}R</td>
                      <td className="py-3 px-3 text-center">{c.profit_factor}</td>
                      <td className="py-3 px-3 text-right text-rose-500">-${c.max_drawdown}</td>
                      <td className={`py-3 px-3 text-right font-bold ${c.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        ${c.net_pnl}
                      </td>
                      <td className="py-3 px-3 text-center text-blue-500">{c.adaptive_effective_pct}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* DIAGNOSTIC FUNNEL & WARNINGS STRIP */}
      {reportData && (
        <div className="p-4 rounded-2xl bg-slate-100 dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] space-y-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-bold text-slate-500">Active Report:</span>
              <span className="font-mono font-bold text-black dark:text-white">{prettifyReportName(selectedFile)}</span>
              <span className="font-mono text-blue-600 dark:text-blue-400">
                (Adaptive Coverage: {(reportData as any).adaptive_effective_pct ?? 100}%)
              </span>
            </div>
            {warnings.length > 0 && (
              <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 font-semibold text-[11px]">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>{warnings.join(' | ')}</span>
              </div>
            )}
          </div>

          {/* Signal Generation Funnel */}
          {funnel && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 border-t border-slate-200 dark:border-[#1a2030] text-center font-mono">
              <div className="p-2 rounded-lg bg-white dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                <div className="text-[10px] text-slate-400 uppercase">Signals Fired</div>
                <div className="text-sm font-bold text-black dark:text-white mt-0.5">{funnel.raw_signals_fired}</div>
              </div>
              <div className="p-2 rounded-lg bg-white dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                <div className="text-[10px] text-slate-400 uppercase">Passed Clamping</div>
                <div className="text-sm font-bold text-blue-500 mt-0.5">{funnel.adapted_signals_passed}</div>
              </div>
              <div className="p-2 rounded-lg bg-white dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                <div className="text-[10px] text-slate-400 uppercase">Vol / Room Blocked</div>
                <div className="text-sm font-bold text-rose-500 mt-0.5">{funnel.vol_filters_blocked}</div>
              </div>
              <div className="p-2 rounded-lg bg-white dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                <div className="text-[10px] text-slate-400 uppercase">Attempted Fills</div>
                <div className="text-sm font-bold text-amber-500 mt-0.5">{funnel.sim_trades_attempted}</div>
              </div>
              <div className="p-2 rounded-lg bg-white dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                <div className="text-[10px] text-slate-400 uppercase">Filled Trades</div>
                <div className="text-sm font-bold text-emerald-500 mt-0.5">{funnel.sim_trades_filled}</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Navigation Sub-Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-[#1a2030] pb-2">
        <button
          onClick={() => setActiveSubTab('summary')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${
            activeSubTab === 'summary' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-500 hover:text-black dark:hover:text-white'
          }`}
        >
          <TrendingUp className="w-3.5 h-3.5" />
          <span>Summary Dashboard</span>
        </button>

        <button
          onClick={() => setActiveSubTab('tips')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 relative ${
            activeSubTab === 'tips' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-500 hover:text-black dark:hover:text-white'
          }`}
        >
          <Lightbulb className="w-3.5 h-3.5 text-amber-400" />
          <span>Actionable Improvement Tips</span>
          {activeTips.length > 0 && (
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold bg-amber-500 text-black">
              {activeTips.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveSubTab('chart')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${
            activeSubTab === 'chart' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-500 hover:text-black dark:hover:text-white'
          }`}
        >
          <Calendar className="w-3.5 h-3.5" />
          <span>Day Chart Inspector</span>
        </button>

        <button
          onClick={() => setActiveSubTab('ledger')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${
            activeSubTab === 'ledger' ? 'bg-blue-600 text-white shadow-xs' : 'text-slate-500 hover:text-black dark:hover:text-white'
          }`}
        >
          <FileText className="w-3.5 h-3.5" />
          <span>Full Trade Ledger ({reportData?.all_trades?.length || 0})</span>
        </button>
      </div>

      {/* SUB-TAB 1: SUMMARY DASHBOARD */}
      {activeSubTab === 'summary' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500">Total Trades</div>
              <div className="text-2xl font-bold font-mono text-blue-600 dark:text-blue-400 mt-1">{kpis.count}</div>
              <div className="mt-1">
                {kpis.is_inconclusive ? (
                  <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-amber-500/15 text-amber-500 border border-amber-500/30">
                    INCONCLUSIVE (&lt;30)
                  </span>
                ) : (
                  <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-emerald-500/15 text-emerald-500 border border-emerald-500/30">
                    SAMPLE VALID
                  </span>
                )}
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500">Win Rate</div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.win_rate >= 50 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600'}`}>
                {kpis.win_rate}%
              </div>
              <div className="text-[10px] text-slate-500 mt-1">Accuracy</div>
            </div>

            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500">Expectancy</div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.expectancy > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600'}`}>
                {kpis.expectancy}R
              </div>
              <div className="text-[10px] text-slate-500 mt-1">Per trade edge</div>
            </div>

            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500">Profit Factor</div>
              <div className="text-2xl font-bold font-mono text-black dark:text-white mt-1">{kpis.profit_factor}</div>
              <div className="text-[10px] text-slate-500 mt-1">Gross Win / Loss</div>
            </div>

            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500">Max Drawdown</div>
              <div className="text-2xl font-bold font-mono text-rose-600 mt-1">-${kpis.max_dd_money}</div>
              <div className="text-[10px] text-slate-500 mt-1">Peak-to-valley</div>
            </div>

            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500">Net Realized P&L</div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.net_pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600'}`}>
                {formatCurrency(kpis.net_pnl, brokerCurrency)}
              </div>
              <div className="text-[10px] text-slate-500 mt-1">Simulated Net</div>
            </div>
          </div>

          {/* Strategy Performance */}
          <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
            <h3 className="text-sm font-bold text-black dark:text-white mb-3">Performance by Strategy</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                    <th className="py-2.5 px-3">Strategy Name</th>
                    <th className="py-2.5 px-3 text-center">Trades</th>
                    <th className="py-2.5 px-3 text-center">Win Rate</th>
                    <th className="py-2.5 px-3 text-center">Avg R</th>
                    <th className="py-2.5 px-3 text-center">Expectancy</th>
                    <th className="py-2.5 px-3 text-center">Profit Factor</th>
                    <th className="py-2.5 px-3 text-right">Net P&L</th>
                    <th className="py-2.5 px-3 text-center">Audit Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                  {Object.entries(reportData?.strategy_kpis || {}).map(([sName, sKpi]) => (
                    <tr key={sName} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                      <td className="py-3 px-3 font-bold text-black dark:text-white">{sName}</td>
                      <td className="py-3 px-3 text-center font-bold">{sKpi.count}</td>
                      <td className={`py-3 px-3 text-center font-bold ${sKpi.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {sKpi.win_rate}%
                      </td>
                      <td className="py-3 px-3 text-center">{sKpi.avg_r}R</td>
                      <td className="py-3 px-3 text-center">{sKpi.expectancy}R</td>
                      <td className="py-3 px-3 text-center">{sKpi.profit_factor}</td>
                      <td className={`py-3 px-3 text-right font-bold ${sKpi.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        ${sKpi.net_pnl}
                      </td>
                      <td className="py-3 px-3 text-center">
                        {sKpi.is_inconclusive ? (
                          <span className="text-[9px] px-2 py-0.5 rounded font-mono font-bold bg-amber-500/15 text-amber-500 border border-amber-500/30">
                            INCONCLUSIVE (&lt;30)
                          </span>
                        ) : (
                          <span className="text-[9px] px-2 py-0.5 rounded font-mono font-bold bg-emerald-500/15 text-emerald-500 border border-emerald-500/30">
                            VALID
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Weekday Performance */}
          <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
            <h3 className="text-sm font-bold text-black dark:text-white mb-3">Performance by Day of Week</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                    <th className="py-2.5 px-3">Weekday</th>
                    <th className="py-2.5 px-3 text-center">Trades</th>
                    <th className="py-2.5 px-3 text-center">Win Rate</th>
                    <th className="py-2.5 px-3 text-center">Avg R</th>
                    <th className="py-2.5 px-3 text-center">Expectancy</th>
                    <th className="py-2.5 px-3 text-right">Net P&L</th>
                    <th className="py-2.5 px-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                  {Object.entries(reportData?.dow_kpis || {}).map(([dow, k]) => (
                    <tr key={dow} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                      <td className="py-3 px-3 font-bold text-black dark:text-white">{dow}</td>
                      <td className="py-3 px-3 text-center font-bold">{k.count}</td>
                      <td className={`py-3 px-3 text-center font-bold ${k.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {k.win_rate}%
                      </td>
                      <td className="py-3 px-3 text-center">{k.avg_r}R</td>
                      <td className="py-3 px-3 text-center">{k.expectancy}R</td>
                      <td className={`py-3 px-3 text-right font-bold ${k.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        ${k.net_pnl}
                      </td>
                      <td className="py-3 px-3 text-center">
                        {k.is_inconclusive ? (
                          <span className="text-[9px] px-2 py-0.5 rounded font-mono font-bold bg-amber-500/15 text-amber-500 border border-amber-500/30">
                            INCONCLUSIVE (&lt;30)
                          </span>
                        ) : (
                          <span className="text-[9px] px-2 py-0.5 rounded font-mono font-bold bg-emerald-500/15 text-emerald-500 border border-emerald-500/30">
                            VALID
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Skipped Detail */}
          {skippedDetail && (skippedDetail.by_reason || Object.keys(skippedDetail).length > 0) && (
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5 space-y-4">
              <h3 className="text-sm font-bold text-black dark:text-white">Skipped Signals Summary</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-mono">
                <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030] space-y-2">
                  <div className="text-[10px] font-bold text-slate-500 uppercase">By Skip Reason</div>
                  <div className="space-y-1">
                    {Object.entries(skippedDetail.by_reason || {}).map(([r, count]: any) => (
                      <div key={r} className="flex justify-between">
                        <span className="text-slate-600 dark:text-slate-300">{r}</span>
                        <span className="font-bold text-black dark:text-white">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030] space-y-2">
                  <div className="text-[10px] font-bold text-slate-500 uppercase">By Strategy</div>
                  <div className="space-y-1">
                    {Object.entries(skippedDetail.by_strategy || {}).map(([s, count]: any) => (
                      <div key={s} className="flex justify-between">
                        <span className="text-slate-600 dark:text-slate-300">{s}</span>
                        <span className="font-bold text-black dark:text-white">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030] space-y-2">
                  <div className="text-[10px] font-bold text-slate-500 uppercase">By Hour (SAST)</div>
                  <div className="space-y-1 max-h-36 overflow-y-auto">
                    {Object.entries(skippedDetail.by_hour_sast || {}).map(([h, count]: any) => (
                      <div key={h} className="flex justify-between">
                        <span className="text-slate-600 dark:text-slate-300">{String(h).padStart(2, '0')}:00 SAST</span>
                        <span className="font-bold text-black dark:text-white">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SUB-TAB 2: ACTIONABLE IMPROVEMENT TIPS */}
      {activeSubTab === 'tips' && (
        <div className="space-y-4">
          <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-3">
              <label className="font-bold text-slate-500">Filter Strategy:</label>
              <select
                value={tipFilter}
                onChange={(e) => setTipFilter(e.target.value)}
                className="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-black dark:text-white cursor-pointer"
              >
                <option value="ALL">All Tips</option>
                {Array.from(new Set(rawTips.map((t) => t.strategy))).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-3">
              {dismissedTipIds.length > 0 && (
                <button
                  type="button"
                  onClick={handleResetDismissedTips}
                  className="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] text-slate-600 dark:text-slate-300 hover:text-black dark:hover:text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Restore Dismissed Tips ({dismissedTipIds.length})</span>
                </button>
              )}
              <span className="font-mono text-slate-500 text-xs">
                Showing {activeTips.length} active insights
              </span>
            </div>
          </div>

          {activeTips.length === 0 ? (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center space-y-3">
              <Sparkles className="w-8 h-8 text-amber-400 mx-auto" />
              <div className="text-sm font-bold text-black dark:text-white">
                No tip rules triggered (sample too small or no pattern above thresholds)
              </div>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                No active recommendations pending.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {activeTips.map((tip) => {
                const isHigh = tip.severity === 'HIGH';
                const isMed = tip.severity === 'MEDIUM';

                return (
                  <div
                    key={tip.id}
                    className={`p-5 rounded-2xl border bg-white dark:bg-[#0f1118] shadow-xs flex flex-col justify-between space-y-4 ${
                      isHigh
                        ? 'border-rose-500/30 dark:border-rose-500/30'
                        : isMed
                        ? 'border-amber-500/30 dark:border-amber-500/30'
                        : 'border-blue-500/30 dark:border-blue-500/30'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-100 dark:border-[#1a2030]">
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded text-[9px] font-mono font-bold ${
                            isHigh
                              ? 'bg-rose-500/15 text-rose-600 border border-rose-500/30'
                              : isMed
                              ? 'bg-amber-500/15 text-amber-600 border border-amber-500/30'
                              : 'bg-blue-500/15 text-blue-600 border border-blue-500/30'
                          }`}>
                            {tip.severity} PRIORITY
                          </span>
                          <span className="px-2 py-0.5 rounded text-[9px] font-mono font-bold bg-slate-100 dark:bg-[#08090d] text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-[#1a2030]">
                            {tip.strategy}
                          </span>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleDismissTip(tip.id)}
                          className="p-1 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-500/10 transition-colors cursor-pointer"
                          title="Dismiss this tip"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <h4 className="text-sm font-bold text-black dark:text-white mt-3">
                        {tip.title}
                      </h4>
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-2 leading-relaxed">
                        {tip.description}
                      </p>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030] text-xs">
                      <div className="font-bold text-blue-600 dark:text-blue-400 text-[11px] mb-1 flex items-center gap-1.5">
                        <Lightbulb className="w-3.5 h-3.5" /> Recommended Tweak:
                      </div>
                      <div className="text-slate-700 dark:text-slate-300 text-[11px] leading-relaxed">
                        {tip.action}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* SUB-TAB 3: DAY CHART INSPECTOR */}
      {activeSubTab === 'chart' && (
        <div className="space-y-4">
          <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2">
              <label className="font-bold text-slate-500">Select Trading Day:</label>
              <select
                value={selectedDay}
                onChange={(e) => setSelectedDay(e.target.value)}
                className="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono font-bold text-blue-600 dark:text-blue-400 cursor-pointer"
              >
                {(reportData?.trading_dates || []).map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-3 text-[11px] font-mono text-slate-500">
              <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-blue-500 inline-block" /> Asia H/L</span>
              <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-amber-500 inline-block" /> Daily EQ</span>
              <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-purple-500 inline-block" /> PDH/PDL</span>
              <span className="text-emerald-500 font-bold">▲ Buy Entry</span>
              <span className="text-rose-500 font-bold">▼ Sell Entry</span>
            </div>
          </div>

          <div 
            ref={chartContainerRef} 
            className="w-full h-[480px] rounded-2xl bg-white dark:bg-[#07090e] border border-slate-300 dark:border-[#1a2030] overflow-hidden"
          />

          <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
            <h4 className="text-xs font-bold text-black dark:text-white uppercase mb-3">
              Trades for {selectedDay} ({reportData?.day_data?.[selectedDay]?.trades?.length || 0} trades)
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                    <th className="py-2 px-3">Strategy</th>
                    <th className="py-2 px-3 text-center">Dir</th>
                    <th className="py-2 px-3">Lots</th>
                    <th className="py-2 px-3">Entry</th>
                    <th className="py-2 px-3">Exit</th>
                    <th className="py-2 px-3 text-center">R</th>
                    <th className="py-2 px-3 text-right">P&L</th>
                    <th className="py-2 px-3">Exit Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                  {(reportData?.day_data?.[selectedDay]?.trades || []).map((t: any, idx: number) => (
                    <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                      <td className="py-2.5 px-3 font-bold text-black dark:text-white">{t.strategy}</td>
                      <td className={`py-2.5 px-3 text-center font-bold ${t.direction === 'BUY' ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {t.direction}
                      </td>
                      <td className="py-2.5 px-3">{t.lots}</td>
                      <td className="py-2.5 px-3">{formatPriceBySymbol(t.entry_price, t.symbol)}</td>
                      <td className="py-2.5 px-3">{formatPriceBySymbol(t.exit_price, t.symbol)}</td>
                      <td className={`py-2.5 px-3 text-center font-bold ${t.r_multiple > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {t.r_multiple}R
                      </td>
                      <td className={`py-2.5 px-3 text-right font-bold ${t.money_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        ${t.money_pnl}
                      </td>
                      <td className="py-2.5 px-3 text-slate-400">{t.exit_reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 4: FULL TRADE LEDGER */}
      {activeSubTab === 'ledger' && (
        <div className="space-y-4">
          <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-3">
              <label className="font-bold text-slate-500">Filter Strategy:</label>
              <select
                value={strategyFilter}
                onChange={(e) => setStrategyFilter(e.target.value)}
                className="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-black dark:text-white cursor-pointer"
              >
                <option value="ALL">All Strategies</option>
                {Object.keys(reportData?.strategy_kpis || {}).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>

              <label className="font-bold text-slate-500">Outcome:</label>
              <select
                value={outcomeFilter}
                onChange={(e) => setOutcomeFilter(e.target.value)}
                className="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-black dark:text-white cursor-pointer"
              >
                <option value="ALL">All Outcomes</option>
                <option value="WIN">Wins Only</option>
                <option value="LOSS">Losses Only</option>
                <option value="BREAKEVEN">Breakeven Only</option>
              </select>
            </div>

            <span className="font-mono text-slate-500 text-xs">Showing {filteredTrades.length} trades</span>
          </div>

          <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500 bg-slate-50 dark:bg-[#08090d]/50">
                    <th className="py-3 px-3">Date (SAST)</th>
                    <th className="py-3 px-3">Strategy</th>
                    <th className="py-3 px-3 text-center">Dir</th>
                    <th className="py-3 px-3">Lots</th>
                    <th className="py-3 px-3">Entry</th>
                    <th className="py-3 px-3">SL</th>
                    <th className="py-3 px-3">TP</th>
                    <th className="py-3 px-3">Exit Time</th>
                    <th className="py-3 px-3">Exit Reason</th>
                    <th className="py-3 px-3 text-center">R</th>
                    <th className="py-3 px-3 text-right">Net P&L</th>
                    <th className="py-3 px-3 text-center">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                  {filteredTrades.map((t: any, idx: number) => (
                    <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                      <td className="py-2.5 px-3 text-slate-400">{t.date_sast || t.date}</td>
                      <td className="py-2.5 px-3 font-bold text-black dark:text-white">{t.strategy}</td>
                      <td className={`py-2.5 px-3 text-center font-bold ${t.direction === 'BUY' ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {t.direction}
                      </td>
                      <td className="py-2.5 px-3">{t.lots}</td>
                      <td className="py-2.5 px-3">{formatPriceBySymbol(t.entry_price, t.symbol)}</td>
                      <td className="py-2.5 px-3 text-rose-500">{formatPriceBySymbol(t.sl, t.symbol)}</td>
                      <td className="py-2.5 px-3 text-emerald-500">{formatPriceBySymbol(t.tp, t.symbol)}</td>
                      <td className="py-2.5 px-3 text-slate-400">{t.exit_time}</td>
                      <td className="py-2.5 px-3 text-slate-400">{t.exit_reason}</td>
                      <td className={`py-2.5 px-3 text-center font-bold ${t.r_multiple > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {t.r_multiple}R
                      </td>
                      <td className={`py-2.5 px-3 text-right font-bold ${t.money_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        ${t.money_pnl}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        <span className={`text-[9px] px-2 py-0.5 rounded font-mono font-bold ${
                          t.result === 'WIN' 
                            ? 'bg-emerald-500/15 text-emerald-500 border border-emerald-500/30' 
                            : 'bg-rose-500/15 text-rose-500 border border-rose-500/30'
                        }`}>
                          {t.result}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};