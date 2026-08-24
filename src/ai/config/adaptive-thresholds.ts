/**
 * Adaptive Thresholds — v5.2 (Priority 4)
 * ----------------------------------------
 * Static thresholds work in calm markets but choke in volatile ones (too
 * conservative) and over-trade in trending ones (too permissive). This module
 * adjusts the LIVE / MARTINGALE gates based on the rolling LIVE win rate.
 *
 *   Win rate >= 75 %  -> loosen by 5 points (more trades, model is hot)
 *   Win rate <= 55 %  -> tighten by 5 points (be selective, model is cold)
 *   Otherwise         -> use the centralized EXECUTION_THRESHOLDS as-is
 *
 * Bounds are CLAMPED so adaptation cannot push gates outside safe ranges:
 *   liveConfidence       : 70..85
 *   liveValidation       : 65..80
 *   martingaleConfidence : 92..98
 *   martingaleValidation : 80..92
 *
 * The base table still lives in execution-thresholds.ts; this layer ONLY
 * shifts the final numbers handed to the ExecutionEngine on each tick.
 */
import { EXECUTION_THRESHOLDS } from './execution-thresholds';

export interface AdaptiveBounds {
    liveConfidence:       [number, number];
    liveValidation:       [number, number];
    martingaleConfidence: [number, number];
    martingaleValidation: [number, number];
}

export const ADAPTIVE_BOUNDS: AdaptiveBounds = {
    liveConfidence:       [70, 85],
    liveValidation:       [65, 80],
    martingaleConfidence: [92, 98],
    martingaleValidation: [80, 92],
};

export interface AdaptiveThresholdInputs {
    /** Rolling LIVE win rate over last ~20 closed trades (0..1). */
    liveWinRate:    number;
    /** Sample size used to compute liveWinRate. Below 10 → no adaptation. */
    sampleSize:     number;
}

export interface AdaptiveThresholds {
    liveConfidence:       number;
    liveValidation:       number;
    martingaleConfidence: number;
    martingaleValidation: number;
    rationale:            string;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Returns the thresholds the ExecutionEngine should use THIS tick.
 * Below MIN_SAMPLE the base table is returned unchanged.
 */
export const computeAdaptiveThresholds = (i: AdaptiveThresholdInputs): AdaptiveThresholds => {
    const base = {
        liveConfidence:       EXECUTION_THRESHOLDS.liveConfidence,
        liveValidation:       EXECUTION_THRESHOLDS.liveValidation,
        martingaleConfidence: EXECUTION_THRESHOLDS.martingaleConfidence,
        martingaleValidation: EXECUTION_THRESHOLDS.martingaleValidation,
    };
    const MIN_SAMPLE = 10;
    if (i.sampleSize < MIN_SAMPLE) {
        return { ...base, rationale: `n=${i.sampleSize}<${MIN_SAMPLE} — base thresholds` };
    }
    let shift = 0;
    let label = 'neutral';
    if (i.liveWinRate >= 0.75)      { shift = -5; label = 'hot streak — loosen by 5'; }
    else if (i.liveWinRate <= 0.55) { shift = +5; label = 'cold streak — tighten by 5'; }
    return {
        liveConfidence:       clamp(base.liveConfidence       + shift, ...ADAPTIVE_BOUNDS.liveConfidence),
        liveValidation:       clamp(base.liveValidation       + shift, ...ADAPTIVE_BOUNDS.liveValidation),
        martingaleConfidence: clamp(base.martingaleConfidence + shift, ...ADAPTIVE_BOUNDS.martingaleConfidence),
        martingaleValidation: clamp(base.martingaleValidation + shift, ...ADAPTIVE_BOUNDS.martingaleValidation),
        rationale: `WR=${(i.liveWinRate*100).toFixed(0)}% n=${i.sampleSize} · ${label}`,
    };
};
