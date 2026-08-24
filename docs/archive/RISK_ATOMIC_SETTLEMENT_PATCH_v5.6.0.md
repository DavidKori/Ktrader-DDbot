# DDBOt v5.6.0 — Atomic Settlement Patch

## Problem fixed

The original production hardening made `reserveRiskState()` atomic with Redis Lua, but `updateRiskState()` still used:

1. Redis GET
2. calculate delta
3. Redis SET

Two Vercel Function instances settling contracts concurrently could therefore overwrite each other's counters.

## Fix

`server-node/risk-store.js` now defines `APPLY_RISK_DELTA_LUA` and the Upstash backend exposes `update(key, delta)`.

The Redis-side script atomically:

- reads the current day-scoped state;
- resets stale-day state;
- applies `openContracts`, `totalStakeToday`, and `lossToday` deltas;
- clamps counters at zero;
- writes the resulting state;
- refreshes the TTL;
- returns the resulting JSON state.

`updateRiskState()` uses this atomic Redis path whenever Upstash Redis is configured.

The local file/memory fallback retains its existing per-process lock and remains unsuitable for shared production trading. `REQUIRE_SHARED_RISK_STORE=true` must remain enabled in production.

## Result

The risk lifecycle now has two Redis atomic boundaries:

- **reservation:** limit check + reservation increment;
- **settlement/rollback:** read + additive delta + write.

This prevents lost settlement updates across concurrent Vercel Function instances.
