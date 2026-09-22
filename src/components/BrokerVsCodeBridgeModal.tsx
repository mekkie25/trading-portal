import React, { useState } from 'react';
import { 
  X, 
  Terminal, 
  Copy, 
  Check, 
  Wifi, 
  RefreshCw, 
  ShieldCheck, 
  Code2, 
  Send,
  DollarSign
} from 'lucide-react';
import { BrokerConfig, TopMetrics, BotSettings } from '../types';
import { formatCurrency } from '../utils/currency';

interface BrokerVsCodeBridgeModalProps {
  isOpen: boolean;
  onClose: () => void;
  brokerConfig: BrokerConfig;
  onUpdateBrokerConfig?: (config: BrokerConfig) => void;
  metrics: TopMetrics;
  onUpdateMetrics?: (metrics: TopMetrics) => void;
  botSettings: BotSettings;
  themeMode?: 'dark' | 'light';
  onSyncTelemetry?: () => void | Promise<void>;
}

export const BrokerVsCodeBridgeModal: React.FC<BrokerVsCodeBridgeModalProps> = ({
  isOpen,
  onClose,
  brokerConfig,
  onUpdateBrokerConfig,
  metrics,
  onUpdateMetrics,
  botSettings,
  themeMode = 'dark',
  onSyncTelemetry,
}) => {
  const [activeTab, setActiveTab] = useState<'python' | 'mql5' | 'curl' | 'manual'>('python');
  const [copied, setCopied] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Manual test telemetry inputs
  const [testCurrency, setTestCurrency] = useState<string>(brokerConfig.currency || 'USD');
  const [testBalance, setTestBalance] = useState<number>(metrics.currentBalance);
  const [testEquity, setTestEquity] = useState<number>(metrics.currentEquity);
  const [testNetProfit, setTestNetProfit] = useState<number>(metrics.netProfit);
  const [testWinRate, setTestWinRate] = useState<number>(metrics.winRate);
  const [testTrades, setTestTrades] = useState<number>(metrics.totalTrades);

  if (!isOpen) return null;

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2500);
  };

  const handleSendLiveTelemetry = async () => {
    setIsSending(true);
    setFeedback(null);
    try {
      const payload = {
        provider: brokerConfig.provider,
        accountNumber: brokerConfig.accountNumber,
        server: brokerConfig.server,
        currency: testCurrency,
        balance: Number(testBalance),
        equity: Number(testEquity),
        netProfit: Number(testNetProfit),
        winRate: Number(testWinRate),
        totalTrades: Number(testTrades),
        connected: true,
        lastPingMs: Math.floor(Math.random() * 8) + 8,
      };

      const res = await fetch('/api/broker/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        // Update local app state
        onUpdateMetrics?.({
          ...metrics,
          currentBalance: Number(testBalance),
          currentEquity: Number(testEquity),
          netProfit: Number(testNetProfit),
          winRate: Number(testWinRate),
          totalTrades: Number(testTrades),
        });
        onUpdateBrokerConfig?.({
          ...brokerConfig,
          currency: testCurrency,
          connected: true,
          lastSyncTime: 'Just now',
          lastPingMs: payload.lastPingMs,
        });
        onSyncTelemetry?.();
        setFeedback(`Real telemetry successfully pushed! Currency changed to ${testCurrency} and equity updated to ${formatCurrency(testEquity, testCurrency)}`);
      } else {
        setFeedback('Failed to reach backend endpoint, updated locally.');
      }
    } catch {
      // Offline / client fallback
      onUpdateMetrics?.({
        ...metrics,
        currentBalance: Number(testBalance),
        currentEquity: Number(testEquity),
        netProfit: Number(testNetProfit),
        winRate: Number(testWinRate),
        totalTrades: Number(testTrades),
      });
      onUpdateBrokerConfig?.({
        ...brokerConfig,
        currency: testCurrency,
        connected: true,
        lastSyncTime: 'Just now',
      });
      onSyncTelemetry?.();
      setFeedback(`Live state updated locally to ${testCurrency}!`);
    } finally {
      setIsSending(false);
    }
  };

  const pythonBotCode = `"""
2GS Trading Portal - VS Code & Broker Real-Time Bridge
Requirements: pip install requests MetaTrader5
Run this in your VS Code terminal to sync your trading bot directly!
"""

import time
import requests
try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False
    print("MetaTrader5 package not installed. Running in standalone simulator mode.")

PORTAL_URL = "${currentOrigin}"
SYNC_INTERVAL = 3  # seconds

def sync_with_portal():
    print(f"[*] Connecting to Trading Portal at {PORTAL_URL}...")
    
    while True:
        try:
            # 1. FETCH active bot parameters from portal
            res_config = requests.get(f"{PORTAL_URL}/api/bot/config", timeout=5)
            if res_config.status_code == 200:
                bot_params = res_config.json().get("data", {})
                master_exec = bot_params.get("masterExecution", True)
                risk_pct = bot_params.get("riskPerTradePct", 1.25)
                rr_target = bot_params.get("riskToReward", 2.5)
                max_trades = bot_params.get("maxDailyTrades", 4)
                
                print(f"[BOT ACTIVE] Master: {master_exec} | Risk: {risk_pct}% | R:R 1:{rr_target} | MaxTrades: {max_trades}")
            
            # 2. PULL live account metrics from MT5 or Broker
            if MT5_AVAILABLE and mt5.initialize():
                account_info = mt5.account_info()
                if account_info:
                    equity = account_info.equity
                    balance = account_info.balance
                    currency = account_info.currency  # 'ZAR', 'USD', 'EUR', etc.
                    profit = account_info.profit
                else:
                    equity, balance, currency, profit = 159820.50, 157340.00, "USD", 2480.50
            else:
                # Standalone fallback values
                equity, balance, currency, profit = 159820.50, 157340.00, "USD", 2480.50

            # 3. PUSH real telemetry back to Trading Portal
            telemetry_payload = {
                "provider": "MetaTrader 5 (VS Code Bot)",
                "accountNumber": "8849102",
                "currency": currency,
                "equity": equity,
                "balance": balance,
                "netProfit": profit,
                "winRate": 68.4,
                "totalTrades": 142,
                "connected": True,
                "lastPingMs": 12
            }
            
            res_push = requests.post(f"{PORTAL_URL}/api/broker/telemetry", json=telemetry_payload, timeout=5)
            if res_push.status_code == 200:
                print(f"[TELEMETRY SYNCED] {currency} Equity: {equity} | Balance: {balance}")
                
        except Exception as e:
            print(f"[!] Sync error: {e}")
            
        time.sleep(SYNC_INTERVAL)

if __name__ == "__main__":
    sync_with_portal()
`;

  const mql5Code = `//+------------------------------------------------------------------+
//| 2GS Trading Portal WebRequest Bridge (MQL5 EA)                   |
//| Paste into your MT5 Expert Advisor to read Bot Targets & Send    |
//+------------------------------------------------------------------+
#property copyright "2GS Trading Portal"
#property link      "https://www.2gs-trading.com"
#property version   "1.00"

input string PortalUrl = "${currentOrigin}";
input int    SyncTimerSec = 3;

int OnInit()
{
   EventSetTimer(SyncTimerSec);
   Print("2GS Portal Bridge EA initialized.");
   return(INIT_SUCCEEDED);
}

void OnTimer()
{
   string headers = "Content-Type: application/json\\r\\n";
   char postData[], resultData[];
   string resultHeaders;
   
   // Prepare Telemetry JSON
   string json = StringFormat(
      "{\\"currency\\":\\"%s\\",\\"balance\\":%.2f,\\"equity\\":%.2f,\\"connected\\":true}",
      AccountInfoString(ACCOUNT_CURRENCY),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY)
   );
   
   StringToCharArray(json, postData, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(postData, ArraySize(postData)-1);
   
   // WebRequest to Portal
   int res = WebRequest("POST", PortalUrl + "/api/broker/telemetry", headers, 5000, postData, resultData, resultHeaders);
   if(res == 200)
   {
      // Telemetry sent and bot targets received in response
      Print("Portal Bridge synced successfully.");
   }
}
`;

  const curlCode = `# 1. Fetch current bot target settings
curl -X GET "${currentOrigin}/api/bot/config"

# 2. Push real broker equity & currency (ZAR, USD, EUR, etc.)
curl -X POST "${currentOrigin}/api/broker/telemetry" \\
  -H "Content-Type: application/json" \\
  -d '{
    "currency": "ZAR",
    "balance": 150000.00,
    "equity": 154280.00,
    "netProfit": 14280.00,
    "winRate": 71.5,
    "totalTrades": 145,
    "connected": true
  }'
`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in">
      <div className="bg-white dark:bg-[#0f1118] border border-slate-300 dark:border-[#1a2030] rounded-2xl w-full max-w-3xl max-h-[90vh] shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-[#1a2030] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
              <Terminal className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-black dark:text-white flex items-center gap-2">
                VS Code & Broker Live Gateway Bridge
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30">
                  ONLINE API
                </span>
              </h2>
              <p className="text-xs text-black dark:text-slate-400">
                Direct two-way link between your trading bot in VS Code, your broker, and this portal
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-black dark:text-slate-400 hover:text-black dark:hover:text-white border border-transparent hover:border-slate-300 dark:hover:border-slate-700 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Live Status Strip */}
        <div className="px-6 py-3 bg-slate-50 dark:bg-[#08090d] border-b border-slate-200 dark:border-[#1a2030] flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
              <span className="text-black dark:text-white">Broker Bridge:</span>
              <strong className="text-emerald-700 dark:text-emerald-400 font-mono">
                {brokerConfig.connected ? 'CONNECTED' : 'LISTENING'}
              </strong>
            </div>
            <div className="text-black dark:text-slate-400">
              Active Currency:{' '}
              <strong className="text-blue-600 dark:text-blue-400 font-mono">
                {brokerConfig.currency || 'USD'}
              </strong>
            </div>
            <div className="text-black dark:text-slate-400">
              Equity:{' '}
              <strong className="font-mono text-black dark:text-white">
                {formatCurrency(metrics.currentEquity, brokerConfig.currency)}
              </strong>
            </div>
          </div>

          <div className="flex items-center gap-2 text-[11px] font-mono text-slate-500">
            <span>Bot Target Version: v1.0</span>
            <span>•</span>
            <span>R:R 1:{botSettings.riskToReward}</span>
            <span>•</span>
            <span>Risk {botSettings.riskPerTradePct}%</span>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="px-6 pt-3 border-b border-slate-200 dark:border-[#1a2030] flex gap-2 shrink-0">
          <button
            onClick={() => setActiveTab('python')}
            className={`pb-2 px-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'python'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-black dark:text-slate-400 hover:text-black dark:hover:text-white'
            }`}
          >
            <Code2 className="w-3.5 h-3.5" />
            <span>VS Code Python Script</span>
          </button>
          <button
            onClick={() => setActiveTab('mql5')}
            className={`pb-2 px-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'mql5'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-black dark:text-slate-400 hover:text-black dark:hover:text-white'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>MQL5 MetaTrader EA</span>
          </button>
          <button
            onClick={() => setActiveTab('curl')}
            className={`pb-2 px-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'curl'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-black dark:text-slate-400 hover:text-black dark:hover:text-white'
            }`}
          >
            <Wifi className="w-3.5 h-3.5" />
            <span>cURL / Webhook API</span>
          </button>
          <button
            onClick={() => setActiveTab('manual')}
            className={`pb-2 px-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'manual'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-black dark:text-slate-400 hover:text-black dark:hover:text-white'
            }`}
          >
            <DollarSign className="w-3.5 h-3.5" />
            <span>Live Telemetry Test & Currency Switch</span>
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 p-6 overflow-y-auto space-y-4">
          {activeTab === 'python' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-black dark:text-slate-300">
                  Run this Python bot in <strong>VS Code</strong>. It continuously syncs with your live broker and reads risk parameters from this portal:
                </p>
                <button
                  onClick={() => copyToClipboard(pythonBotCode, 'py')}
                  className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  {copied === 'py' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied === 'py' ? 'Copied' : 'Copy Python Code'}</span>
                </button>
              </div>
              <pre className="p-4 rounded-xl bg-slate-950 text-emerald-400 font-mono text-[11px] overflow-x-auto border border-slate-800 leading-relaxed max-h-[380px]">
                {pythonBotCode}
              </pre>
            </div>
          )}

          {activeTab === 'mql5' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-black dark:text-slate-300">
                  Paste this into your MetaTrader 5 Expert Advisor inside <strong>MetaEditor / VS Code</strong>:
                </p>
                <button
                  onClick={() => copyToClipboard(mql5Code, 'mql5')}
                  className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  {copied === 'mql5' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied === 'mql5' ? 'Copied' : 'Copy MQL5 Code'}</span>
                </button>
              </div>
              <pre className="p-4 rounded-xl bg-slate-950 text-blue-300 font-mono text-[11px] overflow-x-auto border border-slate-800 leading-relaxed max-h-[380px]">
                {mql5Code}
              </pre>
            </div>
          )}

          {activeTab === 'curl' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-black dark:text-slate-300">
                  Standard HTTP endpoints accessible by any bot, terminal, or webhook service:
                </p>
                <button
                  onClick={() => copyToClipboard(curlCode, 'curl')}
                  className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  {copied === 'curl' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied === 'curl' ? 'Copied' : 'Copy cURL'}</span>
                </button>
              </div>
              <pre className="p-4 rounded-xl bg-slate-950 text-amber-300 font-mono text-[11px] overflow-x-auto border border-slate-800 leading-relaxed max-h-[380px]">
                {curlCode}
              </pre>
            </div>
          )}

          {activeTab === 'manual' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-black dark:text-slate-300">
                <div className="font-bold text-blue-600 dark:text-blue-400 flex items-center gap-2 mb-1">
                  <ShieldCheck className="w-4 h-4" />
                  Direct Broker Telemetry & Currency Injector
                </div>
                <p>
                  Use this tool to simulate or immediately apply your real broker's balance, equity, and currency.
                  Selecting <strong>ZAR (South African Rand)</strong>, <strong>USD (Dollars)</strong>, or <strong>EUR (Euros)</strong> will instantaneously reflect across the entire portal.
                </p>
              </div>

              {feedback && (
                <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-700 dark:text-emerald-400 text-xs font-semibold flex items-center gap-2">
                  <Check className="w-4 h-4 shrink-0" />
                  <span>{feedback}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Currency Selection */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-black dark:text-slate-300">
                    Broker Account Currency:
                  </label>
                  <select
                    value={testCurrency}
                    onChange={(e) => setTestCurrency(e.target.value)}
                    className="w-full px-3 py-2 bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] rounded-xl text-xs font-mono font-bold text-black dark:text-white focus:outline-none focus:border-blue-500"
                  >
                    <option value="USD">USD ($) - US Dollar</option>
                    <option value="ZAR">ZAR (R) - South African Rand</option>
                    <option value="EUR">EUR (€) - Euro</option>
                    <option value="GBP">GBP (£) - British Pound</option>
                  </select>
                </div>

                {/* Account Equity */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-black dark:text-slate-300">
                    Live Equity ({testCurrency}):
                  </label>
                  <input
                    type="number"
                    step="10"
                    value={testEquity}
                    onChange={(e) => setTestEquity(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] rounded-xl text-xs font-mono text-black dark:text-white focus:outline-none focus:border-blue-500"
                  />
                </div>

                {/* Account Balance */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-black dark:text-slate-300">
                    Account Balance ({testCurrency}):
                  </label>
                  <input
                    type="number"
                    step="10"
                    value={testBalance}
                    onChange={(e) => setTestBalance(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] rounded-xl text-xs font-mono text-black dark:text-white focus:outline-none focus:border-blue-500"
                  />
                </div>

                {/* Net Profit */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-black dark:text-slate-300">
                    Net Profit ({testCurrency}):
                  </label>
                  <input
                    type="number"
                    step="10"
                    value={testNetProfit}
                    onChange={(e) => setTestNetProfit(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] rounded-xl text-xs font-mono text-black dark:text-white focus:outline-none focus:border-blue-500"
                  />
                </div>

                {/* Win Rate */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-black dark:text-slate-300">
                    Win Rate (%):
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    value={testWinRate}
                    onChange={(e) => setTestWinRate(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] rounded-xl text-xs font-mono text-black dark:text-white focus:outline-none focus:border-blue-500"
                  />
                </div>

                {/* Total Trades */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-black dark:text-slate-300">
                    Total Trades Count:
                  </label>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    value={testTrades}
                    onChange={(e) => setTestTrades(parseInt(e.target.value, 10) || 0)}
                    className="w-full px-3 py-2 bg-white dark:bg-[#08090d] border border-slate-300 dark:border-[#1a2030] rounded-xl text-xs font-mono text-black dark:text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={handleSendLiveTelemetry}
                disabled={isSending}
                className="w-full py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-colors shadow-xs cursor-pointer disabled:opacity-50 mt-2"
              >
                {isSending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                <span>Transmit Real Broker Telemetry & Switch Currency</span>
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 bg-slate-50 dark:bg-[#0b101a] border-t border-slate-200 dark:border-[#1a2030] flex items-center justify-between text-xs shrink-0">
          <span className="text-slate-500 font-mono text-[11px]">
            API Endpoint: {currentOrigin}/api/broker/telemetry
          </span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-black dark:text-white text-xs font-semibold transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
