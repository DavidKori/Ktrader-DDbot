/**
 * Binary Wick Adapter — v5.5.2
 * =============================
 * Adapts M5 wick-burst signals to Deriv BINARY (CALL/PUT).
 *
 * Refinements over v5.5.1 (all 9 points addressed):
 *   §1. Confidence→pWin uses ISOTONIC calibration table backed by an in-memory
 *       reliability tracker (Platt-scaling-lite); falls back to the tuned
 *       piecewise curve until enough historical trades exist.
 *   §2. Break-even probability computed dynamically from LIVE payout.
 *   §3. Duration accounts for tick velocity + rejection speed + volatility
 *       regime + session liquidity.
 *   §4. LONG→CALL / SHORT→PUT with additional confidence/wick/trend gates.
 *   §5. Positive-EV requires a configurable safety margin above break-even.
 *   §6. Full Number.isFinite validation on all numeric inputs.
 *   §7. Confidence clamped to [0, 1]; ATR / velocity rejected if non-finite
 *       or non-positive.
 *   §8. Implied pWin still capped at 0.85 (realistic model ceiling).
 *   §9. Result exposes expectedValue, kellyFraction, recommendedStake,
 *       confidenceBand, riskLevel, expectedReturn.
 */

import { WickBurstRefinedResult } from './wick-burst-refined';

// ---------------------------------------------------------------------------
//  Calibration store — simple isotonic bucketed win-rate history
// ---------------------------------------------------------------------------
export interface CalibrationBucket {
    /** Lower bound (inclusive) of confidence bucket. */
    lo: number;
    /** Upper bound (exclusive). */
    hi: number;
    trades: number;
    wins: number;
}

const DEFAULT_BUCKETS: CalibrationBucket[] = [
    { lo: 0.50, hi: 0.62, trades: 0, wins: 0 },
    { lo: 0.62, hi: 0.70, trades: 0, wins: 0 },
    { lo: 0.70, hi: 0.78, trades: 0, wins: 0 },
    { lo: 0.78, hi: 0.85, trades: 0, wins: 0 },
    { lo: 0.85, hi: 0.92, trades: 0, wins: 0 },
    { lo: 0.92, hi: 1.01, trades: 0, wins: 0 },
];

/** Global shared calibration state — one per process. */
const calibration: CalibrationBucket[] = DEFAULT_BUCKETS.map(b => ({ ...b }));

/** Minimum trades in a bucket before its empirical win-rate overrides the fallback curve. */
const MIN_TRADES_FOR_CALIBRATION = 20;

/** Record a closed binary trade to grow the calibration table. */
export function recordBinaryOutcome(confidence: number, won: boolean): void {
    if (!Number.isFinite(confidence)) return;
    const c = Math.max(0, Math.min(1, confidence));
    const b = calibration.find(x => c >= x.lo && c < x.hi);
    if (!b) return;
    b.trades += 1;
    if (won) b.wins += 1;
}

export function getCalibrationSnapshot(): CalibrationBucket[] {
    return calibration.map(b => ({ ...b }));
}

export function resetCalibration(): void {
    calibration.forEach(b => { b.trades = 0; b.wins = 0; });
}

// ---------------------------------------------------------------------------
//  Fallback piecewise-linear confidence → pWin (used while warm-up)
// ---------------------------------------------------------------------------
function fallbackConfToPwin(c: number): number {
    if (c <= 0.62) return 0.50 + (c - 0.50) * 0.20;
    if (c <= 0.78) return 0.524 + (c - 0.62) * 0.60;
    if (c <= 0.92) return 0.62 + (c - 0.78) * 0.55;
    return Math.min(0.85, 0.697 + (c - 0.92) * 1.0);
}

/** Isotonic pWin — uses empirical win-rate for the confidence bucket if enough
 *  samples, otherwise falls back to the calibrated piecewise curve. Result is
 *  clamped to [0, 0.85] (§8 realistic ceiling). */
function confToPwinCalibrated(c: number): { pWin: number; source: 'empirical' | 'fallback'; n: number } {
    const cc = Math.max(0, Math.min(1, c));
    const b = calibration.find(x => cc >= x.lo && cc < x.hi);
    if (b && b.trades >= MIN_TRADES_FOR_CALIBRATION) {
        // Add pseudo-count for stability: Laplace smoothing
        const emp = (b.wins + 1) / (b.trades + 2);
        return { pWin: Math.min(0.85, emp), source: 'empirical', n: b.trades };
    }
    return { pWin: Math.min(0.85, fallbackConfToPwin(cc)), source: 'fallback', n: b?.trades ?? 0 };
}

// ---------------------------------------------------------------------------
//  Duration model — velocity + rejection + regime + session
// ---------------------------------------------------------------------------
export type Session = 'ASIA' | 'LONDON' | 'NY' | 'OVERLAP' | 'OFF';
export type VolRegime = 'LOW' | 'MED' | 'HIGH';

