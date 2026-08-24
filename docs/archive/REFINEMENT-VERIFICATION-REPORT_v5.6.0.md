# DDBOt v5.6.0 — Refinement & Verification Report

## Scope

This package was refined from the supplied `DDBOt-New-Deriv-v5.6.0-final-source.zip`.

The primary blocker found in the supplied source was the missing legacy string-based `Icon` resolver. Eleven React files imported:

`@/utils/tmp/dummy`

while the old resolver was absent/placeholder in the working copy.

## Fixes applied

### 1. Replaced the dummy icon dependency

Added:

`src/utils/icon-compat.tsx`

This is now the single compatibility boundary for the remaining legacy string icon API.

Mapped legacy names include:

- `IcAdd`
- `IcAddBold`
- `IcMinus`
- `IcCheckmark`
- `IcChevronRight`
- `IcChevronRightBold`
- `IcCircle`
- `IcUnknown`
- `IcAlertDanger`
- `IcAlertWarning`
- `IcAlertInfo`
- `ic-deriv`
- `ic-currency-eur-check`
- `IcTradetypeAccu`
- `IcMigrateStrategy`
- `IcUpgradeBlockly`

The implementation uses the installed/current Quill icon exports where a direct equivalent exists. The two old announcement illustration names that have no one-to-one Quill export use deterministic inline SVG fallbacks instead of reintroducing the removed icon package.

Unknown legacy icon names fall back to a visible Quill information icon rather than crashing or rendering an empty slot.

### 2. Updated all stale imports

All remaining imports of:

`@/utils/tmp/dummy`

were changed to:

`@/utils/icon-compat`

The obsolete dummy resolver is not included in the final package.

### 3. Fixed the Rsbuild environment definition

The supplied `rsbuild.config.ts` had a malformed comment on the same line as `DERIV_APP_ID`. That comment accidentally swallowed the `DERIV_OAUTH_APP_ID` definition.

The environment definitions are now explicit:

- `DERIV_APP_ID`
- `DERIV_OAUTH_APP_ID`
- `PUBLIC_PROXY_BASE`
- `PUBLIC_DERIV_WS_PROXY_URL`

### 4. Hardened the npm prepare script

Changed:

`husky install`

to:

`husky install || true`

This prevents a missing/non-Git environment from unnecessarily failing deployment installation.

### 5. Normalised package version

The project package and lockfile root metadata are now versioned as:

`5.6.0`

### 6. Expanded proxy symbol allow-list

The proxy previously defaulted to only:

`R_100,R_75,R_50,R_25,R_10`

That conflicted with the application's forex + synthetic scanner configuration.

The default allow-list now covers the symbols registered by the project's forex and synthetic symbol registries. `ALLOWED_SYMBOLS` remains an environment override.

### 7. Improved proxy symbol extraction

The WebSocket compatibility layer now checks both:

- `payload.underlying_symbol`
- `payload.symbol`
- `payload.parameters.underlying_symbol`
- `payload.parameters.symbol`

before applying the risk gate.

### 8. Added repeatable icon audit

Added:

`scripts/audit-icons.mjs`

and npm script:

`npm run audit:icons`

It verifies:

- no stale dummy imports remain
- the dummy resolver is absent
- detected literal legacy icon names have explicit compatibility mappings

## Verification performed

### Passed

- Icon audit
- JSON parsing of `package.json`
- JSON parsing of `package-lock.json`
- Node syntax check of `server-node/index.js`
- Search for stale `@/utils/tmp/dummy` imports
- Confirmation that `DERIV_OAUTH_APP_ID` is present in Rsbuild environment definitions

The icon audit reported:

- 1,042 source JS/TS files scanned
- 11 legacy Icon consumers using the compatibility layer
- 11 literal legacy icon names detected
- stale dummy resolver: absent

### Dependency/build limitation

A complete production `npm ci` / Rsbuild TypeScript build could not be completed in the isolated verification environment because the required npm registry packages were not fully cached.

The project declares Node `24.x`. The available verification runtime was Node `22.16.0`, so it was intentionally not treated as a production build environment.

Use Node 24 locally/CI for the final deployment build.

## Deriv API architecture verification

The current source's OAuth/Options API architecture is consistent with Deriv's current developer documentation:

- OAuth authorization endpoint: `https://auth.deriv.com/oauth2/auth`
- OAuth token endpoint: `https://auth.deriv.com/oauth2/token`
- REST base: `https://api.derivws.com`
- authenticated Options accounts: `/trading/v1/options/accounts`
- OTP: `/trading/v1/options/accounts/{accountId}/otp`
- authenticated WebSocket URL is returned by the OTP endpoint
- public WebSocket: `/trading/v1/options/ws/public`

The proxy keeps the OAuth access token server-side and exposes a browser-facing compatibility WebSocket rather than placing the bearer token in browser JavaScript.

## Deployment requirement

For production OAuth:

`DERIV_REDIRECT_URI` must exactly match the redirect URI registered in the Deriv developer application.

If the proxy is exposed on the same public origin as the frontend, use:

`https://YOUR-DOMAIN/auth/deriv/callback`

If the proxy is hosted on a separate public origin, the registered redirect URI must be the proxy's callback URL, and the frontend must use that proxy as `PUBLIC_PROXY_BASE`.

Do not put the OAuth access token in frontend environment variables.

## Final package principle

The source now has:

Frontend
→ OAuth login URL
→ server-side PKCE callback
→ server-side Bearer token
→ Options REST account discovery
→ server-side OTP
→ authenticated Options WebSocket
→ browser compatibility relay

The old numeric-app-id-only OAuth assumptions are not reintroduced.
