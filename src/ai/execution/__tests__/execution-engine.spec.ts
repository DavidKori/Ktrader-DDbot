import { ExecutionEngine } from '../execution-engine';

const validation = { score: 95, breakdown: {}, reasons: [] } as any;

describe('ExecutionEngine', () => {
    it('resets martingale level after a non-martingale loss', () => {
        const engine = new ExecutionEngine();
        engine.setBalance(1000);

        // First elite loss arms martingale level 1.
        engine.recordLive({ won: false, pnl: -1, wasMartingale: true });
        expect(engine.snapshot().martingaleLevel).toBe(1);

        // A normal live loss must not inherit the previous martingale ladder.
        engine.recordLive({ won: false, pnl: -1, wasMartingale: false });
        expect(engine.snapshot().martingaleLevel).toBe(0);

        const next = engine.decide({
            fusionConfidence: 0.96,
            validation,
            regime: 'trend' as any,
            marketStable: true,
            accountBalance: 1000,
            dailyPnL: -2,
        });

        expect(next.martingaleLevel).toBe(0);
    });
});
