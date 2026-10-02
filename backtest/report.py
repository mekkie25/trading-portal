"""
backtest/report.py
Generates a standalone, double-clickable interactive HTML backtest report:
- Summary KPI Matrix (Win Rate, Expectancy in R, Profit Factor, Drawdown, Inconclusive Badges)
- Interactive M5 Candlestick Chart per day with labeled price levels and trade markers
- Calendar Ledger table with filters
"""

import sys
import os
import json
import argparse
import pandas as pd
import numpy as np
from datetime import datetime

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

def calculate_kpis(trades: list) -> dict:
    if not trades:
        return {
            "count": 0, "win_rate": 0.0, "avg_r": 0.0, "expectancy": 0.0,
            "profit_factor": 0.0, "max_dd_money": 0.0, "avg_duration": 0,
            "best_r": 0.0, "worst_r": 0.0, "net_pnl": 0.0, "is_inconclusive": True
        }

    df = pd.DataFrame(trades)
    count = len(df)
    wins = df[df["result"] == "WIN"]
    losses = df[df["result"] == "LOSS"]

    win_rate = (len(wins) / count) * 100.0 if count > 0 else 0.0
    avg_r = float(df["r_multiple"].mean()) if count > 0 else 0.0

    avg_win_r = float(wins["r_multiple"].mean()) if len(wins) > 0 else 0.0
    avg_loss_r = float(abs(losses["r_multiple"].mean())) if len(losses) > 0 else 0.0
    expectancy = ( (win_rate / 100.0) * avg_win_r ) - ( ((100.0 - win_rate) / 100.0) * avg_loss_r )

    gross_profit = float(wins["money_pnl"].sum()) if len(wins) > 0 else 0.0
    gross_loss = float(abs(losses["money_pnl"].sum())) if len(losses) > 0 else 0.0
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else 99.0

    # Max Drawdown
    df["cum_pnl"] = df["money_pnl"].cumsum()
    df["peak"] = df["cum_pnl"].cummax()
    df["dd"] = df["peak"] - df["cum_pnl"]
    max_dd = float(df["dd"].max()) if not df["dd"].empty else 0.0

    avg_duration = int(df["duration_minutes"].mean()) if count > 0 else 0
    best_r = float(df["r_multiple"].max()) if count > 0 else 0.0
    worst_r = float(df["r_multiple"].min()) if count > 0 else 0.0
    net_pnl = float(df["money_pnl"].sum())

    return {
        "count": count,
        "win_rate": round(win_rate, 1),
        "avg_r": round(avg_r, 2),
        "expectancy": round(expectancy, 2),
        "profit_factor": round(profit_factor, 2),
        "max_dd_money": round(max_dd, 2),
        "avg_duration": avg_duration,
        "best_r": round(best_r, 2),
        "worst_r": round(worst_r, 2),
        "net_pnl": round(net_pnl, 2),
        "is_inconclusive": count < 30
    }

