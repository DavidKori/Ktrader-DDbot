// ============================================================================
// DDBOt Deriv OAuth + account service
// ----------------------------------------------------------------------------
// This service implements the production server responsibilities:
//   - OAuth 2.0 Authorization Code with PKCE
//   - REST account discovery
//   - access-token refresh and cookie-backed session persistence
//   - selected-account tracking for browser session restore
//   - optional OTP issuance route for future non-browser integrations
// ============================================================================
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import cookie from 'cookie';
import {
  readRiskState,
  updateRiskState,
  reserveRiskState,
  riskStoreName,
  riskStoreIsShared,
} from './risk-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const APP_ID = String(process.env.DERIV_APP_ID || '').trim();
const OAUTH_CLIENT_ID = String(process.env.DERIV_OAUTH_APP_ID || APP_ID).trim();
const REDIRECT_URI = String(
  process.env.DERIV_REDIRECT_URI || 'http://localhost:3001/auth/deriv/callback'
).trim();
const FRONTEND_ORIGIN = String(
  process.env.FRONTEND_ORIGIN || 'http://localhost:8443'
).trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim();
const PORT = Number(process.env.PROXY_PORT || process.env.PORT || 3001);
const REST_BASE = String(
  process.env.DERIV_REST_BASE || 'https://api.derivws.com'
).replace(/\/+$/, '');
const AUTHORIZE_URL = String(
  process.env.DERIV_OAUTH_AUTHORIZE_URL || 'https://auth.deriv.com/oauth2/auth'
).trim();
const TOKEN_URL = String(
  process.env.DERIV_OAUTH_TOKEN_URL || 'https://auth.deriv.com/oauth2/token'
).trim();
const COOKIE_NAME = 'twk_auth';
const OAUTH_COOKIE = 'twk_oauth';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

const MAX_STAKE = Number(process.env.MAX_STAKE || 100);
const MAX_OPEN_CONTRACTS = Number(process.env.MAX_OPEN_CONTRACTS || 2);
const MAX_DAILY_LOSS = Number(process.env.MAX_DAILY_LOSS || 300);
const ALLOWED_SYMBOLS = (process.env.ALLOWED_SYMBOLS || 'frxEURUSD,frxGBPUSD,frxUSDJPY,frxAUDUSD,frxUSDCAD,frxUSDCHF,frxNZDUSD,frxEURGBP,frxEURJPY,frxGBPJPY,frxAUDJPY,frxEURAUD,frxEURCAD,frxGBPAUD,frxXAUUSD,frxXAGUSD,R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V,BOOM500,BOOM1000,CRASH500,CRASH1000,stpRNG,JD10,JD25,JD50,JD75,JD100,RDBEAR,RDBULL')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

if (!APP_ID) throw new Error('DERIV_APP_ID is required.');
if (!OAUTH_CLIENT_ID) throw new Error('DERIV_OAUTH_APP_ID or DERIV_APP_ID is required.');
if (process.env.NODE_ENV === 'production' && SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters in production.');
}

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);
app.use(cors({
  origin: FRONTEND_ORIGIN.split(',').map((x) => x.trim()).filter(Boolean),
  credentials: true,
}));
app.use(express.json());

function keyBytes() {
  return crypto.createHash('sha256').update(SESSION_SECRET || 'dev-only-secret').digest();
}

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

function unseal(value) {
  try {
    const raw = Buffer.from(String(value), 'base64url');
    if (raw.length < 28) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    return null;
  }
}

function appendCookie(res, serializedCookie) {
  const current = res.getHeader('Set-Cookie');
  const next = Array.isArray(current) ? current : current ? [String(current)] : [];
  res.setHeader('Set-Cookie', [...next, serializedCookie]);
}

function setCookie(res, name, value, maxAge) {
  appendCookie(res, cookie.serialize(name, value, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: name === OAUTH_COOKIE ? 'none' : 'lax',
    path: '/',
    maxAge,
  }));
}

function clearCookie(res, name) {
  appendCookie(res, cookie.serialize(name, '', {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: name === OAUTH_COOKIE ? 'none' : 'lax',
    path: '/',
    maxAge: 0,
  }));
}

