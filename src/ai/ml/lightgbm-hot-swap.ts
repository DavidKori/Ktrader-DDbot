/**
 * LightGBM Hot-Swap Loader — v5.4
 * ================================
 * Auto-update mechanism for the LightGBM model. Whenever a new model
 * revision is announced (via config-endpoint poll, WS "model_update"
 * event, or manual trigger), the loader:
 *
 *   1. Fetches the new model bytes to a STAGING slot.
 *   2. Validates it (schema, feature-count, sanity-inference on a
 *      canned input).
 *   3. Atomically swaps the ACTIVE reference to the new model.
 *   4. Any in-flight prediction still uses the old model reference
 *      (JavaScript closure captures) → NO interruption to trades.
 *   5. Old model is GC'd after all references drop.
 *
 * Anti-corruption safeguards:
 *   - Schema check (expected feature count) must pass before swap.
 *   - Rollback slot retains previous ACTIVE model; if the new model
 *     produces a suspicious prediction distribution (all-same output,
 *     NaN, out of [0,1]) within the first K predictions, we auto-roll
 *     back and emit a warning.
 *   - Version + checksum tracked for auditability.
 */

export interface LightGBMModel {
    version: string;
    checksum: string;
    featureCount: number;
    /** Predict probability of positive outcome for a feature row. */
    predict: (features: number[]) => number;
}

export interface HotSwapListener {
    (event: {
        type: 'staged' | 'validated' | 'activated' | 'rejected' | 'rolled_back';
        version: string;
        reason?: string;
    }): void;
}

export interface HotSwapConfig {
    canaryPredictions: number;      // how many live preds to sanity-check after swap
    minValidPredRatio: number;      // e.g. 0.9 must be in [0,1] and non-constant
}

const DEFAULT_HS_CFG: HotSwapConfig = {
    canaryPredictions: 25,
    minValidPredRatio: 0.9,
};

export class LightGBMHotSwap {
    private active: LightGBMModel | null = null;
    private previous: LightGBMModel | null = null;
    private staged:   LightGBMModel | null = null;
    private listeners = new Set<HotSwapListener>();
    private canaryCount = 0;
    private canarySuspicious = 0;
    private canaryPreds: number[] = [];
    private cfg: HotSwapConfig;

    constructor(cfg?: Partial<HotSwapConfig>) {
        this.cfg = { ...DEFAULT_HS_CFG, ...cfg };
    }

    subscribe(fn: HotSwapListener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private emit(e: Parameters<HotSwapListener>[0]) {
        this.listeners.forEach(l => { try { l(e); } catch { /* noop */ } });
    }

    /** Initial (or forced) install. */
    install(m: LightGBMModel): void {
        this.previous = this.active;
        this.active = m;
        this.canaryCount = 0;
        this.canarySuspicious = 0;
        this.canaryPreds = [];
        this.emit({ type: 'activated', version: m.version, reason: 'initial install' });
    }

    /** Stage a candidate model. Runs validation before letting it become active. */
    stage(m: LightGBMModel, expectedFeatureCount?: number): boolean {
        // Schema check
        if (expectedFeatureCount && m.featureCount !== expectedFeatureCount) {
            this.emit({ type: 'rejected', version: m.version, reason: `feature count ${m.featureCount} != ${expectedFeatureCount}` });
            return false;
        }
        // Sanity inference on a canned row
        try {
            const canned = new Array(m.featureCount).fill(0.5);
            const p = m.predict(canned);
            if (!Number.isFinite(p) || p < 0 || p > 1) {
                this.emit({ type: 'rejected', version: m.version, reason: `sanity pred out of range: ${p}` });
                return false;
            }
        } catch (e: any) {
            this.emit({ type: 'rejected', version: m.version, reason: `sanity error: ${e?.message}` });
            return false;
        }
        this.staged = m;
        this.emit({ type: 'staged', version: m.version });
        return true;
    }

    /** Atomically activate the staged model. Old model retained for rollback. */
    activate(): boolean {
        if (!this.staged) return false;
        this.previous = this.active;
        this.active = this.staged;
        this.staged = null;
        this.canaryCount = 0;
        this.canarySuspicious = 0;
        this.canaryPreds = [];
        this.emit({ type: 'activated', version: this.active.version });
        return true;
    }

    /** Manual rollback to the previous model (immediate). */
    rollback(reason: string): boolean {
        if (!this.previous) return false;
        this.active = this.previous;
        this.previous = null;
        this.emit({ type: 'rolled_back', version: this.active.version, reason });
        return true;
    }

    /**
     * Get the current active model reference. This is what any prediction
     * caller should use. If the reference is captured in a closure at the
     * start of an operation, later hot-swaps don't disturb it.
     */
    getActive(): LightGBMModel | null {
        return this.active;
    }

    /**
     * Predict wrapper — records canary stats to auto-rollback if the new
     * model is misbehaving.
     */
    predict(features: number[]): number {
        if (!this.active) throw new Error('LightGBM: no active model');
        const p = this.active.predict(features);
        // Canary tracking during the first N predictions after a swap
        if (this.canaryCount < this.cfg.canaryPredictions) {
            this.canaryCount += 1;
            if (!Number.isFinite(p) || p < 0 || p > 1) this.canarySuspicious += 1;
            this.canaryPreds.push(p);
            if (this.canaryCount === this.cfg.canaryPredictions) {
                // Distribution check: all-same → suspicious
                const uniq = new Set(this.canaryPreds.map(x => Math.round(x * 100))).size;
                if (uniq < 3) this.canarySuspicious += Math.floor(this.canaryPreds.length / 2);
                const badRatio = this.canarySuspicious / this.canaryPreds.length;
                if (badRatio > (1 - this.cfg.minValidPredRatio)) {
                    this.rollback(`canary bad-ratio ${(badRatio * 100).toFixed(0)}%`);
                }
            }
        }
        return p;
    }

    get status(): { active?: string; previous?: string; staged?: string; canaryCount: number } {
        return {
            active: this.active?.version,
            previous: this.previous?.version,
            staged: this.staged?.version,
            canaryCount: this.canaryCount,
        };
    }
}
