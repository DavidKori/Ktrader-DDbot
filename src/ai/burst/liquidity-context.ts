/**
 * Liquidity Context — v5.5 (M5 refinement §2)
 * ============================================
 * Counts how many meaningful liquidity zones the current wick has swept.
 * Each hit adds to a confluence score in [0, 1]. NOT all zones are required —
 * this is additive: more confluence = higher confidence.
 *
 * Zones evaluated (all data must be available up to time t):
 *   - Previous M5 swing highs / lows (last 20 bars)
 *   - Previous M15 swing highs / lows (last 20 bars)
 *   - Session high / low (rolling 24 h)
 *   - Previous day high / low
 *   - Equal highs / lows (within k × ATR tolerance)
 *   - Detected order-block levels (last strong M15 candle body edge)
 *   - Fair-value-gap edges (M15 3-candle imbalances)
 *
 * "Swept" means the current wick extreme printed at or beyond the level.
 */

export interface Candle { high: number; low: number; open: number; close: number; epochMs: number; }

export interface LiquidityInput {
    side: 'LONG' | 'SHORT';
    wickExtreme: number;             // low-so-far for LONG, high-so-far for SHORT
    m5Bars: Candle[];                // chronological, closed only
    m15Bars: Candle[];               // chronological, closed only
    /** Rolling 24h high/low (optional; if omitted, we compute from m5Bars). */
    sessionHigh?: number;
    sessionLow?: number;
    /** Previous day high/low (optional). */
    prevDayHigh?: number;
    prevDayLow?: number;
    /** Equal-level tolerance in ATR fractions (default 0.05). */
    equalTolAtr?: number;
}

export interface LiquidityScore {
    score: number;    // 0..1 — sum of weighted hits, clamped
    hits: string[];   // human-readable list of matched zones
}

function atrOf(bars: Candle[], n = 14): number {
    if (bars.length < n + 1) return NaN;
    const trs: number[] = [];
    for (let i = bars.length - n; i < bars.length; i++) {
        const c = bars[i], p = bars[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return trs.reduce((a, b) => a + b, 0) / n;
}

function swings(bars: Candle[], side: 'LONG' | 'SHORT', win = 20): number[] {
    const out: number[] = [];
    if (bars.length < 5) return out;
    const start = Math.max(2, bars.length - win);
    for (let i = start; i < bars.length - 1; i++) {
        const c = bars[i];
        if (side === 'LONG') {
            // swing low: lower than 2 bars on each side
            if (c.low < bars[i - 1].low && c.low < bars[i - 2]?.low && c.low < bars[i + 1].low) out.push(c.low);
        } else {
            if (c.high > bars[i - 1].high && c.high > bars[i - 2]?.high && c.high > bars[i + 1].high) out.push(c.high);
        }
    }
    return out;
}

function orderBlocks(bars: Candle[], side: 'LONG' | 'SHORT'): number[] {
    // Last 3 M15 candles with body > 0.6 ATR — take the opposite-side edge
    if (bars.length < 20) return [];
    const atr = atrOf(bars);
    const out: number[] = [];
    for (let i = bars.length - 10; i < bars.length; i++) {
        const c = bars[i];
        const body = Math.abs(c.close - c.open);
        if (isFinite(atr) && body > 0.6 * atr) {
            out.push(side === 'LONG' ? Math.min(c.open, c.close) : Math.max(c.open, c.close));
        }
    }
    return out;
}

function fairValueGaps(bars: Candle[], side: 'LONG' | 'SHORT'): number[] {
    // 3-candle imbalance: bars[i-2].low > bars[i].high (bullish FVG) or reverse
    const out: number[] = [];
    if (bars.length < 5) return out;
    for (let i = bars.length - 15; i < bars.length; i++) {
        if (i < 2) continue;
        const a = bars[i - 2], c = bars[i];
        if (side === 'LONG' && a.low > c.high) out.push(c.high);        // bullish FVG lower edge
        if (side === 'SHORT' && a.high < c.low) out.push(c.low);
    }
    return out;
}

function equalLevels(bars: Candle[], side: 'LONG' | 'SHORT', tolAtr: number): number[] {
    if (bars.length < 5) return [];
    const atr = atrOf(bars);
    if (!isFinite(atr)) return [];
    const tol = atr * tolAtr;
    const extrema = bars.slice(-30).map(b => side === 'LONG' ? b.low : b.high);
    const equals: number[] = [];
    for (let i = 0; i < extrema.length; i++) {
        for (let j = i + 1; j < extrema.length; j++) {
            if (Math.abs(extrema[i] - extrema[j]) < tol) { equals.push(extrema[i]); break; }
        }
    }
    return equals;
}

export function scoreLiquidityContext(input: LiquidityInput): LiquidityScore {
    const atr5 = atrOf(input.m5Bars);
    if (!isFinite(atr5) || atr5 <= 0) return { score: 0, hits: [] };
    const proximity = atr5 * 0.15;   // "swept" if within 0.15 ATR of level
    const tolAtr = input.equalTolAtr ?? 0.05;
    const hits: string[] = [];
    let raw = 0;

    const check = (level: number, name: string, weight: number) => {
        if (input.side === 'LONG' && input.wickExtreme <= level + proximity && input.wickExtreme >= level - proximity) {
            hits.push(name); raw += weight;
        } else if (input.side === 'SHORT' && input.wickExtreme >= level - proximity && input.wickExtreme <= level + proximity) {
            hits.push(name); raw += weight;
        }
    };

    swings(input.m5Bars, input.side).forEach(l => check(l, 'M5 swing', 0.10));
    swings(input.m15Bars, input.side).forEach(l => check(l, 'M15 swing', 0.15));
    if (input.sessionHigh && input.side === 'SHORT') check(input.sessionHigh, 'session high', 0.15);
    if (input.sessionLow  && input.side === 'LONG')  check(input.sessionLow,  'session low',  0.15);
    if (input.prevDayHigh && input.side === 'SHORT') check(input.prevDayHigh, 'prev day high', 0.15);
    if (input.prevDayLow  && input.side === 'LONG')  check(input.prevDayLow,  'prev day low',  0.15);
    equalLevels(input.m5Bars, input.side, tolAtr).forEach(l => check(l, 'equal M5', 0.05));
    orderBlocks(input.m15Bars, input.side).forEach(l => check(l, 'M15 OB', 0.10));
    fairValueGaps(input.m15Bars, input.side).forEach(l => check(l, 'M15 FVG', 0.10));

    return { score: Math.max(0, Math.min(1, raw)), hits };
}
