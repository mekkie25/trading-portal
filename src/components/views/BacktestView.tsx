import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import { createChart, IChartApi, ColorType, LineStyle, UTCTimestamp } from 'lightweight-charts';
import {
  Calendar, TrendingUp, RefreshCw, Play, AlertTriangle, Lightbulb, Trash2, RotateCcw,
  Sparkles, Layers, Square, Copy, Check, Table, Database, Clock, ShieldCheck, Download, Printer,
  FileText, Activity
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

export const BacktestView: React.FC<BacktestViewProps> = ({ themeMode = 'dark', brokerCurrency = 'USD' }) => {
  const [reportFiles, setReportFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [reportData, setReportData] = useState<BacktestReportPayload | null>(null);
  const [summaryData, setSummaryData] = useState<SymbolSummaryPayload | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<'summary' | 'diagnostics' | 'chart' | 'ledger' | 'tips'>('summary');
  const [selectedDay, setSelectedDay] = useState<string>('');

  const [testSymbol, setTestSymbol] = useState<string>('US30');
  const [testDays, setTestDays] = useState<number>(60);
  const [testRr, setTestRr] = useState<number>(1.0);

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
          }
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [isRunning, fetchReportList, fetchSummaryData, fetchStorageInfo, testSymbol]);

  const currentSymbolReports = useMemo(() => {
    return reportFiles.filter(f => f.startsWith(`${testSymbol}_`));
  }, [reportFiles, testSymbol]);

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

  const handleRunBacktest = async (targetSym: string) => {
    if (isRunning) return;
    setIsRunning(true);
    setRunResults([]);
    setProgressText(`Preparing matrix for ${targetSym}...`);
    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: targetSym, days: testDays, rr: testRr }),
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
          doc.roundedRect(20, 125, pageWidth - 40, 50, 4, 4, 'F');
          doc.setTextColor(248, 250, 252);
          doc.setFontSize(11);
          doc.text('AUDIT METHODOLOGY & CONVENTIONS:', 26, 135);
          doc.setFontSize(9);
          doc.setTextColor(148, 163, 184);
          doc.text('1. Tests 8 combinations per asset across Adaptive/Legacy, Breakeven, and SuperTrend trail.', 26, 143);
          doc.text('2. Every rule in the suggestion engine strictly requires at least 30 trades before firing.', 26, 150);
          doc.text('3. Identifies the statistically superior setup per asset ranked by estimated dollar impact.', 26, 157);
          doc.text('4. Zero look-ahead bias: higher timeframe candles are reconstructed bar-by-bar at time T.', 26, 164);

          doc.addPage();
          addHeaderFooter('Portfolio Overview');
          doc.setFontSize(16);
          doc.setTextColor(15, 23, 42);
          doc.text('Portfolio Executive Summary', 14, 22);

          const overviewRows = (exp.pairs || []).map((p: any) => {
            if (p.status !== 'OK') return [p.symbol, 'NOT TESTED', '--', '--', '--', p.error || ''];
            const b = p.best_combination || {};
            return [p.symbol, b.label || 'N/A', b.total_trades || 0, `${formatNum(b.win_rate)}%`, formatNum(b.profit_factor), `$${formatNum(b.net_pnl)}`];
          });

          autoTable(doc, {
            startY: 28,
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
                tStr, vStr
              ];
            });

            autoTable(doc, {
              startY: 26,
              head: [['Combination', 'Trades', 'Win Rate', 'Exp (R)', 'PF', 'Max DD', 'Net P&L', 'Coverage', 'TUNE (TR/PF/WR)', 'VALIDATE (TR/PF/WR)']],
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
              return [sName, s.count, `${formatNum(s.win_rate)}%`, `${formatNum(s.avg_r)}R`, formatNum(s.profit_factor), `$${formatNum(s.net_pnl)}`, tStr, vStr];
            });

            if (stratRows.length > 0) {
              doc.setFontSize(10);
              doc.setTextColor(15, 23, 42);
              doc.text(`Strategy Breakdown (${bLabel})`, 14, currentY);
              autoTable(doc, {
                startY: currentY + 3,
                head: [['Strategy', 'Trades', 'Win Rate', 'Avg R', 'PF', 'Net P&L', 'TUNE (TR/PF/WR)', 'VALIDATE (TR/PF/WR)']],
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
              const skipStr = skipEntries.map(([r, c]) => `${r}: ${c}`).join(' | ');
              doc.text(`Skipped Signals: ${skipStr}`, 14, currentY);
              currentY += 6;
            }

            const ruleSuggestions = p.best_combination?.rule_suggestions || [];
            if (ruleSuggestions.length > 0) {
              doc.setFontSize(10);
              doc.setTextColor(37, 99, 235);
              doc.text('Actionable Rule Suggestions (Impact Ranked):', 14, currentY);
              doc.setFontSize(8);
              doc.setTextColor(51, 65, 85);
              ruleSuggestions.slice(0, 5).forEach((t: any, i: number) => {
                doc.text(`• [+$${t.impact}] ${t.text}`, 16, currentY + 5 + (i * 5));
              });
            }
          }

          doc.addPage();
          addHeaderFooter('Strategic Recommendations');
          doc.setFontSize(16);
          doc.setTextColor(15, 23, 42);
          doc.text('Portfolio Strategic Optimization (Top 10 Actions)', 14, 22);

          const portSuggestions = exp.portfolio_suggestions || [];
          const suggRows = portSuggestions.map((s: any, idx: number) => [
            `#${idx + 1}`, `+$${formatNum(s.impact)}`, s.type, s.text
          ]);

          if (suggRows.length > 0) {
            autoTable(doc, {
              startY: 28,
              head: [['Rank', 'Est. Impact', 'Category', 'Recommended Action (Requires >= 30 Trades)']],
              body: suggRows,
              theme: 'striped',
              headStyles: { fillColor: [37, 99, 235], fontSize: 8 },
              bodyStyles: { fontSize: 8 },
              columnStyles: { 0: { cellWidth: 14 }, 1: { cellWidth: 24, fontStyle: 'bold' }, 2: { cellWidth: 32 } }
            });
          }

          let nextTestY = (doc as any).lastAutoTable ? (doc as any).lastAutoTable.finalY + 12 : 30;
          doc.setFontSize(12);
          doc.setTextColor(15, 23, 42);
          doc.text('What to Test Next (Prioritized Actions):', 14, nextTestY);

          const whatToTest = exp.what_to_test_next || [];
          doc.setFontSize(9);
          doc.setTextColor(71, 85, 105);
          whatToTest.forEach((item: string, i: number) => {
            doc.text(`${i + 1}. ${item}`, 16, nextTestY + 7 + (i * 6));
          });

          doc.addPage();
          addHeaderFooter('Glossary & Definitions');
          doc.setFontSize(16);
          doc.setTextColor(15, 23, 42);
          doc.text('Audit Glossary & Methodological Definitions', 14, 22);

          const glossaryItems = [
            ['Profit Factor (PF)', 'Gross realized winning profits divided by gross realized losing losses. A PF above 1.30 represents a robust institutional statistical edge; below 1.00 represents a losing system.'],
            ['Expectancy (R)', 'The expected return in units of initial risk (R) per trade: (Win Rate × Avg Win R) - (Loss Rate × Avg Loss R). Positive expectancy is mandatory for profitability.'],
            ['Maximum Drawdown (Max DD)', 'The maximum peak-to-trough equity decline incurred during the simulation period, measured in currency ($).'],
            ['Average Daily Range (ADR)', 'A rolling 90-day smoothed daily price range used by the Volatility Engine to dynamically size stop losses and profit targets according to current market regime.'],
            ['Adaptive vs Legacy Mode', 'Adaptive mode recalculates stop distances and target expansions dynamically based on market volatility; Legacy mode uses static fixed-point stop loss bands.'],
            ['Breakeven Supervisor (BE)', 'A protective trailing rule that moves the stop loss directly to the entry price once price travels 80% toward the Take Profit target, locking in a risk-free trade.'],
            ['SuperTrend Trailing', 'An active trend-following exit that trails open positions along the 10-period, 1.6-multiplier SuperTrend line until an opposite-direction flip occurs.'],
            ['Inconclusive Sample (<30)', 'Any combination or strategy generating fewer than 30 trade executions is flagged as INCONCLUSIVE due to lack of statistical significance.'],
            ['TUNE / VALIDATE split', 'Each test window is split 70/30 by date. TUNE = first 70% (in-sample). VALIDATE = last 30% (unseen). A strategy that fails on VALIDATE does not hold on unseen data.'],
            ['Blueprint Diagnostics', 'Phase-1 + Phase-2 post-hoc analytics: hourly expectancy, session-rollover friction, ATR tier KPIs, loss-streak recovery, circuit-breaker simulation, outlier dependency, Monte Carlo drawdown distribution, buy-and-hold alpha, post-SL/post-TP excursion, premature BE exits, EMA-200 alignment, confirmation type, and news-window slippage profiling.']
          ];

          autoTable(doc, {
            startY: 28,
            head: [['Metric / Concept', 'Quantitative Definition & Operational Role']],
            body: glossaryItems,
            theme: 'grid',
            headStyles: { fillColor: [15, 23, 42], fontSize: 8 },
            bodyStyles: { fontSize: 8 },
            columnStyles: { 0: { cellWidth: 45, fontStyle: 'bold' } }
          });

          if (typeof doc.putTotalPages === 'function') doc.putTotalPages(totalPagesExp);
          doc.save(`Nexus_Matrix_Audit_Report_${exp.generated_at.slice(0, 10)}.pdf`);
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
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 dark:bg-[#0f1118] p-1.5 rounded-xl border border-slate-300 dark:border-[#1a2030]">
            <select value={testSymbol} onChange={(e) => setTestSymbol(e.target.value)} disabled={isRunning} className="px-2.5 py-1.5 rounded-lg bg-transparent text-xs font-mono font-bold text-black dark:text-white cursor-pointer focus:outline-none">
              {WHITELIST_ASSETS.map((sym) => (<option key={sym} value={sym}>{sym}</option>))}
            </select>
            <select value={testDays} onChange={(e) => setTestDays(parseInt(e.target.value, 10))} disabled={isRunning} className="px-2.5 py-1.5 rounded-lg bg-transparent text-xs font-mono font-bold text-black dark:text-white cursor-pointer focus:outline-none">
              <option value={60}>60 Days</option>
              <option value={90}>90 Days</option>
              <option value={180}>180 Days</option>
              <option value={365}>365 Days</option>
            </select>
            <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
              <span className="text-[10px] font-bold text-slate-500">R:R</span>
              <input type="number" step="0.1" min="0.5" max="5.0" value={testRr} onChange={(e) => setTestRr(parseFloat(e.target.value) || 1.0)} disabled={isRunning} className="w-12 text-xs font-mono font-bold text-center bg-transparent text-black dark:text-white focus:outline-none" />
            </div>

            {!isRunning ? (
              <>
                <button type="button" onClick={() => handleRunBacktest(testSymbol)} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-emerald-600 hover:bg-emerald-500 text-white">
                  <Play className="w-3.5 h-3.5" />
                  <span>Run {testSymbol}</span>
                </button>
                <button type="button" onClick={() => handleRunBacktest('ALL')} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-blue-600 hover:bg-blue-500 text-white">
                  <Layers className="w-3.5 h-3.5" />
                  <span>Run All</span>
                </button>
              </>
            ) : (
              <button type="button" onClick={handleStopBacktest} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-rose-600 hover:bg-rose-500 text-white">
                <Square className="w-3.5 h-3.5" />
                <span>Stop</span>
              </button>
            )}
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

            <button type="button" disabled={isVerifying || isRunning} onClick={handleVerifyVsOriginal} className="px-3 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-50 transition-colors">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>{isVerifying ? 'Verifying...' : 'Verify vs original (60 days)'}</span>
            </button>
          </div>
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

      {storageInfo && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <Database className="w-4 h-4 text-blue-500 shrink-0" />
              <span className="font-bold text-black dark:text-white">Storage Volume:</span>
              <span className="font-mono text-slate-600 dark:text-slate-300">{storageInfo.used_mb} MB used / {storageInfo.free_mb} MB free (Total: {storageInfo.total_mb} MB)</span>
              <span className="text-slate-400 hidden sm:inline">|</span>
              <span className="font-mono text-[11px] text-slate-500">Reports: <strong className="text-blue-500">{storageInfo.reports_mb} MB</strong> • Market Data: <strong className="text-emerald-500">{storageInfo.market_data_mb} MB</strong></span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button type="button" disabled={isCleaning || isRunning} onClick={() => handleCleanup('symbol')} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#141722] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
                <Trash2 className="w-3 h-3 text-amber-500" /><span>Clear {testSymbol} reports</span>
              </button>
              <button type="button" disabled={isCleaning || isRunning} onClick={() => handleCleanup('all_reports')} className="px-3 py-1.5 rounded-lg bg-rose-600/10 hover:bg-rose-600/20 text-rose-600 border border-rose-500/30 text-[11px] font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
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
            </div>
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
                  <th className="py-2.5 px-3 text-center">TUNE (PF / WR / TR)</th>
                  <th className="py-2.5 px-3 text-center">VALIDATE (PF / WR / TR)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                {summaryData.combinations.map((c: any, idx: number) => {
                  const tv = c.tune_validate || {};
                  const cTune = tv.tune || {};
                  const cVal = tv.validate || {};
                  const inconTune = (cTune.count ?? 0) < 30;
                  const inconVal = (cVal.count ?? 0) < 30;
                  const failHoldOut = (!inconTune && !inconVal) &&
                    ((cVal.profit_factor ?? 0) < 1.0 || (cVal.profit_factor ?? 0) < 0.7 * (cTune.profit_factor ?? 0));
                  return (
                    <tr key={idx} onClick={() => setSelectedFile(c.report_file)} className={`cursor-pointer transition-colors ${selectedFile === c.report_file ? 'bg-blue-500/15' : idx === bestComboIdx ? 'bg-amber-500/10 hover:bg-amber-500/20' : 'hover:bg-slate-50 dark:hover:bg-[#121520]'} ${failHoldOut ? 'ring-1 ring-rose-500/40' : ''}`}>
                      <td className="py-3 px-3 font-bold text-black dark:text-white">
                        <div className="flex items-center gap-2">
                          {idx === bestComboIdx && <span className="text-amber-500">★</span>}
                          <span>{c.label}</span>
                          {failHoldOut && <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-rose-500/15 text-rose-600">HOLD-OUT FAIL</span>}
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
          <span className="font-mono text-blue-600 dark:text-blue-400">Coverage: {(reportData as any).adaptive_effective_pct ?? 100}%</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-[#1a2030] pb-2">
        <button onClick={() => setActiveSubTab('summary')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'summary' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <TrendingUp className="w-3.5 h-3.5" /><span>Summary Dashboard</span>
        </button>
        <button onClick={() => setActiveSubTab('diagnostics')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'diagnostics' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <Activity className="w-3.5 h-3.5 text-purple-400" /><span>Blueprint Diagnostics</span>
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
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500">Total Trades</div>
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
              <div className="text-[10px] uppercase font-bold text-slate-500">Win Rate</div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{kpis.win_rate}%</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500">Expectancy</div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.expectancy > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{kpis.expectancy}R</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500">Profit Factor</div>
              <div className="text-2xl font-bold font-mono text-black dark:text-white mt-1">{kpis.profit_factor}</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500">Max Drawdown</div>
              <div className="text-2xl font-bold font-mono text-rose-600 mt-1">-${kpis.max_dd_money}</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500">Net Realized P&L</div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{formatCurrency(kpis.net_pnl, brokerCurrency)}</div>
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
                    <th className="py-2.5 px-3 text-center">PF</th>
                    <th className="py-2.5 px-3 text-right">Net P&L</th>
                    <th className="py-2.5 px-3 text-center">TUNE (PF / WR / TR)</th>
                    <th className="py-2.5 px-3 text-center">VALIDATE (PF / WR / TR)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                  {Object.entries(reportData?.strategy_kpis || {}).map(([sName, sKpi]: any) => {
                    const tv = (reportData as any)?.strategy_tune_validate?.[sName] || {};
                    const sTune = tv.tune || {};
                    const sVal = tv.validate || {};
                    const inconTune = (sTune.count ?? 0) < 30;
                    const inconVal = (sVal.count ?? 0) < 30;
                    const failHoldOut = (!inconTune && !inconVal) &&
                      ((sVal.profit_factor ?? 0) < 1.0 || (sVal.profit_factor ?? 0) < 0.7 * (sTune.profit_factor ?? 0));
                    return (
                      <tr key={sName} className={`hover:bg-slate-50 dark:hover:bg-[#121520] ${failHoldOut ? 'ring-1 ring-rose-500/30' : ''}`}>
                        <td className="py-3 px-3 font-bold text-black dark:text-white">
                          <div className="flex items-center gap-2">
                            <span>{sName}</span>
                            {failHoldOut && <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-rose-500/15 text-rose-600">HOLD-OUT FAIL</span>}
                          </div>
                        </td>
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
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeSubTab === 'diagnostics' && (() => {
        const diag = reportData?.diagnostics;
        if (!diag) {
          return (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center">
              <Activity className="w-8 h-8 text-purple-400 mx-auto" />
              <div className="text-sm font-bold text-black dark:text-white mt-2">No diagnostics yet</div>
              <div className="text-xs text-slate-500 mt-1">Run a backtest to generate the Blueprint analytics block.</div>
            </div>
          );
        }

        const kpiColor = (v: number) => v >= 0 ? 'text-emerald-500' : 'text-rose-500';

        return (
          <div className="space-y-6">

            {/* Phase 1 - Section 4 item 19: 24-hour hourly expectancy matrix */}
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-black dark:text-white">§19 · 24-Hour Hourly Expectancy Matrix (SAST)</h3>
                <span className="text-[10px] font-mono text-slate-500">Unbiased · all 24 hours scanned</span>
              </div>
              <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-12 gap-2">
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

            {/* Phase 1 - Section 4 item 20: Day of Week performance */}
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3">§20 · Performance by Day of Week</h3>
              <div className="overflow-x-auto">
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

            {/* Phase 1 - Section 4 item 21: Session rollover friction */}
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1">§21 · Session-Rollover Friction</h3>
              <p className="text-[11px] text-slate-500 mb-3 font-mono">Comparison: trades taken inside ±15min of major session transitions vs outside.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

            {/* Phase 1 - Section 6 item 26: ATR volatility tiering */}
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3">§26 · ATR Volatility Tiering</h3>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
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

            {/* Phase 1 - Sections 7 items 31 + 32: Streak analysis + circuit breaker */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
                <h3 className="text-sm font-bold text-black dark:text-white mb-3">§31 · Consecutive Loss Streak</h3>
                <div className="grid grid-cols-2 gap-3 text-xs font-mono">
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
                <h3 className="text-sm font-bold text-black dark:text-white mb-1">§32 · Circuit-Breaker Simulation</h3>
                <p className="text-[10px] text-slate-500 mb-3 font-mono">What if we halve risk after every 3rd consecutive loss?</p>
                <div className="space-y-2 text-xs font-mono">
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

            {/* Phase 1 - Section 7 item 36: Outlier dependency removal */}
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1">§36 · Outlier Dependency Removal</h3>
              <p className="text-[10px] text-slate-500 mb-3 font-mono">Drops the top 5% best trades and recomputes. If edge collapses, it was luck.</p>
              <div className="overflow-x-auto">
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

            {/* Phase 1 - Section 7 item 37: Monte Carlo resampling */}
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1">§37 · Monte Carlo Resampling</h3>
              <p className="text-[10px] text-slate-500 mb-3 font-mono">{diag.monte_carlo.iterations} shuffles of the trade sequence.</p>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 text-xs font-mono">
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

            {/* Phase 1 - Section 7 item 38: Buy and Hold benchmark */}
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3">§38 · Buy-and-Hold Benchmark (Alpha)</h3>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
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

            {/* ============================================================
                PHASE 2 CARDS
                ============================================================ */}

            {/* Phase 2 - Section 3 item 16: Post-SL continuation distance */}
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1">§16 · Post-SL Continuation Distance ("Bad Stop")</h3>
              <p className="text-[10px] text-slate-500 mb-3 font-mono">
                How far price kept moving against us after SL. Large numbers mean our stop is placed too tight relative to noise.
              </p>
              {diag.post_sl.count === 0 ? (
                <div className="text-xs text-slate-400 italic">No SL exits with post-exit tracking available.</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
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

            {/* Phase 2 - Section 3 item 17: Post-TP extra pips */}
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1">§17 · Post-TP Movement ("Money Left on Table")</h3>
              <p className="text-[10px] text-slate-500 mb-3 font-mono">
                Extra pips price travelled in our favour after TP was hit. Large values suggest target is set too conservative.
              </p>
              {diag.post_tp.count === 0 ? (
                <div className="text-xs text-slate-400 italic">No TP exits with post-exit tracking available.</div>
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
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

            {/* Phase 2 - Section 3 item 18: Premature BE exit detection */}
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1">§18 · Premature BE Exit Detection</h3>
              <p className="text-[10px] text-slate-500 mb-3 font-mono">
                Trades where SL was moved to BE, got stopped at BE, then rallied to the original TP. These are "should have held" cases.
              </p>
              {diag.premature_be.total_be_moved === 0 ? (
                <div className="text-xs text-slate-400 italic">No BE-moved trades in this run.</div>
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
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

            {/* Phase 2 - Section 6 item 27: 200 EMA alignment differential */}
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3">§27 · 200 EMA Trend-Alignment Differential</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-mono">
                {[
                  { label: 'Trend-Aligned', d: diag.ema_200_alignment.aligned, tone: 'emerald' },
                  { label: 'Counter-Trend', d: diag.ema_200_alignment.counter_trend, tone: 'rose' },
                  { label: 'Unknown', d: diag.ema_200_alignment.unknown, tone: 'slate' },
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

            {/* Phase 2 - Section 6 item 28: Confirmation type (close vs touch) */}
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1">§28 · Candle-Close vs Touch Confirmation</h3>
              <p className="text-[10px] text-slate-500 mb-3 font-mono">
                All current strategies use candle-close confirmation. This panel populates once touch-based entries exist.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
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

            {/* Phase 2 - Section 6 item 29: News-window slippage profiling */}
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-1">§29 · News-Event Slippage Profiling</h3>
              <p className="text-[10px] text-slate-500 mb-3 font-mono">
                Compares trades opened inside vs outside scheduled high-impact news windows (NFP, CPI, FOMC).
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
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

          </div>
        );
      })()}

      {activeSubTab === 'tips' && (
        <div className="space-y-4">
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