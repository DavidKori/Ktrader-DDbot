/**
 * Unified Orchestrator — v5 (Production)
 * --------------------------------------
 *
 * Pipeline (matches user's final spec exactly):
 *
 *   Market Scanner
 *           ↓
 *   Feature Engine
 *           ↓
 *   Direction LightGBM
 *           ↓
 *   Duration LightGBM
 *           ↓
 *   Fusion Engine
 *           ↓
 *   Validation Engine
 *           ↓
 *   Market Ranking Scanner (continuous)
 *           ↓
 *   Shadow Trading (rolling virtual win rate)
 *           ↓
 *   Mode Selector (VIRTUAL | LIVE | LIVE_MARTINGALE)
 *           ↓
 *   Market Router (forex | binary)
 *           ↓
 *   ┌────────────┐         ┌──────────────┐
 *   │ Forex      │   OR    │ Binary       │
 *   │ Sizing     │         │ Position     │
 *   └────────────┘         └──────────────┘
 *           ↓
 *   Stake Manager (martingale + recovery scaler)
 *           ↓
 *   Risk Manager (cooldown + DD + exposure)
 *           ↓
 *   Execution Engine → Deriv API
 *           ↓
 *   Trade Journal (persistent)
 *           ↓
 *   Analytics Dashboard (live)
 *
 * Emergency controls and forex burst-mode (multi-trade at 95 %+ confidence)
 * are exposed as public methods called by the UI dropdown.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * v5.5.5 — NO-REPAINT INTEGRATION (LAYER 2: pipeline)
 * ─────────────────────────────────────────────────────────────────────────────
 * Guarded flow — the guard runs BEFORE indicators, features, AI and signals:
 *
 *   Market Data (DerivClient.getCandles → layer-1 guard)
 *           ↓
 *   refreshCandles()  ← re-fetch each cycle (fixes frozen-history bug)
 *           ↓
 *   closedBars()  →  guardWithMinHistory()   ← LAYER 2 HARD GATE
 *           ↓            (skip cycle if a bar is still forming / warm-up)
 *   Indicators (ind)
 *           ↓
 *   Features (buildFeatures)
 *           ↓
 *   AI (predictProbability)
 *           ↓
 *   Fusion → Validation → Signal
 *           ↓
 *   Risk / Exposure / Concurrency
 *           ↓
 *   Execution → Deriv API
 *
 * The guard NEVER throws into the tick loop: a forming bar causes the symbol's
 * cycle to be skipped (DEBUG/WARN), and the engine simply waits for the bar to
 * close. Open-position management is deliberately NOT gated on entry-grade
 * candle freshness — exits must remain able to fire.
 */
import { snapshot as ind, Candle }                from '../engine/indicator-engine';
import {
    guardCandles, guardWithMinHistory, noRepaintStats,
}                                                  from '../engine/no-repaint-guard';
import { mulberry32, hashSeed }                    from '../engine/deterministic-random';
import { analyzeVolume }                           from '../engine/adaptive-volume';
import { buildDigitDistribution }                  from '../engine/digit-stats';
import { buildFeatures, predictProbability, MLPrediction } from '../ml/lightgbm-client';
import { fuseSignals, passesEntryGate }            from '../fusion/signal-fusion';
import { evaluateRisk, DEFAULT_RISK }              from '../risk/risk-engine';
import { evaluateExit, ExitInputs }                from '../exits/exit-engine';
import { PositionStateMachine }                    from './position-state-machine';
import { DerivClient, DERIV_DEFAULT_APP_ID }       from './deriv-client';
import { getSymbolMeta, getSymbolKind } from '../../constants/all-symbols';
import { isSpikeIndex }                           from '../../constants/synthetic-symbols';
import {
    detectRegime, routeContract, routeSpikeContract, ContractPick, MarketRegime,
} from '../regime/market-regime';
import { planDuration, DurationPlan }              from '../duration/duration-model';
import { computeValidationScore, isMarketStable }  from '../validation/validation-engine';
import { ExecutionEngine, ExecMode, ExecutionSnapshot } from '../execution/execution-engine';
import { scanOne, ScanResult }                     from '../scanner/market-scanner';
import { xmlFromScan }                             from '../xml/xml-generator';
import { routeMarket, splitByKind }                from '../router/market-router';
import { buildForexOrder }                         from '../forex/position-sizing';
import { buildBinaryOrder, isBinaryContract }      from '../binary/binary-position';
import { decideConcurrentSizing }                  from '../burst/concurrent-sizing';
import { RecoveryEngine }                          from '../recovery/recovery-engine';
import { TradeJournal, JournalEntry }              from '../journal/trade-journal';
import { ExposureTracker }                          from '../exposure/exposure-tracker';
import { KillSwitch }                               from '../killswitch/kill-switch';
import { MarketCircuits }                           from '../circuit/market-circuits';
import { DriftMonitor }                             from '../drift/model-drift';
import { ShadowStatsEngine }                        from '../shadow/shadow-stats';
import { checkMultiLayer }                          from '../validation/multi-layer-gate';
import { computeAdaptiveThresholds }                from '../config/adaptive-thresholds';
import { ExpectancyGate }                            from '../edge/expectancy-gate';
import { detectBurst, shouldPrecisionExit, BurstSignal } from '../burst/burst-detector';
import { computeAdaptiveBuffer }                      from '../burst/atr-adaptive-buffer';
import { DynamicForexEngine }                        from '../dynamic/dynamic-forex-engine';
import { MetaOptimizer, ParamBucket }                from '../meta/meta-optimizer';
import { AutoTrader }                                from '../meta/auto-trader';
import { pickAutoTimeframe }                          from '../config/auto-timeframe';
import type { RegimeId }                              from '../meta/regime-memory';

export interface OrchestratorEvent {
    type: 'log' | 'signal' | 'entry' | 'exit' | 'error' | 'mode' | 'xml' | 'recovery' | 'emergency'
        | 'scan' | 'signal_qualified' | 'blocked' | 'risk_blocked' | 'trade_open' | 'trade_manage' | 'trade_close' | 'manual_click' | 'tick';
    ts: number;
    symbol?: string;
    message: string;
    data?: any;
    pnl?: number;
}

export interface OrchestratorConfig {
    symbols: string[];
    pollMs: number;
    candleGranularitySec: number;
    candleHistoryCount: number;
    digitWindow: number;
    appId: number;
    baseStake: number;
    riskPctPerTrade: number;       // forex sizing default 1 %
    burstMaxPositions: number;     // forex burst-mode cap (default 5)
}

const DEFAULT_CONFIG: OrchestratorConfig = {
    symbols: [
    'frxEURUSD',
    'frxGBPUSD',
    'frxUSDJPY',
    'frxAUDUSD',
    'frxNZDUSD',
    'frxUSDCHF',
    'frxEURGBP',
    'frxEURJPY',
    'frxGBPJPY',
    'frxAUDJPY',
    'frxEURAUD',
    'frxEURCAD',
    'frxGBPAUD',
    'frxUSDCAD',
    'frxXAUUSD',
    'frxXAGUSD',
    'R_10',
    'R_25',
    'R_50',
    'R_75',
    'R_100',
    '1HZ10V',
    '1HZ25V',
    '1HZ50V',
    '1HZ75V',
    '1HZ100V',
    '1HZ150V',
    '1HZ250V',
    '1HZ500V',
    '1HZ1000V',
    'BOOM300',
    'BOOM500',
    'BOOM1000',
    'CRASH300',
    'CRASH500',
    'CRASH1000',
    'stpRNG',
    'stpRNG2',
    'stpRNG3',
    'JD10',
    'JD25',
    'JD50',
    'JD75',
    'JD100',
    'RDBEAR',
    'RDBULL',
    'RDBRANGE100',
  ],
    pollMs: 4000,
    candleGranularitySec: 60,
    candleHistoryCount: 200,
    digitWindow: 500,
    appId: DERIV_DEFAULT_APP_ID,
    baseStake: 1,
    riskPctPerTrade: 0.01,
    // Bulk mode is capped at 10, but only the measured PF/expectancy gate can
    // activate it. ExposureTracker and the hourly/daily caps remain binding.
    burstMaxPositions: 10,
};

