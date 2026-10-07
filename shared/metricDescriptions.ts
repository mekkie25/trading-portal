/**
 * shared/metricDescriptions.ts
 * Single source of truth for every plain-English description used by:
 *   - the Backtest panel (info icons and "How to read this" lines)
 *   - the TXT export legend
 *   - the PDF export section headers
 */

export interface MetricDescription {
  title: string;
  description: string;
  howToRead: string;
}

export const METRIC_DESCRIPTIONS: Record<string, MetricDescription> = {
  total_trades: {
    title: 'Total Trades',
    description: 'Number of completed trades. Anything under 30 is statistically inconclusive and is tagged.',
    howToRead: 'Look at this first. Under 30 means treat every other number on that row as a hint, not a fact.',
  },
  win_rate: {
    title: 'Win Rate',
    description: 'Share of trades that closed in profit. A low win rate can still be profitable if winners are much bigger than losers.',
    howToRead: 'Compare against the R:R. 40% win rate at 1:3 can beat 70% at 1:1.',
  },
  expectancy: {
    title: 'Expectancy (R)',
    description: 'Average profit or loss per trade in units of initial risk. Positive is required to survive.',
    howToRead: 'Positive and stable. A big number built on five trades is noise.',
  },
  profit_factor: {
    title: 'Profit Factor',
    description: 'Gross winning profit divided by gross losing loss. Around 1.00 is break-even, above 1.30 is robust.',
    howToRead: 'Above 1.30 keep, 1.00-1.30 marginal, below 1.00 retune or switch off.',
  },
  max_drawdown: {
    title: 'Max Drawdown',
    description: 'Largest peak-to-trough equity decline during the run. Judge against the account size.',
    howToRead: 'A 30% drawdown on a small account usually means the risk per trade is too aggressive.',
  },
  net_pnl: {
    title: 'Net Realised P&L',
    description: 'Total profit or loss after all fees and spread. Must be positive and not outlier-driven.',
    howToRead: 'Cross-check against outlier removal. If trimming the top 5% turns profit into loss, the edge is fragile.',
  },
  pip_size: {
    title: 'Pip Size',
    description: 'Price units per pip for this symbol. FX majors 0.0001, JPY pairs 0.01, GOLD 0.01, indices one point or a fraction.',
    howToRead: 'It is the unit the pips columns are reported in.',
  },
  post_trade_r: {
    title: 'Post-Trade Movement in R',
    description: 'Post-stop or post-target distance in R units (initial risk). Makes GOLD and EURUSD comparable. Any single R above 20 is capped.',
    howToRead: 'Use R to compare pairs. The pips number is specific to the contract.',
  },
  bootstrap_monte_carlo: {
    title: 'Bootstrap Monte Carlo',
    description: 'Each of 1,000 runs resamples the trade list with replacement. The probability reported is the honest chance that final P&L is above zero.',
    howToRead: 'Above 90% is comfortable, below 70% means the edge is fragile.',
  },
  lab_per_quarter: {
    title: 'Per-Quarter Stability',
    description: 'Splits the window into four quarters and shows trades, PF and net P&L for each. Robust strategies profit in most quarters.',
    howToRead: 'You want at least three of four quarters above PF 1.00.',
  },
  col_combination: {
    title: 'Combination',
    description: 'One of the six Adaptive combinations: BE on or off, R:R 1:1, 1:2 or 1:3.',
    howToRead: 'The ★ marks the best combination by PF with at least 30 trades.',
  },
  col_trades: { title: 'Trades', description: 'Trades this combination took. Under 30 is INCONCLUSIVE.', howToRead: 'Filter by this first.' },
  col_exp_r: { title: 'Expectancy (R)', description: 'Average R per trade.', howToRead: 'Rank combinations by this, then sanity-check against PF.' },
  col_pf: { title: 'Profit Factor', description: 'Winning dollars divided by losing dollars. 1.00 break-even, 1.30 strong.', howToRead: 'Star picks by PF.' },
  col_max_dd: { title: 'Max DD', description: 'Largest peak-to-trough equity drop in currency.', howToRead: 'Compare drawdown at similar PF.' },
  col_net_pnl: { title: 'Net P&L', description: 'Total realised P&L for this combination.', howToRead: 'A great PF with tiny P&L means few trades.' },
  col_adp_cov: { title: 'Adaptive Coverage', description: 'Percentage of bars where the Adaptive engine was active.', howToRead: 'Aim for 90%+.' },
  col_tune: { title: 'TUNE', description: 'First 70% of the date range (in-sample).', howToRead: 'Not sufficient on its own.' },
  col_validate: { title: 'VALIDATE', description: 'Last 30% of the date range (unseen).', howToRead: 'A big drop from TUNE means no edge on unseen data.' },
  col_holdout_verdict: { title: 'Hold-out Verdict', description: 'Three-state summary: HOLDS, FLAT, FAILS, INCONCLUSIVE.', howToRead: 'Only HOLDS is a go.' },
  tag_holds: { title: 'HOLDS', description: 'VALIDATE PF >= 1.10 and >= 70% of TUNE.', howToRead: 'The only verdict that supports promoting to live.' },
  tag_flat: { title: 'FLAT', description: 'VALIDATE PF 0.95 to 1.10. FLAT means no real edge either way.', howToRead: 'Do not promote.' },
  tag_fails: { title: 'FAILS', description: 'VALIDATE PF below 0.95 or below 70% of TUNE.', howToRead: 'Retune and rerun.' },
  tag_inconclusive: { title: 'INCONCLUSIVE', description: 'Fewer than 30 trades in TUNE or VALIDATE.', howToRead: 'Not enough data for a claim.' },
  sec_summary: { title: 'Summary Dashboard', description: 'Top-level KPIs.', howToRead: 'Read KPI row first.' },
  sec_combinations: { title: 'Six Combinations', description: 'Adaptive only, BE off/on, R:R 1:1, 1:2, 1:3. Six rows per pair.', howToRead: 'Ranked by PF. Star is best of six.' },
  sec_diagnostics: { title: 'Blueprint Diagnostics', description: 'Post-hoc analytics on the trade list.', howToRead: 'Scan the biggest cards first.' },
  sec_portfolio: { title: 'Portfolio Correlation', description: 'Cross-pair daily P&L correlation matrix.', howToRead: 'Low correlation is good.' },
  sec_tips: { title: 'Actionable Tips', description: 'Rule-based suggestions from the trade list.', howToRead: 'Focus on HIGH severity.' },
  sec_ledger: { title: 'Full Trade Ledger', description: 'Every completed trade.', howToRead: 'Filter by strategy or outcome.' },
  sec_strategy_lab: { title: 'Strategy Lab', description: 'Runs single-setting variants on the 365-day window.', howToRead: 'Only variants tagged IMPROVES matter.' },
  diag_hour_matrix: { title: '§19 Hour Matrix', description: 'Win rate, expectancy and P&L per SAST hour.', howToRead: 'Good hours and bad hours become a time filter.' },
  diag_session_rollover: { title: '§21 Rollover Friction', description: 'Trades inside ±15min of session opens vs outside.', howToRead: 'If inside is worse, add a blackout.' },
  diag_atr_tier: { title: '§26 ATR Tiers', description: 'Splits trades by volatility regime at entry.', howToRead: 'Trade where the strategy earns.' },
  diag_streak: { title: '§31 Streaks', description: 'Longest losing streak and recovery.', howToRead: 'Max streak above 5 means risk per trade is too high.' },
  diag_circuit_breaker: { title: '§32 Breaker Sim', description: 'Replays with risk halved after every third loss.', howToRead: 'Positive protection delta means adopt.' },
  diag_outlier_removal: { title: '§36 Outliers', description: 'Removes top 5% and recomputes.', howToRead: 'Above 50% dependency is fragile.' },
  diag_monte_carlo: { title: '§37 Bootstrap Monte Carlo', description: '1,000 runs resample with replacement. Probability final P&L is above zero.', howToRead: 'Above 90% comfortable, below 70% fragile.' },
  diag_buy_and_hold: { title: '§38 Buy-and-Hold', description: 'Compares strategy P&L against holding the underlying.', howToRead: 'Positive alpha = beating the market.' },
  diag_post_sl: { title: '§16 Post-SL', description: 'How far price kept moving against you after the stop. Pips and R.', howToRead: 'High recovered-to-TP rate means the entry is swept.' },
  diag_post_tp: { title: '§17 Post-TP', description: 'Extra pips after the target hit. Pips and R.', howToRead: 'High extra R means try a wider target.' },
  diag_premature_be: { title: '§18 Premature BE', description: 'Stopped at BE then rallied to target.', howToRead: 'High rate means BE trigger is too early.' },
  diag_ema_200: { title: '§27 EMA-200 Alignment', description: 'Aligned vs counter-trend entries.', howToRead: 'Aligned usually outperforms.' },
  diag_confirmation: { title: '§28 Confirmation Type', description: 'Close vs touch entries.', howToRead: 'Keep close-based if touch is worse.' },
  diag_news: { title: '§29 News Windows', description: 'Inside vs outside news windows.', howToRead: 'Extend the blackout if inside is worse.' },
  diag_sizing: { title: '§24 Position Sizing', description: 'Fixed risk vs compounding.', howToRead: 'Compounding usually wins.' },
  diag_daily_caps: { title: '§25 Daily Caps', description: 'Cap 1 and cap 2 from the trade list. Cap 3+ needs the Strategy Lab.', howToRead: 'Tighter cap that keeps profit is worth it.' },
  diag_dd_cutoff: { title: '§33 DD Cutoff', description: 'Halts the day after a fixed % loss.', howToRead: 'Positive protection delta means adopt.' },
  diag_slippage: { title: '§34 Slippage', description: 'Fixed pips of cost per trade, converted with pip_size.', howToRead: 'Edge should survive 3-5 pips.' },
  diag_breakeven_variants: { title: '§22 BE Variants', description: 'A/B/C estimate of BE policies.', howToRead: 'Pick the one preserving the most R.' },
  diag_parameter_sensitivity: { title: '§35 Parameter Sweep', description: 'Estimate of P&L at various R:R targets on the same trade list.', howToRead: 'Peak of the sweep is where R:R best matched MFE.' },
  not_implemented: { title: 'Not Implemented', description: 'Blueprint items not produced.', howToRead: 'Treat as backlog.' },
};

export function describe(key: string): MetricDescription {
  return METRIC_DESCRIPTIONS[key] || {
    title: key,
    description: 'No description available yet.',
    howToRead: 'No guidance written yet.',
  };
}

export const KPI_KEYS = [
  'total_trades', 'win_rate', 'expectancy', 'profit_factor', 'max_drawdown', 'net_pnl',
] as const;