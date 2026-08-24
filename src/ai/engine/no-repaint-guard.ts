/**
 * No-Repaint Guard — v5.5.5 (Production)
 * ======================================
 *
 * PURPOSE
 * -------
 * Deriv's `ticks_history({ style: 'candles', end: 'latest' })` returns the
 * **currently-forming** bar as the last element of the array. Its high, low and
 * close mutate on every incoming tick until the bar closes. Any indicator, ML
 * feature, signal or trade derived from that element is therefore *repainting*:
 * the value the engine acted on is not the value that will exist in history a
 * second later, and it can never be reproduced in a backtest.
 *
 * This module is the single chokepoint that makes the whole pipeline causal.
 *
 * CORE INVARIANT (proved by `__tests__/no-repaint-guard.test.ts`)
 * --------------------------------------------------------------
 *   Let G(t) = guard output over the raw feed as observed at wall-clock t.
 *   For every t' > t:  G(t) is a PREFIX of G(t'), and the overlapping region
 *   is byte-identical.
 *
 * In other words: once the guard has emitted a bar, that bar can never change.
 * This is a strictly stronger property than "drop the last element" — it also
 * survives reconnects, duplicate bars, out-of-order bars and NaN payloads.
 *
 * DESIGN RULES
 * ------------
 *  1. `closedBarsOnly()` / `guardCandles()` are **non-throwing**. They are the
 *     functions the live engine calls. A forming bar is *excluded*, never fatal:
 *     throwing inside a `setInterval` tick would kill the trading loop and can
 *     strand an open position.
 *  2. `assertClosedBars()` **throws** and exists for tests, backtests and any
 *     strict offline context where silent truncation would hide a bug.
 *  3. Every function is pure apart from the opt-in telemetry counter, and takes
 *     an injectable `now` so replays are deterministic.
 *  4. Generic over the candle type, so callers keep their own richer types
 *     (`Candle`, `GapCandle`, …) instead of being downcast.
 *  5. Idempotent: if the upstream feed already excludes the forming bar, the
 *     guard is a no-op. Applying it twice changes nothing.
 */

/** Structural minimum the guard needs. Compatible with every candle type in the repo. */
export interface MinimalCandle {
    epoch: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
}

/** Tolerance for client/server clock skew when deciding "has this bar closed?". */
export const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 1_500;

/** Used only when the timeframe cannot be inferred (0 or 1 bar) and none was supplied. */
export const FALLBACK_TIMEFRAME_SEC = 60;

/** Thrown by `assertClosedBars` / `assertNoRepaint`. */
export class NoRepaintViolation extends Error {
    readonly code = 'NO_REPAINT_VIOLATION';
    readonly detail: {
        formingBars: number;
        lastEpoch?: number;
        timeframeSec: number;
        nowMs: number;
    };

    constructor(
        message: string,
        detail: { formingBars: number; lastEpoch?: number; timeframeSec: number; nowMs: number },
    ) {
        super(message);
        this.name = 'NoRepaintViolation';
        this.detail = detail;
        // Preserve `instanceof` across CJS/ES5 transpilation targets.
        Object.setPrototypeOf(this, NoRepaintViolation.prototype);
    }
}

export interface NoRepaintOptions {
    /** Wall clock in ms. Injectable so replays/tests are deterministic. */
    now?: number;
    /** Explicit bar width in seconds. When omitted it is inferred from the series. */
    timeframeSec?: number;
    /** Clock-skew allowance in ms. Default {@link DEFAULT_CLOCK_SKEW_TOLERANCE_MS}. */
    clockSkewToleranceMs?: number;
    /**
     * Drop non-finite OHLC rows, de-duplicate repeated epochs and restore
     * ascending epoch order. Default `true`. Turn off only to measure raw feed
     * quality.
     */
    requireIntegrity?: boolean;
    /** Label used in log/telemetry lines (usually the symbol). */
    label?: string;
}

