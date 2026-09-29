import React, { useState } from 'react';
import { motion } from 'motion/react';
import { 
  ShieldAlert, 
  AlertTriangle, 
  Flame, 
  CheckCircle2, 
  RotateCcw, 
  Sliders, 
  Clock,
  Calendar,
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

  React.useEffect(() => {
    setFormLimits(limits);
  }, [limits]);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateLimits(formLimits);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const handleResetBreakers = () => {
    if (onHaltBot) {
      onHaltBot(false);
    } else {
      onUpdateLimits({ ...formLimits, breakerTriggered: false, activeTripScope: 'NONE', lastTriggerReason: undefined });
    }
  };

  const maxDaily = formLimits.maxDailyLossUsd || 10;
  const currentDaily = formLimits.currentDailyLossUsd || 0;
  const dailyPct = Math.min(100, Math.round((currentDaily / maxDaily) * 100));

  const maxWeekly = formLimits.maxWeeklyLossUsd || 25;
  const currentWeekly = formLimits.currentWeeklyLossUsd || 0;
  const weeklyPct = Math.min(100, Math.round((currentWeekly / maxWeekly) * 100));

  const maxMonthly = formLimits.maxMonthlyLossUsd || 50;
  const currentMonthly = formLimits.currentMonthlyLossUsd || 0;
  const monthlyPct = Math.min(100, Math.round((currentMonthly / maxMonthly) * 100));

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-8 max-w-7xl mx-auto">
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
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
            Customizable daily, weekly, and monthly loss ceilings. Supports micro accounts down to $1.
          </p>
        </div>

        {formLimits.breakerTriggered && (
          <button
            onClick={handleResetBreakers}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white shadow-sm flex items-center gap-2 transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Circuit Breakers</span>
          </button>
        )}
      </motion.div>

      {/* 3 Tier Loss Limit Monitor Cards */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="grid grid-cols-1 md:grid-cols-3 gap-6"
      >
        <div className="p-6 rounded-2xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span className="font-bold uppercase tracking-wider flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /> Daily Loss Limit
              </span>
              <span className="font-mono text-xs font-bold text-slate-900 dark:text-white">
                ${currentDaily.toFixed(2)} / ${maxDaily.toFixed(2)}
              </span>
            </div>
            <div className="w-full bg-slate-100 dark:bg-[#0d1017] rounded-full h-3 mt-3 overflow-hidden border border-slate-200 dark:border-[#212838] p-0.5">
              <div className="h-full rounded-full bg-blue-600 transition-all duration-500" style={{ width: `${dailyPct}%` }} />
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-[#212838] flex items-center justify-between text-xs">
            <span className="text-slate-500">Action:</span>
            <span className="font-semibold text-rose-600 font-mono">Turn Down Bot Today</span>
          </div>
        </div>

        <div className="p-6 rounded-2xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span className="font-bold uppercase tracking-wider flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /> Weekly Loss Limit
              </span>
              <span className="font-mono text-xs font-bold text-slate-900 dark:text-white">
                ${currentWeekly.toFixed(2)} / ${maxWeekly.toFixed(2)}
              </span>
            </div>
            <div className="w-full bg-slate-100 dark:bg-[#0d1017] rounded-full h-3 mt-3 overflow-hidden border border-slate-200 dark:border-[#212838] p-0.5">
              <div className="h-full rounded-full bg-indigo-600 transition-all duration-500" style={{ width: `${weeklyPct}%` }} />
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-[#212838] flex items-center justify-between text-xs">
            <span className="text-slate-500">Action:</span>
            <span className="font-semibold text-amber-600 font-mono">Turn Down Bot This Week</span>
          </div>
        </div>

        <div className="p-6 rounded-2xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span className="font-bold uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /> Monthly Loss Limit
              </span>
              <span className="font-mono text-xs font-bold text-slate-900 dark:text-white">
                ${currentMonthly.toFixed(2)} / ${maxMonthly.toFixed(2)}
              </span>
            </div>
            <div className="w-full bg-slate-100 dark:bg-[#0d1017] rounded-full h-3 mt-3 overflow-hidden border border-slate-200 dark:border-[#212838] p-0.5">
              <div className="h-full rounded-full bg-emerald-600 transition-all duration-500" style={{ width: `${monthlyPct}%` }} />
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-[#212838] flex items-center justify-between text-xs">
            <span className="text-slate-500">Action:</span>
            <span className="font-semibold text-purple-600 font-mono">Turn Down Bot This Month</span>
          </div>
        </div>
      </motion.div>

      {/* Form supporting micro-accounts (min="1") */}
      <motion.form 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
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
                Supports small balances. You can set daily loss limits as low as $1.
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
          {/* Max Daily Loss ($) - now min="1" */}
          <div className="space-y-2 p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838]">
            <div className="flex items-center justify-between">
              <label className="font-bold text-slate-900 dark:text-white flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-blue-600" /> Max Daily Loss ($)
              </label>
              <span className="font-mono font-bold text-blue-600 dark:text-blue-400">
                ${(formLimits.maxDailyLossUsd ?? 10).toLocaleString()}
              </span>
            </div>
            <p className="text-[11px] text-slate-500">
              Max loss allowed in 1 day before auto-halt.
            </p>
            <input
              type="number"
              min="0.5"
              max="50000"
              step="0.5"
              value={formLimits.maxDailyLossUsd ?? 10}
              onChange={(e) =>
                setFormLimits({
                  ...formLimits,
                  maxDailyLossUsd: parseFloat(e.target.value) || 0.5,
                })
              }
              className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Max Weekly Loss ($) - now min="1" */}
          <div className="space-y-2 p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838]">
            <div className="flex items-center justify-between">
              <label className="font-bold text-slate-900 dark:text-white flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-blue-600" /> Max Weekly Loss ($)
              </label>
              <span className="font-mono font-bold text-blue-600 dark:text-blue-400">
                ${(formLimits.maxWeeklyLossUsd ?? 25).toLocaleString()}
              </span>
            </div>
            <p className="text-[11px] text-slate-500">
              Max loss allowed in 1 week.
            </p>
            <input
              type="number"
              min="1"
              max="100000"
              step="1"
              value={formLimits.maxWeeklyLossUsd ?? 25}
              onChange={(e) =>
                setFormLimits({
                  ...formLimits,
                  maxWeeklyLossUsd: parseFloat(e.target.value) || 1,
                })
              }
              className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Max Monthly Loss ($) - now min="1" */}
          <div className="space-y-2 p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838]">
            <div className="flex items-center justify-between">
              <label className="font-bold text-slate-900 dark:text-white flex items-center gap-1">
                <Layers className="w-3.5 h-3.5 text-blue-600" /> Max Monthly Loss ($)
              </label>
              <span className="font-mono font-bold text-blue-600 dark:text-blue-400">
                ${(formLimits.maxMonthlyLossUsd ?? 50).toLocaleString()}
              </span>
            </div>
            <p className="text-[11px] text-slate-500">
              Max loss allowed in 1 month.
            </p>
            <input
              type="number"
              min="1"
              max="250000"
              step="1"
              value={formLimits.maxMonthlyLossUsd ?? 50}
              onChange={(e) =>
                setFormLimits({
                  ...formLimits,
                  maxMonthlyLossUsd: parseFloat(e.target.value) || 1,
                })
              }
              className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div className="pt-3 flex justify-end">
          <button
            type="submit"
            className="px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-sm cursor-pointer"
          >
            Broadcast Custom Limits to Engine
          </button>
        </div>
      </motion.form>
    </div>
  );
};