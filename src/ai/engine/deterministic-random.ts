/**
 * Deterministic Random — v5.5.5
 * =============================
 *
 * PURPOSE
 * -------
 * The expectancy simulator and the VIRTUAL-mode fallback used bare
 * `Math.random()`. That makes two guarantees impossible:
 *
 *   1. **Reproducibility** — the "positive expectancy" proof produced a
 *      different number on every run, so it could not be used as a gate or
 *      compared across releases.
 *   2. **Deterministic strategy validation** — the same historical data must
 *      always produce the same signals. `Math.random()` in the VIRTUAL path
 *      feeds `getVirtualWinRate()`, which in turn gates LIVE mode. A
 *      non-deterministic gate cannot be regression-tested.
 *
 * This module provides a seeded, dependency-free PRNG (mulberry32). It is
 * *not* cryptographic and must never be used for keys or tokens — it exists
 * purely so simulations and replays are byte-reproducible.
 *
 * Behavioural note: seeding does not change the statistical properties of the
 * simulator (mulberry32 passes the usual smoke tests for uniformity), so the
 * expectancy numbers remain representative — they merely stop drifting.
 */

/** A pure `() => [0,1)` generator. */
export type RandomFn = () => number;

/**
 * mulberry32 — 32-bit seeded PRNG.
 * Chosen because it is 6 lines, has no dependencies, passes basic uniformity
 * checks, and produces identical output in Node and every browser (no reliance
 * on Math.imul edge cases beyond the standard).
 */
export function mulberry32(seed: number): RandomFn {
    let a = seed >>> 0;
    return function next(): number {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Deterministic string → 32-bit seed (FNV-1a). Lets callers seed by symbol. */
export function hashSeed(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** Resolve a seed that may be a number, a string, or absent. */
export function resolveSeed(seed?: number | string, fallback = 0x5eed1234): number {
    if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
    if (typeof seed === 'string' && seed.length > 0) return hashSeed(seed);
    return fallback >>> 0;
}

/**
 * Build a RandomFn from an optional seed.
 * When `seed` is `undefined` **and** `allowNonDeterministic` is true, falls back
 * to `Math.random` so existing live behaviour is preserved unless a seed is
 * explicitly supplied.
 */
export function makeRandom(
    seed?: number | string,
    allowNonDeterministic = false,
): RandomFn {
    if (seed === undefined && allowNonDeterministic) return Math.random;
    return mulberry32(resolveSeed(seed));
}

/**
 * Box–Muller gaussian driven by an injected uniform source.
 * Kept as a standalone function (not a class method) so the simulator can swap
 * the source without touching call sites.
 */
export function gaussFrom(rand: RandomFn, mean: number, std: number): number {
    const u1 = Math.max(1e-9, rand());
    const u2 = rand();
    return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Deterministic monotonic clock for replays.
 * `Date.now()` inside a simulation makes journal entries and expectancy windows
 * unreproducible; this gives a stable, strictly increasing substitute.
 */
export function makeFakeClock(startMs = 1_700_000_000_000, stepMs = 1_000): () => number {
    let t = startMs;
    return () => {
        const v = t;
        t += stepMs;
        return v;
    };
}
