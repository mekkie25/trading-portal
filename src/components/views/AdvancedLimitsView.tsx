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
  Target,
  Shield
} from 'lucide-react';
import { AdvancedLimits, ThemeMode, RiskProfileName } from '../../types';
import { formatCurrency } from '../../utils/currency';

interface AdvancedLimitsViewProps {
  limits: AdvancedLimits;
  onUpdateLimits: (limits: AdvancedLimits) => void;
  currentEquity: number;
  themeMode?: ThemeMode;
  onHaltBot?: (halted: boolean) => void;
  // PROPOSED (Fix 2b): active risk profile from App state. Display-only.
  riskProfile?: RiskProfileName | null;
  // Optional: currency to format the derived ceilings with. Falls back to USD.
  brokerCurrency?: string;
}

// PROPOSED: must match RISK_PROFILES in risk/risk_manager.py
// Display-only. No decision code may read these numbers. If the Python
// profiles change, this map must be updated in the same commit.
const PROFILE_LIMITS: Record<string, { daily: number; weekly: number; monthly: number }> = {
  'Steady':     { daily:  5, weekly: 10, monthly: 15 },
  'Balanced':   { daily: 15, weekly: 25, monthly: 40 },
  'Aggressive': { daily: 30, weekly: 50, monthly: 70 },
  'Max Growth': { daily: 50, weekly: 70, monthly: 85 },
};

