# FINAL TECHNICAL VERIFICATION — DDBOt v5.6.0

## Scope

This verification focused on the production blocker reported after Vercel deployment:

- login succeeds
- charts/balance/subscriptions do not load
- browser console shows WebSocket failures / stale connection behavior
- previous architecture depended on a Vercel-incompatible WebSocket proxy path

## Root cause confirmed

The uploaded package had already moved the browser client away from `direct Deriv WebSocket transport` and toward a direct Deriv WebSocket connection. However, one critical bug still remained:

- the browser session bootstrap (`/api/deriv/me`) was still returning placeholder tokens in the form `proxy_<loginid>`
- the frontend stored those placeholders in `localStorage.authToken`
- the client then attempted direct Deriv WebSocket authorization with that stored value
- placeholder tokens are not valid for direct `authorize(token)` on Deriv WebSocket

That mismatch would still break authenticated chart/balance/trading flows even after removing the Vercel WebSocket proxy path.

## Changes applied

### 1) Fixed browser token bootstrap for direct Deriv WebSocket auth

**File:** `server-node/index.js`

- `/api/deriv/me` now returns a browser-usable Deriv authorization token in `loginInfo[*].token`
- removed the invalid placeholder `proxy_<loginid>` behavior

**File:** `src/utils/deriv-session.ts`

- bootstrap now stores the returned browser-usable token
- session marker renamed to `deriv_oauth_session`
- helper added to sync account selection back to the server session

### 2) Fixed client/runtime WebSocket configuration

**File:** `src/utils/proxy-config.ts`

- normalized direct WebSocket configuration through `PUBLIC_DERIV_WS_URL`
- default remains `wss://ws.derivws.com/websockets/v3`

**File:** `rsbuild.config.ts`

- build-time injection corrected from obsolete `PUBLIC_DERIV_WS_PROXY_URL`
- now injects `PUBLIC_DERIV_WS_URL`

**File:** `.env.example`

- documentation updated to direct Deriv WebSocket env var
- removed obsolete `WS_PROXY_PATH`

### 3) Removed dead Vercel-incompatible WebSocket proxy code

**Files:**
- `server-node/index.js`
- `api/index.mjs`
- `server.mjs`

Changes:
- removed dead server-side upgrade/proxy WebSocket path
- removed obsolete `wss` export path
- removed duplicate local `server.listen()` entrypoint behavior from wrapper files

### 4) Fixed account-selection persistence

**Files:**
- `src/components/layout/header/account-switcher.tsx`
- `src/components/layout/header/AccountSwitcherWallet/account-switcher-wallet-item.tsx`

Changes:
- account switching now also calls `/api/deriv/account/select`
- browser-selected account is persisted in the server-backed session for later bootstrap/refresh

### 5) Fixed misleading implementation comments

**Files:**
- `src/ai/lifecycle/deriv-client.ts`
- `src/components/twk-overlay/engine-boot.ts`

Changes:
- removed comments describing the old same-origin proxy translation model
- aligned comments with the actual direct-to-Deriv browser WebSocket flow

### 6) Improved startup session restore behavior

**File:** `src/app/AuthWrapper.tsx`

Changes:
- app now attempts authoritative server bootstrap on normal loads
- cached browser storage is used only as a fallback if bootstrap is temporarily unavailable

## Verification performed

### Static verification

Confirmed after patching:

- no active client/runtime reference to `direct Deriv WebSocket transport`
- no remaining build-time reference to `PUBLIC_DERIV_WS_PROXY_URL`
- direct Deriv WebSocket URL is present in built output

### Build verification

Executed successfully:

```bash
npm ci
npm run build
```

Result:

- build completed successfully
- `dist/` generated

### Server import smoke test

Validated that the server modules import cleanly when provided required env vars.

## Important deployment note

This package is build-verified and the identified production blocker has been fixed in source. However, **live-money readiness still requires one final post-deploy smoke test with your real production env vars and a very small stake**. That step cannot be completed offline inside the sandbox because it requires your real Deriv OAuth credentials, Vercel environment, cookies, and live account permissions.

## Recommended production smoke test

After deployment, verify:

1. `/auth/deriv/login` returns `302`
2. `/auth/deriv/callback` returns `302`
3. `/api/deriv/me` returns `200` after login
4. browser opens `wss://ws.derivws.com/websockets/v3?...`
5. browser does **not** request `direct Deriv WebSocket transport`
6. chart loads
7. balance stream loads
8. proposal stream loads
9. place one minimal-stake test trade and confirm contract updates arrive

## Files changed

- `server-node/index.js`
- `api/index.mjs`
- `server.mjs`
- `src/utils/deriv-session.ts`
- `src/utils/proxy-config.ts`
- `src/app/AuthWrapper.tsx`
- `src/ai/lifecycle/deriv-client.ts`
- `src/components/twk-overlay/engine-boot.ts`
- `src/components/layout/header/account-switcher.tsx`
- `src/components/layout/header/AccountSwitcherWallet/account-switcher-wallet-item.tsx`
- `rsbuild.config.ts`
- `.env.example`
- `README-production.md`

## External references used for validation

- Deriv authentication overview: https://developers.deriv.com/docs/intro/authentication/
- Deriv workflows: https://developers.deriv.com/docs/workflows/
- Deriv auth-client repository: https://github.com/deriv-com/auth-client
- Deriv Options WebSocket OTP docs: https://developers.deriv.com/docs/options/websocket/
