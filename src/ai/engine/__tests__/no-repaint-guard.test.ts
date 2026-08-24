/**
 * No-Repaint Guard — unit + property tests (v5.5.5)
 * =================================================
 * Covers the acceptance list from the integration spec:
 *   ✓ closed candle accepted
 *   ✓ forming candle rejected
 *   ✓ empty array
 *   ✓ single candle
 *   ✓ multiple timeframes
 *   ✓ historical replay (prefix-stability property)
 *   ✓ live websocket stream (bar mutating mid-formation)
 */
import {
    guardCandles, closedBarsOnly, assertClosedBars, assertNoRepaint,
    guardMultiTimeframe, guardWithMinHistory,
    isBarClosed, isLastBarForming, barCloseTimeMs,
    inferTimeframeSec, resolveTimeframeSec,
    noRepaintStats, resetNoRepaintStats,
    NoRepaintViolation, DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
    FALLBACK_TIMEFRAME_SEC, timeframeFromLabel,
    MinimalCandle,
} from '../no-repaint-guard';

/** Build `n` M1 bars whose LAST bar closed exactly at `endEpoch + 60`. */
function bars(n: number, startEpoch = 1_700_000_000, tf = 60): MinimalCandle[] {
    const out: MinimalCandle[] = [];
    for (let i = 0; i < n; i++) {
        const epoch = startEpoch + i * tf;
        const base = 100 + i * 0.1;
        out.push({ epoch, open: base, high: base + 0.5, low: base - 0.5, close: base + 0.2 });
    }
    return out;
}

/** Wall clock at which bar index `i` of the series has just closed. */
const closedAt = (cs: MinimalCandle[], i: number, tf = 60) => (cs[i].epoch + tf) * 1000;

beforeEach(() => resetNoRepaintStats());

describe('timeframe inference', () => {
    it('infers M1 / M5 / H1 from spacing', () => {
        expect(inferTimeframeSec(bars(10, 1_700_000_000, 60))).toBe(60);
        expect(inferTimeframeSec(bars(10, 1_700_000_000, 300))).toBe(300);
        expect(inferTimeframeSec(bars(10, 1_700_000_000, 3600))).toBe(3600);
    });

    it('is robust to a weekend gap (uses the MODE, not the last delta)', () => {
        // 20 normal M1 bars, then a 48h hole, then 5 more M1 bars.
        const a = bars(20, 1_700_000_000, 60);
        const b = bars(5, 1_700_000_000 + 20 * 60 + 172_800, 60);
        const merged = [...a, ...b];
        // A naive `last - previous` would infer 60 here anyway, so also check the
        // pathological ordering where the gap is at the very end.
        expect(inferTimeframeSec(merged)).toBe(60);

        const gapAtEnd = [...bars(20, 1_700_000_000, 60),
                          { epoch: 1_700_000_000 + 20 * 60 + 172_800, open: 1, high: 1, low: 1, close: 1 }];
        expect(inferTimeframeSec(gapAtEnd)).toBe(60);
    });

    it('falls back to 60s when inference is impossible', () => {
        expect(resolveTimeframeSec([])).toBe(FALLBACK_TIMEFRAME_SEC);
        expect(resolveTimeframeSec(bars(1))).toBe(FALLBACK_TIMEFRAME_SEC);
    });

    it('honours an explicit override', () => {
        expect(resolveTimeframeSec(bars(10, 1_700_000_000, 60), 300)).toBe(300);
    });
});

describe('isBarClosed', () => {
    it('closes a bar at exactly epoch + timeframe', () => {
        const epoch = 1_700_000_000;
        expect(isBarClosed(epoch, 60, barCloseTimeMs(epoch, 60), 0)).toBe(true);
        expect(isBarClosed(epoch, 60, barCloseTimeMs(epoch, 60) - 1, 0)).toBe(false);
    });

    it('tolerates client clock skew', () => {
        const epoch = 1_700_000_000;
        const justBefore = barCloseTimeMs(epoch, 60) - 1_000;
        expect(isBarClosed(epoch, 60, justBefore, 0)).toBe(false);
        expect(isBarClosed(epoch, 60, justBefore, DEFAULT_CLOCK_SKEW_TOLERANCE_MS)).toBe(true);
    });
});

describe('✓ closed candle accepted', () => {
    it('passes a fully-closed series through unchanged', () => {
        const cs = bars(50);
        const now = closedAt(cs, 49) + 5_000;   // well after the last bar closed
        const rep = guardCandles(cs, { now, timeframeSec: 60 });

        expect(rep.ok).toBe(true);
        expect(rep.candles).toHaveLength(50);
        expect(rep.droppedForming).toBe(0);
        expect(rep.candles).toEqual(cs);
        expect(rep.reason).toMatch(/clean/);
        expect(() => assertClosedBars(cs, now, { timeframeSec: 60 })).not.toThrow();
    });
});

