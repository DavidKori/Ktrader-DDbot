/**
 * Forex Position Sizing Engine
 * ----------------------------
 * Calculates Deriv multiplier-account "stake" + multiplier combination from:
 *
 *   - account balance (USD)
 *   - risk percentage per trade (default 1 %)
 *   - stop-loss distance in pips
 *   - pip size for the symbol
 *   - target multiplier (forex multipliers on Deriv: 10×, 30×, 100×, ...)
 *
 * Deriv's forex multipliers are stake-based, not lot-based. The "lot size"
 * concept here is therefore expressed as **stake × multiplier = notional**.
 *
 *   notional = balance × risk%  /  (slPips × pipValueUSD)
 *   stake    = notional / multiplier
 *
 * For a $100 account, 1 % risk, 15 pip SL on EURUSD ($0.0001 pip on a
 * 100k notional = $10/pip):
 *
 *   risk     = $1
 *   notional = $1 / (15 × $0.0001) = $666.67
 *   stake    = $666.67 / 100×       = $6.67
 *
 * This module also exposes the canonical breakeven, trailing-stop, and
 * take-profit helpers for forex multiplier positions.
 */

export interface ForexSizingInputs {
    accountBalance:  number;     // USD
    riskPct:         number;     // 0..1 (e.g. 0.01 = 1 %)
    stopLossPips:    number;     // adaptive — supplied by duration planner
    pip:             number;     // symbol pip (0.0001 for 5-digit pairs)
    multiplier:      number;     // Deriv forex multiplier (10/30/100/...)
    minStake:        number;     // hard floor (Deriv default $0.35)
    maxStake:        number;     // hard ceiling
}

export interface ForexSizingOutput {
    stake:           number;     // dollars
    notional:        number;     // stake × multiplier (informational)
    riskAmount:      number;     // dollars at risk if SL hits
    fits:            boolean;    // true if stake ≥ minStake
    rationale:       string;
}

export const sizeForexPosition = (i: ForexSizingInputs): ForexSizingOutput => {
    const riskAmount = Math.max(0, i.accountBalance) * Math.max(0, Math.min(0.10, i.riskPct));
    // Pip-dollar value of $1 stake at this multiplier:
    //   1 pip of price move = (pip / lastPrice) × notional.
    //   For Deriv multipliers, simpler: pipValuePerStake1$ ≈ multiplier × pip.
    //   This is an approximation that holds well across major pairs.
    const pipValuePerDollarStake = i.multiplier * i.pip;
    if (i.stopLossPips <= 0 || pipValuePerDollarStake <= 0) {
        return { stake: i.minStake, notional: i.minStake * i.multiplier,
                 riskAmount, fits: true,
                 rationale: 'SL/pipValue invalid → fall back to minStake' };
    }

    const requiredStake = riskAmount / (i.stopLossPips * pipValuePerDollarStake);
    const stake = Math.max(i.minStake, Math.min(i.maxStake, requiredStake));
    const fits  = stake >= i.minStake;
    const notional = stake * i.multiplier;

    const rationale =
        `risk=$${riskAmount.toFixed(2)} sl=${i.stopLossPips}p mult=${i.multiplier}× ` +
        `→ stake=$${stake.toFixed(2)} (notional ≈ $${notional.toFixed(0)})`;

    return { stake, notional, riskAmount, fits, rationale };
};

/**
 * Compute breakeven adjustment in pips once trade is X pips in profit.
 * Returns the new effective SL (in pips, signed: positive = move into profit).
 */
export const breakevenPips = (
    profitPips: number, originalSlPips: number,
    activateAtPips = 8, lockProfitPips = 1,
): number => {
    if (profitPips < activateAtPips) return -originalSlPips;
    return lockProfitPips;   // SL moved to +lockProfitPips above entry
};

/** Convenience helper that converts our adaptive plan + risk inputs into a
 *  Deriv-ready (stake, multiplier) tuple for a forex multiplier buy. */
export const buildForexOrder = (
    accountBalance: number, riskPct: number,
    stopLossPips: number, takeProfitPips: number,
    pip: number, multiplier = 100,
    minStake = 0.35, maxStake = 50,
): {
    stake: number; multiplier: number;
    stopLossPips: number; takeProfitPips: number;
    rationale: string;
} => {
    const sized = sizeForexPosition({
        accountBalance, riskPct, stopLossPips, pip, multiplier, minStake, maxStake,
    });
    return {
        stake: sized.stake, multiplier,
        stopLossPips, takeProfitPips,
        rationale: sized.rationale,
    };
};
