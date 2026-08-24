# Deriv `app_id` — single source of truth, and the chart-auth bug (Aug 2026)

## The rule

There is exactly **one** app_id this project uses for every Deriv WebSocket
connection: the alphanumeric id from `DERIV_APP_ID` (Deriv's current
developer dashboard, `developers.deriv.com`), exposed to the browser bundle
via `DERIV_DEFAULT_APP_ID` in `src/ai/lifecycle/deriv-client.ts`.

- **Do not** hardcode or fall back to a legacy numeric app_id (e.g. Deriv's
  public test id `1089`, or any of the `APP_IDS` constants in
  `src/components/shared/utils/config/config.ts` — those are for Deriv's own
  `dbot.deriv.com` domain routing, not this project's WebSocket auth).
- **Do not** open a `new WebSocket(...)` to any `ws.derivws.com` /
  `ws.binaryws.com` / `websockets/v3` URL without appending
  `?app_id=${DERIV_DEFAULT_APP_ID}`. Deriv rejects the connection at the
  HTTP-upgrade handshake if `app_id` is missing or empty — before your code
  gets a chance to send `authorize`, and before any error you can catch in
  application logic.
- If you add a new WebSocket connection anywhere in `bot-skeleton` or
  elsewhere, import `DERIV_DEFAULT_APP_ID` from
  `src/ai/lifecycle/deriv-client.ts` rather than reading `process.env`
  directly — keeps every connection using the same value if it's ever
  rotated.

## What went wrong (root cause)

`src/external/bot-skeleton/services/api/appId.js` — the function
`generateDerivApiInstance()`, used by both the price chart (`chart-api.js`)
and the visual DBot block engine (`api-base.ts`) — opened its WebSocket like
this:

```js
const deriv_socket = new WebSocket(DERIV_WS_URL); // no app_id
```

Meanwhile `src/ai/lifecycle/deriv-client.ts` (the AI/orchestrator trading
path) built its socket URL correctly, with `app_id` appended. The two
connection paths had silently diverged: one was fixed to include `app_id`,
the other never was. Symptom in the browser console:

```
WebSocket connection to 'wss://ws.derivws.com/websockets/v3' failed:
HTTP Authentication failed; no valid credentials available
```

Clearing site storage/cookies did nothing, because the failure isn't a stale
token — it's the connection URL itself being malformed. This is also why the
chart specifically stayed broken even after the OAuth trading path was fully
migrated: the README at the time claimed legacy `ws.derivws.com` transport
had been removed from the codebase, which was true for the OAuth trading
path but never true for `bot-skeleton`. That inaccurate doc is why the gap
went unnoticed — see the corrected "Two connection paths exist" section in
the main `README.md`.

## The fix (Aug 2026)

- `appId.js` now builds `${DERIV_WS_URL}?app_id=${encodeURIComponent(DERIV_DEFAULT_APP_ID)}`,
  importing `DERIV_DEFAULT_APP_ID` from `deriv-client.ts` — same value, same
  source, both connection paths now agree.
- Removed `getNumericDerivEnvAppId()` from `config.ts` (dead code that would
  have silently coerced/fallen back to the numeric test id `1089` if it were
  ever wired into a connection — a trap for a future "fix"). Replaced with
  `getDerivEnvAppId()`, which passes the alphanumeric id through as a string,
  no numeric fallback.

## How to avoid this class of bug going forward

1. Before adding any new Deriv WebSocket connection, grep the codebase for
   `new WebSocket(` and confirm your new call also appends `app_id`.
2. Don't trust architecture docs at face value when debugging a transport
   issue — verify by grepping for the literal failing hostname
   (`ws.derivws.com`, `websockets/v3`) across `src/`, not just reading the
   README's claimed architecture.
3. If Deriv ever rotates `DERIV_APP_ID`, it only needs to change in one
   place (the Vercel env var) — both connection paths read the same env var
   through the same constant, so there's nothing else to update in source.
