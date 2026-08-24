/**
 * Kill-Switch Engine — v5.2 (Priority 3)
 * --------------------------------------
 * Watches multiple failure signals and forces the orchestrator to stop:
 *
 *   • consecutiveLosses >= 4
 *   • signal storm: >100 signals in 60 seconds (ML thrash)
 *   • reconnectCount > 5
 *   • engine health DEGRADED for > 60 s
 *
 * Engine state is one of: ARMED · TRIPPED.
 * Once TRIPPED, the orchestrator must call reset() before any new entries.
 */
export interface KillSwitchConfig {
    maxConsecutiveLosses:    number;   // 4
    maxSignalsPerMinute:     number;   // 100
    maxReconnects:           number;   // 5
    maxDegradedMs:           number;   // 60_000
}

export const DEFAULT_KILL_CONFIG: KillSwitchConfig = {
    maxConsecutiveLosses: 4,
    maxSignalsPerMinute:  100,
    maxReconnects:        5,
    maxDegradedMs:        60_000,
};

export type KillTrigger =
    | 'CONSECUTIVE_LOSSES'
    | 'SIGNAL_STORM'
    | 'CONNECTION_INSTABILITY'
    | 'DEGRADED_TIMEOUT'
    | 'MANUAL';

export interface KillState {
    tripped:   boolean;
    trigger?:  KillTrigger;
    reason?:   string;
    trippedAt?: number;
}

export class KillSwitch {
    private state: KillState = { tripped: false };
    private signalTimestamps: number[] = [];
    private degradedSince:    number = 0;
    constructor(public cfg: KillSwitchConfig = DEFAULT_KILL_CONFIG) {}

    get tripped() { return this.state.tripped; }
    snapshot(): KillState { return { ...this.state }; }

    /** Call on every signal emission (regardless of mode). */
    onSignal() {
        const now = Date.now();
        this.signalTimestamps.push(now);
        const minuteAgo = now - 60_000;
        // Compact older entries
        if (this.signalTimestamps[0] < minuteAgo) {
            this.signalTimestamps = this.signalTimestamps.filter(t => t >= minuteAgo);
        }
        if (this.signalTimestamps.length >= this.cfg.maxSignalsPerMinute) {
            this.trip('SIGNAL_STORM',
                `${this.signalTimestamps.length} signals in 60s (max ${this.cfg.maxSignalsPerMinute})`);
        }
    }

    /** Called after every closed live trade. */
    onLiveResult(won: boolean, consecutiveLosses: number) {
        if (won) return;
        if (consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
            this.trip('CONSECUTIVE_LOSSES',
                `${consecutiveLosses} consecutive losses (max ${this.cfg.maxConsecutiveLosses})`);
        }
    }

    /** Called by deriv-client on every reconnect attempt. */
    onReconnect(totalReconnects: number) {
        if (totalReconnects > this.cfg.maxReconnects) {
            this.trip('CONNECTION_INSTABILITY',
                `${totalReconnects} reconnect attempts (max ${this.cfg.maxReconnects})`);
        }
    }

    /** Called periodically with the deriv-client status. */
    onHealthTick(status: string) {
        const now = Date.now();
        if (status === 'DEGRADED' || status === 'RECONNECTING' || status === 'DISCONNECTED') {
            if (!this.degradedSince) this.degradedSince = now;
            if (now - this.degradedSince >= this.cfg.maxDegradedMs) {
                this.trip('DEGRADED_TIMEOUT',
                    `connection ${status} for ${((now - this.degradedSince)/1000).toFixed(0)}s`);
            }
        } else {
            this.degradedSince = 0;
        }
    }

    /** Manual emergency-stop button. */
    tripManual(reason = 'manual stop') {
        this.trip('MANUAL', reason);
    }

    private trip(trigger: KillTrigger, reason: string) {
        if (this.state.tripped) return;
        this.state = { tripped: true, trigger, reason, trippedAt: Date.now() };
    }

    reset() {
        this.state = { tripped: false };
        this.signalTimestamps = [];
        this.degradedSince = 0;
    }
}
