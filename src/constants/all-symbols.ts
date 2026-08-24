/**
 * Unified symbol resolver — works for both forex and binary synthetics.
 */
import {
    FOREX_SYMBOLS, FOREX_CODES, getForexMeta, isForexSymbol, ForexMeta,
} from './forex-symbols';
import {
    SYNTHETIC_SYMBOLS, SYNTHETIC_CODES, getSyntheticMeta, isSyntheticSymbol, SyntheticMeta,
} from './synthetic-symbols';

export type AnySymbolMeta =
    | (ForexMeta     & { kind: 'forex' })
    | (SyntheticMeta & { kind: 'synthetic' });

export const ALL_CODES = [...FOREX_CODES, ...SYNTHETIC_CODES];

export const getSymbolMeta = (code: string): AnySymbolMeta | undefined => {
    const f = getForexMeta(code);
    if (f) return { ...f, kind: 'forex' };
    const s = getSyntheticMeta(code);
    if (s) return { ...s, kind: 'synthetic' };
    return undefined;
};

export const getSymbolKind = (code: string): 'forex' | 'synthetic' | 'unknown' => {
    if (isForexSymbol(code))      return 'forex';
    if (isSyntheticSymbol(code))  return 'synthetic';
    return 'unknown';
};

export const toPips = (price: number, code: string): number => {
    const m = getSymbolMeta(code);
    return m ? price / m.pip : 0;
};

export const fromPips = (pips: number, code: string): number => {
    const m = getSymbolMeta(code);
    return m ? pips * m.pip : 0;
};

export { isForexSymbol, isSyntheticSymbol, getForexMeta, getSyntheticMeta };
export { FOREX_SYMBOLS, SYNTHETIC_SYMBOLS };