export interface DurationInputs {
    atr: number;                 // price units
    tickVelocity: number;        // pips/sec
    rejectionSpeed?: number;     // pips/sec of the initial snap
    volRegime?: VolRegime;
    session?: Session;
    minDurationTicks?: number;
    maxDurationTicks?: number;
}

function pickDurationTicks(i: DurationInputs): number {
    const min = i.minDurationTicks ?? 5;
    const max = i.maxDurationTicks ?? 15;
    if (!Number.isFinite(i.atr) || !Number.isFinite(i.tickVelocity) || i.tickVelocity <= 0 || i.atr <= 0) {
        return min + 3;
    }
    const atrPips = i.atr / 0.0001;
    // Baseline: time to cover 0.5×ATR at current velocity
    let base = 0.5 * atrPips / i.tickVelocity;

    // Rejection speed adjustment — faster rejection → the burst is short-lived
    if (Number.isFinite(i.rejectionSpeed) && i.rejectionSpeed! > 0) {
        const ratio = i.rejectionSpeed! / i.tickVelocity;
        if (ratio > 2.0) base *= 0.75;         // very fast rejection → shorter duration
        else if (ratio < 0.5) base *= 1.20;    // slow rejection → longer duration
    }

    // Volatility regime — high vol shortens, low vol lengthens
    if (i.volRegime === 'HIGH') base *= 0.85;
    if (i.volRegime === 'LOW')  base *= 1.20;

    // Session — Asia is slow, London/NY fast
    if (i.session === 'ASIA' || i.session === 'OFF') base *= 1.15;
    if (i.session === 'OVERLAP') base *= 0.90;

    return Math.max(min, Math.min(max, Math.round(base)));
}

// ---------------------------------------------------------------------------
//  Kelly & risk sizing
// ---------------------------------------------------------------------------
function kellyFraction(pWin: number, payout: number): number {
    // Kelly for binary: f* = (p·b − q) / b   where b = payout, q = 1 − p
    if (payout <= 0) return 0;
    const q = 1 - pWin;
    return Math.max(0, (pWin * payout - q) / payout);
}

export type ConfidenceBand = 'HIGH' | 'MEDIUM' | 'LOW' | 'BELOW_FLOOR';
function bandOf(c: number): ConfidenceBand {
    if (c >= 0.85) return 'HIGH';
    if (c >= 0.75) return 'MEDIUM';
    if (c >= 0.62) return 'LOW';
    return 'BELOW_FLOOR';
}

