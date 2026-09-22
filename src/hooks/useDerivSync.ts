import { useEffect, useRef, useCallback, useState } from 'react';

interface DerivSyncProps {
  appId?: string;
  token?: string;
  onTelemetryData?: (data: any) => void;
}

export const useDerivSync = ({
  appId = import.meta.env.VITE_DERIV_APP_ID || '1080',
  token = import.meta.env.VITE_DERIV_TOKEN || '',
  onTelemetryData,
}: DerivSyncProps = {}) => {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectCountRef = useRef(0);

  const connect = useCallback(() => {
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      // Use the numeric App ID from Railway env or fallback
      const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setConnectionError(null);
        reconnectCountRef.current = 0;

        // Authorize using the PAT... token from Railway env
        if (token) {
          ws.send(JSON.stringify({ authorize: token }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Once authorized, request account balance updates
          if (data.msg_type === 'authorize') {
            ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
          }

          // Relay telemetry frame to backend
          fetch('/api/broker/telemetry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          }).catch((err) => console.error('Telemetry post failed:', err));

          if (onTelemetryData) {
            onTelemetryData(data);
          }
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };

      ws.onerror = (err) => {
        console.error('WebSocket Error:', err);
        setConnectionError('WebSocket connection error.');
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;

        if (reconnectCountRef.current < 5) {
          const timeout = Math.min(
            1000 * Math.pow(2, reconnectCountRef.current),
            30000
          );
          reconnectCountRef.current += 1;

          reconnectTimerRef.current = setTimeout(() => {
            connect();
          }, timeout);
        }
      };
    } catch (err: any) {
      setConnectionError(err.message || 'Failed to initialize WebSocket');
    }
  }, [appId, token, onTelemetryData]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { isConnected, connectionError, reconnect: connect };
};