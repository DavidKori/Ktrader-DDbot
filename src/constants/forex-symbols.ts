/**
 * Deriv Forex Symbol Registry
 * ---------------------------
 * Pip sizes follow Deriv's 5-digit (4 for JPY, 2 for gold) convention.
 */
export interface ForexMeta {
    code: string;        // Deriv API code e.g. 'frxEURUSD'
    display: string;     // Human label 'EUR/USD'
    pip: number;         // Pip value e.g. 0.0001 (5-digit) | 0.01 (JPY) | 0.01 (XAU 2-digit)
    typicalSpread: number; // pips
    category: 'major' | 'minor' | 'metal';
}

export const FOREX_SYMBOLS: Record<string, ForexMeta> = {
    frxEURUSD: { code: 'frxEURUSD', display: 'EUR/USD', pip: 0.0001, typicalSpread: 0.6, category: 'major' },
    frxGBPUSD: { code: 'frxGBPUSD', display: 'GBP/USD', pip: 0.0001, typicalSpread: 1.0, category: 'major' },
    frxUSDJPY: { code: 'frxUSDJPY', display: 'USD/JPY', pip: 0.01,   typicalSpread: 0.7, category: 'major' },
    frxAUDUSD: { code: 'frxAUDUSD', display: 'AUD/USD', pip: 0.0001, typicalSpread: 0.8, category: 'major' },
    frxUSDCAD: { code: 'frxUSDCAD', display: 'USD/CAD', pip: 0.0001, typicalSpread: 1.0, category: 'major' },
    frxUSDCHF: { code: 'frxUSDCHF', display: 'USD/CHF', pip: 0.0001, typicalSpread: 1.2, category: 'major' },
    frxNZDUSD: { code: 'frxNZDUSD', display: 'NZD/USD', pip: 0.0001, typicalSpread: 1.3, category: 'major' },
    frxEURGBP: { code: 'frxEURGBP', display: 'EUR/GBP', pip: 0.0001, typicalSpread: 1.1, category: 'minor' },
    frxEURJPY: { code: 'frxEURJPY', display: 'EUR/JPY', pip: 0.01,   typicalSpread: 1.4, category: 'minor' },
    frxGBPJPY: { code: 'frxGBPJPY', display: 'GBP/JPY', pip: 0.01,   typicalSpread: 1.8, category: 'minor' },
    frxAUDJPY: { code: 'frxAUDJPY', display: 'AUD/JPY', pip: 0.01,   typicalSpread: 1.6, category: 'minor' },
    frxEURAUD: { code: 'frxEURAUD', display: 'EUR/AUD', pip: 0.0001, typicalSpread: 1.7, category: 'minor' },
    frxEURCAD: { code: 'frxEURCAD', display: 'EUR/CAD', pip: 0.0001, typicalSpread: 1.8, category: 'minor' },
    frxGBPAUD: { code: 'frxGBPAUD', display: 'GBP/AUD', pip: 0.0001, typicalSpread: 2.0, category: 'minor' },
    frxXAUUSD: { code: 'frxXAUUSD', display: 'XAU/USD', pip: 0.01,   typicalSpread: 35,  category: 'metal' },
    frxXAGUSD: { code: 'frxXAGUSD', display: 'XAG/USD', pip: 0.001,  typicalSpread: 4,   category: 'metal' },
};

export const getForexMeta = (code: string): ForexMeta | undefined => FOREX_SYMBOLS[code];

export const isForexSymbol = (code: string): boolean => code.startsWith('frx');

export const FOREX_CODES = Object.keys(FOREX_SYMBOLS);
