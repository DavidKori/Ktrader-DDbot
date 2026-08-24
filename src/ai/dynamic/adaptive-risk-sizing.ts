/**
 * Adaptive Risk Sizing
 * --------------------
 * Replaces static TP/SL with ATR-based dynamic geometry that scales
 * with current volatility while preserving a minimum 1.5:1 R:R.
 *
 *   SL = ATR × 1.0
 *   TP = ATR × 2.5
 *   StakeSize = floor( accountBalance × riskPerTrade / SL_in_$ )
 *
 * Enforces:
 *   - 1.5:1 minimum R:R
 *   - max 2% account risk per trade
 *   - higher confidence floor in high-vol regimes
 */

import { Candle, computeATR } from './regime-detector';

export interface RiskSizingInput {
  candles: Candle[];
  price: number;
  accountBalance: number;
  multiplier: number;          // 100 for forex
  riskPerTrade: number;        // 0..1, e.g. 0.005 = 0.5%
  baseStake: number;           // user-entered base
  confidence: number;          // 0..1
  tpMultiplier?: number;       // regime skew (1.0 default)
  slMultiplier?: number;       // regime skew (1.0 default)
}

export interface RiskSizingOutput {
  atr: number;
  atrPips: number;
  tpPips: number;
  slPips: number;
  trailingPips: number;
  riskReward: number;
  stake: number;
  riskDollar: number;
  effectiveConfidenceFloor: number;
  allowEntry: boolean;
  reason: string;
}

const PIP_SIZE = 0.0001;
const MIN_RR = 1.5;
const ATR_TP_K = 2.5;
const ATR_SL_K = 1.0;
const ATR_TRAIL_K = 0.8;

export function computeAdaptiveRisk(input: RiskSizingInput): RiskSizingOutput {
  const tpK = (input.tpMultiplier ?? 1) * ATR_TP_K;
  const slK = (input.slMultiplier ?? 1) * ATR_SL_K;
  const atr = computeATR(input.candles);
  const atrPips = atr / PIP_SIZE;

  // Volatility-adjusted confidence floor
  const baseFloor = 0.75;
  const volBoost = Math.min(0.10, atrPips / 250); // higher vol => higher floor
  const effectiveConfidenceFloor = baseFloor + volBoost;

  if (input.confidence < effectiveConfidenceFloor) {
    return {
      atr, atrPips, tpPips: 0, slPips: 0, trailingPips: 0, riskReward: 0,
      stake: 0, riskDollar: 0, effectiveConfidenceFloor,
      allowEntry: false,
      reason: `conf ${input.confidence.toFixed(3)} < floor ${effectiveConfidenceFloor.toFixed(3)}`,
    };
  }

  let tpPips = Math.max(6, atrPips * tpK);
  let slPips = Math.max(4, atrPips * slK);
  // Enforce min R:R
  if (tpPips / slPips < MIN_RR) tpPips = slPips * MIN_RR;
  const trailingPips = Math.max(3, atrPips * ATR_TRAIL_K);

  // Position size
  const pipValuePerUnit = PIP_SIZE * input.multiplier; // $ per $1 stake per pip
  const lossPerUnit = slPips * pipValuePerUnit;
  const targetRisk = input.accountBalance * input.riskPerTrade;
  const maxStake = Math.floor((input.accountBalance * 0.02) / Math.max(lossPerUnit, 1e-9));

  if (!Number.isFinite(lossPerUnit) || lossPerUnit <= 0 || !Number.isFinite(maxStake) || maxStake <= 0) {
    return {
      atr, atrPips, tpPips: 0, slPips: 0, trailingPips: 0, riskReward: 0,
      stake: 0, riskDollar: 0, effectiveConfidenceFloor,
      allowEntry: false,
      reason: 'invalid risk geometry',
    };
  }

  if (input.baseStake > maxStake) {
    return {
      atr, atrPips,
      tpPips: +tpPips.toFixed(2),
      slPips: +slPips.toFixed(2),
      trailingPips: +trailingPips.toFixed(2),
      riskReward: +(tpPips / slPips).toFixed(2),
      stake: 0,
      riskDollar: +(input.baseStake * lossPerUnit).toFixed(2),
      effectiveConfidenceFloor,
      allowEntry: false,
      reason: `base stake $${input.baseStake.toFixed(2)} exceeds 2% risk cap stake $${maxStake.toFixed(2)}` ,
    };
  }

  const sizedStake = Math.max(1, Math.floor(targetRisk / lossPerUnit));
  const stake = Math.max(1, Math.min(input.baseStake, sizedStake, maxStake));

  return {
    atr, atrPips,
    tpPips: +tpPips.toFixed(2),
    slPips: +slPips.toFixed(2),
    trailingPips: +trailingPips.toFixed(2),
    riskReward: +(tpPips / slPips).toFixed(2),
    stake,
    riskDollar: +(stake * lossPerUnit).toFixed(2),
    effectiveConfidenceFloor,
    allowEntry: true,
    reason: `ATR=${atrPips.toFixed(1)}p, TP=${tpPips.toFixed(1)}p, SL=${slPips.toFixed(1)}p, R:R=${(tpPips/slPips).toFixed(2)}`,
  };
}
