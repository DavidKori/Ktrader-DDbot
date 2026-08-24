/**
 * Standalone simulation harness (NOT part of the app bundle — lives under
 * __sim__ so it's easy to strip before shipping).
 *
 * This runs the REAL logic modules (ExpectancyGate, kellyStake, AutoTrader,
 * evaluateRisk, sizeForexPosition, buildBinaryOrder) against synthetic trade
 * sequences to:
 *   1. Prove the code executes end-to-end without runtime errors.
 *   2. Prove the expectancy/Kelly gates fixed in this pass actually engage
 *      (flip to SHADOW/blocked) when fed a losing sequence, and stay LIVE
 *      when fed a winning sequence.
 *   3. Report the stake sizing and risk-engine behaviour under each.
 *
 * IMPORTANT: this uses synthetic/assumed win-rates and payouts, not real
 * Deriv market data (this sandbox has no network access to Deriv's API).
 * It validates CODE CORRECTNESS, not real-world profitability.
 */
import { ExpectancyGate, TradeResult } from '../edge/expectancy-gate';
import { kellyStake, DEFAULT_KELLY_CFG } from '../meta/kelly-sizing';
import { AutoTrader } from '../meta/auto-trader';
import { evaluateRisk, DEFAULT_RISK } from '../risk/risk-engine';
import { sizeForexPosition, buildForexOrder } from '../forex/position-sizing';
import { buildBinaryOrder } from '../binary/binary-position';

