/**
 * Deriv Synthetic Indices Registry
 * --------------------------------
 * Covers Volatility Indices (slow + 1-second), Boom/Crash, Step, Jump,
 * Range Break, and Bull/Bear markets. The "binary section" runs on these.
 */
export interface SyntheticMeta {
    code: string;
    display: string;
    pip: number;
    category: 'volatility' | 'boom' | 'crash' | 'step' | 'jump' | 'range';
    tickIntervalSec: number;  // 2 for slow vol, 1 for 1HZ
    supportsDigit: boolean;   // digit contracts only valid on volatility indices
    payoutMultiple: number;   // typical CALL/PUT payout (binary)
}

export const SYNTHETIC_SYMBOLS: Record<string, SyntheticMeta> = {
    // Slow volatility indices (2-second tick)
    R_10:     { code: 'R_10',     display: 'Volatility 10 Index',    pip: 0.001, category: 'volatility', tickIntervalSec: 2, supportsDigit: true, payoutMultiple: 1.95 },
    R_25:     { code: 'R_25',     display: 'Volatility 25 Index',    pip: 0.001, category: 'volatility', tickIntervalSec: 2, supportsDigit: true, payoutMultiple: 1.95 },
    R_50:     { code: 'R_50',     display: 'Volatility 50 Index',    pip: 0.01,  category: 'volatility', tickIntervalSec: 2, supportsDigit: true, payoutMultiple: 1.95 },
    R_75:     { code: 'R_75',     display: 'Volatility 75 Index',    pip: 0.01,  category: 'volatility', tickIntervalSec: 2, supportsDigit: true, payoutMultiple: 1.95 },
    R_100:    { code: 'R_100',    display: 'Volatility 100 Index',   pip: 0.01,  category: 'volatility', tickIntervalSec: 2, supportsDigit: true, payoutMultiple: 1.95 },

    // 1-second volatility indices
    '1HZ10V':  { code: '1HZ10V',  display: 'Volatility 10 (1s)',     pip: 0.001, category: 'volatility', tickIntervalSec: 1, supportsDigit: true, payoutMultiple: 1.95 },
    '1HZ25V':  { code: '1HZ25V',  display: 'Volatility 25 (1s)',     pip: 0.001, category: 'volatility', tickIntervalSec: 1, supportsDigit: true, payoutMultiple: 1.95 },
    '1HZ50V':  { code: '1HZ50V',  display: 'Volatility 50 (1s)',     pip: 0.01,  category: 'volatility', tickIntervalSec: 1, supportsDigit: true, payoutMultiple: 1.95 },
    '1HZ75V':  { code: '1HZ75V',  display: 'Volatility 75 (1s)',     pip: 0.01,  category: 'volatility', tickIntervalSec: 1, supportsDigit: true, payoutMultiple: 1.95 },
    '1HZ100V': { code: '1HZ100V', display: 'Volatility 100 (1s)',    pip: 0.01,  category: 'volatility', tickIntervalSec: 1, supportsDigit: true, payoutMultiple: 1.95 },
    '1HZ150V': { code: '1HZ150V', display: 'Volatility 150 (1s)',    pip: 0.01,  category: 'volatility', tickIntervalSec: 1, supportsDigit: true, payoutMultiple: 1.95 },
    '1HZ250V': { code: '1HZ250V', display: 'Volatility 250 (1s)',    pip: 0.01,  category: 'volatility', tickIntervalSec: 1, supportsDigit: true, payoutMultiple: 1.95 },
    '1HZ500V': { code: '1HZ500V', display: 'Volatility 500 (1s)',    pip: 0.01,  category: 'volatility', tickIntervalSec: 1, supportsDigit: true, payoutMultiple: 1.95 },
    '1HZ1000V':{ code: '1HZ1000V', display: 'Volatility 1000 (1s)',   pip: 0.01,  category: 'volatility', tickIntervalSec: 1, supportsDigit: true, payoutMultiple: 1.95 },

    // Boom / Crash
    BOOM500:   { code: 'BOOM500',   display: 'Boom 500 Index',    pip: 0.01, category: 'boom',  tickIntervalSec: 1, supportsDigit: false, payoutMultiple: 1.95 },
    BOOM1000:  { code: 'BOOM1000',  display: 'Boom 1000 Index',   pip: 0.01, category: 'boom',  tickIntervalSec: 1, supportsDigit: false, payoutMultiple: 1.95 },
    BOOM300:   { code: 'BOOM300',   display: 'Boom 300 Index',    pip: 0.01, category: 'boom',  tickIntervalSec: 1, supportsDigit: false, payoutMultiple: 1.95 },
    CRASH500:  { code: 'CRASH500',  display: 'Crash 500 Index',   pip: 0.01, category: 'crash', tickIntervalSec: 1, supportsDigit: false, payoutMultiple: 1.95 },
    CRASH1000: { code: 'CRASH1000', display: 'Crash 1000 Index',  pip: 0.01, category: 'crash', tickIntervalSec: 1, supportsDigit: false, payoutMultiple: 1.95 },
    CRASH300:  { code: 'CRASH300',  display: 'Crash 300 Index',   pip: 0.01, category: 'crash', tickIntervalSec: 1, supportsDigit: false, payoutMultiple: 1.95 },

    // Step / Jump / Range Break (round numbers picked to match Deriv's product line)
    stpRNG:    { code: 'stpRNG',    display: 'Step Index',         pip: 0.1,  category: 'step',  tickIntervalSec: 2, supportsDigit: false, payoutMultiple: 1.95 },
    stpRNG2:   { code: 'stpRNG2',   display: 'Step Index 200',     pip: 0.1,  category: 'step',  tickIntervalSec: 1, supportsDigit: false, payoutMultiple: 1.95 },
    stpRNG3:   { code: 'stpRNG3',   display: 'Step Index 500',     pip: 0.1,  category: 'step',  tickIntervalSec: 1, supportsDigit: false, payoutMultiple: 1.95 },
    JD10:      { code: 'JD10',      display: 'Jump 10 Index',      pip: 0.001, category: 'jump', tickIntervalSec: 1, supportsDigit: false, payoutMultiple: 1.95 },
    JD25:      { code: 'JD25',      display: 'Jump 25 Index',      pip: 0.001, category: 'jump', tickIntervalSec: 1, supportsDigit: false, payoutMultiple: 1.95 },
    JD50:      { code: 'JD50',      display: 'Jump 50 Index',      pip: 0.01,  category: 'jump', tickIntervalSec: 1, supportsDigit: false, payoutMultiple: 1.95 },
    JD75:      { code: 'JD75',      display: 'Jump 75 Index',      pip: 0.01,  category: 'jump', tickIntervalSec: 1, supportsDigit: false, payoutMultiple: 1.95 },
    JD100:     { code: 'JD100',     display: 'Jump 100 Index',     pip: 0.01,  category: 'jump', tickIntervalSec: 1, supportsDigit: false, payoutMultiple: 1.95 },
    RDBEAR:    { code: 'RDBEAR',    display: 'Bear Market Index',  pip: 0.001, category: 'range', tickIntervalSec: 2, supportsDigit: false, payoutMultiple: 1.95 },
    RDBULL:    { code: 'RDBULL',    display: 'Bull Market Index',  pip: 0.001, category: 'range', tickIntervalSec: 2, supportsDigit: false, payoutMultiple: 1.95 },
    RDBRANGE100: { code: 'RDBRANGE100', display: 'Range Break 100 Index', pip: 0.001, category: 'range', tickIntervalSec: 2, supportsDigit: false, payoutMultiple: 1.95 },
};

export const getSyntheticMeta = (code: string): SyntheticMeta | undefined => SYNTHETIC_SYMBOLS[code];

export const isSyntheticSymbol = (code: string): boolean => !!SYNTHETIC_SYMBOLS[code];

export const isVolatilityIndex = (code: string): boolean => {
    const m = SYNTHETIC_SYMBOLS[code];
    return m?.category === 'volatility';
};

export const isSpikeIndex = (code: string): boolean => {
    const m = SYNTHETIC_SYMBOLS[code];
    return m?.category === 'boom' || m?.category === 'crash';
};

export const SYNTHETIC_CODES = Object.keys(SYNTHETIC_SYMBOLS);
