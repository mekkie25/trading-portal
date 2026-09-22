import React, { useState } from 'react';
import { motion } from 'motion/react';
import { 
  CalendarDays, 
  ChevronLeft, 
  ChevronRight, 
  AlertCircle, 
  TrendingUp, 
  TrendingDown, 
  ShieldAlert, 
  Clock, 
  Compass, 
  Lightbulb, 
  Crosshair,
  BadgeAlert,
  Info,
  Calendar
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
      {/* View Header */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200 dark:border-[#212838]"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2.5">
            Economic Calendar & Macro Outlook
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
              Live Macro
            </span>
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Global market drivers, high-impact interest rate decisions, CPI catalysts, and mentor playbooks.
          </p>
        </div>

        {/* Selected event date chip */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-[#151922] border border-slate-200 dark:border-[#212838] text-xs">
            <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
            <span className="text-slate-700 dark:text-slate-300 font-medium">Selected Date:</span>
            <span className="font-mono font-bold text-slate-900 dark:text-white">{selectedDate}</span>
          </div>
        </div>
      </motion.div>

      {/* Main Grid: Left Calendar Month View + Right Day Summary */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4 }}
        className="grid grid-cols-1 lg:grid-cols-12 gap-6"
      >
        {/* Month View Grid Calendar */}
        <div className="lg:col-span-8 rounded-2xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm p-6 flex flex-col justify-between">
          {/* Calendar Month Header */}
          <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-[#212838]">
            <div className="flex items-center gap-2.5">
              <CalendarDays className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              <h2 className="text-base font-bold text-slate-900 dark:text-white tracking-tight">
                September 2026
              </h2>
              <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-[#0d1017] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-[#212838]">
                Central Bank & Macro Cycle
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                disabled
                className="p-2 rounded-xl bg-slate-100 dark:bg-[#0d1017] text-slate-400 cursor-not-allowed border border-slate-200 dark:border-[#212838]"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                disabled
                className="p-2 rounded-xl bg-slate-100 dark:bg-[#0d1017] text-slate-400 cursor-not-allowed border border-slate-200 dark:border-[#212838]"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 gap-2 text-center text-xs uppercase font-bold text-slate-500 dark:text-slate-400 py-3">
            <span>Sun</span>
            <span>Mon</span>
            <span>Tue</span>
            <span>Wed</span>
            <span>Thu</span>
            <span>Fri</span>
            <span>Sat</span>
          </div>

          {/* Calendar Day Cells */}
          <div className="grid grid-cols-7 gap-2 flex-1 min-h-[360px]">
            {calendarDays.map((cell, idx) => {
              const isSelected = cell.dateStr === selectedDate;
              const hasEvents = cell.eventData && cell.eventData.releases.length > 0;
              const hasHighImpact = cell.eventData?.releases.some((r) => r.impact === 'HIGH');
              const hasMedImpact = cell.eventData?.releases.some((r) => r.impact === 'MEDIUM');

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
                    {hasHighImpact && (
                      <span className="w-2 h-2 rounded-full bg-rose-500 shadow-sm" />
                    )}
                    {!hasHighImpact && hasMedImpact && (
                      <span className="w-2 h-2 rounded-full bg-amber-400" />
                    )}
                  </div>

                  {hasEvents && (
                    <div className="mt-1 space-y-1">
                      <div className={`text-[10px] font-medium truncate px-1 py-0.5 rounded leading-tight ${
                        isSelected 
                          ? 'bg-white/20 text-white' 
                          : 'bg-slate-200 dark:bg-[#1f2533] text-slate-800 dark:text-slate-200'
                      }`}>
                        {(cell.eventData?.releases[0].title || cell.eventData?.releases[0].name || '').slice(0, 18)}
                      </div>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected Day Macro Detail & Mentor Guidance */}
        <div className="lg:col-span-4 rounded-2xl bg-white dark:bg-[#151922] border border-slate-200 dark:border-[#212838] shadow-sm p-6 flex flex-col justify-between space-y-5">
          <div className="pb-4 border-b border-slate-100 dark:border-[#212838]">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase font-bold text-slate-500 dark:text-slate-400">Macro Schedule</span>
              <span className="font-mono text-xs font-bold text-blue-600 dark:text-blue-400">
                {selectedDate}
              </span>
            </div>
            <h3 className="text-base font-bold text-slate-900 dark:text-white mt-1">
              {selectedDayData ? `${selectedDayData.releases.length} Catalyst Events` : 'No Scheduled Macro Events'}
            </h3>
          </div>

          {/* Release List */}
          <div className="space-y-3 flex-1 overflow-y-auto max-h-[320px]">
            {selectedDayData?.releases.map((rel) => {
              const isReleaseActive = rel.id === activeReleaseId;
              return (
                <div
                  key={rel.id}
                  onClick={() => setActiveReleaseId(rel.id)}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                    isReleaseActive
                      ? 'bg-blue-500/10 border-blue-500/30 ring-1 ring-blue-500/20'
                      : 'bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded font-mono ${
                      rel.impact === 'HIGH'
                        ? 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border border-rose-500/20'
                        : 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/20'
                    }`}>
                      {rel.impact} IMPACT
                    </span>
                    <span className="text-xs font-mono text-slate-600 dark:text-slate-400 flex items-center gap-1">
                      <Clock className="w-3 h-3" /> {rel.time}
                    </span>
                  </div>
                  <div className="font-semibold text-xs text-slate-900 dark:text-white mt-2">
                    {rel.title || rel.name}
                  </div>
                  <div className="flex items-center gap-3 mt-2 text-[11px] font-mono text-slate-600 dark:text-slate-400">
                    <span>Fcst: <strong className="text-slate-800 dark:text-slate-200">{rel.forecast}</strong></span>
                    <span>•</span>
                    <span>Prev: <strong className="text-slate-800 dark:text-slate-200">{rel.previous}</strong></span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Institutional Playbook Guidance */}
          {activeRelease && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0d1017] border border-slate-200 dark:border-[#212838] text-xs space-y-2">
              <div className="font-bold text-blue-600 dark:text-blue-400 flex items-center gap-1.5">
                <Lightbulb className="w-4 h-4" />
                <span>Institutional Playbook Protocol</span>
              </div>
              <p className="text-slate-700 dark:text-slate-300 text-xs leading-relaxed">
                {activeRelease.institutionalInsight?.mentorExecutionStrategy || activeRelease.mentorNote}
              </p>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
};