interface SymbolRuntime {
    /**
     * Raw OHLC history as returned by DerivClient (already layer-1 guarded).
     * NEVER consume this directly in a decision path — always go through
     * `Orchestrator.closedBars(sym)` so the layer-2 guard applies.
     */
    candles: Candle[];
    ticks: number[];
    volumes: number[];

    // ── v5.5.5 no-repaint bookkeeping ──
    /** epoch of the newest bar the engine has been allowed to act on. */
    lastClosedEpoch?: number;
    /** wall-clock ms of the last successful candle refresh. */
    lastCandleFetchMs: number;
    /** cycles skipped because the newest bar had not closed yet. */
    formingSkips: number;

    machine?: PositionStateMachine;
    peakProfitPips: number;
    lastEntryStake?: number;
    /** Exact notional recorded at OPEN; used to release the same amount at CLOSE. */
    lastEntryNotional?: number;
    lastEntryConfidence?: number;
    lastEntryMode?: ExecMode;
    lastDurationPlan?: DurationPlan;
    lastScanResult?: ScanResult;
    lastTradeAt: number;        // for risk-engine cooldown
    journalIdOpen?: string;

    // Auto-timeframe rotator state (M1 ↔ M5)
    tf: 'M1' | 'M5';
    tfGranularitySec: 60 | 300;
    tfHistoryCount: number;
    tfTradesSinceSwitch: number;
    tfSwitchReason: string;

    // Burst-mode tracking (velocity + precision exit)
    tickEpochsMs: number[];               // parallel to `ticks`, for VoA
    lastBurstSignal?: BurstSignal;
    burstOpenedAt?: number;               // ms — when a burst-triggered position opened
    burstExpectedDurationSec?: number;
    burstTargetTpPips?: number;
    burstAtrPips?: number;
    priceHistory30s: { epochMs: number; price: number }[];   // rolling for precision exit

    // Meta-optimizer tracking (which bucket the open trade is on)
    activeBucketId?: string;
    activeBucketTpMult?: number;
    activeBucketSlMult?: number;

    // Rolling PnL series for edge-decay monitor
    recentPnL: number[];
    recentWinTrades: number;
    recentTotalTrades: number;
}

export class Orchestrator {
    private cfg: OrchestratorConfig;
    private state = new Map<string, SymbolRuntime>();
    public  deriv?: DerivClient;        // exposed so overlay manual-router can reach the buy API
    private timer?: any;
    public  running   = false;          // public so engine-boot can idempotently start
    private aiDisabled = false;         // emergency: stop NEW entries

    /**
     * v5.5.5 DETERMINISM — seed for every reproducible draw made by this
     * instance (currently the VIRTUAL digit-contract outcome). Set it to a fixed
     * value in replays/backtests so the same historical data yields the same
     * signals; leave the default in production.
     */
    public replaySeed = 'ddbot-v5.5.5';

    /** Per-symbol AI-Auto opt-in map. Written by the overlay's ManualAutoToggle
     *  via `window.__TWK_SET_MODE__`. Missing entry = default AUTO (scan+trade). */
    public autoEnabled: Map<string, boolean> = new Map();

    public accountBalance      = 100;
    public consecutiveLosses   = 0;
    public openExposureUSD     = 0;
    public stats = { trades: 0, wins: 0, losses: 0, pnl: 0, virtualTrades: 0, liveTrades: 0 };

    // Circuit-breaker cooldown: risk-engine.ts vetoes new live entries once
    // consecutiveLosses hits DEFAULT_RISK.maxConsecutiveLosses (3). Previously
    // that counter only ever reset back to 0 on a WIN — but a win can't
    // happen while the veto is blocking every entry, so the bot permanently
    // stopped live-trading after exactly 3 losses in a row until the app was
    // reloaded, with no indication in the UI of why. This timer auto-resets
    // the counter after a cooldown so trading can resume on its own; the
    // separate KillSwitch (trips at 4 losses) still requires a manual
    // reset() as the harder stop.
    private circuitBreakerCooldownMs = 15 * 60_000; // 15 minutes
    private circuitBreakerTimer: ReturnType<typeof setTimeout> | null = null;

    public execution    = new ExecutionEngine();
    public recovery     = new RecoveryEngine();
    public journal      = new TradeJournal();

    // v5.2 production hardening
    public exposure     = new ExposureTracker();
    public killSwitch   = new KillSwitch();
    public circuits     = new MarketCircuits();
    public drift        = new DriftMonitor();
    public edgeGate     = new ExpectancyGate();
    public dynamic      = new DynamicForexEngine();
    public meta         = new MetaOptimizer();
    public autoTrader   = new AutoTrader();
    public shadowStats  = new ShadowStatsEngine();

    public listeners   = new Set<(e: OrchestratorEvent) => void>();
    public lastSignals = new Map<string, any>();

    constructor(public token: string, cfg: Partial<OrchestratorConfig> = {}) {
        this.cfg = { ...DEFAULT_CONFIG, ...cfg };
        this.execution.setBaseStake(this.cfg.baseStake);
        for (const s of this.cfg.symbols) {
            this.state.set(s, {
                candles: [], ticks: [], volumes: [], peakProfitPips: 0, lastTradeAt: 0,
                tf: 'M1', tfGranularitySec: 60, tfHistoryCount: 240,
                tfTradesSinceSwitch: 0, tfSwitchReason: 'initial M1',
                recentPnL: [], recentWinTrades: 0, recentTotalTrades: 0,
                tickEpochsMs: [], priceHistory30s: [],
                lastCandleFetchMs: 0, formingSkips: 0,
            });
        }
        this.execution.listeners.add(snap => {
            this.emit({
                type: 'mode',
                message: `mode=${snap.mode} risk=${snap.riskState} stake=$${snap.nextStake.toFixed(2)} mart=L${snap.martingaleLevel} vWR=${(snap.virtualWinRate*100).toFixed(0)}%`,
                data: snap,
            });
        });
    }

    private emit(e: Omit<OrchestratorEvent, 'ts'>) {
        const ev = { ...e, ts: Date.now() };
        this.listeners.forEach(l => { try { l(ev); } catch {} });
    }

    setBalance(b: number) { this.accountBalance = b; this.execution.setBalance(b); }
    get executionSnapshot(): ExecutionSnapshot { return this.execution.snapshot(); }

    async start() {
        if (this.running) return;
        this.deriv = new DerivClient(this.token, this.cfg.appId);
        try { await this.deriv.connect(); }
        catch (e: any) {
            this.emit({ type: 'error', message: `Deriv connect failed: ${e?.message}` });
            return;
        }
        this.running = true;
        this.emit({
            type: 'log',
            message: `Engine started · app_id=${this.cfg.appId} · baseStake=$${this.execution.baseStake.toFixed(2)} · ${this.cfg.symbols.length} symbols`,
        });

        for (const sym of this.cfg.symbols) {
            try {
                const rt = this.state.get(sym)!;
                // Auto-rotate timeframe (M1 ↔ M5) based on regime/vol/win rate
                this.maybeRotateTimeframe(sym);
                // v5.5.5 — seed OHLC history through the shared, guarded refresh
                // path (identical code as the per-cycle refresh, so bootstrap and
                // steady-state can never diverge).
                await this.refreshCandles(sym, { seedTicks: true });
                await this.deriv.subscribeTicks(sym, t => {
                    const nowMs = Date.now();
                    rt.ticks.push(t.quote);
                    if (rt.ticks.length > 2000) rt.ticks.shift();
                    rt.tickEpochsMs.push(nowMs);
                    if (rt.tickEpochsMs.length > 2000) rt.tickEpochsMs.shift();
                    // Rolling 30 s price history for burst precision-exit
                    rt.priceHistory30s.push({ epochMs: nowMs, price: t.quote });
                    const cutoff = nowMs - 30_000;
                    while (rt.priceHistory30s.length && rt.priceHistory30s[0].epochMs < cutoff) {
                        rt.priceHistory30s.shift();
                    }
                });
            } catch (e: any) {
                this.emit({ type: 'error', symbol: sym, message: `init failed: ${e?.message}` });
            }
        }
        this.timer = setInterval(
            () => this.tick().catch(err => this.emit({ type: 'error', message: err?.message ?? 'tick error' })),
            this.cfg.pollMs,
        );
    }

