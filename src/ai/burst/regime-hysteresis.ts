/**
 * Regime Hysteresis — v5.4
 * ========================
 * Prevents whipsaw between regime states. A new regime is only ACTIVE
 * after N consecutive candles have classified it. Until then the caller
 * still sees the previous ACTIVE regime while the new one sits in
 * PENDING state.
 *
 * Rationale (from spec):
 *   "A regime switch is only acted upon after N consecutive candles
 *    (or a probability-weighted rolling classification) confirm the
 *    new regime — configurable minimum dwell time"
 */

export type Regime =
    | 'TRENDING' | 'MEAN_REVERTING' | 'BREAKOUT'
    | 'COMPRESSION' | 'HIGH_VOL' | 'LOW_VOL' | 'UNKNOWN';

interface Book {
    active: Regime;
    pending: Regime;
    pendingCount: number;
    lastSwitchTs: number;
}

export interface HysteresisConfig {
    confirmCandles: number;         // N candles to confirm switch
    minDwellMs: number;             // do not switch again for this long
}

export const DEFAULT_HYSTERESIS: HysteresisConfig = {
    confirmCandles: 3,
    minDwellMs: 3 * 60 * 1000,   // 3 minutes minimum between switches
};

export class RegimeHysteresis {
    private books = new Map<string, Book>();
    private cfg: HysteresisConfig;

    constructor(cfg: Partial<HysteresisConfig> = {}) {
        this.cfg = { ...DEFAULT_HYSTERESIS, ...cfg };
    }

    /**
     * Feed a raw classification. Returns the ACTIVE regime the caller
     * should use for decisions (may differ from the raw classification).
     */
    update(symbol: string, raw: Regime, now = Date.now()): { active: Regime; pending: Regime; changed: boolean } {
        let b = this.books.get(symbol);
        if (!b) {
            b = { active: raw, pending: raw, pendingCount: 0, lastSwitchTs: now };
            this.books.set(symbol, b);
            return { active: raw, pending: raw, changed: false };
        }
        // Same regime → reset pending
        if (raw === b.active) {
            b.pending = raw; b.pendingCount = 0;
            return { active: b.active, pending: b.pending, changed: false };
        }
        // Different regime — count consecutive
        if (raw === b.pending) {
            b.pendingCount += 1;
        } else {
            b.pending = raw;
            b.pendingCount = 1;
        }
        // Confirm switch?
        const dwellOk = (now - b.lastSwitchTs) >= this.cfg.minDwellMs;
        if (b.pendingCount >= this.cfg.confirmCandles && dwellOk) {
            const prev = b.active;
            b.active = b.pending;
            b.lastSwitchTs = now;
            b.pendingCount = 0;
            return { active: b.active, pending: b.pending, changed: true };
        }
        return { active: b.active, pending: b.pending, changed: false };
    }

    active(symbol: string): Regime | undefined {
        return this.books.get(symbol)?.active;
    }
}