def generate_html_report(symbol: str = "US30", mode: str = "adaptive"):
    trades_file = os.path.join(DATA_DIR, f"{symbol}_{mode}_trades.json")
    m5_file = os.path.join(DATA_DIR, f"{symbol}_M5.csv")

    if not os.path.exists(trades_file):
        print(f"[!] Trades file not found: {trades_file}. Run engine.py first.")
        return

    with open(trades_file, "r") as f:
        trades = json.load(f)

    if not trades:
        print("[!] No trades to generate report for.")
        return

    df_trades = pd.DataFrame(trades)
    global_kpis = calculate_kpis(trades)

    # Strategy breakdown
    strat_kpis = {}
    for strat, group in df_trades.groupby("strategy"):
        strat_kpis[strat] = calculate_kpis(group.to_dict("records"))

    # Day of week breakdown
    df_trades["weekday"] = pd.to_datetime(df_trades["date"]).dt.day_name()
    dow_kpis = {}
    for dow, group in df_trades.groupby("weekday"):
        dow_kpis[dow] = calculate_kpis(group.to_dict("records"))

    # Load M5 candles grouped by date for the Day Chart Inspector
    m5_df = pd.read_csv(m5_file)
    m5_df["dt"] = pd.to_datetime(m5_df["time"], utc=True)
    m5_df["date_str"] = m5_df["dt"].dt.strftime("%Y-%m-%d")

    trading_dates = sorted(df_trades["date"].unique().tolist())
    day_charts_data = {}

    for d_str in trading_dates:
        sub_m5 = m5_df[m5_df["date_str"] == d_str]
        candles_list = []
        for _, r in sub_m5.iterrows():
            candles_list.append({
                "time": int(r["dt"].timestamp()),
                "open": float(r["open"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "close": float(r["close"])
            })

        # Day trades
        day_t = df_trades[df_trades["date"] == d_str].to_dict("records")
        # Extract levels from first trade of day if available
        first_t = day_t[0] if day_t else {}
        ref_levels = first_t.get("ref_levels", {})

        day_charts_data[d_str] = {
            "candles": candles_list,
            "trades": day_t,
            "levels": {
                "asia_high": ref_levels.get("asia_high"),
                "asia_low": ref_levels.get("asia_low"),
                "daily_eq": ref_levels.get("daily_eq"),
                "daily_pivot": ref_levels.get("daily_pivot"),
                "pdh": ref_levels.get("pdh"),
                "pdl": ref_levels.get("pdl"),
                "orb_high": ref_levels.get("orb_high"),
                "orb_low": ref_levels.get("orb_low")
            }
        }

    report_html = f"""<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <title>Nexus Matrix - Quantitative Audit Report ({symbol} | {mode.upper()})</title>
  <script src="https://unpkg.com/lightweight-charts@4.2.2/dist/lightweight-charts.standalone.production.js"></script>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #07090e; color: #f1f5f9; }}
    .header {{ padding: 24px 32px; background: #0f1118; border-bottom: 1px solid #1a2030; display: flex; justify-content: space-between; align-items: center; }}
    .title {{ font-size: 20px; font-weight: 700; color: #fff; }}
    .badge {{ font-size: 11px; padding: 3px 8px; border-radius: 9999px; background: rgba(59,130,246,0.15); color: #60a5fa; border: 1px solid rgba(59,130,246,0.3); font-family: monospace; }}
    .tabs {{ display: flex; gap: 8px; padding: 16px 32px; background: #0b0d13; border-bottom: 1px solid #1a2030; }}
    .tab-btn {{ padding: 8px 16px; border-radius: 8px; background: transparent; border: 1px solid transparent; color: #94a3b8; cursor: pointer; font-size: 13px; font-weight: 600; }}
    .tab-btn.active {{ background: #2563eb; color: #fff; border-color: #3b82f6; }}
    .content {{ padding: 32px; max-width: 1400px; margin: 0 auto; }}
    .grid-kpi {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }}
    .kpi-card {{ background: #0f1118; border: 1px solid #1a2030; border-radius: 12px; padding: 20px; }}
    .kpi-label {{ font-size: 11px; text-transform: uppercase; color: #94a3b8; font-weight: 600; }}
    .kpi-value {{ font-size: 26px; font-weight: 700; font-family: monospace; margin-top: 6px; }}
    .kpi-green {{ color: #10b981; }}
    .kpi-red {{ color: #ef4444; }}
    .kpi-blue {{ color: #3b82f6; }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12px; font-family: monospace; }}
    th, td {{ padding: 12px 14px; text-align: left; border-bottom: 1px solid #1a2030; }}
    th {{ background: #141722; color: #94a3b8; font-weight: 700; text-transform: uppercase; font-size: 10px; }}
    tr:hover {{ background: #121520; }}
    .badge-inconclusive {{ background: rgba(245,158,11,0.15); color: #f59e0b; border: 1px solid rgba(245,158,11,0.3); font-size: 10px; padding: 2px 6px; border-radius: 4px; }}
    .badge-valid {{ background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.3); font-size: 10px; padding: 2px 6px; border-radius: 4px; }}
    #chartContainer {{ width: 100%; height: 500px; background: #07090e; border: 1px solid #1a2030; border-radius: 12px; margin-top: 16px; }}
    select {{ background: #0f1118; color: #fff; border: 1px solid #1a2030; padding: 8px 12px; border-radius: 8px; font-size: 12px; cursor: pointer; }}
  </style>
</head>
<body>

  <div class="header">
    <div>
      <div class="title">Nexus Matrix Quantitative Audit Report</div>
      <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;">Asset: <strong>{symbol}</strong> | Engine Mode: <strong>{mode.upper()}</strong></div>
    </div>
    <span class="badge">AUDITED HISTORICAL SIMULATION</span>
  </div>

  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('summary')">Summary Dashboard</button>
    <button class="tab-btn" onclick="switchTab('dayPage')">Day Chart Inspector</button>
    <button class="tab-btn" onclick="switchTab('tradesTable')">Full Trade Ledger</button>
  </div>

  <div class="content">

    <!-- TAB 1: SUMMARY -->
    <div id="tab-summary">
      <div class="grid-kpi">
        <div class="kpi-card">
          <div class="kpi-label">Total Trades</div>
          <div class="kpi-value kpi-blue">{global_kpis['count']}</div>
          <div style="margin-top: 6px;">{"<span class='badge-inconclusive'>INCONCLUSIVE (<30 trades)</span>" if global_kpis['is_inconclusive'] else "<span class='badge-valid'>SAMPLE VALID</span>"}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Win Rate</div>
          <div class="kpi-value {'kpi-green' if global_kpis['win_rate'] >= 50 else 'kpi-red'}">{global_kpis['win_rate']}%</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Expectancy (R)</div>
          <div class="kpi-value {'kpi-green' if global_kpis['expectancy'] > 0 else 'kpi-red'}">{global_kpis['expectancy']}R</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Profit Factor</div>
          <div class="kpi-value kpi-blue">{global_kpis['profit_factor']}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Max Drawdown</div>
          <div class="kpi-value kpi-red">-${global_kpis['max_dd_money']}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Net Realized P&L</div>
          <div class="kpi-value {'kpi-green' if global_kpis['net_pnl'] >= 0 else 'kpi-red'}">${global_kpis['net_pnl']}</div>
        </div>
      </div>

      <h3 style="font-size: 15px; margin-top: 24px; color: #fff;">Performance by Strategy</h3>
      <table>
        <thead>
          <tr>
            <th>Strategy Name</th>
            <th>Trades</th>
            <th>Win Rate</th>
            <th>Avg R</th>
            <th>Expectancy</th>
            <th>Profit Factor</th>
            <th>Net P&L</th>
            <th>Sample Audit</th>
          </tr>
        </thead>
        <tbody>
          {"".join([f'''<tr>
            <td><strong>{s}</strong></td>
            <td>{k['count']}</td>
            <td style="color:{'#10b981' if k['win_rate']>=50 else '#ef4444'}">{k['win_rate']}%</td>
            <td>{k['avg_r']}R</td>
            <td>{k['expectancy']}R</td>
            <td>{k['profit_factor']}</td>
            <td style="color:{'#10b981' if k['net_pnl']>=0 else '#ef4444'}">${k['net_pnl']}</td>
            <td>{"<span class='badge-inconclusive'>INCONCLUSIVE (<30)</span>" if k['is_inconclusive'] else "<span class='badge-valid'>VALID (>30)</span>"}</td>
          </tr>''' for s, k in strat_kpis.items()])}
        </tbody>
      </table>

      <h3 style="font-size: 15px; margin-top: 32px; color: #fff;">Performance by Day of Week</h3>
      <table>
        <thead>
          <tr>
            <th>Weekday</th>
            <th>Trades</th>
            <th>Win Rate</th>
            <th>Avg R</th>
            <th>Expectancy</th>
            <th>Net P&L</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {"".join([f'''<tr>
            <td><strong>{dow}</strong></td>
            <td>{k['count']}</td>
            <td style="color:{'#10b981' if k['win_rate']>=50 else '#ef4444'}">{k['win_rate']}%</td>
            <td>{k['avg_r']}R</td>
            <td>{k['expectancy']}R</td>
            <td style="color:{'#10b981' if k['net_pnl']>=0 else '#ef4444'}">${k['net_pnl']}</td>
            <td>{"<span class='badge-inconclusive'>INCONCLUSIVE (<30)</span>" if k['is_inconclusive'] else "<span class='badge-valid'>VALID</span>"}</td>
          </tr>''' for dow, k in dow_kpis.items()])}
        </tbody>
      </table>
    </div>

    <!-- TAB 2: DAY CHART INSPECTOR -->
    <div id="tab-dayPage" style="display: none;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <label style="font-size: 12px; color: #94a3b8; font-weight: 600;">Select Trading Day: </label>
          <select id="daySelector" onchange="renderSelectedDayChart()">
            {"".join([f'<option value="{d}">{d}</option>' for d in trading_dates])}
          </select>
        </div>
        <div style="font-size: 12px; color: #94a3b8;">
          Legend: <span style="color:#3b82f6;">-- Asia H/L</span> | <span style="color:#f59e0b;">-- Daily EQ</span> | <span style="color:#a855f7;">-- PDH/PDL</span> | <span style="color:#10b981;">▲ Buy Entry</span> | <span style="color:#ef4444;">▼ Sell Entry</span>
        </div>
      </div>

      <div id="chartContainer"></div>
      <div id="dayTradesContainer" style="margin-top: 24px;"></div>
    </div>

    <!-- TAB 3: FULL TRADES TABLE -->
    <div id="tab-tradesTable" style="display: none;">
      <h3 style="font-size: 15px; color: #fff;">Complete Audited Trade Ledger ({len(trades)} records)</h3>
      <table>
        <thead>
          <tr>
            <th>Trade ID</th>
            <th>Date</th>
            <th>Strategy</th>
            <th>Dir</th>
            <th>Lots</th>
            <th>Entry</th>
            <th>SL</th>
            <th>TP</th>
            <th>Exit</th>
            <th>Reason</th>
            <th>R Multiple</th>
            <th>Net P&L</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {"".join([f'''<tr>
            <td>{t.get('trade_id', t.get('ticket', ''))}</td>
            <td>{t['date']}</td>
            <td><strong>{t['strategy']}</strong></td>
            <td style="color:{'#10b981' if t['direction']=='BUY' else '#ef4444'}">{t['direction']}</td>
            <td>{t['lots']}</td>
            <td>{t['entry_price']}</td>
            <td>{t['sl']}</td>
            <td>{t['tp']}</td>
            <td>{t['exit_price']}</td>
            <td>{t['exit_reason']}</td>
            <td style="color:{'#10b981' if t['r_multiple']>0 else '#ef4444'}">{t['r_multiple']}R</td>
            <td style="color:{'#10b981' if t['money_pnl']>0 else '#ef4444'}">${t['money_pnl']}</td>
            <td><span class="badge" style="color:{'#10b981' if t['result']=='WIN' else '#ef4444'}">{t['result']}</span></td>
          </tr>''' for t in trades])}
        </tbody>
      </table>
    </div>

  </div>

  <script>
    const DAY_DATA = {json.dumps(day_charts_data)};
    let activeChart = null;

    function switchTab(tabId) {{
      document.getElementById('tab-summary').style.display = tabId === 'summary' ? 'block' : 'none';
      document.getElementById('tab-dayPage').style.display = tabId === 'dayPage' ? 'block' : 'none';
      document.getElementById('tab-tradesTable').style.display = tabId === 'tradesTable' ? 'block' : 'none';

      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      event.target.classList.add('active');

      if (tabId === 'dayPage') {{
        setTimeout(renderSelectedDayChart, 50);
      }}
    }}

    function renderSelectedDayChart() {{
      const day = document.getElementById('daySelector').value;
      const data = DAY_DATA[day];
      if (!data) return;

      const container = document.getElementById('chartContainer');
      container.innerHTML = '';

      activeChart = LightweightCharts.createChart(container, {{
        width: container.clientWidth,
        height: 500,
        layout: {{ background: {{ type: 'solid', color: '#07090e' }}, textColor: '#94a3b8' }},
        grid: {{ vertLines: {{ color: '#141a26' }}, horzLines: {{ color: '#141a26' }} }},
        timeScale: {{ timeVisible: true, secondsVisible: false }}
      }});

      const candleSeries = activeChart.addCandlestickSeries({{
        upColor: '#10b981', downColor: '#ef4444',
        borderUpColor: '#10b981', borderDownColor: '#ef4444',
        wickUpColor: '#10b981', wickDownColor: '#ef4444'
      }});
      candleSeries.setData(data.candles);

      // Plot session levels
      const lvls = data.levels;
      if (lvls.asia_high) candleSeries.createPriceLine({{ price: lvls.asia_high, color: '#3b82f6', lineWidth: 1, lineStyle: 2, title: 'ASIA HIGH' }});
      if (lvls.asia_low) candleSeries.createPriceLine({{ price: lvls.asia_low, color: '#3b82f6', lineWidth: 1, lineStyle: 2, title: 'ASIA LOW' }});
      if (lvls.daily_eq) candleSeries.createPriceLine({{ price: lvls.daily_eq, color: '#f59e0b', lineWidth: 2, lineStyle: 2, title: 'DAILY EQ' }});
      if (lvls.pdh) candleSeries.createPriceLine({{ price: lvls.pdh, color: '#a855f7', lineWidth: 1, lineStyle: 2, title: 'PDH' }});
      if (lvls.pdl) candleSeries.createPriceLine({{ price: lvls.pdl, color: '#a855f7', lineWidth: 1, lineStyle: 2, title: 'PDL' }});

      // Trade Markers
      const markers = [];
      data.trades.forEach(t => {{
        const openEpoch = Math.floor(new Date(t.signal_time_utc).getTime() / 1000);
        markers.push({{
          time: openEpoch,
          position: t.direction === 'BUY' ? 'belowBar' : 'aboveBar',
          color: t.direction === 'BUY' ? '#10b981' : '#ef4444',
          shape: t.direction === 'BUY' ? 'arrowUp' : 'arrowDown',
          text: `${{t.direction}} (${{t.strategy}})`
        }});
      }});
      markers.sort((a,b) => a.time - b.time);
      candleSeries.setMarkers(markers);

      // Render Day Trades Table
      let tableHtml = `<h4 style="font-size: 13px; color: #fff; margin-bottom: 8px;">Trades for ${{day}} (${{data.trades.length}} trades)</h4>`;
      tableHtml += `<table><thead><tr><th>Trade ID</th><th>Strategy</th><th>Dir</th><th>Lots</th><th>Entry</th><th>Exit</th><th>R</th><th>P&L</th><th>Reason</th></tr></thead><tbody>`;
      data.trades.forEach(t => {{
        tableHtml += `<tr>
          <td>${{t.trade_id || t.ticket || ''}}</td>
          <td><strong>${{t.strategy}}</strong></td>
          <td style="color:${{t.direction === 'BUY' ? '#10b981' : '#ef4444'}}">${{t.direction}}</td>
          <td>${{t.lots}}</td>
          <td>${{t.entry_price}}</td>
          <td>${{t.exit_price}}</td>
          <td style="color:${{t.r_multiple > 0 ? '#10b981' : '#ef4444'}}">${{t.r_multiple}}R</td>
          <td style="color:${{t.money_pnl >= 0 ? '#10b981' : '#ef4444'}}">$${{t.money_pnl}}</td>
          <td>${{t.exit_reason}}</td>
        </tr>`;
      }});
      tableHtml += `</tbody></table>`;
      document.getElementById('dayTradesContainer').innerHTML = tableHtml;
    }}
  </script>
</body>
</html>
"""

    out_file = os.path.join(DATA_DIR, "report.html")
    with open(out_file, "w", encoding="utf-8") as f:
        f.write(report_html)

    print(f"\n[✓] Visual Audit Report generated successfully: {out_file}")
    print("[*] You can double-click this HTML file to view the complete report in your browser.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, default="US30")
    parser.add_argument("--mode", type=str, default="adaptive")
    args = parser.parse_args()

    generate_html_report(symbol=args.symbol, mode=args.mode)