describe('✓ forming candle rejected', () => {
    it('excludes the last bar while it is still forming', () => {
        const cs = bars(50);
        // 30s into the final bar: it has NOT closed.
        const now = cs[49].epoch * 1000 + 30_000;

        expect(isLastBarForming(cs, { now, timeframeSec: 60 })).toBe(true);

        const rep = guardCandles(cs, { now, timeframeSec: 60 });
        expect(rep.droppedForming).toBe(1);
        expect(rep.candles).toHaveLength(49);
        expect(rep.candles[rep.candles.length - 1].epoch).toBe(cs[48].epoch);
        expect(rep.reason).toMatch(/forming/);
    });

    it('assertClosedBars THROWS NoRepaintViolation on a forming bar', () => {
        const cs = bars(50);
        const now = cs[49].epoch * 1000 + 30_000;
        expect(() => assertClosedBars(cs, now, { timeframeSec: 60 })).toThrow(NoRepaintViolation);
        try {
            assertClosedBars(cs, now, { timeframeSec: 60, label: 'frxEURUSD' });
        } catch (e: any) {
            expect(e.code).toBe('NO_REPAINT_VIOLATION');
            expect(e.detail.formingBars).toBe(1);
            expect(e.message).toContain('frxEURUSD');
        }
    });

    it('closedBarsOnly never throws (live-loop safety)', () => {
        const cs = bars(50);
        const now = cs[49].epoch * 1000 + 1;
        expect(() => closedBarsOnly(cs, { now, timeframeSec: 60 })).not.toThrow();
        expect(closedBarsOnly(cs, { now, timeframeSec: 60 })).toHaveLength(49);
    });

    it('drops MULTIPLE future-dated bars, not just the newest', () => {
        const cs = bars(50);
        const now = cs[45].epoch * 1000 + 30_000;    // bars 45..49 not closed
        const rep = guardCandles(cs, { now, timeframeSec: 60 });
        expect(rep.droppedForming).toBe(5);
        expect(rep.candles).toHaveLength(45);
    });
});

describe('✓ empty array / ✓ single candle', () => {
    it('empty array is safe and reports not-ok', () => {
        const rep = guardCandles([], { now: 1_700_000_000_000 });
        expect(rep.ok).toBe(false);
        expect(rep.candles).toEqual([]);
        expect(rep.reason).toBe('empty series');
        expect(() => assertClosedBars([], 1_700_000_000_000)).not.toThrow();
        expect(() => assertClosedBars(null as any)).not.toThrow();
        expect(() => assertClosedBars(undefined as any)).not.toThrow();
        expect(closedBarsOnly(null)).toEqual([]);
        expect(closedBarsOnly(undefined)).toEqual([]);
    });

    it('single closed candle survives', () => {
        const cs = bars(1);
        const now = closedAt(cs, 0) + 1_000;
        const rep = guardCandles(cs, { now, timeframeSec: 60 });
        expect(rep.ok).toBe(true);
        expect(rep.candles).toHaveLength(1);
    });

    it('single forming candle is removed', () => {
        const cs = bars(1);
        const now = cs[0].epoch * 1000 + 1_000;
        const rep = guardCandles(cs, { now, timeframeSec: 60 });
        expect(rep.ok).toBe(false);
        expect(rep.candles).toHaveLength(0);
    });
});

describe('integrity: NaN, duplicates, ordering', () => {
    it('drops rows with non-finite OHLC (a NaN poisons every rolling indicator)', () => {
        const cs: MinimalCandle[] = [
            ...bars(5),
            { epoch: 1_700_000_300, open: NaN, high: 1, low: 1, close: 1 },
            { epoch: 1_700_000_360, open: 1, high: 1, low: 1, close: Number.POSITIVE_INFINITY },
        ];
        const now = (1_700_000_360 + 60) * 1000 + 1_000;
        const rep = guardCandles(cs, { now, timeframeSec: 60 });
        expect(rep.droppedInvalid).toBe(2);
        expect(rep.candles.every(c => Number.isFinite(c.close))).toBe(true);
    });

    it('collapses duplicate epochs from a reconnect, keeping the NEWEST payload', () => {
        const cs = bars(5);
        const dupe = { ...cs[4], close: 999 };       // re-sent with fresher data
        const now = closedAt(cs, 4) + 1_000;
        const rep = guardCandles([...cs, dupe], { now, timeframeSec: 60 });
        expect(rep.droppedDuplicate).toBe(1);
        expect(rep.candles).toHaveLength(5);
        expect(rep.candles[4].close).toBe(999);
    });

    it('restores ascending order on an out-of-order feed', () => {
        const cs = bars(5);
        const shuffled = [cs[3], cs[0], cs[4], cs[1], cs[2]];
        const now = closedAt(cs, 4) + 1_000;
        const rep = guardCandles(shuffled, { now, timeframeSec: 60 });
        expect(rep.reordered).toBe(true);
        expect(rep.candles.map(c => c.epoch)).toEqual(cs.map(c => c.epoch));
    });

    it('is IDEMPOTENT — guarding twice changes nothing', () => {
        const cs = bars(50);
        const now = cs[49].epoch * 1000 + 30_000;
        const once = closedBarsOnly(cs, { now, timeframeSec: 60 });
        const twice = closedBarsOnly(once, { now, timeframeSec: 60 });
        expect(twice).toEqual(once);
    });
});

