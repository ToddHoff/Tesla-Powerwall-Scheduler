import http from 'node:http';
import { readFile, writeFile, mkdir, copyFile, appendFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';
import { reconcileLaunchd, removeLegacyPlist } from './scripts/launchd-reconcile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, 'config');
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_DIR = path.join(__dirname, 'logs');
const DEFAULT_SCHEDULE_PATH = path.join(CONFIG_DIR, 'default-schedule.json');
const SCHEDULE_PATH = path.join(CONFIG_DIR, 'schedule.json');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'local-settings.json');
const TOKENS_PATH = path.join(CONFIG_DIR, 'tokens.json');
const OAUTH_STATE_PATH = path.join(CONFIG_DIR, 'oauth-state.json');
const RUN_STATE_PATH = path.join(CONFIG_DIR, 'run-state.json');
const LOG_PATH = path.join(LOG_DIR, 'scheduler.log');

const REGION_BASE_URLS = {
  na: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
  eu: 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
  cn: 'https://fleet-api.prd.cn.vn.cloud.tesla.cn'
};
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

await ensureFiles();
const env = await loadEnvFile(path.join(__dirname, '.env'));
const serverSettings = await resolveServerSettings(env);
const port = serverSettings.port;
let lastGoodAuthHeader = null;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${port}`}`);

    // Basic Auth gate. Active whenever a password is configured. Public mode
    // requires one (enforced on save and downgraded at startup if missing).
    if (serverSettings.auth?.hash && !isAuthorized(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Tesla Powerwall Scheduler"',
        'content-type': 'text/plain; charset=utf-8'
      });
      return res.end('Authentication required.');
    }

    if (url.pathname === '/api/server-config' && req.method === 'GET') return await serverConfigGet(res);
    if (url.pathname === '/api/server-config' && req.method === 'POST') return await serverConfigPost(req, res);
    if (url.pathname === '/api/restart' && req.method === 'POST') return await restartServer(res);
    if (url.pathname === '/api/config' && req.method === 'GET') return sendJson(res, await getPublicConfig());
    if (url.pathname === '/api/config' && req.method === 'POST') return await saveConfig(req, res);
    if (url.pathname === '/api/status' && req.method === 'GET') return sendJson(res, await getStatus());
    if (url.pathname === '/api/discover' && req.method === 'POST') return await discoverSites(res);
    if (url.pathname === '/api/live-status' && req.method === 'GET') return await liveStatus(res);
    if (url.pathname === '/api/reports/net-billing' && req.method === 'GET') return await netBillingReport(url, res);
    if (url.pathname === '/api/reports/tou-cost' && req.method === 'GET') return await touCostReport(url, res);
    if (url.pathname === '/api/reports/solar-savings' && req.method === 'GET') return await solarSavingsReport(url, res);
    if (url.pathname === '/api/rates' && req.method === 'GET') return await ratesGet(res);
    if (url.pathname === '/api/rates' && req.method === 'POST') return await ratesPost(req, res);
    if (url.pathname.startsWith('/api/run/') && req.method === 'POST') return await runManual(url, res);
    if (url.pathname === '/auth/login' && req.method === 'GET') return await startTeslaLogin(res);
    if (url.pathname === '/auth/callback' && req.method === 'GET') return await finishTeslaLogin(url, res);
    if (url.pathname === '/auth/logout' && req.method === 'POST') return await clearTeslaAuth(res);

    return await serveStatic(url.pathname, res);
  } catch (error) {
    await logEvent('error', 'request_failed', { message: error.message, stack: error.stack });
    return sendJson(res, { error: error.message }, 500);
  }
});

server.listen(serverSettings.port, serverSettings.host, () => {
  console.log(`Tesla scheduler running on ${serverSettings.host}:${serverSettings.port} (access: ${serverSettings.accessMode})`);
});

await migrateAndReconcileOnStartup().catch(error => {
  logEvent('error', 'startup_reconcile_failed', { message: error.message, stack: error.stack });
});

async function ensureFiles() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  if (!existsSync(SCHEDULE_PATH)) await copyFile(DEFAULT_SCHEDULE_PATH, SCHEDULE_PATH);
  if (!existsSync(SETTINGS_PATH)) await writeJson(SETTINGS_PATH, {});
  if (!existsSync(RUN_STATE_PATH)) await writeJson(RUN_STATE_PATH, {});
}

// --- Server access mode + auth ---------------------------------------------

async function resolveServerSettings(envVars) {
  const local = await readJson(SETTINGS_PATH, {});
  const s = local.server || {};
  let accessMode = ['localhost', 'lan', 'public'].includes(s.accessMode) ? s.accessMode : 'localhost';
  const auth = s.auth?.hash && s.auth?.salt ? s.auth : null;
  // Why: a public-bound server with no password is an open Powerwall controller
  // on the internet. Refuse to honor public without auth; fall back to localhost.
  if (accessMode === 'public' && !auth) {
    accessMode = 'localhost';
    await logEvent('warn', 'public_without_password_downgraded_to_localhost', {});
  }
  const host = accessMode === 'localhost' ? '127.0.0.1' : '0.0.0.0';
  const portNum = Number(s.port || envVars.PORT || process.env.PORT || 8787);
  const port = Number.isInteger(portNum) && portNum >= 1024 && portNum <= 65535 ? portNum : 8787;
  return { accessMode, host, port, auth };
}

