/**
 * Market Regime Detector + Contract Router
 * ----------------------------------------
 * Decides WHICH Deriv contract to fire given indicator state + (now)
 * the LightGBM directional hint. No language-AI dependency.
 *
 * Routing thresholds have been LOOSENED so more signals fire in the
 * forex + binary universes — but every digit pick still requires
 * positive edge expectancy.
 */
import { IndicatorSnapshot } from '../engine/indicator-engine';
import { DigitDistribution, bestMatchDigit, bestOverUnder } from '../engine/digit-stats';
import { getSymbolKind, getSyntheticMeta } from '../../constants/all-symbols';

export type MarketRegime =
    | 'trending_bull' | 'trending_bear'
    | 'mean_reverting' | 'choppy_low_vol'
    | 'volatile_breakout' | 'unknown';

export const detectRegime = (snap: IndicatorSnapshot): { regime: MarketRegime; confidence: number } => {
    const { adx, ema_fast, ema_slow, bollinger, rsi: rsiVal, atr } = snap;
    if (!Number.isFinite(adx) || !Number.isFinite(ema_fast)) {
        return { regime: 'unknown', confidence: 0 };
    }

    // LOOSENED: ADX > 20 (was 25) → more "trending" classifications.
    const trendingUp   = adx > 20 && ema_fast > ema_slow;
    const trendingDown = adx > 20 && ema_fast < ema_slow;
    const flatBands    = bollinger.bandwidth < 0.012;       // tighter dead zone
    const wideBands    = bollinger.bandwidth > 0.035;
    const overbought   = rsiVal > 65;                       // was 70
    const oversold     = rsiVal < 35;                       // was 30

    if (trendingUp)   return { regime: 'trending_bull', confidence: Math.min(1, adx / 40) };
    if (trendingDown) return { regime: 'trending_bear', confidence: Math.min(1, adx / 40) };
    if (wideBands && atr > 0)        return { regime: 'volatile_breakout', confidence: 0.7 };
    if (flatBands)                   return { regime: 'choppy_low_vol',   confidence: 0.6 };
    if (overbought || oversold)      return { regime: 'mean_reverting',   confidence: 0.65 };
    return { regime: 'unknown', confidence: 0.3 };
};

export type ContractType =
    | 'MULTUP' | 'MULTDOWN'
    | 'CALL'   | 'PUT'
    | 'DIGITMATCH' | 'DIGITDIFF'
    | 'DIGITOVER'  | 'DIGITUNDER';

export interface ContractPick {
    contractType: ContractType;
    direction: 'UP' | 'DOWN' | 'NEUTRAL';
    barrier?: number;
    targetDigit?: number;
    rationale: string;
    edgeExpectancy: number;
}

/**
 * Routes the (regime, symbol kind) pair to the best Deriv contract.
 *
 * `mlBullish` comes from the LightGBM directional hint (probability >= 0.5).
 * Digit picks require positive EV regardless of regime.
 */
