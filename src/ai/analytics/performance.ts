/**
 * Performance Analytics
 * ---------------------
 * Pure functions that compute trading-quality metrics from the trade
 * journal. No side effects, no state. Safe to call on every render.
 */
import type { JournalEntry } from '../journal/trade-journal';

export interface PerformanceMetrics {
    totalTrades:        number;
    closedTrades:       number;
    wins:               number;
    losses:             number;
    winRate:            number;   // 0..1
    profitFactor:       number;   // grossWin / |grossLoss|, ∞ if zero loss
    grossWin:           number;
    grossLoss:          number;
    netPnL:             number;
    avgTradePnL:        number;
    avgWin:             number;
    avgLoss:            number;
    maxDrawdown:        number;
    maxDrawdownPct:     number;
    longestWinStreak:   number;
    longestLossStreak:  number;
    /** Annualised-ish ROI vs a starting balance (set via opts.startingBalance). */
    roiPct:             number;
    /** Average hold time (seconds) for closed trades. */
    avgDurationSec:     number;
}

export interface PerformanceOptions {
    /** Filter to one execution mode if set. */
    mode?: JournalEntry['mode'];
    /** Used to compute ROI. Defaults to 100 (so % units come out clean). */
    startingBalance?: number;
}

const closed = (entries: JournalEntry[]): JournalEntry[] =>
    entries.filter(e => e.ts_close && typeof e.pnl === 'number');

export const computePerformance = (
    entries: JournalEntry[], opts: PerformanceOptions = {},
): PerformanceMetrics => {
    const startingBalance = opts.startingBalance ?? 100;
    const data = opts.mode ? entries.filter(e => e.mode === opts.mode) : entries;
    const cl   = closed(data);
    const wins:   JournalEntry[] = cl.filter(e => (e.pnl ?? 0) > 0);
    const losses: JournalEntry[] = cl.filter(e => (e.pnl ?? 0) < 0);

    const grossWin  = wins.reduce((s, e) => s + (e.pnl ?? 0), 0);
    const grossLoss = losses.reduce((s, e) => s + (e.pnl ?? 0), 0);   // negative number
    const netPnL    = grossWin + grossLoss;

    let peak = 0, equity = 0, maxDD = 0;
    let curWin = 0, curLoss = 0, longestWin = 0, longestLoss = 0;
    let totalDuration = 0;

    for (const e of cl) {
        equity += (e.pnl ?? 0);
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDD) maxDD = dd;

        if ((e.pnl ?? 0) > 0) { curWin++; curLoss = 0; if (curWin > longestWin) longestWin = curWin; }
        else                    { curLoss++; curWin = 0; if (curLoss > longestLoss) longestLoss = curLoss; }

        if (typeof e.durationSec === 'number') totalDuration += e.durationSec;
    }

    const avgWin  = wins.length   ? grossWin / wins.length   : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;
    const avgTrade = cl.length ? netPnL / cl.length : 0;

    const profitFactor = grossLoss === 0
        ? (grossWin > 0 ? Infinity : 0)
        : grossWin / Math.abs(grossLoss);

    const peakBalance = startingBalance + peak;
    const maxDDPct = peakBalance > 0 ? maxDD / peakBalance : 0;
    const roiPct = startingBalance > 0 ? netPnL / startingBalance : 0;

    return {
        totalTrades: data.length,
        closedTrades: cl.length,
        wins: wins.length,
        losses: losses.length,
        winRate: cl.length ? wins.length / cl.length : 0,
        profitFactor,
        grossWin, grossLoss, netPnL,
        avgTradePnL: avgTrade, avgWin, avgLoss,
        maxDrawdown: maxDD,
        maxDrawdownPct: maxDDPct,
        longestWinStreak: longestWin,
        longestLossStreak: longestLoss,
        roiPct,
        avgDurationSec: cl.length ? totalDuration / cl.length : 0,
    };
};

/** Per-symbol performance breakdown — useful for the analytics dashboard. */
export const performanceBySymbol = (entries: JournalEntry[]): Record<string, PerformanceMetrics> => {
    const out: Record<string, PerformanceMetrics> = {};
    const symbols = Array.from(new Set(entries.map(e => e.symbol)));
    for (const s of symbols) {
        out[s] = computePerformance(entries.filter(e => e.symbol === s));
    }
    return out;
};

/** Per-mode breakdown (VIRTUAL / LIVE / LIVE_MARTINGALE). */
export const performanceByMode = (entries: JournalEntry[]):
    Record<JournalEntry['mode'], PerformanceMetrics> => ({
        VIRTUAL:         computePerformance(entries, { mode: 'VIRTUAL' }),
        LIVE:            computePerformance(entries, { mode: 'LIVE' }),
        LIVE_MARTINGALE: computePerformance(entries, { mode: 'LIVE_MARTINGALE' }),
    });