describe('✓ multiple timeframes', () => {
    it('validates each stream independently', () => {
        const m1 = bars(60, 1_700_000_000, 60);
        const m5 = bars(60, 1_700_000_000, 300);
        // Pick a moment where M1's last bar HAS closed but M5's has NOT.
        const now = (m1[59].epoch + 60) * 1000 + 1_000;

        const res = guardMultiTimeframe({ m1, m5 }, { now });
        expect(res.reports.m1.droppedForming).toBe(0);
        expect(res.reports.m5.droppedForming).toBeGreaterThan(0);
        // Both still have usable closed history, so overall ok.
        expect(res.ok).toBe(true);
    });

    it('blocks when a timeframe has NO closed history at all', () => {
        const m1 = bars(60, 1_700_000_000, 60);
        const now = (m1[59].epoch + 60) * 1000 + 1_000;

        // A single H1 bar that opened ~1s ago, i.e. genuinely mid-formation.
        // NOTE: it must NOT start at 1_700_000_000 — 60 M1 bars span exactly
        // 3600s, so such an H1 bar would close at the very same instant as the
        // last M1 bar and would (correctly) be reported as closed.
        const h1 = [{ epoch: 1_700_003_600, open: 1, high: 2, low: 0.5, close: 1.5 }];

        const res = guardMultiTimeframe({ m1, h1 }, { now, timeframes: { h1: 3600 } });
        expect(res.ok).toBe(false);
        expect(res.blocked).toContain('h1');
        expect(res.reason).toMatch(/h1/);
        expect(res.reports.m1.ok).toBe(true);
    });

    it('infers a single-bar stream\'s width from its KEY NAME, not the 60s fallback', () => {
        // Regression test for a real bug: a stream with <2 bars has no inferable
        // spacing, so it fell back to 60s. For an H1 stream that is wrong by 60x
        // and would declare a forming hourly bar "closed" — the exact repaint the
        // guard exists to prevent.
        const h1 = [{ epoch: 1_700_003_600, open: 1, high: 2, low: 0.5, close: 1.5 }];
        const now = (1_700_003_600 + 60) * 1000 + 1_000;   // 1 min in: M1 would be closed

        // Without the key hint this would wrongly pass as closed.
        const res = guardMultiTimeframe({ h1 }, { now });
        expect(res.ok).toBe(false);
        expect(res.reports.h1.timeframeSec).toBe(3600);
    });

    it('parses conventional timeframe labels', () => {
        expect(timeframeFromLabel('M1')).toBe(60);
        expect(timeframeFromLabel('m5')).toBe(300);
        expect(timeframeFromLabel('M15')).toBe(900);
        expect(timeframeFromLabel('H1')).toBe(3600);
        expect(timeframeFromLabel('h4')).toBe(14_400);
        expect(timeframeFromLabel('D1')).toBe(86_400);
        expect(timeframeFromLabel('W1')).toBe(604_800);
        expect(timeframeFromLabel('nonsense')).toBe(0);
        expect(timeframeFromLabel('M0')).toBe(0);
    });

    it('explicit per-stream timeframes take precedence over inference', () => {
        // Series spaced 60s apart but declared as M5 — explicit wins.
        const s = bars(10, 1_700_000_000, 60);
        const now = (s[9].epoch + 60) * 1000 + 1_000;
        const res = guardMultiTimeframe({ s }, { now, timeframes: { s: 300 } });
        expect(res.reports.s.timeframeSec).toBe(300);
        // Under a 300s width the newest bars have not closed yet.
        expect(res.reports.s.droppedForming).toBeGreaterThan(0);
    });

    it('enforces minBars per stream', () => {
        const m1 = bars(60, 1_700_000_000, 60);
        const now = (m1[59].epoch + 60) * 1000 + 1_000;
        expect(guardMultiTimeframe({ m1 }, { now, minBars: 40 }).ok).toBe(true);
        expect(guardMultiTimeframe({ m1 }, { now, minBars: 500 }).ok).toBe(false);
    });
});