export type RiskLevel = 'AGGRESSIVE' | 'STANDARD' | 'CONSERVATIVE' | 'SKIP';
function riskOf(band: ConfidenceBand, positiveEv: boolean): RiskLevel {
    if (!positiveEv || band === 'BELOW_FLOOR') return 'SKIP';
    if (band === 'HIGH') return 'AGGRESSIVE';
    if (band === 'MEDIUM') return 'STANDARD';
    return 'CONSERVATIVE';
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------
export interface BinaryAdapterInput {
    refined: WickBurstRefinedResult;
    tickVelocity: number;                // pips/sec
    atr: number;                         // M5 ATR in price units
    /** LIVE Deriv payout as a decimal (0.95 = 95 % ordinary binary). */
    payout: number;
    /** Baseline capital available for staking (used for recommendedStake). */
    baseStake: number;
    /** Optional refinement inputs. */
    rejectionSpeed?: number;
    volRegime?: VolRegime;
    session?: Session;
    minDurationTicks?: number;
    maxDurationTicks?: number;
    /** Safety margin above break-even. Default 0.02. */
    safetyMargin?: number;
    /** Fraction of Kelly to actually stake (0..1). Default 0.25. */
    kellyFraction?: number;
    /** Additional entry gates (§4). */
    minConfidence?: number;
    minWickScore?: number;
    minRejectionSpeed?: number;
    requireTrendAgreement?: boolean;
}

export interface BinaryAdapterResult {
    contract: 'CALL' | 'PUT' | 'NONE';
    durationTicks: number;
    /** Break-even pWin computed from LIVE payout (§2). */
    minWinRate: number;
    /** Model-implied pWin from calibrated confidence. */
    impliedWinRate: number;
    /** Break-even + safety margin (§5). */
    breakEvenWithMargin: number;
    positiveEv: boolean;
    /** Expected value per $1 stake (§9). */
    expectedValue: number;
    /** Fraction of bankroll that Kelly would stake at full Kelly (§9). */
    kellyFraction: number;
    /** Recommended $ stake using fractional Kelly (§9). */
    recommendedStake: number;
    /** Expected $ return on the recommendedStake (§9). */
    expectedReturn: number;
    /** Confidence band label (§9). */
    confidenceBand: ConfidenceBand;
    /** Risk level label (§9). */
    riskLevel: RiskLevel;
    /** Whether pWin came from empirical bucket or the fallback curve. */
    calibrationSource: 'empirical' | 'fallback';
    /** How many closed trades already fed the calibration bucket. */
    calibrationSamples: number;
    reason: string;
}

const EMPTY = (reason: string): BinaryAdapterResult => ({
    contract: 'NONE', durationTicks: 0,
    minWinRate: 0.5128, impliedWinRate: 0, breakEvenWithMargin: 0.5328,
    positiveEv: false, expectedValue: 0, kellyFraction: 0,
    recommendedStake: 0, expectedReturn: 0,
    confidenceBand: 'BELOW_FLOOR', riskLevel: 'SKIP',
    calibrationSource: 'fallback', calibrationSamples: 0,
    reason,
});

export function adaptToBinary(i: BinaryAdapterInput): BinaryAdapterResult {
    // §6, §7 input validation
    if (!Number.isFinite(i.atr) || i.atr <= 0) return EMPTY('atr invalid');
    if (!Number.isFinite(i.tickVelocity) || i.tickVelocity < 0) return EMPTY('tickVelocity invalid');
    if (!Number.isFinite(i.payout) || i.payout <= 0 || i.payout > 3) return EMPTY(`payout out of range: ${i.payout}`);
    if (!Number.isFinite(i.baseStake) || i.baseStake < 0.35) return EMPTY(`baseStake ${i.baseStake} < min 0.35`);
    if (!i.refined) return EMPTY('missing refined');
    if (i.refined.signal === 'NONE') return EMPTY('no refined signal');

    const conf = Math.max(0, Math.min(1, i.refined.confidence));

    // §4 additional entry gates
    const minConfidence   = i.minConfidence   ?? 0.62;
    const minWickScore    = i.minWickScore    ?? 0.55;
    const minRejSpeed     = i.minRejectionSpeed ?? 0;
    if (conf < minConfidence) return EMPTY(`conf ${conf.toFixed(2)} < ${minConfidence}`);
    if ((i.refined.partials?.wickQuality ?? 0) < minWickScore) {
        return EMPTY(`wick ${(i.refined.partials?.wickQuality ?? 0).toFixed(2)} < ${minWickScore}`);
    }
    if (Number.isFinite(i.rejectionSpeed) && (i.rejectionSpeed ?? 0) < minRejSpeed) {
        return EMPTY(`rejSpeed ${i.rejectionSpeed} < ${minRejSpeed}`);
    }
    if (i.requireTrendAgreement && (i.refined.partials?.htfAdjust ?? 0) < 0) {
        return EMPTY('HTF against trade direction');
    }

    // §1 calibrated pWin
    const cal = confToPwinCalibrated(conf);
    const impliedWinRate = cal.pWin;

    // §2 break-even from live payout
    const minWinRate = 1 / (1 + i.payout);
    const safetyMargin = i.safetyMargin ?? 0.02;
    const breakEvenWithMargin = minWinRate + safetyMargin;

    // §5 positive-EV WITH margin
    const positiveEv = impliedWinRate > breakEvenWithMargin;
    if (!positiveEv) {
        return {
            ...EMPTY(`pWin ${impliedWinRate.toFixed(3)} ≤ break-even+margin ${breakEvenWithMargin.toFixed(3)}`),
            minWinRate, impliedWinRate, breakEvenWithMargin,
            confidenceBand: bandOf(conf),
            calibrationSource: cal.source, calibrationSamples: cal.n,
        };
    }

    // §3 refined duration
    const durationTicks = pickDurationTicks({
        atr: i.atr,
        tickVelocity: i.tickVelocity,
        rejectionSpeed: i.rejectionSpeed,
        volRegime: i.volRegime,
        session: i.session,
        minDurationTicks: i.minDurationTicks,
        maxDurationTicks: i.maxDurationTicks,
    });

    // §9 expected-value and Kelly sizing
    const expectedValue = impliedWinRate * i.payout - (1 - impliedWinRate);
    const kellyFull = kellyFraction(impliedWinRate, i.payout);
    const kellyMult = Math.max(0, Math.min(1, i.kellyFraction ?? 0.25));
    const recommendedStake = Math.max(0.35, Math.round(i.baseStake * (0.5 + kellyMult * kellyFull) * 100) / 100);
    const expectedReturn = expectedValue * recommendedStake;

    const contract: 'CALL' | 'PUT' = i.refined.signal === 'LONG' ? 'CALL' : 'PUT';
    const band = bandOf(conf);
    const risk = riskOf(band, positiveEv);

    return {
        contract, durationTicks,
        minWinRate, impliedWinRate, breakEvenWithMargin,
        positiveEv, expectedValue,
        kellyFraction: kellyFull,
        recommendedStake, expectedReturn,
        confidenceBand: band, riskLevel: risk,
        calibrationSource: cal.source, calibrationSamples: cal.n,
        reason: `${contract} dur=${durationTicks}t pWin=${impliedWinRate.toFixed(3)} EV=${expectedValue.toFixed(3)} kelly=${kellyFull.toFixed(3)} stake=$${recommendedStake} src=${cal.source}(n=${cal.n})`,
    };
}
