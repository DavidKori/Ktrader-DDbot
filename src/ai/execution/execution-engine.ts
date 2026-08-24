/**
 * Execution Engine — dual-mode mode selector + stake controller.
 * --------------------------------------------------------------
 *
 *   confidence < 75              →  VIRTUAL
 *   confidence ≥ 75 + val ≥ 70   →  LIVE        stake = baseStake (no martingale)
 *   confidence ≥ 95 + val ≥ 85   →  LIVE_MART   martingale 1× → 3× → 9× (max 3 levels)
 *
 *   All thresholds come from `src/ai/config/execution-thresholds.ts` — single
 *   source of truth. No magic numbers in this file.
 *
 *   Auto-fallback to VIRTUAL when:
 *     • virtualWinRate < 70%  (n ≥ 5)
 *     • consecutiveLosses ≥ 2
 *     • dailyDrawdown ≥ limit
 *     • marketRegime UNSTABLE
 *     • validationScore < liveValidation (70)
 *
 *   baseStake set ONCE, locked, never overwritten.
 *   Recovery multiplier (from RecoveryEngine) further scales stake when active.
 */
import type { MarketRegime }     from '../regime/market-regime';
import type { ValidationResult } from '../validation/validation-engine';
import {
    EXECUTION_THRESHOLDS,
    CONFIDENCE_FLOORS,
    VALIDATION_FLOORS,
} from '../config/execution-thresholds';

export type ExecMode = 'VIRTUAL' | 'LIVE' | 'LIVE_MARTINGALE';
export type RiskState = 'SAFE' | 'CAUTION' | 'PAUSED';

export interface ExecutionConfig {
    baseStake:               number;
    /** 0..1 confidence floor for LIVE mode (default from EXECUTION_THRESHOLDS). */
    liveConfidenceFloor:     number;
    /** 0..100 validation floor for LIVE mode. */
    liveValidationFloor:     number;
    /** 0..1 confidence floor for LIVE_MARTINGALE. */
    martingaleConfidence:    number;
    /** 0..100 validation floor for LIVE_MARTINGALE (v5.1: lowered 90 → 85). */
    martingaleValidation:    number;
    martingaleMultiplier:    number;     // default 3
    martingaleMaxLevels:     number;     // default 3
    virtualWinRateGate:      number;     // default 0.70
    maxConsecutiveLosses:    number;     // default 2
    dailyDrawdownLimit:      number;     // default 0.05
    rollingValidationWindow: number;     // default 20
}

/**
 * Default config derived from the centralized EXECUTION_THRESHOLDS table.
 * Changing thresholds requires editing exactly one place: `config/execution-thresholds.ts`.
 */
export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
    baseStake:               1,
    liveConfidenceFloor:     CONFIDENCE_FLOORS.live,         // 0.75
    liveValidationFloor:     VALIDATION_FLOORS.live,         // 70
    martingaleConfidence:    CONFIDENCE_FLOORS.martingale,   // 0.95
    martingaleValidation:    VALIDATION_FLOORS.martingale,   // 85
    // v5.2: softened from 3 -> 2. Progression is now 1 / 2 / 4 instead of
    // 1 / 3 / 9. Worst-case cumulative loss in a full cycle drops from $13
    // (on $1 base) to $7 — a 46 % reduction in martingale drawdown.
    martingaleMultiplier:    2,
    martingaleMaxLevels:     3,
    virtualWinRateGate:      0.70,
    maxConsecutiveLosses:    2,
    dailyDrawdownLimit:      0.05,
    rollingValidationWindow: 20,
};

/** Re-export so consumers can pin the constant directly without re-imports. */
export { EXECUTION_THRESHOLDS };

export interface VirtualTrade {
    ts: number; symbol: string; direction: 'UP' | 'DOWN' | 'NEUTRAL';
    contractType: string; won: boolean; pnl: number; confidence: number;
}

export interface ExecutionDecision {
    mode:               ExecMode;
    stake:              number;
    martingaleLevel:    number;
    reason:             string;
    allowed:            boolean;
    riskState:          RiskState;
    martingaleEligible: boolean;
}

export interface ExecutionSnapshot {
    mode: ExecMode;
    riskState: RiskState;
    baseStake: number;
    nextStake: number;
    martingaleLevel: number;
    martingaleEligible: boolean;
    sample: number;
    virtualWinRate: number;
    consecutiveLosses: number;
    consecutiveWins: number;
    dailyPnL: number;
    accountBalance: number;
}

