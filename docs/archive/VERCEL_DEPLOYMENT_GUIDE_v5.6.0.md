# DDBOt v5.5.6 — OAuth / Vercel Deployment Checklist

## 1. Deploy first

Push this package to a fresh GitHub repository and import it into Vercel.

Do not reuse the previous Vercel project configuration until the new project
has been verified.

Vercel now supports Node.js WebSocket servers in public beta. This package uses
a root `server.mjs` entry point (`npm run start:server`) so the same application can serve the SPA,
OAuth endpoints, REST proxy endpoints, and `direct Deriv WebSocket transport`.

## 2. Determine the live domain

After the first Vercel deployment, copy the exact HTTPS production URL Vercel
assigns to the project.

Example only:

`https://ddbot-something.vercel.app`

Do not copy this example into Deriv. Use the actual URL shown by Vercel.

## 3. Register the exact Deriv callback

In the Deriv OAuth application, register:

`https://ACTUAL-VERCEL-DOMAIN/auth/deriv/callback`

The string must match the application's `DERIV_REDIRECT_URI` exactly.

## 4. Vercel environment variables

Set these in Vercel Production:

```text
NODE_ENV=production
DERIV_APP_ID=33tDyOr00nQjiUbISnUBK

# Current Deriv portal configuration: OAuth App ID and WebSocket app_id use the same alphanumeric application identifier.
DERIV_OAUTH_APP_ID=<OAuth client id>
DERIV_OAUTH_AUTHORIZE_URL=https://auth.deriv.com/oauth2/auth
DERIV_OAUTH_TOKEN_URL=https://auth.deriv.com/oauth2/token
DERIV_OAUTH_SCOPE=trade
DERIV_REST_BASE=https://api.derivws.com
DERIV_REDIRECT_URI=https://ACTUAL-VERCEL-DOMAIN/auth/deriv/callback
FRONTEND_ORIGIN=https://ACTUAL-VERCEL-DOMAIN
COOKIE_SECURE=true
SESSION_SECRET=<32+ random characters>
WS_PROXY_PATH=direct Deriv WebSocket transport
MAX_STAKE=100
MAX_OPEN_CONTRACTS=2
MAX_DAILY_LOSS=300
ALLOWED_SYMBOLS=R_100,R_75,R_50,R_25,R_10
```

Do not put a Deriv personal access token in the project. OAuth is the
authentication mechanism.

## 5. WebSocket behavior

The browser connects to:

`wss://ACTUAL-VERCEL-DOMAINdirect Deriv WebSocket transport`

The proxy then requests a fresh Deriv Options OTP and connects to the returned
`api.derivws.com` WebSocket URL.

Vercel's current WebSocket support is public beta. Connections are pinned to a
Function instance for their duration, but future connections are not
guaranteed to use the same instance. This build therefore avoids the old
in-memory `express-session` model and stores the authenticated session as an
encrypted HttpOnly cookie.

The browser's reconnect logic obtains a new proxy connection, which causes
the server to request a new short-lived Deriv OTP.

## 6. First production test

Test in this order:

1. Open the Vercel URL.
2. Confirm the DDBOt page loads.
3. Click Login with Deriv.
4. Confirm the browser reaches Deriv.
5. Complete login/consent.
6. Confirm the browser returns to the exact Vercel domain.
7. Confirm `/api/deriv/me` returns account information.
8. Start scanning.
9. Confirm ticks arrive.
10. Request a proposal on a demo account.
11. Perform a small demo trade.
12. Confirm contract updates.
13. Test early sell if supported by the selected contract.
14. Test reconnect.
15. Only after all of the above succeeds should real-money execution be
    considered.

## 7. If Deriv blocks the OAuth page

A Cloudflare/security "Access Denied" page means the OAuth authorization
request reached Deriv but the connection was blocked before the application
could complete OAuth.

Do not interpret that page as proof that PKCE is broken.

Check:

- the live HTTPS redirect URI is registered exactly;
- the App ID is the new OAuth client ID;
- no legacy numeric App ID is being used;
- the request uses `client_id`, not legacy `app_id`;
- the callback uses HTTPS in production;
- the URL is not being repeatedly hammered during testing.

## 8. Never mix callback architectures

This package uses:

```text
/auth/deriv/login
/auth/deriv/callback
```

The callback belongs to the deployed application itself.

Do not configure one callback in Deriv while the source code points to another.

## 9. Vercel beta note

Vercel's WebSocket support is currently public beta. The package is designed
around the current platform model, including reconnects and stateless encrypted
session cookies, but final end-to-end verification must be performed against
the actual Vercel deployment because platform limits and account-plan behavior
cannot be proven from a local build alone.

---

## Addendum — explicit Vercel adapter + durable risk state (v5.6.0-vercel-ready)

### 1. Vercel routing is now explicit

Added:

- `vercel.json` — `buildCommand: npm run build`, `outputDirectory: dist`, and rewrites
  sending `/api/*`, `/auth/*` and `direct Deriv WebSocket transport` to the Node Function. Everything else is
  served as static SPA output from `dist`.
- `api/index.mjs` — the Vercel Function entrypoint. It re-exports the Express `app`,
  the `http` server (needed for the `direct Deriv WebSocket transport` upgrade) and `wss` from
  `server-node/index.js`. The root `server.mjs` remains the entrypoint for plain
  Node / Render / Fly / VPS.

`server-node/index.js` only calls `server.listen()` when `process.env.VERCEL !== '1'`,
so the same code runs in both modes.

WebSockets on Vercel require Fluid Compute to be enabled for the project.

### 2. Trading risk state is no longer only in-process memory

`server-node/risk-store.js` replaces the old `const riskStates = new Map()`:

| Backend | Trigger | Scope |
| --- | --- | --- |
| Upstash Redis REST | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | shared by all instances — **required for real money** |
| JSON file | default (`RISK_STATE_FILE`, else tmpdir) | survives restarts on one host |
| Memory | only if no file path | last resort |

Behaviour:

- reads/writes are serialised per account key, so concurrent buys cannot race
- counters are day-scoped and reset at UTC midnight
- `riskGate()` **fails closed**: if the store is unreachable the trade is refused
- `REQUIRE_SHARED_RISK_STORE=true` makes the server refuse to boot without Redis
- `GET /api/health` now reports `riskStore` and `riskStoreShared`

### 3. Before enabling real money

```
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
REQUIRE_SHARED_RISK_STORE=true
```

Then confirm `GET /api/health` returns `"riskStoreShared": true`.
