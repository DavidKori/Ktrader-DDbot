/**
 * Momentum Exhaustion Score — v5.4 weighted exit
 * ===============================================
 * Replaces boolean signal-list exit with a weighted score:
 *
 *   Exhaustion_Score = 0.25·RSI_Div + 0.20·MACD_Weak + 0.20·ADX_Decline
 *                    + 0.15·Vol_Contraction + 0.20·Sequential_Impulse_Decline
 *
 * Exit fires when score >= dynamic threshold (default = 70th percentile
 * of recent scores per symbol, or fallback 0.65).
 *
 * All sub-scores are 0..1. Weights are regime-aware via caller injection.
 */

export interface ExhaustionInput {
    /** Recent RSI values (chronological). Divergence = price higher-high but RSI lower-high. */
    rsiSeries: number[];
    priceHighs: number[];
    /** MACD histogram series (chronological). Weakening = descending abs values while position is profitable. */
    macdHist: number[];
    /** ADX values. Decline = current < 5-back. */
    adxSeries: number[];
    /** Recent volumes (or |Δclose| proxy). Contraction = current < 50 % of 20-avg. */
    volumeSeries: number[];
    /** Sequential candle impulses (|body|). Decline = last 3 sizes strictly decreasing. */
    candleBodies: number[];
    /** Direction of the position, +1 long / -1 short. */
    direction: 1 | -1;
    /** Regime-aware weights, else default equal-weighted. */
    weights?: {
        rsiDiv: number; macdWeak: number; adxDecline: number;
        volContract: number; seqImpulse: number;
    };
    threshold?: number;
}

export interface ExhaustionResult {
    score: number;
    threshold: number;
    exit: boolean;
    parts: {
        rsiDiv: number; macdWeak: number; adxDecline: number;
        volContract: number; seqImpulse: number;
    };
    reason: string;
}

const DEFAULT_WEIGHTS = { rsiDiv: 0.25, macdWeak: 0.20, adxDecline: 0.20, volContract: 0.15, seqImpulse: 0.20 };
const DEFAULT_THR = 0.65;

function last<T>(a: T[]): T { return a[a.length - 1]; }

function rsiDivergenceScore(rsi: number[], priceHighs: number[], dir: 1 | -1): number {
    if (rsi.length < 6 || priceHighs.length < 6) return 0;
    if (dir === 1) {
        const p = priceHighs.slice(-6);
        const r = rsi.slice(-6);
        const priceHH = p[p.length - 1] > Math.max(...p.slice(0, -1));
        const rsiHH  = r[r.length - 1] < Math.max(...r.slice(0, -1));
        return priceHH && rsiHH ? 1 : 0;
    } else {
        const p = priceHighs.slice(-6);   // lows for shorts
        const r = rsi.slice(-6);
        const priceLL = p[p.length - 1] < Math.min(...p.slice(0, -1));
        const rsiLL  = r[r.length - 1] > Math.min(...r.slice(0, -1));
        return priceLL && rsiLL ? 1 : 0;
    }
}

function macdWeakScore(hist: number[]): number {
    if (hist.length < 4) return 0;
    const s = hist.slice(-4).map(Math.abs);
    // Monotonically decreasing?
    let dec = 0;
    for (let i = 1; i < s.length; i++) if (s[i] < s[i - 1]) dec++;
    return dec / (s.length - 1);
}

function adxDeclineScore(adx: number[]): number {
    if (adx.length < 6) return 0;
    const cur = last(adx);
    const prev = adx[adx.length - 6];
    if (prev <= 0) return 0;
    const drop = (prev - cur) / prev;
    return Math.max(0, Math.min(1, drop / 0.25));
}

function volContractionScore(vol: number[]): number {
    if (vol.length < 20) return 0;
    const cur = last(vol);
    const avg = vol.slice(-20).reduce((a, b) => a + b, 0) / 20;
    if (avg <= 0) return 0;
    return Math.max(0, Math.min(1, 1 - cur / avg));
}

function seqImpulseDeclineScore(bodies: number[]): number {
    if (bodies.length < 4) return 0;
    const b = bodies.slice(-3).map(Math.abs);
    return b[0] > b[1] && b[1] > b[2] ? 1 : (b[0] > b[2] ? 0.5 : 0);
}

export function computeExhaustion(input: ExhaustionInput): ExhaustionResult {
    const w = input.weights ?? DEFAULT_WEIGHTS;
    const parts = {
        rsiDiv:      rsiDivergenceScore(input.rsiSeries, input.priceHighs, input.direction),
        macdWeak:    macdWeakScore(input.macdHist),
        adxDecline:  adxDeclineScore(input.adxSeries),
        volContract: volContractionScore(input.volumeSeries),
        seqImpulse:  seqImpulseDeclineScore(input.candleBodies),
    };
    const score = w.rsiDiv * parts.rsiDiv + w.macdWeak * parts.macdWeak +
                  w.adxDecline * parts.adxDecline + w.volContract * parts.volContract +
                  w.seqImpulse * parts.seqImpulse;
    const threshold = input.threshold ?? DEFAULT_THR;
    const exit = score >= threshold;
    return {
        score, threshold, exit, parts,
        reason: exit
            ? `exhaustion ${score.toFixed(2)} ≥ ${threshold.toFixed(2)} · rsi=${parts.rsiDiv} macd=${parts.macdWeak.toFixed(2)} adx=${parts.adxDecline.toFixed(2)} vol=${parts.volContract.toFixed(2)} imp=${parts.seqImpulse}`
            : `no exhaustion ${score.toFixed(2)} < ${threshold.toFixed(2)}`,
    };
}
