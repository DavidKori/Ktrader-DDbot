# DDBOt v5.5.5 — Production / Master Audit

## Scope

This release was audited against the uploaded `ddbot-v5.5.4-hotfix.zip` source.
The audit covered:

- repository-wide no-repaint integration
- look-ahead / future-data leakage
- deterministic replay and expectancy simulation
- regression behavior
- candle freshness and reconnect integrity
- Deriv OAuth callback and redirect routing
- auth-token persistence under blocked storage
- chart subscription lifecycle
- auto-trade and manual-trade startup paths
- exposure accounting
- production build and tests

## Final verification results

| Check | Result |
|---|---:|
| Production `npm run build` | PASS |
| Repository Jest suite | PASS — 17 suites / 130 tests |
| No-repaint + audit suites | PASS — 4 suites / 87 tests |
| Modified-file ESLint | No rule errors; warnings remain in inherited code and explicit `any`-typed integration surfaces |
| AI-subtree differential type audit | PASS — no new TypeScript errors compared with pristine v5.5.4 |
| Full standalone `tsc --noEmit` | Existing repository-wide type debt remains outside this release scope; the production Rsbuild build is green |

## No-repaint implementation

### Guard layers

1. `src/ai/lifecycle/deriv-client.ts`
   - fetches one extra candle
   - coerces OHLC values
   - removes invalid rows
   - removes duplicate epochs
   - restores chronological order
   - excludes forming bars before returning history

2. `src/ai/lifecycle/orchestrator.ts`
   - refreshes candle history instead of keeping the old one-shot snapshot
   - applies a second guard before indicators/features/AI/signals
   - skips entry evaluation safely when the bar is forming or history is in warm-up
   - keeps closed-bar history available for exit management
   - exposes `noRepaintDiagnostics()`

3. Module-local defence in depth
   - scanner
   - burst detector
   - gap detector
   - adaptive TP/SL buffer

### Covered invariants

- a forming bar never reaches indicators, features, AI, signal generation, or entry execution
- a forming bar never crashes the live loop
- mutating a live websocket bar does not change the guarded historical output
- multiple timeframes are validated independently
- duplicate/out-of-order/invalid feed data is handled safely
- guarded output is prefix-stable during historical replay

## Look-ahead audit

`src/ai/engine/__tests__/look-ahead-audit.test.ts` verifies that:

- indicators remain causal
- ML feature vectors remain causal
- burst direction/confidence cannot be changed by a forming candle
- adaptive TP/SL geometry cannot be changed by a forming candle
- gap detection cannot toggle from an unclosed bar
- walk-forward windows do not overlap into the future
- the audit harness detects a deliberately cheating function

## Determinism audit

`src/ai/engine/deterministic-random.ts` adds seeded deterministic randomness.

Fixed paths:

- expectancy simulator
- portfolio simulator
- virtual neutral/digit outcomes

The simulator now has a bounded rejection loop so impossible configuration cannot
hang the browser. Seeded runs are reproducible; an explicit opt-out remains
available for non-deterministic Monte Carlo behavior.

## Regression audit

`src/ai/engine/__tests__/no-repaint-regression.test.ts` proves:

- when all bars are closed, the guarded pipeline is identical to the baseline
- when the newest bar is forming, exactly that bar is excluded
- an extreme forming bar cannot alter the guarded decision
- guarded trade frequency can only stay the same or decrease
- exit management is not starved while an entry bar forms

## OAuth / callback / redirect audit

Verified in source:

- `/callback` route exists
- `/oauth/callback` route exists
- both routes render the same callback page
- Vercel SPA rewrite routes deep links to the application shell
- callback redirects with an absolute origin plus `/?account=...`
- illegal `useTMB()` Hook invocation was removed from the async OAuth callback
- callback persistence uses safe-storage fallback for Safari/Edge storage blocking
- the engine re-reads the token immediately before start/manual execution and
  reconnects when the token/account identity changes

Registered redirect URLs remain deployment configuration and must exactly match
the actual deployed hostname:

- `https://<your-domain>/callback`
- `https://<your-domain>/oauth/callback`

A live third-party OAuth exchange cannot be proven from a local archive without
the real deployed domain, Deriv app registration, account ID and user login. The
code path and build are verified; production OAuth must still be smoke-tested on
the deployed hostname.

## Chart audit

Fixed:

- removed per-render diagnostic object logging
- wired SmartChart forget callbacks instead of no-op callbacks
- unsubscribes chart RxJS subscriptions and forgets streams on unmount
- preserves market-closed fallback behavior without throwing

The production build includes the SmartChart assets and completed successfully.

## Exposure / execution audit

Fixed a release-blocking accounting defect:

- open exposure was recorded as `stake × multiplier`
- close exposure previously subtracted only `stake`
- runtime now stores and releases the exact opening notional

Manual execution remains product-family aware and auth-gated. No-auth mode is
signals/virtual-only; authenticated mode is live-capable.

## Files added

- `src/ai/engine/no-repaint-guard.ts`
- `src/ai/engine/deterministic-random.ts`
- `src/ai/engine/__tests__/no-repaint-guard.test.ts`
- `src/ai/engine/__tests__/look-ahead-audit.test.ts`
- `src/ai/engine/__tests__/determinism.test.ts`
- `src/ai/engine/__tests__/no-repaint-regression.test.ts`
- `PRODUCTION_AUDIT_v5.5.5.md`

## Files updated

- `src/ai/engine/index.ts` equivalent public barrel: `src/ai/index.ts`
- `src/ai/lifecycle/deriv-client.ts`
- `src/ai/lifecycle/orchestrator.ts`
- `src/ai/scanner/market-scanner.ts`
- `src/ai/burst/burst-detector.ts`
- `src/ai/burst/gap-detector.ts`
- `src/ai/burst/atr-adaptive-buffer.ts`
- `src/ai/edge/simulator.ts`
- `src/components/twk-overlay/engine-boot.ts`
- `src/pages/chart/chart.tsx`
- `src/pages/callback/callback-page.tsx`
- `src/utils/auth-utils.ts`
- `.env.example`

## Deployment checklist

1. Set the real `DERIV_APP_ID` and `DERIV_ACCOUNT_ID` in the deployment provider.
2. Use the correct new-API/legacy pairing described in `OAUTH_DEPLOY_NOTES.md`.
3. Register the exact deployed-domain callback URLs in the Deriv app portal.
4. Deploy the archive and verify `/`, `/callback`, and `/oauth/callback` directly.
5. Verify chart loading and symbol switching while watching active subscriptions.
6. Verify no-auth mode does not place real orders.
7. Verify demo-account auto-trade with a minimal stake before real funds.
8. Confirm a manual order is rejected when `authToken` is absent.
9. Confirm stop/kill-switch closes or safely manages open positions.
10. Monitor the no-repaint diagnostics and skipped-forming-bar logs after rollout.

## Release conclusion

The repository has a green production Rsbuild build, all repository tests pass,
and the requested no-repaint/look-ahead/determinism/regression protections are
integrated and verified locally. The archive is deployment-ready from the code
and build perspective. Third-party Deriv OAuth and real-order behavior still
require the final live smoke test against the user's actual domain/app/account;
that cannot be simulated honestly from the source archive alone.
