/**
 * Validation Engine
 * -----------------
 * Produces a single 0–100 **ValidationScore** that condenses six independent
 * signal-quality views into one number. The Execution Engine uses this score
 * (alongside fusion confidence and recent virtual win rate) to decide between
 * VIRTUAL and LIVE modes.
 *
 * Weights (sum = 1.0):
 *
 *   • Scanner quality score        ×0.25
 *   • Direction model (LightGBM)   ×0.20
 *   • Duration model strength      ×0.10
 *   • Volume analysis              ×0.15
 *   • Trend strength (ADX)         ×0.15
 *   • Regime cleanliness           ×0.15
 *
 * Output is a deterministic, side-effect-free function of inputs.
 */
import type { IndicatorSnapshot } from '../engine/indicator-engine';
import type { VolumeAnalysis }    from '../engine/adaptive-volume';
import type { MLPrediction }      from '../ml/lightgbm-client';
import type { MarketRegime }      from '../regime/market-regime';
import type { DurationPlan }      from '../duration/duration-model';
import { VALIDATION_FLOORS }      from '../config/execution-thresholds';

export interface ValidationInputs {
    snapshot: IndicatorSnapshot;
    volume:   VolumeAnalysis;
    ml:       MLPrediction;
    regime:   MarketRegime;
    duration: DurationPlan | null;
    /** Optional — scanner quality score for this symbol (0..100). */
    scannerQualityScore?: number;
}

export interface ValidationResult {
    score:      number;          // 0..100
    components: {
        scanner:    number;      // 0..100
        direction:  number;
        duration:   number;
        volume:     number;
        trend:      number;
        regime:     number;
    };
    /** True when score >= LIVE validation floor (70). Informational only;
     *  the ExecutionEngine uses VALIDATION_FLOORS.live directly. */
    isValid:    boolean;
    rationale:  string;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

const componentScannerScore = (s?: number): number =>
    typeof s === 'number' ? Math.max(0, Math.min(100, s)) : 50;

/** Direction component: |p - 0.5| × 200 — clean 0..100 conversion. */
const componentDirection = (ml: MLPrediction): number =>
    Math.min(100, Math.abs(ml.probability - 0.5) * 200);

/** Duration component: did we get a plan with sane SL:TP ratio? */
const componentDuration = (d: DurationPlan | null): number => {
    if (!d) return 30;
    const rr = d.takeProfitPips / Math.max(1, d.stopLossPips);
    // Best when 1.5 ≤ R:R ≤ 3.0
    if (rr < 1.0) return 25;
    if (rr < 1.5) return 50;
    if (rr <= 3.0) return 90;
    if (rr <= 4.0) return 70;
    return 55;
};

const componentVolume = (v: VolumeAnalysis): number => {
    switch (v.regime) {
        case 'institutional': return 95;
        case 'elevated':      return 78;
        case 'normal':        return 55;
        case 'dry':           return 25;
    }
};

const componentTrend = (snap: IndicatorSnapshot): number => {
    if (!Number.isFinite(snap.adx)) return 30;
    // ADX 25 = trending, 40 = strong trend, 50+ = extreme.
    // Map ADX∈[0,50] → score∈[0,100] but with a "sweet spot" peak around 30.
    const adx = Math.min(50, Math.max(0, snap.adx));
    if (adx < 15) return adx * 2;                        // 0..30
    if (adx < 25) return 30 + (adx - 15) * 4;            // 30..70
    if (adx < 40) return 70 + (adx - 25) * 2;            // 70..100
    return Math.max(60, 100 - (adx - 40) * 2);           // taper after 40 (too volatile)
};

const componentRegime = (regime: MarketRegime): number => {
    switch (regime) {
        case 'trending_bull':     return 90;
        case 'trending_bear':     return 90;
        case 'volatile_breakout': return 70;
        case 'mean_reverting':    return 65;
        case 'unknown':           return 35;
        case 'choppy_low_vol':    return 15;
    }
};

export const computeValidationScore = (i: ValidationInputs): ValidationResult => {
    const components = {
        scanner:   componentScannerScore(i.scannerQualityScore),
        direction: componentDirection(i.ml),
        duration:  componentDuration(i.duration),
        volume:    componentVolume(i.volume),
        trend:     componentTrend(i.snapshot),
        regime:    componentRegime(i.regime),
    };

    const score =
        components.scanner   * 0.25 +
        components.direction * 0.20 +
        components.duration  * 0.10 +
        components.volume    * 0.15 +
        components.trend     * 0.15 +
        components.regime    * 0.15;

    // v5.1: aligned with EXECUTION_THRESHOLDS.liveValidation (70).
    const isValid = score >= VALIDATION_FLOORS.live;
    const rationale =
        `validation=${score.toFixed(1)} ` +
        `[scan=${components.scanner.toFixed(0)} dir=${components.direction.toFixed(0)} ` +
        `dur=${components.duration.toFixed(0)} vol=${components.volume.toFixed(0)} ` +
        `trend=${components.trend.toFixed(0)} reg=${components.regime.toFixed(0)}]`;

    return { score, components, isValid, rationale };
};

/** Normalised 0..1 form of the validation score. */
export const validationConfidence = (r: ValidationResult): number => clamp01(r.score / 100);

export interface MarketStability {
    isStable: boolean;
    reason: string;
}

/**
 * High-level "is this market currently safe?" check used by the
 * Mode Selector's UNSTABLE_REGIME criterion.
 */
export const isMarketStable = (regime: MarketRegime, vol: VolumeAnalysis): MarketStability => {
    if (regime === 'choppy_low_vol') return { isStable: false, reason: 'choppy_low_vol regime' };
    if (regime === 'unknown')        return { isStable: false, reason: 'unknown regime' };
    if (vol.regime === 'dry')        return { isStable: false, reason: 'dry volume regime' };
    if (vol.zscore > 4)              return { isStable: false, reason: `volume shock z=${vol.zscore.toFixed(1)}` };
    return { isStable: true, reason: 'ok' };
};