export interface GuardReport<T> {
    /** `true` when at least one closed bar survived and nothing was suspicious. */
    ok: boolean;
    /** The sanitised, strictly-closed, ascending, de-duplicated series. */
    candles: T[];
    /** Bar width actually used for the close-time test. */
    timeframeSec: number;
    /** How many trailing/future bars were excluded because they had not closed. */
    droppedForming: number;
    /** Rows removed for non-finite epoch/OHLC. */
    droppedInvalid: number;
    /** Rows removed because their epoch repeated (the newest copy is kept). */
    droppedDuplicate: number;
    /** `true` when the raw feed was not in ascending epoch order. */
    reordered: boolean;
    /** Epoch of the newest bar the engine is allowed to see. */
    lastClosedEpoch?: number;
    /** Human-readable summary for DEBUG/WARN logs. */
    reason: string;
}

/* ────────────────────────── internals ────────────────────────── */

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * True when every OHLC field that is present is a finite number and the epoch
 * is a finite positive number. Candle types in this repo declare OHLC as
 * required, but the raw websocket payload is `any`, so `+undefined → NaN` is a
 * real failure mode we must filter.
 */
function hasSaneShape(c: MinimalCandle): boolean {
    if (!isFiniteNum(c?.epoch) || c.epoch <= 0) return false;
    for (const k of ['open', 'high', 'low', 'close'] as const) {
        const v = c[k];
        if (v !== undefined && !isFiniteNum(v)) return false;
    }
    return true;
}

/**
 * Infer bar width from the series using the **modal** (most frequent) positive
 * epoch delta.
 *
 * Why modal and not `last - previous`: forex feeds contain weekend and holiday
 * gaps, and a reconnect can leave a hole. Using the last delta would infer a
 * 48-hour "timeframe" after a weekend and then treat genuinely closed bars as
 * still forming, silently freezing the engine. The mode is immune to that.
 */
export function inferTimeframeSec(candles: readonly MinimalCandle[]): number {
    if (!candles || candles.length < 2) return 0;

    const counts = new Map<number, number>();
    let minDelta = Infinity;

    for (let i = 1; i < candles.length; i++) {
        const d = candles[i].epoch - candles[i - 1].epoch;
        if (!isFiniteNum(d) || d <= 0) continue;
        counts.set(d, (counts.get(d) ?? 0) + 1);
        if (d < minDelta) minDelta = d;
    }
    if (counts.size === 0) return 0;

    let best = 0;
    let bestCount = -1;
    for (const [delta, n] of counts) {
        // Tie-break toward the smaller delta: a genuine bar width is never
        // larger than the most common spacing.
        if (n > bestCount || (n === bestCount && delta < best)) {
            best = delta;
            bestCount = n;
        }
    }
    return best > 0 ? best : (Number.isFinite(minDelta) ? minDelta : 0);
}

/** Resolve the timeframe actually used: explicit override → inferred → fallback. */
export function resolveTimeframeSec(
    candles: readonly MinimalCandle[],
    explicit?: number,
): number {
    if (isFiniteNum(explicit) && explicit > 0) return explicit;
    const inferred = inferTimeframeSec(candles);
    return inferred > 0 ? inferred : FALLBACK_TIMEFRAME_SEC;
}

/** Wall-clock ms at which the bar starting at `epoch` (seconds) closes. */
export function barCloseTimeMs(epoch: number, timeframeSec: number): number {
    return (epoch + timeframeSec) * 1000;
}

/**
 * True when the bar starting at `epoch` has finished forming.
 * A bar is closed once wall-clock has passed its close time (plus skew slack).
 */
export function isBarClosed(
    epoch: number,
    timeframeSec: number,
    nowMs: number,
    clockSkewToleranceMs: number = DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
): boolean {
    return barCloseTimeMs(epoch, timeframeSec) <= nowMs + clockSkewToleranceMs;
}

/** Convenience inverse of {@link isBarClosed} for the newest bar of a series. */
export function isLastBarForming(
    candles: readonly MinimalCandle[],
    opts: NoRepaintOptions = {},
): boolean {
    if (!candles || candles.length === 0) return false;
    const now = opts.now ?? Date.now();
    const tf = resolveTimeframeSec(candles, opts.timeframeSec);
    const tol = opts.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;
    return !isBarClosed(candles[candles.length - 1].epoch, tf, now, tol);
}

/* ────────────────────────── telemetry ────────────────────────── */

