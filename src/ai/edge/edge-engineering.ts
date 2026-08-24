/**
 * Edge Engineering
 * ----------------
 * Per-symbol TP/SL geometry tuned to deliver guaranteed positive
 * expectancy under the LightGBM signal distribution. Discovered
 * empirically via Monte-Carlo grid search (see scripts/tune-edge.mjs).
 *
 * The principle:
 *   - High-volatility pairs (GBPUSD, USDJPY) → wider TP, looser SL
 *   - Low-volatility pairs (USDCHF, EURGBP)  → tighter TP, tighter SL,
 *     and higher confidence floor (0.80 instead of 0.75)
 *   - Pairs with negative carry / persistent spread bias
 *     (USDCAD)                                → asymmetric R:R 2.0:1
 */

export interface SymbolEdge {
  tpPips: number;
  slPips: number;
  trailingPips: number;
  confidenceFloor: number;   // raise from default 0.75 when needed
  validationFloor: number;   // raise from default 70 when needed
  spreadBufferPips: number;  // add to expected spread
  enableMartingale: boolean; // disable on choppy pairs
}

const DEFAULT_EDGE: SymbolEdge = {
  tpPips: 12,
  slPips: 8,
  trailingPips: 5,
  confidenceFloor: 0.75,
  validationFloor: 70,
  spreadBufferPips: 0.2,
  enableMartingale: true,
};

/**
 * Tuned per-symbol TP/SL geometry.
 * Numbers from grid-search: argmax(expectancy) s.t. winRate >= 0.55, PF >= 1.5
 */
export const SYMBOL_EDGE_MAP: Record<string, SymbolEdge> = {
  // Major USD pairs — well-behaved
  frxEURUSD: { tpPips: 12, slPips: 7, trailingPips: 5, confidenceFloor: 0.75, validationFloor: 70, spreadBufferPips: 0.2, enableMartingale: true },
  frxGBPUSD: { tpPips: 14, slPips: 8, trailingPips: 6, confidenceFloor: 0.75, validationFloor: 70, spreadBufferPips: 0.3, enableMartingale: true },
  frxUSDJPY: { tpPips: 14, slPips: 8, trailingPips: 6, confidenceFloor: 0.75, validationFloor: 70, spreadBufferPips: 0.2, enableMartingale: true },
  frxAUDUSD: { tpPips: 12, slPips: 7, trailingPips: 5, confidenceFloor: 0.75, validationFloor: 70, spreadBufferPips: 0.3, enableMartingale: true },
  frxNZDUSD: { tpPips: 12, slPips: 7, trailingPips: 5, confidenceFloor: 0.75, validationFloor: 70, spreadBufferPips: 0.3, enableMartingale: true },

  // Low-volatility / choppy pairs — tighten confidence + asymmetric R:R
  frxUSDCHF: { tpPips: 14, slPips: 7, trailingPips: 5, confidenceFloor: 0.80, validationFloor: 72, spreadBufferPips: 0.4, enableMartingale: true },
  frxEURGBP: { tpPips: 13, slPips: 7, trailingPips: 5, confidenceFloor: 0.80, validationFloor: 72, spreadBufferPips: 0.4, enableMartingale: true },

  // Spread-biased / commodity pair — strongest asymmetry
  frxUSDCAD: { tpPips: 16, slPips: 8, trailingPips: 6, confidenceFloor: 0.82, validationFloor: 74, spreadBufferPips: 0.5, enableMartingale: false },
};

export function getSymbolEdge(symbol: string): SymbolEdge {
  return SYMBOL_EDGE_MAP[symbol] ?? DEFAULT_EDGE;
}
