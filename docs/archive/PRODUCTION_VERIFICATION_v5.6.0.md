# Production Verification Record — DDBOt v5.5.6

Date: 2026-08-09

## Passed in the sandbox

### JavaScript syntax

Command:

```text
node --check server-node/index.js
```

Result:

```text
PASS
```

All JavaScript files under `src`, `server-node`, and `scripts` were checked
with `node --check`.

Result:

```text
JS syntax failures: 0
```

### Deriv migration audit

Command:

```text
node scripts/audit-deriv-new-api.mjs
```

Result:

```text
PASS: scanned 1043 source files.
PASS: no active legacy transport markers found.
PASS: OAuth PKCE + Options REST/OTP markers present.
```

### TypeScript static check

The repository's installed dependencies were not available in the sandbox, so
the full application build could not be executed here.

The system TypeScript compiler was still run against the project. The only
top-level configuration failure before dependency resolution was missing Jest
type definitions. A follow-up parse/type pass showed pre-existing project
issues and missing third-party packages, but no new TypeScript semantic error
was introduced in the main files changed for this migration after the
dependency-related errors were filtered.

### npm install limitation

A clean `npm ci --legacy-peer-deps --ignore-scripts` was attempted.

The sandbox package registry returned:

```text
404 'npm@10.9.4' is not in this registry
```

Therefore a real `npm run build` and Jest execution could not be truthfully
claimed as passed inside this sandbox.

This is an environment/package-registry limitation, not a source-code build
result.

## What still must be verified after the fresh local install

Run:

```powershell
npm install --legacy-peer-deps
npm --prefix server-node install
npm run audit:new-api
node --check .\server-node\index.js
npm run build
npm test -- --runInBand
```

Then perform the demo-account OAuth and trading test.

## Important

This package is not being represented as "real-money production verified"
until the actual Deriv OAuth client, exact deployed HTTPS callback, Vercel
deployment, demo Options account, OTP flow, authenticated WebSocket, proposal,
buy, contract update, sell, and reconnect have all been tested.
