import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import { createChart, IChartApi, ColorType, LineStyle, UTCTimestamp } from 'lightweight-charts';
import { 
  Calendar, TrendingUp, RefreshCw, Play, AlertTriangle, Lightbulb, Trash2, RotateCcw, 
  Sparkles, Layers, Square, Copy, Check, Table, Database, Clock, ShieldCheck, Download, Printer,
  FileText
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
  total_seconds?: number;
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
  const [activeSubTab, setActiveSubTab] = useState<'summary' | 'chart' | 'ledger' | 'tips'>('summary');
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

          // PAGE 1: COVER PAGE
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

          // PAGE 2: PORTFOLIO OVERVIEW & P&L BAR CHART
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

          // Draw vector P&L bar chart with jsPDF primitives
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

          // ONE PAGE PER PAIR
          for (const p of (exp.pairs || [])) {
            if (p.status !== 'OK') continue;
            doc.addPage();
            addHeaderFooter(`${p.symbol} Deep Dive`);
            doc.setFontSize(14);
            doc.setTextColor(15, 23, 42);
            doc.text(`${p.symbol} - 8-Combination Matrix Performance (${p.seconds_taken || 0}s)`, 14, 22);

            const bLabel = p.best_combination?.label || '';
            const comboRows = (p.combinations || []).map((c: any) => [
              (c.label === bLabel ? `★ ${c.label}` : c.label),
              c.total_trades || 0, `${formatNum(c.win_rate)}%`, `${formatNum(c.expectancy)}R`,
              formatNum(c.profit_factor), `-$${formatNum(c.max_drawdown)}`, `$${formatNum(c.net_pnl)}`, `${formatNum(c.adaptive_effective_pct)}%`
            ]);

            autoTable(doc, {
              startY: 26,
              head: [['Combination', 'Trades', 'Win Rate', 'Exp (R)', 'PF', 'Max DD', 'Net P&L', 'Coverage']],
              body: comboRows,
              theme: 'grid',
              headStyles: { fillColor: [15, 23, 42], fontSize: 7 },
              bodyStyles: { fontSize: 7 }
            });

            let currentY = (doc as any).lastAutoTable.finalY + 8;
            const stratRows = Object.entries(p.best_combination?.strategy_kpis || {}).map(([sName, s]: any) => [
              sName, s.count, `${formatNum(s.win_rate)}%`, `${formatNum(s.avg_r)}R`, formatNum(s.profit_factor), `$${formatNum(s.net_pnl)}`
            ]);

            if (stratRows.length > 0) {
              doc.setFontSize(10);
              doc.setTextColor(15, 23, 42);
              doc.text(`Strategy Breakdown (${bLabel})`, 14, currentY);
              autoTable(doc, {
                startY: currentY + 3,
                head: [['Strategy', 'Trades', 'Win Rate', 'Avg R', 'PF', 'Net P&L']],
                body: stratRows,
                theme: 'striped',
                headStyles: { fillColor: [71, 85, 105], fontSize: 7 },
                bodyStyles: { fontSize: 7 }
              });
              currentY = (doc as any).lastAutoTable.finalY + 8;
            }

            // Skipped signals display
            const skipMap = p.best_combination?.skipped_summary || {};
            const skipEntries = Object.entries(skipMap);
            if (skipEntries.length > 0) {
              doc.setFontSize(8);
              doc.setTextColor(100, 116, 139);
              const skipStr = skipEntries.map(([r, c]) => `${r}: ${c}`).join(' | ');
              doc.text(`Skipped Signals: ${skipStr}`, 14, currentY);
              currentY += 6;
            }

            // Rule-based suggestions for this pair
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

          // FINAL TOP-10 SUGGESTIONS & WHAT TO TEST NEXT PAGE
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

          // AUDIT GLOSSARY PAGE
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
            ['Inconclusive Sample (<30)', 'Any combination or strategy generating fewer than 30 trade executions is flagged as INCONCLUSIVE due to lack of statistical significance.']
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
      {/* Top Header */}
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

        {/* Controls Strip */}
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

      {/* Verification Diff Box */}
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

      {/* Storage Strip */}
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

      {/* Per-Symbol Results Box */}
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
          <button type="button" onClick={handleStopBacktest} className="px-3 py-1.5 rounded-lg text-[11px] font-bold font-mono bg-rose-600 hover:bg-rose-500 text-white transition-colors cursor-pointer">Cancel Run</button>
        </div>
      )}

      {/* RESULTS BY COMBINATION MATRIX TABLE */}
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
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                {summaryData.combinations.map((c, idx) => (
                  <tr key={idx} onClick={() => setSelectedFile(c.report_file)} className={`cursor-pointer transition-colors ${selectedFile === c.report_file ? 'bg-blue-500/15' : idx === bestComboIdx ? 'bg-amber-500/10 hover:bg-amber-500/20' : 'hover:bg-slate-50 dark:hover:bg-[#121520]'}`}>
                    <td className="py-3 px-3 font-bold text-black dark:text-white flex items-center gap-2">
                      {idx === bestComboIdx && <span className="text-amber-500">★</span>}
                      <span>{c.label}</span>
                    </td>
                    <td className="py-3 px-3 text-center font-bold">{c.total_trades}</td>
                    <td className={`py-3 px-3 text-center font-bold ${c.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{c.win_rate}%</td>
                    <td className="py-3 px-3 text-center">{c.expectancy}R</td>
                    <td className="py-3 px-3 text-center">{c.profit_factor}</td>
                    <td className="py-3 px-3 text-right text-rose-500">-${c.max_drawdown}</td>
                    <td className={`py-3 px-3 text-right font-bold ${c.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${c.net_pnl}</td>
                    <td className="py-3 px-3 text-center text-blue-500">{c.adaptive_effective_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Report Selector Strip */}
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

      {/* Navigation Sub-Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-[#1a2030] pb-2">
        <button onClick={() => setActiveSubTab('summary')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'summary' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <TrendingUp className="w-3.5 h-3.5" /><span>Summary Dashboard</span>
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

      {/* SUB-TAB 1: SUMMARY */}
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
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                  {Object.entries(reportData?.strategy_kpis || {}).map(([sName, sKpi]) => (
                    <tr key={sName} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                      <td className="py-3 px-3 font-bold text-black dark:text-white">{sName}</td>
                      <td className="py-3 px-3 text-center font-bold">{sKpi.count}</td>
                      <td className={`py-3 px-3 text-center font-bold ${sKpi.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{sKpi.win_rate}%</td>
                      <td className="py-3 px-3 text-center">{sKpi.avg_r}R</td>
                      <td className="py-3 px-3 text-center">{sKpi.profit_factor}</td>
                      <td className={`py-3 px-3 text-right font-bold ${sKpi.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${sKpi.net_pnl}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 2: TIPS */}
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

      {/* SUB-TAB 3: CHART */}
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

      {/* SUB-TAB 4: LEDGER */}
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