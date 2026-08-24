// ============================================================================
// Durable trading-risk state.
// ----------------------------------------------------------------------------
// Risk counters (open contracts, daily stake, daily loss) MUST survive process
// restarts and multiple serverless Function instances, otherwise a reconnect
// can land on a fresh instance whose counters are all zero and silently bypass
// MAX_OPEN_CONTRACTS / MAX_DAILY_LOSS.
//
// Backends, chosen automatically:
//   1. Upstash Redis REST  (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
//      -> shared across every Function instance. Required for real money.
//   2. Local JSON file     (RISK_STATE_FILE, default <tmp>/ddbot-risk-state.json)
//      -> survives restarts on a single host/VPS.
//   3. In-memory Map       -> last resort only.
//
// Redis reservations use an atomic server-side Lua script across Function instances;
// local file/memory fallbacks use a per-process promise lock and are not shared.
// ============================================================================
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_SECONDS = 3 * 24 * 60 * 60;

const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const STATE_FILE = String(
  process.env.RISK_STATE_FILE || path.join(os.tmpdir(), 'ddbot-risk-state.json')
);

function today() {
  return new Date().toISOString().slice(0, 10);
}

function emptyState() {
  return { day: today(), openContracts: 0, totalStakeToday: 0, lossToday: 0 };
}

function normalize(state) {
  if (!state || typeof state !== 'object' || state.day !== today()) return emptyState();
  return {
    day: state.day,
    openContracts: Math.max(0, Number(state.openContracts) || 0),
    totalStakeToday: Math.max(0, Number(state.totalStakeToday) || 0),
    lossToday: Math.max(0, Number(state.lossToday) || 0),
  };
}

/* ------------------------------- backends ------------------------------- */

const memory = new Map();

const memoryBackend = {
  name: 'memory',
  async read(key) {
    return memory.get(key) || null;
  },
  async write(key, state) {
    memory.set(key, state);
  },
};

const fileBackend = {
  name: 'file',
  async read(key) {
    try {
      const raw = await fs.readFile(STATE_FILE, 'utf8');
      const all = JSON.parse(raw);
      return all?.[key] || null;
    } catch {
      return null;
    }
  },
  async write(key, state) {
    let all = {};
    try {
      all = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) || {};
    } catch {
      all = {};
    }
    // Drop stale days so the file cannot grow without bound.
    for (const [k, v] of Object.entries(all)) {
      if (!v || Date.parse(`${v.day}T00:00:00Z`) < Date.now() - 3 * DAY_MS) delete all[k];
    }
    all[key] = state;
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(all), 'utf8');
    await fs.rename(tmp, STATE_FILE);
  },
};

async function upstash(command) {
  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${UPSTASH_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify([command]),
  });
  if (!res.ok) throw new Error(`Risk store unavailable (${res.status}).`);
  const body = await res.json();
  const entry = Array.isArray(body) ? body[0] : body;
  if (entry?.error) throw new Error(`Risk store error: ${entry.error}`);
  return entry?.result ?? null;
}

const REDIS_PREFIX = 'ddbot:risk:';

async function upstashCommand(command) {
  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${UPSTASH_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify([command]),
  });
  if (!res.ok) throw new Error(`Risk store unavailable (${res.status}).`);
  const body = await res.json();
  const entry = Array.isArray(body) ? body[0] : body;
  if (entry?.error) throw new Error(`Risk store error: ${entry.error}`);
  return entry?.result ?? null;
}

/*
 * IMPORTANT: the risk gate is a read/modify/write decision. A Redis pipeline
 * is NOT atomic for this purpose: another Function instance can run between
 * GET and SET. Upstash supports EVAL over REST, and Redis executes the Lua
 * script as one atomic server-side operation.
 *
 * The script:
 *   - creates/resets the day-scoped state
 *   - validates stake, open-contract and daily-loss limits
 *   - increments the reservation only when all limits pass
 *   - sets a short TTL so stale daily keys disappear automatically
 *
 * Return values:
 *   [1, jsonState] = reserved
 *   [0, reason]    = rejected
 */
