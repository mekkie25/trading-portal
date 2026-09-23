import React, { useState } from 'react';
import { motion } from 'motion/react';
import { 
  ShieldAlert, 
  AlertTriangle, 
  Lock, 
  Flame, 
  CheckCircle2, 
  RotateCcw, 
  Sliders, 
  Activity, 
  Zap,
  Info,
  PowerOff,
  ShieldCheck,
  Calendar,
  Clock,
  Layers,
  Ban
} from 'lucide-react';
import { AdvancedLimits, ThemeMode } from '../../types';

interface AdvancedLimitsViewProps {
  limits: AdvancedLimits;
  onUpdateLimits: (limits: AdvancedLimits) => void;
  currentEquity: number;
  themeMode?: ThemeMode;
  onHaltBot?: (halted: boolean) => void;
}

export const AdvancedLimitsView: React.FC<AdvancedLimitsViewProps> = ({
  limits,
  onUpdateLimits,
  currentEquity,
  themeMode = 'dark',
  onHaltBot,
}) => {
  const [formLimits, setFormLimits] = useState<AdvancedLimits>(limits);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Synchronize local form when parent limits change
  React.useEffect(() => {
    setFormLimits(limits);
  }, [limits]);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateLimits(formLimits);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  // Simulate breaker trip for daily, weekly, or monthly
  const handleSimulateBreakerTrip = (scope: 'DAY' | 'WEEK' | 'MONTH') => {
    let reason = '';
    let updated: AdvancedLimits = { ...formLimits, breakerTriggered: true, activeTripScope: scope };

    if (scope === 'DAY') {
      const excess = (formLimits.maxDailyLossUsd || 2500) + 150;
      updated = {
        ...updated,
        currentDailyLossUsd: excess,
        lastTriggerReason: `Intraday Max Loss Exceeded: -$${excess.toLocaleString()} (Ceiling: -$${(formLimits.maxDailyLossUsd || 2500).toLocaleString()}). Automated trading engine is locked for the remainder of today.`,
      };
    } else if (scope === 'WEEK') {
      const excess = (formLimits.maxWeeklyLossUsd || 6500) + 300;
      updated = {
        ...updated,
        currentWeeklyLossUsd: excess,
        lastTriggerReason: `Weekly Max Loss Exceeded: -$${excess.toLocaleString()} (Ceiling: -$${(formLimits.maxWeeklyLossUsd || 6500).toLocaleString()}). Trading bot automatically turned DOWN for this entire week.`,
      };
    } else {
      const excess = (formLimits.maxMonthlyLossUsd || 15000) + 750;
      updated = {
        ...updated,
        currentMonthlyLossUsd: excess,
        lastTriggerReason: `Monthly Max Loss Exceeded: -$${excess.toLocaleString()} (Ceiling: -$${(formLimits.maxMonthlyLossUsd || 15000).toLocaleString()}). Trading bot automatically shut down for this entire month.`,
      };
    }

    setFormLimits(updated);
    onUpdateLimits(updated);
    // Note: this is a UI-only demo of the trip banner. The server recomputes
    // real loss figures from actual closed trades every ~8s, so this fake
    // trip will be overwritten automatically unless a real loss also
    // breaches the ceiling. What DOES take effect for real is the halt:
    if (onHaltBot) {
      onHaltBot(true); // actually engage the kill switch (masterExecution -> false)
    }
  };

  // Resetting no longer fakes the loss figures. The server recomputes the
  // real currentDailyLossUsd/Weekly/Monthly from actual closed Deriv trades
  // and sends them back — this just clears the breaker flag and re-enables
  // the bot (handled server-side via onHaltBot -> resetBreaker: true).
  const handleResetBreakers = () => {
    if (onHaltBot) {
      onHaltBot(false); // resume trading; App.tsx clears the breaker server-side
    } else {
      onUpdateLimits({ ...formLimits, breakerTriggered: false, activeTripScope: 'NONE', lastTriggerReason: undefined });
    }
  };

  const maxDaily = formLimits.maxDailyLossUsd || 2500;
  const currentDaily = formLimits.currentDailyLossUsd || 0;
  const dailyPct = Math.min(100, Math.round((currentDaily / maxDaily) * 100));

  const maxWeekly = formLimits.maxWeeklyLossUsd || 6500;
  const currentWeekly = formLimits.currentWeeklyLossUsd || 0;
  const weeklyPct = Math.min(100, Math.round((currentWeekly / maxWeekly) * 100));

  const maxMonthly = formLimits.maxMonthlyLossUsd || 15000;
  const currentMonthly = formLimits.currentMonthlyLossUsd || 0;
  const monthlyPct = Math.min(100, Math.round((currentMonthly / maxMonthly) * 100));

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-8 max-w-7xl mx-auto">
      {/* View Header with generous negative space */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200 dark:border-[#212838]"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2.5">
            Advanced Loss Limits & Circuit Breakers
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
              Risk Guardian
            </span>
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Customizable daily, weekly, and monthly loss ceilings. Exceeding any threshold automatically shuts down the bot for that period.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {formLimits.breakerTriggered ? (
            <button
              onClick={handleResetBreakers}
              id="reset-breakers-btn"
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white shadow-sm flex items-center gap-2 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Circuit Breakers</span>
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleSimulateBreakerTrip('DAY')}
                className="px-3 py-1.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-[11px] font-semibold text-rose-700 dark:text-rose-400 flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Flame className="w-3.5 h-3.5 text-rose-500" />
                <span>Trip Day Limit</span>
              </button>
              <button
                onClick={() => handleSimulateBreakerTrip('WEEK')}
                className="px-3 py-1.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-[11px] font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                <span>Trip Week Limit</span>
              </button>
              <button
                onClick={() => handleSimulateBreakerTrip('MONTH')}
                className="px-3 py-1.5 rounded-xl bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 text-[11px] font-semibold text-purple-700 dark:text-purple-400 flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Ban className="w-3.5 h-3.5 text-purple-500" />
                <span>Trip Month Limit</span>
              </button>
            </div>
          )}
        </div>
      </motion.div>

      {/* Emergency Breaker Banner if Triggered */}
      {formLimits.breakerTriggered && (
        <div className="p-5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-900 dark:text-rose-200 text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm animate-pulse">
          <div className="flex items-center gap-3.5">
            <div className="p-2.5 rounded-xl bg-rose-600 text-white font-bold shrink-0">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <div className="font-bold text-sm text-rose-700 dark:text-rose-300 flex items-center gap-2">
                <span>CIRCUIT BREAKER ENGAGED — BOT AUTOMATICALLY TURNED DOWN</span>
                <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-rose-600 text-white">
                  {formLimits.activeTripScope ? `${formLimits.activeTripScope} LOCKOUT` : 'LOCKOUT'}
                </span>
              </div>
              <p className="text-rose-700 dark:text-rose-400 text-xs mt-1">{formLimits.lastTriggerReason}</p>
            </div>
          </div>
          <button
            onClick={handleResetBreakers}
            className="px-4 py-2 rounded-xl bg-rose-600 text-white font-bold text-xs hover:bg-rose-500 transition-colors shrink-0 cursor-pointer"
          >
            Authorize System Reset
          </button>
        </div>
      )}

      {/* 3 Tier Loss Limit Monitor Cards (Day, Week, Month) */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4 }}
        className="grid grid-cols-1 md:grid-cols-3 gap-6"
      >
        {/* Tier 1: Daily Loss Limit */}
        <div className={`p-6 rounded-2xl bg-white dark:bg-[#151922] border transition-all shadow-sm flex flex-col justify-between ${
          dailyPct >= 100 
            ? 'border-rose-500/60 ring-2 ring-rose-500/20' 
            : 'border-slate-200 dark:border-[#212838]'
        }`}>
          <div>
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span className="font-bold uppercase tracking-wider flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /> Daily Loss Limit
              </span>
              <span className={`font-mono text-xs font-bold ${dailyPct >= 100 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'}`}>
                ${currentDaily.toLocaleString()} / ${maxDaily.toLocaleString()}
              </span>
            </div>

            {/* Progress Bar */}
            <div className="w-full bg-slate-100 dark:bg-[#0d1017] rounded-full h-3 mt-3 overflow-hidden border border-slate-200 dark:border-[#212838] p-0.5">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  dailyPct >= 100
                    ? 'bg-rose-500 shadow-sm'
                    : dailyPct > 65
                    ? 'bg-amber-500'
                    : 'bg-blue-600'
                }`}
                style={{ width: `${dailyPct}%` }}
              />
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-[#212838] flex items-center justify-between text-xs">
            <span className="text-slate-500 dark:text-slate-400">Rule Violation Action:</span>
            <span className="font-semibold text-rose-600 dark:text-rose-400 font-mono">Turn Down Bot Today</span>
          </div>
        </div>

        {/* Tier 2: Weekly Loss Limit */}
        <div className={`p-6 rounded-2xl bg-white dark:bg-[#151922] border transition-all shadow-sm flex flex-col justify-between ${
          weeklyPct >= 100 
            ? 'border-rose-500/60 ring-2 ring-rose-500/20' 
            : 'border-slate-200 dark:border-[#212838]'
        }`}>
          <div>
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span className="font-bold uppercase tracking-wider flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /> Weekly Loss Limit
              </span>
              <span className={`font-mono text-xs font-bold ${weeklyPct >= 100 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'}`}>
                ${currentWeekly.toLocaleString()} / ${maxWeekly.toLocaleString()}
              </span>
            </div>

            {/* Progress Bar */}
            <div className="w-full bg-slate-100 dark:bg-[#0d1017] rounded-full h-3 mt-3 overflow-hidden border border-slate-200 dark:border-[#212838] p-0.5">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  weeklyPct >= 100
                    ? 'bg-rose-500 shadow-sm'
                    : weeklyPct > 65
                    ? 'bg-amber-500'
                    : 'bg-indigo-600'
                }`}
                style={{ width: `${weeklyPct}%` }}
              />
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-[#212838] flex items-center justify-between text-xs">
            <span className="text-slate-500 dark:text-slate-400">Rule Violation Action:</span>
            <span className="font-semibold text-amber-600 dark:text-amber-400 font-mono">Turn Down Bot This Week</span>
          </div>
        </div>

        {/* Tier 3: Monthly Loss Limit */}
        <div className={`p-6 rounded-2xl bg-white dark:bg-[#151922] border transition-all shadow-sm flex flex-col justify-between ${
          monthlyPct >= 100 
            ? 'border-rose-500/60 ring-2 ring-rose-500/20' 
            : 'border-slate-200 dark:border-[#212838]'
        }`}>
          <div>
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span className="font-bold uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /> Monthly Loss Limit
              </span>
              <span className={`font-mono text-xs font-bold ${monthlyPct >= 100 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'}`}>
                ${currentMonthly.toLocaleString()} / ${maxMonthly.toLocaleString()}
              </span>
            </div>

            {/* Progress Bar */}
            <div className="w-full bg-slate-100 dark:bg-[#0d1017] rounded-full h-3 mt-3 overflow-hidden border border-slate-200 dark:border-[#212838] p-0.5">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  monthlyPct >= 100
                    ? 'bg-rose-500 shadow-sm'
                    : monthlyPct > 65
                    ? 'bg-amber-500'
                    : 'bg-emerald-600'
                }`}
                style={{ width: `${monthlyPct}%` }}
              />
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-[#212838] flex items-center justify-between text-xs">
            <span className="text-slate-500 dark:text-slate-400">Rule Violation Action:</span>
            <span className="font-semibold text-purple-600 dark:text-purple-400 font-mono">Turn Down Bot This Month</span>
          </div>
        </div>
      </motion.div>

      {/* Configuration Form for Day, Week, Month */}
      <motion.form 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.45 }}
        onSubmit={handleSave} 
        className="rounded-2xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm p-6 space-y-6"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-[#212838]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <Sliders className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white tracking-tight">
                Customize Trade Loss Ceilings & Auto-Halt Rules
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Specify exact dollar ceilings for Day, Week, and Month. The engine automatically turns down execution if broken.
              </p>
            </div>
          </div>

          {saveSuccess && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-semibold bg-emerald-500/10 px-3 py-1 rounded-xl border border-emerald-500/20">
              <CheckCircle2 className="w-4 h-4" />
              <span>Limits Saved & Armed</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-xs">
          {/* Max Loss in a Day */}
          <div className="space-y-2 p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838]">
            <div className="flex items-center justify-between">
              <label className="font-bold text-slate-900 dark:text-white flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-blue-600" /> Max Daily Loss ($)
              </label>
              <span className="font-mono font-bold text-blue-600 dark:text-blue-400">
                ${(formLimits.maxDailyLossUsd ?? 2500).toLocaleString()}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Max money allowed to lose in a single trading day before auto-halt.
            </p>
            <input
              type="number"
              min="100"
              max="50000"
              step="100"
              value={formLimits.maxDailyLossUsd ?? 2500}
              onChange={(e) =>
                setFormLimits({
                  ...formLimits,
                  maxDailyLossUsd: parseFloat(e.target.value) || 100,
                })
              }
              className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Max Loss in a Week */}
          <div className="space-y-2 p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838]">
            <div className="flex items-center justify-between">
              <label className="font-bold text-slate-900 dark:text-white flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-blue-600" /> Max Weekly Loss ($)
              </label>
              <span className="font-mono font-bold text-blue-600 dark:text-blue-400">
                ${(formLimits.maxWeeklyLossUsd ?? 6500).toLocaleString()}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Max money allowed to lose in 1 week. Turns down bot for the week.
            </p>
            <input
              type="number"
              min="200"
              max="100000"
              step="250"
              value={formLimits.maxWeeklyLossUsd ?? 6500}
              onChange={(e) =>
                setFormLimits({
                  ...formLimits,
                  maxWeeklyLossUsd: parseFloat(e.target.value) || 200,
                })
              }
              className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Max Loss in a Month */}
          <div className="space-y-2 p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838]">
            <div className="flex items-center justify-between">
              <label className="font-bold text-slate-900 dark:text-white flex items-center gap-1">
                <Layers className="w-3.5 h-3.5 text-blue-600" /> Max Monthly Loss ($)
              </label>
              <span className="font-mono font-bold text-blue-600 dark:text-blue-400">
                ${(formLimits.maxMonthlyLossUsd ?? 15000).toLocaleString()}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Max money allowed to lose in 1 month. Turns down bot for the month.
            </p>
            <input
              type="number"
              min="500"
              max="250000"
              step="500"
              value={formLimits.maxMonthlyLossUsd ?? 15000}
              onChange={(e) =>
                setFormLimits({
                  ...formLimits,
                  maxMonthlyLossUsd: parseFloat(e.target.value) || 500,
                })
              }
              className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Drawdown Percentage & Emergency Liquidation */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs pt-2">
          {/* Max Daily Drawdown (%) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="font-semibold text-slate-700 dark:text-slate-300">
                Emergency Equity Drawdown (%)
              </label>
              <span className="font-mono font-bold text-blue-600 dark:text-blue-400">
                {formLimits.maxDailyDrawdownPct}%
              </span>
            </div>
            <input
              type="range"
              min="1.0"
              max="10.0"
              step="0.5"
              value={formLimits.maxDailyDrawdownPct}
              onChange={(e) =>
                setFormLimits({
                  ...formLimits,
                  maxDailyDrawdownPct: parseFloat(e.target.value),
                })
              }
              className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Locks terminal if loss exceeds this percentage of opening balance.
            </p>
          </div>

          {/* Auto Liquidate All On Trip Toggle */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] flex items-center justify-between">
            <div>
              <span className="font-semibold text-slate-900 dark:text-white">
                Emergency Liquidation on Breaker Trip
              </span>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Automatically send MARKET CLOSE to broker for all open positions when tripped
              </p>
            </div>
            <input
              type="checkbox"
              checked={Boolean(formLimits.autoLiquidateAllOnTrip)}
              onChange={(e) =>
                setFormLimits({
                  ...formLimits,
                  autoLiquidateAllOnTrip: e.target.checked,
                })
              }
              className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
            />
          </div>
        </div>

        <div className="pt-3 flex justify-end">
          <button
            type="submit"
            id="save-limits-btn"
            className="px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-sm cursor-pointer"
          >
            Broadcast Custom Limits to Engine
          </button>
        </div>
      </motion.form>
    </div>
  );
};
