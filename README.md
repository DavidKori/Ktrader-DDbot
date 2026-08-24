# DDBOt v5.6.2-clean

AI trading bot for [Deriv](https://deriv.com) using the **new Options API** (`api.derivws.com`).
This build is the clean, verified release: legacy `ws.derivws.com` / `websockets/v3` transport is
removed, the WebSocket 401 bug is fixed, and all documentation reflects the current architecture.

## Architecture

Two live connection paths, both Deriv-native:

| Path | Endpoint | Auth | Used for |
|---|---|---|---|
| Public market data (no auth) | `wss://api.derivws.com/trading/v1/options/ws/public` | none | ticks, candles, charts, bot-skeleton engine |
| Authenticated OTP WebSocket | `wss://api.derivws.com/trading/v1/options/ws/{demo\|real}?otp=…` | OAuth2 PKCE + per-request OTP | balance, proposals, buy/sell, contract updates |

```
Browser ── /auth/deriv/login ──▶ server-node (PKCE) ──▶ auth.deriv.com
       ◀── twk_auth + twk_oauth cookies ──
Browser ── wss://api.derivws.com/.../ws/public ──▶ ticks (no app_id!)
Browser ── /api/deriv/otp/request ──▶ server ──▶ POST .../accounts/{id}/otp ──▶ fresh WS URL
```

> **Do not** append `?app_id=` to the public endpoint, and **do not** use `9eb6fce9`-style
> OAuth client IDs as `app_id` on `ws.derivws.com` — that combination returns
> `HTTP 401 Unauthorized` and breaks charts/balance (fixed in v5.6.1).

## Quick start (local)

```bash
cp .env.example .env        # then fill SESSION_SECRET (32+ chars)
npm install
npm run proxy               # starts server-node on :3001
npm run start               # rsbuild dev (http://localhost:8443)
```

Environment: `DERIV_REDIRECT_URI=http://localhost:3001/auth/deriv/callback`,
`FRONTEND_ORIGIN=http://localhost:8443`, `PUBLIC_PROXY_BASE=http://localhost:3001`,
`COOKIE_SECURE=false` (local only).

## Verification

```bash
npm run audit:new-api   # 0 active legacy transport markers -> PASS
npm run build           # rsbuild -> dist/
npm test                # 19 suites / 133+ tests
node --check server-node/index.js
```

Live checks (after deploy): `/api/health` -> `{"ok":true,"oauth":true,"restBase":"https://api.derivws.com"}`;
DevTools Network shows `101 Switching Protocols` on `wss://api.derivws.com/.../ws/public`.

See also: `docs/VERCEL_DEPLOYMENT.md`, `docs/DERIV_WS_AUTH.md`, `docs/CONFIGURATION.md`.