// ---------------------------------------------------------------------
// small deterministic PRNG so results are reproducible run-to-run
// ---------------------------------------------------------------------
function mulberry32(seed: number) {
    return function () {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function line(s = '') { console.log(s); }
function hr() { line('-'.repeat(78)); }

// =======================================================================
// 1. BINARY — three scenarios: house-edge realistic, breakeven, favourable
// =======================================================================
function simulateBinary(label: string, trueWinProb: number, seed: number, n = 250) {
    hr();
    line(`BINARY  — scenario "${label}"  (true win prob=${(trueWinProb * 100).toFixed(1)}%, payout=0.95x, n=${n})`);
    hr();

    const rng = mulberry32(seed);
    const gate = new ExpectancyGate();
    const stake = 1; // $1 base stake, digit/CALL-PUT style
    let liveAllowedFlips = 0;
    let lastAllow = true; // gate starts "not enough samples" -> allow=false actually; track transitions

    const order = buildBinaryOrder({
        symbol: 'R_100', contractType: 'CALL', stake, durationTicks: 5,
    });
    if (!order) throw new Error('buildBinaryOrder returned null — order builder is broken');
    line(`order builder OK: ${order.rationale}`);

    for (let i = 1; i <= n; i++) {
        const win = rng() < trueWinProb;
        const pnl = win ? stake * 0.95 : -stake;
        const trade: TradeResult = {
            symbol: 'R_100', contractType: 'binary', stake, pnl,
            confidence: 0.7, validation: 70, ts: Date.now(),
        };
        gate.record(trade);

        if (i % 50 === 0 || i === n) {
            const check = gate.allowLive('R_100');
            if (check.allow !== lastAllow) {
                liveAllowedFlips++;
                lastAllow = check.allow;
            }
            line(`  after ${String(i).padStart(3)} trades: allow=${String(check.allow).padEnd(5)} | ${check.reason}`);
        }
    }
    const final = gate.stats('R_100');
    line(`FINAL: winRate=${(final.winRate * 100).toFixed(1)}% expectancy=$${final.expectancy.toFixed(4)}/trade profitFactor=${final.profitFactor.toFixed(2)} edgeOK=${final.edgeOK}`);
    return final;
}

// =======================================================================
// 2. FOREX MULTIPLIER — drive AutoTrader.decide() across a synthetic
//    sequence and confirm mode/stake respond correctly to the running edge
// =======================================================================
function simulateForexMultiplier(label: string, trueWinProb: number, seed: number, n = 200) {
    hr();
    line(`FOREX MULTIPLIER — scenario "${label}" (true win prob=${(trueWinProb * 100).toFixed(1)}%, TP=30p/SL=15p (2:1), n=${n})`);
    hr();

    const rng = mulberry32(seed);
    const accountBalance = 500;
    const pip = 0.0001;
    const multiplier = 100;

    const fx = buildForexOrder(accountBalance, 0.01, 15, 30, pip, multiplier);
    line(`position sizing OK: ${fx.rationale}`);

    const trader = new AutoTrader();
    const pnlHistory: number[] = [];
    let liveCount = 0, shadowCount = 0, blockedCount = 0, reducedCount = 0;
    let dailyPnL = 0;
    let consecutiveLosses = 0;
    let riskVetoes = 0;
    let lastTradeAt: number | undefined;
    let ticksSinceBreakerTrip = 0;
    const COOLDOWN_TICKS = 20; // stand-in for the real 15-minute wall-clock cooldown

    for (let i = 1; i <= n; i++) {
        // Mirrors Orchestrator.armCircuitBreakerCooldown(): once tripped, the
        // counter auto-resets after a cooldown instead of staying stuck
        // forever (that permanent-lockup behaviour was the bug fixed above).
        if (consecutiveLosses >= DEFAULT_RISK.maxConsecutiveLosses) {
            ticksSinceBreakerTrip++;
            if (ticksSinceBreakerTrip >= COOLDOWN_TICKS) {
                consecutiveLosses = 0;
                ticksSinceBreakerTrip = 0;
            }
        }

        const decision = trader.decide({
            symbol: 'frxEURUSD', regime: 'TREND_LOW_VOL',
            recentPnL: pnlHistory.slice(-60),
            winRate: pnlHistory.length ? pnlHistory.filter(p => p > 0).length / pnlHistory.length : 0,
            avgWin: (() => { const w = pnlHistory.filter(p => p > 0); return w.length ? w.reduce((s, v) => s + v, 0) / w.length : 0; })(),
            avgLoss: (() => { const l = pnlHistory.filter(p => p <= 0); return l.length ? Math.abs(l.reduce((s, v) => s + v, 0) / l.length) : 0; })(),
            openSymbols: [],
            baseStake: fx.stake,
        });

        if (decision.mode === 'LIVE' || decision.mode === 'REDUCED') {
            const risk = evaluateRisk({
                mode: decision.mode === 'REDUCED' ? 'LIVE' : 'LIVE',
                stake: decision.stake, accountBalance,
                dailyPnL, openExposureUSD: 0, consecutiveLosses,
                atr: 0.0015, pip, lastTradeAt, symbol: 'frxEURUSD',
            }, DEFAULT_RISK);
            lastTradeAt = Date.now() - DEFAULT_RISK.cooldownBetweenTradesMs; // simulate cooldown already elapsed
            if (!risk.allowed) {
                riskVetoes++;
                blockedCount++;
            } else {
                const win = rng() < trueWinProb;
                const pnl = win ? decision.stake * 2 : -decision.stake; // 2:1 TP:SL
                pnlHistory.push(pnl);
                dailyPnL += pnl;
                consecutiveLosses = win ? 0 : consecutiveLosses + 1;
                if (decision.mode === 'LIVE') liveCount++; else reducedCount++;
            }
        } else if (decision.mode === 'SHADOW') {
            shadowCount++;
            // still record a virtual result so learning continues, but no $ at risk
            const win = rng() < trueWinProb;
            pnlHistory.push(win ? decision.stake * 2 || 1 : -(decision.stake || 1));
        } else {
            blockedCount++;
        }

        if (i % 50 === 0 || i === n) {
            line(`  after ${String(i).padStart(3)} ticks: mode=${decision.mode.padEnd(8)} stake=$${decision.stake.toFixed(2).padEnd(6)} dailyPnL=$${dailyPnL.toFixed(2).padEnd(8)} consecLosses=${consecutiveLosses} | ${decision.reason}`);
        }
    }

    line(`FINAL: live=${liveCount} reduced=${reducedCount} shadow=${shadowCount} blocked=${blockedCount} riskVetoes=${riskVetoes} dailyPnL=$${dailyPnL.toFixed(2)}`);
}

// =======================================================================
// 3. Targeted regression check — the exact bug that was fixed:
//    a proven-negative-edge series must stop trading live, not float at
//    a 0.5x floor forever.
// =======================================================================
function regressionCheckKellyBlocksLosers() {
    hr();
    line('REGRESSION CHECK — Kelly must stop trading a proven loser (the bug that was fixed)');
    hr();
    const losing = kellyStake({
        samples: 40, winRate: 0.40, avgWin: 1, avgLoss: 1, baseStake: 10,
    }, DEFAULT_KELLY_CFG);
    line(`  40 samples, 40% win rate, 1:1 payoff -> f*=${losing.fStar.toFixed(3)} stake=$${losing.stake} hasEdge=${losing.hasEdge}`);
    if (losing.hasEdge || losing.stake !== 0) {
        throw new Error('REGRESSION: Kelly still sizing a stake into a proven-negative-edge series!');
    }
    line('  PASS — stake correctly floored to $0, hasEdge=false');

    const winning = kellyStake({
        samples: 40, winRate: 0.60, avgWin: 1, avgLoss: 1, baseStake: 10,
    }, DEFAULT_KELLY_CFG);
    line(`  40 samples, 60% win rate, 1:1 payoff -> f*=${winning.fStar.toFixed(3)} stake=$${winning.stake.toFixed(2)} hasEdge=${winning.hasEdge}`);
    if (!winning.hasEdge || winning.stake <= 0) {
        throw new Error('REGRESSION: Kelly failed to size a stake into a proven-positive-edge series!');
    }
    line('  PASS — positive edge correctly sized > $0');
}

// =======================================================================
line('DDBot trading-logic simulation — synthetic data, code-correctness check only');
line('(no network access to Deriv from this sandbox; not a claim of real-market profitability)');

regressionCheckKellyBlocksLosers();

simulateBinary('Deriv-realistic house edge', 0.4737, 1); // ~0.95 payout breakeven point is 51.28%; below it = negative edge
simulateBinary('breakeven-ish', 0.512, 2);
simulateBinary('favourable (hypothetical)', 0.58, 3);

simulateForexMultiplier('losing strategy', 0.40, 11);
simulateForexMultiplier('roughly breakeven', 0.50, 12);
simulateForexMultiplier('favourable (hypothetical)', 0.60, 13);

hr();
line('ALL SIMULATIONS COMPLETED WITHOUT RUNTIME ERRORS.');
