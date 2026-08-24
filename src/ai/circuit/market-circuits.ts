/**
 * Market-Condition Circuit Breakers — v5.2 (Priority 7)
 * ------------------------------------------------------
 * Pre-trade gate that vetoes entries when the market environment is unsafe:
 *
 *   • ATR spike   — current ATR > N × rolling-ATR median
 *   • Spread spike — spread (high-low of last candle) > maxSpread pips
 *   • News window — externally flagged high-impact news in progress
 *
 * News flagging is push-only (set via `setNewsActive(true)` from a UI
 * toggle or an external feed). We do NOT bake an HTTP news client into
 * the engine — that would add a third-party dependency and a leak vector.
 */
import type { IndicatorSnapshot } from '../engine/indicator-engine';

export interface MarketCircuitConfig {
    /** Multiple of rolling-median ATR that counts as a "volatility spike". */
    atrSpikeMultiple:    number;   // 2.5
    /** Pips of last-candle range that counts as a spread/liquidity spike. */
    maxCandleRangePips:  number;   // 60
    /** Minimum rolling history before ATR-spike gate is meaningful. */
    minHistoryBars:      number;   // 20
}

export const DEFAULT_CIRCUIT_CONFIG: MarketCircuitConfig = {
    atrSpikeMultiple:   2.5,
    maxCandleRangePips: 60,
    minHistoryBars:     20,
};

export interface CircuitVerdict {
    allowed: boolean;
    trips:   string[];     // empty if allowed
}

export class MarketCircuits {
    private newsActive = false;
    private atrHistory = new Map<string, number[]>();
    constructor(public cfg: MarketCircuitConfig = DEFAULT_CIRCUIT_CONFIG) {}

    /** Toggle the news flag from the UI or an external feed. */
    setNewsActive(active: boolean) { this.newsActive = active; }
    isNewsActive(): boolean { return this.newsActive; }

    /** Push the latest ATR for a symbol into the rolling window. */
    pushAtr(symbol: string, atr: number) {
        if (!Number.isFinite(atr) || atr <= 0) return;
        const hist = this.atrHistory.get(symbol) ?? [];
        hist.push(atr);
        if (hist.length > 100) hist.shift();
        this.atrHistory.set(symbol, hist);
    }

    /** Evaluate all circuits for a symbol. */
    evaluate(symbol: string, snap: IndicatorSnapshot, pip: number): CircuitVerdict {
        const trips: string[] = [];

        if (this.newsActive) trips.push('high-impact news window active');

        // ATR-spike circuit
        const hist = this.atrHistory.get(symbol) ?? [];
        if (hist.length >= this.cfg.minHistoryBars) {
            const sorted = hist.slice().sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            if (median > 0 && snap.atr > median * this.cfg.atrSpikeMultiple) {
                trips.push(
                    `ATR spike ${snap.atr.toFixed(5)} > ${this.cfg.atrSpikeMultiple}\u00d7 median ${median.toFixed(5)}`,
                );
            }
        }

        // Spread / liquidity spike (last-bar range proxy)
        if (snap.bollinger && Number.isFinite(snap.bollinger.upper) && Number.isFinite(snap.bollinger.lower)) {
            const rangePips = (snap.bollinger.upper - snap.bollinger.lower) / Math.max(pip, 1e-9);
            if (rangePips > this.cfg.maxCandleRangePips) {
                trips.push(
                    `range ${rangePips.toFixed(0)} pips > maxCandleRangePips ${this.cfg.maxCandleRangePips}`,
                );
            }
        }

        return { allowed: trips.length === 0, trips };
    }

    reset() {
        this.newsActive = false;
        this.atrHistory.clear();
    }
}