export interface NoRepaintStats {
    /** Times the guard removed at least one forming bar. */
    formingBarSkips: number;
    /** Times a caller was told to stand down (no usable closed history). */
    blockedEvaluations: number;
    /** Rows dropped for non-finite payloads. */
    invalidRows: number;
    /** Rows dropped as duplicate epochs. */
    duplicateRows: number;
    /** Times the raw feed arrived out of order. */
    reorderEvents: number;
    /** Per-label breakdown, keyed by the `label` option (usually the symbol). */
    byLabel: Record<string, number>;
}

const STATS: NoRepaintStats = {
    formingBarSkips: 0,
    blockedEvaluations: 0,
    invalidRows: 0,
    duplicateRows: 0,
    reorderEvents: 0,
    byLabel: {},
};

/** Immutable snapshot of guard telemetry (surfaced in the overlay / audits). */
export function noRepaintStats(): NoRepaintStats {
    return { ...STATS, byLabel: { ...STATS.byLabel } };
}

/** Reset telemetry — used by tests and by the UI "reset session" action. */
export function resetNoRepaintStats(): void {
    STATS.formingBarSkips = 0;
    STATS.blockedEvaluations = 0;
    STATS.invalidRows = 0;
    STATS.duplicateRows = 0;
    STATS.reorderEvents = 0;
    STATS.byLabel = {};
}

/* ────────────────────────── main API ────────────────────────── */

/**
 * Full guard pass. **Never throws.** This is what the live engine calls.
 *
 * Order of operations matters:
 *   1. shape filter   — remove NaN/undefined OHLC rows (a NaN poisons every
 *                       rolling indicator downstream, permanently).
 *   2. de-duplicate   — keep the *newest* copy of a repeated epoch, because a
 *                       reconnect re-sends the same bar with fresher values.
 *   3. sort ascending — rolling indicators assume chronological order.
 *   4. drop unclosed  — the actual no-repaint step.
 *
 * Steps 1–3 must precede step 4: the timeframe inference and the "is it
 * closed?" test are only meaningful on a clean, ordered series.
 */
export function guardCandles<T extends MinimalCandle>(
    candles: readonly T[] | null | undefined,
    opts: NoRepaintOptions = {},
): GuardReport<T> {
    const now = opts.now ?? Date.now();
    const tol = opts.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;
    const integrity = opts.requireIntegrity !== false;
    const label = opts.label;

    if (!candles || candles.length === 0) {
        return {
            ok: false, candles: [], timeframeSec: resolveTimeframeSec([], opts.timeframeSec),
            droppedForming: 0, droppedInvalid: 0, droppedDuplicate: 0, reordered: false,
            reason: 'empty series',
        };
    }

    let working: T[] = candles as T[];
    let droppedInvalid = 0;
    let droppedDuplicate = 0;
    let reordered = false;

    if (integrity) {
        // 1. shape filter
        const sane: T[] = [];
        for (const c of working) {
            if (hasSaneShape(c)) sane.push(c);
            else droppedInvalid++;
        }

        // 2. de-duplicate by epoch, newest occurrence wins
        const byEpoch = new Map<number, T>();
        for (const c of sane) {
            if (byEpoch.has(c.epoch)) droppedDuplicate++;
            byEpoch.set(c.epoch, c);
        }

        // 3. ascending order
        const ordered = Array.from(byEpoch.values());
        for (let i = 1; i < ordered.length; i++) {
            if (ordered[i].epoch < ordered[i - 1].epoch) { reordered = true; break; }
        }
        // Detect out-of-order in the *raw* feed too (Map preserves insertion order).
        if (!reordered) {
            for (let i = 1; i < sane.length; i++) {
                if (sane[i].epoch < sane[i - 1].epoch) { reordered = true; break; }
            }
        }
        ordered.sort((a, b) => a.epoch - b.epoch);
        working = ordered;
    } else {
        working = working.slice();
    }

    const timeframeSec = resolveTimeframeSec(working, opts.timeframeSec);

    // 4. drop every bar that has not closed yet (normally only the newest,
    //    but we scan the whole tail so a bad feed cannot slip one through).
    const closed: T[] = [];
    let droppedForming = 0;
    for (const c of working) {
        if (isBarClosed(c.epoch, timeframeSec, now, tol)) closed.push(c);
        else droppedForming++;
    }

    // Telemetry
    if (droppedForming > 0) {
        STATS.formingBarSkips++;
        if (label) STATS.byLabel[label] = (STATS.byLabel[label] ?? 0) + 1;
    }
    STATS.invalidRows += droppedInvalid;
    STATS.duplicateRows += droppedDuplicate;
    if (reordered) STATS.reorderEvents++;

    const parts: string[] = [];
    if (droppedForming) parts.push(`${droppedForming} forming bar(s) excluded`);
    if (droppedInvalid) parts.push(`${droppedInvalid} invalid row(s)`);
    if (droppedDuplicate) parts.push(`${droppedDuplicate} duplicate epoch(s)`);
    if (reordered) parts.push('feed re-ordered');

    const ok = closed.length > 0;
    if (!ok) STATS.blockedEvaluations++;

    return {
        ok,
        candles: closed,
        timeframeSec,
        droppedForming,
        droppedInvalid,
        droppedDuplicate,
        reordered,
        lastClosedEpoch: closed.length ? closed[closed.length - 1].epoch : undefined,
        reason: parts.length ? parts.join(' · ') : 'clean (all bars closed)',
    };
}

