/**
 * LiveSimReplay.tsx
 *
 * Live Bot Replay tab. Drives the single-account portfolio simulation and
 * renders the results.
 *
 * Includes:
 *   - Controls: balance, currency, ZAR rate, days, profile, pairs.
 *   - Report: headline KPIs, per-pair contribution, equity curve, daily
 *     equity, skip story, and a filterable Trading Journal.
 *   - Export: JSON download and "Copy for AI" clipboard buttons.
 *
 * Backed by four endpoints on server.ts:
 *   POST /api/backtest/live-sim
 *   GET  /api/backtest/live-sim/status
 *   GET  /api/backtest/live-sim/report
 *   POST /api/backtest/live-sim/stop
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import {
  Play, Square, RefreshCw, TrendingUp, Activity,
  Wallet, Info, AlertCircle, ChevronDown, ChevronRight,
  FileText, Users, BarChart3, Download, Copy, Check, Search,
} from 'lucide-react';
import { ThemeMode } from '../../types';

interface LiveSimReplayProps {
  themeMode?: ThemeMode;
  brokerCurrency?: string;
}

interface PerPairRow {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  net_pnl: number;
  win_rate: number;
  profit_factor: number;
}

interface LiveSimCombo {
  combo_label: string;
  mode?: string;
  be?: string;
  trail?: string;
  rr_override?: number | null;

  starting_balance_usd: number;
  final_equity: number;
  net_pnl: number;
  net_pnl_pct: number;
  peak_drawdown: number;
  max_consecutive_losses: number;

  total_trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  win_rate: number;
  profit_factor: number;
  expectancy_r: number;
  max_dd_money: number;
  run_seconds?: number;

  per_pair: Record<string, PerPairRow>;
  equity_curve: Array<{ trade_n: number; time: string; equity: number }>;
  daily_equity: Array<{ date: string; open_equity: number; close_equity: number; pnl: number; trades: number }>;
  all_trades: Array<any>;
  skip_summary: {
    total: number;
    by_reason: Record<string, number>;
    by_pair: Record<string, number>;
    by_strategy: Record<string, number>;
  };

  error?: string;
}

interface LiveSimReport {
  generated_at: string;
  days: number;
  symbols: string[];
  starting_balance_input: number;
  currency: string;
  zar_per_usd: number;
  profile_name: string;
  starting_balance_usd: number;
  total_seconds: number;
  combos: LiveSimCombo[];
}

interface LiveSimStatus {
  isRunning: boolean;
  progress: string;
  lastError: string | null;
  params: any;
}

type JournalSort = 'date_desc' | 'date_asc' | 'pnl_desc' | 'pnl_asc' | 'r_desc' | 'r_asc';

const WHITELIST_ASSETS = ['US30', 'GOLD', 'NAS100', 'GERMAN30', 'EURUSD', 'GBPUSD', 'USDJPY'];

// --------------------------------------------------------------------------
// Equity curve mini-chart
// --------------------------------------------------------------------------
const EquityCurveMini: React.FC<{
  data: Array<{ trade_n: number; equity: number; time: string }>;
  startingBalance: number;
}> = ({ data, startingBalance }) => {
  if (!data || data.length === 0) {
    return <div className="text-[11px] text-slate-500 text-center py-6">No equity points.</div>;
  }
  const width = 800;
  const height = 200;
  const padding = 24;
  const equities = data.map(d => d.equity);
  const minEq = Math.min(...equities, startingBalance);
  const maxEq = Math.max(...equities, startingBalance);
  const span = Math.max(1e-9, maxEq - minEq);
  const stepX = (width - 2 * padding) / Math.max(1, data.length - 1);

  const points = data.map((d, i) => {
    const x = padding + i * stepX;
    const y = height - padding - ((d.equity - minEq) / span) * (height - 2 * padding);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');

  const startY = height - padding - ((startingBalance - minEq) / span) * (height - 2 * padding);
  const finalY = height - padding - ((equities[equities.length - 1] - minEq) / span) * (height - 2 * padding);
  const isProfit = equities[equities.length - 1] >= startingBalance;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-48" preserveAspectRatio="none">
      <line
        x1={padding} y1={startY} x2={width - padding} y2={startY}
        stroke="#64748b" strokeWidth="1" strokeDasharray="4 4" opacity="0.5"
      />
      <polyline
        points={points}
        fill="none"
        stroke={isProfit ? '#10b981' : '#ef4444'}
        strokeWidth="2"
      />
      <circle
        cx={width - padding}
        cy={finalY}
        r="4"
        fill={isProfit ? '#10b981' : '#ef4444'}
      />
    </svg>
  );
};

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------
export const LiveSimReplay: React.FC<LiveSimReplayProps> = ({
  themeMode = 'dark',
  brokerCurrency = 'USD',
}) => {
  const [startingBalance, setStartingBalance] = useState<string>('170');
  const [currency, setCurrency] = useState<'USD' | 'ZAR'>('ZAR');
  const [zarRate, setZarRate] = useState<string>('18');
  const [days, setDays] = useState<number>(365);
  const [profile, setProfile] = useState<string>('Max Growth');
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([...WHITELIST_ASSETS]);

  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const [report, setReport] = useState<LiveSimReport | null>(null);
  const [isLoadingReport, setIsLoadingReport] = useState<boolean>(false);
  const [selectedComboIdx, setSelectedComboIdx] = useState<number>(0);
  const [expandedSection, setExpandedSection] = useState<string>('equity');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');

  // Journal filters
  const [journalSearch, setJournalSearch] = useState<string>('');
  const [journalPairFilter, setJournalPairFilter] = useState<string>('ALL');
  const [journalResultFilter, setJournalResultFilter] = useState<string>('ALL');
  const [journalSort, setJournalSort] = useState<JournalSort>('date_desc');
  const [journalLimit, setJournalLimit] = useState<number>(100);

  // -------- Fetch report --------
  const fetchReport = useCallback(async () => {
    setIsLoadingReport(true);
    try {
      const res = await fetch('/api/backtest/live-sim/report');
      if (res.ok) {
        const json = await res.json();
        setReport(json.data || null);
      } else {
        setReport(null);
      }
    } catch {
      setReport(null);
    } finally {
      setIsLoadingReport(false);
    }
  }, []);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  // -------- Poll while running --------
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/backtest/live-sim/status');
        if (!res.ok) return;
        const json: LiveSimStatus = await res.json();
        if (json.progress) setProgress(json.progress);
        if (json.lastError) setError(json.lastError);
        if (!json.isRunning) {
          setIsRunning(false);
          await fetchReport();
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [isRunning, fetchReport]);

  // -------- Handlers --------
  const toggleSymbol = (sym: string) => {
    setSelectedSymbols(prev =>
      prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym]
    );
  };

  const usdEquivalent = useMemo(() => {
    const bal = parseFloat(startingBalance);
    if (!Number.isFinite(bal)) return 0;
    if (currency === 'ZAR') {
      const rate = parseFloat(zarRate);
      if (!Number.isFinite(rate) || rate <= 0) return 0;
      return bal / rate;
    }
    return bal;
  }, [startingBalance, currency, zarRate]);

  const handleRun = async () => {
    if (isRunning) return;
    if (selectedSymbols.length === 0) { setError('Select at least one pair.'); return; }
    const bal = parseFloat(startingBalance);
    if (!Number.isFinite(bal) || bal < 1) { setError('Starting balance must be a number >= 1.'); return; }
    const rate = parseFloat(zarRate);
    if (currency === 'ZAR' && (!Number.isFinite(rate) || rate <= 0)) { setError('ZAR rate must be > 0.'); return; }

    setIsRunning(true);
    setError(null);
    setProgress('Launching live bot replay...');

    try {
      const res = await fetch('/api/backtest/live-sim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols: selectedSymbols,
          days,
          balance: bal,
          currency,
          zarRate: currency === 'ZAR' ? rate : 18,
          profile,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.message || 'Failed to start live bot replay.');
        setIsRunning(false);
      }
    } catch (e: any) {
      setError(`Network error: ${e?.message || e}`);
      setIsRunning(false);
    }
  };

  const handleStop = async () => {
    try {
      await fetch('/api/backtest/live-sim/stop', { method: 'POST' });
      setIsRunning(false);
      setProgress('Cancelled.');
    } catch {}
  };

  const handleExportJson = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `live_sim_${report.days}d_${report.currency}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyForAI = async () => {
    if (!report) return;
    const lines: string[] = [];
    lines.push(`LIVE BOT REPLAY REPORT`);
    lines.push(`Generated: ${report.generated_at}`);
    lines.push(`Days: ${report.days} | Pairs: ${report.symbols.join(', ')}`);
    lines.push(`Starting balance: ${report.starting_balance_input} ${report.currency} (~$${report.starting_balance_usd} USD) | Profile: ${report.profile_name}`);
    lines.push('');

    for (const combo of report.combos) {
      lines.push('='.repeat(72));
      lines.push(`COMBO: ${combo.combo_label}`);
      if (combo.error) { lines.push(`  ERROR: ${combo.error}`); lines.push(''); continue; }

      lines.push(`  Final equity: $${combo.final_equity} (from $${combo.starting_balance_usd})`);
      lines.push(`  Net P&L: $${combo.net_pnl} (${combo.net_pnl_pct}%)`);
      lines.push(`  Peak DD: -$${combo.peak_drawdown} | Max loss streak: ${combo.max_consecutive_losses}`);
      lines.push(`  Trades: ${combo.total_trades} | W/L/BE: ${combo.wins}/${combo.losses}/${combo.breakeven}`);
      lines.push(`  Win rate: ${combo.win_rate}% | PF: ${combo.profit_factor} | Expectancy: ${combo.expectancy_r}R`);
      lines.push('');
      lines.push(`  Per-pair:`);
      for (const [sym, row] of Object.entries(combo.per_pair)) {
        if (row.trades === 0) continue;
        lines.push(`    ${sym.padEnd(10)} TR ${String(row.trades).padStart(4)} | W ${String(row.wins).padStart(3)} | L ${String(row.losses).padStart(3)} | WR ${String(row.win_rate).padStart(5)}% | PF ${String(row.profit_factor).padStart(5)} | $${row.net_pnl}`);
      }
      lines.push('');
      lines.push(`  Skip summary: ${combo.skip_summary.total} rejections`);
      const byReason = Object.entries(combo.skip_summary.by_reason)
        .sort((a, b) => (b[1] as number) - (a[1] as number))
        .slice(0, 10);
      for (const [r, v] of byReason) lines.push(`    ${r}: ${v}`);
      lines.push('');
    }

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 2500);
    } catch {}
  };

  // -------- Journal derived --------
  const selectedCombo = report?.combos?.[selectedComboIdx] ?? null;

  const journalTrades = useMemo(() => {
    if (!selectedCombo || !Array.isArray(selectedCombo.all_trades)) return [];
    let list = [...selectedCombo.all_trades];

    if (journalPairFilter !== 'ALL') {
      list = list.filter((t: any) => t.symbol === journalPairFilter);
    }
    if (journalResultFilter !== 'ALL') {
      list = list.filter((t: any) => t.result === journalResultFilter);
    }
    if (journalSearch.trim()) {
      const q = journalSearch.toLowerCase();
      list = list.filter((t: any) =>
        String(t.strategy || '').toLowerCase().includes(q) ||
        String(t.symbol || '').toLowerCase().includes(q) ||
        String(t.trade_id || '').toLowerCase().includes(q)
      );
    }

    list.sort((a: any, b: any) => {
      if (journalSort === 'date_desc') return String(b.signal_time_utc || '').localeCompare(String(a.signal_time_utc || ''));
      if (journalSort === 'date_asc') return String(a.signal_time_utc || '').localeCompare(String(b.signal_time_utc || ''));
      if (journalSort === 'pnl_desc') return (b.money_pnl || 0) - (a.money_pnl || 0);
      if (journalSort === 'pnl_asc') return (a.money_pnl || 0) - (b.money_pnl || 0);
      if (journalSort === 'r_desc') return (b.r_multiple || 0) - (a.r_multiple || 0);
      if (journalSort === 'r_asc') return (a.r_multiple || 0) - (b.r_multiple || 0);
      return 0;
    });

    return list;
  }, [selectedCombo, journalPairFilter, journalResultFilter, journalSearch, journalSort]);

  const journalStats = useMemo(() => {
    if (journalTrades.length === 0) return { count: 0, wins: 0, losses: 0, be: 0, net: 0, win_rate: 0 };
    let wins = 0, losses = 0, be = 0, net = 0;
    for (const t of journalTrades) {
      if (t.result === 'WIN') wins++;
      else if (t.result === 'LOSS') losses++;
      else be++;
      net += Number(t.money_pnl || 0);
    }
    return {
      count: journalTrades.length,
      wins,
      losses,
      be,
      net,
      win_rate: (wins / journalTrades.length) * 100,
    };
  }, [journalTrades]);

  const journalPairsAvailable = useMemo(() => {
    if (!selectedCombo || !Array.isArray(selectedCombo.all_trades)) return [];
    const s = new Set<string>();
    for (const t of selectedCombo.all_trades) {
      if (t.symbol) s.add(String(t.symbol));
    }
    return Array.from(s).sort();
  }, [selectedCombo]);

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Controls */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] p-5 space-y-4"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <Wallet className="w-4 h-4 text-emerald-500" />
          <h2 className="text-sm font-bold text-black dark:text-white">
            Live Bot Replay
          </h2>
          <span className="text-[10px] font-mono text-slate-500 px-2 py-0.5 rounded bg-slate-100 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
            One account · All pairs · One risk profile
          </span>
        </div>

        <p className="text-xs text-slate-600 dark:text-slate-400">
          Replays the live bot over the selected window with a single equity. All
          selected pairs share the same daily cap, the same streak counter, the same
          drawdown throttles. Every trade is sized off current equity and updates
          on close. This is the mode that answers: <em>what would the live bot have
          actually done on a single starting balance?</em>
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              Starting Balance
            </label>
            <input
              type="number" step="any" min="1"
              value={startingBalance}
              onChange={(e) => setStartingBalance(e.target.value)}
              disabled={isRunning}
              placeholder="Any value >= 1"
              className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] text-xs font-mono text-black dark:text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
            {currency === 'ZAR' && usdEquivalent > 0 && (
              <div className="text-[10px] font-mono text-slate-500">
                ≈ ${usdEquivalent.toFixed(2)} USD at {zarRate} ZAR/USD
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              Currency
            </label>
            <div className="flex gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
              {(['USD', 'ZAR'] as const).map(c => (
                <button
                  key={c} type="button"
                  onClick={() => setCurrency(c)}
                  disabled={isRunning}
                  className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-colors cursor-pointer disabled:opacity-50 ${
                    currency === c
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-600 dark:text-slate-400 hover:text-black dark:hover:text-white'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              ZAR / USD
            </label>
            <input
              type="number" step="0.1" min="0.1"
              value={zarRate}
              onChange={(e) => setZarRate(e.target.value)}
              disabled={isRunning || currency !== 'ZAR'}
              className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] text-xs font-mono text-black dark:text-white focus:outline-none focus:border-blue-500 disabled:opacity-40"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              Days
            </label>
            <select
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value, 10))}
              disabled={isRunning}
              className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] text-xs font-mono text-black dark:text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
            >
              <option value={60}>60</option>
              <option value={90}>90</option>
              <option value={180}>180</option>
              <option value={365}>365</option>
              <option value={500}>500</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              Risk Profile
            </label>
            <select
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              disabled={isRunning}
              className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] text-xs font-mono text-black dark:text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
            >
              <option value="Max Growth">Max Growth</option>
              <option value="Aggressive">Aggressive</option>
              <option value="Balanced">Balanced</option>
              <option value="Steady">Steady</option>
              <option value="None">None (flat 1%)</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              Action
            </label>
            {!isRunning ? (
              <button
                type="button" onClick={handleRun}
                className="w-full px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Run Live Bot Replay</span>
              </button>
            ) : (
              <button
                type="button" onClick={handleStop}
                className="w-full px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors"
              >
                <Square className="w-3.5 h-3.5" />
                <span>Stop</span>
              </button>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              Pairs ({selectedSymbols.length} of {WHITELIST_ASSETS.length})
            </label>
            <div className="flex gap-1.5">
              <button
                type="button" onClick={() => setSelectedSymbols([...WHITELIST_ASSETS])}
                disabled={isRunning}
                className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] text-slate-600 dark:text-slate-300 cursor-pointer disabled:opacity-50"
              >
                All
              </button>
              <button
                type="button" onClick={() => setSelectedSymbols([])}
                disabled={isRunning}
                className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] text-slate-600 dark:text-slate-300 cursor-pointer disabled:opacity-50"
              >
                None
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
            {WHITELIST_ASSETS.map(sym => {
              const on = selectedSymbols.includes(sym);
              return (
                <button
                  key={sym} type="button"
                  onClick={() => toggleSymbol(sym)}
                  disabled={isRunning}
                  className={`px-3 py-2 rounded-xl text-xs font-mono font-bold border transition-colors cursor-pointer disabled:opacity-50 ${
                    on
                      ? 'bg-blue-600/15 border-blue-500/40 text-blue-700 dark:text-blue-300'
                      : 'bg-slate-50 dark:bg-[#08090d] border-slate-300 dark:border-[#1a2030] text-slate-600 dark:text-slate-400 hover:border-slate-400'
                  }`}
                >
                  {sym}
                </button>
              );
            })}
          </div>
        </div>

        {isRunning && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-blue-500/10 border border-blue-500/30 text-xs text-blue-700 dark:text-blue-300">
            <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span className="font-mono">{progress || 'Working...'}</span>
          </div>
        )}

        {error && !isRunning && (
          <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-700 dark:text-rose-300">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="font-mono break-words">{error}</span>
          </div>
        )}
      </motion.div>

      {/* Report */}
      {report && report.combos && report.combos.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] p-5 space-y-4"
        >
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-sm font-bold text-black dark:text-white flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-emerald-500" />
              Results
            </h3>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-3 text-[10px] font-mono text-slate-500 mr-2">
                <span>{report.generated_at}</span>
                <span>·</span>
                <span>{report.days}d</span>
                <span>·</span>
                <span>start {report.starting_balance_input} {report.currency}</span>
                <span>·</span>
                <span>{report.profile_name}</span>
              </div>
              <button
                type="button" onClick={handleExportJson}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export JSON</span>
              </button>
              <button
                type="button" onClick={handleCopyForAI}
                className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-[11px] font-bold flex items-center gap-1.5 cursor-pointer"
              >
                {copyStatus === 'copied' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copyStatus === 'copied' ? 'Copied' : 'Copy for AI'}</span>
              </button>
            </div>
          </div>

          {/* Combo tabs */}
          <div className="flex flex-wrap gap-1.5">
            {report.combos.map((c, i) => (
              <button
                key={i} type="button"
                onClick={() => setSelectedComboIdx(i)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-mono font-bold border transition-colors cursor-pointer ${
                  selectedComboIdx === i
                    ? 'bg-emerald-600 text-white border-emerald-600'
                    : 'bg-white dark:bg-[#08090d] text-slate-600 dark:text-slate-300 border-slate-300 dark:border-[#1a2030] hover:border-slate-400'
                }`}
              >
                {c.combo_label}
                {c.error && <span className="ml-1 text-rose-400">!</span>}
              </button>
            ))}
          </div>

          {selectedCombo?.error ? (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-700 dark:text-rose-300 font-mono">
              <strong>Combo failed:</strong> {selectedCombo.error}
            </div>
          ) : selectedCombo ? (
            <>
              {/* Headline KPIs */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                  <div className="text-[10px] uppercase font-bold text-slate-500">Final Equity</div>
                  <div className={`text-lg font-bold font-mono mt-1 ${
                    selectedCombo.final_equity >= selectedCombo.starting_balance_usd ? 'text-emerald-500' : 'text-rose-500'
                  }`}>
                    ${selectedCombo.final_equity.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    from ${selectedCombo.starting_balance_usd.toFixed(2)}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                  <div className="text-[10px] uppercase font-bold text-slate-500">Net P&amp;L</div>
                  <div className={`text-lg font-bold font-mono mt-1 ${
                    selectedCombo.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'
                  }`}>
                    {selectedCombo.net_pnl >= 0 ? '+' : ''}${selectedCombo.net_pnl.toFixed(2)}
                  </div>
                  <div className={`text-[10px] font-mono mt-0.5 ${
                    selectedCombo.net_pnl_pct >= 0 ? 'text-emerald-500' : 'text-rose-500'
                  }`}>
                    {selectedCombo.net_pnl_pct >= 0 ? '+' : ''}{selectedCombo.net_pnl_pct.toFixed(2)}%
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                  <div className="text-[10px] uppercase font-bold text-slate-500">Peak Drawdown</div>
                  <div className="text-lg font-bold font-mono mt-1 text-rose-500">
                    -${selectedCombo.peak_drawdown.toFixed(2)}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                  <div className="text-[10px] uppercase font-bold text-slate-500">Max Loss Streak</div>
                  <div className="text-lg font-bold font-mono mt-1 text-amber-500">
                    {selectedCombo.max_consecutive_losses}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                  <div className="text-[10px] uppercase font-bold text-slate-500">Total Trades</div>
                  <div className="text-base font-bold font-mono mt-1">{selectedCombo.total_trades}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                  <div className="text-[10px] uppercase font-bold text-slate-500">Win Rate</div>
                  <div className={`text-base font-bold font-mono mt-1 ${selectedCombo.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {selectedCombo.win_rate}%
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                  <div className="text-[10px] uppercase font-bold text-slate-500">Profit Factor</div>
                  <div className="text-base font-bold font-mono mt-1">{selectedCombo.profit_factor}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                  <div className="text-[10px] uppercase font-bold text-slate-500">W / L / BE</div>
                  <div className="text-base font-bold font-mono mt-1">
                    {selectedCombo.wins}/{selectedCombo.losses}/{selectedCombo.breakeven}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                  <div className="text-[10px] uppercase font-bold text-slate-500">Run Time</div>
                  <div className="text-base font-bold font-mono mt-1">
                    {selectedCombo.run_seconds != null ? `${selectedCombo.run_seconds}s` : '—'}
                  </div>
                </div>
              </div>

              {/* Per-pair table */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-black dark:text-white flex items-center gap-2">
                  <Users className="w-3.5 h-3.5 text-blue-500" />
                  Per-Pair Contribution
                </h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs font-mono">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                        <th className="py-2 px-3">Pair</th>
                        <th className="py-2 px-3 text-center">Trades</th>
                        <th className="py-2 px-3 text-center">W</th>
                        <th className="py-2 px-3 text-center">L</th>
                        <th className="py-2 px-3 text-center">Win %</th>
                        <th className="py-2 px-3 text-center">PF</th>
                        <th className="py-2 px-3 text-right">Net P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                      {Object.entries(selectedCombo.per_pair).map(([sym, row]) => (
                        <tr key={sym} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                          <td className="py-2 px-3 font-bold text-black dark:text-white">{sym}</td>
                          <td className="py-2 px-3 text-center">{row.trades}</td>
                          <td className="py-2 px-3 text-center text-emerald-500">{row.wins}</td>
                          <td className="py-2 px-3 text-center text-rose-500">{row.losses}</td>
                          <td className="py-2 px-3 text-center">{row.win_rate}%</td>
                          <td className="py-2 px-3 text-center">{row.profit_factor}</td>
                          <td className={`py-2 px-3 text-right font-bold ${
                            row.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'
                          }`}>
                            {row.net_pnl >= 0 ? '+' : ''}${row.net_pnl.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Equity curve */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setExpandedSection(expandedSection === 'equity' ? '' : 'equity')}
                  className="flex items-center gap-2 text-xs font-bold text-black dark:text-white cursor-pointer"
                >
                  {expandedSection === 'equity' ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
                  Equity Curve ({selectedCombo.equity_curve.length} points)
                </button>
                {expandedSection === 'equity' && (
                  <div className="rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] p-3">
                    <EquityCurveMini
                      data={selectedCombo.equity_curve}
                      startingBalance={selectedCombo.starting_balance_usd}
                    />
                  </div>
                )}
              </div>

              {/* Daily table */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setExpandedSection(expandedSection === 'daily' ? '' : 'daily')}
                  className="flex items-center gap-2 text-xs font-bold text-black dark:text-white cursor-pointer"
                >
                  {expandedSection === 'daily' ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <Activity className="w-3.5 h-3.5 text-blue-500" />
                  Daily Equity ({selectedCombo.daily_equity.length} days)
                </button>
                {expandedSection === 'daily' && (
                  <div className="rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] max-h-72 overflow-y-auto">
                    <table className="w-full text-left text-[11px] font-mono">
                      <thead className="sticky top-0 bg-slate-100 dark:bg-[#0f1118]">
                        <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[9px] uppercase font-bold text-slate-500">
                          <th className="py-1.5 px-3">Date</th>
                          <th className="py-1.5 px-3 text-right">Open</th>
                          <th className="py-1.5 px-3 text-right">Close</th>
                          <th className="py-1.5 px-3 text-right">P&amp;L</th>
                          <th className="py-1.5 px-3 text-center">Trades</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                        {selectedCombo.daily_equity.map(d => (
                          <tr key={d.date} className="hover:bg-slate-100 dark:hover:bg-[#121520]">
                            <td className="py-1.5 px-3 text-slate-600 dark:text-slate-300">{d.date}</td>
                            <td className="py-1.5 px-3 text-right">${d.open_equity.toFixed(2)}</td>
                            <td className="py-1.5 px-3 text-right">${d.close_equity.toFixed(2)}</td>
                            <td className={`py-1.5 px-3 text-right font-bold ${
                              d.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'
                            }`}>
                              {d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}
                            </td>
                            <td className="py-1.5 px-3 text-center">{d.trades}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Skip summary */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setExpandedSection(expandedSection === 'skip' ? '' : 'skip')}
                  className="flex items-center gap-2 text-xs font-bold text-black dark:text-white cursor-pointer"
                >
                  {expandedSection === 'skip' ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <Info className="w-3.5 h-3.5 text-amber-500" />
                  Skip Story ({selectedCombo.skip_summary.total} rejections)
                </button>
                {expandedSection === 'skip' && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] p-3">
                      <div className="text-[10px] uppercase font-bold text-slate-500 mb-2">By Reason</div>
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {Object.entries(selectedCombo.skip_summary.by_reason)
                          .sort((a, b) => (b[1] as number) - (a[1] as number))
                          .map(([k, v]) => (
                            <div key={k} className="flex items-center justify-between text-[10px] font-mono gap-2">
                              <span className="text-slate-600 dark:text-slate-300 truncate">{k}</span>
                              <span className="text-black dark:text-white font-bold shrink-0">{v}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                    <div className="rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] p-3">
                      <div className="text-[10px] uppercase font-bold text-slate-500 mb-2">By Pair</div>
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {Object.entries(selectedCombo.skip_summary.by_pair)
                          .sort((a, b) => (b[1] as number) - (a[1] as number))
                          .map(([k, v]) => (
                            <div key={k} className="flex items-center justify-between text-[10px] font-mono">
                              <span className="text-slate-600 dark:text-slate-300">{k}</span>
                              <span className="text-black dark:text-white font-bold">{v}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                    <div className="rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] p-3">
                      <div className="text-[10px] uppercase font-bold text-slate-500 mb-2">By Strategy</div>
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {Object.entries(selectedCombo.skip_summary.by_strategy)
                          .sort((a, b) => (b[1] as number) - (a[1] as number))
                          .map(([k, v]) => (
                            <div key={k} className="flex items-center justify-between text-[10px] font-mono gap-2">
                              <span className="text-slate-600 dark:text-slate-300 truncate">{k}</span>
                              <span className="text-black dark:text-white font-bold shrink-0">{v}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Trading Journal */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setExpandedSection(expandedSection === 'journal' ? '' : 'journal')}
                  className="flex items-center gap-2 text-xs font-bold text-black dark:text-white cursor-pointer"
                >
                  {expandedSection === 'journal' ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <FileText className="w-3.5 h-3.5 text-purple-500" />
                  Trading Journal ({selectedCombo.all_trades.length} trades)
                </button>

                {expandedSection === 'journal' && (
                  <div className="space-y-3">
                    {/* Filter bar */}
                    <div className="flex flex-col lg:flex-row lg:items-center gap-2 p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                      <div className="relative flex-1">
                        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={journalSearch}
                          onChange={(e) => setJournalSearch(e.target.value)}
                          placeholder="Search trade ID or strategy..."
                          className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-xs font-mono text-black dark:text-white focus:outline-none focus:border-blue-500"
                        />
                      </div>
                      <select
                        value={journalPairFilter}
                        onChange={(e) => setJournalPairFilter(e.target.value)}
                        className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-xs font-mono text-black dark:text-white focus:outline-none focus:border-blue-500 cursor-pointer"
                      >
                        <option value="ALL">All Pairs</option>
                        {journalPairsAvailable.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                      <select
                        value={journalResultFilter}
                        onChange={(e) => setJournalResultFilter(e.target.value)}
                        className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-xs font-mono text-black dark:text-white focus:outline-none focus:border-blue-500 cursor-pointer"
                      >
                        <option value="ALL">All Results</option>
                        <option value="WIN">Wins only</option>
                        <option value="LOSS">Losses only</option>
                        <option value="BREAKEVEN">Breakeven only</option>
                      </select>
                      <select
                        value={journalSort}
                        onChange={(e) => setJournalSort(e.target.value as JournalSort)}
                        className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-xs font-mono text-black dark:text-white focus:outline-none focus:border-blue-500 cursor-pointer"
                      >
                        <option value="date_desc">Newest first</option>
                        <option value="date_asc">Oldest first</option>
                        <option value="pnl_desc">P&amp;L: high → low</option>
                        <option value="pnl_asc">P&L: low → high</option>
                        <option value="r_desc">R: high → low</option>
                        <option value="r_asc">R: low → high</option>
                      </select>
                    </div>

                    {/* Journal summary strip */}
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-[11px] font-mono">
                      <div className="p-2 rounded-lg bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                        <div className="text-[9px] uppercase text-slate-500">Matched</div>
                        <div className="font-bold text-black dark:text-white">{journalStats.count}</div>
                      </div>
                      <div className="p-2 rounded-lg bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                        <div className="text-[9px] uppercase text-slate-500">Win Rate</div>
                        <div className={`font-bold ${journalStats.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>
                          {journalStats.win_rate.toFixed(1)}%
                        </div>
                      </div>
                      <div className="p-2 rounded-lg bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                        <div className="text-[9px] uppercase text-slate-500">W / L / BE</div>
                        <div className="font-bold text-black dark:text-white">
                          {journalStats.wins}/{journalStats.losses}/{journalStats.be}
                        </div>
                      </div>
                      <div className="p-2 rounded-lg bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030]">
                        <div className="text-[9px] uppercase text-slate-500">Net P&amp;L</div>
                        <div className={`font-bold ${journalStats.net >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                          {journalStats.net >= 0 ? '+' : ''}${journalStats.net.toFixed(2)}
                        </div>
                      </div>
                      <div className="p-2 rounded-lg bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] flex items-center justify-between">
                        <div>
                          <div className="text-[9px] uppercase text-slate-500">Show</div>
                          <select
                            value={journalLimit}
                            onChange={(e) => setJournalLimit(parseInt(e.target.value, 10))}
                            className="bg-transparent text-xs font-mono font-bold text-black dark:text-white focus:outline-none cursor-pointer"
                          >
                            <option value={50}>50</option>
                            <option value={100}>100</option>
                            <option value={250}>250</option>
                            <option value={500}>500</option>
                            <option value={100000}>All</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* Table */}
                    <div className="rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] max-h-96 overflow-auto">
                      <table className="w-full text-left text-[11px] font-mono">
                        <thead className="sticky top-0 bg-slate-100 dark:bg-[#0f1118] z-10">
                          <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[9px] uppercase font-bold text-slate-500">
                            <th className="py-1.5 px-2">Date</th>
                            <th className="py-1.5 px-2">Pair</th>
                            <th className="py-1.5 px-2">Strategy</th>
                            <th className="py-1.5 px-2">Dir</th>
                            <th className="py-1.5 px-2 text-right">Entry</th>
                            <th className="py-1.5 px-2 text-right">Exit</th>
                            <th className="py-1.5 px-2 text-right">SL</th>
                            <th className="py-1.5 px-2 text-right">TP</th>
                            <th className="py-1.5 px-2 text-center">R</th>
                            <th className="py-1.5 px-2 text-right">P&amp;L</th>
                            <th className="py-1.5 px-2 text-center">Reason</th>
                            <th className="py-1.5 px-2 text-center">Result</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                          {journalTrades.slice(0, journalLimit).map((tr: any, i: number) => (
                            <tr key={i} className="hover:bg-slate-100 dark:hover:bg-[#121520]">
                              <td className="py-1.5 px-2 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                                {tr.signal_time_sast ? String(tr.signal_time_sast).slice(0, 16) : (tr.date_sast || '')}
                              </td>
                              <td className="py-1.5 px-2 font-bold text-black dark:text-white">{tr.symbol || ''}</td>
                              <td className="py-1.5 px-2 text-slate-600 dark:text-slate-300">{tr.strategy || ''}</td>
                              <td className={`py-1.5 px-2 font-bold ${tr.direction === 'BUY' ? 'text-emerald-500' : 'text-rose-500'}`}>
                                {tr.direction}
                              </td>
                              <td className="py-1.5 px-2 text-right">{Number(tr.entry_price || 0).toFixed(2)}</td>
                              <td className="py-1.5 px-2 text-right">{Number(tr.exit_price || 0).toFixed(2)}</td>
                              <td className="py-1.5 px-2 text-right text-rose-500">{Number(tr.sl || 0).toFixed(2)}</td>
                              <td className="py-1.5 px-2 text-right text-emerald-500">{Number(tr.tp || 0).toFixed(2)}</td>
                              <td className={`py-1.5 px-2 text-center font-bold ${
                                (tr.r_multiple || 0) >= 0 ? 'text-emerald-500' : 'text-rose-500'
                              }`}>
                                {Number(tr.r_multiple || 0).toFixed(2)}
                              </td>
                              <td className={`py-1.5 px-2 text-right font-bold ${
                                (tr.money_pnl || 0) >= 0 ? 'text-emerald-500' : 'text-rose-500'
                              }`}>
                                {Number(tr.money_pnl || 0).toFixed(2)}
                              </td>
                              <td className="py-1.5 px-2 text-center text-slate-600 dark:text-slate-300 whitespace-nowrap">
                                {tr.exit_reason || ''}
                              </td>
                              <td className="py-1.5 px-2 text-center">
                                <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                                  tr.result === 'WIN' ? 'bg-emerald-500/15 text-emerald-500'
                                    : tr.result === 'LOSS' ? 'bg-rose-500/15 text-rose-500'
                                    : 'bg-slate-500/15 text-slate-500'
                                }`}>
                                  {tr.result || ''}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {journalTrades.length > journalLimit && (
                        <div className="text-center text-[10px] font-mono text-slate-500 py-2 border-t border-slate-200 dark:border-[#1a2030]">
                          Showing {journalLimit} of {journalTrades.length}. Increase the "Show" limit above to see more.
                        </div>
                      )}
                      {journalTrades.length === 0 && (
                        <div className="text-center text-[11px] font-mono text-slate-500 py-6">
                          No trades match the current filters.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : null}
        </motion.div>
      )}

      {/* Empty state */}
      {!report && !isRunning && !isLoadingReport && (
        <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center">
          <Wallet className="w-8 h-8 mx-auto text-slate-400 mb-3" />
          <div className="text-sm font-bold text-black dark:text-white mb-1">No live bot replay yet</div>
          <div className="text-xs text-slate-500 max-w-xl mx-auto">
            Configure the parameters above and click <strong>Run Live Bot Replay</strong>.
            The bot will walk the last N days with a single account, one risk profile,
            and all selected pairs sharing the same daily cap and equity.
          </div>
        </div>
      )}
    </div>
  );
};