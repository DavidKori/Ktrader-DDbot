# Deriv WebSocket authentication (current)

## Public market data — no auth, no app_id

`wss://api.derivws.com/trading/v1/options/ws/public`

- Read-only ticks/candles (R_100, frxEURUSD, …). Works for charts + the bot-skeleton engine.
- **No `?app_id=` required.** Sending the OAuth client id as `app_id` here is harmless but pointless;
  sending it to the **legacy** `wss://ws.derivws.com/websockets/v3?app_id=<client_id>` returns
  `HTTP/1.1 401 Unauthorized` (root cause of the historic charts/balance outage).

## Authenticated trading — OTP flow

1. OAuth2 PKCE login via `/auth/deriv/login` (server-node). Server stores `access_token` in an
   encrypted HttpOnly cookie (`twk_auth`).
2. `POST /trading/v1/options/accounts/{accountId}/otp` with `Authorization: Bearer <token>` and
   `Deriv-App-Id` header → JSON `{ "data": { "url": "wss://api.derivws.com/trading/v1/options/ws/demo?otp=…" } }`.
3. `new WebSocket(data.url)` — **no extra headers**. OTP expires after ~120 s; reconnect by
   requesting a fresh OTP (server endpoint: `/api/deriv/otp/request`).

## Service worker

`public/sw.js` (mirrored into `dist/sw.js`) must never intercept WebSocket upgrades. Current
`isApiRequest` uses an **exact-match allow-list** for `api.derivws.com` etc. — do not reintroduce
`hostname.startsWith('api.')` or `url.protocol === 'wss:'` checks, they silently swallow the WS
upgrade and the bot engine receives no ticks.

## Troubleshooting 401 / no ticks

| Symptom | Cause | Fix |
|---|---|---|
| HTTP 401 on WS | `app_id` = OAuth client id on legacy v3 endpoint | use public endpoint, no app_id |
| Charts spin forever | SW swallowed the upgrade | clear SW/cache (see VERCEL_DEPLOYMENT.md) |
| `InvalidToken` loop | stale `localStorage.authToken` | call `/api/deriv/me` first, use HttpOnly cookie |
