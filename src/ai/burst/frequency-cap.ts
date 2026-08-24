/**
 * Frequency Cap — v5.4
 * ====================
 * Overtrading brake.
 *   - minCooldownSecPerSymbol   between two entries on the same symbol
 *   - maxTradesPerSessionSymbol per symbol per session
 *   - Regime-aware: tighter in chop, looser in clean trend
 */

export type Regime = 'TRENDING' | 'MEAN_REVERTING' | 'BREAKOUT' | 'COMPRESSION' | 'HIGH_VOL' | 'LOW_VOL' | 'UNKNOWN';

export interface FreqCapCfg {
    /** cooldown in seconds per regime */
    cooldownSec: Record<Regime, number>;
    /** max trades per calendar day per (symbol, regime) */
    maxPerDay: Record<Regime, number>;
}

export const DEFAULT_FREQ_CAP: FreqCapCfg = {
    cooldownSec: {
        TRENDING: 30, BREAKOUT: 30, MEAN_REVERTING: 120,
        COMPRESSION: 240, HIGH_VOL: 60, LOW_VOL: 300, UNKNOWN: 120,
    },
    maxPerDay: {
        TRENDING: 40, BREAKOUT: 40, MEAN_REVERTING: 20,
        COMPRESSION: 12, HIGH_VOL: 25, LOW_VOL: 10, UNKNOWN: 20,
    },
};

interface Book {
    lastEntryTs: number;
    dayCount: number;
    dayStamp: string;       // YYYY-MM-DD UTC
}

export class FrequencyCap {
    private books = new Map<string, Book>();
    private cfg: FreqCapCfg;

    constructor(cfg?: Partial<FreqCapCfg>) {
        this.cfg = { ...DEFAULT_FREQ_CAP, ...cfg };
    }

    private ymd(now: number): string {
        const d = new Date(now);
        return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
    }

    /** Check whether a new entry is allowed on this symbol in this regime. */
    allow(symbol: string, regime: Regime, now = Date.now()): { allow: boolean; reason: string } {
        const b = this.books.get(symbol);
        const today = this.ymd(now);
        const cooldown = this.cfg.cooldownSec[regime] ?? this.cfg.cooldownSec.UNKNOWN;
        const cap = this.cfg.maxPerDay[regime] ?? this.cfg.maxPerDay.UNKNOWN;

        if (!b) return { allow: true, reason: 'no history' };
        if (b.dayStamp !== today) return { allow: true, reason: 'new day (counter reset on record)' };
        const sinceLast = (now - b.lastEntryTs) / 1000;
        if (sinceLast < cooldown) return { allow: false, reason: `cooldown ${sinceLast.toFixed(0)}/${cooldown}s` };
        if (b.dayCount >= cap) return { allow: false, reason: `daily cap ${b.dayCount}/${cap}` };
        return { allow: true, reason: `ok (${b.dayCount}/${cap} today, ${sinceLast.toFixed(0)}s since last)` };
    }

    record(symbol: string, now = Date.now()): void {
        const today = this.ymd(now);
        let b = this.books.get(symbol);
        if (!b || b.dayStamp !== today) {
            b = { lastEntryTs: now, dayCount: 1, dayStamp: today };
            this.books.set(symbol, b);
            return;
        }
        b.lastEntryTs = now;
        b.dayCount += 1;
    }
}
