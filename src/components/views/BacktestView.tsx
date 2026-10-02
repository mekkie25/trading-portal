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
  Check
} from 'lucide-react';
import { ThemeMode, BacktestReportPayload, BacktestKPIs, ImprovementTip } from '../../types';
import { formatCurrency } from '../../utils/currency';

interface BacktestViewProps {
  themeMode?: ThemeMode;
  brokerCurrency?: string;
}

const WHITELIST_ASSETS = ["US30", "GOLD", "NAS100", "GERMAN30", "EURUSD", "GBPUSD", "USDJPY"];

function formatNum(val: any, decimals = 2): string {
  if (typeof val === 'number') {
    return isNaN(val) ? '0.00' : val.toFixed(decimals);
  }
  const parsed = parseFloat(val);
  return isNaN(parsed) ? '0.00' : parsed.toFixed(decimals);
}

function buildReportMarkdown(r: BacktestReportPayload): string {
  const sections: string[] = [];

  // 1. Header & Instructions
  sections.push(
    `# BACKTEST REPORT FOR AI REVIEW\n` +
    `You are reviewing results from a rules-based trading bot backtest. Be honest and skeptical. ` +
    `Treat any group with fewer than 30 trades as inconclusive. Spreads are estimated. ` +
    `Do not recommend changes based on tiny samples. Rank suggestions by confidence, ` +
    `say what extra data would confirm each one, and give changes as small testable steps.`
  );

  // 2. Settings
  const settingsList: string[] = [];
  if (r.symbol) settingsList.push(`- Symbol: ${r.symbol}`);
  if (r.mode) settingsList.push(`- Mode: ${r.mode}`);
  if ((r as any).generated_at) settingsList.push(`- Generated At: ${(r as any).generated_at}`);
  if ((r as any).run_settings) settingsList.push(`- Run Settings: ${(r as any).run_settings}`);
  if (settingsList.length > 0) {
    sections.push(`## Settings\n${settingsList.join('\n')}`);
  }

  // 3. Overall stats from global_kpis
  if (r.global_kpis) {
    const g = r.global_kpis;
    sections.push(
      `## Overall Stats\n` +
      `- Trades: ${g.count ?? 0}\n` +
      `- Win Rate: ${formatNum(g.win_rate)}%\n` +
      `- Expectancy: ${formatNum(g.expectancy)}R\n` +
      `- Avg R: ${formatNum(g.avg_r)}R\n` +
      `- Profit Factor: ${formatNum(g.profit_factor)}\n` +
      `- Max Drawdown: $${formatNum(g.max_dd_money)}\n` +
      `- Net Realized P&L: $${formatNum(g.net_pnl)}\n` +
      `- Sample Status: ${g.is_inconclusive ? 'INCONCLUSIVE (<30 trades)' : 'VALID'}`
    );
  }

  // 4. Table of strategy_kpis
  if (r.strategy_kpis && Object.keys(r.strategy_kpis).length > 0) {
    const rows = Object.entries(r.strategy_kpis).map(([strat, k]) => {
      const inconcl = k.is_inconclusive ? 'Yes' : 'No';
      return `| ${strat} | ${k.count ?? 0} | ${formatNum(k.win_rate)}% | ${formatNum(k.expectancy)}R | ${formatNum(k.profit_factor)} | $${formatNum(k.net_pnl)} | ${inconcl} |`;
    });
    sections.push(
      `## Strategy Performance\n` +
      `| Strategy | Trades | Win Rate | Expectancy | Profit Factor | Net P&L | Inconclusive |\n` +
      `| --- | --- | --- | --- | --- | --- | --- |\n` +
      rows.join('\n')
    );
  }

  // 5. Table of dow_kpis
  if (r.dow_kpis && Object.keys(r.dow_kpis).length > 0) {
    const rows = Object.entries(r.dow_kpis).map(([dow, k]) => {
      const inconcl = k.is_inconclusive ? 'Yes' : 'No';
      return `| ${dow} | ${k.count ?? 0} | ${formatNum(k.win_rate)}% | ${formatNum(k.expectancy)}R | ${formatNum(k.profit_factor)} | $${formatNum(k.net_pnl)} | ${inconcl} |`;
    });
    sections.push(
      `## Day of Week Performance\n` +
      `| Day | Trades | Win Rate | Expectancy | Profit Factor | Net P&L | Inconclusive |\n` +
      `| --- | --- | --- | --- | --- | --- | --- |\n` +
      rows.join('\n')
    );
  }

  // 6. Improvement Tips
  if (r.improvement_tips && r.improvement_tips.length > 0) {
    const tipBlocks = r.improvement_tips.map((t, idx) => {
      return (
        `### Tip ${idx + 1}: ${t.title || 'Recommendation'}\n` +
        `- Severity: ${t.severity || 'N/A'}\n` +
        `- Strategy: ${t.strategy || 'ALL'}\n` +
        `- Description: ${t.description || ''}\n` +
        `- Action: ${t.action || ''}`
      );
    });
    sections.push(`## Improvement Tips\n${tipBlocks.join('\n\n')}`);
  }

  // 7. Skipped Summary
  const skipped = (r as any).skipped_summary;
  if (skipped && typeof skipped === 'object' && Object.keys(skipped).length > 0) {
    const lines = Object.entries(skipped).map(([reason, count]) => `- ${reason}: ${count}`);
    sections.push(`## Skipped Signals Summary\n${lines.join('\n')}`);
  }

  // 8. Trades CSV (up to 150 most recent)
  if (r.all_trades && Array.isArray(r.all_trades) && r.all_trades.length > 0) {
    const totalCount = r.all_trades.length;
    const recent = r.all_trades.slice(-150);
    const omitted = totalCount - recent.length;

    const csvHeader = 'trade_id,date,strategy,direction,signal_time_sast,entry_price,sl,tp,exit_reason,r_multiple,money_pnl,mfe_r,mae_r,result';
    const csvRows = recent.map((t: any) => {
      const tid = t.trade_id || t.ticket || '';
      const date = t.date || '';
      const strat = t.strategy || '';
      const dir = t.direction || '';
      const sast = t.signal_time_sast || '';
      const entry = formatNum(t.entry_price);
      const sl = formatNum(t.sl);
      const tp = formatNum(t.tp);
      const reason = t.exit_reason || '';
      const rMult = formatNum(t.r_multiple);
      const pnl = formatNum(t.money_pnl);
      const mfe = formatNum(t.mfe_r);
      const mae = formatNum(t.mae_r);
      const res = t.result || '';
      return `${tid},${date},${strat},${dir},${sast},${entry},${sl},${tp},${reason},${rMult},${pnl},${mfe},${mae},${res}`;
    });

    const note = omitted > 0 ? `*(Showing 150 most recent trades. ${omitted} older trades omitted.)*\n\n` : '';
    sections.push(`## Trades\n${note}\`\`\`csv\n${csvHeader}\n${csvRows.join('\n')}\n\`\`\``);
  }

  // 9. Final Question
  sections.push(`QUESTION: What are the 3 most credible weaknesses in this data, and what is the smallest change to test for each?`);

  return sections.join('\n\n');
}

