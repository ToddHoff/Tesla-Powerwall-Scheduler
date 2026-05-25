import http from 'node:http';
import { readFile, writeFile, mkdir, copyFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

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

let schedulerTimer;

await ensureFiles();
const env = await loadEnvFile(path.join(__dirname, '.env'));
const port = Number(env.PORT || process.env.PORT || 8787);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${port}`}`);

    if (url.pathname === '/api/config' && req.method === 'GET') return sendJson(res, await getPublicConfig());
    if (url.pathname === '/api/config' && req.method === 'POST') return await saveConfig(req, res);
    if (url.pathname === '/api/status' && req.method === 'GET') return sendJson(res, await getStatus());
    if (url.pathname === '/api/discover' && req.method === 'POST') return await discoverSites(res);
    if (url.pathname === '/api/live-status' && req.method === 'GET') return await liveStatus(res);
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

server.listen(port, () => {
  console.log(`Tesla scheduler running at http://localhost:${port}`);
});

startScheduler();

async function ensureFiles() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  if (!existsSync(SCHEDULE_PATH)) await copyFile(DEFAULT_SCHEDULE_PATH, SCHEDULE_PATH);
  if (!existsSync(SETTINGS_PATH)) await writeJson(SETTINGS_PATH, {});
  if (!existsSync(RUN_STATE_PATH)) await writeJson(RUN_STATE_PATH, {});
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
    schedule: activeSchedule(normalized).schedule,
    activeMonths: activeSchedule(normalized).activeMonths
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
    activeMonths: active.activeMonths,
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
  return sendJson(res, await getPublicConfig());
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
    : defaultSchedules(legacyRows, raw.activeMonths);

  schedules = schedules.map((schedule, index) => ({
    id: schedule.id || (index === 0 ? 'summer' : `schedule-${index + 1}`),
    name: schedule.name || (index === 0 ? 'Summer' : `Schedule ${index + 1}`),
    activeMonths: normalizeMonths(schedule.activeMonths || (index === 0 ? raw.activeMonths : undefined), index === 0 ? [6, 7, 8, 9] : [1, 2, 3, 4, 5, 10, 11, 12]),
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

function defaultSchedules(legacyRows, legacyMonths) {
  return [
    {
      id: 'summer',
      name: 'Summer',
      activeMonths: normalizeMonths(legacyMonths, [6, 7, 8, 9]),
      schedule: legacyRows
    },
    defaultWinterSchedule()
  ];
}

function defaultWinterSchedule() {
  return {
    id: 'winter',
    name: 'Winter',
    activeMonths: [1, 2, 3, 4, 5, 10, 11, 12],
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

function normalizeMonths(months, fallback) {
  const values = Array.isArray(months) ? months : fallback;
  return [...new Set(values.map(Number).filter(month => month >= 1 && month <= 12))].sort((a, b) => a - b);
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

function startScheduler() {
  clearInterval(schedulerTimer);
  schedulerTimer = setInterval(() => {
    runDueSteps().catch(error => logEvent('error', 'scheduler_failed', { message: error.message }));
  }, 30_000);
  runDueSteps().catch(error => logEvent('error', 'scheduler_failed', { message: error.message }));
}

async function runDueSteps() {
  const config = await readConfig();
  const now = zonedParts(new Date(), config.timezone || 'America/Los_Angeles');
  const currentSchedule = activeSchedule(config);
  if (!currentSchedule.activeMonths?.includes(now.month)) return;

  const runState = await readJson(RUN_STATE_PATH, {});
  for (const step of currentSchedule.schedule || []) {
    if (!step.enabled || step.time !== now.hhmm) continue;
    const key = `${currentSchedule.id}:${step.id}:${now.date}`;
    if (runState[key]) continue;

    try {
      await applyStep(step, { dryRun: false, source: 'scheduler' });
      runState[key] = new Date().toISOString();
      await writeJson(RUN_STATE_PATH, runState);
    } catch (error) {
      await logEvent('error', 'scheduled_step_failed', { id: step.id, message: error.message });
    }
  }
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
    month: Number(parts.month),
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
  if (!existsSync(LOG_PATH)) return [];
  const body = await readFile(LOG_PATH, 'utf8');
  return body.trim().split(/\r?\n/).filter(Boolean).slice(-80).map(line => safeJson(line));
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
