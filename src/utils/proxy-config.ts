// Runtime helpers. HTTP auth stays same-origin; Deriv WebSocket connects directly.

const runtimeOrigin = typeof window !== 'undefined' ? window.location.origin : '';

const configuredProxyBase =
  typeof process !== 'undefined' && (process as any).env?.PUBLIC_PROXY_BASE
    ? String((process as any).env.PUBLIC_PROXY_BASE).trim()
    : '';

export const PROXY_BASE = configuredProxyBase || runtimeOrigin || 'http://localhost:3001';

const configuredDerivWsUrl =
  typeof process !== 'undefined' && (process as any).env?.PUBLIC_DERIV_WS_URL
    ? String((process as any).env.PUBLIC_DERIV_WS_URL).trim()
    : '';

export const PUBLIC_DERIV_WS_URL = configuredDerivWsUrl || 'wss://api.derivws.com/trading/v1/options/ws/public';

export const DERIV_WS_URL = PUBLIC_DERIV_WS_URL;
