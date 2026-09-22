import { useEffect, useRef } from 'react';

interface DerivSyncConfig {
  appId?: string;
  apiToken?: string;
  onTelemetryUpdate?: (telemetry: any) => void;
}

export function useDerivSync({ appId = '1089', apiToken, onTelemetryUpdate }: DerivSyncConfig) {
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!apiToken) return;

    const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
    console.log('🔌 Connecting to Deriv WebSocket from Browser...');

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    let pingInterval: NodeJS.Timeout;

    ws.onopen = () => {
      console.log('🔑 Authenticating with Deriv API Token...');
      ws.send(JSON.stringify({ authorize: apiToken }));

      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ ping: 1 }));
        }
      }, 30000);
    };

    ws.onmessage = async (event) => {
      try {
        const res = JSON.parse(event.data);

        if (res.msg_type === 'authorize' && res.authorize) {
          console.log(`✅ Connected Deriv Account: ${res.authorize.loginid}`);

          const initialTelemetry = {
            connected: true,
            provider: 'Deriv API (Browser)',
            accountNumber: res.authorize.loginid,
            currency: res.authorize.currency || 'USD',
            balance: res.authorize.balance || 0,
            equity: res.authorize.balance || 0,
          };

          ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
          await syncTelemetryToServer(initialTelemetry);
          if (onTelemetryUpdate) onTelemetryUpdate(initialTelemetry);
        }

        if (res.msg_type === 'balance' && res.balance) {
          console.log(`💰 Live Balance Updated: ${res.balance.currency} ${res.balance.balance}`);

          const updatedTelemetry = {
            connected: true,
            balance: res.balance.balance,
            equity: res.balance.balance,
            currency: res.balance.currency,
            accountNumber: res.balance.loginid,
          };

          await syncTelemetryToServer(updatedTelemetry);
          if (onTelemetryUpdate) onTelemetryUpdate(updatedTelemetry);
        }
      } catch (err) {
        console.error('Error parsing Deriv WebSocket message:', err);
      }
    };

    ws.onerror = (err) => console.error('Deriv WS Error:', err);

    ws.onclose = () => {
      console.log('Deriv WS disconnected. Retrying connection in 5s...');
      clearInterval(pingInterval);
      syncTelemetryToServer({ connected: false });
      setTimeout(() => {
        if (apiToken) useDerivSync({ appId, apiToken, onTelemetryUpdate });
      }, 5000);
    };

    return () => {
      clearInterval(pingInterval);
      ws.close();
    };
  }, [appId, apiToken]);
}

async function syncTelemetryToServer(data: Record<string, any>) {
  try {
    await fetch('/api/broker/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch (err) {
    console.error('Failed to sync telemetry to Railway gateway:', err);
  }
}