export const BacktestView: React.FC<BacktestViewProps> = ({
  themeMode = 'dark',
  brokerCurrency = 'USD'
}) => {
  const [reportFiles, setReportFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [reportData, setReportData] = useState<BacktestReportPayload | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<'summary' | 'chart' | 'ledger' | 'tips'>('summary');
  const [selectedDay, setSelectedDay] = useState<string>('');

  // Runner & Live Progress State
  const [testSymbol, setTestSymbol] = useState<string>('US30');
  const [testDays, setTestDays] = useState<number>(60);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [progressText, setProgressText] = useState<string>('');
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Copy for AI State
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [fallbackCopyText, setFallbackCopyText] = useState<string>('');

  // Table & Tip Filters
  const [strategyFilter, setStrategyFilter] = useState<string>('ALL');
  const [outcomeFilter, setOutcomeFilter] = useState<string>('ALL');
  const [tipFilter, setTipFilter] = useState<string>('ALL');

  // Dismissed tips persistent storage
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

  // 1. Initial status poll on mount (syncs running state even if page refreshed)
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
        }
      } catch {}
    };
    checkInitialStatus();
  }, []);

  // 2. Fetch available report files
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

  // 3. Fetch selected report JSON payload
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

  // 4. Live Polling for Background Backtest Runner
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
          if (!json.isRunning) {
            setIsRunning(false);
            if (json.exitCode === 0 && !json.lastError) {
              setSuccessBanner(`Backtest completed successfully! Updated report loaded.`);
              setErrorBanner(null);
            } else {
              setErrorBanner(json.lastError || 'Backtest failed or stopped.');
              setSuccessBanner(null);
            }
            await fetchReportList();
            setTimeout(() => setSuccessBanner(null), 5000);
          }
        }
      } catch (err) {
        console.warn('Status poll error:', err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [isRunning, fetchReportList]);

  // 5. Trigger Backtest Function
  const handleRunBacktest = async (targetSym: string) => {
    if (isRunning) return;
    setIsRunning(true);
    setErrorBanner(null);
    setSuccessBanner(null);
    setProgressText(`Connecting to broker & preparing historical data for ${targetSym}...`);

    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: targetSym, days: testDays, adaptive: true }),
      });

      if (!res.ok) {
        const errJson = await res.json();
        setErrorBanner(errJson.message || 'Failed to initiate backtest');
        setIsRunning(false);
      }
    } catch {
      setErrorBanner('Network error connecting to backtest engine.');
      setIsRunning(false);
    }
  };

  // 6. Stop / Cancel Running Backtest
  const handleStopBacktest = async () => {
    try {
      await fetch('/api/backtest/stop', { method: 'POST' });
      setIsRunning(false);
      setProgressText('Backtest cancelled.');
    } catch {
      setErrorBanner('Failed to stop backtest process.');
    }
  };

  // 7. Copy for AI Handler
  const handleCopyForAI = async () => {
    if (!reportData) return;
    const text = buildReportMarkdown(reportData);
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        setCopyStatus('copied');
        setFallbackCopyText('');
        setTimeout(() => setCopyStatus('idle'), 2000);
      } else {
        setFallbackCopyText(text);
      }
    } catch {
      setFallbackCopyText(text);
    }
  };

  // 8. Dismiss Tip handler
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

  // 9. Render Lightweight-Chart for the selected day
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
      candleSeries.createPriceLine({
        price: lvls.asia_high,
        color: '#3b82f6',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'ASIA HIGH',
      });
    }
    if (lvls.asia_low) {
      candleSeries.createPriceLine({
        price: lvls.asia_low,
        color: '#3b82f6',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'ASIA LOW',
      });
    }
    if (lvls.daily_eq) {
      candleSeries.createPriceLine({
        price: lvls.daily_eq,
        color: '#f59e0b',
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'DAILY EQ',
      });
    }
    if (lvls.pdh) {
      candleSeries.createPriceLine({
        price: lvls.pdh,
        color: '#a855f7',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'PDH',
      });
    }
    if (lvls.pdl) {
      candleSeries.createPriceLine({
        price: lvls.pdl,
        color: '#a855f7',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'PDL',
      });
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

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Header with Test Controls */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-300 dark:border-[#1a2030]"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-black dark:text-white flex items-center gap-2.5">
            Backtest & Replay Suite
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
              Zero Look-Ahead
            </span>
          </h1>
          <p className="text-sm text-black dark:text-slate-400 mt-1">
            Replays 5-minute broker candles across all 8 strategies with actionable improvement advice.
          </p>
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-[#0f1118] p-1 rounded-xl border border-slate-300 dark:border-[#1a2030]">
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
              <option value={30}>30 Days (~15s)</option>
              <option value={60}>60 Days (~30s)</option>
              <option value={90}>90 Days (~45s)</option>
              <option value={180}>180 Days (~1.5m)</option>
              <option value={365}>365 Days (1 Yr)</option>
            </select>

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
                  title="Sequentially runs backtest across all 7 whitelist pairs"
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>Run All 7</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleStopBacktest}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-rose-600 hover:bg-rose-500 text-white"
              >
                <Square className="w-3.5 h-3.5" />
                <span>Stop Backtest</span>
              </button>
            )}
          </div>

          <div className="h-6 w-px bg-slate-300 dark:border-[#1a2030] hidden sm:block" />

          {/* Report Viewer Dropdown & Copy for AI */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-500">Report:</span>
            <select
              value={selectedFile}
              onChange={(e) => setSelectedFile(e.target.value)}
              disabled={isRunning}
              className="px-3 py-2 rounded-xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-xs font-mono font-bold text-blue-600 dark:text-blue-400 cursor-pointer"
            >
              {reportFiles.length === 0 ? (
                <option value="">No reports found (Click Run above)</option>
              ) : (
                reportFiles.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))
              )}
            </select>

            {reportData && (
              <button
                type="button"
                onClick={handleCopyForAI}
                className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-[#0f1118] dark:hover:bg-[#141722] border border-slate-300 dark:border-[#1a2030] text-xs font-semibold text-black dark:text-slate-200 flex items-center gap-1.5 cursor-pointer shadow-xs transition-colors"
                title="Copy markdown report for AI analysis"
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
            )}
          </div>
        </div>
      </motion.div>

      {/* Fallback Textarea if Clipboard is Blocked */}
      {fallbackCopyText && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-amber-500/40 shadow-xs space-y-2 animate-in fade-in">
          <div className="flex items-center justify-between text-xs font-bold text-amber-600 dark:text-amber-400">
            <span>Clipboard write was blocked by the browser. Select all and copy the text below:</span>
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

      {/* Live Running Progress Banner */}
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

      {/* Error Banner */}
      {errorBanner && (
        <div className="p-4 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-700 dark:text-rose-400 text-xs font-semibold flex items-center justify-between animate-in fade-in">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{errorBanner}</span>
          </div>
          <button onClick={() => setErrorBanner(null)} className="text-slate-400 hover:text-black dark:hover:text-white cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {/* Completion Toast */}
      {successBanner && (
        <div className="p-3.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-700 dark:text-emerald-400 text-xs font-semibold flex items-center gap-2 animate-in fade-in">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{successBanner}</span>
        </div>
      )}

      {/* 4 Navigation Sub-Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-[#1a2030] pb-2">
        <button
          onClick={() => setActiveSubTab('summary')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${
            activeSubTab === 'summary'
              ? 'bg-blue-600 text-white shadow-xs'
              : 'text-slate-500 hover:text-black dark:hover:text-white'
          }`}
        >
          <TrendingUp className="w-3.5 h-3.5" />
          <span>Summary Dashboard</span>
        </button>

        <button
          onClick={() => setActiveSubTab('tips')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 relative ${
            activeSubTab === 'tips'
              ? 'bg-blue-600 text-white shadow-xs'
              : 'text-slate-500 hover:text-black dark:hover:text-white'
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
            activeSubTab === 'chart'
              ? 'bg-blue-600 text-white shadow-xs'
              : 'text-slate-500 hover:text-black dark:hover:text-white'
          }`}
        >
          <Calendar className="w-3.5 h-3.5" />
          <span>Day Chart Inspector</span>
        </button>

        <button
          onClick={() => setActiveSubTab('ledger')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${
            activeSubTab === 'ledger'
              ? 'bg-blue-600 text-white shadow-xs'
              : 'text-slate-500 hover:text-black dark:hover:text-white'
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
              <div className="text-sm font-bold text-black dark:text-white">All Improvement Tips Reviewed!</div>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                No active recommendations pending. Run a backtest or click "Restore Dismissed Tips" above.
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
                      <td className="py-2.5 px-3">{t.entry_price}</td>
                      <td className="py-2.5 px-3">{t.exit_price}</td>
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
                    <th className="py-3 px-3">Date</th>
                    <th className="py-3 px-3">Strategy</th>
                    <th className="py-3 px-3 text-center">Dir</th>
                    <th className="py-3 px-3">Lots</th>
                    <th className="py-3 px-3">Entry</th>
                    <th className="py-3 px-3">SL</th>
                    <th className="py-3 px-3">TP</th>
                    <th className="py-3 px-3">MFE (R/Pips)</th>
                    <th className="py-3 px-3">MAE (R/Pips)</th>
                    <th className="py-3 px-3">Classification</th>
                    <th className="py-3 px-3 text-right">Net P&L</th>
                    <th className="py-3 px-3 text-center">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                  {filteredTrades.map((t: any, idx: number) => (
                    <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                      <td className="py-2.5 px-3 text-slate-400">{t.date}</td>
                      <td className="py-2.5 px-3 font-bold text-black dark:text-white">{t.strategy}</td>
                      <td className={`py-2.5 px-3 text-center font-bold ${t.direction === 'BUY' ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {t.direction}
                      </td>
                      <td className="py-2.5 px-3">{t.lots}</td>
                      <td className="py-2.5 px-3">{t.entry_price}</td>
                      <td className="py-2.5 px-3 text-rose-500">{t.sl}</td>
                      <td className="py-2.5 px-3 text-emerald-500">{t.tp}</td>
                      <td className="py-2.5 px-3 text-emerald-500 font-semibold">
                        +{t.mfe_r ?? 0}R ({t.mfe_pips ?? 0}p)
                      </td>
                      <td className="py-2.5 px-3 text-rose-500 font-semibold">
                        -{t.mae_r ?? 0}R ({t.mae_pips ?? 0}p)
                      </td>
                      <td className="py-2.5 px-3">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold ${
                          t.failure_reason === 'NOISE_STOPOUT_RECOVERED'
                            ? 'bg-amber-500/15 text-amber-500 border border-amber-500/30'
                            : t.failure_reason === 'NEAR_TP_REVERSAL'
                            ? 'bg-purple-500/15 text-purple-500 border border-purple-500/30'
                            : 'bg-slate-100 dark:bg-[#0d1017] text-slate-400'
                        }`}>
                          {t.failure_reason || t.exit_reason}
                        </span>
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