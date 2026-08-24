/**
 * Regime Memory (Architecture #9)
 * ===============================
 * Maintains a per-(symbol, regime) memory of which parameter bucket
 * worked. When the live RegimeDetector reports the same regime returning,
 * the meta-optimizer immediately warm-starts with the previously-best
 * bucket for that regime — saving the warm-up window cost.
 *
 * Regimes (as in dynamic/regime-detector.ts):
 *   TREND_HIGH_VOL, TREND_LOW_VOL, RANGE_HIGH_VOL, RANGE_LOW_VOL
 */

export type RegimeId = 'TREND_HIGH_VOL' | 'TREND_LOW_VOL' | 'RANGE_HIGH_VOL' | 'RANGE_LOW_VOL';

export interface RegimeRecall {
  symbol: string;
  regime: RegimeId;
  bestBucket: string;
  expectancy: number;
  samples: number;
  lastUpdated: number;
}

export class RegimeMemory {
  private mem = new Map<string, RegimeRecall>();   // key = `${symbol}|${regime}`

  private key(symbol: string, regime: RegimeId): string {
    return `${symbol}|${regime}`;
  }

  /** Update memory after a closed trade. */
  update(symbol: string, regime: RegimeId, bucketId: string, pnl: number, now = Date.now()): void {
    const k = this.key(symbol, regime);
    const prev = this.mem.get(k);
    if (!prev || prev.bestBucket !== bucketId) {
      if (!prev) {
        this.mem.set(k, { symbol, regime, bestBucket: bucketId, expectancy: pnl, samples: 1, lastUpdated: now });
        return;
      }
      // Different bucket — only replace if new bucket exceeds prev
      const newAvg = pnl;
      if (newAvg > prev.expectancy * 1.10) {
        this.mem.set(k, { symbol, regime, bestBucket: bucketId, expectancy: newAvg, samples: 1, lastUpdated: now });
      }
      return;
    }
    const n = prev.samples + 1;
    const newE = prev.expectancy + (pnl - prev.expectancy) / n;
    this.mem.set(k, { ...prev, expectancy: newE, samples: n, lastUpdated: now });
  }

  /** Recall the best bucket previously seen in this regime, or undefined. */
  recall(symbol: string, regime: RegimeId): RegimeRecall | undefined {
    return this.mem.get(this.key(symbol, regime));
  }

  snapshot(): RegimeRecall[] {
    return Array.from(this.mem.values());
  }
}
