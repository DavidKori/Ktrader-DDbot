/**
 * Deterministic Strategy Validation — v5.5.5
 * ==========================================
 * Requirement: "the same historical data always produces the same signals".
 *
 * This suite proves determinism at three levels:
 *   1. PRNG          — the seeded generator is stable and platform-independent.
 *   2. Pipeline      — indicators → features → fusion inputs are pure functions.
 *   3. Simulator     — the expectancy "proof" is byte-reproducible run to run.
 *
 * It also proves the NEGATIVE control: with `allowNonDeterministic: true` the
 * simulator does drift, so the determinism we measure is real and not an
 * artefact of an insensitive test.
 */
import {
    mulberry32, hashSeed, resolveSeed, makeRandom, gaussFrom, makeFakeClock,
} from '../deterministic-random';
import { snapshot, Candle } from '../indicator-engine';
import { analyzeVolume } from '../adaptive-volume';
import { buildFeatures } from '../../ml/lightgbm-client';
import { fuseSignals } from '../../fusion/signal-fusion';
import { detectRegime } from '../../regime/market-regime';
import { computeValidationScore } from '../../validation/validation-engine';
import { simulateForexMultiplier, simulatePortfolio, DEFAULT_FOREX_SIM } from '../../edge/simulator';
import { closedBarsOnly } from '../no-repaint-guard';

function series(n: number, seed = 7, startEpoch = 1_700_000_000, tf = 60): Candle[] {
    const rand = mulberry32(seed);
    const out: Candle[] = [];
    let price = 100;
    for (let i = 0; i < n; i++) {
        const open = price;
        const close = price + (rand() - 0.5) * 0.9;
        out.push({
            epoch: startEpoch + i * tf, open, close,
            high: Math.max(open, close) + rand() * 0.25,
            low: Math.min(open, close) - rand() * 0.25,
        });
        price = close;
    }
    return out;
}

