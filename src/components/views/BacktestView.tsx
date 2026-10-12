import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import {
  TrendingUp, RefreshCw, Play, Lightbulb, Trash2,
  Layers, Square, Copy, Check, Database, Clock, ShieldCheck, Download, Printer,
  FileText, Activity, Network, Info, FlaskConical, Wand2
} from 'lucide-react';
import {
  ThemeMode, BacktestReportPayload, BacktestKPIs, ImprovementTip,
  PortfolioCorrelation
} from '../../types';
import { formatCurrency } from '../../utils/currency';
import { describe } from '../../../shared/metricDescriptions';

interface BacktestViewProps {
  themeMode?: ThemeMode;
  brokerCurrency?: string;
}

interface SummaryCombination {
  label: string; mode: string; be: string; trail: string;
  rr: number; rr_label: string; report_file: string;
  total_trades: number; win_rate: number; expectancy: number;
  profit_factor: number; max_drawdown: number; net_pnl: number;
  adaptive_effective_pct: number; holdout_verdict?: string;
  tune_validate?: any; funnel?: any;
}

interface SymbolSummaryPayload {
  symbol: string; days: number; target_rr?: number | null;
  rr_values?: number[]; generated_at: string;
  total_seconds?: number; phase_seconds?: any; cache?: any;
  combinations: SummaryCombination[];
}

interface StorageInfo {
  total_mb: number; used_mb: number; free_mb: number;
  market_data_mb: number; reports_mb: number;
}

interface RunResultItem {
  symbol: string; status: 'OK' | 'FAILED'; message: string; timing?: string;
}

interface LabVariantRow {
  label: string; trades: number; win_rate: number; profit_factor: number;
  max_drawdown: number; net_pnl: number; expectancy: number;
  tune_pf: number; tune_trades: number; validate_pf: number; validate_trades: number;
  verdict: 'IMPROVES' | 'NO' | 'INCONCLUSIVE';
}

interface LabPayload {
  symbol: string; days: number; generated_at: string;
  window_start: string; window_end: string; baseline_label: string;
  variants: LabVariantRow[];
}

interface OptimizerDetails {
  isRunning?: boolean;
  pair?: string;
  strategy?: string;
  elapsed_s?: number;
  variants_tested?: number;
  suggested_file?: string;
  summary_file?: string;
}

const WHITELIST_ASSETS = ["US30", "GOLD", "NAS100", "GERMAN30", "EURUSD", "GBPUSD", "USDJPY"];

function formatNum(val: any, decimals = 2): string {
  const num = typeof val === 'number' ? val : parseFloat(val);
  return isNaN(num) ? '0.00' : num.toFixed(decimals);
}

function formatPriceBySymbol(price: any, symbol?: string): string {
  const num = parseFloat(price);
  if (isNaN(num)) return '--';
  const sym = (symbol || '').toUpperCase();
  if (sym.includes('EURUSD') || sym.includes('GBPUSD')) return num.toFixed(5);
  if (sym.includes('USDJPY')) return num.toFixed(3);
  return num.toFixed(2);
}

function corrColor(v: number): string {
  if (v >= 0.7) return 'bg-rose-500/40 text-rose-900 dark:text-rose-100 border-rose-500/50';
  if (v >= 0.4) return 'bg-amber-500/30 text-amber-900 dark:text-amber-100 border-amber-500/40';
  if (v >= 0.15) return 'bg-slate-400/20 text-slate-800 dark:text-slate-200 border-slate-400/30';
  if (v > -0.15) return 'bg-slate-200/40 dark:bg-[#0d1017] text-slate-600 dark:text-slate-300 border-slate-300 dark:border-[#1a2030]';
  if (v > -0.4) return 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 border-emerald-500/30';
  return 'bg-emerald-500/40 text-emerald-900 dark:text-emerald-100 border-emerald-500/50';
}

const InfoTip: React.FC<{ metricKey: string }> = ({ metricKey }) => {
  const [open, setOpen] = useState(false);
  const d = describe(metricKey);
  return (
    <span className="relative inline-flex items-center ml-1 align-middle"
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={`Info: ${d.title}`} tabIndex={0}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        className="text-slate-400 hover:text-blue-500 focus:text-blue-500 cursor-help outline-none">
        <Info className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 z-[60] w-64 p-3 rounded-xl bg-slate-900 text-white text-[11px] leading-relaxed shadow-2xl border border-slate-700 pointer-events-none">
          <div className="font-bold text-blue-300 mb-1">{d.title}</div>
          <div className="text-slate-200">{d.description}</div>
          <div className="mt-1.5 pt-1.5 border-t border-slate-700 text-slate-400 italic">
            {d.howToRead}
          </div>
        </div>
      )}
    </span>
  );
};

const HowToRead: React.FC<{ metricKey: string }> = ({ metricKey }) => {
  const d = describe(metricKey);
  return (
    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 flex items-start gap-1.5">
      <Info className="w-3 h-3 mt-0.5 shrink-0 text-blue-500" />
      <span>
        <strong className="not-italic text-blue-500">How to read this:</strong> {d.howToRead}
      </span>
    </p>
  );
};

