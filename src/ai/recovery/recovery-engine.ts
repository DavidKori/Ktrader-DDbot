/**
 * Recovery Engine
 * ---------------
 * After consecutive losses the system enters a defensive "recovery" state:
 *
 *   • Minimum confidence floor temporarily raised
 *   • Stake multiplier temporarily reduced
 *   • New entries blocked during cooldown window
 *   • Returns to normal once a streak of wins is observed
 *
 * Stateful, owned by the Orchestrator.
 */
export interface RecoveryConfig {
    /** Losses to enter recovery. */
    enterAtConsecutiveLosses: number;       // default 2
    /** Wins required to exit recovery. */
    exitAtConsecutiveWins: number;          // default 3
    /** Confidence floor while in recovery (overrides 0.75 default). */
    recoveryMinConfidence: number;          // default 0.85
    /** Stake multiplier while in recovery. */
    recoveryStakeMultiplier: number;        // default 0.5
    /** Cooldown in ms after entering recovery — no new entries allowed. */
    cooldownMs: number;                     // default 60_000
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
    enterAtConsecutiveLosses: 2,
    exitAtConsecutiveWins: 3,
    recoveryMinConfidence: 0.85,
    recoveryStakeMultiplier: 0.5,
    cooldownMs: 60_000,
};

export interface RecoverySnapshot {
    active: boolean;
    inCooldown: boolean;
    cooldownRemainingMs: number;
    minConfidence: number | null;   // null if not active
    stakeMultiplier: number;        // 1.0 if not active
    reason: string;
}

export class RecoveryEngine {
    private cfg: RecoveryConfig;
    private active = false;
    private cooldownUntil = 0;
    private consecutiveLosses = 0;
    private consecutiveWins   = 0;

    constructor(cfg: Partial<RecoveryConfig> = {}) {
        this.cfg = { ...DEFAULT_RECOVERY_CONFIG, ...cfg };
    }

    /** Call after every closed trade. Returns the new snapshot. */
    recordTrade(won: boolean): RecoverySnapshot {
        if (won) {
            this.consecutiveWins++;
            this.consecutiveLosses = 0;
            if (this.active && this.consecutiveWins >= this.cfg.exitAtConsecutiveWins) {
                this.active = false;
            }
        } else {
            this.consecutiveLosses++;
            this.consecutiveWins = 0;
            if (!this.active && this.consecutiveLosses >= this.cfg.enterAtConsecutiveLosses) {
                this.active = true;
                this.cooldownUntil = Date.now() + this.cfg.cooldownMs;
            }
        }
        return this.snapshot();
    }

    /** Read-only state. */
    snapshot(): RecoverySnapshot {
        const inCooldown = Date.now() < this.cooldownUntil;
        return {
            active: this.active,
            inCooldown,
            cooldownRemainingMs: Math.max(0, this.cooldownUntil - Date.now()),
            minConfidence: this.active ? this.cfg.recoveryMinConfidence : null,
            stakeMultiplier: this.active ? this.cfg.recoveryStakeMultiplier : 1.0,
            reason: this.active
                ? (inCooldown
                    ? `recovery cooldown ${(this.cooldownRemainingSec()).toFixed(0)}s`
                    : `recovery active — min conf ≥ ${(this.cfg.recoveryMinConfidence * 100).toFixed(0)}%`)
                : 'normal',
        };
    }

    private cooldownRemainingSec(): number {
        return Math.max(0, this.cooldownUntil - Date.now()) / 1000;
    }

    /** True if a new entry is blocked due to cooldown. */
    isBlocked(): boolean {
        return this.active && Date.now() < this.cooldownUntil;
    }

    /** Allow caller to override the confidence floor with the recovery one. */
    effectiveMinConfidence(baseFloor: number): number {
        return this.active ? Math.max(baseFloor, this.cfg.recoveryMinConfidence) : baseFloor;
    }

    /** Scale stake by the recovery multiplier (1.0 when inactive). */
    scaleStake(stake: number): number {
        return this.active ? stake * this.cfg.recoveryStakeMultiplier : stake;
    }

    reset() {
        this.active = false;
        this.cooldownUntil = 0;
        this.consecutiveLosses = 0;
        this.consecutiveWins   = 0;
    }
}
