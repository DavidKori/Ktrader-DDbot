import { evaluateRisk, DEFAULT_RISK } from '../risk-engine';

describe('evaluateRisk', () => {
    it('blocks aggregate exposure using notional units consistently', () => {
        const verdict = evaluateRisk(
            {
                mode: 'LIVE',
                stake: 5,
                accountBalance: 100,
                dailyPnL: 0,
                openExposureUSD: 18,
                consecutiveLosses: 0,
                atr: 0.001,
                pip: 0.0001,
                symbol: 'frxEURUSD',
            },
            {
                ...DEFAULT_RISK,
                maxExposurePct: 0.2,
                multiplierForex: 1,
                maxStake: 50,
            }
        );

        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toMatch(/Aggregate exposure cap exceeded/);
    });

    it('falls back to sane SL/TP values when ATR or pip inputs are invalid', () => {
        const verdict = evaluateRisk({
            mode: 'LIVE',
            stake: 1,
            accountBalance: 1000,
            dailyPnL: 0,
            openExposureUSD: 0,
            consecutiveLosses: 0,
            atr: 0,
            pip: 0,
            symbol: 'R_100',
        });

        expect(verdict.allowed).toBe(true);
        expect(verdict.stopLossPips).toBeGreaterThanOrEqual(5);
        expect(verdict.takeProfitPips).toBeGreaterThanOrEqual(10);
    });
});
