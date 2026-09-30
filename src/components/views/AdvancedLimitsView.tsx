import React, { useState } from 'react';
import { motion } from 'motion/react';
import { 
  RotateCcw, 
  Sliders, 
  Clock,
  Calendar,
  Layers,
  CheckCircle2,
  TrendingUp,
  Target
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

  const handleResetBreakers = async () => {
    try {
      await fetch('/api/limits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resetBreaker: true })
      });
      onUpdateLimits({ ...formLimits, breakerTriggered: false, activeTripScope: 'NONE', lastTriggerReason: undefined });
    } catch {
      if (onHaltBot) onHaltBot(false);
    }
  };

  const maxDaily = formLimits.maxDailyLossUsd || 10;
  const currentDaily = formLimits.currentDailyLossUsd || 0;
  const dailyPct = maxDaily > 0 ? Math.min(100, Math.round((currentDaily / maxDaily) * 100)) : 0;

  const maxWeekly = formLimits.maxWeeklyLossUsd || 25;
  const currentWeekly = formLimits.currentWeeklyLossUsd || 0;
  const weeklyPct = maxWeekly > 0 ? Math.min(100, Math.round((currentWeekly / maxWeekly) * 100)) : 0;

  const maxMonthly = formLimits.maxMonthlyLossUsd || 50;
  const currentMonthly = formLimits.currentMonthlyLossUsd || 0;
  const monthlyPct = maxMonthly > 0 ? Math.min(100, Math.round((currentMonthly / maxMonthly) * 100)) : 0;

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-8 max-w-7xl mx-auto">
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200 dark:border-[#212838]"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2.5">
            Loss Ceilings & Circuit Breakers
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
              Risk Guardian
            </span>
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Real-time equity drawdown limits. Values set to 0.0 automatically engage percentage fallback caps.
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
                <Clock className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /> Daily Loss Ceiling
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
            <span className="font-semibold text-rose-600 font-mono">Halt Trading Today</span>
          </div>
        </div>

        <div className="p-6 rounded-2xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span className="font-bold uppercase tracking-wider flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /> Weekly Loss Ceiling
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
            <span className="font-semibold text-amber-600 font-mono">Halt Trading This Week</span>
          </div>
        </div>

        <div className="p-6 rounded-2xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span className="font-bold uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /> Monthly Loss Ceiling
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
            <span className="font-semibold text-purple-600 font-mono">Halt Trading This Month</span>
          </div>
        </div>
      </motion.div>

      {/* Form supporting currency ceilings */}
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
                Configure Max Drawdown Ceilings (Base Units)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Set to 0 to automatically use percentage caps (Daily 5%, Weekly 10%, Monthly 15%).
              </p>
            </div>
          </div>

          {saveSuccess && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-semibold bg-emerald-500/10 px-3 py-1 rounded-xl border border-emerald-500/20">
              <CheckCircle2 className="w-4 h-4" />
              <span>Limits Saved & Confirmed</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-xs">
          <div className="space-y-2 p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838]">
            <label className="font-bold text-slate-900 dark:text-white flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-blue-600" /> Max Daily Loss ($ / Base)
            </label>
            <input
              type="number"
              min="0"
              max="50000"
              step="0.5"
              value={formLimits.maxDailyLossUsd ?? 0}
              onChange={(e) =>
                setFormLimits({
                  ...formLimits,
                  maxDailyLossUsd: parseFloat(e.target.value) || 0,
                })
              }
              className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="space-y-2 p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838]">
            <label className="font-bold text-slate-900 dark:text-white flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5 text-blue-600" /> Max Weekly Loss ($ / Base)
            </label>
            <input
              type="number"
              min="0"
              max="100000"
              step="1"
              value={formLimits.maxWeeklyLossUsd ?? 0}
              onChange={(e) =>
                setFormLimits({
                  ...formLimits,
                  maxWeeklyLossUsd: parseFloat(e.target.value) || 0,
                })
              }
              className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="space-y-2 p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838]">
            <label className="font-bold text-slate-900 dark:text-white flex items-center gap-1">
              <Layers className="w-3.5 h-3.5 text-blue-600" /> Max Monthly Loss ($ / Base)
            </label>
            <input
              type="number"
              min="0"
              max="250000"
              step="1"
              value={formLimits.maxMonthlyLossUsd ?? 0}
              onChange={(e) =>
                setFormLimits({
                  ...formLimits,
                  maxMonthlyLossUsd: parseFloat(e.target.value) || 0,
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
            Save & Confirm Loss Limits
          </button>
        </div>
      </motion.form>
    </div>
  );
};