# DDBOt v5.6.0 — Vercel Production Hardening

## Changes in this package

### 1. Cross-instance atomic risk reservation
`server-node/risk-store.js` now uses an Upstash Redis `EVAL` Lua script for trade reservations. The script checks the open-contract, daily-loss, and max-stake limits and increments the reservation in one Redis-side atomic operation.

The previous JavaScript promise lock remains for local/VPS fallback stores, but it is not treated as cross-instance protection.

### 2. Buy reservation semantics
The server reserves risk **before** forwarding a `buy` request to Deriv. A rejected Deriv buy releases the reservation. A successful buy reconciles the reported buy price difference.

This prevents two concurrent Vercel instances from both passing a stale read of `openContracts`.

### 3. Cross-instance atomic settlement and rollback
Settlement and rollback now use a second Upstash Redis `EVAL` Lua script for additive deltas. The script performs the read, delta application, clamping, and TTL refresh as one Redis-side atomic operation. This covers:
- releasing a rejected buy reservation;
- reconciling the actual buy price/stake;
- recording a sold contract's loss and open-contract decrement.

This closes the cross-instance lost-update race that a plain Redis GET followed by SET would have left behind. The JavaScript promise lock remains only as a same-process optimization; Redis `EVAL` is the cross-instance correctness boundary.

A sold contract also decrements the durable open-contract count even if the local WebSocket process did not previously observe the contract, which is important after reconnects or instance changes.

### 4. Vercel memory setting
`memory` was removed from `vercel.json`. Current Vercel Fluid Compute instance sizing should be managed by the Vercel project/function configuration rather than hard-coded here.

### 5. Long-lived WebSocket reconnect
The browser Deriv client now retries reconnects indefinitely with capped exponential backoff. This is intentional because Vercel WebSocket Functions are subject to Function duration limits; a closed connection must obtain a fresh authenticated proxy connection and re-subscribe.

## Deployment verification still required

This ZIP cannot prove an actual Vercel deployment without deploying it. After deployment, verify:

- `/api/health` returns `200`
- `riskStoreShared` is `true`
- OAuth redirect reaches `https://auth.deriv.com/oauth2/auth`
- OAuth callback returns to the deployed domain
- authenticated `/api/deriv/me` works
- `direct Deriv WebSocket transport` connects
- demo proposal/buy/settlement works
- a forced WebSocket close reconnects and restores subscriptions
- Upstash Redis is configured
- `REQUIRE_SHARED_RISK_STORE=true` in production
- the deployed Function uses Fluid Compute/WebSocket support

## Vercel duration

The package keeps `maxDuration: 300` as a conservative explicit value. Vercel currently documents 300 seconds as the default duration and longer durations for eligible Pro/Enterprise configurations. The client therefore does not rely on a WebSocket living forever.
