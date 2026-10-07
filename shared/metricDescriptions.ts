/**
 * shared/metricDescriptions.ts
 *
 * Single source of truth for every plain-English description used by:
 *   - the Backtest panel (info icons and "How to read this" lines)
 *   - the TXT export legend
 *   - the PDF export section headers
 *
 * Rules followed:
 *   - each description <= 45 words
 *   - what it is + how it is calculated in one line + what good/bad looks like
 *   - no numeric examples that could go stale
 */

export interface MetricDescription {
  title: string;
  description: string;
  /** A single sentence shown under a section header as "How to read this". */
  howToRead: string;
}

export const METRIC_DESCRIPTIONS: Record<string, MetricDescription> = {
  // ---------------------------------------------------------------------------
  // KPI CARDS
  // ---------------------------------------------------------------------------
  total_trades: {
    title: 'Total Trades',
    description:
      'Number of completed trades in this run. Anything under 30 is statistically inconclusive and is tagged. Aim for 30 or more per combination before making decisions.',
    howToRead:
      'Look at this first. If it is under 30 for a combination or a strategy, treat every other number on that row as a hint, not a fact.',
  },
  win_rate: {
    title: 'Win Rate',
    description:
      'Share of trades that closed in profit. A low win rate can still be profitable if winners are much bigger than losers. Judge it together with the R:R, never on its own.',
    howToRead:
      'Compare win rate against the average R:R. A 40% win rate with 1:3 R:R can beat a 70% win rate with 1:1 R:R.',
  },
  expectancy: {
    title: 'Expectancy (R)',
    description:
      'Average profit or loss per trade measured in units of R (initial risk). Positive is required for the strategy to survive. Above +0.20R is a healthy edge.',
    howToRead:
      'Positive and stable is what you want. A large positive number built on five trades is not a signal, it is noise.',
  },
  profit_factor: {
    title: 'Profit Factor',
    description:
      'Gross winning profit divided by gross losing loss. Around 1.00 is break-even, above 1.30 is a robust edge, below 1.00 is a losing system.',
    howToRead:
      'Anything above 1.30 is worth keeping, between 1.00 and 1.30 is marginal, below 1.00 should be retuned or switched off.',
  },
  max_drawdown: {
    title: 'Max Drawdown',
    description:
      'Largest peak-to-trough decline in account equity during the run. Smaller is safer. Judge it against the account size to decide whether you could tolerate it.',
    howToRead:
      'Compare it against the account. A 30% drawdown on a small account usually means the risk profile is too aggressive.',
  },
  net_pnl: {
    title: 'Net Realised P&L',
    description:
      'Total profit or loss after all fees and spread. Must be positive and, ideally, not driven by a single outlier trade.',
    howToRead:
      'Cross-check against the outlier-removal panel. If removing the top 5% of trades turns profit into loss, the edge is fragile.',
  },
  run_time: {
    title: 'Run Time',
    description:
      'Wall-clock seconds the backtest took for this pair, broken into precompute, strategy evaluation, simulator and report-writing phases.',
    howToRead:
      'Use it to spot slow phases. If the simulator phase dwarfs everything else, the traffic is in the trade logic, not the data.',
  },
  adaptive_coverage: {
    title: 'Adaptive Coverage',
    description:
      'Percentage of bars where the Adaptive Volatility Engine was active. Below 90% means a portion of the run used Legacy fallback values.',
    howToRead:
      'Aim for 90% or higher. Below that, treat Adaptive comparisons to Legacy as provisional.',
  },

  // ---------------------------------------------------------------------------
  // COMBINATION TABLE COLUMNS
  // ---------------------------------------------------------------------------
  col_combination: {
    title: 'Combination',
    description:
      'One of the eight Adaptive/Legacy × Breakeven on/off × Trail on/off variants tested for this pair.',
    howToRead:
      'The ★ marks the best combination by profit factor with at least 30 trades.',
  },
  col_trades: {
    title: 'Trades',
    description:
      'Number of trades this combination actually took. Under 30 is tagged INCONCLUSIVE.',
    howToRead:
      'Filter your thinking by this first. Small samples lie.',
  },
  col_exp_r: {
    title: 'Expectancy (R)',
    description:
      'Average R multiple per trade for this combination. Positive means the combination has an edge, negative means it bleeds.',
    howToRead:
      'Rank combinations by expectancy, then sanity-check against profit factor and drawdown.',
  },
  col_pf: {
    title: 'Profit Factor',
    description:
      'Winning dollars divided by losing dollars for this combination. 1.00 is break-even, 1.30 is strong.',
    howToRead:
      'Star picks by PF. Anything under 1.00 is a candidate for OFF.',
  },
  col_max_dd: {
    title: 'Max DD',
    description:
      'Largest peak-to-trough equity drop in currency for this combination.',
    howToRead:
      'The best PF is not always the best trade-off. Look for small drawdown at similar PF.',
  },
  col_net_pnl: {
    title: 'Net P&L',
    description:
      'Total realised profit or loss for this combination in account currency.',
    howToRead:
      'A combination with the best PF but tiny P&L usually means too few trades.',
  },
  col_adp_cov: {
    title: 'Adp Cov',
    description:
      'Adaptive coverage percentage. Only meaningful on Adaptive combinations.',
    howToRead:
      'Ignore on Legacy rows. Below 90% on Adaptive rows means cold-start bars were in the mix.',
  },
  col_tune: {
    title: 'TUNE (PF / WR / TR)',
    description:
      'Metrics from the first 70% of the date range (in-sample). Tuning happened here. A strong TUNE PF only proves the fit.',
    howToRead:
      'Do not make decisions on TUNE alone. It must be matched by a healthy VALIDATE.',
  },
  col_validate: {
    title: 'VALIDATE (PF / WR / TR)',
    description:
      'Metrics from the last 30% of the date range (unseen). A strategy must survive here to be trusted in live.',
    howToRead:
      'A big drop from TUNE to VALIDATE means the edge does not hold on unseen data.',
  },
  col_holdout_verdict: {
    title: 'Hold-out Verdict',
    description:
      'Summary of whether the TUNE edge survived on VALIDATE. HOLD-OUT FAIL means it did not.',
    howToRead:
      'Any HOLD-OUT FAIL on the best combination should trigger a retune, not a promote.',
  },
  tag_hold_out_fail: {
    title: 'HOLD-OUT FAIL',
    description:
      'Strategy looked good on TUNE but collapsed on VALIDATE. The edge is unproven until this is fixed.',
    howToRead:
      'Retune on the TUNE window, rerun, and only promote if VALIDATE holds.',
  },
  tag_inconclusive: {
    title: 'INCONCLUSIVE',
    description:
      'Fewer than 30 trades in the relevant window. Not enough data for a statistically meaningful claim.',
    howToRead:
      'Do not draw conclusions. Either extend the window or accept that the sample is thin.',
  },
  tag_valid: {
    title: 'VALID',
    description:
      'Thirty or more trades in the relevant window. The sample is large enough for a meaningful claim.',
    howToRead:
      'A valid sample is necessary but not sufficient. Look at PF, expectancy and hold-out next.',
  },

  // ---------------------------------------------------------------------------
  // SECTION TITLES
  // ---------------------------------------------------------------------------
  sec_summary: {
    title: 'Summary Dashboard',
    description:
      'Top-level KPIs for the currently selected report plus the strategy and weekday performance tables.',
    howToRead:
      'Read the KPI row first, then the strategy table to see which strategies drove the result.',
  },
  sec_diagnostics: {
    title: 'Blueprint Diagnostics',
    description:
      'Post-hoc analytics on the trade list: hourly expectancy, session rollover, ATR tiers, streaks, Monte Carlo, slippage sensitivity and more.',
    howToRead:
      'Scan the four biggest cards first: hour matrix, streak analysis, Monte Carlo, slippage sensitivity. They usually drive the next change.',
  },
  sec_portfolio: {
    title: 'Portfolio Correlation',
    description:
      'Cross-pair daily P&L correlation matrix and concurrent portfolio drawdown versus the sum of individual drawdowns.',
    howToRead:
      'Low or negative correlation is good (diversifying). Above 0.7 means the pairs are effectively the same bet.',
  },
  sec_variants: {
    title: 'Variant Matrix',
    description:
      'Alternative rule sets (structural BE, EMA-9/25 trails, tighter daily caps) run against the same window.',
    howToRead:
      'If a variant beats the matching baseline row, consider promoting it into the live rule set.',
  },
  sec_tips: {
    title: 'Actionable Improvement Tips',
    description:
      'Rule-based suggestions triggered directly from the trade list: near-TP reversals, noise stop-outs, bad hours, bad weekdays and unviable pairs.',
    howToRead:
      'Focus on the HIGH severity tips first. Each is derived only from trades in this run.',
  },
  sec_chart: {
    title: 'Day Chart Inspector',
    description:
      'Interactive M5 candlestick chart for one trading day, with Asia levels, daily equilibrium, PDH/PDL and trade markers.',
    howToRead:
      'Pick a day, then look for the entry marker relative to the structural lines.',
  },
  sec_ledger: {
    title: 'Full Trade Ledger',
    description:
      'Every completed trade in the currently selected report, with entry, exit, R multiple and net P&L.',
    howToRead:
      'Filter by strategy or outcome. Use it to spot size or timing anomalies in the raw data.',
  },

  // ---------------------------------------------------------------------------
  // SKIP REASONS (surfaced in the skipped-signal summary)
  // ---------------------------------------------------------------------------
  skip_daily_cap: {
    title: 'DAILY_CAP',
    description:
      'Trade was skipped because the daily trade quota for that SAST day was already reached.',
    howToRead:
      'If this dominates skips, the daily cap is binding and may be hiding good setups.',
  },
  skip_no_room: {
    title: 'NO_ROOM',
    description:
      'Trade was skipped because the fixed R:R target had no structural room to reach the required distance.',
    howToRead:
      'A high count here means the target rule is too ambitious for the market structure on that pair.',
  },
  skip_invalid_sl: {
    title: 'INVALID_SL_DIST',
    description:
      'Trade was skipped because the calculated stop-loss distance was zero or negative.',
    howToRead:
      'Should never appear. If it does, one strategy is emitting bad stops.',
  },
  skip_min_lot_too_risky: {
    title: 'MIN_LOT_TOO_RISKY',
    description:
      'Trade was skipped because the minimum-lot size would have risked more than the allowed cash risk.',
    howToRead:
      'Common on small accounts. Increase deposit or loosen the min-lot tolerance if acceptable.',
  },
  skip_no_fx: {
    title: 'UNSUPPORTED_SYMBOL_NO_FX',
    description:
      'Trade was skipped because the FX rate needed to convert P&L into the account currency was unavailable.',
    howToRead:
      'Usually a cold-start issue. If frequent, check the FX quote feed.',
  },
  skip_spread: {
    title: 'SPREAD_FILTER',
    description:
      'Trade was skipped because the live spread exceeded the allowed fraction of the stop distance.',
    howToRead:
      'A frequent filter during news. That is the filter doing its job.',
  },
  skip_adr_room: {
    title: 'ADR_ROOM',
    description:
      'Trade was skipped because the remaining ADR room was too small for the target distance.',
    howToRead:
      'High counts late in the day are expected. High counts all day means the target is too wide.',
  },
  skip_sl_too_wide: {
    title: 'SL_TOO_WIDE',
    description:
      'Trade was skipped because the structural stop was wider than the maximum ADR-scaled ratio.',
    howToRead:
      'The adaptive engine is protecting you from oversized risk. Review the strategy stop logic.',
  },
  skip_min_rr: {
    title: 'MIN_RR',
    description:
      'Trade was skipped because the adapted target distance did not meet the minimum R:R floor.',
    howToRead:
      'The minimum R:R filter is doing its job. If the count is very high, lower the floor or widen targets.',
  },
  skip_monotonicity: {
    title: 'MONOTONICITY',
    description:
      'Trade was skipped because TP1 / TP2 / TP3 could not be enforced in strict order.',
    howToRead:
      'A strategy is emitting targets that do not progress. Rare and usually fixable.',
  },

  // ---------------------------------------------------------------------------
  // STRATEGY DESCRIPTIONS (taken from strategies/*.py docstrings)
  // ---------------------------------------------------------------------------
  strat_grubber_kick: {
    title: 'Grubber Kick',
    description:
      'US30 only. Waits for the Asia range to be swept, then a retest of the daily equilibrium with two consecutive closes holding. AMD cycle logic.',
    howToRead:
      'Watch its Asia sweep timing. If most trades fire before 06:00 SAST, the time filter is being bypassed.',
  },
  strat_513: {
    title: '513 Strategy',
    description:
      '5 EMA crosses 13 EMA while price is on the correct side of the Daily Flip and the 200 EMA. Mechanical cross with structural filter.',
    howToRead:
      'High trade count, low R:R. Judge it on win rate and expectancy, not on drawdown.',
  },
  strat_orb_liquidity_sweep: {
    title: 'ORB Liquidity Sweep',
    description:
      'London or NY open. Sweeps Asia high/low, PDH/PDL or the 15M OR, then closes back inside the 75% value area with an engulfing candle.',
    howToRead:
      'Best in the first hour of London and NY. Time-of-day hour matrix shows where it earns.',
  },
  strat_avwap_200ema: {
    title: 'AVWAP / 200 EMA',
    description:
      'Weekly anchored VWAP plus the 200 EMA define the trend. Pullbacks that hold the anchor are entries. Lets winners run on SuperTrend.',
    howToRead:
      'Loves trending weeks. Weak in chop. Check the ATR tier panel to see its volatility sweet spot.',
  },
  strat_pdh_pdl: {
    title: 'PDH / PDL Trap',
    description:
      'Previous daily high or low is broken with a buffer, then price closes back inside the prior day range with CVD confirming the trap.',
    howToRead:
      'Pairs well with London and NY opens. Time-of-day matrix is the key panel.',
  },
  strat_ema_9_25: {
    title: '9 / 25 EMA Cross',
    description:
      'Fast 9 EMA crosses 25 EMA in the direction of the 200 EMA. Entry only on the pullback that holds the fast or slow EMA.',
    howToRead:
      'Pullback discipline matters. If most trades are entries at the cross without a pullback, the rule is being short-circuited.',
  },
  strat_orb_cracker: {
    title: 'ORB Cracker',
    description:
      'NYSE open only. The first 5M candle pulse breaks the OR and then is rejected by the 200 EMA or session VWAP. Counter-pulse entry.',
    howToRead:
      'Should fire only during the NY open window. Any trade outside is a bug in the time filter.',
  },
  strat_oes_4h: {
    title: 'OES 4H Order Block',
    description:
      '4H and 1H institutional order blocks with fair-value gaps. Entry on 5M market structure shift inside the zone. Confluence raises confidence.',
    howToRead:
      'Low trade count, higher R:R. Judge it over long windows, not short ones.',
  },
  strat_manual: {
    title: 'Manual / Discretionary',
    description:
      'Trades entered by hand or via the broker directly, not by the automated engine. Reported for completeness.',
    howToRead:
      'Manual trades are noise for strategy tuning. Exclude them from strategy-level conclusions.',
  },

  // ---------------------------------------------------------------------------
  // DIAGNOSTIC SUB-CARD DESCRIPTIONS
  // ---------------------------------------------------------------------------
  diag_hour_matrix: {
    title: '§19 · 24-Hour Hourly Expectancy Matrix',
    description:
      'Win rate, expectancy and net P&L for each SAST clock hour across the whole run. Hours with thin samples are marked.',
    howToRead:
      'Find the hours that consistently make money and the ones that consistently lose. Those two lists become a time filter.',
  },
  diag_session_rollover: {
    title: '§21 · Session-Rollover Friction',
    description:
      'Compares trades taken inside ±15 minutes of London, NY and daily rollover against trades outside those windows.',
    howToRead:
      'If inside-rollover expectancy is much worse, add a rollover blackout to the engine.',
  },
  diag_atr_tier: {
    title: '§26 · ATR Volatility Tiering',
    description:
      'Splits the trade list by the volatility regime that was active at entry: LOW, NORMAL, HIGH.',
    howToRead:
      'Match your strategy to the regime where it earns. Ignore regimes with no data.',
  },
  diag_streak: {
    title: '§31 · Consecutive Loss Streak',
    description:
      'Longest consecutive losing streak, average streak length, peak drawdown, and how many trades were needed to recover from the peak.',
    howToRead:
      'If the max streak is above 5, your risk per trade is probably too high for the account size.',
  },
  diag_circuit_breaker: {
    title: '§32 · Circuit-Breaker Simulation',
    description:
      'Replays the same trades but halves risk after every third consecutive loss. Shows whether the extra break-even discipline helps.',
    howToRead:
      'A large positive protection delta means the halving rule is worth adopting.',
  },
  diag_outlier_removal: {
    title: '§36 · Outlier Dependency Removal',
    description:
      'Removes the top 5% best trades and recomputes the KPIs. Measures how much of the profit came from rare outliers.',
    howToRead:
      'Above 50% dependency means the edge is a few lucky trades, not a repeatable pattern.',
  },
  diag_monte_carlo: {
    title: '§37 · Monte Carlo Resampling',
    description:
      'Shuffles the trade order 1000 times and measures the resulting drawdown distribution and probability of ending positive.',
    howToRead:
      'The P95 max drawdown is the drawdown you should plan for, not the historical one.',
  },
  diag_buy_and_hold: {
    title: '§38 · Buy-and-Hold Benchmark',
    description:
      'Compares the strategy net P&L against simply holding the underlying over the same window. Reports alpha.',
    howToRead:
      'Positive alpha means the strategy is beating the market, not just riding it.',
  },
  diag_post_sl: {
    title: '§16 · Post-SL Continuation Distance',
    description:
      'How far price kept moving against you after the stop loss was hit. Large numbers mean the stop is too tight for the current volatility.',
    howToRead:
      'If recovered-to-TP rate is high, the entry trigger is facing liquidity sweeps, not the stop itself.',
  },
  diag_post_tp: {
    title: '§17 · Post-TP Movement',
    description:
      'How many extra pips price travelled in your favour after the take profit was hit. Large numbers mean the target is too conservative.',
    howToRead:
      'High average extra pips on winners suggests testing a wider R:R.',
  },
  diag_premature_be: {
    title: '§18 · Premature BE Exit Detection',
    description:
      'Trades where the stop was moved to break-even, stopped at break-even, and then price went on to reach the original take profit.',
    howToRead:
      'A high premature rate means the break-even trigger is firing too early. Consider the STRUCTURAL variant.',
  },
  diag_ema_200: {
    title: '§27 · 200 EMA Trend-Alignment Differential',
    description:
      'Splits trades by whether entry was aligned with or against the 200 EMA. Counter-trend trades are reported separately.',
    howToRead:
      'Aligned trades usually outperform. A strong counter-trend bucket means the trend filter is too loose.',
  },
  diag_confirmation: {
    title: '§28 · Candle-Close vs Touch Confirmation',
    description:
      'Compares trades confirmed by a closed candle versus entries on a wick touch. Populated once touch-based entries exist.',
    howToRead:
      'If touch is materially worse, keep the close-based rule everywhere.',
  },
  diag_news: {
    title: '§29 · News-Event Slippage Profiling',
    description:
      'Splits trades into those opened inside scheduled high-impact news windows (NFP, CPI, FOMC) and those outside.',
    howToRead:
      'If inside-news expectancy is much worse, extend the news blackout window.',
  },
  diag_sizing: {
    title: '§24 · Position Sizing Comparison',
    description:
      'Replays the same trade sequence with fixed risk per trade versus compounding risk as a percentage of current equity.',
    howToRead:
      'Compounding usually wins over long runs. A fixed-risk win means the equity curve is too volatile to compound.',
  },
  diag_daily_caps: {
    title: '§25 · Daily Execution Cap Comparison',
    description:
      'Slices the trades to the first 1, 2 or 4 of each day. The unlimited column is what the run actually produced.',
    howToRead:
      'If a tighter cap keeps the profit, adopt the tighter cap. If profit collapses, the daily cap is hiding edge.',
  },
  diag_dd_cutoff: {
    title: '§33 · Daily Max-Drawdown Cutoff Simulation',
    description:
      'Halts trading for the day once the running loss exceeds a fixed percentage of that day’s starting equity.',
    howToRead:
      'Positive protection delta means the cutoff is worth adding to the live engine.',
  },
  diag_slippage: {
    title: '§34 · Slippage Sensitivity Curve',
    description:
      'Degrades every trade by 1 to 5 pips of entry and exit slippage to model realistic execution friction.',
    howToRead:
      'If edge collapses at 3 pips, live broker conditions will destroy it. Aim for edge that survives 3-5 pips.',
  },
  diag_breakeven_variants: {
    title: 'Breakeven Variants A / B / C',
    description:
      'Estimate of how the trade list would have played out with three different break-even policies. This is a post-hoc estimate, not a re-simulation.',
    howToRead:
      'B is "never move to BE", C is "only move to BE after a full R of buffer". Pick whichever preserves the most R.',
  },
  diag_parameter_sensitivity: {
    title: 'Parameter Sensitivity (Target R:R sweep)',
    description:
      'Estimated net P&L if the target R:R were changed on the SAME trade list. Winners scale linearly with R:R, losers stay fixed.',
    howToRead:
      'The peak of the curve is where the R:R was best matched to actual MFE. If the peak is not at the current setting, adjust target_rr.',
  },
  not_implemented: {
    title: 'Not Implemented',
    description:
      'Blueprint items that the backtester does not yet produce. Listed here so nothing is silently missing.',
    howToRead:
      'Nothing on this list should be treated as passing. Treat it as an open backlog item.',
  },
};

/** Convenience: return the description text or a neutral fallback. */
export function describe(key: string): MetricDescription {
  return (
    METRIC_DESCRIPTIONS[key] || {
      title: key,
      description: 'No description available yet for this metric.',
      howToRead: 'No guidance written yet.',
    }
  );
}

/** Ordered keys for the panel's compact "How to read this" lookup. */
export const KPI_KEYS = [
  'total_trades',
  'win_rate',
  'expectancy',
  'profit_factor',
  'max_drawdown',
  'net_pnl',
] as const;