function readCookies(request) {
  return cookie.parse(request.headers.cookie || '');
}

function readAuth(request) {
  const c = readCookies(request);
  const session = c[COOKIE_NAME] ? unseal(c[COOKIE_NAME]) : null;
  if (!session?.accessToken) return null;
  return session;
}

async function refreshAccessToken(session) {
  if (!session?.refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: OAUTH_CLIENT_ID,
    refresh_token: String(session.refreshToken),
  });

  const tokenResponse = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  const tokenData = await tokenResponse.json().catch(() => ({}));

  if (!tokenResponse.ok || !tokenData.access_token) {
    return null;
  }

  const expiresIn = Number(tokenData.expires_in || 3600);
  return {
    ...session,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || session.refreshToken || null,
    expiresAt: Date.now() + Math.max(60, expiresIn - 30) * 1000,
  };
}

async function ensureFreshAuth(session) {
  if (!session?.accessToken) return null;
  if (!session.expiresAt || Date.now() < Number(session.expiresAt) - 5000) {
    return session;
  }
  return refreshAccessToken(session);
}

async function requireAuth(req, res, next) {
  const auth = await ensureFreshAuth(readAuth(req));
  if (!auth) {
    res.status(401).json({ error: 'Deriv authentication required or expired.' });
    return;
  }
  req.derivAuth = auth;
  setCookie(res, COOKIE_NAME, seal(auth), Math.max(60, Math.floor((auth.expiresAt - Date.now()) / 1000)));
  next();
}

