/**
 * Regime Detector
 * ---------------
 * Classifies market into one of 4 regimes using ATR-based volatility
 * and ADX-based trend strength, then suggests an aggressiveness
 * multiplier and TP/SL skew.
 *
 *   Trending High Vol   →  aggressive    (TP×1.3, SL×0.9, agg=0.9)
 *   Trending Low  Vol   →  balanced      (TP×1.0, SL×1.0, agg=0.7)
 *   Ranging  High Vol   →  conservative  (TP×0.7, SL×1.2, agg=0.4)
 *   Ranging  Low  Vol   →  skip          (agg=0.0)
 */

export type Regime = 'TREND_HIGH_VOL' | 'TREND_LOW_VOL' | 'RANGE_HIGH_VOL' | 'RANGE_LOW_VOL';

export interface RegimeOutput {
  regime: Regime;
  atr: number;
  adx: number;
  trendStrength: number;     // 0..1
  volPercentile: number;     // 0..1
  tpMultiplier: number;
  slMultiplier: number;
  aggressiveness: number;    // 0..1
  shouldTrade: boolean;
}

export interface Candle { open: number; high: number; low: number; close: number; }

const REGIME_TABLE: Record<Regime, Pick<RegimeOutput, 'tpMultiplier' | 'slMultiplier' | 'aggressiveness' | 'shouldTrade'>> = {
  TREND_HIGH_VOL: { tpMultiplier: 1.30, slMultiplier: 0.90, aggressiveness: 0.90, shouldTrade: true  },
  TREND_LOW_VOL:  { tpMultiplier: 1.00, slMultiplier: 1.00, aggressiveness: 0.70, shouldTrade: true  },
  RANGE_HIGH_VOL: { tpMultiplier: 0.70, slMultiplier: 1.20, aggressiveness: 0.40, shouldTrade: true  },
  RANGE_LOW_VOL:  { tpMultiplier: 0.60, slMultiplier: 1.30, aggressiveness: 0.00, shouldTrade: false },
};

export function computeATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

export function computeADX(candles: Candle[], period = 14): number {
  if (candles.length < period + 2) return 0;
  const plusDM: number[] = [], minusDM: number[] = [], trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high, dn = p.low - c.low;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  if (atr === 0) return 0;
  const plusDI = (plusDM.slice(-period).reduce((a, b) => a + b, 0) / period) / atr * 100;
  const minusDI = (minusDM.slice(-period).reduce((a, b) => a + b, 0) / period) / atr * 100;
  const dx = Math.abs(plusDI - minusDI) / Math.max(plusDI + minusDI, 1e-9) * 100;
  return dx; // simplified single-period DX
}

export function detectRegime(candles: Candle[], volHistory: number[] = []): RegimeOutput {
  const atr = computeATR(candles);
  const adx = computeADX(candles);

  // Trend strength
  const trendStrength = Math.min(1, adx / 40);
  const isTrending = adx >= 22;

  // Volatility percentile
  const allVols = [...volHistory, atr].sort((a, b) => a - b);
  const idx = allVols.indexOf(atr);
  const volPercentile = allVols.length > 1 ? idx / (allVols.length - 1) : 0.5;
  const isHighVol = volPercentile >= 0.55;

  let regime: Regime;
  if (isTrending && isHighVol) regime = 'TREND_HIGH_VOL';
  else if (isTrending) regime = 'TREND_LOW_VOL';
  else if (isHighVol) regime = 'RANGE_HIGH_VOL';
  else regime = 'RANGE_LOW_VOL';

  return { regime, atr, adx, trendStrength, volPercentile, ...REGIME_TABLE[regime] };
}
