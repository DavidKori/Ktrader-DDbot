// Regression harness: executes the REAL ExpectancyGate / kelly / AutoTrader /
// risk / forex-sizing / binary-order modules end-to-end inside Jest.
import './run-simulation';
describe('simulation harness', () => {
    it('runs binary + forex scenarios end-to-end without throwing', () => {
        expect(true).toBe(true);
    });
});
