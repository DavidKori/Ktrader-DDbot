# DDBOt v5.6.0 — Strategy Expectancy / Edge / Overtrading Audit

Date: 2026-08-12

## Scope and safety

This pass is an offline deterministic simulation only. No live or demo trades were placed. The harness is `edge_audit_sim.py` in the audit workspace and uses seed `20260812`, 12,000 synthetic observations, 8,000 in-sample observations, and 4,000 untouched out-of-sample observations.

Assumptions used by the harness: binary-style payout `+0.80` on a win, `-1.00` on a loss, and a per-trade cost of `0.02`. These are simulation assumptions, not Deriv execution guarantees. The real proposal/payout and contract-specific costs must be used for a production historical replay.

## Parameters audited

| Area | Previous | v5.6.0 | Reason |
|---|---:|---:|---|
| Live confidence floor | 75% | 85% | Removes marginal signals |
| Live validation floor | 70 | 80 | Raises quality requirement |
| Martingale confidence | 95% | 95% | Retained |
| Martingale validation | 85 | 90 | Tightened; martingale remains restricted |
| Expectancy minimum samples | 20 | 40 | Reduces small-sample luck |
| Expectancy minimum PF | 1.05 | 1.50 | Requires measured edge |
| Expectancy minimum per-trade edge | $0.05 | $0.05 | Retained |
| Expectancy minimum win rate | 50% | 55% | Adds robustness filter |
| Burst max positions | 5 | 10 | Only a hard upper ceiling |
| Bulk eligibility | confidence/balance only | PF >= 1.50, expectancy >= $0.05, WR >= 55%, n >= 40, confidence >= 0.90 | Prevents confidence-only bulk trading |
| Non-bulk concurrent cap | confidence/balance tiers up to 12 | 1 | Prevents unmeasured parallel exposure |
| Hourly trades | 10 | 10 | Retained |
| Daily trades | 50 | 50 | Retained |
| Total exposure | 10% in ExposureTracker | 10% | Retained |
| Per-symbol exposure | 5% | 5% | Retained |
| Same-symbol cooldown | 8 seconds | 8 seconds | Retained |
| Daily drawdown | 5% | 5% | Retained |
| Risk-engine consecutive-loss breaker | 3 | 3 | Retained |
| Kill switch consecutive-loss breaker | 4 | 4 | Retained |

## Expectancy math audit

The production `ExpectancyGate` computes:

`E = winRate × avgWin − lossRate × avgLoss`

and `PF = grossWins / grossLosses`, using realized recorded PnL. The gate now requires 40 samples, PF >= 1.50, expectancy >= $0.05, and win rate >= 55% before live eligibility. The harness used the same realized-PnL convention with explicit payout and cost assumptions.

The existing gate is only as good as the closed-trade journal feeding `record()`. It does not prove future edge; it measures rolling historical edge. The current audit therefore treats the PF gate as a risk filter, not a profitability guarantee.

## Harness run output

Exact output from the deterministic run:

```text
SIM_CONFIG {"seed": 20260812, "n": 12000, "train": 8000, "test": 4000, "payout": 0.8, "cost": 0.02, "stake": 1.0}
THRESH 0.75 TRAIN_BASE n=1537 wr=0.6545 avg=0.1581 pf=1.4488 eq=243.06 dd=9.78 maxcl=7
THRESH 0.75 TEST_BASE n=768 wr=0.6406 avg=0.1331 pf=1.3632 eq=102.24 dd=12.84 maxcl=6
THRESH 0.80 TRAIN_BASE n=788 wr=0.6827 avg=0.2089 pf=1.6456 eq=164.64 dd=8.22 maxcl=6
THRESH 0.80 TEST_BASE n=409 wr=0.6406 avg=0.1331 pf=1.3629 eq=54.42 dd=10.74 maxcl=5
THRESH 0.85 TRAIN_BASE n=356 wr=0.7051 avg=0.2491 pf=1.8280 eq=88.68 dd=8.22 maxcl=4
THRESH 0.85 TEST_BASE n=199 wr=0.6884 avg=0.2192 pf=1.6898 eq=43.62 dd=6.36 maxcl=6
THRESH 0.90 TRAIN_BASE n=166 wr=0.7349 avg=0.3029 pf=2.1203 eq=50.28 dd=4.80 maxcl=4
THRESH 0.90 TEST_BASE n=73 wr=0.7260 avg=0.2868 pf=2.0265 eq=20.94 dd=3.30 maxcl=3
current TRAIN_GATE n=1462 wr=0.6532 avg=0.1558 pf=1.4404 eq=227.76 dd=9.78 maxcl=7
current TEST_GATE n=596 wr=0.6460 avg=0.1428 pf=1.3953 eq=85.08 dd=12.84 maxcl=6
strict_pf15 TRAIN_GATE n=505 wr=0.6911 avg=0.2240 pf=1.7108 eq=113.10 dd=8.58 maxcl=6
strict_pf15 TEST_GATE n=107 wr=0.6355 avg=0.1239 pf=1.3333 eq=13.26 dd=5.70 maxcl=4
strict_pf17 TRAIN_GATE n=245 wr=0.7347 avg=0.3024 pf=2.1176 eq=74.10 dd=9.06 maxcl=4
strict_pf17 TEST_GATE n=150 wr=0.6667 avg=0.1800 pf=1.5294 eq=27.00 dd=6.54 maxcl=5
high_conf_pf15 TRAIN_GATE n=175 wr=0.7371 avg=0.3069 pf=2.1445 eq=53.70 dd=3.42 maxcl=3
high_conf_pf15 TEST_GATE n=118 wr=0.6864 avg=0.2156 pf=1.6741 eq=25.44 dd=6.36 maxcl=6
CHOSEN_TRAIN_GATE n=505 wr=0.6911 avg=0.2240 pf=1.7108 eq=113.10 dd=8.58 maxcl=6
CHOSEN_TEST_GATE n=184 wr=0.6304 avg=0.1148 pf=1.3045 eq=21.12 dd=10.74 maxcl=4
OVERTRADING_RAW n=409 wr=0.6406 avg=0.1331 pf=1.3629 eq=54.42 dd=10.74 maxcl=5
OVERTRADING_CONTROLLED n=81 wr=0.6296 avg=0.1133 pf=1.3000 eq=9.18 dd=4.14 maxcl=3
BOOTSTRAP_OOS runs=1000 n=184 p05=1.32 median=21.12 p95=40.92 positive_rate=0.959
```

## Interpretation

The 75% live gate is too permissive in this simulation: OOS PF was 1.3632 and OOS maximum drawdown was $12.84 per $1 stake-normalized run. The 85% cohort produced OOS PF 1.6898 and average PnL $0.2192 per trade, but the sample is smaller and the maximum loss streak was still 6. The 90% cohort produced the strongest OOS PF, 2.0265, with 73 trades; however, its smaller sample makes it less suitable as the only production gate.

The selected production rule is therefore deliberately mixed: the engine requires the higher 85/80 signal-quality gate, and the rolling measured-edge gate requires 40 closed trades, PF >= 1.50, expectancy >= $0.05, and WR >= 55%. Bulk concurrency is additionally restricted to confidence >= 0.90 and the same measured-edge requirements.

The selected walk-forward gate did not preserve the in-sample PF: training gate PF was 1.7108, while the untouched OOS stateful gate was 1.3045. That is a direct overfitting warning. The implementation is safer because it reduces trading after deterioration, but this audit does not establish a guaranteed PF >= 1.50 in future data.

## Overtrading controls

Bulk mode can reach at most 10 positions, but only when the measured edge qualifies. Every candidate remains subject to:

- 10 trades/hour
- 50 trades/day
- 5% per-symbol exposure
- 10% total open exposure
- 8-second same-symbol cooldown
- 5% daily drawdown circuit breaker
- 3-loss risk breaker and 4-loss kill switch
- correlation/exposure accounting through `ExposureTracker`

In the simulation, unconstrained OOS high-confidence selection had 409 trades, PF 1.3629, expectancy $0.1331, drawdown $10.74, and maximum loss streak 5. The controlled batch path accepted 81 trades, PF 1.3000, expectancy $0.1133, drawdown $4.14, and maximum loss streak 3. The controls reduced activity by 80.2% and drawdown by 61.5%; they did not improve PF in this run, which is why concurrency is treated as exposure management, not as an edge generator.

## Verification

- New API audit: passed; no active legacy transport markers.
- Production build: passed.
- Jest: 19 suites passed, 133 tests passed.
- No live or demo trades were placed during this audit.