async function derivFetch(pathname, options = {}, auth) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  headers.set('Deriv-App-ID', APP_ID);
  if (auth?.accessToken) headers.set('Authorization', `Bearer ${auth.accessToken}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${REST_BASE}${pathname}`, {
    ...options,
    headers,
  });

  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }

  if (!response.ok) {
    const detail =
      body?.errors?.[0]?.message ||
      body?.error_description ||
      body?.message ||
      `Deriv REST request failed (${response.status})`;
    const error = new Error(detail);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function normaliseAccounts(body) {
  const raw = Array.isArray(body?.data) ? body.data : [];
  return raw
    .map((a) => ({
      loginid: String(a?.account_id || a?.loginid || ''),
      currency: a?.currency || 'USD',
      balance: Number(a?.balance ?? 0),
      account_type: a?.account_type || null,
      status: a?.status || null,
      group: a?.group || null,
    }))
    .filter((a) => a.loginid);
}

async function getAccounts(auth) {
  const body = await derivFetch('/trading/v1/options/accounts', { method: 'GET' }, auth);
  return normaliseAccounts(body);
}

function chooseAccount(accounts, requested) {
  if (requested && accounts.some((a) => a.loginid === requested)) {
    return requested;
  }
  const demo = accounts.find((a) => a.account_type === 'demo' && a.status !== 'disabled');
  return demo?.loginid || accounts[0]?.loginid || null;
}

async function getOtpUrl(auth, accountId) {
  if (!accountId) throw new Error('No Options account is available for this Deriv login.');
  const body = await derivFetch(
    `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    { method: 'POST' },
    auth
  );
  const url = body?.data?.url;
  if (typeof url !== 'string' || !url.startsWith('wss://api.derivws.com/trading/v1/options/ws/')) {
    throw new Error('Deriv OTP response did not contain an allowed Options WebSocket URL.');
  }
  return url;
}

/* ----------------------------- Risk gate ----------------------------- */
// State lives in ./risk-store.js (shared Redis when configured, otherwise a
// JSON file) so counters survive restarts and multiple Function instances.

const REQUIRE_SHARED_RISK_STORE = process.env.REQUIRE_SHARED_RISK_STORE === 'true';

if (REQUIRE_SHARED_RISK_STORE && !riskStoreIsShared) {
  throw new Error(
    'REQUIRE_SHARED_RISK_STORE=true but no shared risk store is configured. ' +
      'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN before enabling real-money trading.'
  );
}

if (process.env.NODE_ENV === 'production' && !riskStoreIsShared) {
  console.warn(
    `[risk] Using "${riskStoreName}" risk store. Trading risk counters are NOT shared ` +
      'across instances. Configure UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN before real-money trading.'
  );
}

async function riskGate(key, { symbol, amount }) {
  if (symbol && !ALLOWED_SYMBOLS.includes(symbol)) {
    return { ok: false, reason: `Symbol ${symbol} is not allowed.` };
  }
  if (Number(amount) > MAX_STAKE) {
    return { ok: false, reason: `Stake exceeds max stake ${MAX_STAKE}.` };
  }
  let risk;
  try {
    risk = await readRiskState(key);
  } catch (err) {
    // Fail closed: an unreachable risk store must never allow unbounded trading.
    return { ok: false, reason: `Risk store unavailable: ${err?.message || 'unknown error'}.` };
  }
  if (risk.openContracts >= MAX_OPEN_CONTRACTS) {
    return { ok: false, reason: `Too many open contracts. Max ${MAX_OPEN_CONTRACTS}.` };
  }
  if (risk.lossToday >= MAX_DAILY_LOSS) {
    return { ok: false, reason: `Daily loss limit reached: ${MAX_DAILY_LOSS}.` };
  }
  return { ok: true };
}


async function reserveTradeRisk(key, { symbol, amount }) {
  if (symbol && !ALLOWED_SYMBOLS.includes(symbol)) {
    return { ok: false, reason: `Symbol ${symbol} is not allowed.` };
  }
  const stake = Number(amount);
  if (!Number.isFinite(stake) || stake <= 0) {
    return { ok: false, reason: 'Invalid trade stake.' };
  }
  if (stake > MAX_STAKE) {
    return { ok: false, reason: `Stake exceeds max stake ${MAX_STAKE}.` };
  }
  try {
    return await reserveRiskState(key, {
      amount: stake,
      maxOpenContracts: MAX_OPEN_CONTRACTS,
      maxDailyLoss: MAX_DAILY_LOSS,
      maxStake: MAX_STAKE,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `Risk store unavailable: ${err?.message || 'unknown error'}.`,
    };
  }
}

/* ----------------------------- OAuth ----------------------------- */

function makePkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

app.get('/auth/deriv/login', (req, res) => {
  const pkce = makePkce();
  const state = crypto.randomUUID();

  setCookie(res, OAUTH_COOKIE, seal({
    verifier: pkce.verifier,
    state,
    createdAt: Date.now(),
  }), 600);

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', process.env.DERIV_OAUTH_SCOPE || 'trade');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  res.redirect(url.toString());
});

app.get('/auth/deriv/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    const oauth = readCookies(req).twk_oauth ? unseal(readCookies(req).twk_oauth) : null;

    if (error) {
      clearCookie(res, OAUTH_COOKIE);
      res.status(400).send(`Deriv OAuth error: ${error} ${error_description || ''}`);
      return;
    }
    if (!code || !state || !oauth || oauth.state !== state) {
      clearCookie(res, OAUTH_COOKIE);
      res.status(400).send('Invalid or expired OAuth state.');
      return;
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OAUTH_CLIENT_ID,
      code: String(code),
      redirect_uri: REDIRECT_URI,
      code_verifier: oauth.verifier,
    });

    const tokenResponse = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));

    if (!tokenResponse.ok || !tokenData.access_token) {
      clearCookie(res, OAUTH_COOKIE);
      res.status(400).send(
        tokenData.error_description || tokenData.error || 'Deriv token exchange failed.'
      );
      return;
    }

    const expiresIn = Number(tokenData.expires_in || 3600);
    const accounts = await getAccounts({ accessToken: tokenData.access_token });
    const selectedAccount = chooseAccount(
      accounts,
      String(process.env.DERIV_ACCOUNT_ID || '').trim() || null
    );

    if (!selectedAccount) {
      clearCookie(res, OAUTH_COOKIE);
      res.status(400).send('OAuth succeeded, but no Deriv Options trading account was returned.');
      return;
    }

    const session = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresAt: Date.now() + Math.max(60, expiresIn - 30) * 1000,
      accounts,
      selectedAccount,
      createdAt: Date.now(),
    };

    setCookie(res, COOKIE_NAME, seal(session), Math.max(60, expiresIn - 30));
    clearCookie(res, OAUTH_COOKIE);
    res.redirect(new URL('/', FRONTEND_ORIGIN.split(',')[0].trim()).toString());
  } catch (err) {
    console.error('Deriv callback error:', err);
    clearCookie(res, OAUTH_COOKIE);
    res.status(Number(err?.status) || 500).send(err?.message || 'Deriv authentication failed.');
  }
});

app.get('/auth/deriv/logout', (req, res) => {
  clearCookie(res, COOKIE_NAME);
  clearCookie(res, OAUTH_COOKIE);
  res.redirect(FRONTEND_ORIGIN.split(',')[0].trim());
});

/* ----------------------------- Account API ----------------------------- */

app.get('/api/deriv/me', requireAuth, async (req, res) => {
  try {
    const accounts = await getAccounts(req.derivAuth);
    const active = chooseAccount(accounts, req.derivAuth.selectedAccount);
    req.derivAuth.accounts = accounts;
    req.derivAuth.selectedAccount = active;

    const refreshed = seal(req.derivAuth);
    setCookie(res, COOKIE_NAME, refreshed, Math.max(60, Math.floor((req.derivAuth.expiresAt - Date.now()) / 1000)));

    const loginInfo = accounts.map((a) => ({
      loginid: a.loginid,
      token: req.derivAuth.accessToken,
      currency: a.currency || 'USD',
      balance: a.balance,
      account_type: a.account_type,
      status: a.status,
    }));

    res.json({
      loginInfo,
      active_loginid: active,
      currency: accounts.find((a) => a.loginid === active)?.currency || 'USD',
      account_list: accounts,
    });
  } catch (err) {
    res.status(Number(err?.status) || 502).json({
      error: err?.message || 'Unable to load Deriv Options accounts.',
    });
  }
});

app.post('/api/deriv/account/select', requireAuth, async (req, res) => {
  const requested = String(req.body?.accountId || '').trim();
  if (!requested) {
    res.status(400).json({ error: 'accountId is required.' });
    return;
  }
  const accounts = await getAccounts(req.derivAuth);
  if (!accounts.some((a) => a.loginid === requested)) {
    res.status(400).json({ error: 'Requested Options account is not available to this session.' });
    return;
  }
  req.derivAuth.accounts = accounts;
  req.derivAuth.selectedAccount = requested;
  setCookie(res, COOKIE_NAME, seal(req.derivAuth), Math.max(60, Math.floor((req.derivAuth.expiresAt - Date.now()) / 1000)));
  res.json({ ok: true, active_loginid: requested });
});

app.post('/api/deriv/otp/request', requireAuth, async (req, res) => {
  try {
    const accounts = await getAccounts(req.derivAuth);
    const accountId = chooseAccount(accounts, String(req.body?.accountId || req.derivAuth.selectedAccount || ''));
    const url = await getOtpUrl(req.derivAuth, accountId);
    res.json({ data: { url }, account_id: accountId });
  } catch (err) {
    res.status(Number(err?.status) || 400).json({ error: err?.message || 'OTP request failed.' });
  }
});

app.post('/api/deriv/otp/verify', requireAuth, (req, res) => {
  res.status(410).json({
    error: 'Manual OTP verification is obsolete in the new Deriv API.',
    note: 'Use POST /api/deriv/otp/request. Deriv returns a one-time WebSocket URL directly.',
  });
});

/* ----------------------------- Health + static ----------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'ddbot-deriv-new-api-proxy',
    oauth: true,
    legacyDerivTransport: false,
    restBase: REST_BASE,
    riskStore: riskStoreName,
    riskStoreShared: riskStoreIsShared,
  });
});

const distDir = path.resolve(__dirname, '..', 'dist');
app.use(express.static(distDir, { index: false }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) next(err);
  });
});

export { app, server };

if (process.env.VERCEL !== '1') {
  server.listen(PORT, () => {
    console.log(`DDBot Deriv OAuth/New-API server running on http://localhost:${PORT}`);
  });
}