interface DecideInputs {
    fusionConfidence: number;
    validation: ValidationResult;
    regime: MarketRegime;
    marketStable: boolean;
    accountBalance: number;
    dailyPnL: number;
    /** Stake scaler applied last — used by the Recovery Engine. */
    stakeScaler?: number;
    /**
     * Optional per-tick threshold override from the AdaptiveThresholds layer.
     * Confidence values are PERCENT (75 = 0.75 internally); validation 0..100.
     * When omitted the engine uses the centralized EXECUTION_THRESHOLDS.
     */
    adaptive?: {
        liveConfidence:       number;
        liveValidation:       number;
        martingaleConfidence: number;
        martingaleValidation: number;
    };
}

export class ExecutionEngine {
    private cfg: ExecutionConfig;
    private virtualTrades: VirtualTrade[] = [];
    private consecutiveLosses = 0;
    private consecutiveWins   = 0;
    private dailyPnL          = 0;
    private accountBalance    = 0;
    private martingaleLevel   = 0;
    private lastMode: ExecMode = 'VIRTUAL';
    private _baseLocked = false;

    public listeners = new Set<(s: ExecutionSnapshot) => void>();

    constructor(cfg: Partial<ExecutionConfig> = {}) {
        this.cfg = { ...DEFAULT_EXECUTION_CONFIG, ...cfg };
    }

    setBaseStake(stake: number) {
        if (this._baseLocked) return;
        this.cfg.baseStake = Math.max(0.35, Math.round(stake * 100) / 100);
        this._baseLocked = true;
    }
    get baseStake(): number { return this.cfg.baseStake; }
    setBalance(b: number) { this.accountBalance = b; }

    decide(i: DecideInputs): ExecutionDecision {
        const { fusionConfidence, validation, marketStable } = i;
        const reasons: string[] = [];
        const stakeScaler = Math.max(0, Math.min(2, i.stakeScaler ?? 1));

        // Resolve effective thresholds: adaptive override > centralized config.
        // The adaptive layer hands us percent / 0..100 values; we keep the
        // internal storage as float / 0..100 to match the rest of the engine.
        const liveConfFloor = i.adaptive
            ? i.adaptive.liveConfidence / 100
            : this.cfg.liveConfidenceFloor;
        const liveValFloor  = i.adaptive
            ? i.adaptive.liveValidation
            : this.cfg.liveValidationFloor;
        const martConfFloor = i.adaptive
            ? i.adaptive.martingaleConfidence / 100
            : this.cfg.martingaleConfidence;
        const martValFloor  = i.adaptive
            ? i.adaptive.martingaleValidation
            : this.cfg.martingaleValidation;

        let riskState: RiskState = 'SAFE';
        const ddPct = this.accountBalance > 0
            ? Math.max(0, -this.dailyPnL / this.accountBalance) : 0;
        if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
            riskState = 'CAUTION';
            reasons.push(`consLoss=${this.consecutiveLosses}`);
        }
        if (ddPct >= this.cfg.dailyDrawdownLimit) {
            riskState = 'PAUSED';
            reasons.push(`dailyDD=${(ddPct * 100).toFixed(1)}%`);
        }

        const vwr = this.getVirtualWinRate();
        const sample = this.virtualTrades.length;

        // v5.1+: enforce BOTH confidence AND validation floors for LIVE.
        // v5.2: floors may be adaptively shifted; use effective values resolved above.
        const validationBelowLive = validation.score < liveValFloor;

        const fallbackToVirtual =
            fusionConfidence < liveConfFloor ||
            validationBelowLive ||
            this.consecutiveLosses >= this.cfg.maxConsecutiveLosses ||
            ddPct >= this.cfg.dailyDrawdownLimit ||
            !marketStable ||
            (sample >= 5 && vwr < this.cfg.virtualWinRateGate);

        if (fallbackToVirtual) {
            if (fusionConfidence < liveConfFloor)
                reasons.unshift(`conf=${(fusionConfidence*100).toFixed(0)}%<${(liveConfFloor*100).toFixed(0)}%`);
            if (validationBelowLive)
                reasons.push(`val=${validation.score.toFixed(0)}<${liveValFloor}`);
            if (!marketStable)       reasons.push('market unstable');
            if (sample >= 5 && vwr < this.cfg.virtualWinRateGate)
                reasons.push(`vWR=${(vwr*100).toFixed(0)}%<${(this.cfg.virtualWinRateGate*100).toFixed(0)}%`);
            return {
                mode: 'VIRTUAL', stake: 0, martingaleLevel: 0,
                reason: 'VIRTUAL: ' + (reasons.join(' · ') || 'gates not met'),
                allowed: true, riskState, martingaleEligible: false,
            };
        }

