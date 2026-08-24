/**
 * Centralized Execution Thresholds — v5.1
 * ----------------------------------------
 * Single source of truth for the three-band mode selector.
 *
 *   Confidence < 85              -> VIRTUAL
 *   Confidence >= 85 AND
 *     Validation >= 80           -> LIVE
 *   Confidence >= 95 AND
 *     Validation >= 90           -> LIVE_MARTINGALE
 *
 * v5.6.0 edge audit: the previous 75/70 live gate admitted too many marginal
 * signals. The reproducible seeded walk-forward audit retained the 85+
 * confidence cohort because it had the best out-of-sample PF/expectancy among
 * tested cohorts. Live validation was raised to 80 and the martingale band was
 * tightened to 95/90. These are selection filters, not a guarantee of profit.
 *
 * IMPORTANT: All execution thresholds live HERE. Engines must import from
 * this module — no magic numbers anywhere else.
 *
 * Confidence values are 0..1 floats; validation values are 0..100 integers
 * (matching ValidationResult.score). This matches the user-facing wording
 * in the spec ("Confidence >= 75%" -> 0.75; "Validation >= 85" -> 85).
 */

export interface ExecutionThresholds {
    /** Confidence (0..1) floor to enter LIVE mode. Below this -> VIRTUAL. */
    liveConfidence: number;
    /** Validation score (0..100) floor to enter LIVE mode. */
    liveValidation: number;
    /** Confidence (0..1) floor to escalate to LIVE_MARTINGALE. */
    martingaleConfidence: number;
    /** Validation score (0..100) floor to escalate to LIVE_MARTINGALE. */
    martingaleValidation: number;
}

/**
 * Production thresholds — v5.1 FINAL.
 * Exposed as plain numbers (not 0..1 / 0..100 mixed) so configuration files,
 * env-vars, and documentation can reference them without ambiguity.
 *
 * NOTE: The shape matches the user's spec snippet exactly:
 *
 *     liveConfidence:       85
 *     liveValidation:       80
 *     martingaleConfidence: 95
 *     martingaleValidation: 90
 *
 * Internally the ExecutionEngine converts confidence to 0..1.
 */
export const EXECUTION_THRESHOLDS = {
    liveConfidence:       85,   // percent; audited high-confidence cohort
    liveValidation:       80,   // 0..100
    martingaleConfidence: 95,   // percent
    martingaleValidation: 90,   // 0..100; tightened, not recommended by default
} as const;

/** Helper: percent -> 0..1 float. */
export const pctToFloat = (pct: number): number => pct / 100;

/** Canonical 0..1 confidence floors derived from the percent constants. */
export const CONFIDENCE_FLOORS = {
    live:       pctToFloat(EXECUTION_THRESHOLDS.liveConfidence),       // 0.75
    martingale: pctToFloat(EXECUTION_THRESHOLDS.martingaleConfidence), // 0.95
} as const;

/** Canonical 0..100 validation floors. */
export const VALIDATION_FLOORS = {
    live:       EXECUTION_THRESHOLDS.liveValidation,       // 70
    martingale: EXECUTION_THRESHOLDS.martingaleValidation, // 85
} as const;

/**
 * Decision-table helper — exposed so UI / docs / tests can describe the
 * mode-selection logic without re-implementing it.
 */
export const describeMode = (
    confidencePct: number,
    validationScore: number,
): 'VIRTUAL' | 'LIVE' | 'LIVE_MARTINGALE' => {
    if (confidencePct >= EXECUTION_THRESHOLDS.martingaleConfidence &&
        validationScore >= EXECUTION_THRESHOLDS.martingaleValidation) {
        return 'LIVE_MARTINGALE';
    }
    if (confidencePct >= EXECUTION_THRESHOLDS.liveConfidence &&
        validationScore >= EXECUTION_THRESHOLDS.liveValidation) {
        return 'LIVE';
    }
    return 'VIRTUAL';
};
