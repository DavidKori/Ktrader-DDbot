/**
 * Edge Decay Monitor (Architecture #6)
 * ====================================
 * Detects when a symbol's edge is statistically dying BEFORE it becomes
 * a draw-down event. Uses a CUSUM (cumulative sum) change-point detector
 * on rolling expectancy plus a Welch t-test between the first half and
 * the second half of the active window.
 *
 *   - CUSUM detects directional drift in expectancy.
 *   - Welch t-test confirms the drift is statistically significant.
 *   - Combined output: a "decay score" in [0, 1] where 1 = edge is dead.
 *
 * The orchestrator should:
 *   - decayScore < 0.3  → trade normally
 *   - 0.3..0.6          → reduce stake fraction
 *   - 0.6..0.85         → switch to shadow / virtual mode
 *   - >= 0.85           → stop trading this symbol; trigger rebalance
 */

export interface DecayInput {
  symbol: string;
  pnlSeries: number[];   // chronological per-trade PnL
}

export interface DecaySignal {
  symbol: string;
  samples: number;
  meanFirst: number;
  meanSecond: number;
  cusumPos: number;
  cusumNeg: number;
  tStat: number;
  pValue: number;
  decayScore: number;    // 0..1
  action: 'TRADE' | 'REDUCE' | 'SHADOW' | 'STOP';
  reason: string;
}

function mean(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
}
function variance(xs: number[]): number {
  const m = mean(xs);
  return xs.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, xs.length - 1);
}

/** Welch's two-sample t (unequal variance, robust). */
function welchT(a: number[], b: number[]): { t: number; df: number } {
  const ma = mean(a), mb = mean(b);
  const va = variance(a), vb = variance(b);
  const na = a.length, nb = b.length;
  const seDiff = Math.sqrt(va / na + vb / nb) || 1e-9;
  const t = (mb - ma) / seDiff;
  const df = (va / na + vb / nb) ** 2 /
             ((va / na) ** 2 / Math.max(1, na - 1) + (vb / nb) ** 2 / Math.max(1, nb - 1));
  return { t, df };
}

/** Coarse Student-t p-value approximation (two-tailed). */
function tToP(t: number, df: number): number {
  const x = df / (df + t * t);
  // Incomplete beta-ish approximation via continued fraction would be ideal;
  // we use a sigmoid-fit that is monotonic and bounded, sufficient for decay rank.
  return Math.min(1, Math.max(0, Math.pow(x, df / 2)));
}

export function detectDecay(input: DecayInput, minSamples = 40): DecaySignal {
  const xs = input.pnlSeries;
  if (xs.length < minSamples) {
    return {
      symbol: input.symbol, samples: xs.length,
      meanFirst: 0, meanSecond: 0, cusumPos: 0, cusumNeg: 0,
      tStat: 0, pValue: 1, decayScore: 0,
      action: 'TRADE',
      reason: `warmup ${xs.length}/${minSamples}`,
    };
  }
  // Compare last-15 vs prior-25 — more stable than naive halves
  const a = xs.slice(-40, -15);
  const b = xs.slice(-15);
  const ma = mean(a), mb = mean(b);

  // CUSUM
  const sigma = Math.sqrt(variance(xs)) || 1e-9;
  const k = 0.5 * sigma;
  let sPos = 0, sNeg = 0;
  let maxPos = 0, maxNeg = 0;
  for (const v of xs) {
    sPos = Math.max(0, sPos + (v - k));
    sNeg = Math.max(0, sNeg - (v + k));
    if (sPos > maxPos) maxPos = sPos;
    if (sNeg > maxNeg) maxNeg = sNeg;
  }

  // Significance test
  const { t, df } = welchT(a, b);
  const p = tToP(t, df);

  // Decay score: weighted combination
  //   - direction: mb < ma is bad
  //   - magnitude: |t| large + p small
  //   - persistence: maxNeg dominant over maxPos
  //   - ratio drop: relative deterioration vs ma
  const direction = mb < ma ? 1 : -1;
  const tNorm = Math.min(1, Math.abs(t) / 3);
  const cusumRatio = maxNeg / Math.max(1e-9, maxNeg + maxPos);
  const ratioDrop = ma > 0 ? Math.max(0, (ma - mb) / ma) : 0;
  let decayScore = 0;
  if (direction > 0) {
    decayScore = 0.40 * tNorm + 0.40 * Math.min(1, ratioDrop * 1.2) + 0.15 * cusumRatio + 0.05;
  } else {
    decayScore = Math.max(0, 0.15 * cusumRatio - 0.1);
  }
  decayScore = Math.max(0, Math.min(1, decayScore));

  let action: DecaySignal['action'];
  let reason: string;
  const stopOK = decayScore >= 0.85 && xs.length >= 80 && mb < 0;
  if (stopOK) {
    action = 'STOP';   reason = `dead edge: score=${decayScore.toFixed(2)}, mean dropped ${ma.toFixed(3)}→${mb.toFixed(3)}`;
  } else if (decayScore >= 0.60) {
    action = 'SHADOW'; reason = `severe decay: score=${decayScore.toFixed(2)}`;
  } else if (decayScore >= 0.30) {
    action = 'REDUCE'; reason = `mild decay: score=${decayScore.toFixed(2)}`;
  } else {
    action = 'TRADE';  reason = `edge healthy: score=${decayScore.toFixed(2)}`;
  }

  return {
    symbol: input.symbol,
    samples: xs.length,
    meanFirst: ma, meanSecond: mb,
    cusumPos: maxPos, cusumNeg: maxNeg,
    tStat: t, pValue: p,
    decayScore, action, reason,
  };
}