        const elite = fusionConfidence >= martConfFloor &&
                      validation.score    >= martValFloor;
        let level = this.martingaleLevel;
        let mode: ExecMode = 'LIVE';
        let stake = this.cfg.baseStake * stakeScaler;
        let martingaleEligible = false;

        if (elite) {
            const m = Math.pow(this.cfg.martingaleMultiplier, level);
            const requested = this.cfg.baseStake * stakeScaler * m;
            if (requested > this.accountBalance && level > 0) {
                mode = 'LIVE';
                stake = this.cfg.baseStake * stakeScaler;
                reasons.push(`balance<${requested.toFixed(2)} → reset to base`);
            } else {
                mode = 'LIVE_MARTINGALE';
                stake = requested;
                martingaleEligible = level < this.cfg.martingaleMaxLevels - 1;
            }
        } else if (fusionConfidence >= martConfFloor &&
                   validation.score < martValFloor) {
            reasons.push(`val=${validation.score.toFixed(0)}<${martValFloor} → no martingale`);
            level = 0;
        } else {
            level = 0;
        }

        const head = mode === 'LIVE_MARTINGALE'
            ? `LIVE_MARTINGALE L${level + 1}/${this.cfg.martingaleMaxLevels} stake=$${stake.toFixed(2)}`
            : `LIVE stake=$${stake.toFixed(2)}`;
        const reason = head + (reasons.length ? ' · ' + reasons.join(' · ') : '');

        return { mode, stake, martingaleLevel: level, reason, allowed: true, riskState, martingaleEligible };
    }

    recordVirtual(t: Omit<VirtualTrade, 'ts'>) {
        this.virtualTrades.push({ ...t, ts: Date.now() });
        if (this.virtualTrades.length > this.cfg.rollingValidationWindow) {
            this.virtualTrades.shift();
        }
        this.emit();
    }

    recordLive(args: { won: boolean; pnl: number; wasMartingale: boolean }) {
        if (args.won) {
            this.consecutiveWins++;
            this.consecutiveLosses = 0;
            this.martingaleLevel = 0;
        } else {
            this.consecutiveLosses++;
            this.consecutiveWins = 0;
            if (args.wasMartingale) {
                if (this.martingaleLevel >= this.cfg.martingaleMaxLevels - 1) {
                    this.martingaleLevel = 0;
                } else {
                    this.martingaleLevel++;
                }
            } else {
                this.martingaleLevel = 0;
            }
        }
        this.dailyPnL += args.pnl;
        this.emit();
    }

    getVirtualWinRate(): number {
        if (this.virtualTrades.length === 0) return 0;
        const w = this.virtualTrades.filter(t => t.won).length;
        return w / this.virtualTrades.length;
    }

    snapshot(): ExecutionSnapshot {
        return {
            mode: this.lastMode,
            riskState: this.computeRiskState(),
            baseStake: this.cfg.baseStake,
            nextStake: this.cfg.baseStake * Math.pow(this.cfg.martingaleMultiplier, this.martingaleLevel),
            martingaleLevel: this.martingaleLevel,
            martingaleEligible: this.martingaleLevel < this.cfg.martingaleMaxLevels - 1,
            sample: this.virtualTrades.length,
            virtualWinRate: this.getVirtualWinRate(),
            consecutiveLosses: this.consecutiveLosses,
            consecutiveWins: this.consecutiveWins,
            dailyPnL: this.dailyPnL,
            accountBalance: this.accountBalance,
        };
    }

    setLastMode(m: ExecMode) { this.lastMode = m; this.emit(); }

    private computeRiskState(): RiskState {
        const ddPct = this.accountBalance > 0
            ? Math.max(0, -this.dailyPnL / this.accountBalance) : 0;
        if (ddPct >= this.cfg.dailyDrawdownLimit) return 'PAUSED';
        if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) return 'CAUTION';
        return 'SAFE';
    }

    private emit() {
        const s = this.snapshot();
        this.listeners.forEach(l => { try { l(s); } catch {} });
    }

    resetForTest() {
        this.virtualTrades = [];
        this.consecutiveLosses = 0; this.consecutiveWins = 0;
        this.martingaleLevel = 0; this.dailyPnL = 0;
        this.lastMode = 'VIRTUAL';
    }
}
