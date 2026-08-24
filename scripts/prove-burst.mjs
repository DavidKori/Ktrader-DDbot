/**
 * Burst-Detector Proof
 * ====================
 * Injects synthetic bursts + noise sequences into the detector and asserts:
 *   1. True bursts fire (recall ≥ 0.8).
 *   2. Noise does NOT fire (precision ≥ 0.9 = false-positive rate ≤ 10%).
 *   3. ATR-adaptive buffer widens in LDN_NY_OVERLAP session vs ASIA_LULL.
 */

// ---- Minimal port of atr/bollinger for standalone Node run ----
function atr(candles, n = 14) {
  if (candles.length < n + 1) return NaN;
  const trs = [];
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.reduce((a, b) => a + b, 0) / n;
}
function sma(xs, n) { let s = 0; for (let i = xs.length - n; i < xs.length; i++) s += xs[i]; return s / n; }
function bollinger(closes, n = 20, k = 2) {
  const m = sma(closes, n);
  let v = 0; for (let i = closes.length - n; i < closes.length; i++) v += (closes[i] - m) ** 2;
  const sd = Math.sqrt(v / n);
  return { upper: m + k * sd, mid: m, lower: m - k * sd, bandwidth: (2 * k * sd) / m };
}
function percentile(xs, x) {
  const s = [...xs].sort((a, b) => a - b);
  const r = s.findIndex(v => v >= x);
  return r < 0 ? 100 : (r / s.length) * 100;
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]);
}

// ---- Port of burst-detector ----
function velocityAndAccel(candles, atrVal, k = 3) {
  if (candles.length < k + 1 || !isFinite(atrVal) || atrVal <= 0) return { v: 0, a: 0 };
  const closes = candles.slice(-k - 1).map(c => c.close);
  const v1 = (closes[closes.length - 1] - closes[closes.length - 2]) / atrVal;
  const v0 = (closes[1] - closes[0]) / atrVal;
  const a = (v1 - v0) / Math.max(1, closes.length - 2);
  return { v: v1, a };
}
function volumeOfAttention(tickEpochsMs, recentSec = 20, windowSec = 300) {
  if (tickEpochsMs.length < 10) return 1;
  const now = tickEpochsMs[tickEpochsMs.length - 1];
  const recent = tickEpochsMs.filter(t => t >= now - recentSec * 1000).length / recentSec;
  const buckets = new Map();
  for (const t of tickEpochsMs) {
    if (t < now - windowSec * 1000) continue;
    const s = Math.floor(t / 1000);
    buckets.set(s, (buckets.get(s) ?? 0) + 1);
  }
  const rates = [...buckets.values()];
  const base = median(rates);
  return base > 0 ? recent / base : 1;
}
function bbSqueezeRelease(candles) {
  if (candles.length < 25) return { released: false, direction: 0 };
  const closes = candles.map(c => c.close);
  const bws = [];
  for (let i = 20; i < candles.length; i++) {
    const bb = bollinger(closes.slice(0, i), 20, 2);
    if (isFinite(bb.bandwidth)) bws.push(bb.bandwidth);
  }
  if (bws.length < 20) return { released: false, direction: 0 };
  const cur = bws[bws.length - 1];
  const p = percentile(bws.slice(-20, -1), cur);
  if (p > 25) return { released: false, direction: 0 };
  const bb = bollinger(closes, 20, 2);
  const last = closes[closes.length - 1];
  if (last > bb.upper) return { released: true, direction: 1 };
  if (last < bb.lower) return { released: true, direction: -1 };
  return { released: false, direction: 0 };
}
function detectBurst({ candles, tickEpochsMs }) {
  if (candles.length < 25 || tickEpochsMs.length < 20) return { fired: false };
  const atrVal = atr(candles);
  if (!isFinite(atrVal) || atrVal <= 0) return { fired: false };
  const { v, a } = velocityAndAccel(candles, atrVal, 3);
  const voa = volumeOfAttention(tickEpochsMs);
  const bb = bbSqueezeRelease(candles);
  const dir = bb.released ? bb.direction : (v > 0 ? 1 : v < 0 ? -1 : 0);
  if (dir === 0) return { fired: false };
  const voteV = Math.abs(v) > 0.50 && Math.sign(v) === dir;
  const voteA = Math.abs(a) > 0.15 && Math.sign(a) === dir;
  const voteVoa = voa > 1.7;
  const voteBb = bb.released;
  const votes = [voteV, voteA, voteVoa, voteBb].filter(Boolean).length;
  if (votes < 3) return { fired: false, votes };
  return { fired: true, direction: dir, votes, v, a, voa, bbReleased: voteBb };
}

