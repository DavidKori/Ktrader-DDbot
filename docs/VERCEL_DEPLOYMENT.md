# Vercel deployment (v5.6.2-clean)

## Build settings

- Framework preset: Node.js 24.x; Build command `npm run build`; Output `dist`.
- **Enable Fluid Compute** on the deployment — required for WebSocket upgrades.
- Single project; do not reuse an old Vercel project config from the v5.5.x era.

## Environment variables (Production + Preview)

| Key | Value | Notes |
|---|---|---|
| `DERIV_OAUTH_APP_ID` | `33tDyOr00nQjiUbISnUBK` | OAuth client_id (Deriv dashboard) |
| `DERIV_APP_ID` | *(empty)* | legacy numeric app id — leave blank |
| `DERIV_REDIRECT_URI` | `https://tradewithkenbots.vercel.app/auth/deriv/callback` | must match Deriv registered redirect |
| `FRONTEND_ORIGIN` | `https://tradewithkenbots.vercel.app` | same-origin CORS |
| `PUBLIC_PROXY_BASE` | `https://tradewithkenbots.vercel.app` | SPA origin (browser) |
| `PUBLIC_DERIV_WS_URL` | `wss://api.derivws.com/trading/v1/options/ws/public` | fixes 401; replaces legacy v3 URL |
| `DERIV_REST_BASE` | `https://api.derivws.com` | |
| `DERIV_OAUTH_AUTHORIZE_URL` | `https://auth.deriv.com/oauth2/auth` | |
| `DERIV_OAUTH_TOKEN_URL` | `https://auth.deriv.com/oauth2/token` | |
| `DERIV_OAUTH_SCOPE` | `trade` | |
| `SESSION_SECRET` | *(32+ random chars)* | `openssl rand -base64 48` |
| `COOKIE_SECURE` | `true` | required for OAuth round-trip |
| `NODE_ENV` | `production` | Production scope only |
| `MAX_STAKE` | `100` | |
| `MAX_OPEN_CONTRACTS` | `2` | |
| `MAX_DAILY_LOSS` | `300` | |
| `ALLOWED_SYMBOLS` | `frxEURUSD,frxGBPUSD,frxUSDJPY,frxAUDUSD,frxNZDUSD,frxUSDCHF,frxEURGBP,frxEURJPY,frxGBPJPY,frxAUDJPY,frxEURAUD,frxEURCAD,frxGBPAUD,frxUSDCAD,frxXAUUSD,frxXAGUSD,R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V,1HZ150V,1HZ250V,1HZ500V,1HZ1000V,BOOM300,BOOM500,BOOM1000,CRASH300,CRASH500,CRASH1000,stpRNG,stpRNG2,stpRNG3,JD10,JD25,JD50,JD75,JD100,RDBEAR,RDBULL,RDBRANGE100` | full Deriv universe exposed to the AI router |
| `REQUIRE_SHARED_RISK_STORE` | `false` | set `true` only with Upstash |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | *(optional)* | required for shared risk store (real money) |

**Do not** define legacy `WS_PROXY_PATH`, `PUBLIC_DERIV_WS_PROXY_URL`, or `DERIV_LEGACY_APP_ID` —
they are obsolete and were the source of prior breakage.

## Post-deploy checklist

1. `GET /api/health` → `{"ok":true,"oauth":true,"legacyDerivTransport":false,"restBase":"https://api.derivws.com"}`
2. If a stale service worker is serving the old SPA, run in the console once:
   `navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister())); caches.keys().then(ks=>ks.forEach(k=>caches.delete(k))); localStorage.clear(); location.reload();`
3. Login → DevTools Network → expect `101 Switching Protocols` on `wss://api.derivws.com/trading/v1/options/ws/public`.
4. Balance loads, ticks advance, proposal → buy works on a demo account before any real money.