describe('warm-up gate', () => {
    it('denies until the minimum closed-bar count is met', () => {
        const cs = bars(45);
        const now = cs[44].epoch * 1000 + 30_000;   // last bar forming → 44 closed
        expect(guardWithMinHistory(cs, 40, { now, timeframeSec: 60 }).allowed).toBe(true);
        expect(guardWithMinHistory(cs, 50, { now, timeframeSec: 60 }).allowed).toBe(false);
        expect(guardWithMinHistory(cs, 50, { now, timeframeSec: 60 }).reason).toMatch(/warmup/);
    });
});

describe('✓ live websocket stream — the actual repaint scenario', () => {
    it('output is UNCHANGED while the newest bar mutates tick-by-tick', () => {
        const history = bars(50);
        const formingEpoch = history[49].epoch + 60;
        const midBar = formingEpoch * 1000 + 20_000;

        // Same forming bar observed three times with different high/low/close,
        // exactly as Deriv streams it.
        const snapshots = [
            { epoch: formingEpoch, open: 105, high: 105.2, low: 104.9, close: 105.1 },
            { epoch: formingEpoch, open: 105, high: 106.8, low: 104.9, close: 106.5 },
            { epoch: formingEpoch, open: 105, high: 106.8, low: 103.1, close: 103.4 },
        ];

        const outputs = snapshots.map(s =>
            closedBarsOnly([...history, s], { now: midBar, timeframeSec: 60 }));

        // The guard's view is identical across all three mutations.
        expect(outputs[1]).toEqual(outputs[0]);
        expect(outputs[2]).toEqual(outputs[0]);
        expect(outputs[0]).toHaveLength(50);
        expect(outputs[0][49].epoch).toBe(history[49].epoch);
    });
});

describe('✓ historical replay — PREFIX-STABILITY property', () => {
    /**
     * THE core invariant: for any two observation times t1 < t2, the guarded
     * output at t1 must be an exact prefix of the guarded output at t2. If it
     * is not, some already-emitted bar changed → repaint.
     */
    it('every earlier view is an exact prefix of every later view', () => {
        const tf = 60;
        const full = bars(200, 1_700_000_000, tf);

        const views: MinimalCandle[][] = [];
        // Walk wall-clock forward in 7-second steps across the whole series.
        for (let ms = full[0].epoch * 1000; ms <= (full[199].epoch + tf) * 1000; ms += 7_000) {
            // Simulate the feed: everything up to "now", with the current bar forming.
            const visible = full.filter(c => c.epoch * 1000 <= ms);
            views.push(closedBarsOnly(visible, { now: ms, timeframeSec: tf }));
        }

        for (let i = 1; i < views.length; i++) {
            const prev = views[i - 1];
            const cur = views[i];
            expect(cur.length).toBeGreaterThanOrEqual(prev.length);
            // Overlapping region must be byte-identical.
            expect(cur.slice(0, prev.length)).toEqual(prev);
        }
        // And the final view must be strictly monotonic + fully closed.
        const finalNow = (full[199].epoch + tf) * 1000 + 1_000;
        expect(() => assertNoRepaint(views[views.length - 1], finalNow, { timeframeSec: tf }))
            .not.toThrow();
    });

    it('assertNoRepaint catches non-monotonic epochs that assertClosedBars allows', () => {
        const cs = bars(5);
        const broken = [cs[0], cs[1], cs[1], cs[2]];   // repeated epoch
        const now = closedAt(cs, 4) + 1_000;
        expect(() => assertClosedBars(broken, now, { timeframeSec: 60 })).not.toThrow();
        expect(() => assertNoRepaint(broken, now, { timeframeSec: 60 })).toThrow(NoRepaintViolation);
    });
});

describe('telemetry', () => {
    it('counts skips, invalid rows and duplicates', () => {
        resetNoRepaintStats();
        const cs = bars(50);
        const now = cs[49].epoch * 1000 + 10_000;

        guardCandles(cs, { now, timeframeSec: 60, label: 'frxEURUSD' });
        guardCandles(cs, { now, timeframeSec: 60, label: 'frxEURUSD' });

        const s = noRepaintStats();
        expect(s.formingBarSkips).toBe(2);
        expect(s.byLabel['frxEURUSD']).toBe(2);

        resetNoRepaintStats();
        expect(noRepaintStats().formingBarSkips).toBe(0);
    });

    it('snapshot is a copy, not a live reference', () => {
        resetNoRepaintStats();
        const a = noRepaintStats();
        const cs = bars(10);
        guardCandles(cs, { now: cs[9].epoch * 1000 + 1_000, timeframeSec: 60, label: 'X' });
        expect(a.formingBarSkips).toBe(0);          // unchanged
        expect(noRepaintStats().formingBarSkips).toBe(1);
    });
});