export const routeContract = (
    symbolKind: 'forex' | 'synthetic',
    regime: MarketRegime,
    snap: IndicatorSnapshot,
    digitDist: DigitDistribution | null,
    mlBullish: boolean,
): ContractPick | null => {
    // ── FOREX → multipliers only ─────────────────────────────────────────
    if (symbolKind === 'forex') {
        if (regime === 'trending_bull' || (regime === 'mean_reverting' && snap.rsi < 35)) {
            return { contractType: 'MULTUP', direction: 'UP', edgeExpectancy: 0.05,
                     rationale: `forex • ${regime}` };
        }
        if (regime === 'trending_bear' || (regime === 'mean_reverting' && snap.rsi > 65)) {
            return { contractType: 'MULTDOWN', direction: 'DOWN', edgeExpectancy: 0.05,
                     rationale: `forex • ${regime}` };
        }
        if (regime === 'volatile_breakout') {
            return mlBullish
                ? { contractType: 'MULTUP',   direction: 'UP',   edgeExpectancy: 0.03,
                    rationale: 'forex • breakout (ML bullish)' }
                : { contractType: 'MULTDOWN', direction: 'DOWN', edgeExpectancy: 0.03,
                    rationale: 'forex • breakout (ML bearish)' };
        }
        // LOOSENED: even on 'unknown' regime, follow the ML hint with reduced edge
        if (regime === 'unknown') {
            return mlBullish
                ? { contractType: 'MULTUP',   direction: 'UP',   edgeExpectancy: 0.015,
                    rationale: 'forex • ML-only directional pick' }
                : { contractType: 'MULTDOWN', direction: 'DOWN', edgeExpectancy: 0.015,
                    rationale: 'forex • ML-only directional pick' };
        }
        return null;
    }

    // ── SYNTHETIC (binary) ───────────────────────────────────────────────
    // 1. Digit contracts — POSITIVE EV is the gate.
    if (digitDist && digitDist.samples >= 150) {
        const ou = bestOverUnder(digitDist, 1.95);
        if (ou && ou.edge > 0.015) {
            return {
                contractType: ou.side === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER',
                direction: 'NEUTRAL', barrier: ou.barrier, edgeExpectancy: ou.edge,
                rationale: `digit-${ou.side.toLowerCase()} barrier=${ou.barrier} edge=${(ou.edge * 100).toFixed(2)}%`,
            };
        }
        const m = bestMatchDigit(digitDist, 9.0, 0.015);
        if (m) {
            return {
                contractType: 'DIGITMATCH', direction: 'NEUTRAL', targetDigit: m.digit,
                edgeExpectancy: m.edge,
                rationale: `digit-match d=${m.digit} edge=${(m.edge * 100).toFixed(2)}%`,
            };
        }
    }

    // 2. Rise/Fall on synthetics — most regimes are tradeable.
    if (regime === 'trending_bull') return { contractType: 'CALL', direction: 'UP',   edgeExpectancy: 0.04, rationale: 'synthetic • trending bull' };
    if (regime === 'trending_bear') return { contractType: 'PUT',  direction: 'DOWN', edgeExpectancy: 0.04, rationale: 'synthetic • trending bear' };
    if (regime === 'volatile_breakout') {
        return mlBullish
            ? { contractType: 'CALL', direction: 'UP',   edgeExpectancy: 0.025, rationale: 'synthetic • breakout (ML bullish)' }
            : { contractType: 'PUT',  direction: 'DOWN', edgeExpectancy: 0.025, rationale: 'synthetic • breakout (ML bearish)' };
    }
    if (regime === 'mean_reverting' && snap.rsi < 30) return { contractType: 'CALL', direction: 'UP',   edgeExpectancy: 0.03, rationale: 'synthetic • mean-revert oversold' };
    if (regime === 'mean_reverting' && snap.rsi > 70) return { contractType: 'PUT',  direction: 'DOWN', edgeExpectancy: 0.03, rationale: 'synthetic • mean-revert overbought' };

    // LOOSENED: even on 'unknown' regime, the ML model can drive a Rise/Fall pick.
    if (regime === 'unknown') {
        return mlBullish
            ? { contractType: 'CALL', direction: 'UP',   edgeExpectancy: 0.015, rationale: 'synthetic • ML-only directional pick' }
            : { contractType: 'PUT',  direction: 'DOWN', edgeExpectancy: 0.015, rationale: 'synthetic • ML-only directional pick' };
    }

    return null; // choppy_low_vol → still skipped (dead zone, no edge)
};

export const routeSpikeContract = (symbol: string, snap: IndicatorSnapshot): ContractPick | null => {
    const meta = getSyntheticMeta(symbol);
    if (!meta) return null;
    if (meta.category === 'boom')  return { contractType: 'CALL', direction: 'UP',   edgeExpectancy: 0.03, rationale: `${symbol} • boom natural-bias long` };
    if (meta.category === 'crash') return { contractType: 'PUT',  direction: 'DOWN', edgeExpectancy: 0.03, rationale: `${symbol} • crash natural-bias short` };
    return null;
};

export const resolveSymbolKind = (code: string): 'forex' | 'synthetic' => {
    const k = getSymbolKind(code);
    if (k === 'unknown') throw new Error(`Unknown symbol: ${code}`);
    return k;
};