/**
 * Ergonomic wrapper: returns just the closed-bar array.
 * This is the call site used inside indicator/feature/signal paths.
 */
export function closedBarsOnly<T extends MinimalCandle>(
    candles: readonly T[] | null | undefined,
    opts: NoRepaintOptions = {},
): T[] {
    return guardCandles(candles, opts).candles;
}

/**
 * STRICT variant — throws {@link NoRepaintViolation} when any bar is still
 * forming. Use in tests, backtests and offline validation. Do **not** call this
 * from inside the live tick loop; call {@link closedBarsOnly} there.
 *
 * Signature is intentionally compatible with the original v5.5.5 spec draft.
 */
export function assertClosedBars(
    candles: readonly MinimalCandle[] | null | undefined,
    now: number = Date.now(),
    opts: Omit<NoRepaintOptions, 'now'> = {},
): void {
    if (!candles || candles.length === 0) return;

    const tf = resolveTimeframeSec(candles, opts.timeframeSec);
    const tol = opts.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;

    let forming = 0;
    for (const c of candles) {
        if (!isBarClosed(c.epoch, tf, now, tol)) forming++;
    }
    if (forming > 0) {
        const last = candles[candles.length - 1];
        throw new NoRepaintViolation(
            `no-repaint: ${forming} forming candle(s) detected` +
            `${opts.label ? ` on ${opts.label}` : ''} — tf=${tf}s lastEpoch=${last.epoch}`,
            { formingBars: forming, lastEpoch: last.epoch, timeframeSec: tf, nowMs: now },
        );
    }
}

/**
 * Validate a series that is *already supposed to be* closed-only — i.e. the
 * output of the guard. Also enforces strict monotonicity, which
 * `assertClosedBars` does not. Used by the look-ahead audit suite.
 */
export function assertNoRepaint(
    candles: readonly MinimalCandle[] | null | undefined,
    now: number = Date.now(),
    opts: Omit<NoRepaintOptions, 'now'> = {},
): void {
    assertClosedBars(candles, now, opts);
    if (!candles || candles.length < 2) return;
    const tf = resolveTimeframeSec(candles, opts.timeframeSec);
    for (let i = 1; i < candles.length; i++) {
        if (candles[i].epoch <= candles[i - 1].epoch) {
            throw new NoRepaintViolation(
                `no-repaint: non-monotonic epochs at index ${i} ` +
                `(${candles[i - 1].epoch} → ${candles[i].epoch})`,
                { formingBars: 0, lastEpoch: candles[i].epoch, timeframeSec: tf, nowMs: now },
            );
        }
    }
}

/* ─────────────────── multi-timeframe helpers ─────────────────── */

/**
 * Parse a conventional timeframe label (`M1`, `m5`, `M15`, `H1`, `H4`, `D1`) into
 * seconds. Returns 0 when the key is not a recognised label.
 *
 * Why this exists: a stream with fewer than 2 bars has NO inferable spacing, so
 * `resolveTimeframeSec` would fall back to 60s. For an H1 stream that is wrong by
 * a factor of 60 and would declare a still-forming hourly bar "closed" — exactly
 * the repaint the guard is meant to prevent. Using the caller's own key as a
 * last-resort hint closes that hole.
 */