    async stop() {
        this.running = false;
        if (this.timer) clearInterval(this.timer);
        for (const sym of this.cfg.symbols) {
            const rt = this.state.get(sym)!;
            if (rt.machine && ['TRADE_ACTIVE','MANAGING_POSITION'].includes(rt.machine.current())) {
                await this.closePosition(sym, 'manual_stop');
            }
        }
        this.deriv?.disconnect();
        this.emit({ type: 'log', message: 'Engine stopped' });
    }

    // ────────── Emergency Controls ──────────

    /** STOP ALL — kill switch: stops engine + closes every open trade. */
    async emergencyStopAll() {
        this.emit({ type: 'emergency', message: 'STOP ALL pressed' });
        await this.stop();
    }
    /** Close every open trade but keep the engine running. */
    async emergencyCloseAll() {
        this.emit({ type: 'emergency', message: 'Close all trades' });
        for (const sym of this.cfg.symbols) {
            const rt = this.state.get(sym)!;
            if (rt.machine) await this.closePosition(sym, 'manual_close_all');
        }
    }
    /** Close only profitable open trades. */
    async emergencyCloseProfitable() {
        this.emit({ type: 'emergency', message: 'Close profitable trades' });
        for (const sym of this.cfg.symbols) {
            const rt = this.state.get(sym)!;
            if (!rt.machine) continue;
            const c = rt.machine.ctx;
            const meta = getSymbolMeta(sym)!;
            const cur = rt.ticks[rt.ticks.length - 1] ?? c.entryPrice;
            if (!cur || !c.entryPrice) continue;
            const profitPips = c.direction === 'NEUTRAL' ? 0
                : (c.direction === 'UP' ? (cur - c.entryPrice) / meta.pip
                                        : (c.entryPrice - cur) / meta.pip);
            if (profitPips > 0) await this.closePosition(sym, 'manual_close_profit');
        }
    }
    /** Disable new entries but keep managing existing positions. */
    emergencyDisableAI(flag = true) {
        this.aiDisabled = flag;
        this.emit({ type: 'emergency', message: flag ? 'AI disabled — no new entries' : 'AI re-enabled' });
    }

    // ────────── Tick loop ──────────

    // -----------------------------------------------------------------
    //  v5.5.5 — NO-REPAINT: candle refresh + closed-bar accessors
    // -----------------------------------------------------------------

    /**
     * Re-fetch OHLC history for `sym` and store it on the runtime.
     *
     * WHY THIS EXISTS (bug fixed in v5.5.5):
     * before this release `rt.candles` was assigned exactly once, during
     * `start()`. The tick loop never refetched it, so `ind(rt.candles)` returned
     * a FROZEN indicator snapshot for the entire session — RSI/MACD/Bollinger/
     * ATR/ADX never moved after boot, and `analyzeVolume(rt.volumes)` returned a
     * frozen z-score that fed straight into the ML feature vector.
     *
     * A no-repaint guard over a frozen array would be meaningless, so the fix is
     * part of the same change: candles are refreshed on a cadence, and every
     * refresh passes through the layer-1 guard inside `DerivClient.getCandles`.
     *
     * Never throws — a failed refresh leaves the previous (still valid, still
     * closed-only) history in place and the cycle is skipped upstream.
     */
    private async refreshCandles(
        sym: string,
        opts: { seedTicks?: boolean; force?: boolean } = {},
    ): Promise<boolean> {
        const rt = this.state.get(sym);
        if (!rt || !this.deriv) return false;

        const now = Date.now();
        // Refetching more often than half a bar width is pure waste: nothing can
        // have closed. `force` bypasses for bootstrap / timeframe rotation.
        const minIntervalMs = Math.max(5_000, (rt.tfGranularitySec * 1000) / 2);
        if (!opts.force && !opts.seedTicks && rt.lastCandleFetchMs &&
            now - rt.lastCandleFetchMs < minIntervalMs) {
            return true;
        }

        try {
            const raw = await this.deriv.getCandles(sym, rt.tfGranularitySec, rt.tfHistoryCount);
            const mapped: Candle[] = raw.map((c: any) => ({
                epoch: Number(c.epoch),
                open: Number(c.open), high: Number(c.high),
                low: Number(c.low), close: Number(c.close),
            }));

            // Layer-2 guard. Idempotent w.r.t. layer 1, and it is what protects us
            // if a future caller swaps in an unguarded data source.
            const report = guardCandles(mapped, {
                timeframeSec: rt.tfGranularitySec,
                label: sym,
                now,
            });
            if (report.candles.length === 0) {
                this.emit({
                    type: 'log', symbol: sym,
                    message: `no-repaint: candle refresh yielded no closed bars (${report.reason})`,
                });
                return false;
            }

            rt.candles = report.candles;
            rt.lastClosedEpoch = report.lastClosedEpoch;
            rt.lastCandleFetchMs = now;

            // Volume proxy is derived from closed bars only, so `vol_z` /
            // `vol_regime_num` in the ML vector are now causal too.
            rt.volumes = rt.candles.map((_, i) =>
                Math.abs(rt.candles[i].close - (rt.candles[i - 1]?.close ?? rt.candles[i].close)));

            // Only seed the tick series at bootstrap. Afterwards the live tick
            // subscription owns `rt.ticks`; overwriting it would destroy the
            // sub-bar resolution the burst detector needs.
            if (opts.seedTicks) {
                rt.ticks = rt.candles.map(c => c.close);
            }
            return true;
        } catch (e: any) {
            this.emit({ type: 'error', symbol: sym, message: `candle refresh failed: ${e?.message}` });
            return false;
        }
    }

    /**
     * THE closed-bar accessor. Every decision path must read candles through
     * this method rather than touching `rt.candles`.
     *
     * Returns `{ allowed:false }` when the newest bar is still forming or the
     * warm-up window is not yet filled. Callers skip the cycle; they never throw.
     */
    private closedBars(
        sym: string,
        minBars = 40,
    ): { allowed: boolean; candles: Candle[]; reason: string } {
        const rt = this.state.get(sym);
        if (!rt) return { allowed: false, candles: [], reason: 'unknown symbol' };

        const res = guardWithMinHistory<Candle>(rt.candles, minBars, {
            timeframeSec: rt.tfGranularitySec,
            label: sym,
        });

        if (res.report.droppedForming > 0) rt.formingSkips++;
        if (res.report.candles.length) rt.lastClosedEpoch = res.report.lastClosedEpoch;

        return { allowed: res.allowed, candles: res.candles, reason: res.reason };
    }

    /**
     * Volume proxy aligned to a given closed-bar series. Keeps `volumes` and
     * `candles` the same length so `analyzeVolume`'s rolling window cannot be
     * skewed by a bar the guard removed.
     */
    private closedVolumes(sym: string, closed: Candle[]): number[] {
        const rt = this.state.get(sym);
        if (!rt) return [];
        if (rt.volumes.length === closed.length) return rt.volumes;
        return closed.map((_, i) =>
            Math.abs(closed[i].close - (closed[i - 1]?.close ?? closed[i].close)));
    }

    /** Public no-repaint diagnostics for the overlay / production audit. */
    noRepaintDiagnostics(): {
        global: ReturnType<typeof noRepaintStats>;
        perSymbol: Array<{ symbol: string; lastClosedEpoch?: number; formingSkips: number;
                           closedBars: number; lastFetchMs: number }>;
    } {
        return {
            global: noRepaintStats(),
            perSymbol: Array.from(this.state.entries()).map(([symbol, rt]) => ({
                symbol,
                lastClosedEpoch: rt.lastClosedEpoch,
                formingSkips: rt.formingSkips,
                closedBars: rt.candles.length,
                lastFetchMs: rt.lastCandleFetchMs,
            })),
        };
    }

