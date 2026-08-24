/**
 * Exposure Controls — v5.2 (Priority 2)
 * --------------------------------------
 * Hard caps that prevent over-trading during volatile periods.
 * These are CUMULATIVE counters, separate from per-trade risk gates.
 */
export interface ExposureLimits {
    maxTradesPerDay:        number;   // 50
    maxTradesPerHour:       number;   // 10
    maxExposurePerSymbol:   number;   // 0.05 → 5 % of balance in one symbol
    maxExposureTotal:       number;   // 0.10 → 10 % of balance across all open positions
}

// v5.6.2-clean: exposure figures are now MAX-LOSS (stake) units, not notional.
// Deriv multiplier contracts stop out at 100% of stake, so stake is the real
// capital at risk. 10 % per symbol / 25 % total of balance is the worst-case
// loss envelope if every open position stops out simultaneously; the
// confidence gate (>=85%), circuit breaker and daily-loss cap layer on top.
export const DEFAULT_EXPOSURE_LIMITS: ExposureLimits = {
    maxTradesPerDay:      50,
    maxTradesPerHour:     10,
    maxExposurePerSymbol: 0.10,   // 10 % of balance at risk in one symbol (stake units)
    maxExposureTotal:     0.25,   // 25 % of balance at risk in total (stake units)
};