function isAuthorized(req) {
  const header = req.headers.authorization || '';
  if (!header) return false;
  if (header === lastGoodAuthHeader) return true;
  const m = header.match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const password = decoded.slice(decoded.indexOf(':') + 1);
  if (verifyPassword(password, serverSettings.auth)) {
    lastGoodAuthHeader = header;
    return true;
  }
  return false;
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(plain, auth) {
  if (!auth?.salt || !auth?.hash) return false;
  const candidate = crypto.scryptSync(plain, auth.salt, 64);
  const stored = Buffer.from(auth.hash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

async function serverConfigGet(res) {
  const local = await readJson(SETTINGS_PATH, {});
  const s = local.server || {};
  const config = await readConfig();
  return sendJson(res, {
    accessMode: ['localhost', 'lan', 'public'].includes(s.accessMode) ? s.accessMode : 'localhost',
    port: Number(s.port || env.PORT || 8787),
    hasPassword: Boolean(s.auth?.hash),
    timezone: config.timezone || 'America/Los_Angeles',
    lanIp: getLanIp(),
    // The mode actually in effect right now (may differ from saved if a public
    // config was downgraded at startup for missing password).
    activeAccessMode: serverSettings.accessMode,
    activePort: serverSettings.port
  });
}

async function serverConfigPost(req, res) {
  const body = await readRequestJson(req);
  const accessMode = ['localhost', 'lan', 'public'].includes(body.accessMode) ? body.accessMode : 'localhost';
  const portNum = Number(body.port);
  const port = Number.isInteger(portNum) && portNum >= 1024 && portNum <= 65535 ? portNum : serverSettings.port;

  const local = await readJson(SETTINGS_PATH, {});
  const existing = local.server || {};
  let auth = existing.auth || null;
  if (body.clearPassword) auth = null;
  else if (body.password) auth = hashPassword(String(body.password));

  if (accessMode === 'public' && !auth?.hash) {
    return sendJson(res, { ok: false, error: 'Public access requires a password. Set one before selecting Public.' }, 400);
  }

  local.server = { accessMode, port, auth };
  await writeJson(SETTINGS_PATH, local);

  if (body.timezone && typeof body.timezone === 'string') {
    const sched = await readJson(SCHEDULE_PATH, {});
    sched.timezone = body.timezone;
    await writeJson(SCHEDULE_PATH, sched);
  }

  const newHost = accessMode === 'localhost' ? '127.0.0.1' : '0.0.0.0';
  const restartNeeded =
    newHost !== serverSettings.host ||
    port !== serverSettings.port ||
    (auth?.hash || null) !== (serverSettings.auth?.hash || null);

  await logEvent('info', 'server_config_saved', { accessMode, port, hasPassword: Boolean(auth?.hash), restartNeeded });
  return sendJson(res, { ok: true, restartNeeded, accessMode, port, lanIp: getLanIp() });
}

async function restartServer(res) {
  sendJson(res, { ok: true, restarting: true });
  await logEvent('info', 'server_restart_requested', {});
  // Exit cleanly; the LaunchAgent (KeepAlive) respawns us with the new config.
  setTimeout(() => process.exit(0), 150);
}

async function loadEnvFile(filePath) {
  const values = {};
  if (!existsSync(filePath)) return values;
  const body = await readFile(filePath, 'utf8');
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    values[key] = value;
  }
  return values;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readConfig() {
  const scheduleConfig = await readJson(SCHEDULE_PATH, {});
  const localSettings = await readJson(SETTINGS_PATH, {});
  const normalized = normalizeConfig(scheduleConfig);
  const tesla = {
    ...(normalized.tesla || {}),
    ...(localSettings.tesla || {})
  };

  tesla.clientId ||= env.TESLA_CLIENT_ID || process.env.TESLA_CLIENT_ID || '';
  tesla.clientSecret ||= env.TESLA_CLIENT_SECRET || process.env.TESLA_CLIENT_SECRET || '';
  tesla.redirectUri ||= env.TESLA_REDIRECT_URI || process.env.TESLA_REDIRECT_URI || `http://localhost:${port}/auth/callback`;
  tesla.region ||= env.TESLA_REGION || process.env.TESLA_REGION || 'na';

  return {
    ...normalized,
    tesla,
    schedule: activeSchedule(normalized).schedule
  };
}

async function getPublicConfig() {
  const config = await readConfig();
  return {
    ...config,
    tesla: {
      ...config.tesla,
      clientSecret: config.tesla.clientSecret ? '••••••••' : ''
    },
    auth: await getAuthSummary()
  };
}

async function saveConfig(req, res) {
  const incoming = await readRequestJson(req);
  const current = await readConfig();
  const normalizedIncoming = normalizeConfig({
    ...current,
    ...incoming,
    schedules: incoming.schedules || current.schedules,
    activeScheduleId: incoming.activeScheduleId || current.activeScheduleId
  });
  const active = activeSchedule(normalizedIncoming);
  const next = {
    timezone: incoming.timezone || current.timezone || 'America/Los_Angeles',
    activeScheduleId: normalizedIncoming.activeScheduleId,
    tesla: {
      region: incoming.tesla?.region || current.tesla?.region || 'na',
      energySiteId: incoming.tesla?.energySiteId || current.tesla?.energySiteId || '',
      redirectUri: incoming.tesla?.redirectUri || current.tesla?.redirectUri || `http://localhost:${port}/auth/callback`
    },
    schedules: normalizedIncoming.schedules,
    schedule: active.schedule
  };

  const localSettings = await readJson(SETTINGS_PATH, {});
  localSettings.tesla = {
    ...(localSettings.tesla || {}),
    region: next.tesla.region,
    energySiteId: next.tesla.energySiteId,
    redirectUri: next.tesla.redirectUri,
    clientId: incoming.tesla?.clientId || current.tesla?.clientId || '',
    clientSecret: incoming.tesla?.clientSecret && incoming.tesla.clientSecret !== '••••••••'
      ? incoming.tesla.clientSecret
      : current.tesla?.clientSecret || ''
  };

  await writeJson(SCHEDULE_PATH, next);
  await writeJson(SETTINGS_PATH, localSettings);
  await logEvent('info', 'config_saved', { rows: next.schedule.length });

  const launchd = await reconcileSafe(activeSchedule(normalizedIncoming));
  return sendJson(res, { ...(await getPublicConfig()), launchd });
}

async function reconcileSafe(schedule) {
  try {
    const result = await reconcileLaunchd({
      schedule,
      appDir: __dirname,
      nodeBin: process.execPath,
      logDir: LOG_DIR
    });
    await logEvent('info', 'launchd_reconciled', result);
    return { ok: true, ...result };
  } catch (error) {
    await logEvent('error', 'launchd_reconcile_failed', { message: error.message });
    return { ok: false, error: error.message };
  }
}

async function migrateAndReconcileOnStartup() {
  const removed = await removeLegacyPlist();
  if (removed) await logEvent('info', 'legacy_plist_removed', {});
  const config = await readConfig();
  await reconcileSafe(activeSchedule(config));
}

function normalizeSchedule(rows) {
  return rows.map(row => ({
    id: row.id || crypto.randomUUID(),
    enabled: row.enabled !== false,
    time: row.time || '00:00',
    backupReservePercent: clamp(Number(row.backupReservePercent ?? 30), 0, 100),
    operationMode: row.operationMode || modeLabel(row.operationModeApi || 'autonomous'),
    operationModeApi: row.operationModeApi || modeApi(row.operationMode || 'Time-Based Control'),
    energyExports: row.energyExports || exportLabel(row.energyExportsApi || 'pv_only'),
    energyExportsApi: row.energyExportsApi || exportApi(row.energyExports || 'Solar Only'),
    gridCharging: Boolean(row.gridCharging),
    purpose: row.purpose || ''
  }));
}

function normalizeConfig(raw) {
  const legacyRows = normalizeSchedule(raw.schedule || []);
  let schedules = Array.isArray(raw.schedules) && raw.schedules.length
    ? raw.schedules
    : defaultSchedules(legacyRows);

  schedules = schedules.map((schedule, index) => ({
    id: schedule.id || (index === 0 ? 'summer' : `schedule-${index + 1}`),
    name: schedule.name || (index === 0 ? 'Summer' : `Schedule ${index + 1}`),
    schedule: normalizeSchedule(schedule.schedule || [])
  }));

  if (!schedules.some(schedule => schedule.id === 'winter')) {
    schedules.push(defaultWinterSchedule());
  }

  const activeScheduleId = schedules.some(schedule => schedule.id === raw.activeScheduleId)
    ? raw.activeScheduleId
    : schedules[0].id;

  return {
    ...raw,
    activeScheduleId,
    schedules
  };
}

function defaultSchedules(legacyRows) {
  return [
    {
      id: 'summer',
      name: 'Summer',
      schedule: legacyRows
    },
    defaultWinterSchedule()
  ];
}

function defaultWinterSchedule() {
  return {
    id: 'winter',
    name: 'Winter',
    schedule: normalizeSchedule([
      {
        id: 'winter-morning',
        enabled: true,
        time: '07:00',
        backupReservePercent: 50,
        operationMode: 'Self-Powered',
        operationModeApi: 'self_consumption',
        energyExports: 'Solar Only',
        energyExportsApi: 'pv_only',
        gridCharging: false,
        purpose: 'Winter morning: keep a higher outage reserve while using available solar.'
      },
      {
        id: 'winter-midnight',
        enabled: true,
        time: '00:00',
        backupReservePercent: 50,
        operationMode: 'Time-Based Control',
        operationModeApi: 'autonomous',
        energyExports: 'Solar Only',
        energyExportsApi: 'pv_only',
        gridCharging: true,
        purpose: 'Winter off-peak: allow low-cost grid charging back to the outage reserve level.'
      }
    ])
  };
}

function activeSchedule(config) {
  return config.schedules.find(schedule => schedule.id === config.activeScheduleId) || config.schedules[0];
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function modeApi(label) {
  return label === 'Self-Powered' ? 'self_consumption' : 'autonomous';
}

function modeLabel(api) {
  return api === 'self_consumption' ? 'Self-Powered' : 'Time-Based Control';
}

function exportApi(label) {
  if (label === 'Everything') return 'battery_ok';
  if (label === 'None') return 'never';
  return 'pv_only';
}

function exportLabel(api) {
  if (api === 'battery_ok') return 'Everything';
  if (api === 'never') return 'None';
  return 'Solar Only';
}

async function readRequestJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function startTeslaLogin(res) {
  const config = await readConfig();
  requireTeslaSetting(config.tesla.clientId, 'Tesla client ID');
  requireTeslaSetting(config.tesla.redirectUri, 'Tesla redirect URI');

  const codeVerifier = base64Url(crypto.randomBytes(48));
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64Url(crypto.randomBytes(24));
  await writeJson(OAUTH_STATE_PATH, { state, codeVerifier, createdAt: new Date().toISOString() });

  const authUrl = new URL('https://auth.tesla.com/oauth2/v3/authorize');
  authUrl.searchParams.set('client_id', config.tesla.clientId);
  authUrl.searchParams.set('redirect_uri', config.tesla.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid offline_access energy_device_data energy_cmds');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}

async function finishTeslaLogin(url, res) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthState = await readJson(OAUTH_STATE_PATH, {});
  if (!code) throw new Error('Tesla callback did not include an authorization code.');
  if (!state || state !== oauthState.state) throw new Error('OAuth state mismatch.');

  const config = await readConfig();
  const token = await tokenRequest(config, {
    grant_type: 'authorization_code',
    client_id: config.tesla.clientId,
    client_secret: config.tesla.clientSecret,
    audience: fleetBaseUrl(config),
    code,
    redirect_uri: config.tesla.redirectUri,
    code_verifier: oauthState.codeVerifier,
    scope: 'openid offline_access energy_device_data energy_cmds'
  });
  await saveTokens(token);
  await logEvent('info', 'tesla_connected', { expiresIn: token.expires_in });
  res.writeHead(302, { Location: '/?connected=1' });
  res.end();
}

async function clearTeslaAuth(res) {
  await writeJson(TOKENS_PATH, {});
  await logEvent('info', 'tesla_disconnected', {});
  return sendJson(res, { ok: true });
}

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function tokenRequest(config, body) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.entries(body).filter(([, value]) => value))
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Tesla token request failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function saveTokens(token) {
  await writeJson(TOKENS_PATH, {
    ...token,
    expires_at: Date.now() + Math.max(0, Number(token.expires_in || 0) - 90) * 1000,
    updated_at: new Date().toISOString()
  });
}

async function getAccessToken() {
  const config = await readConfig();
  const tokens = await readJson(TOKENS_PATH, {});
  if (!tokens.access_token) throw new Error('Tesla is not connected. Use Connect Tesla first.');
  if (tokens.expires_at && Date.now() < tokens.expires_at) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error('Tesla token expired and no refresh token is available.');

  const refreshed = await tokenRequest(config, {
    grant_type: 'refresh_token',
    client_id: config.tesla.clientId,
    refresh_token: tokens.refresh_token
  });
  await saveTokens(refreshed);
  return refreshed.access_token;
}

async function teslaFetch(pathname, options = {}) {
  const config = await readConfig();
  const baseUrl = fleetBaseUrl(config);
  const accessToken = await getAccessToken();
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? safeJson(text) : {};
  if (!response.ok) throw new Error(`Tesla API ${pathname} failed: ${response.status} ${text}`);
  return data;
}

function fleetBaseUrl(config) {
  return REGION_BASE_URLS[config.tesla?.region] || REGION_BASE_URLS.na;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function discoverSites(res) {
  const data = await teslaFetch('/api/1/products');
  const products = Array.isArray(data.response) ? data.response : [];
  const sites = products
    .filter(product => product.energy_site_id || product.resource_type === 'battery')
    .map(product => ({
      energySiteId: String(product.energy_site_id || ''),
      siteName: product.site_name || product.asset_site_id || product.id || 'Energy Site',
      resourceType: product.resource_type || 'energy'
    }));

  if (sites.length === 1) {
    const config = await readConfig();
    const localSettings = await readJson(SETTINGS_PATH, {});
    localSettings.tesla = {
      ...(localSettings.tesla || {}),
      energySiteId: sites[0].energySiteId,
      region: config.tesla.region,
      redirectUri: config.tesla.redirectUri
    };
    await writeJson(SETTINGS_PATH, localSettings);
  }

  await logEvent('info', 'sites_discovered', { count: sites.length });
  return sendJson(res, { sites, raw: data });
}

async function liveStatus(res) {
  const config = await readConfig();
  requireTeslaSetting(config.tesla.energySiteId, 'Energy site ID');
  const [siteInfo, live] = await Promise.all([
    teslaFetch(`/api/1/energy_sites/${config.tesla.energySiteId}/site_info`),
    teslaFetch(`/api/1/energy_sites/${config.tesla.energySiteId}/live_status`)
  ]);
  return sendJson(res, { siteInfo, live });
}

async function netBillingReport(url, res) {
  const config = await readConfig();
  requireTeslaSetting(config.tesla.energySiteId, 'Energy site ID');
  const timeZone = url.searchParams.get('timeZone') || config.timezone || 'America/Los_Angeles';
  const startDate = url.searchParams.get('startDate');
  const endDate = url.searchParams.get('endDate');
  if (!isDateOnly(startDate) || !isDateOnly(endDate)) {
    return sendJson(res, { error: 'startDate and endDate must be YYYY-MM-DD.' }, 400);
  }
  if (startDate > endDate) {
    return sendJson(res, { error: 'startDate must be on or before endDate.' }, 400);
  }

  const dates = dateRange(startDate, endDate);
  if (dates.length > 31) {
    return sendJson(res, { error: 'Report range is limited to 31 days to control Tesla API usage.' }, 400);
  }

  const responses = [];
  const days = [];
  const hourlyMap = new Map();
  for (const date of dates) {
    const params = new URLSearchParams({
      kind: 'energy',
      period: 'day',
      start_date: zonedDateTimeParam(date, '00:00:00', timeZone),
      end_date: zonedDateTimeParam(date, '23:59:59', timeZone),
      time_zone: timeZone
    });
    const raw = await teslaFetch(`/api/1/energy_sites/${config.tesla.energySiteId}/calendar_history?${params}`);
    const timeSeries = Array.isArray(raw.response?.time_series) ? raw.response.time_series : [];
    days.push(aggregateEnergyIntervals(date, timeSeries));
    addHourlyIntervals(hourlyMap, timeSeries);
    responses.push({
      date,
      intervalCount: timeSeries.length,
      period: raw.response?.period,
      firstTimestamp: timeSeries[0]?.timestamp || null,
      lastTimestamp: timeSeries.at(-1)?.timestamp || null
    });
  }
  const totals = days.reduce((acc, day) => ({
    importedKwh: acc.importedKwh + day.importedKwh,
    exportedKwh: acc.exportedKwh + day.exportedKwh,
    netKwh: acc.netKwh + day.netKwh,
    batteryExportedKwh: acc.batteryExportedKwh + day.batteryExportedKwh,
    solarExportedKwh: acc.solarExportedKwh + day.solarExportedKwh,
    batteryImportedFromGridKwh: acc.batteryImportedFromGridKwh + day.batteryImportedFromGridKwh,
    consumerImportedFromGridKwh: acc.consumerImportedFromGridKwh + day.consumerImportedFromGridKwh
  }), {
    importedKwh: 0,
    exportedKwh: 0,
    netKwh: 0,
    batteryExportedKwh: 0,
    solarExportedKwh: 0,
    batteryImportedFromGridKwh: 0,
    consumerImportedFromGridKwh: 0
  });
  const hourly = [...hourlyMap.values()].sort((a, b) => a.hour.localeCompare(b.hour)).map(roundEnergyRow);
  const buckets = summarizeBuckets(hourly);

  await logEvent('info', 'net_billing_report', {
    startDate,
    endDate,
    timeZone,
    days: days.length,
    totals: roundReport(totals)
  });

  return sendJson(res, {
    startDate,
    endDate,
    timeZone,
    siteId: config.tesla.energySiteId,
    days,
    buckets,
    hourly,
    totals: roundReport(totals),
    responses
  });
}

async function touCostReport(url, res) {
  const config = await readConfig();
  requireTeslaSetting(config.tesla.energySiteId, 'Energy site ID');
  const timeZone = url.searchParams.get('timeZone') || config.timezone || 'America/Los_Angeles';
  const startDate = url.searchParams.get('startDate');
  const endDate = url.searchParams.get('endDate');
  if (!isDateOnly(startDate) || !isDateOnly(endDate)) {
    return sendJson(res, { error: 'startDate and endDate must be YYYY-MM-DD.' }, 400);
  }
  if (startDate > endDate) {
    return sendJson(res, { error: 'startDate must be on or before endDate.' }, 400);
  }
  const dates = dateRange(startDate, endDate);
  if (dates.length > 31) {
    return sendJson(res, { error: 'Report range is limited to 31 days to control Tesla API usage.' }, 400);
  }

  const siteInfo = await teslaFetch(`/api/1/energy_sites/${config.tesla.energySiteId}/site_info`);
  const localSettings = await readJson(SETTINGS_PATH, {});
  const tariff = buildRatePlan(localSettings, siteInfo);
  if (!tariff) {
    return sendJson(res, { error: 'No rate plan available (Tesla tariff_content empty and no custom override set).' }, 502);
  }

  const days = [];
  for (const date of dates) {
    const energyParams = new URLSearchParams({
      kind: 'energy', period: 'day',
      start_date: zonedDateTimeParam(date, '00:00:00', timeZone),
      end_date:   zonedDateTimeParam(date, '23:59:59', timeZone),
      time_zone:  timeZone
    });
    const soeParams = new URLSearchParams({
      kind: 'soe', period: 'day',
      start_date: zonedDateTimeParam(date, '00:00:00', timeZone),
      end_date:   zonedDateTimeParam(date, '23:59:59', timeZone),
      time_zone:  timeZone
    });
    const [energyRaw, soeRaw] = await Promise.all([
      teslaFetch(`/api/1/energy_sites/${config.tesla.energySiteId}/calendar_history?${energyParams}`),
      teslaFetch(`/api/1/energy_sites/${config.tesla.energySiteId}/calendar_history?${soeParams}`)
    ]);
    const intervals = Array.isArray(energyRaw.response?.time_series) ? energyRaw.response.time_series : [];
    const soeSeries = Array.isArray(soeRaw.response?.time_series) ? soeRaw.response.time_series : [];
    days.push(buildTouDay({ date, intervals, soeSeries, tariff }));
  }

  const totals = sumTouDays(days);
  await logEvent('info', 'tou_cost_report', {
    startDate, endDate, timeZone,
    daysCount: days.length,
    netCost: totals.netCost,
    peakImportKwh: totals.peakImportKwh
  });

  return sendJson(res, {
    startDate, endDate, timeZone,
    siteId: config.tesla.energySiteId,
    tariff,
    days,
    totals
  });
}

async function solarSavingsReport(url, res) {
  const config = await readConfig();
  requireTeslaSetting(config.tesla.energySiteId, 'Energy site ID');
  const timeZone = url.searchParams.get('timeZone') || config.timezone || 'America/Los_Angeles';
  const startDate = url.searchParams.get('startDate');
  const endDate = url.searchParams.get('endDate');
  if (!isDateOnly(startDate) || !isDateOnly(endDate)) {
    return sendJson(res, { error: 'startDate and endDate must be YYYY-MM-DD.' }, 400);
  }
  if (startDate > endDate) {
    return sendJson(res, { error: 'startDate must be on or before endDate.' }, 400);
  }
  const dates = dateRange(startDate, endDate);
  if (dates.length > 45) {
    return sendJson(res, { error: 'Report range is limited to 45 days to control Tesla API usage.' }, 400);
  }

  const siteInfo = await teslaFetch(`/api/1/energy_sites/${config.tesla.energySiteId}/site_info`);
  const localSettings = await readJson(SETTINGS_PATH, {});
  const tariff = buildRatePlan(localSettings, siteInfo);
  if (!tariff) {
    return sendJson(res, { error: 'No rate plan available (Tesla tariff_content empty and no custom override set).' }, 502);
  }

  const hours = [];
  for (const date of dates) {
    const params = new URLSearchParams({
      kind: 'energy', period: 'day',
      start_date: zonedDateTimeParam(date, '00:00:00', timeZone),
      end_date:   zonedDateTimeParam(date, '23:59:59', timeZone),
      time_zone:  timeZone
    });
    const raw = await teslaFetch(`/api/1/energy_sites/${config.tesla.energySiteId}/calendar_history?${params}`);
    const intervals = Array.isArray(raw.response?.time_series) ? raw.response.time_series : [];
    hours.push(...hourlyHomeUsage({ date, intervals, tariff }));
  }

  // Per-rate-type summary (Off-Peak / Part-Peak / Peak) + grand total.
  const byType = {
    'Off-Peak': { kwh: 0, cost: 0 },
    'Part-Peak': { kwh: 0, cost: 0 },
    'Peak': { kwh: 0, cost: 0 }
  };
  let totalKwh = 0;
  let totalCost = 0;
  for (const h of hours) {
    const key = byType[h.rateType] ? h.rateType : 'Off-Peak';
    byType[key].kwh += h.kwh;
    byType[key].cost += h.cost;
    totalKwh += h.kwh;
    totalCost += h.cost;
  }
  const summary = Object.entries(byType).map(([rateType, v]) => ({
    rateType,
    kwh: round(v.kwh),
    cost: roundCurrency(v.cost)
  }));

  await logEvent('info', 'solar_savings_report', {
    startDate, endDate, timeZone,
    daysCount: dates.length,
    totalKwh: round(totalKwh),
    noSolarCost: roundCurrency(totalCost)
  });

  return sendJson(res, {
    startDate, endDate, timeZone,
    siteId: config.tesla.energySiteId,
    tariff,
    hours: hours.map(h => ({ ...h, kwh: round(h.kwh), cost: roundCurrency(h.cost) })),
    summary,
    totals: { kwh: round(totalKwh), noSolarCost: roundCurrency(totalCost) }
  });
}

function hourlyHomeUsage({ date, intervals, tariff }) {
  const season = seasonForDate(date, tariff);
  const seasonName = seasonDisplayName(season, tariff.source);
  const rateByName = {};
  for (const period of season.periods || []) {
    rateByName[period.name] = period.buyRate;
  }

  // Roll the 5-minute intervals up into clock-hours.
  const hourMap = new Map();
  for (const interval of intervals) {
    const ts = String(interval.timestamp || '');
    if (ts.length < 13) continue;
    const hourKey = ts.slice(0, 13); // e.g. "2026-06-01T16"
    const prev = hourMap.get(hourKey) || { homeWh: 0, weekday: localWeekday(ts) };
    prev.homeWh += Number(interval.total_home_usage || 0);
    hourMap.set(hourKey, prev);
  }

  const out = [];
  for (const [hourKey, agg] of [...hourMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const hourNum = Number(hourKey.slice(11, 13));
    const periodName = periodForLocalTime(hourNum, 0, agg.weekday, season);
    const rate = Number(rateByName[periodName] || 0);
    const kwh = whToKwh(agg.homeWh);
    out.push({
      date,
      season: seasonName,
      startTime: formatHour12(hourNum),
      endTime: formatHour12(hourNum + 1),
      kwh,
      rateType: displayRateType(periodName),
      rate,
      cost: kwh * rate
    });
  }
  return out;
}

function seasonDisplayName(season, source) {
  // Custom plans use the user's own season names. Tesla's labels are inverted
  // from PG&E convention (it files Jun–Sep under "Winter"), so derive the label
  // from the months: a season covering July is Summer, otherwise Winter.
  if (source === 'custom') return season.label;
  const months = monthsInSeason(season);
  return months.includes(7) ? 'Summer' : 'Winter';
}

function monthsInSeason(season) {
  const from = Number(season.fromMonth ?? season.startMonth ?? 1);
  const to = Number(season.toMonth ?? from);
  const out = [];
  let m = from;
  for (let i = 0; i < 12; i++) {
    out.push(m);
    if (m === to) break;
    m = m === 12 ? 1 : m + 1;
  }
  return out;
}

function displayRateType(periodName) {
  if (isOffPeakName(periodName)) return 'Off-Peak';
  if (isPartialPeakName(periodName)) return 'Part-Peak';
  if (isPeakName(periodName)) return 'Peak';
  return periodName;
}

function formatHour12(hourNum) {
  const h = ((hourNum % 24) + 24) % 24;
  const ampm = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:00:00 ${ampm}`;
}

// --- Rate plan abstraction -------------------------------------------------
// Custom plans (from local-settings.json rateStructure) and Tesla plans (from
// site_info.tariff_content) both normalize to the same shape:
//   { source, code, name, utility, currency, seasons: [
//     { label, startMonth, startDay,
//       // Tesla only: fromMonth/toMonth from tariff data
//       // Custom only: nextStartMonth/nextStartDay derived from neighbor season
//       periods: [
//         { name, windows: [{startMin, endMin, fromDow, toDow}], buyRate, sellRate }
//       ]
//     }
//   ]}

function buildRatePlan(localSettings, siteInfo) {
  const custom = localSettings?.rateStructure;
  if (custom?.enabled) {
    const plan = normalizeCustomPlan(custom);
    if (plan) return plan;
  }
  return normalizeTeslaPlan(siteInfo?.response?.tariff_content);
}

function normalizeCustomPlan(rateStructure) {
  const seasons = Array.isArray(rateStructure?.seasons) ? rateStructure.seasons : [];
  if (!seasons.length) return null;
  const sorted = [...seasons].sort((a, b) =>
    ((a.startMonth || 1) * 100 + (a.startDay || 1)) -
    ((b.startMonth || 1) * 100 + (b.startDay || 1))
  );
  const normalized = sorted.map((s, i) => {
    const next = sorted[(i + 1) % sorted.length];
    return {
      label: s.name || `Season ${i + 1}`,
      startMonth: Number(s.startMonth) || 1,
      startDay: Number(s.startDay) || 1,
      nextStartMonth: Number(next.startMonth) || 1,
      nextStartDay: Number(next.startDay) || 1,
      periods: (s.periods || []).map(p => ({
        name: p.name || 'Off-Peak',
        windows: [{
          startMin: parseTimeMinutes(p.startTime) ?? 0,
          endMin: parseTimeMinutes(p.endTime) ?? 1440,
          fromDow: 0, toDow: 6
        }],
        buyRate: Number(p.buyRate || 0),
        sellRate: Number(p.sellRate || 0)
      }))
    };
  });
  return {
    source: 'custom',
    code: 'custom',
    name: 'User-defined rate structure',
    utility: '',
    currency: rateStructure.currency || 'USD',
    seasons: normalized
  };
}

function normalizeTeslaPlan(tariffContent) {
  if (!tariffContent || typeof tariffContent !== 'object') return null;
  const seasonsRaw = tariffContent.seasons || {};
  const buy = tariffContent.energy_charges || {};
  const sell = tariffContent.sell_tariff?.energy_charges || {};
  const seasonList = [];
  for (const [label, raw] of Object.entries(seasonsRaw)) {
    if (!raw || typeof raw !== 'object') continue;
    const periods = [];
    for (const [periodName, ranges] of Object.entries(raw.tou_periods || {})) {
      if (!Array.isArray(ranges)) continue;
      const windows = ranges.map(r => ({
        startMin: Number(r.fromHour) * 60 + Number(r.fromMinute || 0),
        endMin: Number(r.toHour) * 60 + Number(r.toMinute || 0),
        fromDow: Number(r.fromDayOfWeek ?? 0),
        toDow: Number(r.toDayOfWeek ?? 6)
      }));
      periods.push({
        name: periodName,
        windows,
        buyRate: Number(buy?.[label]?.[periodName] || 0),
        sellRate: Number(sell?.[label]?.[periodName] || 0)
      });
    }
    seasonList.push({
      label,
      fromMonth: Number(raw.fromMonth),
      toMonth: Number(raw.toMonth),
      startMonth: Number(raw.fromMonth),
      startDay: Number(raw.fromDay) || 1,
      periods
    });
  }
  if (!seasonList.length) return null;
  return {
    source: 'tesla',
    code: tariffContent.code || '',
    name: tariffContent.name || '',
    utility: tariffContent.utility || '',
    currency: 'USD',
    seasons: seasonList
  };
}

function seasonForDate(dateStr, plan) {
  if (!plan?.seasons?.length) return null;
  const month = Number(dateStr.slice(5, 7));
  const day = Number(dateStr.slice(8, 10));
  const cur = month * 100 + day;

  if (plan.source === 'custom') {
    for (const season of plan.seasons) {
      const start = season.startMonth * 100 + season.startDay;
      const end = season.nextStartMonth * 100 + season.nextStartDay;
      if (dateInSeasonRange(cur, start, end)) return season;
    }
    return plan.seasons[0];
  }
  for (const season of plan.seasons) {
    if (monthInRange(month, season.fromMonth, season.toMonth)) return season;
  }
  return plan.seasons[0];
}

function dateInSeasonRange(cur, start, end) {
  if (start === end) return true;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

function monthInRange(month, fromMonth, toMonth) {
  if (fromMonth <= toMonth) return month >= fromMonth && month <= toMonth;
  return month >= fromMonth || month <= toMonth;
}

function periodForLocalTime(hour, minute, weekday, season) {
  const cur = hour * 60 + minute;
  for (const period of season.periods || []) {
    for (const window of period.windows || []) {
      if (!weekdayInRange(weekday, window.fromDow, window.toDow)) continue;
      if (timeInWindow(cur, window.startMin, window.endMin)) return period.name;
    }
  }
  return season.periods?.[0]?.name || 'Off-Peak';
}

function timeInWindow(cur, startMin, endMin) {
  if (startMin === endMin) return true;
  if (startMin < endMin) return cur >= startMin && cur < endMin;
  return cur >= startMin || cur < endMin;
}

function weekdayInRange(weekday, from, to) {
  if (from == null || to == null || Number.isNaN(from) || Number.isNaN(to)) return true;
  if (from <= to) return weekday >= from && weekday <= to;
  return weekday >= from || weekday <= to;
}

function findPeakWindow(season) {
  for (const period of season?.periods || []) {
    if (isPeakName(period.name) && period.windows?.length) {
      const w = period.windows[0];
      return { startMin: w.startMin, endMin: w.endMin };
    }
  }
  // Reasonable default: 16:00–21:00 (PG&E TOU-C peak window).
  return { startMin: 16 * 60, endMin: 21 * 60 };
}

function isPeakName(name) {
  const n = String(name || '').toLowerCase().replace(/[_\s-]/g, '');
  if (n.includes('partial') || n.includes('mid')) return false;
  if (n.includes('off')) return false;
  return n.includes('peak');
}

function isPartialPeakName(name) {
  const n = String(name || '').toLowerCase().replace(/[_\s-]/g, '');
  return n.includes('partial') || n.includes('mid');
}

function isOffPeakName(name) {
  const n = String(name || '').toLowerCase().replace(/[_\s-]/g, '');
  return n.includes('off');
}

function parseTimeMinutes(text) {
  if (text == null) return null;
  const m = String(text).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  if (h === 24 && min !== 0) return null;
  return h * 60 + min;
}

function buildTouDay({ date, intervals, soeSeries, tariff }) {
  const season = seasonForDate(date, tariff);
  const rateByName = {};
  for (const period of season.periods || []) {
    rateByName[period.name] = { buyRate: period.buyRate, sellRate: period.sellRate };
  }
  const { startMin: peakStartMin, endMin: peakEndMin } = findPeakWindow(season);

  const perPeriod = new Map(); // period -> { importedKwh, exportedKwh }
  const ensurePeriod = name => {
    if (!perPeriod.has(name)) perPeriod.set(name, { importedKwh: 0, exportedKwh: 0 });
    return perPeriod.get(name);
  };

  const peak = {
    homeUsageKwh: 0,
    batteryToLoadKwh: 0,
    solarToLoadKwh: 0,
    gridToLoadKwh: 0,
    batteryToGridKwh: 0,
    solarToGridKwh: 0,
    batteryFromGridKwh: 0
  };

  // PG&E billing is local-clock; weekday from interval timestamp's local zone.
  for (const interval of intervals) {
    const ts = String(interval.timestamp || '');
    if (ts.length < 16) continue;
    const hour = Number(ts.slice(11, 13));
    const minute = Number(ts.slice(14, 16));
    const weekday = localWeekday(ts);
    const period = periodForLocalTime(hour, minute, weekday, season);

    const importedKwh = whToKwh(
      Number(interval.battery_energy_imported_from_grid || 0) +
      Number(interval.consumer_energy_imported_from_grid || 0)
    );
    const exportedKwh = whToKwh(
      Number(interval.grid_energy_exported_from_battery || 0) +
      Number(interval.grid_energy_exported_from_solar || 0)
    );
    const bucket = ensurePeriod(period);
    bucket.importedKwh += importedKwh;
    bucket.exportedKwh += exportedKwh;

    const cur = hour * 60 + minute;
    const inPeak = peakStartMin < peakEndMin
      ? (cur >= peakStartMin && cur < peakEndMin)
      : (cur >= peakStartMin || cur < peakEndMin);
    if (inPeak) {
      peak.homeUsageKwh += whToKwh(Number(interval.total_home_usage || 0));
      peak.batteryToLoadKwh += whToKwh(Number(interval.consumer_energy_imported_from_battery || 0));
      peak.solarToLoadKwh += whToKwh(Number(interval.consumer_energy_imported_from_solar || 0));
      peak.gridToLoadKwh += whToKwh(Number(interval.consumer_energy_imported_from_grid || 0));
      peak.batteryToGridKwh += whToKwh(Number(interval.grid_energy_exported_from_battery || 0));
      peak.solarToGridKwh += whToKwh(Number(interval.grid_energy_exported_from_solar || 0));
      peak.batteryFromGridKwh += whToKwh(Number(interval.battery_energy_imported_from_grid || 0));
    }
  }

  const periods = [...perPeriod.entries()].map(([name, totals]) => {
    const rates = rateByName[name] || { buyRate: 0, sellRate: 0 };
    const importCost = totals.importedKwh * rates.buyRate;
    const exportCredit = totals.exportedKwh * rates.sellRate;
    return {
      period: name,
      importedKwh: round(totals.importedKwh),
      exportedKwh: round(totals.exportedKwh),
      buyRate: rates.buyRate,
      sellRate: rates.sellRate,
      importCost: roundCurrency(importCost),
      exportCredit: roundCurrency(exportCredit),
      netCost: roundCurrency(importCost - exportCredit)
    };
  });
  // Stable order: Off-Peak first, then Partial-Peak, then Peak, then any extras.
  periods.sort((a, b) => periodOrder(a.period) - periodOrder(b.period));

  const soe = pickSoeSamples(soeSeries, peakStartMin, peakEndMin);

  const netCost = periods.reduce((sum, p) => sum + p.netCost, 0);
  const importCost = periods.reduce((sum, p) => sum + p.importCost, 0);
  const exportCredit = periods.reduce((sum, p) => sum + p.exportCredit, 0);
  const peakPeriod = periods.find(p => isPeakName(p.period))
    || { importedKwh: 0, importCost: 0, exportedKwh: 0, exportCredit: 0 };

  return {
    date,
    seasonLabel: season.label,
    seasonMonths: season.fromMonth != null
      ? { from: season.fromMonth, to: season.toMonth }
      : { startMonth: season.startMonth, startDay: season.startDay },
    periods,
    importCost: roundCurrency(importCost),
    exportCredit: roundCurrency(exportCredit),
    netCost: roundCurrency(netCost),
    peakImportKwh: peakPeriod.importedKwh,
    peakImportCost: peakPeriod.importCost,
    peakExportKwh: peakPeriod.exportedKwh,
    peakExportCredit: peakPeriod.exportCredit,
    peakAudit: {
      homeUsageKwh: round(peak.homeUsageKwh),
      batteryToLoadKwh: round(peak.batteryToLoadKwh),
      solarToLoadKwh: round(peak.solarToLoadKwh),
      gridToLoadKwh: round(peak.gridToLoadKwh),
      batteryToGridKwh: round(peak.batteryToGridKwh),
      solarToGridKwh: round(peak.solarToGridKwh),
      batteryFromGridKwh: round(peak.batteryFromGridKwh),
      percentLoadFromBattery: peak.homeUsageKwh > 0
        ? Math.round((peak.batteryToLoadKwh / peak.homeUsageKwh) * 1000) / 10
        : null,
      ...soe
    }
  };
}

function periodOrder(name) {
  if (isOffPeakName(name)) return 0;
  if (isPartialPeakName(name)) return 1;
  if (isPeakName(name)) return 2;
  return 3;
}

async function ratesGet(res) {
  const localSettings = await readJson(SETTINGS_PATH, {});
  let siteInfo = null;
  try {
    const config = await readConfig();
    if (config.tesla.energySiteId) {
      siteInfo = await teslaFetch(`/api/1/energy_sites/${config.tesla.energySiteId}/site_info`);
    }
  } catch (error) {
    await logEvent('warn', 'rates_tesla_fetch_failed', { message: error.message });
  }
  const tesla = normalizeTeslaPlan(siteInfo?.response?.tariff_content);
  const effective = buildRatePlan(localSettings, siteInfo);
  return sendJson(res, {
    custom: localSettings?.rateStructure || null,
    tesla,
    effective
  });
}

async function ratesPost(req, res) {
  const body = await readRequestJson(req);
  const errors = validateRateStructure(body);
  if (errors.length) {
    return sendJson(res, { ok: false, errors }, 400);
  }
  const localSettings = await readJson(SETTINGS_PATH, {});
  localSettings.rateStructure = body;
  await writeJson(SETTINGS_PATH, localSettings);
  await logEvent('info', 'rate_structure_saved', {
    enabled: Boolean(body.enabled),
    seasonCount: (body.seasons || []).length
  });
  return sendJson(res, { ok: true, rateStructure: body });
}

function validateRateStructure(rs) {
  const errors = [];
  if (!rs || typeof rs !== 'object') return ['Missing rateStructure body.'];
  if (!Array.isArray(rs.seasons) || rs.seasons.length === 0) {
    errors.push('At least one season is required.');
    return errors;
  }
  for (const [si, season] of rs.seasons.entries()) {
    const where = `season[${si}] (${season?.name || 'unnamed'})`;
    if (!season?.name) errors.push(`${where}: name is required.`);
    if (!Number.isInteger(season?.startMonth) || season.startMonth < 1 || season.startMonth > 12) {
      errors.push(`${where}: startMonth must be 1–12.`);
    }
    if (!Number.isInteger(season?.startDay) || season.startDay < 1 || season.startDay > 31) {
      errors.push(`${where}: startDay must be 1–31.`);
    }
    const periods = Array.isArray(season?.periods) ? season.periods : [];
    if (!periods.length) {
      errors.push(`${where}: at least one period is required.`);
      continue;
    }
    const coverage = new Array(1440).fill(0);
    for (const [pi, p] of periods.entries()) {
      const pwhere = `${where}.period[${pi}] (${p?.name || 'unnamed'})`;
      if (!p?.name) errors.push(`${pwhere}: name is required.`);
      const start = parseTimeMinutes(p?.startTime);
      const end = parseTimeMinutes(p?.endTime);
      if (start == null) errors.push(`${pwhere}: invalid startTime (expected HH:MM).`);
      if (end == null) errors.push(`${pwhere}: invalid endTime (expected HH:MM, may be 24:00).`);
      if (!(Number(p?.buyRate) >= 0)) errors.push(`${pwhere}: buyRate must be ≥ 0.`);
      if (!(Number(p?.sellRate) >= 0)) errors.push(`${pwhere}: sellRate must be ≥ 0.`);
      if (start != null && end != null) {
        const endNorm = end === 0 ? 1440 : end;
        if (start < endNorm) {
          for (let i = start; i < endNorm; i++) coverage[i]++;
        } else {
          for (let i = start; i < 1440; i++) coverage[i]++;
          for (let i = 0; i < endNorm; i++) coverage[i]++;
        }
      }
    }
    const overlap = coverage.some(v => v > 1);
    const gap = coverage.some(v => v === 0);
    if (overlap) errors.push(`${where}: periods overlap; each minute of the day must be covered exactly once.`);
    if (gap) errors.push(`${where}: periods leave a gap; each minute of the day must be covered exactly once.`);
  }
  return errors;
}

function pickSoeSamples(soeSeries, peakStartMin, peakEndMin) {
  if (!Array.isArray(soeSeries) || !soeSeries.length) {
    return { soeAtPeakStart: null, soeAtPeakEnd: null, soeMinDuringPeak: null };
  }
  let startSample = null;
  let endSample = null;
  let minDuringPeak = null;
  let bestStartGap = Infinity;
  let bestEndGap = Infinity;
  for (const sample of soeSeries) {
    const ts = String(sample.timestamp || '');
    if (ts.length < 16) continue;
    const hour = Number(ts.slice(11, 13));
    const minute = Number(ts.slice(14, 16));
    const cur = hour * 60 + minute;
    const soe = Number(sample.soe);
    if (Number.isFinite(soe)) {
      const startGap = Math.abs(cur - peakStartMin);
      if (startGap < bestStartGap) { bestStartGap = startGap; startSample = soe; }
      const endGap = Math.abs(cur - peakEndMin);
      if (endGap < bestEndGap) { bestEndGap = endGap; endSample = soe; }
      const inPeak = peakStartMin < peakEndMin
        ? (cur >= peakStartMin && cur < peakEndMin)
        : (cur >= peakStartMin || cur < peakEndMin);
      if (inPeak && (minDuringPeak === null || soe < minDuringPeak)) minDuringPeak = soe;
    }
  }
  return {
    soeAtPeakStart: startSample === null ? null : round(startSample),
    soeAtPeakEnd: endSample === null ? null : round(endSample),
    soeMinDuringPeak: minDuringPeak === null ? null : round(minDuringPeak)
  };
}

function localWeekday(timestamp) {
  // Tesla timestamps include local offset (e.g. "2026-05-25T16:00:00-07:00").
  // Date() respects the offset, returning the correct UTC instant; getDay() then
  // returns the weekday in the *runtime's* local zone, which is good enough for
  // TOU-C since periods are identical across all weekdays anyway.
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? 0 : d.getDay();
}

function sumTouDays(days) {
  const totals = {
    importCost: 0,
    exportCredit: 0,
    netCost: 0,
    peakImportKwh: 0,
    peakImportCost: 0,
    peakExportKwh: 0,
    peakExportCredit: 0,
    peakAudit: {
      homeUsageKwh: 0,
      batteryToLoadKwh: 0,
      solarToLoadKwh: 0,
      gridToLoadKwh: 0,
      batteryToGridKwh: 0,
      solarToGridKwh: 0,
      batteryFromGridKwh: 0
    },
    periodTotals: {} // name -> { importedKwh, exportedKwh, importCost, exportCredit }
  };
  for (const day of days) {
    totals.importCost += day.importCost;
    totals.exportCredit += day.exportCredit;
    totals.netCost += day.netCost;
    totals.peakImportKwh += day.peakImportKwh;
    totals.peakImportCost += day.peakImportCost;
    totals.peakExportKwh += day.peakExportKwh;
    totals.peakExportCredit += day.peakExportCredit;
    for (const k of Object.keys(totals.peakAudit)) {
      totals.peakAudit[k] += day.peakAudit[k] || 0;
    }
    for (const p of day.periods) {
      if (!totals.periodTotals[p.period]) {
        totals.periodTotals[p.period] = { importedKwh: 0, exportedKwh: 0, importCost: 0, exportCredit: 0 };
      }
      const t = totals.periodTotals[p.period];
      t.importedKwh += p.importedKwh;
      t.exportedKwh += p.exportedKwh;
      t.importCost += p.importCost;
      t.exportCredit += p.exportCredit;
    }
  }
  for (const k of Object.keys(totals)) {
    if (typeof totals[k] === 'number') totals[k] = k.endsWith('Kwh') ? round(totals[k]) : roundCurrency(totals[k]);
  }
  for (const k of Object.keys(totals.peakAudit)) {
    totals.peakAudit[k] = round(totals.peakAudit[k]);
  }
  for (const p of Object.values(totals.periodTotals)) {
    p.importedKwh = round(p.importedKwh);
    p.exportedKwh = round(p.exportedKwh);
    p.importCost = roundCurrency(p.importCost);
    p.exportCredit = roundCurrency(p.exportCredit);
  }
  totals.peakAudit.percentLoadFromBattery = totals.peakAudit.homeUsageKwh > 0
    ? Math.round((totals.peakAudit.batteryToLoadKwh / totals.peakAudit.homeUsageKwh) * 1000) / 10
    : null;
  return totals;
}

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function aggregateEnergyIntervals(date, intervals) {
  const sum = intervals.reduce((acc, interval) => ({
    batteryImportedFromGridWh: acc.batteryImportedFromGridWh + Number(interval.battery_energy_imported_from_grid || 0),
    consumerImportedFromGridWh: acc.consumerImportedFromGridWh + Number(interval.consumer_energy_imported_from_grid || 0),
    batteryExportedWh: acc.batteryExportedWh + Number(interval.grid_energy_exported_from_battery || 0),
    solarExportedWh: acc.solarExportedWh + Number(interval.grid_energy_exported_from_solar || 0)
  }), {
    batteryImportedFromGridWh: 0,
    consumerImportedFromGridWh: 0,
    batteryExportedWh: 0,
    solarExportedWh: 0
  });

  const batteryImportedFromGridKwh = whToKwh(sum.batteryImportedFromGridWh);
  const consumerImportedFromGridKwh = whToKwh(sum.consumerImportedFromGridWh);
  const batteryExportedKwh = whToKwh(sum.batteryExportedWh);
  const solarExportedKwh = whToKwh(sum.solarExportedWh);
  const importedKwh = batteryImportedFromGridKwh + consumerImportedFromGridKwh;
  const exportedKwh = batteryExportedKwh + solarExportedKwh;
  const netKwh = importedKwh - exportedKwh;
  return {
    date,
    importedKwh: round(importedKwh),
    exportedKwh: round(exportedKwh),
    netKwh: round(netKwh),
    batteryExportedKwh: round(batteryExportedKwh),
    solarExportedKwh: round(solarExportedKwh),
    batteryImportedFromGridKwh: round(batteryImportedFromGridKwh),
    consumerImportedFromGridKwh: round(consumerImportedFromGridKwh),
    intervalCount: intervals.length
  };
}

function addHourlyIntervals(hourlyMap, intervals) {
  for (const interval of intervals) {
    const hour = String(interval.timestamp || '').slice(0, 13);
    if (!hour) continue;
    const existing = hourlyMap.get(hour) || blankEnergyRow({ hour });
    addIntervalToRow(existing, interval);
    hourlyMap.set(hour, existing);
  }
}

function summarizeBuckets(hourly) {
  const buckets = [
    { id: 'offPeakMidnight', label: 'Midnight Off-Peak', startHour: 0, endHour: 6 },
    { id: 'morningSolarRamp', label: 'Morning Solar Ramp', startHour: 7, endHour: 14 },
    { id: 'partialPeakPrep', label: 'Partial-Peak Prep', startHour: 15, endHour: 15 },
    { id: 'peak', label: 'Peak', startHour: 16, endHour: 20 },
    { id: 'lateEvening', label: 'Late Evening', startHour: 21, endHour: 23 }
  ].map(bucket => ({ ...bucket, ...blankEnergyTotals() }));

  for (const hour of hourly) {
    const localHour = Number(hour.hour.slice(11, 13));
    const bucket = buckets.find(item => localHour >= item.startHour && localHour <= item.endHour);
    if (!bucket) continue;
    addEnergyTotals(bucket, hour);
  }

  return buckets.map(bucket => ({
    id: bucket.id,
    label: bucket.label,
    window: `${String(bucket.startHour).padStart(2, '0')}:00-${String(bucket.endHour).padStart(2, '0')}:59`,
    ...roundReport(pickEnergyTotals(bucket))
  }));
}

function blankEnergyRow(extra = {}) {
  return {
    ...extra,
    ...blankEnergyTotals()
  };
}

function blankEnergyTotals() {
  return {
    importedKwh: 0,
    exportedKwh: 0,
    netKwh: 0,
    batteryExportedKwh: 0,
    solarExportedKwh: 0,
    batteryImportedFromGridKwh: 0,
    consumerImportedFromGridKwh: 0,
    intervalCount: 0
  };
}

function addIntervalToRow(row, interval) {
  const batteryImportedFromGridKwh = whToKwh(interval.battery_energy_imported_from_grid);
  const consumerImportedFromGridKwh = whToKwh(interval.consumer_energy_imported_from_grid);
  const batteryExportedKwh = whToKwh(interval.grid_energy_exported_from_battery);
  const solarExportedKwh = whToKwh(interval.grid_energy_exported_from_solar);
  row.batteryImportedFromGridKwh += batteryImportedFromGridKwh;
  row.consumerImportedFromGridKwh += consumerImportedFromGridKwh;
  row.batteryExportedKwh += batteryExportedKwh;
  row.solarExportedKwh += solarExportedKwh;
  row.importedKwh += batteryImportedFromGridKwh + consumerImportedFromGridKwh;
  row.exportedKwh += batteryExportedKwh + solarExportedKwh;
  row.netKwh = row.importedKwh - row.exportedKwh;
  row.intervalCount += 1;
}

function addEnergyTotals(target, source) {
  const totals = pickEnergyTotals(source);
  for (const [key, value] of Object.entries(totals)) {
    target[key] += value;
  }
}

function pickEnergyTotals(source) {
  return {
    importedKwh: source.importedKwh,
    exportedKwh: source.exportedKwh,
    netKwh: source.netKwh,
    batteryExportedKwh: source.batteryExportedKwh,
    solarExportedKwh: source.solarExportedKwh,
    batteryImportedFromGridKwh: source.batteryImportedFromGridKwh,
    consumerImportedFromGridKwh: source.consumerImportedFromGridKwh,
    intervalCount: source.intervalCount
  };
}

function roundEnergyRow(row) {
  return {
    ...row,
    ...roundReport(pickEnergyTotals(row))
  };
}

function whToKwh(value) {
  return Number(value || 0) / 1000;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function roundReport(report) {
  return Object.fromEntries(Object.entries(report).map(([key, value]) => [key, round(value)]));
}

function isDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '');
}

function dateRange(startDate, endDate) {
  const dates = [];
  const current = dateOnlyToUtc(startDate);
  const end = dateOnlyToUtc(endDate);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function dateOnlyToUtc(dateText) {
  const [year, month, day] = dateText.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function zonedDateTimeParam(dateText, timeText, timeZone) {
  return `${dateText}T${timeText}${timeZoneOffset(dateText, timeText, timeZone)}`;
}

function timeZoneOffset(dateText, timeText, timeZone) {
  const [year, month, day] = dateText.split('-').map(Number);
  const [hour, minute, second] = timeText.split(':').map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(utcGuess).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '00' : parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMinutes = Math.round((asUtc - utcGuess.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

async function runManual(url, res) {
  const id = decodeURIComponent(url.pathname.replace('/api/run/', ''));
  const dryRun = url.searchParams.get('dryRun') === '1';
  const scheduleId = url.searchParams.get('scheduleId');
  const config = await readConfig();
  const selectedSchedule = scheduleId
    ? config.schedules.find(schedule => schedule.id === scheduleId)
    : activeSchedule(config);
  const step = selectedSchedule?.schedule.find(row => row.id === id);
  if (!step) return sendJson(res, { error: 'Schedule row not found.' }, 404);
  const result = await applyStep(step, { dryRun, source: 'manual' });
  return sendJson(res, result);
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${hour}:${parts.minute}`
  };
}

async function applyStep(step, { dryRun, source }) {
  const config = await readConfig();
  const energySiteId = config.tesla.energySiteId || (dryRun ? '{energy_site_id}' : '');
  requireTeslaSetting(energySiteId, 'Energy site ID');

  const requests = [
    {
      name: 'backup',
      path: `/api/1/energy_sites/${energySiteId}/backup`,
      body: { backup_reserve_percent: step.backupReservePercent }
    },
    {
      name: 'operation',
      path: `/api/1/energy_sites/${energySiteId}/operation`,
      body: { default_real_mode: step.operationModeApi }
    },
    {
      name: 'grid_import_export',
      path: `/api/1/energy_sites/${energySiteId}/grid_import_export`,
      body: {
        customer_preferred_export_rule: step.energyExportsApi,
        disallow_charge_from_grid_with_solar_installed: !step.gridCharging
      }
    }
  ];

  if (dryRun) {
    await logEvent('info', 'dry_run', { source, id: step.id, requests });
    return { ok: true, dryRun: true, requests };
  }

  const responses = [];
  for (const request of requests) {
    const response = await teslaFetch(request.path, {
      method: 'POST',
      body: JSON.stringify(request.body)
    });
    responses.push({ name: request.name, response });
  }

  await logEvent('info', 'step_applied', {
    source,
    id: step.id,
    time: step.time,
    backupReservePercent: step.backupReservePercent,
    operationModeApi: step.operationModeApi,
    energyExportsApi: step.energyExportsApi,
    gridCharging: step.gridCharging,
    responses
  });

  return { ok: true, dryRun: false, responses };
}

function requireTeslaSetting(value, label) {
  if (!value) throw new Error(`${label} is required.`);
}

async function getAuthSummary() {
  const tokens = await readJson(TOKENS_PATH, {});
  return {
    connected: Boolean(tokens.access_token || tokens.refresh_token),
    updatedAt: tokens.updated_at || null,
    expiresAt: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null
  };
}

async function getStatus() {
  const config = await readConfig();
  return {
    now: new Date().toISOString(),
    timezone: config.timezone,
    nextRun: getNextRun(config),
    auth: await getAuthSummary(),
    logs: await getRecentLogs()
  };
}

function getNextRun(config) {
  const currentSchedule = activeSchedule(config);
  const enabled = (currentSchedule.schedule || []).filter(row => row.enabled);
  if (enabled.length === 0) return null;
  const now = zonedParts(new Date(), config.timezone || 'America/Los_Angeles');
  const laterToday = enabled.map(row => row.time).filter(time => time > now.hhmm).sort()[0];
  return laterToday || enabled.map(row => row.time).sort()[0];
}

async function getRecentLogs() {
  const sources = [{ path: LOG_PATH, source: 'server' }];
  if (existsSync(LOG_DIR)) {
    const entries = await readdir(LOG_DIR);
    for (const name of entries.sort()) {
      const match = name.match(/^run-(\d{2})(\d{2})\.log$/);
      if (!match) continue;
      sources.push({
        path: path.join(LOG_DIR, name),
        source: `step ${match[1]}:${match[2]}`
      });
    }
  }

  const all = [];
  for (const { path: filePath, source } of sources) {
    if (!existsSync(filePath)) continue;
    const body = await readFile(filePath, 'utf8');
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Skip the multi-line pretty-JSON dumps from older runs by ignoring
      // lines that don't start with '{"' — those are the inner formatting
      // lines that aren't standalone JSON entries.
      if (!trimmed.startsWith('{"')) continue;
      const parsed = safeJson(trimmed);
      if (!parsed || typeof parsed !== 'object' || !parsed.ts) continue;
      all.push({ ...parsed, source });
    }
  }

  all.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return all.slice(-200);
}

async function logEvent(level, event, details) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    details
  };
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(LOG_PATH, `${JSON.stringify(entry)}\n`);
}

async function serveStatic(urlPath, res) {
  const safePath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 'Not found', 404);
  if (!existsSync(filePath)) return sendText(res, 'Not found', 404);
  const ext = path.extname(filePath);
  const body = await readFile(filePath);
  res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] || 'application/octet-stream' });
  res.end(body);
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value, null, 2));
}

function sendText(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(value);
}
