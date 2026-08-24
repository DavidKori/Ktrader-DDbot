/**
 * Market Router
 * -------------
 * Single source of truth for "which engine handles this symbol".
 *
 *   frx*           -> forex engine (multipliers)
 *   R_*, 1HZ*, etc -> binary engine (CALL/PUT/digit)
 *   BOOM and CRASH symbols -> binary engine (with built-in spike bias)
 *
 * Also exposes the per-engine knobs (Deriv multiplier for forex, default
 * duration ticks for binary) so that other modules don't hard-code them.
 */
import { getSymbolKind, getSymbolMeta } from '../../constants/all-symbols';
import { isSpikeIndex }                  from '../../constants/synthetic-symbols';

export type MarketKind = 'forex' | 'binary';

export interface RoutingResult {
    kind: MarketKind;
    /** Deriv multiplier for forex (for example 10, 30, 100); irrelevant for binary. */
    forexMultiplier: number;
    /** Default duration ticks for binary contracts; planner usually overrides this. */
    binaryDefaultDurationTicks: number;
    /** True for Boom/Crash markets where a bias is hard-coded. */
    isSpike: boolean;
    rationale: string;
}

export const FOREX_DEFAULT_MULTIPLIER = 100;
export const BINARY_DEFAULT_DURATION_TICKS = 5;

export const routeMarket = (symbol: string): RoutingResult => {
    const kindRaw = getSymbolKind(symbol);
    if (kindRaw === 'unknown') {
        throw new Error(`MarketRouter: unknown symbol "${symbol}"`);
    }
    const meta = getSymbolMeta(symbol)!;
    const kind: MarketKind = kindRaw === 'forex' ? 'forex' : 'binary';
    const isSpike = kind === 'binary' && isSpikeIndex(symbol);
    return {
        kind,
        forexMultiplier: kind === 'forex' ? FOREX_DEFAULT_MULTIPLIER : 0,
        binaryDefaultDurationTicks: BINARY_DEFAULT_DURATION_TICKS,
        isSpike,
        rationale: `router: ${symbol} -> ${kind}${isSpike ? ' (spike)' : ''} | ${meta.display}`,
    };
};

/** Group an arbitrary symbol list into forex + binary buckets. */
export const splitByKind = (symbols: string[]): { forex: string[]; binary: string[] } => {
    const forex: string[] = [], binary: string[] = [];
    for (const s of symbols) {
        try {
            const r = routeMarket(s);
            (r.kind === 'forex' ? forex : binary).push(s);
        } catch { /* ignore unknown */ }
    }
    return { forex, binary };
};
