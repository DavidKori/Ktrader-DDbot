/**
 * Gap Detector — v5.4
 * ===================
 * Session-open / post-news gap detection.
 *
 *   - Compare current candle open to previous candle close.
 *   - Deviation > k × ATR(14) → flag as gap event.
 *   - Suspend wick-based entries for `cooldownCandles` candles.
 *   - Resume when subsequent candle ranges normalise (< ATR percentile 75).
 *
 * v5.5.5 NO-REPAINT: this detector reads `candles[len-1].open` and compares it
 * against `atrOf(candles.slice(0,-1))`. With a forming last bar the "gap" was
 * measured from a bar that had not closed, so a gap could be flagged and then
 * un-flagged within the same bar — toggling `allowEntries` mid-bar. The series
 * is now guarded to closed bars only before any comparison.
 */
import { closedBarsOnly } from '../engine/no-repaint-guard';

export interface GapCandle {
    open: number; high: number; low: number; close: number; epoch: number;
}

export interface GapConfig {
    gapMultiplier: number;      // k × ATR to flag
    cooldownCandles: number;    // pause after gap
    normalizeAtrPct: number;    // require range < this % of recent ATR to resume
}

export const DEFAULT_GAP_CFG: GapConfig = {
    gapMultiplier: 3.0,
    cooldownCandles: 5,
    normalizeAtrPct: 75,
};

function atrOf(cs: GapCandle[], n = 14): number {
    if (cs.length < n + 1) return NaN;
    const trs: number[] = [];
    for (let i = cs.length - n; i < cs.length; i++) {
        const c = cs[i], p = cs[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return trs.reduce((a, b) => a + b, 0) / n;
}

interface Book {
    inCooldown: boolean;
    cooldownRemaining: number;
    lastGapAt?: number;
}

export class GapDetector {
    private books = new Map<string, Book>();
    private cfg: GapConfig;

    constructor(cfg: Partial<GapConfig> = {}) {
        this.cfg = { ...DEFAULT_GAP_CFG, ...cfg };
    }

    /**
     * Feed the latest candle. Returns:
     *   - gapFlagged: true if THIS candle was flagged as a gap
     *   - allowEntries: false while in cooldown
     */
    update(
        symbol: string,
        rawCandles: GapCandle[],
        opts: { now?: number; timeframeSec?: number } = {},
    ): { gapFlagged: boolean; allowEntries: boolean; reason: string } {
        let b = this.books.get(symbol);
        if (!b) { b = { inCooldown: false, cooldownRemaining: 0 }; this.books.set(symbol, b); }

        // v5.5.5 no-repaint — idempotent guard (no-op if caller already guarded).
        const candles = closedBarsOnly(rawCandles, {
            now: opts.now,
            timeframeSec: opts.timeframeSec,
            label: symbol,
        });

        if (candles.length < 20) return { gapFlagged: false, allowEntries: !b.inCooldown, reason: 'warmup' };

        const cur = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const atr = atrOf(candles.slice(0, -1));   // ATR up to but not including current
        const deviation = Math.abs(cur.open - prev.close);
        const gap = isFinite(atr) && deviation > this.cfg.gapMultiplier * atr;

        if (gap && !b.inCooldown) {
            b.inCooldown = true;
            b.cooldownRemaining = this.cfg.cooldownCandles;
            b.lastGapAt = cur.epoch;
            return { gapFlagged: true, allowEntries: false, reason: `GAP ${deviation.toFixed(5)} > ${(this.cfg.gapMultiplier * atr).toFixed(5)}` };
        }
        if (b.inCooldown) {
            b.cooldownRemaining -= 1;
            // Check for normalisation
            const range = cur.high - cur.low;
            const normalised = isFinite(atr) && range < (this.cfg.normalizeAtrPct / 100) * atr * 1.5;
            if (b.cooldownRemaining <= 0 && normalised) {
                b.inCooldown = false;
                return { gapFlagged: false, allowEntries: true, reason: 'gap cooldown ended' };
            }
            return { gapFlagged: false, allowEntries: false, reason: `gap cooldown (${b.cooldownRemaining})` };
        }
        return { gapFlagged: false, allowEntries: true, reason: 'clear' };
    }

    inCooldown(symbol: string): boolean {
        return this.books.get(symbol)?.inCooldown ?? false;
    }
}