    private async tick() {
        if (!this.running) return;

        // v5.2 kill-switch health checks (status / reconnects from deriv client)
        if (this.deriv) {
            this.killSwitch.onHealthTick(this.deriv.getStatus());
            this.killSwitch.onReconnect(this.deriv.reconnectCount);
        }
        if (this.killSwitch.tripped) {
            // Kill switch tripped — manage open positions but no new entries.
            //
            // v5.5.5: EXIT management intentionally uses the best available closed
            // history WITHOUT an allow/deny gate. Blocking exits because a bar is
            // mid-formation could strand a live position through a drawdown —
            // strictly more dangerous than the repaint it would avoid. We still
            // feed only CLOSED bars, so the exit decision itself never repaints.
            for (const sym of this.cfg.symbols) {
                const rt = this.state.get(sym)!;
                if (rt.machine) {
                    const m = rt.machine.current();
                    if (m === 'TRADE_ACTIVE' || m === 'MANAGING_POSITION') {
                        await this.refreshCandles(sym);
                        const exitBars = this.closedBars(sym, 1).candles;
                        if (exitBars.length === 0) continue;
                        const snap = ind(exitBars);
                        const vol  = analyzeVolume(this.closedVolumes(sym, exitBars));
                        await this.manage(sym, snap, vol);
                    }
                }
            }
            return;
        }

        // v5.2 connection-health gate — refuse new entries when degraded
        const connHealthy = this.deriv?.isHealthy() ?? false;

        for (const sym of this.cfg.symbols) {
            const rt = this.state.get(sym)!;

            // v5.5.5 — refresh OHLC every cycle so indicators actually move.
            // Internally rate-limited to half a bar width, so this adds no extra
            // API pressure relative to the bar cadence.
            await this.refreshCandles(sym);

            // Manage open positions first (always — even when AI disabled).
            if (rt.machine) {
                const m = rt.machine.current();
                if (m === 'TRADE_ACTIVE' || m === 'MANAGING_POSITION') {
                    const exitBars = this.closedBars(sym, 1).candles;
                    if (exitBars.length === 0) continue;
                    const snap = ind(exitBars);
                    const vol  = analyzeVolume(this.closedVolumes(sym, exitBars));
                    await this.manage(sym, snap, vol);
                    continue;
                }
            }
            if (this.aiDisabled) continue;
            if (this.recovery.isBlocked()) continue;
            if (!connHealthy) continue;             // v5.2 — no entries when DEGRADED
            if (this.drift.isDrifting()) continue;  // v5.2 — no entries while model drifts

            // ── v5.5.5 NO-REPAINT HARD GATE (entries only) ──
            // Runs BEFORE feature engineering, AI inference and signal generation.
            // A forming bar or an unfilled warm-up window skips this symbol's cycle;
            // the engine simply waits for the bar to close. WARN/DEBUG only — never
            // an ERROR, and never a throw (a throw here would kill the interval).
            const gate = this.closedBars(sym, 40);
            if (!gate.allowed) {
                this.emit({
                    type: 'log', symbol: sym,
                    message: `no-repaint: entry skipped — ${gate.reason}`,
                });
                continue;
            }

            await this.evaluateAndExecute(sym, gate.candles);
        }
    }