export const AdvancedLimitsView: React.FC<AdvancedLimitsViewProps> = ({
  limits,
  onUpdateLimits,
  currentEquity,
  themeMode = 'dark',
  onHaltBot,
  riskProfile = null,
  brokerCurrency = 'USD',
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

  // PROPOSED (Fix 2b): when a profile is active and the toggle is on,
  // show the profile's real ceilings. Otherwise today's behaviour.
  const profileActive = Boolean(riskProfile && PROFILE_LIMITS[riskProfile]);
  const switchOn = formLimits.useProfileDrawdownPct !== false;
  const useProfileView = profileActive && switchOn;

  let maxDaily: number;
  let maxWeekly: number;
  let maxMonthly: number;
  let dailyPctLabel: string | null = null;
  let weeklyPctLabel: string | null = null;
  let monthlyPctLabel: string | null = null;

  if (useProfileView && riskProfile) {
    const pl = PROFILE_LIMITS[riskProfile];
    maxDaily = Number(((currentEquity || 0) * pl.daily / 100).toFixed(2));
    maxWeekly = Number(((currentEquity || 0) * pl.weekly / 100).toFixed(2));
    maxMonthly = Number(((currentEquity || 0) * pl.monthly / 100).toFixed(2));
    dailyPctLabel = `${pl.daily}%`;
    weeklyPctLabel = `${pl.weekly}%`;
    monthlyPctLabel = `${pl.monthly}%`;
  } else {
    maxDaily = formLimits.maxDailyLossUsd ?? 0;
    maxWeekly = formLimits.maxWeeklyLossUsd ?? 0;
    maxMonthly = formLimits.maxMonthlyLossUsd ?? 0;
  }

  const currentDaily = formLimits.currentDailyLossUsd || 0;
  const dailyPct = maxDaily > 0 ? Math.min(100, Math.round((currentDaily / maxDaily) * 100)) : 0;

  const currentWeekly = formLimits.currentWeeklyLossUsd || 0;
  const weeklyPct = maxWeekly > 0 ? Math.min(100, Math.round((currentWeekly / maxWeekly) * 100)) : 0;

  const currentMonthly = formLimits.currentMonthlyLossUsd || 0;
  const monthlyPct = maxMonthly > 0 ? Math.min(100, Math.round((currentMonthly / maxMonthly) * 100)) : 0;

  const fmt = (v: number) => formatCurrency(v, brokerCurrency);

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

      {/* PROPOSED (Fix 2b): explain what the cards are showing when the profile is active. */}
      {useProfileView && riskProfile && (
        <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-slate-700 dark:text-slate-300">
          <strong className="text-blue-600 dark:text-blue-400">Showing {riskProfile} profile caps</strong>
          {' '}— daily {PROFILE_LIMITS[riskProfile].daily}%, weekly {PROFILE_LIMITS[riskProfile].weekly}%,
          {' '}monthly {PROFILE_LIMITS[riskProfile].monthly}% of current equity
          ({fmt(currentEquity)}). Turn the switch below off to use your own USD ceilings instead.
        </div>
      )}

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
                {dailyPctLabel
                  ? `${dailyPctLabel} (${fmt(maxDaily)})`
                  : `${fmt(currentDaily)} / ${fmt(maxDaily)}`}
              </span>
            </div>
            <div className="w-full bg-slate-100 dark:bg-[#0d1017] rounded-full h-3 mt-3 overflow-hidden border border-slate-200 dark:border-[#212838] p-0.5">
              <div className="h-full rounded-full bg-blue-600 transition-all duration-500" style={{ width: `${dailyPct}%` }} />
            </div>
            {dailyPctLabel && (
              <p className="text-[10px] text-slate-500 mt-2 font-mono">
                Cap: {fmt(maxDaily)} · Used: {fmt(currentDaily)} ({dailyPct}%)
              </p>
            )}
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
                {weeklyPctLabel
                  ? `${weeklyPctLabel} (${fmt(maxWeekly)})`
                  : `${fmt(currentWeekly)} / ${fmt(maxWeekly)}`}
              </span>
            </div>
            <div className="w-full bg-slate-100 dark:bg-[#0d1017] rounded-full h-3 mt-3 overflow-hidden border border-slate-200 dark:border-[#212838] p-0.5">
              <div className="h-full rounded-full bg-indigo-600 transition-all duration-500" style={{ width: `${weeklyPct}%` }} />
            </div>
            {weeklyPctLabel && (
              <p className="text-[10px] text-slate-500 mt-2 font-mono">
                Cap: {fmt(maxWeekly)} · Used: {fmt(currentWeekly)} ({weeklyPct}%)
              </p>
            )}
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
                {monthlyPctLabel
                  ? `${monthlyPctLabel} (${fmt(maxMonthly)})`
                  : `${fmt(currentMonthly)} / ${fmt(maxMonthly)}`}
              </span>
            </div>
            <div className="w-full bg-slate-100 dark:bg-[#0d1017] rounded-full h-3 mt-3 overflow-hidden border border-slate-200 dark:border-[#212838] p-0.5">
              <div className="h-full rounded-full bg-emerald-600 transition-all duration-500" style={{ width: `${monthlyPct}%` }} />
            </div>
            {monthlyPctLabel && (
              <p className="text-[10px] text-slate-500 mt-2 font-mono">
                Cap: {fmt(maxMonthly)} · Used: {fmt(currentMonthly)} ({monthlyPct}%)
              </p>
            )}
          </div>
          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-[#212838] flex items-center justify-between text-xs">
            <span className="text-slate-500">Action:</span>
            <span className="font-semibold text-purple-600 font-mono">Halt Trading This Month</span>
          </div>
        </div>
      </motion.div>

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

        <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 shrink-0">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <span className="font-bold text-slate-900 dark:text-white text-xs">
                Use Risk Profile's Percentage Limits
              </span>
              <p className="text-[11px] text-slate-500 mt-1 max-w-2xl leading-relaxed">
                When <strong>on</strong> and a risk profile is active, the profile's daily / weekly / monthly
                percentages decide when trading halts, and the USD values below are ignored. Turn
                <strong> off</strong> if you want the USD ceilings to override the profile.
                When no profile is selected, USD values always win if they are &gt; 0.
              </p>
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
            <input
              type="checkbox"
              checked={Boolean(formLimits.useProfileDrawdownPct ?? true)}
              onChange={(e) =>
                setFormLimits({ ...formLimits, useProfileDrawdownPct: e.target.checked })
              }
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-slate-300 dark:bg-slate-800 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
          </label>
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