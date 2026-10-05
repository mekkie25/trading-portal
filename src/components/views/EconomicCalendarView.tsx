import React, { useState, useMemo, useEffect } from 'react';
import { motion } from 'motion/react';
import { 
  CalendarDays, 
  ChevronLeft, 
  ChevronRight, 
  TrendingUp, 
  TrendingDown, 
  ShieldAlert, 
  Clock,
  Info
} from 'lucide-react';
import { CALENDAR_DATA_SEPTEMBER_2026 } from '../../data/mockTradingData';
import { CalendarDayData, MacroRelease, ThemeMode } from '../../types';

interface EconomicCalendarViewProps {
  themeMode?: ThemeMode;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Picks the latest "YYYY-MM" key present in the calendar data map.
// Used to auto-jump the view to a month that actually has events.
function latestDataMonth(data: Record<string, CalendarDayData>): { year: number; month: number } | null {
  const keys = Object.keys(data).sort();
  if (keys.length === 0) return null;
  const last = keys[keys.length - 1];
  const y = parseInt(last.slice(0, 4), 10);
  const m = parseInt(last.slice(5, 7), 10);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
  return { year: y, month: m };
}

export const EconomicCalendarView: React.FC<EconomicCalendarViewProps> = ({ themeMode = 'dark' }) => {
  const allData = CALENDAR_DATA_SEPTEMBER_2026;

  // PROPOSED: default the view to the most recent month that has data.
  // If today's month has no entries (very common), this avoids an empty grid.
  const initial = useMemo(() => {
    const now = new Date();
    const todayPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const hasTodayMonth = Object.keys(allData).some((k) => k.startsWith(todayPrefix));
    if (hasTodayMonth) return { year: now.getFullYear(), month: now.getMonth() + 1 };
    const fallback = latestDataMonth(allData);
    if (fallback) return fallback;
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  }, [allData]);

  const [viewYear, setViewYear] = useState<number>(initial.year);
  const [viewMonth, setViewMonth] = useState<number>(initial.month); // 1-12
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [activeReleaseId, setActiveReleaseId] = useState<string>('');

  const monthPrefix = `${viewYear}-${String(viewMonth).padStart(2, '0')}`;

  // Calendar grid sizing for the viewed month.
  const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();
  const firstWeekday = new Date(viewYear, viewMonth - 1, 1).getDay();
  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;

  const cells = useMemo(() => {
    const out: Array<{ dayNum: number | null; dateStr: string | null }> = [];
    for (let i = 0; i < firstWeekday; i++) out.push({ dayNum: null, dateStr: null });
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${viewYear}-${String(viewMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      out.push({ dayNum: d, dateStr: ds });
    }
    while (out.length < totalCells) out.push({ dayNum: null, dateStr: null });
    return out;
  }, [viewYear, viewMonth, firstWeekday, daysInMonth, totalCells]);

  // Auto-select the first day with data whenever the viewed month changes.
  useEffect(() => {
    const daysInView = Object.keys(allData).filter((k) => k.startsWith(monthPrefix)).sort();
    if (daysInView.length > 0) {
      setSelectedDate(daysInView[0]);
      const rels = allData[daysInView[0]]?.releases;
      if (rels && rels.length > 0) setActiveReleaseId(rels[0].id);
    } else {
      setSelectedDate('');
      setActiveReleaseId('');
    }
  }, [monthPrefix, allData]);

  const monthHasAnyData = Object.keys(allData).some((k) => k.startsWith(monthPrefix));
  const selectedDayData: CalendarDayData | undefined = selectedDate ? allData[selectedDate] : undefined;
  const activeRelease: MacroRelease | undefined =
    selectedDayData?.releases?.find((r) => r.id === activeReleaseId) || selectedDayData?.releases?.[0];

  const goPrevMonth = () => {
    if (viewMonth === 1) { setViewMonth(12); setViewYear((y) => y - 1); }
    else setViewMonth((m) => m - 1);
  };
  const goNextMonth = () => {
    if (viewMonth === 12) { setViewMonth(1); setViewYear((y) => y + 1); }
    else setViewMonth((m) => m + 1);
  };
  const goToLatestData = () => {
    const latest = latestDataMonth(allData);
    if (latest) {
      setViewYear(latest.year);
      setViewMonth(latest.month);
    } else {
      const now = new Date();
      setViewYear(now.getFullYear());
      setViewMonth(now.getMonth() + 1);
    }
  };

  const handleSelectDay = (dateStr: string) => {
    setSelectedDate(dateStr);
    const dayData = allData[dateStr];
    if (dayData && dayData.releases.length > 0) {
      setActiveReleaseId(dayData.releases[0].id);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-8 max-w-7xl mx-auto font-sans">
      {/* Header */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200 dark:border-[#212838]"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2.5">
            Economic Calendar & Institutional Playbook
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
              SAST Synchronized
            </span>
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            All times displayed in South African Standard Time (SAST / UTC+2). High-impact catalyst schedule and trading playbooks.
          </p>
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-[#151922] border border-slate-200 dark:border-[#212838] text-xs">
          <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
          <span className="text-slate-600 dark:text-slate-400">Selected:</span>
          <span className="font-mono font-bold text-slate-900 dark:text-white">{selectedDate || '—'}</span>
        </div>
      </motion.div>

      {/* Month navigation strip */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm"
      >
        <button
          type="button"
          onClick={goPrevMonth}
          className="p-2 rounded-xl bg-slate-100 dark:bg-[#0d1017] hover:bg-slate-200 dark:hover:bg-[#1a202c] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-[#212838] cursor-pointer transition-colors"
          title="Previous month"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-3">
          <CalendarDays className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <span className="text-base font-bold text-slate-900 dark:text-white tracking-tight">
            {MONTH_NAMES[viewMonth - 1]} {viewYear}
          </span>
          {!monthHasAnyData && (
            <button
              type="button"
              onClick={goToLatestData}
              className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30 cursor-pointer hover:bg-amber-500/25 transition-colors"
              title="Jump to the most recent month with events"
            >
              Jump to latest events
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={goNextMonth}
          className="p-2 rounded-xl bg-slate-100 dark:bg-[#0d1017] hover:bg-slate-200 dark:hover:bg-[#1a202c] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-[#212838] cursor-pointer transition-colors"
          title="Next month"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </motion.div>

      {/* Main Grid */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        className="grid grid-cols-1 lg:grid-cols-12 gap-6"
      >
        {/* Calendar Month View */}
        <div className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm p-6 flex flex-col justify-between">
          <div className="grid grid-cols-7 gap-2 text-center text-xs uppercase font-bold text-slate-500 py-3">
            {WEEKDAY_LABELS.map((w) => <span key={w}>{w}</span>)}
          </div>

          <div className="grid grid-cols-7 gap-2 flex-1 min-h-[360px]">
            {cells.map((cell, idx) => {
              if (cell.dayNum === null || cell.dateStr === null) {
                return <div key={idx} className="rounded-xl bg-slate-50/40 dark:bg-[#0d1017]/30 min-h-[72px]" />;
              }

              const isSelected = cell.dateStr === selectedDate;
              const dayData = allData[cell.dateStr];
              const hasEvents = !!(dayData && dayData.releases.length > 0);
              const hasHighImpact = dayData?.releases.some((r) => r.impact === 'HIGH');

              return (
                <button
                  key={idx}
                  onClick={() => handleSelectDay(cell.dateStr!)}
                  className={`p-2.5 rounded-xl text-left flex flex-col justify-between transition-all min-h-[72px] cursor-pointer ${
                    isSelected
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'bg-slate-50 dark:bg-[#0d1017] hover:bg-slate-100 dark:hover:bg-[#1a202c] text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-[#212838]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-mono font-bold ${isSelected ? 'text-white' : 'text-slate-800 dark:text-slate-200'}`}>
                      {cell.dayNum}
                    </span>
                    {hasHighImpact && <span className="w-2 h-2 rounded-full bg-rose-500" />}
                  </div>

                  {hasEvents && (
                    <div className="mt-1">
                      <div className={`text-[10px] font-medium truncate px-1 py-0.5 rounded leading-tight ${
                        isSelected ? 'bg-white/20 text-white' : 'bg-slate-200 dark:bg-[#1f2533] text-slate-800 dark:text-slate-200'
                      }`}>
                        {(dayData!.releases[0].title || '').slice(0, 16)}...
                      </div>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected Day Event Details */}
        <div className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm p-6 space-y-5">
          <div className="pb-3 border-b border-slate-100 dark:border-[#212838]">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase font-bold text-slate-500">Event Breakdown</span>
              <span className="font-mono text-xs font-bold text-blue-600 dark:text-blue-400">{selectedDate || '—'}</span>
            </div>
            <h3 className="text-base font-bold text-slate-900 dark:text-white mt-1">
              {activeRelease?.title || (monthHasAnyData ? 'No event on this date' : 'No scheduled macro events for this month')}
            </h3>
          </div>

          {!monthHasAnyData && (
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-2.5 text-xs text-amber-800 dark:text-amber-300">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <strong className="block text-amber-700 dark:text-amber-400 mb-0.5">This month has no scheduled events in the portal yet.</strong>
                <span>Click <em>Jump to latest events</em> above to see the most recent populated month.</span>
              </div>
            </div>
          )}

          {activeRelease && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 font-bold text-blue-600 dark:text-blue-400 font-mono">
                  <Clock className="w-4 h-4" /> {activeRelease.time || '20:00 SAST'} (South African Time)
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-rose-500 text-white font-mono font-bold">
                  {activeRelease.impact || 'HIGH'} IMPACT
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838]">
                  <div className="text-[10px] text-slate-500 uppercase">Forecast</div>
                  <div className="font-bold text-slate-900 dark:text-white mt-0.5">{activeRelease.forecast || '—'}</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838]">
                  <div className="text-[10px] text-slate-500 uppercase">Previous</div>
                  <div className="font-bold text-slate-900 dark:text-white mt-0.5">{activeRelease.previous || '—'}</div>
                </div>
              </div>

              <div className="space-y-2.5 text-xs">
                <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20 text-emerald-900 dark:text-emerald-300">
                  <div className="font-bold flex items-center gap-1.5 mb-1 text-emerald-600 dark:text-emerald-400">
                    <TrendingUp className="w-4 h-4" /> Bullish Outcome (Gold & Indices rally)
                  </div>
                  <p className="text-[11px] leading-relaxed">
                    {activeRelease.institutionalInsight?.bullishScenario ||
                     'Dovish rate cut beyond expectations triggers massive liquidity injection into Gold (XAUUSD) and US30/NAS100.'}
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-rose-500/5 border border-rose-500/20 text-rose-900 dark:text-rose-300">
                  <div className="font-bold flex items-center gap-1.5 mb-1 text-rose-600 dark:text-rose-400">
                    <TrendingDown className="w-4 h-4" /> Bearish Outcome (USD surges)
                  </div>
                  <p className="text-[11px] leading-relaxed">
                    {activeRelease.institutionalInsight?.bearishScenario ||
                     'Hawkish hold or higher inflation rhetoric strengthens the Dollar, causing sharp drops in GBPUSD and Indices.'}
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/20 text-amber-900 dark:text-amber-300">
                  <div className="font-bold flex items-center gap-1.5 mb-1 text-amber-600 dark:text-amber-400">
                    <ShieldAlert className="w-4 h-4" /> Fakeout Trap & News Armor Rule
                  </div>
                  <p className="text-[11px] leading-relaxed">
                    {activeRelease.institutionalInsight?.fakeoutTrapWarning ||
                     'Never trade within the first 5 minutes (20:00–20:05 SAST). Spreads widen heavily. Wait for the initial sweep and enter the retest.'}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
};