const VerdictPill: React.FC<{ verdict?: string }> = ({ verdict }) => {
  const v = verdict || 'INCONCLUSIVE';
  const cfg: Record<string, string> = {
    HOLDS: 'bg-emerald-500/15 text-emerald-600 border border-emerald-500/30',
    FLAT: 'bg-slate-500/15 text-slate-500 border border-slate-400/30',
    FAILS: 'bg-rose-500/15 text-rose-600 border border-rose-500/30',
    INCONCLUSIVE: 'bg-slate-400/15 text-slate-500 border border-slate-400/30',
    IMPROVES: 'bg-emerald-500/15 text-emerald-600 border border-emerald-500/30',
    NO: 'bg-slate-500/15 text-slate-500 border border-slate-400/30',
    ROBUST: 'bg-emerald-500/15 text-emerald-600 border border-emerald-500/30',
    'NO CHANGE': 'bg-slate-500/15 text-slate-500 border border-slate-400/30',
    SKIPPED: 'bg-amber-500/15 text-amber-600 border border-amber-500/30',
  };
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold ${cfg[v] || cfg.INCONCLUSIVE}`}>
      {v}
    </span>
  );
};

function holdoutVerdictLocal(tune: any, val: any): string {
  const tCount = tune?.count ?? 0;
  const vCount = val?.count ?? 0;
  if (tCount < 30 || vCount < 30) return 'INCONCLUSIVE';
  const tPf = tune?.profit_factor ?? 0;
  const vPf = val?.profit_factor ?? 0;
  if (vPf < 0.95 || vPf < 0.7 * tPf) return 'FAILS';
  if (vPf < 1.10) return 'FLAT';
  return 'HOLDS';
}

// =============================================================================
// PDF HTML builders (mirrors the TXT sections)
// =============================================================================

function esc(s: any): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hTable(headers: string[], rows: string[][]): string {
  const th = headers.map(h => `<th>${esc(h)}</th>`).join('');
  const body = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table class="data"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

function kpiRow(k: any): string {
  if (!k) return 'n/a';
  return `TR ${k.count ?? 0} | WR ${formatNum(k.win_rate, 1)}% | PF ${formatNum(k.profit_factor)} | $${formatNum(k.net_pnl)}`;
}

function diagnosticsHtml(diag: any): string {
  if (!diag) return '<p class="muted">(no diagnostics in this report)</p>';
  const parts: string[] = [];
  if (diag.post_sl) parts.push(`<li><b>§16 Post-SL continuation:</b> n=${diag.post_sl.count} mean ${formatNum(diag.post_sl.mean_pips,1)} pips | median ${formatNum(diag.post_sl.median_pips,1)} | max ${formatNum(diag.post_sl.max_pips,1)} | mean_R ${formatNum(diag.post_sl.mean_r,2)} | recovered_to_TP ${diag.post_sl.recovered_count} (${formatNum(diag.post_sl.recovered_pct,1)}%)</li>`);
  if (diag.post_tp) parts.push(`<li><b>§17 Post-TP extra:</b> n=${diag.post_tp.count} mean ${formatNum(diag.post_tp.mean_pips,1)} pips | median ${formatNum(diag.post_tp.median_pips,1)} | max ${formatNum(diag.post_tp.max_pips,1)} | mean_R ${formatNum(diag.post_tp.mean_r,2)} | avg_missed_R ${formatNum(diag.post_tp.avg_missed_r,2)}</li>`);
  if (diag.premature_be) parts.push(`<li><b>§18 Premature BE:</b> moved ${diag.premature_be.total_be_moved} | premature ${diag.premature_be.premature_count} (${formatNum(diag.premature_be.premature_pct,1)}%) | total_missed_R ${formatNum(diag.premature_be.total_missed_r,2)}</li>`);
  if (diag.hour_kpis) {
    const rows: string[][] = [];
    for (let h = 0; h < 24; h++) {
      const k = diag.hour_kpis[String(h)];
      if (!k || k.count === 0) continue;
      rows.push([`${String(h).padStart(2,'0')}:00`, String(k.count), `${formatNum(k.win_rate,1)}%`, formatNum(k.profit_factor), `$${formatNum(k.net_pnl)}`, `${formatNum(k.expectancy,3)}R`]);
    }
    if (rows.length > 0) {
      parts.push(`<li><b>§19 Hour matrix (SAST):</b>${hTable(['Hour','Trades','WR','PF','Net $','Expectancy'], rows)}</li>`);
    }
  }
  if (diag.session_rollover) parts.push(`<li><b>§21 Session rollover:</b> in ${kpiRow(diag.session_rollover.in_transition)} | out ${kpiRow(diag.session_rollover.out_of_transition)}</li>`);
  if (diag.breakeven_variants) {
    const bv = diag.breakeven_variants;
    parts.push(`<li><b>§22 BE variants:</b> A_current ${formatNum(bv.A_current?.total_r,2)}R (n=${bv.A_current?.count ?? 0}) | B_no_BE ${formatNum(bv.B_no_be?.total_r,2)}R | C_delayed ${formatNum(bv.C_delayed_be?.total_r,2)}R | best ${esc(bv.best_variant)} | ${esc(bv.verdict)}</li>`);
  }
  if (diag.sizing_comparison) {
    const s = diag.sizing_comparison;
    parts.push(`<li><b>§24 Sizing:</b> fixed net $${formatNum(s.fixed?.net_pnl)} (final $${formatNum(s.fixed?.final_equity)}) | compounding $${formatNum(s.compounding?.net_pnl)} (final $${formatNum(s.compounding?.final_equity)}) | diff $${formatNum(s.difference)}</li>`);
  }
  if (diag.daily_cap_comparison) {
    const rows = Object.entries<any>(diag.daily_cap_comparison).map(([k, v]) => [esc(k), String(v.count ?? 0), `${formatNum(v.win_rate,1)}%`, formatNum(v.profit_factor), `$${formatNum(v.net_pnl)}`]);
    if (rows.length) parts.push(`<li><b>§25 Daily cap comparison:</b>${hTable(['Cap','Trades','WR','PF','Net $'], rows)}</li>`);
  }
  if (diag.atr_tier_kpis) {
    const rows: string[][] = [];
    for (const tier of ['LOW','NORMAL','HIGH','UNKNOWN']) {
      const k = diag.atr_tier_kpis[tier];
      if (!k || k.count === 0) continue;
      rows.push([tier, String(k.count), `${formatNum(k.win_rate,1)}%`, formatNum(k.profit_factor), `$${formatNum(k.net_pnl)}`]);
    }
    if (rows.length) parts.push(`<li><b>§26 ATR tiers:</b>${hTable(['Tier','Trades','WR','PF','Net $'], rows)}</li>`);
  }
  if (diag.ema_200_alignment) {
    const e = diag.ema_200_alignment;
    parts.push(`<li><b>§27 EMA-200 alignment:</b> aligned ${kpiRow(e.aligned)} | counter ${kpiRow(e.counter_trend)}</li>`);
  }
  if (diag.confirmation_type) parts.push(`<li><b>§28 Confirmation:</b> close ${kpiRow(diag.confirmation_type.close)} | touch ${kpiRow(diag.confirmation_type.touch)}</li>`);
  if (diag.news_window) parts.push(`<li><b>§29 News window:</b> in ${kpiRow(diag.news_window.in_news)} | out ${kpiRow(diag.news_window.out_of_news)}</li>`);
  if (diag.streak_analysis) {
    const s = diag.streak_analysis;
    parts.push(`<li><b>§31 Streaks:</b> max ${s.max_consecutive_losses ?? 0} | avg ${formatNum(s.average_streak,2)} | peak DD -$${formatNum(s.peak_drawdown)} | recovery ${s.recovery_trades_from_peak_dd ?? 0} trades</li>`);
  }
  if (diag.circuit_breaker_sim) {
    const c = diag.circuit_breaker_sim;
    parts.push(`<li><b>§32 Breaker sim:</b> orig $${formatNum(c.original_net_pnl)} -> sim $${formatNum(c.simulated_net_pnl)} | halved ${c.trades_halved ?? 0} | protection $${formatNum(c.protection_delta)}</li>`);
  }
  if (diag.daily_dd_cutoff) {
    const d = diag.daily_dd_cutoff;
    parts.push(`<li><b>§33 Daily DD cutoff:</b> cutoff ${formatNum(d.cutoff_pct,1)}% | days ${d.days_triggered} | blocked ${d.trades_blocked} | protection $${formatNum(d.protection_delta)}</li>`);
  }
  if (diag.slippage_sensitivity) {
    const rows: string[][] = [];
    for (const [, pt] of Object.entries<any>(diag.slippage_sensitivity)) {
      rows.push([`${pt.slippage_pips} pips`, `$${formatNum(pt.net_pnl)}`, `${formatNum(pt.win_rate,1)}%`, `${formatNum(pt.per_trade_cost_r,3)}R`]);
    }
    if (rows.length) parts.push(`<li><b>§34 Slippage:</b>${hTable(['Slippage','Net $','WR','Cost/trade'], rows)}</li>`);
  }
  if (diag.parameter_sensitivity && Array.isArray(diag.parameter_sensitivity.sweep) && diag.parameter_sensitivity.sweep.length > 0) {
    const rows = diag.parameter_sensitivity.sweep.map((r: any) => [`1:${formatNum(r.rr,2)}`, String(r.count), `$${formatNum(r.net_pnl)}`]);
    parts.push(`<li><b>§35 Parameter sweep:</b>${hTable(['R:R','Trades','Net $'], rows)} best R:R ${formatNum(diag.parameter_sensitivity.best_rr,2)}</li>`);
  }
  if (diag.outlier_removal) {
    const o = diag.outlier_removal;
    parts.push(`<li><b>§36 Outliers removed:</b> ${o.outlier_count ?? 0} | full ${kpiRow(o.full)} | trimmed ${kpiRow(o.trimmed)} | impact ${formatNum(o.impact_pct,1)}%</li>`);
  }
  if (diag.monte_carlo) {
    const m = diag.monte_carlo;
    parts.push(`<li><b>§37 Bootstrap MC:</b> iterations ${m.iterations} | median final $${formatNum(m.median_final_pnl)} (P5 $${formatNum(m.p5_final_pnl)}, P95 $${formatNum(m.p95_final_pnl)}) | median DD -$${formatNum(m.median_max_dd)} | prob positive ${formatNum(m.prob_positive,1)}%</li>`);
  }
  if (diag.buy_and_hold) {
    const b = diag.buy_and_hold;
    parts.push(`<li><b>§38 Alpha:</b> hold ${formatNum(b.bh_return_pct,2)}% ($${formatNum(b.bh_net_pnl)}) | strategy $${formatNum(b.strategy_net_pnl)} | alpha $${formatNum(b.alpha)} | ${esc(b.verdict)}</li>`);
  }
  return `<ul class="kv">${parts.join('')}</ul>`;
}

function portfolioMatrixHtml(pc: any): string {
  if (!pc || !Array.isArray(pc.symbols) || pc.symbols.length === 0) return '<p class="muted">(portfolio correlation matrix unavailable)</p>';
  const syms: string[] = pc.symbols;
  const corr: Record<string, Record<string, number>> = pc.correlation_matrix || {};
  const headers = ['Symbol', ...syms];
  const rows = syms.map(row => {
    const cells = syms.map(col => {
      const v = corr?.[row]?.[col];
      return formatNum(typeof v === 'number' ? v : 0, 2);
    });
    return [row, ...cells];
  });
  return hTable(headers, rows) +
    `<p class="muted">Portfolio max DD $${formatNum(pc.portfolio_drawdown)} | Sum of individual DDs $${formatNum(pc.sum_of_individual_drawdowns)} | Diversification ${formatNum(pc.diversification_ratio,2)}x | Avg daily corr ${formatNum(pc.avg_daily_correlation,3)} | Days ${pc.days}</p>`;
}

function ledgerSummaryHtml(trades: any[]): string {
  if (!Array.isArray(trades) || trades.length === 0) return '<p class="muted">(no trades)</p>';
  const n = trades.length;
  const wins = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');
  const avgWinR = wins.length > 0 ? wins.reduce((s, t) => s + (t.r_multiple || 0), 0) / wins.length : 0;
  const avgLossR = losses.length > 0 ? losses.reduce((s, t) => s + (t.r_multiple || 0), 0) / losses.length : 0;
  const totalR = trades.reduce((s, t) => s + (t.r_multiple || 0), 0);
  const totalPnl = trades.reduce((s, t) => s + (t.money_pnl || 0), 0);

  const ordered = [...trades].sort((a, b) => String(a.signal_time_utc || '').localeCompare(String(b.signal_time_utc || '')));
  let maxW = 0, maxL = 0, cw = 0, cl = 0;
  for (const t of ordered) {
    if (t.result === 'WIN') { cw++; cl = 0; if (cw > maxW) maxW = cw; }
    else if (t.result === 'LOSS') { cl++; cw = 0; if (cl > maxL) maxL = cl; }
  }

  const byPnl = [...trades].sort((a, b) => (b.money_pnl || 0) - (a.money_pnl || 0));
  const top25 = byPnl.slice(0, 25);
  const worst25 = byPnl.slice(-25).reverse();

  const tradeRow = (t: any) => [
    esc(t.date_sast || ''), esc(t.symbol || ''), esc(t.strategy || ''), esc(t.direction || ''),
    formatNum(t.entry_price, 5), formatNum(t.exit_price, 5),
    formatNum(t.r_multiple, 2), `$${formatNum(t.money_pnl)}`, esc(t.exit_reason || '')
  ];
  const tradeHeaders = ['Date','Symbol','Strategy','Dir','Entry','Exit','R','PnL $','Reason'];

  return `
    <p>Trades ${n} | Wins ${wins.length} | Losses ${losses.length} | Avg win ${formatNum(avgWinR,3)}R | Avg loss ${formatNum(avgLossR,3)}R | Total R ${formatNum(totalR,2)} | Net $${formatNum(totalPnl)}</p>
    <p>Longest win streak ${maxW} | Longest loss streak ${maxL}</p>
    <h4>Top 25 wins</h4>
    ${hTable(tradeHeaders, top25.map(tradeRow))}
    <h4>Top 25 losses</h4>
    ${hTable(tradeHeaders, worst25.map(tradeRow))}
  `;
}

function buildPdfHtml(exp: any): string {
  const okPairs = (exp.pairs || []).filter((p: any) => p.status === 'OK');
  const notTested = (exp.pairs || []).filter((p: any) => p.status !== 'OK');
  const ledgerRows = Number(exp.total_ledger_rows || 0);

  const sections: string[] = [];

  // Header
  sections.push(`
    <div class="header">
      <h1>NEXUS MATRIX — SIX-COMBINATION AUDIT REPORT</h1>
      <p class="muted">Run Date: ${esc(exp.generated_at?.slice(0, 10))} | Window: ${esc(exp.days)} days | Full trade ledger: backtest_ledger.csv (${ledgerRows} rows)</p>
    </div>
  `);

  // TOC
  sections.push(`
    <h2>Table of Contents</h2>
    <ol class="toc">
      <li>Legend</li>
      <li>Active settings differing from default</li>
      <li>Cross-pair rollup</li>
      <li>Per-pair sections (Summary, six combinations, per-strategy, per-weekday, skipped, ledger summary, diagnostics, tips, strategy lab)</li>
      <li>Portfolio correlation (full matrix)</li>
      <li>Ranked portfolio suggestions</li>
      <li>What to test next</li>
      <li>Entry condition analysis</li>
      <li>Optimizer summary</li>
      <li>Cost assumptions</li>
      <li>Consistency checks</li>
      <li>Not implemented</li>
    </ol>
  `);

  // Legend
  sections.push(`
    <h2>Legend</h2>
    <ul class="kv">
      <li>Six combinations: Adaptive only, BE off/on, R:R 1:1 / 1:2 / 1:3.</li>
      <li>Ledger summary lists streaks and the 25 best/worst trades. The full ledger is in <b>backtest_ledger.csv</b>.</li>
      <li>Diagnostics sections use §N labels that match the Blueprint.</li>
      <li>Any row under 30 trades is tagged INCONCLUSIVE.</li>
    </ul>
  `);

  // Non-default settings
  const nonDefault: string[] = Array.isArray(exp.non_default_settings) ? exp.non_default_settings : [];
  sections.push(`
    <h2>Active settings differing from default</h2>
    ${nonDefault.length === 0
      ? '<p class="muted">(none — all pairs and strategies use schema defaults)</p>'
      : `<ul class="kv">${nonDefault.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`}
  `);

  // Cross-pair rollup
  const rollupRows = Object.entries<any>(exp.combinations_rollup || {}).map(([combo, r]) => [
    esc(combo), String(r.total_trades), `${formatNum(r.weighted_win_rate,1)}%`, `$${formatNum(r.total_pnl)}`
  ]);
  sections.push(`
    <h2>Cross-pair rollup</h2>
    ${rollupRows.length ? hTable(['Combination','Trades','WR','Net $'], rollupRows) : '<p class="muted">(no data)</p>'}
  `);

  // Per-pair sections
  for (const p of okPairs) {
    const b = p.best_combination || {};
    const combos = p.combinations || [];

    const combosRows = combos.map((c: any) => {
      const tv = c.tune_validate || {};
      const t = tv.tune || {};
      const v = tv.validate || {};
      return [
        esc(c.label), String(c.total_trades ?? 0), `${formatNum(c.win_rate,1)}%`, formatNum(c.expectancy),
        formatNum(c.profit_factor), `-$${formatNum(c.max_drawdown)}`, `$${formatNum(c.net_pnl)}`,
        `${t.count ?? 0}t/${formatNum(t.profit_factor)}`,
        `${v.count ?? 0}t/${formatNum(v.profit_factor)}`,
        esc(c.holdout_verdict || 'INCONCLUSIVE')
      ];
    });

    const stratStv: Record<string, any> = b.strategy_tune_validate || {};
    const stratRows = Object.entries(b.strategy_kpis || {}).map(([sName, s]: any) => {
      const tv = stratStv[sName] || {};
      const t = tv.tune || {};
      const v = tv.validate || {};
      const inc = (s.count || 0) < 30 ? ' [INCONCLUSIVE]' : '';
      return [
        esc(sName) + inc, String(s.count ?? 0), `${formatNum(s.win_rate,1)}%`, formatNum(s.profit_factor),
        `$${formatNum(s.net_pnl)}`,
        `${t.count ?? 0}t/${formatNum(t.profit_factor)}`,
        `${v.count ?? 0}t/${formatNum(v.profit_factor)}`
      ];
    });

    const dowRows = Object.entries(b.dow_kpis || {}).map(([dow, k]: any) => {
      const inc = (k.count || 0) < 30 ? ' [INCONCLUSIVE]' : '';
      return [esc(dow), String(k.count ?? 0), `${formatNum(k.win_rate,1)}%`, formatNum(k.profit_factor), `$${formatNum(k.net_pnl)}` + inc];
    });

    const skipEntries = Object.entries(b.skipped_summary || {});
    const skipRows = skipEntries.map(([reason, val]: [string, any]) => {
      if (val && typeof val === 'object') {
        return [esc(reason), String(val.candle_skips ?? 0), String(val.unique_setups ?? 0)];
      }
      return [esc(reason), String(val), ''];
    });

    const labRows = (p.lab && Array.isArray(p.lab.variants)) ? p.lab.variants.map((v: any) => [
      esc(v.label), String(v.trades), `${formatNum(v.win_rate,1)}%`, formatNum(v.profit_factor),
      `-$${formatNum(v.max_drawdown)}`, `$${formatNum(v.net_pnl)}`,
      `${formatNum(v.tune_pf)} (${v.tune_trades})`, `${formatNum(v.validate_pf)} (${v.validate_trades})`,
      esc(v.verdict)
    ]) : [];

    const tips = Array.isArray(b.improvement_tips) ? b.improvement_tips : [];
    const ruleSuggestions = Array.isArray(b.rule_suggestions) ? b.rule_suggestions : [];

    sections.push(`
      <div class="pair">
        <h2>${esc(p.symbol)} ${p.wrong_engine ? '— <span class="warn">WRONG ENGINE</span>' : ''}</h2>
        <p class="muted">
          Generated: ${esc(p.generated_at || 'unknown')} | This run: ${p.seconds_taken != null ? p.seconds_taken + 's' : 'n/a'}
          ${p.engine_line ? ' | ' + esc(p.engine_line) : ''}
        </p>

        <h3>Summary: Six combinations</h3>
        ${hTable(['Combination','Trades','WR','Exp R','PF','Max DD','Net $','TUNE','VALIDATE','Verdict'], combosRows)}

        <h3>Summary: Per-strategy (best = ${esc(b.label || 'n/a')})</h3>
        ${stratRows.length ? hTable(['Strategy','Trades','WR','PF','Net $','TUNE','VALIDATE'], stratRows) : '<p class="muted">(no per-strategy data)</p>'}

        <h3>Summary: Per-weekday</h3>
        ${dowRows.length ? hTable(['Weekday','Trades','WR','PF','Net $'], dowRows) : '<p class="muted">(no weekday data)</p>'}

        <h3>Summary: Skipped signals</h3>
        ${skipRows.length ? hTable(['Reason','Candle skips','Unique setups'], skipRows) : '<p class="muted">(none)</p>'}

        <h3>Ledger summary</h3>
        ${ledgerSummaryHtml(b.all_trades || [])}

        <h3>Diagnostics</h3>
        ${diagnosticsHtml(b.diagnostics)}

        ${(tips.length > 0 || ruleSuggestions.length > 0) ? `
          <h3>Tips</h3>
          <ul class="kv">
            ${tips.map((t: any) => `<li><b>[${esc(t.severity || 'INFO')}] [${esc(t.strategy || 'ALL')}]</b> ${esc(t.title || '')}${t.action ? ` — <i>${esc(t.action)}</i>` : ''}</li>`).join('')}
            ${ruleSuggestions.map((s: any) => `<li><b>${esc(s.tag)}</b> ${esc(s.text)}</li>`).join('')}
          </ul>
        ` : ''}

        ${labRows.length ? `
          <h3>Strategy Lab (${esc(p.lab.days)} days)</h3>
          ${hTable(['Variant','Trades','WR','PF','Max DD','Net $','TUNE PF','VALIDATE PF','Verdict'], labRows)}
        ` : ''}
      </div>
    `);
  }

  // Not tested pairs
  if (notTested.length > 0) {
    sections.push(`
      <h2>NOT TESTED</h2>
      <ul class="kv">
        ${notTested.map((p: any) => `<li><b>${esc(p.symbol)}:</b> ${esc(p.error || 'unknown error')}</li>`).join('')}
      </ul>
    `);
  }

  // Portfolio
  sections.push(`
    <h2>Portfolio correlation</h2>
    ${portfolioMatrixHtml(exp.portfolio_correlation)}
  `);

  // Ranked suggestions
  const rankedSuggestions = Array.isArray(exp.portfolio_suggestions) ? exp.portfolio_suggestions : [];
  if (rankedSuggestions.length > 0) {
    sections.push(`
      <h2>Ranked portfolio suggestions</h2>
      <ul class="kv">
        ${rankedSuggestions.map((s: any) => `<li><b>${esc(s.tag)}</b> ${esc(s.text)}</li>`).join('')}
      </ul>
    `);
  }

  // What to test next
  const nextTests = Array.isArray(exp.what_to_test_next) ? exp.what_to_test_next : [];
  if (nextTests.length > 0) {
    sections.push(`
      <h2>What to test next</h2>
      <ol class="toc">
        ${nextTests.map((t: string) => `<li>${esc(t)}</li>`).join('')}
      </ol>
    `);
  }

  // Entry condition analysis
  sections.push(`
    <h2>Entry condition analysis</h2>
    <p class="muted">See backtest_ai.txt for the pooled entry-condition analysis; the PDF shows the same section list but the full buckets remain in the TXT.</p>
  `);

  // Optimizer summary
  sections.push(`
    <h2>Optimizer summary</h2>
    <p class="muted">See backtest_ai.txt for the full optimizer summary text. The optimizer writes config/pair_settings.suggested.json.</p>
  `);

  // Cost table
  sections.push(`
    <h2>Cost assumptions</h2>
    ${hTable(
      ['Symbol','Pip size','Contract size','Spread'],
      [
        ['GOLD','0.01','100.0','0.30'],
        ['US30','1.0','1.0','2.50'],
        ['NAS100','0.1','1.0','1.50'],
        ['GERMAN30','0.1','1.0','1.80'],
        ['EURUSD','0.0001','100000.0','0.00010'],
        ['USDJPY','0.01','100000.0','0.012'],
        ['GBPUSD','0.0001','100000.0','0.00014'],
      ]
    )}
    <p class="muted">Identical between the backtest and the live bot.</p>
  `);

  // Consistency checks
  const consistencyRows: string[][] = [];
  for (const p of okPairs) {
    const notes: string[] = [];
    if (p.wrong_engine) notes.push('WRONG ENGINE');
    if (p.engine_line) notes.push(p.engine_line);
    if (p.precompute_s != null) notes.push(`precompute this run ${p.precompute_s}s`);
    if (p.cache_built_at && p.cache_build_seconds != null) notes.push(`cache built ${Math.round(p.cache_build_seconds)}s on ${String(p.cache_built_at).slice(0,10)}`);
    if (notes.length) consistencyRows.push([p.symbol, notes.join(' | ')]);
  }
  if (consistencyRows.length > 0) {
    sections.push(`
      <h2>Consistency checks</h2>
      ${hTable(['Pair','Notes'], consistencyRows)}
    `);
  }

  // Not implemented
  const notImpl = (exp.spec_coverage || []).filter((row: any) => !row.panel && !row.txt);
  sections.push(`
    <h2>Not implemented</h2>
    ${notImpl.length === 0
      ? '<p class="muted">(none)</p>'
      : `<ul class="kv">${notImpl.map((row: any) => `<li>#${row.id} ${esc(row.label)}</li>`).join('')}</ul>`}
  `);

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Nexus Matrix Audit Report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111827; padding: 24px; font-size: 11px; }
  h1 { font-size: 18px; margin: 0 0 4px 0; }
  h2 { font-size: 14px; margin: 22px 0 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
  h3 { font-size: 12px; margin: 14px 0 6px; }
  h4 { font-size: 11px; margin: 10px 0 4px; }
  .header { border-bottom: 2px solid #2563eb; padding-bottom: 12px; margin-bottom: 12px; }
  .muted { color: #6b7280; font-size: 10px; margin: 4px 0; }
  .warn { color: #b91c1c; font-weight: bold; }
  .kv { margin: 4px 0; padding-left: 20px; }
  .kv li { margin: 3px 0; }
  .toc { margin: 4px 0; padding-left: 20px; }
  .toc li { margin: 2px 0; }
  .data { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-family: 'Courier New', monospace; font-size: 9px; }
  .data th, .data td { border-bottom: 1px solid #e5e7eb; padding: 3px 5px; text-align: left; }
  .data th { background: #f3f4f6; font-weight: bold; text-transform: uppercase; font-size: 9px; }
  .pair { page-break-before: auto; margin-bottom: 20px; }
  @media print { body { padding: 12px; } h2 { page-break-after: avoid; } table { page-break-inside: auto; } tr { page-break-inside: avoid; } }
</style>
</head>
<body>
${sections.join('\n')}
<script>window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };</script>
</body>
</html>`;
  return html;
}

export const BacktestView: React.FC<BacktestViewProps> = ({ themeMode = 'dark', brokerCurrency = 'USD' }) => {
  const [reportFiles, setReportFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [reportData, setReportData] = useState<BacktestReportPayload | null>(null);
  const [summaryData, setSummaryData] = useState<SymbolSummaryPayload | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<'summary' | 'diagnostics' | 'portfolio' | 'lab' | 'tips' | 'ledger'>('summary');
  const [selectedDay, setSelectedDay] = useState<string>('');

  const [testSymbol, setTestSymbol] = useState<string>('US30');
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(['US30']);
  const [testDays, setTestDays] = useState<number>(365);

  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [isCleaning, setIsCleaning] = useState<boolean>(false);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [progressText, setProgressText] = useState<string>('');
  const [runResults, setRunResults] = useState<RunResultItem[]>([]);

  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [verifyCopyStatus, setVerifyCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [verifyProgress, setVerifyProgress] = useState<string>('');
  const [isExportingPdf, setIsExportingPdf] = useState<boolean>(false);

  const [strategyFilter, setStrategyFilter] = useState<string>('ALL');
  const [outcomeFilter, setOutcomeFilter] = useState<string>('ALL');
  const [tipFilter, setTipFilter] = useState<string>('ALL');

  const [portfolioData, setPortfolioData] = useState<PortfolioCorrelation | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [isLoadingPortfolio, setIsLoadingPortfolio] = useState<boolean>(false);

  const [labRunning, setLabRunning] = useState<boolean>(false);
  const [labProgress, setLabProgress] = useState<string>('');
  const [labError, setLabError] = useState<string | null>(null);
  const [labPayloadBySymbol, setLabPayloadBySymbol] = useState<Record<string, LabPayload | null>>({});
  const [isLoadingLab, setIsLoadingLab] = useState<boolean>(false);
  const [labCopyStatus, setLabCopyStatus] = useState<Record<string, 'idle' | 'copied'>>({});

  const [optimizerRunning, setOptimizerRunning] = useState<boolean>(false);
  const [optimizerServerRunning, setOptimizerServerRunning] = useState<boolean>(false);
  const [optimizerProgress, setOptimizerProgress] = useState<string>('');
  const [optimizerError, setOptimizerError] = useState<string | null>(null);
  const [optimizerDetails, setOptimizerDetails] = useState<OptimizerDetails | null>(null);
  const [optimizerSummaryText, setOptimizerSummaryText] = useState<string | null>(null);
  const [optimizerCopyStatus, setOptimizerCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [showOptimizerSummary, setShowOptimizerSummary] = useState<boolean>(false);

  const [dismissedTipIds, setDismissedTipIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('dismissed_improvement_tips');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  const chartContainerRef = useRef<HTMLDivElement>(null);

  const fetchStorageInfo = useCallback(async () => {
    try {
      const res = await fetch('/api/backtest/storage');
      if (res.ok) {
        const json = await res.json();
        if (json.data) setStorageInfo(json.data);
      }
    } catch {}
  }, []);

  useEffect(() => { fetchStorageInfo(); }, [fetchStorageInfo]);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/backtest/status');
        if (res.ok) {
          const json = await res.json();
          if (json.isRunning) {
            setIsRunning(true);
            setProgressText(json.progress || 'Simulation in progress...');
          }
          if (Array.isArray(json.results) && json.results.length > 0) setRunResults(json.results);
        }
      } catch {}
    };
    checkStatus();
  }, []);

  const fetchReportList = useCallback(async () => {
    try {
      const res = await fetch('/api/backtest/reports');
      if (res.ok) {
        const json = await res.json();
        if (json.reports && json.reports.length > 0) {
          setReportFiles(json.reports);
          setSelectedFile(prev => json.reports.includes(prev) ? prev : json.reports[0]);
        }
      }
    } catch {}
  }, []);

  useEffect(() => { fetchReportList(); }, [fetchReportList]);

  const fetchSummaryData = useCallback(async (sym: string) => {
    try {
      const res = await fetch(`/api/backtest/summary/${sym}`);
      if (res.ok) {
        const json = await res.json();
        setSummaryData(json.data || null);
      } else { setSummaryData(null); }
    } catch { setSummaryData(null); }
  }, []);

  useEffect(() => { fetchSummaryData(testSymbol); }, [testSymbol, fetchSummaryData]);

  const fetchLabForSymbol = useCallback(async (sym: string) => {
    setIsLoadingLab(true);
    try {
      const res = await fetch(`/api/backtest/lab/${sym}`);
      if (res.ok) {
        const json = await res.json();
        setLabPayloadBySymbol(prev => ({ ...prev, [sym]: json.data || null }));
      } else {
        setLabPayloadBySymbol(prev => ({ ...prev, [sym]: null }));
      }
    } catch {
      setLabPayloadBySymbol(prev => ({ ...prev, [sym]: null }));
    } finally {
      setIsLoadingLab(false);
    }
  }, []);

  useEffect(() => {
    if (labPayloadBySymbol[testSymbol] === undefined) {
      fetchLabForSymbol(testSymbol);
    }
  }, [testSymbol, labPayloadBySymbol, fetchLabForSymbol]);

  const fetchPortfolio = useCallback(async () => {
    setIsLoadingPortfolio(true);
    setPortfolioError(null);
    try {
      const res = await fetch('/api/backtest/portfolio');
      if (res.ok) {
        const json = await res.json();
        setPortfolioData(json.data || null);
      } else {
        const err = await res.json().catch(() => ({}));
        setPortfolioError(err.message || 'Portfolio correlation unavailable.');
        setPortfolioData(null);
      }
    } catch (e: any) {
      setPortfolioError(`Network error: ${e.message}`);
      setPortfolioData(null);
    } finally {
      setIsLoadingPortfolio(false);
    }
  }, []);

  useEffect(() => {
    if (activeSubTab === 'portfolio') fetchPortfolio();
  }, [activeSubTab, fetchPortfolio]);

  useEffect(() => {
    if (!selectedFile) return;
    const loadReport = async () => {
      try {
        const res = await fetch(`/api/backtest/report/${encodeURIComponent(selectedFile)}`);
        if (res.ok) {
          const json = await res.json();
          if (json.data) {
            setReportData(json.data);
            if (json.data.trading_dates?.length > 0) setSelectedDay(json.data.trading_dates[0]);
          }
        }
      } catch {}
    };
    loadReport();
  }, [selectedFile]);

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/backtest/status');
        if (res.ok) {
          const json = await res.json();
          if (json.progress) setProgressText(json.progress);
          if (Array.isArray(json.results)) setRunResults(json.results);
          if (!json.isRunning) {
            setIsRunning(false);
            await fetchReportList();
            await fetchSummaryData(testSymbol);
            await fetchStorageInfo();
            if (activeSubTab === 'portfolio') fetchPortfolio();
          }
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [isRunning, fetchReportList, fetchSummaryData, fetchStorageInfo, fetchPortfolio, testSymbol, activeSubTab]);

  useEffect(() => {
    if (!labRunning) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/backtest/status');
        if (res.ok) {
          const json = await res.json();
          if (json.progress) setLabProgress(json.progress);
          if (!json.isRunning) {
            setLabRunning(false);
            for (const sym of selectedSymbols) {
              await fetchLabForSymbol(sym);
            }
          }
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [labRunning, selectedSymbols, fetchLabForSymbol]);

  useEffect(() => {
    const fetchOptimizerStatus = async () => {
      try {
        const res = await fetch('/api/backtest/optimize-status');
        if (!res.ok) return;
        const json = await res.json();

        if (json.progress) setOptimizerProgress(json.progress);
        if (json.details) setOptimizerDetails(json.details);
        if (json.lastError) setOptimizerError(json.lastError);
        if (typeof json.summaryText === 'string' && json.summaryText.length > 0) {
          setOptimizerSummaryText(json.summaryText);
        }

        const serverRunning = Boolean(json.isRunning);
        setOptimizerServerRunning(serverRunning);

        if (serverRunning && !optimizerRunning) {
          setOptimizerRunning(true);
          setOptimizerError(null);
        }

        if (!serverRunning && optimizerRunning) {
          setOptimizerRunning(false);
          setShowOptimizerSummary(true);
        }
      } catch {}
    };
    fetchOptimizerStatus();
    const interval = setInterval(fetchOptimizerStatus, 3000);
    return () => clearInterval(interval);
  }, [optimizerRunning]);

  const currentSymbolReports = useMemo(() => {
    return reportFiles.filter(f =>
      f.startsWith(`${testSymbol}_`) &&
      f !== 'portfolio_correlation.json' &&
      !f.endsWith('_lab.json') &&
      !f.endsWith('_verify.json') &&
      !f.endsWith('_compare.json') &&
      f !== 'optimizer_summary.json'
    );
  }, [reportFiles, testSymbol]);

  const toggleSymbol = (sym: string) => {
    setSelectedSymbols(prev => {
      const has = prev.includes(sym);
      const next = has ? prev.filter(s => s !== sym) : [...prev, sym];
      if (has && testSymbol === sym && next.length > 0) setTestSymbol(next[0]);
      if (!has && next.length === 1) setTestSymbol(sym);
      return next;
    });
  };

  const handleCleanup = async (scope: 'all_reports' | 'symbol') => {
    const sym = testSymbol;
    if (!window.confirm(scope === 'all_reports' ? 'Clear ALL reports and summaries?' : `Clear all reports for ${sym}?`)) return;
    setIsCleaning(true);
    try {
      const res = await fetch('/api/backtest/storage/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, symbol: sym }),
      });
      if (res.ok) {
        await fetchStorageInfo();
        await fetchReportList();
        await fetchSummaryData(testSymbol);
        if (scope === 'all_reports' || selectedFile.startsWith(`${sym}_`)) {
          setSelectedFile('');
          setReportData(null);
        }
      }
    } finally { setIsCleaning(false); }
  };

  const handleRunSelected = async () => {
    if (isRunning || selectedSymbols.length === 0) return;
    setIsRunning(true);
    setRunResults([]);
    setProgressText(`Preparing matrix for ${selectedSymbols.join(', ')}...`);
    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selectedSymbols.length === 1 ? selectedSymbols[0] : selectedSymbols,
          days: testDays,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setRunResults(selectedSymbols.map(s => ({ symbol: s, status: 'FAILED' as const, message: err.message || 'Run failed' })));
        setIsRunning(false);
      }
    } catch {
      setRunResults(selectedSymbols.map(s => ({ symbol: s, status: 'FAILED' as const, message: 'Network error connecting to runner' })));
      setIsRunning(false);
    }
  };

  const handleRunAll = async () => {
    if (isRunning) return;
    setIsRunning(true);
    setRunResults([]);
    setProgressText(`Preparing matrix for all 7 pairs...`);
    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'ALL', days: testDays }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setRunResults([{ symbol: 'ALL', status: 'FAILED', message: err.message || 'Run failed' }]);
        setIsRunning(false);
      }
    } catch {
      setRunResults([{ symbol: 'ALL', status: 'FAILED', message: 'Network error connecting to runner' }]);
      setIsRunning(false);
    }
  };

  const handleStopBacktest = async () => {
    try {
      await fetch('/api/backtest/stop', { method: 'POST' });
      setIsRunning(false);
      setProgressText('Cancelled.');
      await fetchStorageInfo();
    } catch {}
  };

  const handleRunStrategyLab = async () => {
    if (labRunning || selectedSymbols.length === 0) return;
    setLabRunning(true);
    setLabError(null);
    setLabProgress(`Launching Strategy Lab for ${selectedSymbols.join(', ')}...`);
    try {
      const res = await fetch('/api/backtest/lab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: selectedSymbols }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setLabError(err.message || 'Lab launch failed.');
        setLabRunning(false);
      }
    } catch (e: any) {
      setLabError(`Network error: ${e.message}`);
      setLabRunning(false);
    }
  };

  const handleRunOptimizer = async () => {
    if (optimizerRunning || optimizerServerRunning || isRunning || labRunning) return;
    if (!window.confirm(
      'Run the settings optimizer?\n\n' +
      'It will test many setting variations per strategy per pair on the ' +
      'cached signals. This takes up to 20 minutes. The live bot is NOT ' +
      'affected while it runs.\n\n' +
      'It writes config/pair_settings.suggested.json. Your live settings ' +
      'file is never touched.'
    )) return;

    setOptimizerRunning(true);
    setOptimizerError(null);
    setOptimizerSummaryText(null);
    setShowOptimizerSummary(false);
    setOptimizerProgress(`Launching optimizer for all ${WHITELIST_ASSETS.length} pairs...`);

    try {
      const res = await fetch('/api/backtest/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: 'ALL' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setOptimizerError(err.message || 'Optimizer launch failed.');
        setOptimizerRunning(false);
      }
    } catch (e: any) {
      setOptimizerError(`Network error: ${e.message}`);
      setOptimizerRunning(false);
    }
  };

  const handleStopOptimizer = async () => {
    try {
      await fetch('/api/backtest/optimize/stop', { method: 'POST' });
      setOptimizerRunning(false);
      setOptimizerServerRunning(false);
      setOptimizerProgress('Optimizer cancelled.');
    } catch {}
  };

  const handleCopyOptimizerSummary = () => {
    if (!optimizerSummaryText) return;
    navigator.clipboard.writeText(optimizerSummaryText).then(() => {
      setOptimizerCopyStatus('copied');
      setTimeout(() => setOptimizerCopyStatus('idle'), 2500);
    }).catch(() => {});
  };

  const handleCopyLabForAI = (sym: string) => {
    const lab = labPayloadBySymbol[sym];
    if (!lab) return;
    const lines: string[] = [];
    lines.push(`STRATEGY LAB — ${sym} (${lab.days}-day window)`);
    lines.push(`Baseline: ${lab.baseline_label}`);
    lines.push('');
    const sorted = [...lab.variants].sort((a, b) => {
      const rank = (v: string) => v === 'IMPROVES' ? 0 : v === 'NO' ? 1 : 2;
      return rank(a.verdict) - rank(b.verdict);
    });
    for (const v of sorted) {
      lines.push(`${v.label.padEnd(28)} | TR ${String(v.trades).padStart(4)} | WR ${formatNum(v.win_rate, 1)}% | PF ${formatNum(v.profit_factor)} | TUNE PF ${formatNum(v.tune_pf)} (${v.tune_trades}) | VALIDATE PF ${formatNum(v.validate_pf)} (${v.validate_trades}) | ${v.verdict}`);
    }
    navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
    setLabCopyStatus(prev => ({ ...prev, [sym]: 'copied' }));
    setTimeout(() => setLabCopyStatus(prev => ({ ...prev, [sym]: 'idle' })), 2500);
  };

  const formatVerifyResult = (r: any): string => {
    if (r.error) return `Error: ${r.error}`;
    const lines: string[] = [];
    lines.push(`VERIFY ${r.symbol} — ${r.days} days`);
    lines.push(`Old combo: ${r.old_combo || 'n/a'}`);
    lines.push(`New combo: ${r.new_combo || 'n/a'}`);
    lines.push(`Old trades: ${r.old_trades_count ?? 'n/a'} | New trades: ${r.new_trades_count ?? 'n/a'}`);
    if (r.old_kpis) lines.push(`Old KPIs: WR ${r.old_kpis.win_rate}%, PF ${r.old_kpis.profit_factor}, PnL $${r.old_kpis.net_pnl}, Max DD $${r.old_kpis.max_dd_money}`);
    if (r.new_kpis) lines.push(`New KPIs: WR ${r.new_kpis.win_rate}%, PF ${r.new_kpis.profit_factor}, PnL $${r.new_kpis.net_pnl}, Max DD $${r.new_kpis.max_dd_money}`);
    lines.push(`Verdict: ${r.verdict}`);
    if (Array.isArray(r.divergences_sample) && r.divergences_sample.length > 0) {
      lines.push('');
      lines.push(`First ${r.divergences_sample.length} divergent trades:`);
      for (const d of r.divergences_sample) {
        lines.push(`  [${d.stage}] index ${d.index}`);
        if (d.old) lines.push(`    old : ${d.old.signal_time_utc} ${d.old.direction} ${d.old.strategy} entry ${d.old.entry_price} sl ${d.old.sl} tp ${d.old.tp} exit ${d.old.exit_time} @ ${d.old.exit_price} (${d.old.exit_reason}) PnL $${d.old.money_pnl}`);
        if (d.new) lines.push(`    new : ${d.new.signal_time_utc} ${d.new.direction} ${d.new.strategy} entry ${d.new.entry_price} sl ${d.new.sl} tp ${d.new.tp} exit ${d.new.exit_time} @ ${d.new.exit_price} (${d.new.exit_reason}) PnL $${d.new.money_pnl}`);
      }
    }
    if (r.cost_assumptions) {
      lines.push('');
      lines.push('Cost assumptions:');
      if (r.cost_assumptions.old) lines.push(`  old: ${JSON.stringify(r.cost_assumptions.old)}`);
      if (r.cost_assumptions.new) lines.push(`  new: ${JSON.stringify(r.cost_assumptions.new)}`);
    }
    return lines.join('\n');
  };

  const handleVerifyVsOriginal = async () => {
    setIsVerifying(true);
    setVerifyResult(null);
    setVerifyProgress(`Starting comparison for ${testSymbol}...`);
    try {
      const start = await fetch('/api/backtest/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: testSymbol, days: 60 }),
      });
      const text = await start.text();
      let startJson: any = {};
      try { startJson = JSON.parse(text); } catch {
        setVerifyResult(`Non-JSON response (HTTP ${start.status}): ${text.slice(0, 200)}`);
        setIsVerifying(false);
        return;
      }
      if (!start.ok) {
        setVerifyResult(`Failed to start (HTTP ${start.status}): ${startJson.error || 'unknown'}`);
        setIsVerifying(false);
        return;
      }
      setVerifyProgress(startJson.message || 'Comparison running...');

      const pollId = window.setInterval(async () => {
        try {
          const statusRes = await fetch('/api/backtest/compare/status');
          const statusText = await statusRes.text();
          let statusJson: any = {};
          try { statusJson = JSON.parse(statusText); } catch {
            window.clearInterval(pollId);
            setIsVerifying(false);
            setVerifyResult(`Non-JSON poll (HTTP ${statusRes.status}): ${statusText.slice(0, 200)}`);
            return;
          }
          if (statusJson.progress) setVerifyProgress(statusJson.progress);
          if (!statusJson.isRunning) {
            window.clearInterval(pollId);
            setIsVerifying(false);
            if (statusJson.lastError) {
              setVerifyResult(`Comparison failed: ${statusJson.lastError}`);
            } else if (statusJson.result) {
              setVerifyResult(formatVerifyResult(statusJson.result));
            } else {
              setVerifyResult('Comparison finished but no result file was produced.');
            }
          }
        } catch (e: any) {
          window.clearInterval(pollId);
          setIsVerifying(false);
          setVerifyResult(`Poll error: ${e.message}`);
        }
      }, 3000);
    } catch (e: any) {
      setVerifyResult(`Network error: ${e.message}`);
      setIsVerifying(false);
    }
  };

  const handleExportPDF = async () => {
    setIsExportingPdf(true);
    try {
      const res = await fetch('/api/backtest/export-data');
      if (!res.ok) throw new Error('Could not fetch export data.');
      const json = await res.json();
      const exp = json.data;
      const html = buildPdfHtml(exp);
      const printWindow = window.open('', '_blank');
      if (!printWindow) {
        throw new Error('Popup blocked. Please allow popups for this site and try again.');
      }
      printWindow.document.write(html);
      printWindow.document.close();
    } catch (err: any) {
      alert(`PDF Export Notice: ${err?.message || String(err)}`);
    } finally {
      setIsExportingPdf(false);
    }
  };

  const kpis: BacktestKPIs = reportData?.global_kpis || {
    count: 0, win_rate: 0, avg_r: 0, expectancy: 0, profit_factor: 0, max_dd_money: 0,
    avg_duration: 0, best_r: 0, worst_r: 0, net_pnl: 0, is_inconclusive: true,
  };

  const filteredTrades = (reportData?.all_trades || []).filter((tr) => {
    return (strategyFilter === 'ALL' || tr.strategy === strategyFilter) &&
           (outcomeFilter === 'ALL' || tr.result === outcomeFilter);
  });

  const rawTips: ImprovementTip[] = reportData?.improvement_tips || [];
  const activeTips = rawTips.filter((tip) => {
    return !dismissedTipIds.includes(tip.id) &&
           (tipFilter === 'ALL' || tip.strategy === tipFilter || tip.category === tipFilter);
  });

  const bestComboIdx = summaryData?.combinations?.reduce((bestIdx, curr, currIdx, arr) => {
    if (curr.total_trades < 30) return bestIdx;
    if (bestIdx === -1) return currIdx;
    return curr.profit_factor > arr[bestIdx].profit_factor ? currIdx : bestIdx;
  }, -1) ?? -1;

  const exportPairCount = reportFiles.filter(f => f.endsWith('_summary.json') && !f.startsWith('.')).length;

  const anyJobRunning = isRunning || labRunning || optimizerRunning || optimizerServerRunning;

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-6 max-w-7xl mx-auto">
      <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-300 dark:border-[#1a2030]">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-black dark:text-white flex items-center gap-2.5">
            Backtest & Replay Suite
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
              Six Combinations
            </span>
          </h1>
          <p className="text-sm text-black dark:text-slate-400 mt-1">
            Adaptive only. BE off/on × R:R 1:1, 1:2, 1:3.
          </p>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-4 space-y-3"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-blue-500" />
            <span className="text-xs font-bold text-black dark:text-white">Pairs to test</span>
            <span className="text-[10px] font-mono text-slate-500">
              ({selectedSymbols.length} of {WHITELIST_ASSETS.length} selected)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setSelectedSymbols([...WHITELIST_ASSETS])} className="text-[11px] font-mono font-bold px-2.5 py-1 rounded-lg bg-white dark:bg-[#08090d] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] hover:border-blue-400 cursor-pointer">All</button>
            <button type="button" onClick={() => setSelectedSymbols([])} className="text-[11px] font-mono font-bold px-2.5 py-1 rounded-lg bg-white dark:bg-[#08090d] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] hover:border-rose-400 cursor-pointer">None</button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 pt-1">
          {WHITELIST_ASSETS.map((sym) => {
            const checked = selectedSymbols.includes(sym);
            const focused = testSymbol === sym;
            return (
              <button key={sym} type="button" onClick={() => toggleSymbol(sym)}
                className={`px-3 py-2 rounded-xl text-xs font-mono font-bold transition-colors cursor-pointer border ${checked ? 'bg-blue-600/15 border-blue-500/40 text-blue-700 dark:text-blue-300' : 'bg-slate-50 dark:bg-[#08090d] border-slate-300 dark:border-[#1a2030] text-slate-600 dark:text-slate-400 hover:border-slate-400'}`}>
                {sym}
                {focused && <span className="ml-1 text-[8px] opacity-60">•</span>}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 dark:border-[#1a2030]">
          <select value={testDays} onChange={(e) => setTestDays(parseInt(e.target.value, 10))} disabled={anyJobRunning} className="px-2.5 py-1.5 rounded-lg bg-transparent text-xs font-mono font-bold text-black dark:text-white cursor-pointer focus:outline-none border border-slate-300 dark:border-[#1a2030]">
            <option value={60}>60 Days</option>
            <option value={90}>90 Days</option>
            <option value={180}>180 Days</option>
            <option value={365}>365 Days</option>
          </select>

          {!isRunning ? (
            <>
              <button type="button" onClick={handleRunSelected} disabled={selectedSymbols.length === 0 || labRunning || optimizerRunning || optimizerServerRunning} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50">
                <Play className="w-3.5 h-3.5" />
                <span>Run Selected ({selectedSymbols.length})</span>
              </button>
              <button type="button" onClick={handleRunAll} disabled={labRunning || optimizerRunning || optimizerServerRunning} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">
                <Layers className="w-3.5 h-3.5" />
                <span>Run All</span>
              </button>
              <button type="button" onClick={handleRunStrategyLab} disabled={selectedSymbols.length === 0 || optimizerRunning || optimizerServerRunning} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50">
                <FlaskConical className="w-3.5 h-3.5" />
                <span>Strategy Lab</span>
              </button>
              <button type="button" onClick={handleRunOptimizer} disabled={labRunning || optimizerRunning || optimizerServerRunning} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50">
                <Wand2 className="w-3.5 h-3.5" />
                <span>Optimize settings</span>
              </button>
            </>
          ) : (
            <button type="button" onClick={handleStopBacktest} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer bg-rose-600 hover:bg-rose-500 text-white">
              <Square className="w-3.5 h-3.5" />
              <span>Stop</span>
            </button>
          )}
        </div>
      </motion.div>

      {(optimizerRunning || optimizerServerRunning || optimizerError || optimizerSummaryText) && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-purple-500/40 shadow-xs space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-purple-500" />
              <span className="text-xs font-bold text-black dark:text-white">
                Optimizer
              </span>
              {(optimizerRunning || optimizerServerRunning) && <RefreshCw className="w-3.5 h-3.5 text-purple-500 animate-spin" />}
            </div>
            <div className="flex items-center gap-2">
              {(optimizerRunning || optimizerServerRunning) && (
                <button type="button" onClick={handleStopOptimizer} className="px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold cursor-pointer">
                  Stop optimizer
                </button>
              )}
              {optimizerSummaryText && !optimizerRunning && !optimizerServerRunning && (
                <>
                  <button type="button" onClick={handleCopyOptimizerSummary} className="px-3 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer">
                    {optimizerCopyStatus === 'copied' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{optimizerCopyStatus === 'copied' ? 'Copied' : 'Copy summary'}</span>
                  </button>
                  <button type="button" onClick={() => setShowOptimizerSummary(v => !v)} className="px-3 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#141722] dark:hover:bg-[#1a2030] border border-slate-300 dark:border-[#1a2030] text-slate-700 dark:text-slate-200 text-xs font-semibold cursor-pointer">
                    {showOptimizerSummary ? 'Hide summary' : 'Show summary'}
                  </button>
                </>
              )}
            </div>
          </div>

          {(optimizerRunning || optimizerServerRunning) && (
            <div className="text-xs text-slate-500 font-mono">
              {optimizerProgress || 'Working...'}
              {optimizerDetails?.variants_tested != null && (
                <span className="ml-2">Variants tested: {optimizerDetails.variants_tested}</span>
              )}
              {optimizerDetails?.elapsed_s != null && (
                <span className="ml-2">Elapsed: {Math.round(optimizerDetails.elapsed_s)}s</span>
              )}
            </div>
          )}

          {optimizerError && !optimizerRunning && !optimizerServerRunning && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-700 dark:text-rose-300 font-mono">
              {optimizerError}
            </div>
          )}

          {optimizerSummaryText && !optimizerRunning && !optimizerServerRunning && (
            <div className="space-y-2">
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-800 dark:text-emerald-300">
                Optimizer finished. Your suggested settings file is at{' '}
                <code className="font-mono">config/pair_settings.suggested.json</code>.
                Your live settings file has not been changed. Review the summary
                and the TXT export before copying anything in.
              </div>
              {showOptimizerSummary && (
                <textarea
                  readOnly
                  value={optimizerSummaryText}
                  rows={24}
                  onFocus={(e) => e.target.select()}
                  className="w-full p-3.5 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-[11px] text-black dark:text-slate-200 focus:outline-none"
                />
              )}
            </div>
          )}
        </div>
      )}

      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs"
      >
        <div className="flex items-center gap-2 text-[11px] font-mono text-slate-600 dark:text-slate-300">
          <FileText className="w-3.5 h-3.5 text-blue-500" />
          <span>Exporting <strong className="text-black dark:text-white">{exportPairCount}</strong> pair{exportPairCount === 1 ? '' : 's'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <a href="/api/backtest/export-zip" download className="px-3 py-2 rounded-xl bg-white hover:bg-slate-100 dark:bg-[#0f1118] dark:hover:bg-[#141722] border border-slate-300 dark:border-[#1a2030] text-xs font-semibold text-black dark:text-slate-200 flex items-center gap-1.5 cursor-pointer transition-colors shadow-xs">
            <Download className="w-3.5 h-3.5 text-blue-500" />
            <span>Export for AI (.zip)</span>
          </a>
          <button type="button" onClick={handleExportPDF} disabled={isExportingPdf} className="px-3 py-2 rounded-xl bg-white hover:bg-slate-100 dark:bg-[#0f1118] dark:hover:bg-[#141722] border border-slate-300 dark:border-[#1a2030] text-xs font-semibold text-black dark:text-slate-200 flex items-center gap-1.5 cursor-pointer transition-colors shadow-xs disabled:opacity-50">
            <Printer className="w-3.5 h-3.5 text-emerald-500" />
            <span>{isExportingPdf ? 'Building PDF...' : 'Export PDF'}</span>
          </button>
          <button type="button" disabled={isVerifying || anyJobRunning} onClick={handleVerifyVsOriginal} className="px-3 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-50 transition-colors">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>{isVerifying ? 'Verifying...' : 'Verify vs Reference (60 days)'}</span>
          </button>
        </div>
      </motion.div>

      {(isVerifying || verifyResult) && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-purple-500/40 shadow-xs space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-purple-500" />
              <span className="text-xs font-bold text-black dark:text-white">
                Verify vs Reference ({testSymbol} · 60 days)
              </span>
              {isVerifying && <RefreshCw className="w-3.5 h-3.5 text-purple-500 animate-spin" />}
            </div>
            <div className="flex items-center gap-2">
              {verifyResult && !isVerifying && (
                <button type="button"
                  onClick={() => { navigator.clipboard.writeText(verifyResult); setVerifyCopyStatus('copied'); setTimeout(() => setVerifyCopyStatus('idle'), 2000); }}
                  className="px-3 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer">
                  {verifyCopyStatus === 'copied' ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{verifyCopyStatus === 'copied' ? 'Copied' : 'Copy Result'}</span>
                </button>
              )}
              {!isVerifying && (
                <button type="button" onClick={() => { setVerifyResult(null); setVerifyProgress(''); }} className="text-xs text-slate-400 hover:text-black dark:hover:text-white cursor-pointer ml-1">Dismiss</button>
              )}
            </div>
          </div>
          {isVerifying && (
            <div className="text-xs text-slate-500 font-mono">{verifyProgress || 'Comparison running...'}</div>
          )}
          {verifyResult && (
            <textarea readOnly value={verifyResult} rows={20} onFocus={(e) => e.target.select()} className="w-full p-3.5 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-xs text-black dark:text-slate-200 focus:outline-none" />
          )}
        </div>
      )}

      {labRunning && (
        <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-xs">
          <div className="flex items-center gap-3">
            <FlaskConical className="w-4 h-4 text-amber-500 animate-pulse shrink-0" />
            <div>
              <div className="font-bold text-amber-700 dark:text-amber-400">Strategy Lab in Progress</div>
              <div className="text-slate-500 font-mono text-[11px] mt-0.5">{labProgress || 'Testing variants...'}</div>
            </div>
          </div>
        </div>
      )}

      {labError && (
        <div className="p-3 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-700 dark:text-rose-300 flex items-center justify-between">
          <span className="font-mono">Strategy Lab error: {labError}</span>
          <button type="button" onClick={() => setLabError(null)} className="text-xs text-slate-400 hover:text-rose-600 cursor-pointer">Dismiss</button>
        </div>
      )}

      {storageInfo && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <Database className="w-4 h-4 text-blue-500 shrink-0" />
              <span className="font-bold text-black dark:text-white">Storage:</span>
              <span className="font-mono text-slate-600 dark:text-slate-300">{storageInfo.used_mb} MB used / {storageInfo.free_mb} MB free</span>
              <span className="font-mono text-[11px] text-slate-500">Reports: <strong className="text-blue-500">{storageInfo.reports_mb} MB</strong> · Data: <strong className="text-emerald-500">{storageInfo.market_data_mb} MB</strong></span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button type="button" disabled={isCleaning || anyJobRunning} onClick={() => handleCleanup('symbol')} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-[#141722] text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-[#1a2030] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
                <Trash2 className="w-3 h-3 text-amber-500" /><span>Clear {testSymbol} reports</span>
              </button>
              <button type="button" disabled={isCleaning || anyJobRunning} onClick={() => handleCleanup('all_reports')} className="px-3 py-1.5 rounded-lg bg-rose-600/10 hover:bg-rose-600/20 text-rose-600 border border-rose-500/30 text-[11px] font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
                <Trash2 className="w-3 h-3 text-rose-500" /><span>Clear all</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {runResults.length > 0 && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-black dark:text-white">Run Results</span>
            <button onClick={() => setRunResults([])} className="text-xs text-slate-400 hover:text-black dark:hover:text-white cursor-pointer">Dismiss</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 pt-1">
            {runResults.map((r, i) => (
              <div key={i} className={`p-3 rounded-xl border text-xs font-mono ${r.status === 'OK' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600' : 'bg-rose-500/10 border-rose-500/30 text-rose-600'}`}>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-black dark:text-white">{r.symbol}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${r.status === 'OK' ? 'bg-emerald-500/20 text-emerald-600' : 'bg-rose-500/20 text-rose-600'}`}>{r.status}</span>
                </div>
                <div className="text-[11px] break-words whitespace-pre-wrap mt-1">{r.message}</div>
                {r.timing && (
                  <div className="pt-1.5 mt-1 border-t border-slate-200 dark:border-[#1a2030] text-[10px] text-slate-600 dark:text-slate-400 flex items-start gap-1">
                    <Clock className="w-3 h-3 text-blue-500 shrink-0 mt-0.5" />
                    <span>{r.timing}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {isRunning && (
        <div className="p-4 rounded-2xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-between text-xs">
          <div className="flex items-center gap-3">
            <RefreshCw className="w-4 h-4 text-blue-500 animate-spin shrink-0" />
            <div>
              <div className="font-bold text-blue-600 dark:text-blue-400">Simulation in Progress</div>
              <div className="text-slate-500 font-mono text-[11px] mt-0.5">{progressText}</div>
            </div>
          </div>
          <button type="button" onClick={handleStopBacktest} className="px-3 py-1.5 rounded-lg text-[11px] font-bold font-mono bg-rose-600 hover:bg-rose-500 text-white cursor-pointer">Cancel</button>
        </div>
      )}

      {summaryData?.combinations && summaryData.combinations.length > 0 && (
        <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5 space-y-3">
          <h3 className="text-sm font-bold text-black dark:text-white">
            Results by Combination ({summaryData.symbol} · {summaryData.days} Days)
          </h3>
          <HowToRead metricKey="sec_combinations" />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                  <th className="py-2.5 px-3">Combination</th>
                  <th className="py-2.5 px-3 text-center">Trades</th>
                  <th className="py-2.5 px-3 text-center">Win Rate</th>
                  <th className="py-2.5 px-3 text-center">Exp (R)</th>
                  <th className="py-2.5 px-3 text-center">PF</th>
                  <th className="py-2.5 px-3 text-right">Max DD</th>
                  <th className="py-2.5 px-3 text-right">Net P&L</th>
                  <th className="py-2.5 px-3 text-center">Cov</th>
                  <th className="py-2.5 px-3 text-center">TUNE</th>
                  <th className="py-2.5 px-3 text-center">VALIDATE</th>
                  <th className="py-2.5 px-3 text-center">Verdict</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                {summaryData.combinations.map((c: any, idx: number) => {
                  const tv = c.tune_validate || {};
                  const cTune = tv.tune || {};
                  const cVal = tv.validate || {};
                  const holdout = c.holdout_verdict || holdoutVerdictLocal(cTune, cVal);
                  return (
                    <tr key={idx} onClick={() => setSelectedFile(c.report_file)} className={`cursor-pointer transition-colors ${selectedFile === c.report_file ? 'bg-blue-500/15' : idx === bestComboIdx ? 'bg-amber-500/10' : 'hover:bg-slate-50 dark:hover:bg-[#121520]'}`}>
                      <td className="py-3 px-3 font-bold text-black dark:text-white">
                        {idx === bestComboIdx && <span className="text-amber-500 mr-1">★</span>}
                        {c.label}
                      </td>
                      <td className="py-3 px-3 text-center font-bold">{c.total_trades}</td>
                      <td className={`py-3 px-3 text-center font-bold ${c.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{c.win_rate}%</td>
                      <td className="py-3 px-3 text-center">{c.expectancy}R</td>
                      <td className="py-3 px-3 text-center">{c.profit_factor}</td>
                      <td className="py-3 px-3 text-right text-rose-500">-${c.max_drawdown}</td>
                      <td className={`py-3 px-3 text-right font-bold ${c.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${c.net_pnl}</td>
                      <td className="py-3 px-3 text-center text-blue-500">{c.adaptive_effective_pct}%</td>
                      <td className="py-3 px-3 text-center text-[11px]">{cTune.count ?? 0}t / PF {formatNum(cTune.profit_factor)}</td>
                      <td className="py-3 px-3 text-center text-[11px]">{cVal.count ?? 0}t / PF {formatNum(cVal.profit_factor)}</td>
                      <td className="py-3 px-3 text-center"><VerdictPill verdict={holdout} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-[#1a2030] pb-2">
        <button onClick={() => setActiveSubTab('summary')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'summary' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <TrendingUp className="w-3.5 h-3.5" /><span>Summary</span>
        </button>
        <button onClick={() => setActiveSubTab('diagnostics')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'diagnostics' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <Activity className="w-3.5 h-3.5" /><span>Diagnostics</span>
        </button>
        <button onClick={() => setActiveSubTab('portfolio')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'portfolio' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <Network className="w-3.5 h-3.5" /><span>Portfolio</span>
        </button>
        <button onClick={() => setActiveSubTab('lab')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'lab' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <FlaskConical className="w-3.5 h-3.5" /><span>Strategy Lab</span>
        </button>
        <button onClick={() => setActiveSubTab('tips')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'tips' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <Lightbulb className="w-3.5 h-3.5" /><span>Tips</span>
        </button>
        <button onClick={() => setActiveSubTab('ledger')} className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-2 ${activeSubTab === 'ledger' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
          <FileText className="w-3.5 h-3.5" /><span>Ledger ({reportData?.all_trades?.length || 0})</span>
        </button>
      </div>

      {activeSubTab === 'summary' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Total Trades <InfoTip metricKey="total_trades" /></div>
              <div className="text-2xl font-bold font-mono text-blue-600 dark:text-blue-400 mt-1">{kpis.count}</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Win Rate <InfoTip metricKey="win_rate" /></div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{kpis.win_rate}%</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Expectancy <InfoTip metricKey="expectancy" /></div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.expectancy > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{kpis.expectancy}R</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Profit Factor <InfoTip metricKey="profit_factor" /></div>
              <div className="text-2xl font-bold font-mono text-black dark:text-white mt-1">{kpis.profit_factor}</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Max DD <InfoTip metricKey="max_drawdown" /></div>
              <div className="text-2xl font-bold font-mono text-rose-600 mt-1">-${kpis.max_dd_money}</div>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center">Net P&L <InfoTip metricKey="net_pnl" /></div>
              <div className={`text-2xl font-bold font-mono mt-1 ${kpis.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{formatCurrency(kpis.net_pnl, brokerCurrency)}</div>
            </div>
          </div>

          {reportData?.strategy_kpis && Object.keys(reportData.strategy_kpis).length > 0 && (
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3">Per-Strategy</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                      <th className="py-2.5 px-3">Strategy</th>
                      <th className="py-2.5 px-3 text-center">Trades</th>
                      <th className="py-2.5 px-3 text-center">Win Rate</th>
                      <th className="py-2.5 px-3 text-center">PF</th>
                      <th className="py-2.5 px-3 text-right">Net P&L</th>
                      <th className="py-2.5 px-3 text-center">Verdict</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                    {Object.entries(reportData.strategy_kpis).map(([sName, sKpi]: any) => {
                      const tv = (reportData as any)?.strategy_tune_validate?.[sName] || {};
                      const verdict = holdoutVerdictLocal(tv.tune, tv.validate);
                      return (
                        <tr key={sName} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                          <td className="py-3 px-3 font-bold text-black dark:text-white">{sName}</td>
                          <td className="py-3 px-3 text-center font-bold">{sKpi.count}</td>
                          <td className={`py-3 px-3 text-center font-bold ${sKpi.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{sKpi.win_rate}%</td>
                          <td className="py-3 px-3 text-center">{sKpi.profit_factor}</td>
                          <td className={`py-3 px-3 text-right font-bold ${sKpi.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${sKpi.net_pnl}</td>
                          <td className="py-3 px-3 text-center"><VerdictPill verdict={verdict} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {reportData?.dow_kpis && Object.keys(reportData.dow_kpis).length > 0 && (
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3">Per-Weekday</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                      <th className="py-2.5 px-3">Weekday</th>
                      <th className="py-2.5 px-3 text-center">Trades</th>
                      <th className="py-2.5 px-3 text-center">Win Rate</th>
                      <th className="py-2.5 px-3 text-center">PF</th>
                      <th className="py-2.5 px-3 text-right">Net P&L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                    {Object.entries(reportData.dow_kpis).map(([dow, sKpi]: any) => (
                      <tr key={dow} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                        <td className="py-3 px-3 font-bold text-black dark:text-white">{dow}</td>
                        <td className="py-3 px-3 text-center font-bold">{sKpi.count}</td>
                        <td className={`py-3 px-3 text-center font-bold ${sKpi.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{sKpi.win_rate}%</td>
                        <td className="py-3 px-3 text-center">{sKpi.profit_factor}</td>
                        <td className={`py-3 px-3 text-right font-bold ${sKpi.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${sKpi.net_pnl}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'diagnostics' && reportData?.diagnostics && (
        <div className="space-y-4">
          <HowToRead metricKey="sec_diagnostics" />
          <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
            <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§19 Hour Matrix <InfoTip metricKey="diag_hour_matrix" /></h3>
            <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-12 gap-2">
              {Array.from({ length: 24 }, (_, h) => {
                const k = reportData.diagnostics?.hour_kpis?.[String(h)];
                const hasData = k && k.count > 0;
                const isWin = hasData && k.net_pnl >= 0;
                return (
                  <div key={h} className={`p-2 rounded-xl border text-[10px] font-mono ${!hasData ? 'bg-slate-50 dark:bg-[#08090d] border-slate-200 dark:border-[#1a2030] text-slate-400' : isWin ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600' : 'bg-rose-500/10 border-rose-500/30 text-rose-600'}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold">{String(h).padStart(2, '0')}</span>
                    </div>
                    {hasData ? (
                      <>
                        <div className="truncate">n={k.count}</div>
                        <div className="truncate font-bold">{k.win_rate}%</div>
                        <div className="truncate">{k.net_pnl >= 0 ? '+' : ''}${k.net_pnl}</div>
                      </>
                    ) : <div className="text-center text-slate-300 dark:text-slate-600">—</div>}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§31 Streaks <InfoTip metricKey="diag_streak" /></h3>
              <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Max Streak</div>
                  <div className="text-lg font-bold text-rose-500">{reportData.diagnostics.streak_analysis.max_consecutive_losses}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Peak DD</div>
                  <div className="text-lg font-bold text-rose-500">-${reportData.diagnostics.streak_analysis.peak_drawdown}</div>
                </div>
              </div>
            </div>

            <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§37 Bootstrap Monte Carlo <InfoTip metricKey="diag_monte_carlo" /></h3>
              <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Median Final P&L</div>
                  <div className={`text-lg font-bold ${(reportData.diagnostics.monte_carlo.median_final_pnl ?? 0) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${reportData.diagnostics.monte_carlo.median_final_pnl}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#08090d] border border-slate-200 dark:border-[#1a2030]">
                  <div className="text-[10px] text-slate-500 uppercase">Prob Positive</div>
                  <div className={`text-lg font-bold ${(reportData.diagnostics.monte_carlo.prob_positive ?? 0) >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{reportData.diagnostics.monte_carlo.prob_positive}%</div>
                </div>
              </div>
            </div>
          </div>

          <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
            <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§38 Alpha <InfoTip metricKey="diag_buy_and_hold" /></h3>
            <div className="text-xs font-mono">
              <div>Strategy P&L: <span className={`font-bold ${(reportData.diagnostics.buy_and_hold.strategy_net_pnl ?? 0) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${reportData.diagnostics.buy_and_hold.strategy_net_pnl}</span></div>
              <div>Hold P&L: <span className="font-bold">${reportData.diagnostics.buy_and_hold.bh_net_pnl}</span></div>
              <div>Alpha: <span className={`font-bold ${(reportData.diagnostics.buy_and_hold.alpha ?? 0) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${reportData.diagnostics.buy_and_hold.alpha}</span></div>
              <div className="mt-2 text-[11px] text-slate-500">Verdict: {reportData.diagnostics.buy_and_hold.verdict}</div>
            </div>
          </div>

          {reportData.diagnostics.slippage_sensitivity && Object.keys(reportData.diagnostics.slippage_sensitivity).length > 0 && (
            <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030]">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3 flex items-center">§34 Slippage <InfoTip metricKey="diag_slippage" /></h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                      <th className="py-2 px-3">Slippage</th>
                      <th className="py-2 px-3 text-right">Net P&L</th>
                      <th className="py-2 px-3 text-center">Win Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                    {Object.values(reportData.diagnostics.slippage_sensitivity).map((pt: any, i: number) => (
                      <tr key={i}>
                        <td className="py-2.5 px-3 font-bold text-black dark:text-white">
                          {pt.slippage_pips === 0 ? 'Baseline' : `${pt.slippage_pips} pip${pt.slippage_pips > 1 ? 's' : ''}`}
                        </td>
                        <td className={`py-2.5 px-3 text-right font-bold ${pt.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${pt.net_pnl}</td>
                        <td className="py-2.5 px-3 text-center">{pt.win_rate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'portfolio' && (
        <div className="space-y-4">
          {isLoadingPortfolio ? (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center">
              <RefreshCw className="w-6 h-6 text-blue-500 animate-spin mx-auto" />
            </div>
          ) : portfolioData ? (
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] p-5">
              <h3 className="text-sm font-bold text-black dark:text-white mb-3">Portfolio Correlation</h3>
              <div className="overflow-x-auto">
                <table className="text-[11px] font-mono border-separate border-spacing-0.5">
                  <thead>
                    <tr>
                      <th className="px-2 py-1.5"></th>
                      {portfolioData.symbols.map((s) => <th key={s} className="px-2 py-1.5 text-center">{s}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {portfolioData.symbols.map((rowSym) => (
                      <tr key={rowSym}>
                        <td className="px-2 py-1.5 font-bold text-right">{rowSym}</td>
                        {portfolioData.symbols.map((colSym) => {
                          const v = portfolioData.correlation_matrix?.[rowSym]?.[colSym];
                          const num = typeof v === 'number' ? v : 0;
                          const isSelf = rowSym === colSym;
                          return (
                            <td key={colSym} className={`px-2 py-1.5 text-center rounded border ${isSelf ? 'bg-blue-500/20' : corrColor(num)}`}>
                              {isSelf ? '1.00' : num.toFixed(2)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center text-xs text-slate-500">
              {portfolioError || 'No portfolio correlation yet'}
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'lab' && (
        <div className="space-y-4">
          {labPayloadBySymbol[testSymbol] ? (
            <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-amber-500/30 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-black dark:text-white">
                  Strategy Lab — {testSymbol} · Baseline: {labPayloadBySymbol[testSymbol]!.baseline_label}
                </h3>
                <button type="button" onClick={() => handleCopyLabForAI(testSymbol)} className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold flex items-center gap-1 cursor-pointer">
                  {labCopyStatus[testSymbol] === 'copied' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{labCopyStatus[testSymbol] === 'copied' ? 'Copied' : 'Copy for AI'}</span>
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500">
                      <th className="py-2.5 px-3">Variant</th>
                      <th className="py-2.5 px-3 text-center">Trades</th>
                      <th className="py-2.5 px-3 text-center">Win Rate</th>
                      <th className="py-2.5 px-3 text-center">PF</th>
                      <th className="py-2.5 px-3 text-right">Net P&L</th>
                      <th className="py-2.5 px-3 text-center">TUNE PF (TR)</th>
                      <th className="py-2.5 px-3 text-center">VALIDATE PF (TR)</th>
                      <th className="py-2.5 px-3 text-center">Verdict</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                    {[...labPayloadBySymbol[testSymbol]!.variants]
                      .sort((a, b) => {
                        const rank = (v: string) => v === 'IMPROVES' ? 0 : v === 'NO' ? 1 : 2;
                        return rank(a.verdict) - rank(b.verdict);
                      })
                      .map((v, i) => (
                        <tr key={i} className={`hover:bg-slate-50 dark:hover:bg-[#121520] ${v.verdict === 'IMPROVES' ? 'bg-emerald-500/5' : ''}`}>
                          <td className="py-2.5 px-3 font-bold text-black dark:text-white">{v.label}</td>
                          <td className="py-2.5 px-3 text-center">{v.trades}</td>
                          <td className={`py-2.5 px-3 text-center font-bold ${v.win_rate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{formatNum(v.win_rate, 1)}%</td>
                          <td className="py-2.5 px-3 text-center">{formatNum(v.profit_factor)}</td>
                          <td className={`py-2.5 px-3 text-right font-bold ${v.net_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${formatNum(v.net_pnl)}</td>
                          <td className="py-2.5 px-3 text-center">{formatNum(v.tune_pf)} ({v.tune_trades})</td>
                          <td className="py-2.5 px-3 text-center">{formatNum(v.validate_pf)} ({v.validate_trades})</td>
                          <td className="py-2.5 px-3 text-center"><VerdictPill verdict={v.verdict} /></td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center text-xs text-slate-500">
              {isLoadingLab ? 'Loading...' : `No lab for ${testSymbol}. Click Strategy Lab above.`}
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'tips' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {activeTips.map((tip) => (
            <div key={tip.id} className="p-5 rounded-2xl border bg-white dark:bg-[#0f1118] flex flex-col justify-between space-y-3">
              <div className="flex items-center justify-between">
                <span className="px-2 py-0.5 rounded text-[9px] font-mono font-bold bg-blue-500/15 text-blue-600">{tip.severity}</span>
                <button type="button" onClick={() => setDismissedTipIds(prev => [...prev, tip.id])} className="text-slate-400 hover:text-rose-600"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
              <h4 className="text-sm font-bold text-black dark:text-white">{tip.title}</h4>
              <p className="text-xs text-slate-600 dark:text-slate-400">{tip.description}</p>
            </div>
          ))}
          {activeTips.length === 0 && (
            <div className="col-span-full p-8 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] text-center text-xs text-slate-500">
              No tips for this report.
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'ledger' && (
        <div className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-200 dark:border-[#1a2030] text-[10px] uppercase font-bold text-slate-500 bg-slate-50 dark:bg-[#08090d]/50">
                  <th className="py-3 px-3">Date</th><th className="py-3 px-3">Strategy</th><th className="py-3 px-3">Dir</th><th className="py-3 px-3">Entry</th><th className="py-3 px-3">Exit</th><th className="py-3 px-3">R</th><th className="py-3 px-3 text-right">Net P&L</th><th className="py-3 px-3">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#141a26]">
                {filteredTrades.slice(0, 500).map((t: any, idx: number) => (
                  <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-[#121520]">
                    <td className="py-2.5 px-3 text-slate-400">{t.date_sast || t.date}</td>
                    <td className="py-2.5 px-3 font-bold text-black dark:text-white">{t.strategy}</td>
                    <td className={`py-2.5 px-3 font-bold ${t.direction === 'BUY' ? 'text-emerald-500' : 'text-rose-500'}`}>{t.direction}</td>
                    <td className="py-2.5 px-3">{formatPriceBySymbol(t.entry_price, t.symbol)}</td>
                    <td className="py-2.5 px-3">{formatPriceBySymbol(t.exit_price, t.symbol)}</td>
                    <td className={`py-2.5 px-3 font-bold ${t.r_multiple > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{t.r_multiple}R</td>
                    <td className={`py-2.5 px-3 text-right font-bold ${t.money_pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${t.money_pnl}</td>
                    <td className="py-2.5 px-3"><span className={`text-[9px] px-2 py-0.5 rounded font-bold ${t.result === 'WIN' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'}`}>{t.result}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};