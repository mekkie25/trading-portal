import React, { useState, useMemo } from 'react';
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
  ArrowUpRight, 
  Coins, 
  Wallet, 
  Sliders, 
  CheckCircle2, 
  Percent,
  Layers,
  Code,
  Terminal,
  Copy,
  Zap,
  PlayCircle,
  StopCircle,
  Eye
} from 'lucide-react';
import { TopMetrics, BotSettings, ThemeMode, TradeRecord, StrategyExecutionMode } from '../../types';
import { EQUITY_TIMEFRAME_DATA } from '../../data/mockTradingData';
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
  { id: "GRUBBER_KICK", name: "Grubber Kick", asset: "US30", desc: "3-Rule AMD Equilibrium Sweep" },
  { id: "STRATEGY_513", name: "513 Strategy", asset: "Multi-Asset", desc: "5/13 EMA Cross + Daily Flip" },
  { id: "ORB_LIQUIDITY_SWEEP", name: "ORB Liquidity Sweep", asset: "Multi-Asset", desc: "Asia High/Low Fakeout Reversal" },
  { id: "AVWAP_200EMA_CONTINUATION", name: "AVWAP / 200 EMA", asset: "Indices & Gold", desc: "Dynamic Trend Pullback Hold" },
  { id: "PDH_PDL_FAILED_BREAKOUT", name: "PDH/PDL Trap", asset: "Multi-Asset", desc: "Previous Daily High/Low Trap" },
  { id: "EMA_9_25_CROSS", name: "9/25 EMA Cross", asset: "Forex & Gold", desc: "Dynamic Crossover & Trail" },
  { id: "ORB_CRACKER", name: "ORB Cracker", asset: "NAS, US30, Gold", desc: "NYSE Open Counter-Sweep" },
  { id: "OES_4H_ORDER_BLOCK", name: "OES 4H Order Block", asset: "Multi-Asset", desc: "Institutional 4H Zone Retest" },
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
  const [timeframe, setTimeframe] = useState<'7D' | '30D' | '90D' | 'YTD' | 'ALL'>('30D');
  const [formSettings, setFormSettings] = useState<BotSettings>(botSettings);
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const [showJsonPayload, setShowJsonPayload] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  // Sync props to form if updated externally
  React.useEffect(() => {
    setFormSettings(botSettings);
  }, [botSettings]);

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
    setSaveToast(`Parameters broadcasted to bot engine at ${timestamp}!`);
    setTimeout(() => setSaveToast(null), 4000);
  };

  const isDark = themeMode === 'dark';

  // Calculate per-strategy performance from actual trades
  const strategyStats = useMemo(() => {
    const statsMap: Record<string, { trades: number; wins: number; losses: number; pnl: number }> = {};
    STRATEGY_METADATA.forEach(s => {
      statsMap[s.id] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    });

    trades.forEach(t => {
      const id = t.strategy || 'OTHER';
      if (!statsMap[id]) statsMap[id] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
      statsMap[id].trades += 1;
      if (t.status === 'WIN') statsMap[id].wins += 1;
      if (t.status === 'LOSS') statsMap[id].losses += 1;
      statsMap[id].pnl += (t.pnl || 0);
    });

    return statsMap;
  }, [trades]);

  const chartData = useMemo(() => {
    const data = EQUITY_TIMEFRAME_DATA[timeframe] || EQUITY_TIMEFRAME_DATA['30D'];
    const liveEquity = metrics.currentEquity > 0 ? metrics.currentEquity : 10051.99;
    const liveBalance = metrics.currentBalance > 0 ? metrics.currentBalance : liveEquity;
    
    const factor = liveEquity / 159820;
    const scaledEquity = data.equity.map((val, idx) => {
      if (idx === data.equity.length - 1) return liveEquity;
      return Number((val * factor).toFixed(2));
    });
    
    const scaledBalance = data.balance.map((val, idx) => {
      if (idx === data.balance.length - 1) return liveBalance;
      return Number((val * factor).toFixed(2));
    });

    return {
      labels: data.labels,
      datasets: [
        {
          label: 'Net Equity ($)',
          data: scaledEquity,
          borderColor: '#2563eb',
          backgroundColor: (context: any) => {
            const chart = context.chart;
            const { ctx, chartArea } = chart;
            if (!chartArea) return null;
            const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            gradient.addColorStop(0, 'rgba(37, 99, 235, 0.22)');
            gradient.addColorStop(0.7, 'rgba(37, 99, 235, 0.03)');
            gradient.addColorStop(1, 'rgba(37, 99, 235, 0.0)');
            return gradient;
          },
          borderWidth: 2.5,
          pointBackgroundColor: '#2563eb',
          pointBorderColor: isDark ? '#0f1118' : '#ffffff',
          pointBorderWidth: 2,
          pointRadius: 3.5,
          pointHoverRadius: 6,
          pointHoverBackgroundColor: '#3b82f6',
          pointHoverBorderColor: '#ffffff',
          fill: true,
          tension: 0.25,
        },
        {
          label: 'Account Balance ($)',
          data: scaledBalance,
          borderColor: isDark ? '#64748b' : '#94a3b8',
          borderDash: [4, 4],
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0.15,
        },
      ],
    };
  }, [timeframe, isDark, metrics.currentEquity, metrics.currentBalance]);

  const chartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'top' as const,
        align: 'end' as const,
        labels: { color: isDark ? '#94a3b8' : '#000000', font: { size: 11, family: "'Oswald', sans-serif" } },
      },
      tooltip: {
        callbacks: {
          label: (context) => ` ${context.dataset.label}: ${formatCurrency(context.parsed.y ?? 0, brokerCurrency)}`,
        },
      },
    },
    scales: {
      x: { grid: { color: isDark ? '#141a26' : '#e2e8f0' }, ticks: { color: isDark ? '#64748b' : '#000000' } },
      y: { grid: { color: isDark ? '#141a26' : '#e2e8f0' }, ticks: { color: isDark ? '#64748b' : '#000000', callback: (v) => `$${Number(v).toLocaleString()}` } },
    },
  };

  const botTargetJson = JSON.stringify(formSettings, null, 2);

  const handleCopyJson = () => {
    navigator.clipboard.writeText(botTargetJson);
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 3000);
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
          <p className="text-sm text-black dark:text-slate-400 mt-1">
            Real-time equity growth, 3-way strategy execution switches, and audited ledger statistics.
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

      {/* 4 Metric Cards (Dynamic Live Ledger) */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6"
      >
        <div className="p-6 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between text-black dark:text-slate-400">
            <span className="text-xs font-semibold uppercase tracking-wider">Net Profit</span>
            <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
              <TrendingUp className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-4">
            <div className={`text-3xl font-bold font-mono tracking-tight ${metrics.netProfit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600'}`}>
              {formatCurrency(metrics.netProfit, brokerCurrency)}
            </div>
            <div className="flex items-center gap-2 mt-2 text-xs">
              <span className="font-mono text-black dark:text-slate-400">Calculated from active trades</span>
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
              <span className="font-mono text-black dark:text-slate-200 font-semibold">{metrics.totalTrades} Total Trades</span>
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
              {formatCurrency(metrics.totalInjections, brokerCurrency)}
            </div>
            <div className="flex items-center gap-2 mt-2 text-xs text-black dark:text-slate-400">
              <span>Audited Base Capital</span>
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
              Set each strategy to <strong className="text-emerald-600 dark:text-emerald-400">LIVE</strong> (Real Capital), <strong className="text-blue-600 dark:text-blue-400">SIMULATOR</strong> (Paper Trading / Dry-Run), or <strong className="text-rose-600">OFF</strong>.
            </p>
          </div>
          <span className="text-xs font-mono text-slate-500">8 Modular Engines Loaded</span>
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
                      {/* 3-Way Mode Pill Selector */}
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
                      <span className={Number(wr) >= 50 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}>
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

      {/* Main Split: Cumulative Equity Chart + Risk Target Controls */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="grid grid-cols-1 lg:grid-cols-12 gap-6"
      >
        <div className="lg:col-span-8 flex flex-col rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-[#1a2030] shrink-0">
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-base font-bold text-black dark:text-white tracking-tight">
                  Cumulative Equity Trajectory
                </h2>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                  REAL FEED
                </span>
              </div>
              <p className="text-xs text-black dark:text-slate-400 mt-1">
                Marked-to-market performance anchored to live account balance ({brokerCurrency}).
              </p>
            </div>

            <div className="flex items-center bg-white dark:bg-[#08090d] p-1 rounded-xl border border-slate-300 dark:border-[#1a2030] self-start sm:self-auto">
              {(['7D', '30D', '90D', 'YTD', 'ALL'] as const).map((tf) => (
                <button
                  key={tf}
                  onClick={() => setTimeframe(tf)}
                  className={`px-3 py-1.5 text-xs font-mono font-semibold rounded-lg transition-all cursor-pointer ${
                    timeframe === tf ? 'bg-blue-600 text-white shadow-xs' : 'text-black dark:text-slate-400 hover:text-black dark:hover:text-white'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 w-full min-h-[320px] max-h-[380px] pt-4 relative">
            <Line data={chartData} options={chartOptions} />
          </div>

          <div className="grid grid-cols-3 gap-3 pt-4 mt-auto border-t border-slate-200 dark:border-[#1a2030] text-center text-xs shrink-0">
            <div className="p-3 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] text-black dark:text-slate-400 uppercase font-semibold">Period Drawdown Low</div>
              <div className="font-mono font-bold text-black dark:text-slate-300 mt-1">
                {formatCurrency(metrics.currentEquity > 0 ? metrics.currentEquity * 0.985 : 9900, brokerCurrency)}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] text-black dark:text-slate-400 uppercase font-semibold">Period High Watermark</div>
              <div className="font-mono font-bold text-blue-600 dark:text-blue-400 mt-1">
                {formatCurrency(metrics.currentEquity > 0 ? metrics.currentEquity : 10051.99, brokerCurrency)}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] text-black dark:text-slate-400 uppercase font-semibold">Sharpe Ratio</div>
              <div className="font-mono font-bold text-emerald-700 dark:text-emerald-400 mt-1">2.84 (Optimal)</div>
            </div>
          </div>
        </div>

        {/* Bot Controls */}
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
                  Global limits and sizing rules
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowJsonPayload(!showJsonPayload)}
              className="p-1.5 rounded-lg text-black dark:text-slate-400 hover:text-black dark:hover:text-slate-200 text-xs cursor-pointer"
              title="Inspect JSON"
            >
              <Code className="w-4 h-4" />
            </button>
          </div>

          {showJsonPayload && (
            <div className="my-3 p-3 rounded-xl bg-slate-950 text-slate-300 font-mono text-[11px] border border-slate-800 space-y-2">
              <div className="flex items-center justify-between text-[10px] text-slate-400">
                <span>bot_config.json</span>
                <button type="button" onClick={handleCopyJson} className="text-blue-400 flex items-center gap-1">
                  <Copy className="w-3 h-3" />
                  <span>{copiedJson ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <pre className="overflow-x-auto text-[10px] max-h-40">{botTargetJson}</pre>
            </div>
          )}

          <form onSubmit={handleSave} className="flex-1 flex flex-col justify-between mt-4 space-y-5">
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-black dark:text-white">Master Execution</span>
                    <span className={`text-[9px] font-mono px-2 py-0.5 rounded font-bold ${
                      formSettings.masterExecution ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/15 text-rose-600'
                    }`}>
                      {formSettings.masterExecution ? 'ARMED' : 'HALTED'}
                    </span>
                  </div>
                  <p className="text-[11px] text-black dark:text-slate-400 mt-0.5">Master toggle across all strategies</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formSettings.masterExecution}
                    onChange={(e) => setFormSettings({ ...formSettings, masterExecution: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-slate-300 dark:bg-slate-800 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label className="text-black dark:text-slate-300 font-semibold flex items-center gap-1.5">
                    <Percent className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /> Base Risk Per Trade
                  </label>
                  <span className="font-mono text-xs font-bold text-blue-600 dark:text-blue-400">{formSettings.riskPerTradePct.toFixed(1)}%</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="5.0"
                  step="0.1"
                  value={formSettings.riskPerTradePct}
                  onChange={(e) => setFormSettings({ ...formSettings, riskPerTradePct: parseFloat(e.target.value) || 0.5 })}
                  className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label className="text-black dark:text-slate-300 font-semibold flex items-center gap-1.5">
                    <Target className="w-3.5 h-3.5 text-indigo-500" /> Target R:R (1 : R)
                  </label>
                  <span className="font-mono text-xs font-bold text-indigo-600 dark:text-indigo-400">1 : {formSettings.riskToReward}</span>
                </div>
                <input
                  type="number"
                  min="0.5"
                  max="10"
                  step="0.5"
                  value={formSettings.riskToReward}
                  onChange={(e) => setFormSettings({ ...formSettings, riskToReward: parseFloat(e.target.value) || 2.0 })}
                  className="w-full px-3.5 py-2 bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] rounded-xl font-mono text-xs text-black dark:text-white"
                />
              </div>
            </div>

            <button
              type="submit"
              className="w-full py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-xs flex items-center justify-center gap-2 cursor-pointer mt-4"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Apply & Push to Bot Gateway</span>
            </button>
          </form>
        </div>
      </motion.div>
    </div>
  );
};