// ---- Synthetic data generator ----
function genBaseCandles(n = 60, price = 1.1000) {
  const cs = [];
  let p = price;
  for (let i = 0; i < n; i++) {
    const noise = (Math.random() - 0.5) * 0.0002;
    const open = p, close = p + noise, high = Math.max(open, close) + Math.random() * 0.0001, low = Math.min(open, close) - Math.random() * 0.0001;
    cs.push({ epoch: Date.now() / 1000 - (n - i) * 60, open, high, low, close });
    p = close;
  }
  return cs;
}
function genBaseTicks(nMs = 300_000, ratePerSec = 3) {
  const ticks = [];
  const now = Date.now();
  for (let t = now - nMs; t < now; t += 1000 / ratePerSec) ticks.push(t);
  return ticks;
}
function injectBurst(candles, ticks, direction = 1, magnitudePips = 20) {
  // Squeeze then release: last 5 pre-burst candles compress, then 3 accelerating candles
  const c = candles.slice();
  for (let i = c.length - 8; i < c.length - 3; i++) {
    const mid = (c[i].open + c[i].close) / 2;
    c[i] = { ...c[i], open: mid - 0.00005, close: mid + 0.00005, high: mid + 0.00007, low: mid - 0.00007 };
  }
  let last = c[c.length - 4].close;
  // Accelerating moves: 20%, 35%, 45% of total magnitude → real acceleration signature
  const shares = [0.20, 0.35, 0.45];
  for (let i = 0; i < 3; i++) {
    const idx = c.length - 3 + i;
    const move = direction * magnitudePips * 0.0001 * shares[i];
    const open = last, close = last + move;
    c[idx] = { ...c[idx], open, close, high: Math.max(open, close) + 0.0001, low: Math.min(open, close) - 0.0001 };
    last = close;
  }
  // Boost tick rate in the last 20 s to trigger VoA
  const now = ticks[ticks.length - 1];
  const boost = [];
  for (let t = now - 20_000; t < now; t += 100) boost.push(t);
  return { candles: c, ticks: [...ticks, ...boost] };
}

// ---- Adaptive-buffer port ----
function classifySession(nowUtcMs = Date.now()) {
  const h = new Date(nowUtcMs).getUTCHours();
  if (h >= 22 || h < 2) return 'ASIA_LULL';
  if (h < 7)  return 'ASIA_MAIN';
  if (h < 9)  return 'LDN_OPEN';
  if (h < 13) return 'LDN_MAIN';
  if (h < 16) return 'LDN_NY_OVERLAP';
  if (h < 20) return 'NY_MAIN';
  if (h < 22) return 'NY_CLOSE';
  return 'OFF';
}
function computeAdaptiveBuffer({ candles, baseTpAtrMult, baseSlAtrMult, nowUtcMs }) {
  const now = nowUtcMs ?? Date.now();
  const atrs = [];
  for (let i = 20; i < candles.length; i++) {
    const a = atr(candles.slice(0, i));
    if (isFinite(a)) atrs.push(a);
  }
  const cur = atrs[atrs.length - 1];
  const p = percentile(atrs.slice(0, -1), cur);
  const session = classifySession(now);
  let factor = 1.0;
  if (p >= 90) factor = 1.4; else if (p >= 75) factor = 1.25; else if (p >= 50) factor = 1.1; else if (p >= 25) factor = 1.0; else factor = 0.8;
  const bonus = { LDN_NY_OVERLAP: 0.15, LDN_OPEN: 0.1, NY_MAIN: 0.05, ASIA_LULL: -0.15, OFF: -0.10 };
  factor += bonus[session] ?? 0;
  factor = Math.max(0.6, Math.min(1.7, factor));
  return { tpAtrMult: baseTpAtrMult * factor, slAtrMult: baseSlAtrMult * factor, atrPercentile: p, session, widenFactor: factor };
}

