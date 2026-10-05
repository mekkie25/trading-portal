import React, { useState, useMemo, useEffect } from 'react';
import { motion } from 'motion/react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  ChartOptions,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { 
  TrendingUp, 
  Target, 
  Coins, 
  Wallet, 
  Sliders, 
  CheckCircle2, 
  Terminal,
  Zap,
  Activity,
  Calendar
} from 'lucide-react';
import { TopMetrics, BotSettings, ThemeMode, TradeRecord, StrategyExecutionMode } from '../../types';
import { formatCurrency } from '../../utils/currency';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

interface OpenPositionItem {
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
}

interface DashboardViewProps {
  metrics: TopMetrics;
  botSettings: BotSettings;
  trades?: TradeRecord[];
  onSaveBotSettings: (settings: BotSettings) => void;
  onQuickNavigate: (tab: any) => void;
  themeMode?: ThemeMode;
  brokerCurrency?: string;
  onOpenBridge?: () => void;
}

const STRATEGY_METADATA = [
  { id: "EMA_9_25_CROSS", name: "9/25 EMA Cross", asset: "Forex & Gold", desc: "Dynamic Crossover & Trail" },
  { id: "GRUBBER_KICK", name: "Grubber Kick", asset: "US30", desc: "3-Rule AMD Equilibrium Sweep" },
  { id: "STRATEGY_513", name: "513 Strategy", asset: "Multi-Asset", desc: "5/13 EMA Cross + Daily Flip" },
  { id: "ORB_LIQUIDITY_SWEEP", name: "ORB Liquidity Sweep", asset: "Multi-Asset", desc: "Asia High/Low Fakeout Reversal" },
  { id: "AVWAP_200EMA_CONTINUATION", name: "AVWAP / 200 EMA", asset: "Indices & Gold", desc: "Dynamic Trend Pullback Hold" },
  { id: "PDH_PDL_FAILED_BREAKOUT", name: "PDH/PDL Trap", asset: "Multi-Asset", desc: "Previous Daily High/Low Trap" },
  { id: "ORB_CRACKER", name: "ORB Cracker", asset: "NAS, US30, Gold", desc: "NYSE Open Counter-Sweep" },
  { id: "OES_4H_ORDER_BLOCK", name: "OES 4H Order Block", asset: "Multi-Asset", desc: "Institutional 4H Zone Retest" },
  { id: "MANUAL_TRADE", name: "Manual / Discretionary", asset: "All Pairs", desc: "Trader manual execution" },
];

