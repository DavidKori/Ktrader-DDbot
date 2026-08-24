/**
 * Public barrel — v5.3 final surface.
 * Pure LightGBM ML stack. No LLM, no chat-AI, no third-party AI proxies.
 */
export * from './config/execution-thresholds';
export * from './config/exposure-controls';
export * from './config/adaptive-thresholds';
export { pickAutoTimeframe, defaultTimeframeFor } from './config/auto-timeframe';
export type { TimeframeChoice, TimeframeContext } from './config/auto-timeframe';
export * from './engine/indicator-engine';
export * from './engine/adaptive-volume';
export * from './engine/digit-stats';
// v5.5.5 — no-repaint guard + deterministic PRNG (see NO_REPAINT_v5.5.5.md)
export {
    guardCandles, closedBarsOnly, assertClosedBars, assertNoRepaint,
    guardMultiTimeframe, guardWithMinHistory,
    isBarClosed, isLastBarForming, barCloseTimeMs,
    inferTimeframeSec, resolveTimeframeSec,
    noRepaintStats, resetNoRepaintStats,
    NoRepaintViolation,
    DEFAULT_CLOCK_SKEW_TOLERANCE_MS, FALLBACK_TIMEFRAME_SEC,
} from './engine/no-repaint-guard';
export type {
    MinimalCandle, NoRepaintOptions, GuardReport, NoRepaintStats,
} from './engine/no-repaint-guard';
export {
    mulberry32, hashSeed, resolveSeed, makeRandom, gaussFrom, makeFakeClock,
} from './engine/deterministic-random';
export type { RandomFn } from './engine/deterministic-random';
export * from './regime/market-regime';
export * from './fusion/signal-fusion';
export * from './risk/risk-engine';
export * from './exits/exit-engine';
export * from './lifecycle/position-state-machine';
export * from './lifecycle/orchestrator';
export * from './lifecycle/deriv-client';
export * from './ml/lightgbm-client';
export * from './duration/duration-model';
export * from './validation/validation-engine';
export * from './validation/multi-layer-gate';
export * from './execution/execution-engine';
export * from './scanner/market-scanner';
export * from './xml/xml-generator';
export * from './forex/position-sizing';
export * from './binary/binary-position';
export * from './router/market-router';
export * from './recovery/recovery-engine';
export * from './journal/trade-journal';
export * from './analytics/performance';
export * from './exposure/exposure-tracker';
export * from './killswitch/kill-switch';
export * from './circuit/market-circuits';
export * from './drift/model-drift';
export * from './shadow/shadow-stats';
// v5.3 — edge engineering + meta-optimiser + dynamic engine
export * from './edge/expectancy-gate';
export * from './edge/edge-engineering';
export * from './edge/simulator';
export * from './dynamic/asset-selector';
export {
  detectRegime as detectRegimeDynamic,
} from './dynamic/regime-detector';
export type {
  RegimeOutput,
  Candle as DynamicCandle,
} from './dynamic/regime-detector';
export * from './dynamic/adaptive-risk-sizing';
export * from './dynamic/walk-forward-optimizer';
export * from './dynamic/dynamic-forex-engine';
export * from './meta/meta-optimizer';
export {
  detectBurst, shouldPrecisionExit,
  computeAdaptiveBuffer, classifySessionSimple,
  AdaptiveThresholdEngine, EdgeCostGate,
  RegimeHysteresis, DEFAULT_HYSTERESIS,
  GapDetector, DEFAULT_GAP_CFG,
  FrequencyCap, DEFAULT_FREQ_CAP,
  classifySessionEngine, computeExhaustion,
  evaluateWickBurst, DEFAULT_WICK_BURST_CFG,
  unifiedDecide,
} from './burst';
export type { BurstSignal, BurstInput, PrecisionExitInput,
  AdaptiveBufferInput, AdaptiveBufferOutput, BufferSession,
  AdaptiveThresholds, RTrade, EdgeCostInput, EdgeCostDecision,
  HysteresisRegime, HysteresisConfig,
  GapCandle, GapConfig,
  FreqCapCfg, FreqRegime,
  SessionId, SessionInfo,
  ExhaustionInput, ExhaustionResult,
  BarSnapshot, WickBurstConfig, WickBurstDecision,
  UnifiedInput, UnifiedDecision, StrategyName,
} from './burst';
export * from './ml/lightgbm-hot-swap';
