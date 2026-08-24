/**
 * Indicator Engine — pure functions only. No I/O, no side effects.
 */
export interface Candle {
    epoch: number; open: number; high: number; low: number; close: number; volume?: number;
}

const last = <T,>(a: T[]) => a[a.length - 1];

export const sma = (xs: number[], n: number): number => {
    if (xs.length < n) return NaN;
    let s = 0;
    for (let i = xs.length - n; i < xs.length; i++) s += xs[i];
    return s / n;
};

export const ema = (xs: number[], n: number): number => {
    if (xs.length < n) return NaN;
    const k = 2 / (n + 1);
    let e = sma(xs.slice(0, n), n);
    for (let i = n; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
    return e;
};

export const rsi = (closes: number[], period = 14): number => {
    if (closes.length < period + 1) return NaN;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    const ag = gains / period, al = losses / period;
    if (al === 0) return 100;
    const rs = ag / al;
    return 100 - 100 / (1 + rs);
};

export interface MACDResult { macd: number; signal: number; histogram: number; }

export const macd = (closes: number[], fast = 12, slow = 26, sig = 9): MACDResult => {
    const m = ema(closes, fast) - ema(closes, slow);
    // crude signal line: EMA over recent macd values via reduced series
    const macdSeries: number[] = [];
    for (let i = slow; i <= closes.length; i++) {
        const slice = closes.slice(0, i);
        macdSeries.push(ema(slice, fast) - ema(slice, slow));
    }
    const signal = ema(macdSeries, sig);
    return { macd: m, signal, histogram: m - signal };
};

export interface BollingerResult { upper: number; mid: number; lower: number; bandwidth: number; }

export const bollinger = (closes: number[], n = 20, k = 2): BollingerResult => {
    const m = sma(closes, n);
    let v = 0;
    for (let i = closes.length - n; i < closes.length; i++) v += (closes[i] - m) ** 2;
    const sd = Math.sqrt(v / n);
    return { upper: m + k * sd, mid: m, lower: m - k * sd, bandwidth: (2 * k * sd) / m };
};

export const atr = (candles: Candle[], n = 14): number => {
    if (candles.length < n + 1) return NaN;
    const trs: number[] = [];
    for (let i = candles.length - n; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return trs.reduce((a, b) => a + b, 0) / n;
};

export const adx = (candles: Candle[], n = 14): number => {
    if (candles.length < n + 1) return NaN;
    let dmPlus = 0, dmMinus = 0, trSum = 0;
    for (let i = candles.length - n; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        const up = c.high - p.high, dn = p.low - c.low;
        dmPlus  += up > dn && up > 0 ? up : 0;
        dmMinus += dn > up && dn > 0 ? dn : 0;
        trSum   += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    if (trSum === 0) return 0;
    const diPlus = 100 * dmPlus / trSum, diMinus = 100 * dmMinus / trSum;
    const sum = diPlus + diMinus;
    if (sum === 0) return 0;
    return 100 * Math.abs(diPlus - diMinus) / sum;
};

export interface IndicatorSnapshot {
    rsi: number; macd: MACDResult; bollinger: BollingerResult;
    atr: number; adx: number; ema_fast: number; ema_slow: number;
    lastClose: number;
}

export const snapshot = (candles: Candle[]): IndicatorSnapshot => {
    const closes = candles.map(c => c.close);
    return {
        rsi: rsi(closes), macd: macd(closes),
        bollinger: bollinger(closes), atr: atr(candles), adx: adx(candles),
        ema_fast: ema(closes, 9), ema_slow: ema(closes, 21),
        lastClose: last(closes),
    };
};