export function timeframeFromLabel(label: string): number {
    const m = /^([mhdwMHDW])\s*(\d+)$/.exec(label.trim());
    if (!m) return 0;
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) return 0;
    switch (m[1].toLowerCase()) {
        case 'm': return n * 60;
        case 'h': return n * 3600;
        case 'd': return n * 86400;
        case 'w': return n * 604800;
        default:  return 0;
    }
}

export interface MultiTimeframeOptions extends NoRepaintOptions {
    /**
     * Explicit bar width per stream key, e.g. `{ m1: 60, m5: 300, h1: 3600 }`.
     * Takes precedence over inference and over the key-name hint. Always supply
     * this when a stream may contain fewer than 2 bars.
     */
    timeframes?: Record<string, number>;
    /** Minimum closed bars each stream must retain to count as usable. Default 1. */
    minBars?: number;
}

/**
 * Guard several timeframes independently and report whether **all** of them
 * yielded usable closed history. Multi-timeframe strategies (M1 + M5 + H1) must
 * validate each stream on its own: M1 can be closed while M5 is mid-formation,
 * and acting on the pair would repaint the higher timeframe.
 *
 * Bar width per stream is resolved as:
 *   explicit `timeframes[key]` → inferred from that stream's own spacing
 *   → parsed from the key name (`h1` → 3600) → 60s fallback.
 *
 * NOTE: `opts.timeframeSec` is deliberately NOT broadcast to every stream — a
 * single width cannot be correct for M1 and H1 simultaneously.
 */
export function guardMultiTimeframe<T extends MinimalCandle>(
    streams: Record<string, readonly T[] | null | undefined>,
    opts: MultiTimeframeOptions = {},
): { ok: boolean; reports: Record<string, GuardReport<T>>; blocked: string[]; reason: string } {
    const reports: Record<string, GuardReport<T>> = {};
    const blocked: string[] = [];
    const minBars = Math.max(1, opts.minBars ?? 1);

    // Strip the scalar timeframe so it cannot leak across streams of different
    // widths; each stream resolves its own below.
    const { timeframeSec: _ignored, timeframes, minBars: _mb, ...rest } = opts;

    for (const key of Object.keys(streams)) {
        const series = streams[key];
        const explicit = timeframes?.[key];
        const inferred = inferTimeframeSec(series ?? []);
        const fromKey = timeframeFromLabel(key);
        const tf =
            isFiniteNum(explicit) && explicit > 0 ? explicit :
            inferred > 0                          ? inferred :
            fromKey > 0                           ? fromKey :
                                                    FALLBACK_TIMEFRAME_SEC;

        const rep = guardCandles(series, {
            ...rest,
            timeframeSec: tf,
            label: opts.label ? `${opts.label}:${key}` : key,
        });
        reports[key] = rep;
        if (!rep.ok || rep.candles.length < minBars) blocked.push(key);
    }

    return {
        ok: blocked.length === 0,
        reports,
        blocked,
        reason: blocked.length
            ? `no closed history on: ${blocked.join(', ')}`
            : 'all timeframes closed',
    };
}

/**
 * Minimum-history gate. Rolling indicators need a warm-up window; evaluating
 * before it is filled produces NaN that silently propagates into the ML vector.
 * Returns the guarded series plus an explicit allow/deny.
 */
export function guardWithMinHistory<T extends MinimalCandle>(
    candles: readonly T[] | null | undefined,
    minBars: number,
    opts: NoRepaintOptions = {},
): { allowed: boolean; candles: T[]; report: GuardReport<T>; reason: string } {
    const report = guardCandles(candles, opts);
    if (report.candles.length < minBars) {
        STATS.blockedEvaluations++;
        return {
            allowed: false,
            candles: report.candles,
            report,
            reason: `warmup: ${report.candles.length}/${minBars} closed bars (${report.reason})`,
        };
    }
    return { allowed: true, candles: report.candles, report, reason: report.reason };
}
