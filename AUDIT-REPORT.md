# DDBot v5.6.2 Clean Validation Report

## Scope

This package was audited for build integrity, automated execution routing, live-account safety boundaries, and accidental secret patterns. It was not modified to route losing trades to virtual funds and winning trades to real funds; outcome-dependent routing is not implemented because trade outcomes are not knowable before execution.

## Execution-routing findings

The execution engine selects `VIRTUAL`, `LIVE`, or `LIVE_MARTINGALE` before an order is placed, using confidence, validation, market-stability, drawdown, consecutive-loss, exposure, and rolling expectancy gates. Virtual trades use a zero stake and are settled by the local simulation path. Live trades call the Deriv client order methods and are settled later through the live position path. The settlement result is recorded after routing and does not change the account used for the trade.

## Validation results

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | Passed |
| `npm run audit:new-api` | Passed; no active legacy transport markers |
| `npm run audit:icons` | Passed |
| `npm test -- --runInBand` | Passed; 20 suites and 134 tests |
| `node --check server-node/index.js` | Passed |
| `npm run build` | Passed; production `dist/` generated |
| Secret-pattern scan | Passed; no matching private-key or common token patterns found in source, excluding generated/vendor directories |

## Deployment note

Review all production environment variables and the active Deriv account before enabling live mode. A passing build and test suite do not guarantee profitability or eliminate market, exchange, authentication, or operational risk.
