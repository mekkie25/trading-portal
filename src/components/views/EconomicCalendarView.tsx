import React, { useState } from 'react';
import { motion } from 'motion/react';
import { 
  CalendarDays, 
  ChevronLeft, 
  ChevronRight, 
  TrendingUp, 
  TrendingDown, 
  ShieldAlert, 
  Clock, 
  Lightbulb, 
  AlertCircle
} from 'lucide-react';
import { CALENDAR_DATA_SEPTEMBER_2026 } from '../../data/mockTradingData';
import { CalendarDayData, MacroRelease, ThemeMode } from '../../types';

interface EconomicCalendarViewProps {
  themeMode?: ThemeMode;
}

export const EconomicCalendarView: React.FC<EconomicCalendarViewProps> = ({ themeMode = 'dark' }) => {
  const [selectedDate, setSelectedDate] = useState<string>('2026-09-17'); // FOMC Day
  const [activeReleaseId, setActiveReleaseId] = useState<string>('rel-5');

  const selectedDayData: CalendarDayData | undefined = CALENDAR_DATA_SEPTEMBER_2026[selectedDate];
  const activeRelease: MacroRelease | undefined = selectedDayData?.releases?.find(
    (r) => r.id === activeReleaseId
  ) || selectedDayData?.releases?.[0];

  const calendarDays = [];
  const daysInMonth = 30;
  const startDayOfWeek = 2; // Tuesday

  for (let i = 0; i < startDayOfWeek; i++) {
    const prevDayNum = 31 - startDayOfWeek + 1 + i;
    calendarDays.push({
      dateStr: `2026-08-${prevDayNum < 10 ? '0' + prevDayNum : prevDayNum}`,
      dayNum: prevDayNum,
      isCurrentMonth: false,
    });
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const formattedDate = `2026-09-${d < 10 ? '0' + d : d}`;
    calendarDays.push({
      dateStr: formattedDate,
      dayNum: d,
      isCurrentMonth: true,
      hasData: Boolean(CALENDAR_DATA_SEPTEMBER_2026[formattedDate]),
      eventData: CALENDAR_DATA_SEPTEMBER_2026[formattedDate],
    });
  }

  const totalSlots = Math.ceil(calendarDays.length / 7) * 7;
  const remaining = totalSlots - calendarDays.length;
  for (let r = 1; r <= remaining; r++) {
    calendarDays.push({
      dateStr: `2026-10-0${r}`,
      dayNum: r,
      isCurrentMonth: false,
    });
  }

  const handleSelectDay = (dateStr: string) => {
    setSelectedDate(dateStr);
    const dayData = CALENDAR_DATA_SEPTEMBER_2026[dateStr];
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
          <span className="font-mono font-bold text-slate-900 dark:text-white">{selectedDate}</span>
        </div>
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
          <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-[#212838]">
            <div className="flex items-center gap-2.5">
              <CalendarDays className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              <h2 className="text-base font-bold text-slate-900 dark:text-white tracking-tight">September 2026</h2>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-100 dark:bg-[#0d1017] text-slate-600 dark:text-slate-300">
                Macro Cycle
              </span>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-2 text-center text-xs uppercase font-bold text-slate-500 py-3">
            <span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span>
          </div>

          <div className="grid grid-cols-7 gap-2 flex-1 min-h-[360px]">
            {calendarDays.map((cell, idx) => {
              const isSelected = cell.dateStr === selectedDate;
              const hasEvents = cell.eventData && cell.eventData.releases.length > 0;
              const hasHighImpact = cell.eventData?.releases.some((r) => r.impact === 'HIGH');

              return (
                <button
                  key={idx}
                  onClick={() => cell.isCurrentMonth && handleSelectDay(cell.dateStr)}
                  disabled={!cell.isCurrentMonth}
                  className={`p-2.5 rounded-xl text-left flex flex-col justify-between transition-all min-h-[72px] cursor-pointer ${
                    !cell.isCurrentMonth
                      ? 'opacity-25 cursor-not-allowed bg-slate-50/50 dark:bg-[#0d1017]/30'
                      : isSelected
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
                        {(cell.eventData?.releases[0].title || '').slice(0, 16)}...
                      </div>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected Day Event Details with Detailed South African Time & Scenarios */}
        <div className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm p-6 space-y-5">
          <div className="pb-3 border-b border-slate-100 dark:border-[#212838]">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase font-bold text-slate-500">Event Breakdown</span>
              <span className="font-mono text-xs font-bold text-blue-600 dark:text-blue-400">{selectedDate}</span>
            </div>
            <h3 className="text-base font-bold text-slate-900 dark:text-white mt-1">
              {activeRelease?.title || 'No Scheduled Macro Events'}
            </h3>
          </div>

          {activeRelease && (
            <div className="space-y-4">
              {/* Timing Badge specifically in South African Standard Time */}
              <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 font-bold text-blue-600 dark:text-blue-400 font-mono">
                  <Clock className="w-4 h-4" /> {activeRelease.time || '20:00 SAST'} (South African Time)
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-rose-500 text-white font-mono font-bold">
                  HIGH IMPACT
                </span>
              </div>

              {/* Forecast & Previous */}
              <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838]">
                  <div className="text-[10px] text-slate-500 uppercase">Forecast</div>
                  <div className="font-bold text-slate-900 dark:text-white mt-0.5">{activeRelease.forecast || '5.00%'}</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838]">
                  <div className="text-[10px] text-slate-500 uppercase">Previous</div>
                  <div className="font-bold text-slate-900 dark:text-white mt-0.5">{activeRelease.previous || '5.25%'}</div>
                </div>
              </div>

              {/* Scenarios Breakdown */}
              <div className="space-y-2.5 text-xs">
                {/* Bullish Scenario */}
                <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20 text-emerald-900 dark:text-emerald-300">
                  <div className="font-bold flex items-center gap-1.5 mb-1 text-emerald-600 dark:text-emerald-400">
                    <TrendingUp className="w-4 h-4" /> Bullish Outcome (Gold & Indices rally)
                  </div>
                  <p className="text-[11px] leading-relaxed">
                    {activeRelease.institutionalInsight?.bullishScenario || 
                     'Dovish rate cut beyond expectations triggers massive liquidity injection into Gold (XAUUSD) and US30/NAS100.'}
                  </p>
                </div>

                {/* Bearish Scenario */}
                <div className="p-3 rounded-xl bg-rose-500/5 border border-rose-500/20 text-rose-900 dark:text-rose-300">
                  <div className="font-bold flex items-center gap-1.5 mb-1 text-rose-600 dark:text-rose-400">
                    <TrendingDown className="w-4 h-4" /> Bearish Outcome (USD surges)
                  </div>
                  <p className="text-[11px] leading-relaxed">
                    {activeRelease.institutionalInsight?.bearishScenario || 
                     'Hawkish hold or higher inflation rhetoric strengthens the Dollar, causing sharp drops in GBPUSD and Indices.'}
                  </p>
                </div>

                {/* Institutional Trap Warning */}
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