    /**
     * @param closedCandles Guaranteed closed-only OHLC series supplied by the
     *   caller's no-repaint gate. When omitted (external/legacy callers) the gate
     *   is applied here instead, so there is no unguarded entry path into the
     *   pipeline.
     */
    private async evaluateAndExecute(sym: string, closedCandles?: Candle[]) {
        const rt = this.state.get(sym)!;

        // ── v5.5.5 defence-in-depth ──
        // `tick()` already gated, but this method is also reachable from
        // `fireForexBurst()` / external callers. Re-gating is cheap and idempotent,
        // and it guarantees the invariant "no feature is ever built from a forming
        // bar" holds for EVERY caller, not just the tick loop.
        let bars: Candle[];
        if (closedCandles && closedCandles.length >= 40) {
            bars = closedCandles;
        } else {
            const gate = this.closedBars(sym, 40);
            if (!gate.allowed) {
                this.emit({
                    type: 'log', symbol: sym,
                    message: `no-repaint: evaluate skipped — ${gate.reason}`,
                });
                return;
            }
            bars = gate.candles;
        }
        const volumes = this.closedVolumes(sym, bars);

        // Everything below this line sees CLOSED BARS ONLY.
        const snap = ind(bars);
        const vol  = analyzeVolume(volumes);
        const route = routeMarket(sym);
        const meta  = getSymbolMeta(sym)!;

        // 1. Scanner (per-symbol Quality)
        const scan = await scanOne({
            symbol: sym, candles: bars, ticks: rt.ticks, volumes,
            recentWinRate: this.execution.getVirtualWinRate(),
        });
        if (scan) rt.lastScanResult = scan;

        // 2. Direction LightGBM
        const features = buildFeatures(snap, vol, rt.ticks);
        const ml: MLPrediction = await predictProbability(features);

        // 3. Fusion
        const fusion = fuseSignals(snap, vol, ml);
        const regimeRes = detectRegime(snap);

        // 4. Tentative pick + Duration plan
        const tentativePick = await this.tentativeContractPick(sym, regimeRes.regime, snap, vol, rt.ticks, route.kind, fusion.direction === 'BUY');
        const tickInt = meta.kind === 'synthetic' ? meta.tickIntervalSec : 60;
        const plan = tentativePick
            ? await planDuration(snap, vol, regimeRes.regime, tentativePick.contractType, tickInt, meta.pip)
            : null;

        // 5. Validation
        const validation = computeValidationScore({
            snapshot: snap, volume: vol, ml, regime: regimeRes.regime, duration: plan,
            scannerQualityScore: scan?.qualityScore,
        });

        // 6. Stability
        const stability = isMarketStable(regimeRes.regime, vol);
        this.lastSignals.set(sym, { snap, vol, ml, fusion, validation, regime: regimeRes.regime, scan });

        // v5.2 signal-storm tracker
        this.killSwitch.onSignal();
        if (this.killSwitch.tripped) return;

        // v5.2 market-condition circuit breakers (ATR spike / range spike / news)
        this.circuits.pushAtr(sym, snap.atr);
        const circuit = this.circuits.evaluate(sym, snap, meta.pip);
        if (!circuit.allowed) {
            this.emit({ type: 'log', symbol: sym, message: `circuit: ${circuit.trips.join(' · ')}` });
            return;
        }

        // v5.2 multi-layer pre-trade gate (trend / volume / regime / RSI / ML conviction)
        const mlGate = checkMultiLayer({
            snapshot: snap, volume: vol, ml, regime: regimeRes.regime, fusion,
        });
        if (!mlGate.allowed) {
            this.emit({ type: 'log', symbol: sym, message: `multi-layer veto: ${mlGate.reason}` });
            return;
        }

        // v5.2 adaptive thresholds based on rolling LIVE win-rate
        const adaptive = computeAdaptiveThresholds({
            liveWinRate: this.execution.getVirtualWinRate(),
            sampleSize:  this.execution.snapshot().sample,
        });

        // 7. Mode Selector (with recovery scaler + adaptive thresholds)
        const recoverySnap = this.recovery.snapshot();
        const decision = this.execution.decide({
            fusionConfidence: fusion.confidence, validation,
            regime: regimeRes.regime, marketStable: stability.isStable,
            accountBalance: this.accountBalance,
            dailyPnL: this.execution.snapshot().dailyPnL,
            stakeScaler: recoverySnap.stakeMultiplier,
            adaptive: {
                liveConfidence:       adaptive.liveConfidence,
                liveValidation:       adaptive.liveValidation,
                martingaleConfidence: adaptive.martingaleConfidence,
                martingaleValidation: adaptive.martingaleValidation,
            },
        });
        this.execution.setLastMode(decision.mode);

        const openSymbols = Array.from(this.state.entries())
            .filter(([s, runtime]) => s !== sym && Boolean(runtime.machine))
            .map(([s]) => s);
        const autoDecision = this.autoTraderDecide(sym, openSymbols);
        let metaStake = decision.stake;
        if (autoDecision) {
            rt.activeBucketId = autoDecision.bucket.id;
            rt.activeBucketTpMult = autoDecision.bucket.tpMultiplier;
            rt.activeBucketSlMult = autoDecision.bucket.slMultiplier;
            metaStake = Math.max(0.35, Math.round(autoDecision.stake * 100) / 100);
            this.emit({
                type: 'log', symbol: sym,
                message: `auto-trader ${autoDecision.mode} bucket=${autoDecision.bucket.id} stake=$${metaStake.toFixed(2)} · ${autoDecision.reason}`,
            });
            if (autoDecision.mode === 'BLOCKED') {
                this.emit({ type: 'risk_blocked', symbol: sym, message: `auto-trader veto: ${autoDecision.reason}` });
                return;
            }
        }

        if (!passesEntryGate(fusion, 0.65)) {
            this.emit({ type: 'scan', symbol: sym, message: 'scanning… no qualified signal', data: { conf: fusion.confidence } });
            return;
        }
        if (!tentativePick) return;
        const pick = tentativePick;
        if (pick.edgeExpectancy <= 0) {
            this.emit({ type: 'blocked', symbol: sym, message: `edge<=0 (${pick.edgeExpectancy.toFixed(3)})` });
            return;
        }

        // Per-symbol AUTO opt-in — the overlay's ManualAutoToggle sets
        // `orchestrator.autoEnabled.set(sym, true/false)`. When explicitly set
        // to false, the AI must NOT auto-open a live trade on this symbol
        // (scanning + telemetry still flow, so the UI stays responsive).
        if (this.autoEnabled.has(sym) && this.autoEnabled.get(sym) === false) {
            this.emit({ type: 'blocked', symbol: sym, message: 'AUTO disabled for this symbol (manual mode)' });
            return;
        }

        this.emit({ type: 'signal_qualified', symbol: sym,
            message: `${pick.contractType} conf=${fusion.confidence.toFixed(2)} edge=${pick.edgeExpectancy.toFixed(3)}` });

        // Direction cross-check
        const pickIsBullish = pick.contractType === 'MULTUP' || pick.contractType === 'CALL';
        const pickIsBearish = pick.contractType === 'MULTDOWN' || pick.contractType === 'PUT';
        if (fusion.direction === 'BUY'  && pickIsBearish) return;
        if (fusion.direction === 'SELL' && pickIsBullish) return;

        // XML strategy export
        if (scan) {
            const xml = xmlFromScan(scan, decision.stake || this.execution.baseStake, plan?.durationTicks ?? 5);
            if (xml) {
                this.emit({ type: 'xml', symbol: sym, message: `XML generated (${pick.contractType})`,
                            data: { xml, plan, pick } });
            }
        }

        // Recovery-engine cooldown gate
        if (this.recovery.isBlocked()) {
            this.emit({ type: 'recovery', symbol: sym, message: recoverySnap.reason });
            return;
        }

        // 8. Forex/Binary routing — build the actual order params
        const orderInputs = this.buildOrderParams(sym, route, pick, plan, metaStake, decision.mode);
        if (!orderInputs) return;

        // 9. Risk Manager
        const risk = evaluateRisk({
            mode: decision.mode, stake: orderInputs.stake,
            accountBalance: this.accountBalance,
            dailyPnL: this.execution.snapshot().dailyPnL,
            openExposureUSD: this.openExposureUSD,
            consecutiveLosses: this.consecutiveLosses,
            atr: snap.atr, pip: meta.pip,
            lastTradeAt: rt.lastTradeAt, symbol: sym,
        }, DEFAULT_RISK);
        if (!risk.allowed) {
            this.emit({ type: 'log', symbol: sym, message: `risk veto: ${risk.reason}` });
            return;
        }

        // 9b. v5.2 exposure-tracker — daily / hourly / per-symbol / total caps
        if (decision.mode !== 'VIRTUAL') {
            // Exposure = stake (Deriv multiplier max loss = 100% of stake), NOT
            // stake × multiplier. Matches the risk-engine fix (v5.6.2-clean).
            const exposureStake = orderInputs.stake;
            const expCheck = this.exposure.canOpen(sym, exposureStake, this.accountBalance);
            if (!expCheck.allowed) {
                this.emit({ type: 'risk_blocked', symbol: sym, message: `exposure veto: ${expCheck.reason}` });
                return;
            }
        }

        // 9c. v5.5.2 concurrent-sizing gate — confidence-tiered multi-position
        // scaler. At ≥ 0.85 conf on a $500+ account this permits 5–12 parallel
        // trades so the burst engine can actually deploy capital.
        if (decision.mode !== 'VIRTUAL') {
            const openCount    = Array.from(this.state.values()).filter(s => s.machine).length;
            const openExposure = this.openExposureUSD;
            const measuredEdge = this.edgeGate.allowBulk(sym);
            const sizing = decideConcurrentSizing({
                balance: this.accountBalance,
                baseStake: orderInputs.stake,
                confidence: fusion.confidence,
                openCount, openExposure,
                bulkEligible: measuredEdge.allow,
                measuredProfitFactor: measuredEdge.stats.profitFactor,
            });
            if (!sizing.allowNewPosition) {
                this.emit({
                    type: 'risk_blocked', symbol: sym,
                    message: `concurrent-cap veto: ${sizing.reason} (cap=${sizing.concurrentCap})`,
                });
                return;
            }
            // Shrink the per-trade stake so total exposure respects maxExposureFrac.
            if (sizing.stakePerPosition > 0 && sizing.stakePerPosition < orderInputs.stake) {
                orderInputs.stake = sizing.stakePerPosition;
            }
        }

        // 9d. Expectancy gate — final measured-edge check. This was computed
        // (this.edgeGate.record(...) below feeds it every closed trade) but
        // never consulted before firing a live entry, so a symbol with a
        // proven non-positive rolling expectancy could still trade live
        // indefinitely. Past warm-up, block live entries when the gate says
        // no — route to shadow/virtual instead so learning continues without
        // risking capital.
        let executionMode = decision.mode;
        if (autoDecision?.mode === 'SHADOW') {
            executionMode = 'VIRTUAL';
        } else if (autoDecision?.mode === 'REDUCED' && executionMode === 'LIVE_MARTINGALE') {
            executionMode = 'LIVE';
        }
        if (executionMode !== 'VIRTUAL') {
            const edgeCheck = this.edgeGate.allowLive(sym);
            if (!edgeCheck.allow && edgeCheck.stats.samples >= 20) {
                this.emit({
                    type: 'risk_blocked', symbol: sym,
                    message: `expectancy veto: ${edgeCheck.reason}`,
                });
                executionMode = 'VIRTUAL';
            }
        }

        // 10. Execute
        if (executionMode === 'VIRTUAL') {
            this.simulateVirtual(sym, pick, snap.lastClose, plan, fusion.confidence, validation.score, decision.reason);
        } else {
            await this.openPosition(sym, pick, orderInputs, snap.lastClose, plan, fusion.confidence, executionMode, validation.score, scan?.qualityScore);
        }
    }

    /**
     * Forex Burst Mode — public method called by the UI Emergency Controls
     * dropdown. At ≥95% confidence, opens up to N parallel forex positions
     * across enabled forex symbols (capital-permitting).
     */
    async fireForexBurst(minConfidence = 0.95) {
        const { forex } = splitByKind(this.cfg.symbols);
        const opened: string[] = [];
        for (const sym of forex) {
            if (opened.length >= this.cfg.burstMaxPositions) break;
            const rt = this.state.get(sym);
            if (!rt || rt.machine) continue;
            // v5.5.5 — burst mode is a manual, high-stake action, so refresh OHLC
            // first and let `evaluateAndExecute`'s own no-repaint gate decide.
            // A symbol whose current bar is still forming is skipped, not traded.
            await this.refreshCandles(sym);
            // Each symbol gets evaluated; if confidence + balance pass we fire.
            await this.evaluateAndExecute(sym);
            const last = this.lastSignals.get(sym);
            if (last?.fusion?.confidence >= minConfidence && this.state.get(sym)!.machine) {
                opened.push(sym);
            }
            // If capital exhausted, retain at least 1 position then bail.
            // Capital bail, stake units: halt burst when total stake > 50% of balance.
            if (this.openExposureUSD > this.accountBalance * 0.5) break;
        }
        this.emit({
            type: 'emergency',
            message: `Forex burst → opened ${opened.length}/${this.cfg.burstMaxPositions} positions [${opened.join(', ')}]`,
        });
    }

