import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { 
  createChart, 
  IChartApi, 
  ISeriesApi, 
  ColorType, 
  LineStyle, 
  UTCTimestamp 
  // @ts-ignore
} from 'lightweight-charts';

import { 
  History, 
  Calendar, 
  TrendingUp, 
  TrendingDown, 
  Target, 
  Layers, 
  Clock, 
  ShieldAlert,
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  FileText
} from 'lucide-react';
import { ThemeMode, BacktestReportPayload, BacktestKPIs } from '../../types';
import { formatCurrency } from '../../utils/currency';

interface BacktestViewProps {
  themeMode?: ThemeMode;
  brokerCurrency?: string;
}

export const BacktestView: React.FC<BacktestViewProps> = ({
  themeMode = 'dark',
  brokerCurrency = 'USD'
}) => {
  const [reportFiles, setReportFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [reportData, setReportData] = useState<BacktestReportPayload | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [activeSubTab, setActiveSubTab] = useState<'summary' | 'chart' | 'ledger'>('summary');
  const [selectedDay, setSelectedDay] = useState<string>('');

  const [strategyFilter, setStrategyFilter] = useState<string>('ALL');
  const [outcomeFilter, setOutcomeFilter] = useState<string>('ALL');

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);

  // 1. Fetch available report files
  useEffect(() => {
    const fetchReportList = async () => {
      try {
        const res = await fetch('/api/backtest/reports');
        if (res.ok) {
          const json = await res.json();
          if (json.reports && json.reports.length > 0) {
            setReportFiles(json.reports);
            setSelectedFile(json.reports[0]);
          }
        }
      } catch (err) {
        console.warn('Could not fetch backtest report list:', err);
      }
    };
    fetchReportList();
  }, []);

  // 2. Fetch selected report JSON payload
  useEffect(() => {
    if (!selectedFile) return;
    const loadReport = async () => {
      setIsLoading(true);
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
      } finally {
        setIsLoading(false);
      }
    };
    loadReport();
  }, [selectedFile]);

  // 3. Render Lightweight-Chart for the selected day
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

    // Plot horizontal session levels
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

    // Trade markers (Arrows)
    if (dayData.trades && dayData.trades.length > 0) {
      const markers: any[] = [];
      dayData.trades.forEach((t) => {
        const openEpoch = Math.floor(new Date(t.signal_time_utc).getTime() / 1000);
        markers.push({
          time: openEpoch as UTCTimestamp,
          position: t.direction === 'BUY' ? 'belowBar' : 'aboveBar',
          color: t.direction === 'BUY' ? '#10b981' : '#ef4444',
          shape: t.direction === 'BUY' ? 'arrowUp' : 'arrowDown',
          text: `${t.direction} Leg ${t.leg} (${t.strategy})`,
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

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Header with File Selector */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-300 dark:border-[#1a2030]"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-black dark:text-white flex items-center gap-2.5">
            Backtest & Replay Suite
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
              Zero Look-Ahead
            </span>
          </h1>
          <p className="text-sm text-black dark:text-slate-400 mt-1">
            Audited historical execution data strictly served from static outputs. Live bot state is unaffected.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-xs font-bold text-slate-500">Report:</label>
          <select
            value={selectedFile}
            onChange={(e) => setSelectedFile(e.target.value)}
            className="px-3 py-1.5 rounded-xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-xs font-mono font-bold text-blue-600 dark:text-blue-400 cursor-pointer"
          >
            {reportFiles.length === 0 ? (
              <option value="">No reports found in backtest/output/</option>
            ) : (
              reportFiles.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))
            )}
          </select>

          {isLoading && <RefreshCw className="w-4 h-4 text-blue-500 animate-spin" />}
        </div>
      </motion.div>

      {/* 3 Navigation Sub-Tabs */}
      <div className="flex gap-2 border-b border-slate-200 dark:border-[#1a2030] pb-2">
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
          {/* Top KPI Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500">Filled Legs</div>
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

          {/* Strategy Breakdown Table */}
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

      {/* SUB-TAB 2: DAY CHART INSPECTOR */}
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

          {/* Trades table for that selected day */}
          <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
            <h4 className="text-xs font-bold text-black dark:text-white uppercase mb-3">
              Trades for {selectedDay} ({reportData?.day_data?.[selectedDay]?.trades?.length || 0} legs)
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                    <th className="py-2 px-3">Strategy</th>
                    <th className="py-2 px-3 text-center">Leg</th>
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
                      <td className="py-2.5 px-3 text-center">{t.leg}</td>
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

      {/* SUB-TAB 3: FULL TRADE LEDGER */}
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
                    <th className="py-3 px-3 text-center">Leg</th>
                    <th className="py-3 px-3 text-center">Dir</th>
                    <th className="py-3 px-3">Lots</th>
                    <th className="py-3 px-3">Entry</th>
                    <th className="py-3 px-3">SL</th>
                    <th className="py-3 px-3">TP</th>
                    <th className="py-3 px-3">Exit</th>
                    <th className="py-3 px-3">Reason</th>
                    <th className="py-3 px-3 text-center">R</th>
                    <th className="py-3 px-3 text-right">Net P&L</th>
                    <th className="py-3 px-3 text-center">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                  {filteredTrades.map((t: any, idx: number) => (
                    <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                      <td className="py-2.5 px-3 text-slate-400">{t.date}</td>
                      <td className="py-2.5 px-3 font-bold text-black dark:text-white">{t.strategy}</td>
                      <td className="py-2.5 px-3 text-center">{t.leg}</td>
                      <td className={`py-2.5 px-3 text-center font-bold ${t.direction === 'BUY' ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {t.direction}
                      </td>
                      <td className="py-2.5 px-3">{t.lots}</td>
                      <td className="py-2.5 px-3">{t.entry_price}</td>
                      <td className="py-2.5 px-3 text-rose-500">{t.sl}</td>
                      <td className="py-2.5 px-3 text-emerald-500">{t.tp}</td>
                      <td className="py-2.5 px-3">{t.exit_price}</td>
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