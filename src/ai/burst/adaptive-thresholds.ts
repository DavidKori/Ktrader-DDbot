/**
 * Adaptive Thresholds — v5.4
 * ==========================
 * Replaces the static burst thresholds (v > 0.5, a > 0.15, VoA > 1.7)
 * with rolling per-symbol statistical thresholds:
 *
 *   - velocity threshold  = 90th percentile of last N velocity samples
 *   - accel  threshold    = 95th percentile of last N accel samples
 *   - VoA    threshold    = z-score > 2 (mean + 2·std of last N)
 *   - BB expansion score  = percentile-based (already relative)
 *
 * Per-symbol buffers keep it symbol-specific; fall back to conservative
 * static values while the sample size is small (< MIN_SAMPLES).
 */

export interface AdaptiveThresholds {
    velocity: number;
    acceleration: number;
    voa: number;
    samples: number;
    isWarmedUp: boolean;
}

const MIN_SAMPLES = 40;
const WINDOW = 200;
const FALLBACK_VELOCITY = 0.50;
const FALLBACK_ACCEL    = 0.15;
const FALLBACK_VOA      = 1.70;

interface Book {
    velocity: number[];
    accel: number[];
    voa: number[];
}

function pctile(xs: number[], p: number): number {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1))));
    return s[idx];
}

function meanStd(xs: number[]): { m: number; s: number } {
    if (!xs.length) return { m: 0, s: 0 };
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
    return { m, s: Math.sqrt(v) };
}

export class AdaptiveThresholdEngine {
    private books = new Map<string, Book>();

    /** Record a raw observation. Call every tick with the current v/a/VoA. */
    record(symbol: string, v: number, a: number, voa: number): void {
        let b = this.books.get(symbol);
        if (!b) { b = { velocity: [], accel: [], voa: [] }; this.books.set(symbol, b); }
        b.velocity.push(Math.abs(v)); if (b.velocity.length > WINDOW) b.velocity.shift();
        b.accel.push(Math.abs(a));    if (b.accel.length    > WINDOW) b.accel.shift();
        b.voa.push(voa);              if (b.voa.length      > WINDOW) b.voa.shift();
    }

    /** Get current adaptive thresholds for a symbol. */
    get(symbol: string): AdaptiveThresholds {
        const b = this.books.get(symbol);
        if (!b || b.velocity.length < MIN_SAMPLES) {
            return {
                velocity: FALLBACK_VELOCITY,
                acceleration: FALLBACK_ACCEL,
                voa: FALLBACK_VOA,
                samples: b?.velocity.length ?? 0,
                isWarmedUp: false,
            };
        }
        const vThr = Math.max(FALLBACK_VELOCITY * 0.6, pctile(b.velocity, 90));
        const aThr = Math.max(FALLBACK_ACCEL    * 0.6, pctile(b.accel,    95));
        const { m, s } = meanStd(b.voa);
        const voaThr = Math.max(1.3, m + 2 * s);
        return { velocity: vThr, acceleration: aThr, voa: voaThr, samples: b.velocity.length, isWarmedUp: true };
    }

    /** Compute normalized sub-scores (0..1) — for weighted confidence. */
    zScores(symbol: string, v: number, a: number, voa: number): { velocity: number; acceleration: number; voa: number } {
        const b = this.books.get(symbol);
        if (!b || b.velocity.length < MIN_SAMPLES) {
            return {
                velocity: Math.min(1, Math.abs(v) / 1.2),
                acceleration: Math.min(1, Math.abs(a) / 0.5),
                voa: Math.min(1, Math.max(0, (voa - 1) / 2)),
            };
        }
        const { m: mv, s: sv } = meanStd(b.velocity);
        const { m: ma, s: sa } = meanStd(b.accel);
        const { m: mvoa, s: svoa } = meanStd(b.voa);
        const zv = sv > 0 ? (Math.abs(v) - mv) / sv : 0;
        const za = sa > 0 ? (Math.abs(a) - ma) / sa : 0;
        const zvoa = svoa > 0 ? (voa - mvoa) / svoa : 0;
        // sigmoid → 0..1
        const sig = (x: number) => 1 / (1 + Math.exp(-x));
        return { velocity: sig(zv), acceleration: sig(za), voa: sig(zvoa) };
    }

    reset(symbol?: string): void {
        if (symbol) this.books.delete(symbol); else this.books.clear();
    }
}
