# DDBOt v5.6.0 — Deriv New-Portal Migration Handoff

## What was changed

### 1) Active transport switched to the current Deriv architecture

Browser login and trading now flow through:

- OAuth 2.0 Authorization Code + PKCE
- REST account discovery (`GET /trading/v1/options/accounts`)
- REST OTP issuance (`POST /trading/v1/options/accounts/{accountId}/otp`)
- authenticated Options WebSocket custody on the server side
- same-origin browser relay over `direct Deriv WebSocket transport`
- public market-data fallback on `wss://api.derivws.com/trading/v1/options/ws/public`

### 2) Frontend auth/bootstrap repaired

- `loginUrl()` now points to `/auth/deriv/login`
- frontend boot now restores a server-backed session from `/api/deriv/me`
- browser storage now keeps only opaque `proxy_<accountId>` markers
- callback page forwards code/state to the server callback when needed
- logout clears browser cache and terminates the server-backed session

### 3) Trading engine safety fixes

- fixed martingale ladder persistence after a non-martingale loss
- fixed aggregate exposure cap to compare consistent notional units
- added invalid ATR/pip fallbacks so SL/TP sizing cannot explode on bad inputs
- retained expectancy gate, recovery engine, concurrency gate, kill switch, and exposure tracker

### 4) Server hardening

- added refresh-token based session renewal before authenticated REST and WebSocket use
- kept token custody server-side in encrypted HttpOnly cookies
- preserved server-side trade risk gates before proposal/buy forwarding

## Files most relevant to the migration

- `server-node/index.js`
- `src/utils/deriv-session.ts`
- `src/utils/proxy-config.ts`
- `src/components/shared/utils/login/login.ts`
- `src/app/AuthWrapper.tsx`
- `src/pages/callback/callback-page.tsx`
- `src/external/bot-skeleton/services/api/appId.js`
- `src/ai/lifecycle/deriv-client.ts`
- `src/ai/execution/execution-engine.ts`
- `src/ai/risk/risk-engine.ts`

## Regression tests added

- `src/ai/execution/__tests__/execution-engine.spec.ts`
- `src/ai/risk/__tests__/risk-engine.spec.ts`

## Static verification completed in sandbox

Passed:

- `node --check server-node/index.js`
- `npm run audit:new-api`
- `npm run build`
- `npm test -- --runInBand`

## Still required outside sandbox

These require your real Deriv OAuth app registration and a live deployment URL, so they were not claimed as completed here:

- exact redirect URI registration in Deriv dashboard
- full OAuth consent flow against your deployed domain
- real account selection behavior on your own Deriv tenant
- OTP issuance against your live demo account
- end-to-end WebSocket trading on deployed infrastructure
- Vercel websocket/session behavior under reconnect and cold-start conditions

## Recommended deployment checklist

1. Copy `.env.example` to `.env`
2. Set `SESSION_SECRET` to a real 32+ character random secret
3. Register the exact HTTPS redirect URI:
   - `https://YOUR-DOMAIN/auth/deriv/callback`
4. Set `FRONTEND_ORIGIN` and `DERIV_REDIRECT_URI` to the same deployed origin
5. Deploy frontend + `server-node` together behind one origin
6. Test demo login
7. Test account discovery
8. Test OTP issuance
9. Test public ticks
10. Test demo proposal, buy, contract updates, sell, reconnect

## Recommended next live test order

1. health endpoint
2. login redirect
3. callback success
4. `/api/deriv/me`
5. `/api/deriv/otp/request`
6. `direct Deriv WebSocket transport` upgrade
7. demo tick stream
8. demo proposal
9. demo buy
10. proposal_open_contract lifecycle
11. demo sell / expiry
12. refresh-token renewal after access-token expiry