    /**
     * v5.3 Auto-Burst — evaluates the burst-detector on every tick.
     * Called from the main tick loop (evaluateAndExecute).  Returns a
     * burst-augmented order hint that upstream execution can use to
     * override the default TP/SL geometry with the precision-burst values.
     */
    evaluateBurst(sym: string): { signal: BurstSignal; tpAtrMult: number; slAtrMult: number; atrPercentile: number; session: string; reason: string } | null {
        const rt = this.state.get(sym);
        if (!rt || rt.tickEpochsMs.length < 20) return null;

        // v5.5.5 no-repaint — the burst detector derives ATR, velocity,
        // acceleration and the Bollinger-squeeze release from OHLC. Feeding it a
        // forming bar made `direction` and `confidence` flip mid-bar, which is the
        // single worst repaint in the system (it drives live entries).
        // `ticks` / `tickEpochsMs` are intentionally NOT gated: they are genuine
        // point-in-time observations, not mutable aggregates.
        const gate = this.closedBars(sym, 25);
        if (!gate.allowed) return null;
        const bars = gate.candles;

        const signal = detectBurst({
            candles: bars,
            ticks: rt.ticks,
            tickEpochsMs: rt.tickEpochsMs,
        });
        rt.lastBurstSignal = signal;
        if (!signal.fired) return null;

        // ATR-adaptive buffer widens/tightens by ATR-percentile & session
        const buf = computeAdaptiveBuffer({
            candles: bars,
            baseTpAtrMult: signal.suggestedTpAtrMult,
            baseSlAtrMult: signal.suggestedSlAtrMult,
        });

        this.emit({
            type: 'log', symbol: sym,
            message: `BURST ${signal.direction > 0 ? '↑' : '↓'} conf=${(signal.confidence * 100).toFixed(0)}% → TP=${buf.tpAtrMult.toFixed(2)}×ATR SL=${buf.slAtrMult.toFixed(2)}×ATR (${buf.reason})`,
        });

        return {
            signal,
            tpAtrMult: buf.tpAtrMult,
            slAtrMult: buf.slAtrMult,
            atrPercentile: buf.atrPercentile,
            session: buf.session,
            reason: `${signal.reason} | ${buf.reason}`,
        };
    }

    private buildOrderParams(
        sym: string, route: ReturnType<typeof routeMarket>,
        pick: ContractPick, plan: DurationPlan | null,
        decidedStake: number, mode: ExecMode,
    ): { stake: number; multiplier?: number; durationTicks?: number;
          barrier?: number; targetDigit?: number; rationale: string } | null {
        const meta = getSymbolMeta(sym)!;
        if (route.kind === 'forex') {
            // Forex sizing — derive lot/stake from balance × risk × SL.
            const sl = plan?.stopLossPips ?? 15;
            const tp = plan?.takeProfitPips ?? 30;
            const fx = buildForexOrder(
                this.accountBalance, this.cfg.riskPctPerTrade,
                sl, tp, meta.pip, route.forexMultiplier,
            );
            const desiredStake = Math.max(0.35, decidedStake);
            const stake = Math.max(0.35, Math.min(desiredStake, fx.stake));
            return {
                stake, multiplier: fx.multiplier,
                rationale: `forex • ${fx.rationale} • desired=$${desiredStake.toFixed(2)} capped=$${stake.toFixed(2)}`,
            };
        }
        // Binary
        if (!isBinaryContract(pick.contractType)) return null;
        const bin = buildBinaryOrder({
            symbol: sym, contractType: pick.contractType,
            stake: decidedStake, durationTicks: plan?.durationTicks ?? 5,
            barrier: pick.barrier, targetDigit: pick.targetDigit,
        });
        if (!bin) return null;
        return {
            stake: bin.stake, durationTicks: bin.durationTicks,
            barrier: bin.barrier, targetDigit: bin.targetDigit,
            rationale: `binary • ${bin.rationale}`,
        };
    }

    private async tentativeContractPick(
        sym: string, regime: MarketRegime, snap: any, _vol: any, ticks: number[],
        kind: 'forex' | 'binary', bullish: boolean,
    ): Promise<ContractPick | null> {
        const meta = getSymbolMeta(sym);
        if (!meta) return null;
        if (kind === 'binary' && isSpikeIndex(sym)) return routeSpikeContract(sym, snap);
        const digitDist = (kind === 'binary' && meta.kind === 'synthetic' && meta.supportsDigit)
            ? buildDigitDistribution(ticks, 2, this.cfg.digitWindow) : null;
        const routerKind = kind === 'forex' ? 'forex' : 'synthetic';
        return routeContract(routerKind, regime, snap, digitDist, bullish);
    }

    private async openPosition(
        sym: string, pick: ContractPick,
        order: { stake: number; multiplier?: number; durationTicks?: number;
                 barrier?: number; targetDigit?: number; rationale: string },
        lastClose: number, plan: DurationPlan | null, confidence: number, mode: ExecMode,
        validationScore: number, qualityScore?: number,
    ) {
        const rt = this.state.get(sym)!;
        const route = routeMarket(sym);
        const machine = new PositionStateMachine({
            symbol: sym, direction: pick.direction, contractType: pick.contractType,
        });
        machine.transition('ANALYZING');
        machine.transition('SIGNAL_CONFIRMED');
        machine.transition('ENTERING_TRADE');

        try {
            let result;
            if (pick.contractType === 'MULTUP' || pick.contractType === 'MULTDOWN') {
                result = await this.deriv!.buyMultiplier({
                    symbol: sym, direction: pick.direction as 'UP' | 'DOWN',
                    stake: order.stake, multiplier: order.multiplier ?? 100,
                    stopLossPips: plan?.stopLossPips, takeProfitPips: plan?.takeProfitPips,
                });
            } else {
                result = await this.deriv!.buyBinary({
                    symbol: sym, contractType: pick.contractType as any,
                    stake: order.stake, durationTicks: order.durationTicks ?? 5,
                    barrier: order.barrier, targetDigit: order.targetDigit,
                });
            }
            machine.transition('TRADE_ACTIVE', {
                contractId: result.contractId, entryPrice: lastClose, openedAt: Date.now(),
            });
            rt.machine             = machine;
            rt.peakProfitPips      = 0;
            rt.lastEntryStake      = order.stake;
            // Store max-loss exposure (stake) used by ExposureTracker/openExposureUSD.
            // Deriv multipliers stop out at 100% of stake, so notional is not the
            // capital at risk; using stake keeps open/close units consistent.
            rt.lastEntryNotional   = order.stake;
            rt.lastEntryConfidence = confidence;
            rt.lastEntryMode       = mode;
            rt.lastDurationPlan    = plan ?? undefined;
            rt.lastTradeAt         = Date.now();
            const exposureStake    = order.stake;
            this.openExposureUSD  += exposureStake;
            this.stats.liveTrades++;

            // v5.2 exposure tracker — record OPEN for daily/hourly/per-symbol caps
            this.exposure.recordOpen(sym, exposureStake);

            // Trade Journal — record OPEN
            rt.journalIdOpen = this.journal.open({
                symbol: sym, kind: route.kind, contractType: pick.contractType,
                direction: pick.direction, mode, martingaleLevel: this.execution.snapshot().martingaleLevel,
                durationTicks: order.durationTicks, durationSec: undefined,
                entryPrice: lastClose, stake: order.stake,
                confidence, validationScore, qualityScore, regime: pick.rationale,
                barrier: order.barrier, targetDigit: order.targetDigit,
            });

            this.emit({
                type: 'entry', symbol: sym,
                message: `${mode} ${pick.contractType} ${pick.direction} stake=$${order.stake.toFixed(2)} (${order.rationale})`,
                data: { contractId: result.contractId, edge: pick.edgeExpectancy, plan, mode, journalId: rt.journalIdOpen },
            });
            this.publishOverlay({
                type: 'trade_open', symbol: sym,
                mode: mode as any, tf: rt.tf, bucket: rt.activeBucketId,
                message: `${pick.contractType} ${pick.direction} $${order.stake.toFixed(2)}`,
                stake: order.stake,
            });
        } catch (e: any) {
            machine.transition('ERROR', { note: e?.message });
            this.emit({ type: 'error', symbol: sym, message: `entry failed: ${e?.message}` });
        }
    }

