/**
 * Model-Drift Monitor — v5.2 (Priority 9)
 * ----------------------------------------
 * Watches the rolling LIVE win-rate and disables auto-execution if it falls
 * below a configurable floor over a meaningful sample. This catches model
 * decay (regime change, broker spread change, asset behaviour change) without
 * waiting for the kill switch to trip.
 *
 *   • Window: last `windowSize` closed live trades (default 30)
 *   • If observed WR < `minWinRate` (default 50 %) -> drift = TRUE
 *   • Engine reads `isDrifting()` before each new entry
 *
 * Resets when a clean run of `recoverySize` wins lands inside the window.
 */
export interface DriftConfig {
    windowSize:       number;   // 30
    minWinRate:       number;   // 0.50
    minSamplesArmed:  number;   // 15 (don't trip on tiny samples)
    recoverySize:     number;   // 5 consecutive wins to clear drift
}

export const DEFAULT_DRIFT_CONFIG: DriftConfig = {
    windowSize:      30,
    minWinRate:      0.50,
    minSamplesArmed: 15,
    recoverySize:    5,
};

export interface DriftSnapshot {
    drifting:        boolean;
    windowWinRate:   number;
    sample:          number;
    consecutiveWins: number;
    reason:          string;
}

interface Trade { won: boolean; ts: number; }

export class DriftMonitor {
    private trades: Trade[] = [];
    private drifting = false;
    private consecutiveWins = 0;

    constructor(public cfg: DriftConfig = DEFAULT_DRIFT_CONFIG) {}

    record(won: boolean) {
        this.trades.push({ won, ts: Date.now() });
        if (this.trades.length > this.cfg.windowSize) this.trades.shift();

        let justRecovered = false;
        if (won) {
            this.consecutiveWins++;
            if (this.drifting && this.consecutiveWins >= this.cfg.recoverySize) {
                this.drifting = false;
                justRecovered = true;
            }
        } else {
            this.consecutiveWins = 0;
        }

        // Re-evaluate drift state — but do NOT immediately re-trip in the same
        // tick that just cleared drift via a wins streak. The wins-streak
        // recovery is the user-visible signal that the model is healthy again;
        // the rolling WR will catch up on subsequent ticks.
        if (!this.drifting && !justRecovered && this.trades.length >= this.cfg.minSamplesArmed) {
            const wr = this.winRate();
            if (wr < this.cfg.minWinRate) this.drifting = true;
        }
    }

    private winRate(): number {
        if (!this.trades.length) return 0;
        const w = this.trades.filter(t => t.won).length;
        return w / this.trades.length;
    }

    isDrifting(): boolean { return this.drifting; }

    snapshot(): DriftSnapshot {
        const wr = this.winRate();
        return {
            drifting:        this.drifting,
            windowWinRate:   wr,
            sample:          this.trades.length,
            consecutiveWins: this.consecutiveWins,
            reason:          this.drifting
                ? `WR ${(wr*100).toFixed(0)}% < ${(this.cfg.minWinRate*100).toFixed(0)}% on n=${this.trades.length}`
                : 'healthy',
        };
    }

    reset() {
        this.trades = [];
        this.drifting = false;
        this.consecutiveWins = 0;
    }
}