const RESERVE_RISK_LUA = `
local raw = redis.call('GET', KEYS[1])
local state
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and decoded then state = decoded end
end

local day = ARGV[1]
local maxOpen = tonumber(ARGV[2])
local maxLoss = tonumber(ARGV[3])
local maxStake = tonumber(ARGV[4])
local stake = tonumber(ARGV[5])

if not state or state.day ~= day then
  state = {
    day = day,
    openContracts = 0,
    totalStakeToday = 0,
    lossToday = 0
  }
end

if stake < 0 then
  return {0, 'invalid_stake'}
end

if stake > maxStake then
  return {0, 'stake_limit'}
end

if tonumber(state.openContracts or 0) >= maxOpen then
  return {0, 'open_limit'}
end

if tonumber(state.lossToday or 0) >= maxLoss then
  return {0, 'loss_limit'}
end

local nextStake = tonumber(state.totalStakeToday or 0) + stake
state.openContracts = tonumber(state.openContracts or 0) + 1
state.totalStakeToday = nextStake
state.lossToday = tonumber(state.lossToday or 0)

local encoded = cjson.encode(state)
redis.call('SET', KEYS[1], encoded, 'EX', ARGV[6])
return {1, encoded}
`;


/*
 * Settlement/rollback updates are also a read/modify/write operation.
 * A plain GET followed by SET can lose a concurrent settlement when two
 * Function instances update the same account at the same time. Keep the
 * additive delta operation inside Redis so the entire read/adjust/write
 * happens atomically across every Vercel instance.
 *
 * ARGV:
 *   1 = UTC day
 *   2 = openContracts delta
 *   3 = totalStakeToday delta
 *   4 = lossToday delta
 *   5 = TTL seconds
 *
 * Returns the JSON state after the atomic update.
 */
const APPLY_RISK_DELTA_LUA = `
local raw = redis.call('GET', KEYS[1])
local state
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and decoded then state = decoded end
end

local day = ARGV[1]
if not state or state.day ~= day then
  state = {
    day = day,
    openContracts = 0,
    totalStakeToday = 0,
    lossToday = 0
  }
end

local openDelta = tonumber(ARGV[2]) or 0
local stakeDelta = tonumber(ARGV[3]) or 0
local lossDelta = tonumber(ARGV[4]) or 0

state.openContracts = math.max(0, tonumber(state.openContracts or 0) + openDelta)
state.totalStakeToday = math.max(0, tonumber(state.totalStakeToday or 0) + stakeDelta)
state.lossToday = math.max(0, tonumber(state.lossToday or 0) + lossDelta)

local encoded = cjson.encode(state)
redis.call('SET', KEYS[1], encoded, 'EX', ARGV[5])
return encoded
`;