export const DashboardView: React.FC<DashboardViewProps> = ({
  metrics,
  botSettings,
  trades = [],
  onSaveBotSettings,
  onQuickNavigate,
  themeMode = 'dark',
  brokerCurrency = 'USD',
  onOpenBridge,
}) => {
  const [formSettings, setFormSettings] = useState<BotSettings>(botSettings);
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const [openPositions, setOpenPositions] = useState<OpenPositionItem[]>([]);
  const [closingId, setClosingId] = useState<string | null>(null);

  React.useEffect(() => {
    setFormSettings(botSettings);
  }, [botSettings]);

  useEffect(() => {
    const pollPositions = async () => {
      try {
        const res = await fetch('/api/broker/telemetry');
        if (res.ok) {
          const json = await res.json();
          if (json.data && Array.isArray(json.data.openPositions)) {
            setOpenPositions(json.data.openPositions);
          }
        }
      } catch {}
    };
    pollPositions();
    const interval = setInterval(pollPositions, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleClosePosition = async (posId: string) => {
    setClosingId(posId);
    try {
      await fetch(`/api/positions/close/${posId}`, { method: 'POST' });
      setSaveToast(`Close order dispatched for Position #${posId}!`);
      setOpenPositions(prev => prev.filter(p => p.id !== posId));
    } catch {
      setSaveToast(`Failed to close Position #${posId}`);
    } finally {
      setTimeout(() => setSaveToast(null), 3500);
      setClosingId(null);
    }
  };

  const handleStrategyModeChange = (stratId: string, mode: StrategyExecutionMode) => {
    const updatedModes = {
      ...(formSettings.strategyModes || {}),
      [stratId]: mode
    };
    const updated = {
      ...formSettings,
      strategyModes: updatedModes
    };
    setFormSettings(updated);
    onSaveBotSettings(updated);
    setSaveToast(`${stratId} switched to ${mode}`);
    setTimeout(() => setSaveToast(null), 3000);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const now = new Date();
    const timestamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const updated = {
      ...formSettings,
      currency: brokerCurrency,
      lastAppliedTimestamp: timestamp,
    };
    onSaveBotSettings(updated);
    setSaveToast(`Daily trade limit saved at ${timestamp}!`);
    setTimeout(() => setSaveToast(null), 3500);
  };

  const isDark = themeMode === 'dark';

  const strategyStats = useMemo(() => {
    const statsMap: Record<string, { trades: number; wins: number; losses: number; pnl: number }> = {};
    STRATEGY_METADATA.forEach(s => {
      statsMap[s.id] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    });

    trades.forEach(t => {
      const id = t.strategy || 'MANUAL_TRADE';
      if (!statsMap[id]) statsMap[id] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
      statsMap[id].trades += 1;
      if (t.status === 'WIN') statsMap[id].wins += 1;
      if (t.status === 'LOSS') statsMap[id].losses += 1;
      statsMap[id].pnl += (t.pnl || 0);
    });

    return statsMap;
  }, [trades]);

  const chartData = useMemo(() => {
    const startingBal = metrics.totalInjections > 0 ? metrics.totalInjections : 10.0;
    const dailyMap = new Map<string, { dateLabel: string; netPnL: number; count: number }>();

    const sortedTrades = [...trades].filter(t => t.status !== 'OPEN').sort((a, b) => {
      return new Date(a.closeTime || a.openTime).getTime() - new Date(b.closeTime || b.openTime).getTime();
    });

    sortedTrades.forEach(tr => {
      const dateRaw = tr.closeTime || tr.openTime || new Date().toISOString();
      const dateKey = dateRaw.slice(0, 10);
      const dateObj = new Date(dateKey);
      const friendlyDate = isNaN(dateObj.getTime())
        ? dateKey
        : dateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, { dateLabel: friendlyDate, netPnL: 0, count: 0 });
      }
      const dayData = dailyMap.get(dateKey)!;
      dayData.netPnL += (tr.pnl || 0);
      dayData.count += 1;
    });

    const labels: string[] = ['Start'];
    const equityPoints: number[] = [startingBal];
    const pointColors: string[] = ['#3b82f6'];
    const pointRadii: number[] = [4];
    const dayStats: Array<{ pnl: number; count: number }> = [{ pnl: 0, count: 0 }];

    let runningEquity = startingBal;

    if (dailyMap.size === 0) {
      labels.push('Today');
      equityPoints.push(metrics.currentEquity > 0 ? metrics.currentEquity : startingBal);
      pointColors.push('#3b82f6');
      pointRadii.push(5);
      dayStats.push({ pnl: 0, count: 0 });
    } else {
      dailyMap.forEach((day) => {
        runningEquity += day.netPnL;
        const cleanEq = Number(runningEquity.toFixed(2));
        
        labels.push(day.dateLabel);
        equityPoints.push(cleanEq);
        dayStats.push({ pnl: day.netPnL, count: day.count });

        if (day.netPnL > 0) {
          pointColors.push('#10b981');
          pointRadii.push(7);
        } else if (day.netPnL < 0) {
          pointColors.push('#ef4444');
          pointRadii.push(7);
        } else {
          pointColors.push('#94a3b8');
          pointRadii.push(5);
        }
      });
    }

    return {
      labels,
      datasets: [
        {
          label: 'Daily Cumulative Equity',
          data: equityPoints,
          borderColor: '#2563eb',
          backgroundColor: (context: any) => {
            const chart = context.chart;
            const { ctx, chartArea } = chart;
            if (!chartArea) return null;
            const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            gradient.addColorStop(0, 'rgba(37, 99, 235, 0.28)');
            gradient.addColorStop(1, 'rgba(37, 99, 235, 0.0)');
            return gradient;
          },
          borderWidth: 2.5,
          pointBackgroundColor: pointColors,
          pointBorderColor: '#ffffff',
          pointBorderWidth: 2,
          pointRadius: pointRadii,
          pointHoverRadius: 8,
          fill: true,
          tension: 0.2,
          dayStats,
        } as any,
      ],
    };
  }, [trades, metrics.currentEquity, metrics.totalInjections]);

  const chartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items) => `Date: ${items[0]?.label}`,
          label: (context: any) => {
            const eq = context.parsed.y ?? 0;
            const idx = context.dataIndex;
            const dataset = context.dataset as any;
            const stat = dataset?.dayStats?.[idx];
            if (idx === 0) return ` Starting Capital: ${formatCurrency(eq, brokerCurrency)}`;
            const pnlStr = stat ? ` | Day P&L: ${stat.pnl >= 0 ? '+' : ''}${formatCurrency(stat.pnl, brokerCurrency)} (${stat.count} deals)` : '';
            return ` Equity: ${formatCurrency(eq, brokerCurrency)}${pnlStr}`;
          },
        },
      },
    },
    scales: {
      x: { grid: { color: isDark ? '#141a26' : '#e2e8f0' }, ticks: { color: isDark ? '#64748b' : '#000000', font: { weight: 'bold' } } },
      y: { grid: { color: isDark ? '#141a26' : '#e2e8f0' }, ticks: { color: isDark ? '#64748b' : '#000000', callback: (v) => `$${Number(v).toFixed(2)}` } },
    },
  };

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-8 max-w-7xl mx-auto">
      {saveToast && (
        <div className="fixed top-20 right-8 z-50 p-4 rounded-xl bg-blue-600 text-white shadow-xl flex items-center gap-2.5 text-xs font-semibold animate-in fade-in border border-blue-400">
          <CheckCircle2 className="w-4 h-4 text-emerald-300" />
          <span>{saveToast}</span>
        </div>
      )}

      {/* Header */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200 dark:border-[#1a2030]"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2.5">
            Trading Dashboard & Strategy Command
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
              Live Core
            </span>
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Real-time equity growth, goal pacing, and 3-way strategy execution controls.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onQuickNavigate('settings')}
            className="px-4 py-2 rounded-xl bg-white dark:bg-[#0f1118] hover:bg-slate-100 dark:hover:bg-[#141722] border border-slate-300 dark:border-[#1a2030] text-black dark:text-slate-300 text-xs font-semibold transition-colors flex items-center gap-2 cursor-pointer shadow-xs"
          >
            <Terminal className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
            <span>Broker API Config</span>
          </button>
        </div>
      </motion.div>

      {/* 4 Metric Cards */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6"
      >
        <div className="p-6 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-black dark:text-slate-400">
            <span className="text-xs font-semibold uppercase tracking-wider">Net Profit</span>
            <div className={`p-2.5 rounded-xl ${metrics.netProfit >= 0 ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-rose-500/10 text-rose-600'}`}>
              <TrendingUp className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-4">
            <div className={`text-3xl font-bold font-mono tracking-tight ${metrics.netProfit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600'}`}>
              {formatCurrency(metrics.netProfit, brokerCurrency)}
            </div>
            <div className="flex items-center gap-2 mt-2 text-xs font-mono text-slate-500">
              <span>Audited closed trades</span>
            </div>
          </div>
        </div>

        <div className="p-6 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-black dark:text-slate-400">
            <span className="text-xs font-semibold uppercase tracking-wider">Win Rate</span>
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <Target className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-4">
            <div className="text-3xl font-bold font-mono text-blue-600 dark:text-blue-400 tracking-tight">
              {metrics.winRate}%
            </div>
            <div className="flex items-center gap-2 mt-2 text-xs text-black dark:text-slate-400">
              <span className="font-mono text-black dark:text-slate-200 font-semibold">{metrics.totalTrades} Trades</span>
              <span>•</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-mono font-semibold">{metrics.winningTrades}W</span>
              <span>/</span>
              <span className="text-rose-600 font-mono font-semibold">{metrics.losingTrades}L</span>
            </div>
          </div>
        </div>

        <div className="p-6 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-black dark:text-slate-400">
            <span className="text-xs font-semibold uppercase tracking-wider">Total Injections</span>
            <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border border-indigo-500/20">
              <Coins className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-4">
            <div className="text-3xl font-bold font-mono text-black dark:text-white tracking-tight">
              {formatCurrency(metrics.totalInjections > 0 ? metrics.totalInjections : 10.0, brokerCurrency)}
            </div>
            <div className="flex items-center gap-2 mt-2 text-xs text-black dark:text-slate-400">
              <span>Deposited Base Capital</span>
            </div>
          </div>
        </div>

        <div className="p-6 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-black dark:text-slate-400">
            <span className="text-xs font-semibold uppercase tracking-wider">Live Account Equity</span>
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <Wallet className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-4">
            <div className="text-3xl font-bold font-mono text-blue-600 dark:text-blue-400 tracking-tight">
              {formatCurrency(metrics.currentEquity, brokerCurrency)}
            </div>
            <div className="flex items-center gap-2 mt-2 text-xs text-black dark:text-slate-400">
              <span>Balance: <strong className="font-mono text-black dark:text-slate-200">{formatCurrency(metrics.currentBalance, brokerCurrency)}</strong></span>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ACTIVE TRADES IN-FLIGHT (LIVE OPEN POSITIONS CARD) */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-6 space-y-4"
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-[#1a2030]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              <Activity className="w-4 h-4 animate-pulse" />
            </div>
            <div>
              <h2 className="text-base font-bold text-black dark:text-white tracking-tight flex items-center gap-2">
                Active In-Flight Positions (cTrader)
                <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 font-bold border border-emerald-500/20">
                  {openPositions.length} OPEN
                </span>
              </h2>
              <p className="text-xs text-black dark:text-slate-400">
                Live floating positions currently managed by the 80% R:R break-even supervisor.
              </p>
            </div>
          </div>
        </div>

        {openPositions.length === 0 ? (
          <div className="py-6 text-center text-xs text-slate-500 font-mono">
            No positions currently open. Engine is scanning all pairs.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                  <th className="py-2.5 px-3">Ticket / Pair</th>
                  <th className="py-2.5 px-3">Strategy</th>
                  <th className="py-2.5 px-3">Direction</th>
                  <th className="py-2.5 px-3">Lots</th>
                  <th className="py-2.5 px-3">Entry $\rightarrow$ Current</th>
                  <th className="py-2.5 px-3">Stop Loss</th>
                  <th className="py-2.5 px-3">Take Profit</th>
                  <th className="py-2.5 px-3 text-right">Floating P&L</th>
                  <th className="py-2.5 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                {openPositions.map((pos) => {
                  const isBuy = pos.direction === 'BUY';
                  const isProfit = pos.floatingPnL >= 0;
                  return (
                    <tr key={pos.id} className="hover:bg-slate-50 dark:hover:bg-[#121520] transition-colors">
                      <td className="py-3 px-3">
                        <div className="font-bold text-black dark:text-white">{pos.symbol}</div>
                        <div className="text-[10px] text-slate-500">{pos.ticket}</div>
                      </td>
                      <td className="py-3 px-3">
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                          {pos.strategy}
                        </span>
                      </td>
                      <td className="py-3 px-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          isBuy ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-600 border border-rose-500/20'
                        }`}>
                          {pos.direction}
                        </span>
                      </td>
                      <td className="py-3 px-3 font-bold text-black dark:text-white">{pos.lots}</td>
                      <td className="py-3 px-3">
                        <span>{pos.entry}</span> $\rightarrow$ <strong className="text-black dark:text-white">{pos.currentPrice}</strong>
                      </td>
                      <td className="py-3 px-3">
                        <span className={pos.isRiskFree ? 'text-emerald-500 font-bold' : 'text-rose-500'}>
                          {pos.sl || '--'} {pos.isRiskFree && '🛡️ (BE)'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-emerald-600 dark:text-emerald-400 font-bold">{pos.tp || '--'}</td>
                      <td className={`py-3 px-3 text-right font-bold text-sm ${isProfit ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {isProfit ? '+' : ''}${pos.floatingPnL.toFixed(2)}
                      </td>
                      <td className="py-3 px-3 text-right">
                        <button
                          type="button"
                          disabled={closingId === pos.id}
                          onClick={() => handleClosePosition(pos.id)}
                          className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold text-[10px] transition-all cursor-pointer shadow-xs disabled:opacity-50"
                        >
                          {closingId === pos.id ? 'Closing...' : 'Close Now'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </motion.div>

      {/* STRATEGY CONTROL CENTER & PERFORMANCE LEADERBOARD */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-6 space-y-4"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200 dark:border-[#1a2030]">
          <div>
            <h2 className="text-base font-bold text-black dark:text-white tracking-tight flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-500" />
              Strategy Performance & 3-Way Execution Mode Switch
            </h2>
            <p className="text-xs text-black dark:text-slate-400 mt-0.5">
              Tracks performance per strategy in real time. Switch any strategy between <strong className="text-emerald-600 dark:text-emerald-400">LIVE</strong>, <strong className="text-blue-600 dark:text-blue-400">SIMULATOR</strong>, or <strong className="text-rose-600">OFF</strong>.
            </p>
          </div>
          <span className="text-xs font-mono text-slate-500">Tracked by Strategy Name</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">
                <th className="py-3 px-3">Strategy Name</th>
                <th className="py-3 px-3">Target Asset</th>
                <th className="py-3 px-3 text-center">Execution Mode</th>
                <th className="py-3 px-3 text-center">Trades</th>
                <th className="py-3 px-3 text-center">Win Rate</th>
                <th className="py-3 px-3 text-right">Net P&L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
              {STRATEGY_METADATA.map((strat) => {
                const currentMode: StrategyExecutionMode = formSettings.strategyModes?.[strat.id] || 'LIVE';
                const stats = strategyStats[strat.id] || { trades: 0, wins: 0, losses: 0, pnl: 0 };
                const wr = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(0) : '0';

                return (
                  <tr key={strat.id} className="hover:bg-slate-50 dark:hover:bg-[#121520] transition-colors">
                    <td className="py-3 px-3">
                      <div className="font-bold text-black dark:text-white">{strat.name}</div>
                      <div className="text-[10px] text-slate-500">{strat.desc}</div>
                    </td>
                    <td className="py-3 px-3 font-mono font-semibold text-blue-600 dark:text-blue-400">
                      {strat.asset}
                    </td>
                    <td className="py-3 px-3 text-center">
                      <div className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                        <button
                          type="button"
                          onClick={() => handleStrategyModeChange(strat.id, 'LIVE')}
                          className={`px-2.5 py-1 rounded-lg text-[10px] font-bold font-mono transition-all cursor-pointer ${
                            currentMode === 'LIVE'
                              ? 'bg-emerald-600 text-white shadow-xs'
                              : 'text-slate-500 hover:text-black dark:hover:text-white'
                          }`}
                        >
                          LIVE
                        </button>
                        <button
                          type="button"
                          onClick={() => handleStrategyModeChange(strat.id, 'DRY_RUN')}
                          className={`px-2.5 py-1 rounded-lg text-[10px] font-bold font-mono transition-all cursor-pointer ${
                            currentMode === 'DRY_RUN'
                              ? 'bg-blue-600 text-white shadow-xs'
                              : 'text-slate-500 hover:text-black dark:hover:text-white'
                          }`}
                        >
                          SIMULATOR
                        </button>
                        <button
                          type="button"
                          onClick={() => handleStrategyModeChange(strat.id, 'OFF')}
                          className={`px-2.5 py-1 rounded-lg text-[10px] font-bold font-mono transition-all cursor-pointer ${
                            currentMode === 'OFF'
                              ? 'bg-rose-600 text-white shadow-xs'
                              : 'text-slate-500 hover:text-black dark:hover:text-white'
                          }`}
                        >
                          OFF
                        </button>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-center font-mono font-semibold text-black dark:text-white">
                      {stats.trades}
                    </td>
                    <td className="py-3 px-3 text-center font-mono font-semibold">
                      <span className={Number(wr) >= 50 ? 'text-emerald-600 dark:text-emerald-400 font-bold' : 'text-slate-400'}>
                        {wr}% ({stats.wins}W/{stats.losses}L)
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right font-mono font-bold">
                      <span className={stats.pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600'}>
                        {formatCurrency(stats.pnl, brokerCurrency)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </motion.div>

      {/* Main Split: Daily Grouped Equity Curve + Bot Target Controls */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="grid grid-cols-1 lg:grid-cols-12 gap-6"
      >
        <div className="lg:col-span-8 flex flex-col rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-[#1a2030] shrink-0">
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-base font-bold text-black dark:text-white tracking-tight flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-blue-600" />
                  Daily Cumulative Equity Trajectory
                </h2>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 font-bold">
                  DAILY PACED
                </span>
              </div>
              <p className="text-xs text-black dark:text-slate-400 mt-1">
                Timeline by trading day. <span className="text-emerald-500 font-bold">● Green Dot</span> = Profitable Day, <span className="text-rose-500 font-bold">● Red Dot</span> = Negative Day.
              </p>
            </div>

            <div className="flex items-center gap-3 text-xs font-mono">
              <span className="text-slate-500">Starting Balance: <strong className="text-black dark:text-white">{formatCurrency(metrics.totalInjections > 0 ? metrics.totalInjections : 10.0, brokerCurrency)}</strong></span>
            </div>
          </div>

          <div className="flex-1 w-full min-h-[320px] max-h-[380px] pt-4 relative">
            <Line data={chartData} options={chartOptions} />
          </div>

          <div className="grid grid-cols-3 gap-3 pt-4 mt-auto border-t border-slate-200 dark:border-[#1a2030] text-center text-xs shrink-0">
            <div className="p-3 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] text-black dark:text-slate-400 uppercase font-semibold">Total Deals</div>
              <div className="font-mono font-bold text-black dark:text-slate-300 mt-1">{trades.length} Deals</div>
            </div>
            <div className="p-3 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] text-black dark:text-slate-400 uppercase font-semibold">Current Balance</div>
              <div className="font-mono font-bold text-blue-600 dark:text-blue-400 mt-1">
                {formatCurrency(metrics.currentBalance, brokerCurrency)}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] text-black dark:text-slate-400 uppercase font-semibold">Net P&L</div>
              <div className={`font-mono font-bold mt-1 ${metrics.netProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                {formatCurrency(metrics.netProfit, brokerCurrency)}
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-4 flex flex-col rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-6">
          <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-[#1a2030] shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                <Sliders className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-base font-bold text-black dark:text-white tracking-tight">
                  Bot Target Controls
                </h2>
                <p className="text-[11px] text-black dark:text-slate-400">
                  Global risk limits and sizing rules
                </p>
              </div>
            </div>
          </div>

          <form onSubmit={handleSave} className="flex-1 flex flex-col justify-between mt-4 space-y-5">
            <div className="space-y-4">
              {/* Only Max Daily Trades is editable here. Risk %, R:R and Master
                  Execution live in Settings / the header kill switch. */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label className="text-black dark:text-slate-300 font-semibold flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 text-amber-500" /> Max Daily Trades Quota
                  </label>
                  <span className="font-mono text-xs font-bold text-amber-600 dark:text-amber-400">{formSettings.maxDailyTrades} Trades</span>
                </div>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={formSettings.maxDailyTrades}
                  onChange={(e) => setFormSettings({ ...formSettings, maxDailyTrades: parseInt(e.target.value, 10) || 4 })}
                  className="w-full px-3.5 py-2 bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] rounded-xl font-mono text-xs text-black dark:text-white"
                />
                <p className="text-[10px] text-slate-500 mt-1 leading-snug">
                  Hard cap per SAST calendar day. The bot stops opening new trades once this many have been filled.
                </p>
              </div>
            </div>

            <button
              type="submit"
              className="w-full py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-xs flex items-center justify-center gap-2 cursor-pointer mt-4"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Broadcast Custom Limits to Engine</span>
            </button>
          </form>
        </div>
      </motion.div>
    </div>
  );
};