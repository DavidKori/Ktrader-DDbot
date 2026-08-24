# DDBot v5.6.0 — Refinement Pass (verified fixes only)

This pass applies exactly two changes to your existing v5.6.0 source, both
verified against your actual codebase and confirmed with a real production
build before packaging. Nothing else in the codebase was touched.

## 1. OAuth PKCE cookie SameSite (server-node/index.js)

**Problem:** `setCookie`/`clearCookie` hardcoded `sameSite: 'lax'` for every
cookie, including the OAuth PKCE state cookie (`twk_oauth`). That cookie
needs `SameSite=None` to reliably survive the redirect through
auth.deriv.com and back, which caused intermittent "Invalid or expired
OAuth state" failures on the callback.

**Fix:** Both functions now check the cookie name and use `'none'` only for
the OAuth cookie, keeping the normal session cookie (`twk_auth`) on `'lax'`
as before.

## 2. WebSocket architecture (src/ai/lifecycle/deriv-client.ts)

**Problem:** Authenticated sessions connected through `DERIV_WS_PROXY_URL`
(same-origin `direct Deriv WebSocket transport`, rewritten by vercel.json to api/index.mjs). That
route depends on `server.on('upgrade', ...)` attached to a raw Node
`http.Server` — which only works when `server.listen()` runs. Your own code
explicitly skips that call on Vercel (`if (process.env.VERCEL !== '1')`),
so on Vercel nothing was listening for the WebSocket upgrade at all,
producing a 403 on every handshake once a user logged in (guests, who
already bypassed the proxy, were unaffected).

**Fix:** Both guest and authenticated sessions now connect directly to
`wss://api.derivws.com/trading/v1/options/ws/public`. `authorize(token)`
still runs immediately after the connection opens, same as before — only
the transport changed, not the authorization logic. The now-unused
`DERIV_WS_PROXY_URL` import was removed (required, since this project
builds with `noUnusedLocals: true`).

## Verified before packaging
- `npm install` — succeeds (Node engine warnings only, non-blocking)
- `npm run build` — succeeds, `dist/` generated with no errors
- `node --check server-node/index.js` — syntax OK

## Not changed
`vercel.json`, `.env.example`, `proxy-config.ts`, `DERIV_DEFAULT_APP_ID`,
and everything else are untouched. If ticks still don't flow after
deploying this, the next thing to check is whether Deriv's WS endpoint
needs an explicit `?app_id=` query param on the connection URL — the
client currently sends none.

## Deploy
This is your existing repo's workflow — no new steps:
```
git add server-node/index.js src/ai/lifecycle/deriv-client.ts
git commit -m "Fix OAuth cookie SameSite + connect WS directly to Deriv (bypass broken Vercel proxy)"
git push
```
Vercel will auto-redeploy from the push.

## v5.6.2-clean (2026-08-23)
- Audit `npm run audit:new-api` → **PASS (0 legacy markers)**; removed last legacy default
  (`wss://ws.derivws.com/websockets/v3`) from `src/utils/proxy-config.ts` and `.env.example`.
- Service worker fix: `isAuthRequest`/`isApiRequest` rewritten to **exact-match allow-lists**
  (public + dist). Google Fonts no longer flood-logged; WebSocket upgrades to
  `api.derivws.com` are no longer swallowed (ticks/candles restored).
- Symbol coverage: AI router + asset selector now expose the full Deriv universe
  (forex/multipliers + volatiles 1HZ/V, boom/crash, step/jump/range).
- Docs: stale v5.5.x/v5.6.0 md moved to `docs/archive/`; clean `README.md`,
  `docs/VERCEL_DEPLOYMENT.md`, `docs/DERIV_WS_AUTH.md`, `docs/CONFIGURATION.md` added.
- Verified: 19 suites / 133+ tests pass, rsbuild build succeeds, bundle contains public WS endpoint only.
