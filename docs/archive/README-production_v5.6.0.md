# DDBOt v5.6.0 Final Production Notes

## What was fixed

1. **Removed the Vercel-incompatible browser WebSocket proxy dependency** for the trading/chart client path.
   - Browser WebSocket traffic is now directed to `wss://ws.derivws.com/websockets/v3`.
   - OAuth/session HTTP traffic remains same-origin through `/auth/deriv/*` and `/api/deriv/*`.

2. **Fixed session bootstrap token handling.**
   - `/api/deriv/me` now returns a browser-usable Deriv authorization token instead of an internal `proxy_<loginid>` placeholder.
   - This resolves the direct WebSocket `authorize(token)` path for charts, balance, subscriptions, and trading flows.

3. **Fixed build-time environment wiring.**
   - Rsbuild now injects `PUBLIC_DERIV_WS_URL` instead of the obsolete `PUBLIC_DERIV_WS_PROXY_URL`.
   - `.env.example` now documents the direct WebSocket variable correctly.

4. **Removed dead server-side WebSocket upgrade code.**
   - The Vercel deployment no longer carries the obsolete `direct Deriv WebSocket transport` upgrade path.
   - The remaining server responsibilities are OAuth, session refresh, account discovery, and account selection persistence.

5. **Improved account persistence.**
   - When the user switches accounts in the UI, the selection is synced back to `/api/deriv/account/select` so reload/bootstrap preserves the chosen account.

6. **Made session bootstrap authoritative on load.**
   - The app now attempts `/api/deriv/me` on normal loads to refresh token state from the server-backed session before falling back to cached browser storage.

## Verification completed

- `npm ci`
- `npm run build`
- Static search confirms there is **no active client/runtime reference** to `direct Deriv WebSocket transport` in the client path.
- Serverless routing still serves only `/api/*` and `/auth/*` through `api/index.mjs`.

## Required production environment

At minimum, configure the following on Vercel:

- `DERIV_APP_ID` (WebSocket application identifier; current Deriv portal value: `33tDyOr00nQjiUbISnUBK`)
- `DERIV_OAUTH_APP_ID`
- `DERIV_REDIRECT_URI`
- `FRONTEND_ORIGIN`
- `SESSION_SECRET`
- `COOKIE_SECURE=true`
- `PUBLIC_PROXY_BASE=https://YOUR-DOMAIN`
- `PUBLIC_DERIV_WS_URL=wss://ws.derivws.com/websockets/v3`

## Post-deploy smoke test

1. Open the app while logged out.
2. Start login and confirm:
   - `/auth/deriv/login` → `302`
   - `/auth/deriv/callback` → `302`
   - `/api/deriv/me` → `200` after login
3. In DevTools Network, confirm the browser opens:
   - `wss://ws.derivws.com/websockets/v3?...`
4. Confirm there is **no** client request to:
   - `direct Deriv WebSocket transport`
5. Confirm balance, active symbols, proposals, and chart/tick updates load after login.

## Important note

This package is production-hardened and build-verified, but **live-money activation should still be validated with a small-stake post-deploy smoke trade** because that requires your real Deriv account, current app credentials, and production environment variables.
