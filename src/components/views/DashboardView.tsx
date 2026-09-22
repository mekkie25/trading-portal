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
  Zap,
  Percent,
  Layers,
  Shield,
  Code,
  Terminal,
  Copy,
  Activity
} from 'lucide-react';
import { TopMetrics, BotSettings, ThemeMode } from '../../types';
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
  onSaveBotSettings: (settings: BotSettings) => void;
  onQuickNavigate: (tab: any) => void;
  themeMode?: ThemeMode;
  brokerCurrency?: string;
  onOpenBridge?: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  metrics,
  botSettings,
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
  const [appliedNotice, setAppliedNotice] = useState<{
    timestamp: string;
    settings: BotSettings;
  } | null>(() => {
    if (botSettings.lastAppliedTimestamp) {
      return {
        timestamp: botSettings.lastAppliedTimestamp,
        settings: botSettings,
      };
    }
    return {
      timestamp: 'Initial Active',
      settings: botSettings,
    };
  });

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
    setAppliedNotice({
      timestamp,
      settings: updated,
    });
    setSaveToast(`Parameters broadcasted to MT5 / VS Code bot gateway successfully at ${timestamp}!`);
    setTimeout(() => setSaveToast(null), 4000);
  };

  const isDark = themeMode === 'dark';

  const chartData = useMemo(() => {
    const data = EQUITY_TIMEFRAME_DATA[timeframe];
    return {
      labels: data.labels,
      datasets: [
        {
          label: 'Net Equity ($)',
          data: data.equity,
          borderColor: '#2563eb', // Royal blue
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
          data: data.balance,
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
  }, [timeframe, isDark]);

  const chartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        position: 'top' as const,
        align: 'end' as const,
        labels: {
          color: isDark ? '#94a3b8' : '#000000',
          font: {
            size: 11,
            family: "'Oswald', 'Bebas Neue', sans-serif",
          },
          boxWidth: 12,
          boxHeight: 2,
          usePointStyle: false,
        },
      },
      tooltip: {
        backgroundColor: isDark ? '#08090d' : '#ffffff',
        titleColor: isDark ? '#ffffff' : '#000000',
        bodyColor: isDark ? '#94a3b8' : '#000000',
        borderColor: isDark ? '#1a2030' : '#cbd5e1',
        borderWidth: 1,
        padding: 12,
        cornerRadius: 10,
        bodyFont: {
          family: "'Oswald', 'Bebas Neue', sans-serif",
          size: 11,
        },
        titleFont: {
          family: "'Oswald', 'Bebas Neue', sans-serif",
          weight: 'bold',
          size: 12,
        },
        callbacks: {
          label: (context) => {
            const val = context.parsed.y;
            return ` ${context.dataset.label}: ${formatCurrency(val ?? 0, brokerCurrency)}`;
          },
        },
      },
    },
    scales: {
      x: {
        grid: {
          color: isDark ? '#141a26' : '#e2e8f0',
        },
        ticks: {
          color: isDark ? '#64748b' : '#000000',
          font: {
            family: "'Oswald', 'Bebas Neue', sans-serif",
            size: 10,
          },
        },
      },
      y: {
        grid: {
          color: isDark ? '#141a26' : '#e2e8f0',
        },
        ticks: {
          color: isDark ? '#64748b' : '#000000',
          font: {
            family: "'Oswald', 'Bebas Neue', sans-serif",
            size: 10,
          },
          callback: (value) => `$${Number(value).toLocaleString()}`,
        },
      },
    },
  };

  const dollarRisk = (metrics.currentEquity * formSettings.riskPerTradePct) / 100;

  const botTargetJson = JSON.stringify({
    master_execution: formSettings.masterExecution,
    risk_per_trade_pct: formSettings.riskPerTradePct,
    risk_to_reward_ratio: formSettings.riskToReward,
    max_daily_trades: formSettings.maxDailyTrades,
    trailing_stop: formSettings.trailingStopActive,
    auto_breakeven_pips: formSettings.autoBreakevenPips,
    timestamp: new Date().toISOString(),
  }, null, 2);

  const handleCopyJson = () => {
    navigator.clipboard.writeText(botTargetJson);
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 3000);
  };

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-8 max-w-7xl mx-auto">
      {/* Toast */}
      {saveToast && (
        <div className="fixed top-20 right-8 z-50 p-4 rounded-xl bg-blue-600 text-white shadow-xl flex items-center gap-2.5 text-xs font-semibold animate-in fade-in slide-in-from-top-2 border border-blue-400">
          <CheckCircle2 className="w-4 h-4 text-emerald-300" />
          <span>{saveToast}</span>
        </div>
      )}

      {/* View Header with generous negative space */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200 dark:border-[#1a2030]"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2.5">
            Trading Dashboard & Bot Command
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
              Live MT5 Core
            </span>
          </h1>
          <p className="text-sm text-black dark:text-slate-400 mt-1">
            Real-time equity growth, audited win telemetry, and live execution target controls.
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

      {/* Top 4 Primary Metric Cards (Pure white bubbles in light mode with clear borders) */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4 }}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6"
      >
        {/* Metric 1: Net Profit */}
        <div className="p-6 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs flex flex-col justify-between transition-all hover:border-blue-500/40">
          <div className="flex items-center justify-between text-black dark:text-slate-400">
            <span className="text-xs font-semibold uppercase tracking-wider">Net Profit</span>
            <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
              <TrendingUp className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-4">
            <div className="text-3xl font-bold font-mono text-black dark:text-white tracking-tight">
              {metrics.netProfit >= 0 ? '+' : ''}{formatCurrency(metrics.netProfit, brokerCurrency)}
            </div>
            <div className="flex items-center gap-2 mt-2 text-xs">
              <span className="flex items-center font-mono font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded">
                <ArrowUpRight className="w-3.5 h-3.5 mr-0.5" />
                +{metrics.netProfitPct}%
              </span>
              <span className="text-black dark:text-slate-400">vs All-time deposits</span>
            </div>
          </div>
        </div>

        {/* Metric 2: Win Rate */}
        <div className="p-6 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs flex flex-col justify-between transition-all hover:border-blue-500/40">
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
              <span className="font-mono text-black dark:text-slate-200 font-semibold">
                {metrics.totalTrades} Total Trades
              </span>
              <span>•</span>
              <span className="text-emerald-700 dark:text-emerald-400 font-mono font-semibold">{metrics.winningTrades}W</span>
              <span>/</span>
              <span className="text-rose-600 font-mono font-semibold">{metrics.losingTrades}L</span>
            </div>
          </div>
        </div>

        {/* Metric 3: Total Injections */}
        <div className="p-6 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs flex flex-col justify-between transition-all hover:border-blue-500/40">
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
              <span>Base Capital Injected</span>
              <span>•</span>
              <span className="font-mono">Audited</span>
            </div>
          </div>
        </div>

        {/* Metric 4: Current Live Equity */}
        <div className="p-6 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs flex flex-col justify-between transition-all hover:border-blue-500/40">
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
              <span>•</span>
              <span className="text-emerald-700 dark:text-emerald-400 font-mono font-semibold">
                {metrics.unrealizedPnL >= 0 ? '+' : ''}{formatCurrency(metrics.unrealizedPnL, brokerCurrency)} Floating
              </span>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Main Split: Cumulative Equity Chart + Bot Controls & Risk Panel */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.45 }}
        className="grid grid-cols-1 lg:grid-cols-12 gap-6"
      >
        {/* Cumulative Equity Chart */}
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
                Marked-to-market performance tracked against closed ledger balance ({brokerCurrency}).
              </p>
            </div>

            {/* Timeframe selector buttons */}
            <div className="flex items-center bg-white dark:bg-[#08090d] p-1 rounded-xl border border-slate-300 dark:border-[#1a2030] self-start sm:self-auto">
              {(['7D', '30D', '90D', 'YTD', 'ALL'] as const).map((tf) => (
                <button
                  key={tf}
                  onClick={() => setTimeframe(tf)}
                  className={`px-3 py-1.5 text-xs font-mono font-semibold rounded-lg transition-all cursor-pointer ${
                    timeframe === tf
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'text-black dark:text-slate-400 hover:text-black dark:hover:text-slate-200'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>

          {/* Cleanly bounded chart container */}
          <div className="flex-1 w-full min-h-[320px] max-h-[380px] pt-4 relative">
            <Line data={chartData} options={chartOptions} />
          </div>

          {/* Quick stats footer */}
          <div className="grid grid-cols-3 gap-3 pt-4 mt-auto border-t border-slate-200 dark:border-[#1a2030] text-center text-xs shrink-0">
            <div className="p-3 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] text-black dark:text-slate-400 uppercase font-semibold">Period Drawdown Low</div>
              <div className="font-mono font-bold text-black dark:text-slate-300 mt-1">{formatCurrency(138200, brokerCurrency)}</div>
            </div>
            <div className="p-3 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] text-black dark:text-slate-400 uppercase font-semibold">Period High Watermark</div>
              <div className="font-mono font-bold text-blue-600 dark:text-blue-400 mt-1">{formatCurrency(159820.5, brokerCurrency)}</div>
            </div>
            <div className="p-3 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] shadow-xs">
              <div className="text-[10px] text-black dark:text-slate-400 uppercase font-semibold">Sharpe Ratio</div>
              <div className="font-mono font-bold text-emerald-700 dark:text-emerald-400 mt-1">2.84 (Optimal)</div>
            </div>
          </div>
        </div>

        {/* Bot Controls & Risk Target Panel */}
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
                  Direct algorithmic parameters for MT5 EA
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowJsonPayload(!showJsonPayload)}
              className="p-1.5 rounded-lg text-black dark:text-slate-400 hover:text-black dark:hover:text-slate-200 text-xs border border-transparent hover:border-slate-300 dark:hover:border-[#1a2030] transition-colors cursor-pointer"
              title="Inspect JSON Payload"
            >
              <Code className="w-4 h-4" />
            </button>
          </div>

          {showJsonPayload && (
            <div className="my-3 p-3 rounded-xl bg-slate-950 text-slate-300 font-mono text-[11px] border border-slate-800 space-y-2 animate-in fade-in">
              <div className="flex items-center justify-between text-[10px] text-slate-400">
                <span>POST /api/bot/targets payload</span>
                <button
                  type="button"
                  onClick={handleCopyJson}
                  className="text-blue-400 hover:text-blue-300 flex items-center gap-1 cursor-pointer"
                >
                  <Copy className="w-3 h-3" />
                  <span>{copiedJson ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <pre className="overflow-x-auto text-[10px]">{botTargetJson}</pre>
            </div>
          )}

          <form onSubmit={handleSave} className="flex-1 flex flex-col justify-between mt-4 space-y-5">
            <div className="space-y-4">
              {/* Master Execution Switch */}
              <div className="p-4 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] flex items-center justify-between shadow-xs">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-black dark:text-white">
                      Master Execution Switch
                    </span>
                    <span
                      className={`text-[9px] font-mono px-2 py-0.5 rounded font-bold ${
                        formSettings.masterExecution
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
                          : 'bg-rose-500/15 text-rose-600 border border-rose-500/30'
                      }`}
                    >
                      {formSettings.masterExecution ? 'ARMED' : 'HALTED'}
                    </span>
                  </div>
                  <p className="text-[11px] text-black dark:text-slate-400 mt-0.5">
                    Permits bot to open automated orders on broker
                  </p>
                </div>

                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formSettings.masterExecution}
                    onChange={(e) =>
                      setFormSettings({ ...formSettings, masterExecution: e.target.checked })
                    }
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-slate-300 dark:bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600 shadow-inner"></div>
                </label>
              </div>

              {/* Risk Per Trade (%) */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label className="text-black dark:text-slate-300 font-semibold flex items-center gap-1.5">
                    <Percent className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                    Risk Per Trade Allocation (0% – 100%)
                  </label>
                  <span className="font-mono text-xs font-bold text-blue-600 dark:text-blue-400">
                    {formSettings.riskPerTradePct.toFixed(1)}%
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="0.5"
                    value={formSettings.riskPerTradePct}
                    onChange={(e) =>
                      setFormSettings({
                        ...formSettings,
                        riskPerTradePct: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                  <div className="flex items-center gap-1 shrink-0">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={formSettings.riskPerTradePct}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        setFormSettings({
                          ...formSettings,
                          riskPerTradePct: isNaN(val) ? 0 : Math.min(100, Math.max(0, val)),
                        });
                      }}
                      className="w-16 px-2.5 py-1 bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] rounded-lg text-right font-mono text-xs text-black dark:text-white focus:border-blue-500 focus:outline-none"
                    />
                    <span className="text-xs font-mono text-slate-500">%</span>
                  </div>
                </div>
                <p className="text-[11px] text-black dark:text-slate-400">
                  Exact Stop Loss risk: <strong className="font-mono text-black dark:text-slate-300">{formatCurrency((metrics.currentEquity * formSettings.riskPerTradePct) / 100, brokerCurrency)}</strong> per trade
                </p>
              </div>

              {/* Risk-To-Reward Target (1 : X typed physically) */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <label className="text-black dark:text-slate-300 font-semibold flex items-center gap-1.5">
                    <Target className="w-3.5 h-3.5 text-indigo-500" />
                    Risk-To-Reward Target (1 : R)
                  </label>
                  <span className="font-mono text-xs font-bold text-indigo-600 dark:text-indigo-400">
                    1 : {formSettings.riskToReward}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="px-3 py-2 bg-slate-100 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] rounded-xl font-mono text-xs font-bold text-black dark:text-slate-300 shrink-0">
                    1 :
                  </span>
                  <input
                    type="number"
                    min="0.1"
                    max="100"
                    step="0.1"
                    value={formSettings.riskToReward}
                    onChange={(e) =>
                      setFormSettings({
                        ...formSettings,
                        riskToReward: parseFloat(e.target.value) || 1,
                      })
                    }
                    placeholder="Type custom R:R (e.g. 2, 5, 10, 100)"
                    className="flex-1 px-3.5 py-2 bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] rounded-xl font-mono text-xs text-black dark:text-white focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                  <span className="text-[10px] text-slate-500">Quick presets:</span>
                  {[1.5, 2.0, 3.0, 5.0, 10.0, 20.0, 50.0, 100.0].map((rr) => (
                    <button
                      type="button"
                      key={rr}
                      onClick={() => setFormSettings({ ...formSettings, riskToReward: rr })}
                      className={`px-2 py-0.5 rounded text-[10px] font-mono transition-all cursor-pointer ${
                        formSettings.riskToReward === rr
                          ? 'bg-blue-600 text-white font-bold'
                          : 'bg-slate-100 dark:bg-slate-800 text-black dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                      }`}
                    >
                      1:{rr}
                    </button>
                  ))}
                </div>
              </div>

              {/* Max Daily Trades quota (physically typed in) */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label className="text-black dark:text-slate-300 font-semibold flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                    Maximum Daily Trades Quota
                  </label>
                  <span className="font-mono text-xs font-bold text-blue-600 dark:text-blue-400">
                    {formSettings.maxDailyTrades} Trades
                  </span>
                </div>
                <input
                  type="number"
                  min="1"
                  max="500"
                  value={formSettings.maxDailyTrades}
                  onChange={(e) =>
                    setFormSettings({
                      ...formSettings,
                      maxDailyTrades: parseInt(e.target.value, 10) || 1,
                    })
                  }
                  placeholder="Type quota (e.g. 5, 10, 20, 50)"
                  className="w-full px-3.5 py-2 bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] rounded-xl font-mono text-xs text-black dark:text-white focus:border-blue-500 focus:outline-none"
                />
                <p className="text-[11px] text-black dark:text-slate-400">
                  Intraday circuit lockout once quota is reached.
                </p>
              </div>

              {/* Active Values Chosen Confirmation Display */}
              {appliedNotice && (
                <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 font-bold text-xs text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      Values Chosen & Active for Bot Controls
                    </span>
                    <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
                      {appliedNotice.timestamp}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 font-mono text-[11px] text-black dark:text-slate-200">
                    <div className="p-2 rounded-lg bg-white/70 dark:bg-black/40 border border-emerald-500/20">
                      <div className="text-[9px] uppercase text-slate-500">Risk %</div>
                      <div className="font-bold text-blue-600 dark:text-blue-400">{appliedNotice.settings.riskPerTradePct}%</div>
                    </div>
                    <div className="p-2 rounded-lg bg-white/70 dark:bg-black/40 border border-emerald-500/20">
                      <div className="text-[9px] uppercase text-slate-500">Target R:R</div>
                      <div className="font-bold text-indigo-600 dark:text-indigo-400">1 : {appliedNotice.settings.riskToReward}</div>
                    </div>
                    <div className="p-2 rounded-lg bg-white/70 dark:bg-black/40 border border-emerald-500/20">
                      <div className="text-[9px] uppercase text-slate-500">Max Trades</div>
                      <div className="font-bold text-black dark:text-white">{appliedNotice.settings.maxDailyTrades}</div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-black dark:text-slate-400 pt-0.5">
                    <span>Execution: <strong className={appliedNotice.settings.masterExecution ? 'text-emerald-600 font-bold' : 'text-rose-600 font-bold'}>{appliedNotice.settings.masterExecution ? 'ARMED' : 'HALTED'}</strong></span>
                    <span>Broker Currency: <strong className="font-mono font-bold text-emerald-600">{brokerCurrency}</strong></span>
                  </div>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="pt-3 space-y-2">
              <button
                type="submit"
                id="apply-bot-parameters-btn"
                className="w-full py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-xs flex items-center justify-center gap-2 cursor-pointer"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Apply & Push to Bot Gateway</span>
              </button>

              {onOpenBridge && (
                <button
                  type="button"
                  onClick={onOpenBridge}
                  className="w-full py-2.5 px-4 rounded-xl bg-white hover:bg-slate-100 dark:bg-[#08090d] dark:hover:bg-[#141722] border border-slate-300 dark:border-[#1a2030] text-black dark:text-slate-300 font-semibold text-xs transition-colors flex items-center justify-center gap-2 cursor-pointer shadow-xs"
                >
                  <Terminal className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                  <span>Connect VS Code & Broker Live Bridge</span>
                </button>
              )}
            </div>
          </form>
        </div>
      </motion.div>
    </div>
  );
};
