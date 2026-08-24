/**
 * Session Engine — v5.4 (DST-aware)
 * ==================================
 * Classifies the current UTC time into forex sessions and returns a
 * liquidity score used by execution and buffer widening.
 *
 * Approximation notes:
 *   - Uses fixed UTC boundaries with DST-aware shims for London/NY.
 *   - LDN observes DST last Sunday of March → last Sunday of October.
 *   - NY  observes DST second Sunday of March → first Sunday of November.
 *   - During DST-shifted months, London/NY open one hour earlier in UTC.
 */

export type SessionId =
    | 'ASIA_LULL' | 'SYDNEY' | 'TOKYO' | 'TOKYO_LDN_OVERLAP'
    | 'LDN_OPEN' | 'LDN_MAIN' | 'LDN_NY_OVERLAP' | 'NY_MAIN'
    | 'NY_CLOSE' | 'OFF';

export interface SessionInfo {
    id: SessionId;
    liquidityScore: number;    // 0..1
    isMajorSession: boolean;
    dstActive: { ldn: boolean; ny: boolean };
    utcHour: number;
}

function ldnDstActive(d: Date): boolean {
    const m = d.getUTCMonth() + 1;
    if (m > 3 && m < 10) return true;
    if (m === 3) {
        // last Sunday of March 01:00 UTC
        const lastSun = new Date(Date.UTC(d.getUTCFullYear(), 2, 31));
        while (lastSun.getUTCDay() !== 0) lastSun.setUTCDate(lastSun.getUTCDate() - 1);
        return d >= new Date(Date.UTC(d.getUTCFullYear(), 2, lastSun.getUTCDate(), 1));
    }
    if (m === 10) {
        const lastSun = new Date(Date.UTC(d.getUTCFullYear(), 9, 31));
        while (lastSun.getUTCDay() !== 0) lastSun.setUTCDate(lastSun.getUTCDate() - 1);
        return d < new Date(Date.UTC(d.getUTCFullYear(), 9, lastSun.getUTCDate(), 1));
    }
    return false;
}

function nyDstActive(d: Date): boolean {
    const m = d.getUTCMonth() + 1;
    if (m > 3 && m < 11) return true;
    if (m === 3) {
        // second Sunday of March 07:00 UTC (02:00 EST)
        const sundays: number[] = [];
        for (let day = 1; day <= 14; day++) {
            if (new Date(Date.UTC(d.getUTCFullYear(), 2, day)).getUTCDay() === 0) sundays.push(day);
        }
        const secondSun = sundays[1];
        return d >= new Date(Date.UTC(d.getUTCFullYear(), 2, secondSun, 7));
    }
    if (m === 11) {
        // first Sunday of November 06:00 UTC
        let firstSun = 1;
        for (let day = 1; day <= 7; day++) {
            if (new Date(Date.UTC(d.getUTCFullYear(), 10, day)).getUTCDay() === 0) {
                firstSun = day; break;
            }
        }
        return d < new Date(Date.UTC(d.getUTCFullYear(), 10, firstSun, 6));
    }
    return false;
}

export function classifySession(nowMs = Date.now()): SessionInfo {
    const d = new Date(nowMs);
    const h = d.getUTCHours();
    const ldnDst = ldnDstActive(d);
    const nyDst  = nyDstActive(d);
    // Shift LDN/NY open by 1 hour when their DST is active
    const ldnOpen  = ldnDst ? 6 : 7;
    const ldnClose = ldnDst ? 15 : 16;
    const nyOpen   = nyDst  ? 12 : 13;
    const nyClose  = nyDst  ? 20 : 21;

    let id: SessionId = 'OFF';
    let liq = 0.2;
    if      (h >= 22 || h < 1)                     { id = 'ASIA_LULL';         liq = 0.15; }
    else if (h >= 1  && h < 3)                     { id = 'SYDNEY';            liq = 0.25; }
    else if (h >= 3  && h < ldnOpen)               { id = 'TOKYO';             liq = 0.40; }
    else if (h >= ldnOpen && h < ldnOpen + 2)      { id = 'TOKYO_LDN_OVERLAP'; liq = 0.65; }
    else if (h >= ldnOpen + 2 && h < nyOpen)       { id = h === ldnOpen + 2 ? 'LDN_OPEN' : 'LDN_MAIN'; liq = 0.80; }
    else if (h >= nyOpen && h < ldnClose)          { id = 'LDN_NY_OVERLAP';    liq = 1.00; }
    else if (h >= ldnClose && h < nyClose)         { id = 'NY_MAIN';           liq = 0.70; }
    else if (h >= nyClose && h < 22)               { id = 'NY_CLOSE';          liq = 0.35; }

    return {
        id, liquidityScore: liq,
        isMajorSession: liq >= 0.65,
        dstActive: { ldn: ldnDst, ny: nyDst },
        utcHour: h,
    };
}
