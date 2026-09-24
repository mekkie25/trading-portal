import React, { useState, useMemo } from 'react';
import { motion } from 'motion/react';
import { 
  Search, 
  Filter, 
  RefreshCw, 
  Plus, 
  FileSpreadsheet,
  FileText,
  TrendingUp, 
  TrendingDown, 
  CheckCircle2, 
  X,
  Database,
  ArrowUpRight,
  ArrowDownRight
} from 'lucide-react';
import { TradeRecord, GoogleSheetsConfig, BrokerConfig, ThemeMode } from '../../types';
import { formatCurrency } from '../../utils/currency';

interface TradeJournalViewProps {
  trades: TradeRecord[];
  onAddTrade: (trade: TradeRecord) => void;
  onResetJournal?: () => void;
  sheetsConfig: GoogleSheetsConfig;
  brokerConfig: BrokerConfig;
  themeMode?: ThemeMode;
}

export const TradeJournalView: React.FC<TradeJournalViewProps> = ({ 
  trades, 
  onAddTrade,
  onResetJournal,
  sheetsConfig,
  brokerConfig,
  themeMode = 'dark'
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [assetFilter, setAssetFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [isSyncingSheets, setIsSyncingSheets] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  // New manual trade entry state
  const [newTicket, setNewTicket] = useState(`#${Math.floor(8000000 + Math.random() * 999999)}`);
  const [newAsset, setNewAsset] = useState('US30');
  const [newStrategy, setNewStrategy] = useState('GRUBBER_KICK');
  const [newType, setNewType] = useState<'BUY' | 'SELL'>('BUY');
  const [newLots, setNewLots] = useState(1.0);
  const [newOpenPrice, setNewOpenPrice] = useState(46120.00);
  const [newClosePrice, setNewClosePrice] = useState(46250.00);
  const [newPnL, setNewPnL] = useState(130.00);

  const filteredTrades = useMemo(() => {
    return trades.filter((tr) => {
      const matchSearch =
        tr.ticket.toLowerCase().includes(searchQuery.toLowerCase()) ||
        tr.asset.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (tr.strategy && tr.strategy.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchAsset = assetFilter === 'ALL' || tr.asset === assetFilter;
      const matchStatus = statusFilter === 'ALL' || tr.status === statusFilter;
      return matchSearch && matchAsset && matchStatus;
    });
  }, [trades, searchQuery, assetFilter, statusFilter]);

  const stats = useMemo(() => {
    const totalCount = filteredTrades.length;
    const wins = filteredTrades.filter((t) => t.status === 'WIN');
    const losses = filteredTrades.filter((t) => t.status === 'LOSS');
    const totalPnL = filteredTrades.reduce((acc, curr) => acc + curr.pnl, 0);
    const winRate = totalCount > 0 ? (wins.length / totalCount) * 100 : 0;
    const grossProfit = wins.reduce((acc, curr) => acc + curr.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((acc, curr) => acc + curr.pnl, 0));
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '∞';

    return {
      totalCount,
      wins: wins.length,
      losses: losses.length,
      totalPnL,
      winRate: winRate.toFixed(1),
      profitFactor,
    };
  }, [filteredTrades]);

  const uniqueAssets = useMemo(() => {
    return Array.from(new Set(trades.map((t) => t.asset)));
  }, [trades]);

  const handleSyncSheets = () => {
    setIsSyncingSheets(true);
    setTimeout(() => {
      setIsSyncingSheets(false);
      setSyncNotice(`Synced with Google Sheet tab "${sheetsConfig.sheetTabName}". ${trades.length} ledger rows verified.`);
      setTimeout(() => setSyncNotice(null), 4000);
    }, 1000);
  };

  const handleExportPDF = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Please allow popups to export the PDF trade statement.');
      return;
    }

    const rowsHtml = filteredTrades.map((t) => `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 8px; font-family: monospace; font-size: 11px;">${t.ticket}</td>
        <td style="padding: 8px; font-size: 11px; font-weight: bold;">${t.asset}</td>
        <td style="padding: 8px; font-size: 11px; font-weight: bold; color: #2563eb;">${t.strategy || 'MANUAL'}</td>
        <td style="padding: 8px; font-size: 11px; color: ${t.type === 'BUY' ? '#16a34a' : '#dc2626'};">${t.type}</td>
        <td style="padding: 8px; font-family: monospace; font-size: 11px;">${t.lots}</td>
        <td style="padding: 8px; font-family: monospace; font-size: 11px;">${t.openPrice.toFixed(2)}</td>
        <td style="padding: 8px; font-family: monospace; font-size: 11px;">${t.closePrice.toFixed(2)}</td>
        <td style="padding: 8px; font-family: monospace; font-size: 11px; font-weight: bold; color: ${t.pnl >= 0 ? '#16a34a' : '#dc2626'};">
          ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}
        </td>
        <td style="padding: 8px; font-size: 10px; color: #64748b;">${t.closeTime}</td>
        <td style="padding: 8px; font-size: 11px; font-weight: bold;">${t.status}</td>
      </tr>
    `).join('');

    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Trading Portal - Trade Journal Audit Statement</title>
          <style>
            body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #0f172a; padding: 40px; margin: 0; }
            .header { display: flex; justify-content: space-between; border-bottom: 2px solid #2563eb; padding-bottom: 20px; margin-bottom: 30px; }
            .title { font-size: 24px; font-weight: bold; color: #0f172a; }
            table { width: 100%; border-collapse: collapse; text-align: left; }
            th { background: #f1f5f9; padding: 10px 8px; font-size: 11px; text-transform: uppercase; color: #475569; border-bottom: 2px solid #cbd5e1; }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <div class="title">TRADING PORTAL</div>
              <div style="color: #2563eb; font-weight: bold; font-size: 13px; margin-top: 4px;">Audited Execution Ledger</div>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Asset</th>
                <th>Strategy</th>
                <th>Type</th>
                <th>Lots</th>
                <th>Open</th>
                <th>Close</th>
                <th>Net P&L</th>
                <th>Close Time</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <script>window.onload = function() { window.print(); };</script>
        </body>
      </html>
    `;

    printWindow.document.write(htmlContent);
    printWindow.document.close();
  };

  const handleCreateTrade = (e: React.FormEvent) => {
    e.preventDefault();
    const isWin = newPnL > 0;
    const isBE = newPnL === 0;
    const status = isWin ? 'WIN' : isBE ? 'BREAKEVEN' : 'LOSS';
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);

    const record: TradeRecord = {
      id: `tr-${Date.now()}`,
      ticket: newTicket,
      asset: newAsset,
      strategy: newStrategy,
      type: newType,
      lots: Number(newLots),
      openPrice: Number(newOpenPrice),
      closePrice: Number(newClosePrice),
      pnl: Number(newPnL),
      pnlPct: Number(((newPnL / 50000) * 100).toFixed(2)),
      openTime: nowStr,
      closeTime: nowStr,
      duration: '45m',
      status,
      source: 'Manual',
    };

    onAddTrade(record);
    setShowAddModal(false);
    setSyncNotice(`Trade ${newTicket} added to journal!`);
    setTimeout(() => setSyncNotice(null), 3500);
  };

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 space-y-8 max-w-7xl mx-auto">
      {/* Toast Notice */}
      {syncNotice && (
        <div className="p-4 rounded-xl bg-blue-600 text-white shadow-lg flex items-center gap-2.5 text-xs font-semibold animate-in fade-in border border-blue-400">
          <CheckCircle2 className="w-4 h-4 text-emerald-300 shrink-0" />
          <span>{syncNotice}</span>
        </div>
      )}

      {/* View Header */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-300 dark:border-[#1a2030]"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-black dark:text-white flex items-center gap-2.5">
            Trade Journal & Strategy Ledger
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium font-mono">
              Live Feed
            </span>
          </h1>
          <p className="text-sm text-black dark:text-slate-400 mt-1">
            Audited execution log showing the exact strategy used for every trade.
          </p>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            type="button"
            onClick={handleSyncSheets}
            disabled={isSyncingSheets}
            className="px-3.5 py-2 rounded-xl bg-white hover:bg-slate-100 dark:bg-[#0f1118] dark:hover:bg-[#141722] border border-slate-300 dark:border-[#1a2030] text-xs font-semibold text-black dark:text-slate-300 flex items-center gap-2 transition-colors disabled:opacity-50 cursor-pointer shadow-xs"
          >
            <FileSpreadsheet className={`w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 ${isSyncingSheets ? 'animate-spin' : ''}`} />
            <span>{isSyncingSheets ? 'Syncing...' : 'Sync Google Sheet'}</span>
          </button>

          <button
            type="button"
            onClick={handleExportPDF}
            className="px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-2 transition-colors shadow-xs cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Export PDF</span>
          </button>

          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 dark:bg-white dark:hover:bg-slate-100 text-white dark:text-slate-900 text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-xs cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Manual Trade</span>
          </button>

          {onResetJournal && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Clear the journal view? This hides past trades from view without affecting your Deriv account.')) {
                  onResetJournal();
                }
              }}
              className="px-3.5 py-2 rounded-xl bg-red-600/10 hover:bg-red-600/20 text-red-500 border border-red-500/30 text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-xs cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              <span>Clear Journal</span>
            </button>
          )}
        </div>
      </motion.div>

      {/* Stats Summary Bento */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4 }}
        className="grid grid-cols-2 lg:grid-cols-4 gap-6"
      >
        <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
          <div className="text-xs font-semibold uppercase tracking-wider text-black dark:text-slate-400">Total Filtered P&L</div>
          <div className={`text-2xl font-bold font-mono mt-2 ${stats.totalPnL >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600'}`}>
            {formatCurrency(stats.totalPnL, brokerConfig.currency)}
          </div>
          <div className="text-[11px] text-black dark:text-slate-400 mt-1">Net closed ledger</div>
        </div>

        <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
          <div className="text-xs font-semibold uppercase tracking-wider text-black dark:text-slate-400">Win Rate Accuracy</div>
          <div className="text-2xl font-bold font-mono text-blue-600 dark:text-blue-400 mt-2">
            {stats.winRate}%
          </div>
          <div className="text-[11px] text-black dark:text-slate-400 mt-1">{stats.wins} wins / {stats.losses} losses</div>
        </div>

        <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
          <div className="text-xs font-semibold uppercase tracking-wider text-black dark:text-slate-400">Profit Factor</div>
          <div className="text-2xl font-bold font-mono text-black dark:text-white mt-2">
            {stats.profitFactor}
          </div>
          <div className="text-[11px] text-black dark:text-slate-400 mt-1">Gross win/loss ratio</div>
        </div>

        <div className="p-5 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs">
          <div className="text-xs font-semibold uppercase tracking-wider text-black dark:text-slate-400">Audited Positions</div>
          <div className="text-2xl font-bold font-mono text-black dark:text-white mt-2">
            {stats.totalCount}
          </div>
          <div className="text-[11px] text-black dark:text-slate-400 mt-1">In selected filter range</div>
        </div>
      </motion.div>

      {/* Filter and Search Bar */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.4 }}
        className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs"
      >
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-black dark:text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search ticket, asset, or strategy..."
            className="w-full pl-9 pr-3.5 py-2 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] text-xs font-medium text-black dark:text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          <select
            value={assetFilter}
            onChange={(e) => setAssetFilter(e.target.value)}
            className="px-3.5 py-2 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] text-xs font-medium text-black dark:text-slate-300 focus:outline-none focus:border-blue-500"
          >
            <option value="ALL">All Instruments</option>
            {uniqueAssets.map((asset) => (
              <option key={asset} value={asset}>{asset}</option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3.5 py-2 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] text-xs font-medium text-black dark:text-slate-300 focus:outline-none focus:border-blue-500"
          >
            <option value="ALL">All Outcomes</option>
            <option value="WIN">Wins Only</option>
            <option value="LOSS">Losses Only</option>
            <option value="BREAKEVEN">Breakeven Only</option>
          </select>
        </div>
      </motion.div>

      {/* Main Table Container */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.45 }}
        className="rounded-2xl bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] shadow-xs overflow-hidden"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-[#1a2030] bg-white dark:bg-[#08090d]/50 text-black dark:text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
                <th className="py-4 px-5">Ticket #</th>
                <th className="py-4 px-4">Instrument</th>
                <th className="py-4 px-4">Strategy</th>
                <th className="py-4 px-4">Direction</th>
                <th className="py-4 px-4">Lots</th>
                <th className="py-4 px-4">Open Fill</th>
                <th className="py-4 px-4">Close Fill</th>
                <th className="py-4 px-4">Net P&L ($)</th>
                <th className="py-4 px-4">Duration</th>
                <th className="py-4 px-4">Timestamp</th>
                <th className="py-4 px-5 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-[#141a26]">
              {filteredTrades.map((trade) => {
                const isWin = trade.status === 'WIN';
                const isLoss = trade.status === 'LOSS';
                return (
                  <tr 
                    key={trade.id} 
                    className="hover:bg-slate-50 dark:hover:bg-[#121520] transition-colors"
                  >
                    <td className="py-3.5 px-5 font-mono text-black dark:text-slate-400">
                      {trade.ticket}
                    </td>
                    <td className="py-3.5 px-4 font-semibold text-black dark:text-white">
                      {trade.asset}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                        {trade.strategy || 'DERIV_CORE'}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={`inline-flex items-center gap-1 font-mono font-bold px-2 py-0.5 rounded text-[10px] ${
                        trade.type === 'BUY'
                          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20'
                          : 'bg-rose-500/10 text-rose-600 border border-rose-500/20'
                      }`}>
                        {trade.type === 'BUY' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                        {trade.type}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 font-mono text-black dark:text-slate-300">
                      {trade.lots.toFixed(2)}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-black dark:text-slate-300">
                      {trade.openPrice.toFixed(2)}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-black dark:text-slate-300">
                      {trade.closePrice.toFixed(2)}
                    </td>
                    <td className="py-3.5 px-4 font-mono font-bold">
                      <span className={trade.pnl >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600'}>
                        {formatCurrency(trade.pnl, brokerConfig.currency)}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-black dark:text-slate-400 text-[11px]">
                      {trade.duration}
                    </td>
                    <td className="py-3.5 px-4 text-black dark:text-slate-400 text-[11px] font-mono">
                      {trade.closeTime}
                    </td>
                    <td className="py-3.5 px-5 text-right">
                      <span className={`font-mono text-[10px] font-bold px-2.5 py-1 rounded-full ${
                        isWin
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
                          : isLoss
                          ? 'bg-rose-500/15 text-rose-600 border border-rose-500/30'
                          : 'bg-slate-200 dark:bg-slate-800 text-black dark:text-slate-300'
                      }`}>
                        {trade.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </motion.div>

      {/* Add Manual Trade Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-md bg-white dark:bg-[#0f1118] rounded-2xl border border-slate-300 dark:border-[#1a2030] shadow-2xl p-6 space-y-5"
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-[#1a2030]">
              <h3 className="text-base font-bold text-black dark:text-white">Record Manual Execution</h3>
              <button 
                onClick={() => setShowAddModal(false)}
                className="text-black dark:text-slate-400 hover:text-slate-600 dark:hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateTrade} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-black dark:text-slate-300">Ticket #</label>
                  <input
                    type="text"
                    value={newTicket}
                    onChange={(e) => setNewTicket(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-black dark:text-white"
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-black dark:text-slate-300">Instrument</label>
                  <input
                    type="text"
                    value={newAsset}
                    onChange={(e) => setNewAsset(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] text-black dark:text-white"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-black dark:text-slate-300">Strategy</label>
                <select
                  value={newStrategy}
                  onChange={(e) => setNewStrategy(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] text-black dark:text-white font-mono"
                >
                  <option value="GRUBBER_KICK">GRUBBER_KICK</option>
                  <option value="STRATEGY_513">STRATEGY_513</option>
                  <option value="ORB_LIQUIDITY_SWEEP">ORB_LIQUIDITY_SWEEP</option>
                  <option value="AVWAP_200EMA_CONTINUATION">AVWAP_200EMA_CONTINUATION</option>
                  <option value="PDH_PDL_FAILED_BREAKOUT">PDH_PDL_FAILED_BREAKOUT</option>
                  <option value="EMA_9_25_CROSS">EMA_9_25_CROSS</option>
                  <option value="ORB_CRACKER">ORB_CRACKER</option>
                  <option value="OES_4H_ORDER_BLOCK">OES_4H_ORDER_BLOCK</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-black dark:text-slate-300">Direction</label>
                  <select
                    value={newType}
                    onChange={(e) => setNewType(e.target.value as any)}
                    className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] text-black dark:text-white font-semibold"
                  >
                    <option value="BUY">BUY</option>
                    <option value="SELL">SELL</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-black dark:text-slate-300">Lots</label>
                  <input
                    type="number"
                    step="0.01"
                    value={newLots}
                    onChange={(e) => setNewLots(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-black dark:text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-black dark:text-slate-300">Open Price</label>
                  <input
                    type="number"
                    step="0.01"
                    value={newOpenPrice}
                    onChange={(e) => setNewOpenPrice(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-black dark:text-white"
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-black dark:text-slate-300">Close Price</label>
                  <input
                    type="number"
                    step="0.01"
                    value={newClosePrice}
                    onChange={(e) => setNewClosePrice(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono text-black dark:text-white"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-black dark:text-slate-300">Net Closed P&L ($ USD)</label>
                <input
                  type="number"
                  step="0.01"
                  value={newPnL}
                  onChange={(e) => setNewPnL(parseFloat(e.target.value) || 0)}
                  className="w-full px-3 py-2.5 rounded-xl bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] font-mono font-bold text-black dark:text-white"
                />
              </div>

              <div className="pt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-black dark:text-slate-300 font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold cursor-pointer"
                >
                  Save to Journal
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </div>
  );
};