describe('1. PRNG determinism', () => {
    it('same seed → identical sequence', () => {
        const a = mulberry32(12345);
        const b = mulberry32(12345);
        const seqA = Array.from({ length: 500 }, () => a());
        const seqB = Array.from({ length: 500 }, () => b());
        expect(seqB).toEqual(seqA);
    });

    it('different seeds → different sequences', () => {
        const a = Array.from({ length: 50 }, mulberry32(1));
        const b = Array.from({ length: 50 }, mulberry32(2));
        expect(b).not.toEqual(a);
    });

    it('output is bounded in [0,1)', () => {
        const r = mulberry32(999);
        for (let i = 0; i < 20_000; i++) {
            const v = r();
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });

    it('is reasonably uniform (mean ≈ 0.5) so seeding does not bias results', () => {
        const r = mulberry32(4242);
        let sum = 0;
        const N = 200_000;
        for (let i = 0; i < N; i++) sum += r();
        expect(sum / N).toBeCloseTo(0.5, 2);
    });

    it('hashSeed is stable and case/order sensitive', () => {
        expect(hashSeed('frxEURUSD')).toBe(hashSeed('frxEURUSD'));
        expect(hashSeed('frxEURUSD')).not.toBe(hashSeed('frxGBPUSD'));
        expect(hashSeed('ab')).not.toBe(hashSeed('ba'));
    });

    it('resolveSeed handles numbers, strings and absence', () => {
        expect(resolveSeed(42)).toBe(42);
        expect(resolveSeed('x')).toBe(hashSeed('x'));
        expect(resolveSeed(undefined, 7)).toBe(7);
        expect(resolveSeed(NaN, 7)).toBe(7);
    });

    it('makeRandom is seeded by default and only unseeded when asked', () => {
        const s1 = Array.from({ length: 20 }, makeRandom('k'));
        const s2 = Array.from({ length: 20 }, makeRandom('k'));
        expect(s2).toEqual(s1);
        // Explicit opt-out returns Math.random itself.
        expect(makeRandom(undefined, true)).toBe(Math.random);
    });

    it('gaussFrom is deterministic for a seeded source', () => {
        const g1 = gaussFrom(mulberry32(5), 0.78, 0.07);
        const g2 = gaussFrom(mulberry32(5), 0.78, 0.07);
        expect(g2).toBe(g1);
    });

    it('fake clock is monotonic and reproducible', () => {
        const c1 = makeFakeClock(1_000, 10);
        const c2 = makeFakeClock(1_000, 10);
        const a = [c1(), c1(), c1()];
        const b = [c2(), c2(), c2()];
        expect(b).toEqual(a);
        expect(a[1]).toBeGreaterThan(a[0]);
    });
});

describe('2. Pipeline determinism — same data ⇒ same signals', () => {
    const DATA = series(240);
    const NOW = (DATA[239].epoch + 60) * 1000 + 1_000;

    /** Full deterministic slice of the decision pipeline (no I/O, no clock). */
    function runPipeline(cs: Candle[]) {
        const guarded = closedBarsOnly(cs, { now: NOW, timeframeSec: 60 });
        const volumes = guarded.map((_, i) =>
            Math.abs(guarded[i].close - (guarded[i - 1]?.close ?? guarded[i].close)));
        const snap = snapshot(guarded);
        const vol = analyzeVolume(volumes);
        const features = buildFeatures(snap, vol, guarded.map(c => c.close));
        // Neutral ML stand-in keeps this test independent of the inference service.
        const ml = {
            probability: 0.5, confidence: 'low' as const,
            risk_score: 0.5, direction_hint: 'NEUTRAL' as const,
        };
        const fusion = fuseSignals(snap, vol, ml);
        const regime = detectRegime(snap);
        const validation = computeValidationScore({
            snapshot: snap, volume: vol, ml, regime: regime.regime, duration: null,
        });
        return { snap, vol, features, fusion, regime, validation };
    }

    it('is byte-identical across 25 consecutive runs', () => {
        const first = JSON.stringify(runPipeline(DATA));
        for (let i = 0; i < 25; i++) {
            expect(JSON.stringify(runPipeline(DATA))).toBe(first);
        }
    });

    it('is invariant to array identity (a copy yields the same signals)', () => {
        const copy = DATA.map(c => ({ ...c }));
        expect(JSON.stringify(runPipeline(copy))).toBe(JSON.stringify(runPipeline(DATA)));
    });

    it('does NOT mutate its input (pure w.r.t. the caller\'s data)', () => {
        const before = JSON.stringify(DATA);
        runPipeline(DATA);
        expect(JSON.stringify(DATA)).toBe(before);
    });

    it('changing one historical bar DOES change the signal (sensitivity control)', () => {
        const perturbed = DATA.map(c => ({ ...c }));
        perturbed[239] = { ...perturbed[239], close: perturbed[239].close * 1.05 };
        expect(JSON.stringify(runPipeline(perturbed)))
            .not.toBe(JSON.stringify(runPipeline(DATA)));
    });

    it('the guard itself is deterministic for a fixed clock', () => {
        const a = closedBarsOnly(DATA, { now: NOW, timeframeSec: 60 });
        const b = closedBarsOnly(DATA, { now: NOW, timeframeSec: 60 });
        expect(b).toEqual(a);
    });
});

describe('3. Expectancy simulator reproducibility', () => {
    it('seeded runs are byte-identical', () => {
        const a = simulateForexMultiplier({ ...DEFAULT_FOREX_SIM, trades: 300, seed: 'audit-1' });
        const b = simulateForexMultiplier({ ...DEFAULT_FOREX_SIM, trades: 300, seed: 'audit-1' });
        expect(b.netPnL).toBe(a.netPnL);
        expect(b.wins).toBe(a.wins);
        expect(b.losses).toBe(a.losses);
        expect(b.winRate).toBe(a.winRate);
        expect(b.expectancy).toBe(a.expectancy);
        expect(b.maxDrawdown).toBe(a.maxDrawdown);
        expect(b.sharpe).toBe(a.sharpe);
    });

    it('different seeds produce different paths (the sim is still stochastic)', () => {
        const a = simulateForexMultiplier({ ...DEFAULT_FOREX_SIM, trades: 300, seed: 'x' });
        const b = simulateForexMultiplier({ ...DEFAULT_FOREX_SIM, trades: 300, seed: 'y' });
        expect(b.netPnL).not.toBe(a.netPnL);
    });

    it('NEGATIVE CONTROL: unseeded runs DO drift (proves the test is sensitive)', () => {
        const cfg = {
            ...DEFAULT_FOREX_SIM, trades: 300,
            seed: undefined, allowNonDeterministic: true,
        };
        const a = simulateForexMultiplier(cfg);
        const b = simulateForexMultiplier(cfg);
        expect(b.netPnL).not.toBe(a.netPnL);
    });

    it('portfolio simulation is reproducible', () => {
        const a = simulatePortfolio(['frxEURUSD', 'frxGBPUSD'], 150, 'pf-seed');
        const b = simulatePortfolio(['frxEURUSD', 'frxGBPUSD'], 150, 'pf-seed');
        expect(b.portfolio.netPnL).toBe(a.portfolio.netPnL);
        expect(b.portfolio.winRate).toBe(a.portfolio.winRate);
        expect(b.perSymbol.map(p => p.netPnL)).toEqual(a.perSymbol.map(p => p.netPnL));
    });

    it('each portfolio leg differs from the others (seeds are per-symbol)', () => {
        const r = simulatePortfolio(['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY'], 150, 'pf-seed');
        const pnls = r.perSymbol.map(p => p.netPnL);
        expect(new Set(pnls).size).toBe(pnls.length);
    });

    it('aggregates are finite — no NaN from empty input', () => {
        const empty = simulatePortfolio([], 100, 'pf-seed');
        expect(Number.isFinite(empty.portfolio.winRate)).toBe(true);
        expect(Number.isFinite(empty.portfolio.expectancy)).toBe(true);
        expect(Number.isFinite(empty.portfolio.profitFactor)).toBe(true);
        expect(empty.portfolio.winRate).toBe(0);
    });

    it('terminates on a pathological config (no infinite rejection loop)', () => {
        const start = Date.now();
        const r = simulateForexMultiplier({
            ...DEFAULT_FOREX_SIM, trades: 50,
            validationGate: 1000,          // impossible → every draw rejected
            seed: 'pathological',
        });
        expect(Date.now() - start).toBeLessThan(5_000);
        expect(Number.isFinite(r.netPnL)).toBe(true);
    });
});