    private simulateVirtual(
        sym: string, pick: ContractPick, lastClose: number,
        plan: DurationPlan | null, confidence: number, validationScore: number, reason: string,
    ) {
        const rt = this.state.get(sym)!;
        const meta = getSymbolMeta(sym)!;
        const route = routeMarket(sym);
        const tickInt = meta.kind === 'synthetic' ? meta.tickIntervalSec : 60;
        const durTicks = plan?.durationTicks ?? 5;
        const holdMs = (durTicks * tickInt) * 1000;
        const entry = lastClose;
        this.stats.virtualTrades++;

        // Journal OPEN
        const jid = this.journal.open({
            symbol: sym, kind: route.kind, contractType: pick.contractType,
            direction: pick.direction, mode: 'VIRTUAL', martingaleLevel: 0,
            durationTicks: durTicks, entryPrice: entry, stake: 0,
            confidence, validationScore, regime: pick.rationale,
            barrier: pick.barrier, targetDigit: pick.targetDigit,
        });

        this.emit({
            type: 'entry', symbol: sym,
            message: `VIRTUAL ${pick.contractType} ${pick.direction} (${reason})`,
            data: { plan, confidence, journalId: jid },
        });

        setTimeout(() => {
            const exit = rt.ticks[rt.ticks.length - 1] ?? entry;
            let won = false;
            if (pick.direction === 'UP')        won = exit > entry;
            else if (pick.direction === 'DOWN') won = exit < entry;
            // v5.5.5 DETERMINISM — the NEUTRAL branch (digit contracts) previously
            // used bare `Math.random()`. That outcome feeds `recordVirtual()` →
            // `getVirtualWinRate()`, which GATES the promotion to LIVE mode. A
            // non-deterministic gate cannot be regression-tested and made the
            // same historical data produce different signals on replay.
            // The draw is now seeded from immutable trade coordinates, so it is
            // reproducible while remaining unbiased w.r.t. confidence.
            else {
                const draw = mulberry32(hashSeed(
                    `${this.replaySeed}|${sym}|${pick.contractType}|${entry}|${jid}`,
                ))();
                won = draw < confidence;
            }
            const pnl = won ? 0.95 : -1.0;
            this.execution.recordVirtual({
                symbol: sym, direction: pick.direction, contractType: pick.contractType,
                won, pnl, confidence,
            });
            // v5.2 shadow-mode stats — record virtual signal + outcome for edge analysis
            const shadowId = this.shadowStats.record({
                symbol: sym,
                direction: pick.direction === 'UP' ? 'BUY' : pick.direction === 'DOWN' ? 'SELL' : 'NONE',
                confidence, validation: validationScore,
                contractType: pick.contractType,
            });
            this.shadowStats.resolve(shadowId, { won, pnl, reason: 'virtual_simulated' });
            this.journal.close(jid, {
                exitPrice: exit, pnl, durationSec: (durTicks * tickInt),
                exitReason: 'virtual_simulated',
            });
            this.emit({
                type: 'exit', symbol: sym,
                message: `VIRTUAL closed → ${won ? 'WIN' : 'LOSS'} (vWR=${(this.execution.getVirtualWinRate()*100).toFixed(0)}%)`,
                data: { reason: 'virtual_simulated' }, pnl,
            });
        }, Math.min(holdMs, 30_000));
    }

    private async manage(sym: string, snap: any, vol: any) {
        const rt = this.state.get(sym)!;
        const meta = getSymbolMeta(sym)!;
        const m = rt.machine!;
        const c = m.ctx;
        if (m.current() === 'TRADE_ACTIVE') m.transition('MANAGING_POSITION');

        const last = this.lastSignals.get(sym);
        const ml: MLPrediction = last?.ml ?? {
            probability: 0.5, confidence: 'low', risk_score: 0.5, direction_hint: 'NEUTRAL',
        };
        const current = snap.lastClose;
        const pip = meta.pip;
        const profitPips = c.direction === 'NEUTRAL' ? 0
            : (c.direction === 'UP' ? (current - (c.entryPrice ?? current)) / pip
                                    : ((c.entryPrice ?? current) - current) / pip);
        if (profitPips > rt.peakProfitPips) rt.peakProfitPips = profitPips;

        const plan = rt.lastDurationPlan;
        const inputs: ExitInputs = {
            direction: c.direction, entryPrice: c.entryPrice ?? current, currentPrice: current,
            pip,
            stopLossPips:        plan?.stopLossPips        ?? 20,
            takeProfitPips:      plan?.takeProfitPips      ?? 40,
            trailingActivatedPips: plan?.trailingActivatedPips ?? 25,
            trailingDistancePips:  plan?.trailingDistancePips  ?? 10,
            openedAt: c.openedAt ?? Date.now(),
            maxHoldSec: plan?.maxHoldSec ?? 600,
            minSecondsHeld: 15,
            snapshot: snap, volume: vol, ml, peakProfitPips: rt.peakProfitPips,
        };
        const dec = evaluateExit(inputs);
        if (dec.shouldExit) { await this.closePosition(sym, dec.reason ?? 'unknown'); return; }

        // v5.3 burst precision-exit — fires only if this position was opened via burst
        if (rt.burstOpenedAt && rt.burstExpectedDurationSec && rt.burstTargetTpPips && rt.burstAtrPips) {
            const prices30s = rt.priceHistory30s.map(p => p.price);
            const px = shouldPrecisionExit({
                burstOpenedAt: rt.burstOpenedAt,
                expectedDurationSec: rt.burstExpectedDurationSec,
                profitPips: rt.peakProfitPips,
                targetTpPips: rt.burstTargetTpPips,
                lastNPricesInLast30s: prices30s,
                atrPips: rt.burstAtrPips,
            });
            if (px.exit) {
                this.emit({ type: 'log', symbol: sym, message: `precision-exit: ${px.reason}` });
                await this.closePosition(sym, `burst_${px.reason}`);
            }
        }
    }

    private async closePosition(sym: string, reason: string) {
        const rt = this.state.get(sym)!;
        const m  = rt.machine!;
        const c  = m.ctx;
        m.transition('EXIT_CONDITION_MET');
        m.transition('CLOSING_TRADE');
        let closed = false;
        try {
            const soldFor = c.contractId ? await this.deriv!.sellContract(c.contractId) : 0;
            const stake = rt.lastEntryStake ?? 0;
            const pnl   = soldFor - stake;
            m.transition('LOGGING_RESULTS', { closedAt: Date.now(), pnl });

            this.stats.trades++;
            this.stats.pnl += pnl;
            if (pnl >= 0) { this.stats.wins++; this.consecutiveLosses = 0; }
            else          { this.stats.losses++; this.consecutiveLosses++; this.armCircuitBreakerCooldown(); }
            const releasedNotional = rt.lastEntryNotional ?? stake; // stake units since v5.6.2-clean
            this.openExposureUSD = Math.max(0, this.openExposureUSD - releasedNotional);

            this.execution.recordLive({
                won: pnl >= 0, pnl,
                wasMartingale: rt.lastEntryMode === 'LIVE_MARTINGALE',
            });

            // Recovery engine update
            const recSnap = this.recovery.recordTrade(pnl >= 0);
            this.emit({ type: 'recovery', message: recSnap.reason, data: recSnap });

            // v5.2 exposure tracker — release notional
            this.exposure.recordClose(sym, releasedNotional);

            // v5.2 drift monitor — track rolling LIVE win-rate
            this.drift.record(pnl >= 0);

            // v5.2 kill switch — trip on 4 consecutive losses
            this.killSwitch.onLiveResult(pnl >= 0, this.consecutiveLosses);

            // v5.3 meta-optimizer — feed result to AutoTrader (bucket UCB, decay, correlation)
            this.recordTradeResult(sym, pnl);

            // Journal CLOSE
            if (rt.journalIdOpen) {
                const cur = rt.ticks[rt.ticks.length - 1] ?? c.entryPrice ?? 0;
                this.journal.close(rt.journalIdOpen, {
                    exitPrice: cur, pnl,
                    durationSec: ((Date.now() - (c.openedAt ?? Date.now())) / 1000),
                    exitReason: reason,
                });
                rt.journalIdOpen = undefined;
            }

            this.emit({
                type: 'exit', symbol: sym,
                message: `${rt.lastEntryMode} closed (${reason}) pnl≈$${pnl.toFixed(2)}`,
                data: { reason, pnl, stake, payout: soldFor },
                pnl,
            });
            // Publish to overlay telemetry bus
            this.publishOverlay({
                type: 'trade_close', symbol: sym, message: reason,
                mode: rt.lastEntryMode as any, pnl, tf: rt.tf, bucket: rt.activeBucketId,
            });
            m.transition('IDLE');
            closed = true;
            rt.machine = undefined;
        } catch (e: any) {
            m.transition('ERROR', { note: e?.message });
            this.emit({ type: 'error', symbol: sym, message: `close failed: ${e?.message} · position retained for manual recovery` });
            if (!closed) {
                rt.machine = m;
            }
        }
    }