// ---- Run experiments ----
console.log('\n=====================================================');
console.log('  Burst Detector Proof — recall, precision, buffer');
console.log('=====================================================\n');

// (1) Recall on TRUE bursts
const RECALL_N = 100;
let trueFired = 0;
for (let i = 0; i < RECALL_N; i++) {
  const base = genBaseCandles(60);
  const ticks = genBaseTicks();
  const dir = Math.random() < 0.5 ? 1 : -1;
  const mag = 12 + Math.random() * 10;
  const { candles, ticks: t2 } = injectBurst(base, ticks, dir, mag);
  const r = detectBurst({ candles, tickEpochsMs: t2 });
  if (r.fired && r.direction === dir) trueFired++;
}
const recall = trueFired / RECALL_N;

// (2) Precision on pure NOISE
const NOISE_N = 200;
let falseFired = 0;
for (let i = 0; i < NOISE_N; i++) {
  const base = genBaseCandles(60);
  const ticks = genBaseTicks();
  const r = detectBurst({ candles: base, tickEpochsMs: ticks });
  if (r.fired) falseFired++;
}
const fpr = falseFired / NOISE_N;

// (3) Adaptive buffer session comparison
const cs = genBaseCandles(120);
// Force LDN_NY_OVERLAP at 14 UTC
const ldnNy = computeAdaptiveBuffer({
  candles: cs, baseTpAtrMult: 1.8, baseSlAtrMult: 0.9,
  nowUtcMs: Date.UTC(2026, 0, 15, 14, 0, 0),
});
const asia = computeAdaptiveBuffer({
  candles: cs, baseTpAtrMult: 1.8, baseSlAtrMult: 0.9,
  nowUtcMs: Date.UTC(2026, 0, 15, 0, 0, 0),
});

console.log('1. Recall (true bursts caught):');
console.log(`   ${trueFired}/${RECALL_N} = ${(recall * 100).toFixed(1)}%   (target ≥ 80%)   ${recall >= 0.80 ? '✅' : '❌'}\n`);

console.log('2. False-positive rate (noise misclassified as burst):');
console.log(`   ${falseFired}/${NOISE_N} = ${(fpr * 100).toFixed(1)}%   (target ≤ 10%)   ${fpr <= 0.10 ? '✅' : '❌'}\n`);

console.log('3. ATR-adaptive buffer widens for high-vol session:');
console.log(`   LDN/NY overlap (14 UTC):  factor=${ldnNy.widenFactor.toFixed(2)}x  TP=${ldnNy.tpAtrMult.toFixed(2)}xATR  SL=${ldnNy.slAtrMult.toFixed(2)}xATR`);
console.log(`   Asia lull      (00 UTC):  factor=${asia.widenFactor.toFixed(2)}x  TP=${asia.tpAtrMult.toFixed(2)}xATR  SL=${asia.slAtrMult.toFixed(2)}xATR`);
console.log(`   Overlap wider than Asia?  ${ldnNy.widenFactor > asia.widenFactor ? '✅' : '❌'}\n`);

const pass = recall >= 0.80 && fpr <= 0.10 && ldnNy.widenFactor > asia.widenFactor;
console.log('-----------------------------------------------------');
console.log(pass ? '✅ PASS — burst detector + adaptive buffer both work.' : '❌ FAIL — see gates above.');
process.exit(pass ? 0 : 1);