const redisBackend = {
  name: 'upstash-redis',

  async read(key) {
    const raw = await upstashCommand(['GET', `${REDIS_PREFIX}${key}`]);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  async write(key, state) {
    await upstashCommand([
      'SET',
      `${REDIS_PREFIX}${key}`,
      JSON.stringify(state),
      'EX',
      String(TTL_SECONDS),
    ]);
  },

  async reserve(key, { amount, maxOpenContracts, maxDailyLoss, maxStake }) {
    const result = await upstashCommand([
      'EVAL',
      RESERVE_RISK_LUA,
      '1',
      `${REDIS_PREFIX}${key}`,
      today(),
      String(maxOpenContracts),
      String(maxDailyLoss),
      String(maxStake),
      String(amount),
      String(TTL_SECONDS),
    ]);

    if (!Array.isArray(result) || result.length < 2) {
      throw new Error('Risk store returned an invalid atomic reservation response.');
    }

    const ok = Number(result[0]) === 1;
    if (!ok) {
      const reasonMap = {
        invalid_stake: 'Invalid stake.',
        stake_limit: `Stake exceeds max stake ${maxStake}.`,
        open_limit: `Too many open contracts. Max ${maxOpenContracts}.`,
        loss_limit: `Daily loss limit reached: ${maxDailyLoss}.`,
      };
      return { ok: false, reason: reasonMap[String(result[1])] || 'Risk limit rejected.' };
    }

    let state;
    try {
      state = JSON.parse(String(result[1]));
    } catch {
      throw new Error('Risk store returned invalid state JSON.');
    }
    return { ok: true, state: normalize(state) };
  },

  async update(key, delta) {
    const result = await upstashCommand([
      'EVAL',
      APPLY_RISK_DELTA_LUA,
      '1',
      `${REDIS_PREFIX}${key}`,
      today(),
      String(Number(delta.openContracts) || 0),
      String(Number(delta.totalStakeToday) || 0),
      String(Number(delta.lossToday) || 0),
      String(TTL_SECONDS),
    ]);

    if (typeof result !== 'string') {
      throw new Error('Risk store returned an invalid atomic settlement response.');
    }

    try {
      return normalize(JSON.parse(result));
    } catch {
      throw new Error('Risk store returned invalid settlement state JSON.');
    }

  },
};

const backend =
  UPSTASH_URL && UPSTASH_TOKEN ? redisBackend : STATE_FILE ? fileBackend : memoryBackend;

export const riskStoreName = backend.name;
export const riskStoreIsShared = backend.name === 'upstash-redis';

/* ---------------------------- serialised access ---------------------------- */

const queues = new Map();

function withLock(key, fn) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.then(fn, fn);
  queues.set(
    key,
    next.catch(() => {})
  );
  return next;
}


/**
 * Atomically reserve one potential trade.
 *
 * Redis/Upstash uses a server-side Lua EVAL so the limit check and increment
 * happen as one atomic operation across all Vercel Function instances.
 * Local file/memory backends retain the per-process lock and are suitable only
 * for local/VPS testing; production must set REQUIRE_SHARED_RISK_STORE=true.
 */
export function reserveRiskState(key, { amount, maxOpenContracts, maxDailyLoss, maxStake }) {
  return withLock(key, async () => {
    if (backend.reserve) {
      return backend.reserve(key, {
        amount: Number(amount) || 0,
        maxOpenContracts,
        maxDailyLoss,
        maxStake,
      });
    }

    const current = normalize(await backend.read(key));
    const stake = Number(amount) || 0;
    if (stake < 0) return { ok: false, reason: 'Invalid stake.' };
    if (stake > maxStake) {
      return { ok: false, reason: `Stake exceeds max stake ${maxStake}.` };
    }
    if (current.openContracts >= maxOpenContracts) {
      return { ok: false, reason: `Too many open contracts. Max ${maxOpenContracts}.` };
    }
    if (current.lossToday >= maxDailyLoss) {
      return { ok: false, reason: `Daily loss limit reached: ${maxDailyLoss}.` };
    }

    const next = {
      ...current,
      openContracts: current.openContracts + 1,
      totalStakeToday: current.totalStakeToday + stake,
    };
    await backend.write(key, next);
    return { ok: true, state: next };
  });
}

/** Read the current (day-scoped) risk state for a session key. */
export function readRiskState(key) {
  return withLock(key, async () => normalize(await backend.read(key)));
}

/**
 * Atomically apply additive deltas to the stored risk state.
 * Returns the state after the update.
 */
export function updateRiskState(key, delta) {
  return withLock(key, async () => {
    if (backend.update) {
      return backend.update(key, {
        openContracts: Number(delta?.openContracts) || 0,
        totalStakeToday: Number(delta?.totalStakeToday) || 0,
        lossToday: Number(delta?.lossToday) || 0,
      });
    }

    const current = normalize(await backend.read(key));
    const next = {
      day: current.day,
      openContracts: Math.max(0, current.openContracts + (Number(delta?.openContracts) || 0)),
      totalStakeToday: Math.max(0, current.totalStakeToday + (Number(delta?.totalStakeToday) || 0)),
      lossToday: Math.max(0, current.lossToday + (Number(delta?.lossToday) || 0)),
    };
    await backend.write(key, next);
    return next;
  });
}