    /** Used by the Scanner UI to fetch fresh tick & candle data per symbol. */
    // -----------------------------------------------------------------
    //  Auto-Timeframe Rotator (M1 ↔ M5)
    // -----------------------------------------------------------------
    private maybeRotateTimeframe(sym: string): void {
        const rt = this.state.get(sym); if (!rt) return;
        // v5.5.5 no-repaint — the rotation decision must not be driven by a
        // forming bar's volume/ATR proxy, or the engine can thrash M1↔M5 mid-bar
        // and reset the dwell counter. Only re-evaluate on closed history.
        const gate = this.closedBars(sym, 30);
        if (!gate.allowed) return;
        const recentWR = rt.recentTotalTrades > 0
            ? rt.recentWinTrades / rt.recentTotalTrades
            : undefined;
        // ATR percentile: quick proxy from recent volumes (closed bars only)
        const vols = this.closedVolumes(sym, gate.candles).slice(-60);
        const cur = vols[vols.length - 1] ?? 0;
        const sortedVols = [...vols].sort((a, b) => a - b);
        const rank = sortedVols.findIndex(v => v >= cur);
        const atrPercentile = sortedVols.length ? (rank / sortedVols.length) * 100 : undefined;
        // Regime hint from last scan
        const regime = (rt.lastScanResult as any)?.regime as RegimeId | undefined;
        const choice = pickAutoTimeframe({
            symbol: sym,
            regime,
            atrPercentile,
            recentWinRate: recentWR,
            currentLabel: rt.tf,
            tradesSinceSwitch: rt.tfTradesSinceSwitch,
        });
        if (choice.label !== rt.tf) {
            this.emit({ type: 'log', symbol: sym, message: `TF rotate: ${rt.tf}→${choice.label} (${choice.reason})` });
            rt.tf = choice.label;
            rt.tfGranularitySec = choice.granularitySec;
            rt.tfHistoryCount = choice.historyCount;
            rt.tfTradesSinceSwitch = 0;
            rt.tfSwitchReason = choice.reason;
        }
    }

    // -----------------------------------------------------------------
    //  AutoTrader integration — called by execution decision path
    // -----------------------------------------------------------------
    autoTraderDecide(sym: string, openSymbols: string[]): ReturnType<AutoTrader['decide']> | null {
        const rt = this.state.get(sym); if (!rt) return null;
        const closed = rt.recentPnL;
        const wins = closed.filter(p => p > 0);
        const losses = closed.filter(p => p <= 0);
        const wr = closed.length ? wins.length / closed.length : 0;
        const avgWin = wins.length ? wins.reduce((s, v) => s + v, 0) / wins.length : 0;
        const avgLoss = losses.length ? Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length) : 0;
        const regime = ((rt.lastScanResult as any)?.regime as RegimeId) ?? 'TREND_LOW_VOL';
        return this.autoTrader.decide({
            symbol: sym,
            regime,
            recentPnL: closed,
            winRate: wr,
            avgWin,
            avgLoss,
            openSymbols,
            baseStake: this.execution.baseStake,
        });
    }

    /**
     * Once consecutiveLosses hits the risk-engine's circuit-breaker
     * threshold, schedule an automatic reset after a cooldown instead of
     * leaving the bot permanently blocked from live entries. Re-armed on
     * every additional loss so the cooldown always counts from the most
     * recent one. A win still resets the counter immediately, cancelling
     * any pending cooldown.
     */
    private armCircuitBreakerCooldown(): void {
        if (this.consecutiveLosses < DEFAULT_RISK.maxConsecutiveLosses) return;
        if (this.circuitBreakerTimer) clearTimeout(this.circuitBreakerTimer);
        this.emit({
            type: 'risk_blocked',
            message: `circuit breaker: ${this.consecutiveLosses} consecutive losses — live entries paused for ${(this.circuitBreakerCooldownMs / 60_000).toFixed(0)}m`,
        });
        this.circuitBreakerTimer = setTimeout(() => {
            this.circuitBreakerTimer = null;
            if (this.consecutiveLosses >= DEFAULT_RISK.maxConsecutiveLosses) {
                this.consecutiveLosses = 0;
                this.emit({ type: 'log', message: 'circuit breaker cooldown elapsed — live entries resumed' });
            }
        }, this.circuitBreakerCooldownMs);
    }

    recordTradeResult(sym: string, pnl: number): void {
        const rt = this.state.get(sym); if (!rt) return;
        rt.recentPnL.push(pnl);
        if (rt.recentPnL.length > 60) rt.recentPnL.shift();
        if (pnl > 0) rt.recentWinTrades++;
        rt.recentTotalTrades++;
        rt.tfTradesSinceSwitch++;
        const regime = ((rt.lastScanResult as any)?.regime as RegimeId) ?? 'TREND_LOW_VOL';
        this.autoTrader.recordResult({
            symbol: sym,
            regime,
            bucketId: rt.activeBucketId ?? 'A-balanced',
            tpMult: rt.activeBucketTpMult ?? 2.5,
            slMult: rt.activeBucketSlMult ?? 1.0,
            pnl,
        });
        // Also feed the ExpectancyGate
        this.edgeGate.record({
            symbol: sym,
            contractType: 'multiplier',
            stake: rt.lastEntryStake ?? this.execution.baseStake,
            pnl,
            confidence: rt.lastEntryConfidence ?? 0.75,
            validation: 70,
            ts: Date.now(),
        });
    }

    /** Publish a telemetry event to the browser overlay bus (window.__TWK_BUS__). */
    private publishOverlay(payload: { type: string; symbol?: string; message?: string; mode?: string; bucket?: string; stake?: number; pnl?: number; tf?: string }): void {
        try {
            const w = (typeof window !== 'undefined') ? (window as any) : undefined;
            if (!w || !w.__TWK_BUS__) return;
            w.__TWK_BUS__.publish({ ...payload, ts: Date.now() });
        } catch { /* ignore — server-side or overlay not mounted */ }
    }

    async fetchScanInputs(symbol: string, tickCount: number) {
        if (!this.deriv) return null;
        const [candles, ticks] = await Promise.all([
            this.deriv.getCandles(symbol, 60, 200),
            this.deriv.getTicks(symbol, tickCount),
        ]);
        const candleArr = candles.map((c: any) => ({
            epoch: Number(c.epoch),
            open: Number(c.open), high: Number(c.high),
            low: Number(c.low), close: Number(c.close),
        }));
        // v5.5.5 no-repaint — the Scanner UI feeds these inputs straight into
        // `scanAll()` → `scanOne()` → indicators + ML, and the user can act on the
        // ranking, so it must be closed-only too. `getCandles` already guards at
        // layer 1; this is the idempotent layer-2 pass for defence in depth.
        // Bind the guard's generic to the concrete `Candle` type: `MinimalCandle`
        // declares OHLC as optional, so an unannotated call would surface
        // `close: number | undefined` here.
        const guarded = guardCandles<Candle>(candleArr, { timeframeSec: 60, label: symbol }).candles;
        const tickPrices: number[] = ticks.map((t: any) => Number(t.quote));
        const volumes = guarded.map((_: Candle, i: number) =>
            Math.abs(guarded[i].close - (guarded[i - 1]?.close ?? guarded[i].close)));
        return { symbol, candles: guarded, ticks: tickPrices, volumes };
    }
}

// Re-export the journal entry type so UI components can import it directly
// from the orchestrator module.
export type { JournalEntry };
