# AI configuration (v5.6.2-clean)

## Execution thresholds (confidence-score gate)

Config source: `src/ai/config/execution-thresholds.ts`. Values are **filters, not profit guarantees**;
they come from the reproducible walk-forward cohort audit that retained the highest
out-of-sample expectancy.

| Mode | Confidence | Validation | Action |
|---|---|---|---|
| `VIRTUAL` | < 85% | any | paper/shadow trade, learn |
| `LIVE` | ≥ 85% | ≥ 80 | real/virtual balance trade |
| `LIVE_MARTINGALE` | ≥ 95% | ≥ 90 | escalation band (kept tight by default) |

Additional gates that must all pass for a LIVE entry:

- **ExpectancyGate** (`src/ai/edge/expectancy-gate.ts`) — blocks LIVE when rolling
  win-rate/expectancy is below threshold; flips signals to SHADOW.
- **EdgeCostGate** (`src/ai/burst/edge-cost-gate.ts`) — `ExpectedR / cost ≥ ratio` (1.5 cold, 0.8 warmup).
- **Risk engine** (`src/ai/risk/risk-engine.ts`) — stake caps, daily-loss cap, open-contract cap
  (server-side: `MAX_STAKE`, `MAX_OPEN_CONTRACTS`, `MAX_DAILY_LOSS`).
- **Exposure caps are max-loss (stake) units since v5.6.2-clean**: Deriv multipliers
  stop out at 100% of stake, so exposure = stake, never stake × multiplier.
  Defaults: 10% of balance per symbol, 25% total. (`src/ai/config/exposure-controls.ts`)

## Market routing

`src/ai/router/market-router.ts` + `src/ai/constants/all-symbols.ts`:
- `frx*`, `XAU`, `XAG` → **forex/multiplier** engine (default multiplier 100, configurable via
  `FOREX_DEFAULT_MULTIPLIER`).
- `R_*`, `1HZ*`, `V*`, `BOOM*`, `CRASH*`, `stpRNG*`, `JD*`, `RD*` → **binary** engine
  (CALL/PUT/digit, default 5 ticks).

The AI pipeline fuses with Deriv via `src/ai/lifecycle/deriv-client.ts` (public WS for ticks,
authenticated OTP WS for orders) — see `docs/DERIV_WS_AUTH.md`.

## Simulation harness

`src/ai/__sim__/run-simulation.ts` (also run as a Jest regression test) executes the **real**
modules against synthetic win-rate scenarios to prove code correctness (binary payout 0.95x,
forex multiplier sizing). It does **not** claim real-world profitability.
