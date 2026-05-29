import { readFile, writeFile, mkdir, copyFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(APP_DIR, 'config');
const LOG_DIR = path.join(APP_DIR, 'logs');
const DEFAULT_SCHEDULE_PATH = path.join(CONFIG_DIR, 'default-schedule.json');
const SCHEDULE_PATH = path.join(CONFIG_DIR, 'schedule.json');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'local-settings.json');
const TOKENS_PATH = path.join(CONFIG_DIR, 'tokens.json');
const RUN_STATE_PATH = path.join(CONFIG_DIR, 'run-state.json');
const LEGACY_LOG_PATH = path.join(LOG_DIR, 'scheduler.log');
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const REGION_BASE_URLS = {
  na: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
  eu: 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
  cn: 'https://fleet-api.prd.cn.vn.cloud.tesla.cn'
};

// Verify timing. Tweak here if Tesla's gateway settle window changes.
const VERIFY_SETTLE_MS = 45_000;
const VERIFY_RETRY_MS = 60_000;
const VERIFY_MAX_ATTEMPTS = 3;

// Log path for the current run; set per step when --step is used.
let LOG_PATH = LEGACY_LOG_PATH;

await ensureFiles();
const env = await loadEnvFile(path.join(APP_DIR, '.env'));
const options = parseArgs();

try {
  if (options.step) {
    const result = await runStep(options.step, { dryRun: options.dryRun });
    // Why: structured logEvent entries already capture everything; the prior
    // pretty-JSON dump produced ~30 unparseable lines per run in the per-step
    // log file that the Activity feed couldn't render. CLI users can still
    // inspect the log files (or run with --print to get the legacy dump).
    if (hasArg('--print')) console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }
  const result = await runDueSteps(options);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.errors.length ? 1 : 0);
} catch (error) {
  await logEvent('error', 'one_shot_failed', { message: error.message, stack: error.stack });
  console.error(error.message);
  process.exit(1);
}

async function ensureFiles() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  if (!existsSync(SCHEDULE_PATH)) await copyFile(DEFAULT_SCHEDULE_PATH, SCHEDULE_PATH);
  if (!existsSync(SETTINGS_PATH)) await writeJson(SETTINGS_PATH, {});
  if (!existsSync(RUN_STATE_PATH)) await writeJson(RUN_STATE_PATH, {});
}

function parseArgs() {
  return {
    dryRun: hasArg('--dry-run'),
    force: hasArg('--force'),
    step: arg('--step'),
    at: arg('--at'),
    date: arg('--date'),
    windowMinutes: Number(arg('--window-minutes') || 3)
  };
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] || '';
}

function hasArg(name) {
  return process.argv.includes(name);
}

async function runStep(stepId, { dryRun }) {
  const config = await readConfig();
  const schedule = activeSchedule(config);
  const step = (schedule.schedule || []).find(row => row.id === stepId);
  if (!step) throw new Error(`Step "${stepId}" not found in active schedule "${schedule.id}".`);

  // Per-step log file. Time is the unique key.
  LOG_PATH = path.join(LOG_DIR, `run-${step.time.replace(':', '')}.log`);

  await logEvent('info', 'step_start', {
    source: 'cron',
    scheduleId: schedule.id,
    id: step.id,
    time: step.time,
    dryRun
  });

  if (dryRun) {
    const requests = buildRequests(step, config.tesla.energySiteId || '{energy_site_id}');
    await logEvent('info', 'dry_run', { id: step.id, requests });
    return { ok: true, dryRun: true, id: step.id, requests };
  }

  const applied = await applyStep(step, config);
  const verification = await verifyWithRetry(step, config);

  if (verification.ok) {
    await logEvent('info', 'step_verified', {
      id: step.id,
      time: step.time,
      attempts: verification.attempts,
      observed: verification.observed
    });
  } else {
    await logEvent('error', 'verify_failed', {
      id: step.id,
      time: step.time,
      attempts: verification.attempts,
      mismatched: verification.mismatched,
      observed: verification.observed
    });
  }

  return {
    ok: verification.ok,
    id: step.id,
    time: step.time,
    applied,
    verification
  };
}

function buildRequests(step, energySiteId) {
  return [
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
}

async function applyStep(step, config) {
  const energySiteId = config.tesla.energySiteId;
  requireTeslaSetting(energySiteId, 'Energy site ID');
  const requests = buildRequests(step, energySiteId);
  return postRequests(requests);
}

async function postRequests(requests) {
  const responses = [];
  for (const request of requests) {
    const response = await teslaFetch(request.path, {
      method: 'POST',
      body: JSON.stringify(request.body)
    });
    responses.push({ name: request.name, response });
  }
  return responses;
}

async function verifyWithRetry(step, config) {
  const desired = {
    backup_reserve_percent: step.backupReservePercent,
    default_real_mode: step.operationModeApi,
    customer_preferred_export_rule: step.energyExportsApi,
    disallow_charge_from_grid_with_solar_installed: !step.gridCharging
  };

  for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt += 1) {
    await sleep(attempt === 1 ? VERIFY_SETTLE_MS : VERIFY_RETRY_MS);
    const observed = await readSiteInfo(config);
    const mismatched = diffFields(desired, observed);

    if (mismatched.length === 0) {
      return { ok: true, attempts: attempt, observed };
    }

    await logEvent('warn', 'verify_mismatch', {
      id: step.id,
      attempt,
      mismatched,
      observed
    });

    if (attempt === VERIFY_MAX_ATTEMPTS) {
      return { ok: false, attempts: attempt, observed, mismatched };
    }

    // Re-POST only the mismatched fields. Path-per-field so we don't redo settled work.
    const energySiteId = config.tesla.energySiteId;
    const retryRequests = buildRequests(step, energySiteId).filter(request => {
      if (request.name === 'backup') return mismatched.some(m => m.field === 'backup_reserve_percent');
      if (request.name === 'operation') return mismatched.some(m => m.field === 'default_real_mode');
      if (request.name === 'grid_import_export') {
        return mismatched.some(m =>
          m.field === 'customer_preferred_export_rule' ||
          m.field === 'disallow_charge_from_grid_with_solar_installed'
        );
      }
      return false;
    });
    await postRequests(retryRequests);
  }

  return { ok: false, attempts: VERIFY_MAX_ATTEMPTS, observed: null, mismatched: [] };
}

async function readSiteInfo(config) {
  const energySiteId = config.tesla.energySiteId;
  const raw = await teslaFetch(`/api/1/energy_sites/${energySiteId}/site_info`);
  const response = raw?.response || {};
  const components = response.components || {};
  return {
    backup_reserve_percent: response.backup_reserve_percent,
    default_real_mode: response.default_real_mode,
    customer_preferred_export_rule: components.customer_preferred_export_rule,
    disallow_charge_from_grid_with_solar_installed: components.disallow_charge_from_grid_with_solar_installed
  };
}

function diffFields(desired, observed) {
  const out = [];
  for (const field of Object.keys(desired)) {
    if (desired[field] !== observed?.[field]) {
      out.push({ field, desired: desired[field], observed: observed?.[field] });
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runDueSteps({ dryRun, force, at, date, windowMinutes }) {
  const config = await readConfig();
  const currentSchedule = activeSchedule(config);
  const now = zonedParts(new Date(), config.timezone || 'America/Los_Angeles');
  const current = {
    ...now,
    date: date || now.date,
    hhmm: at || now.hhmm
  };
  current.minutes = minutesFromHHMM(current.hhmm);

  const summary = {
    ok: true,
    source: 'one-shot',
    dryRun,
    force,
    timezone: config.timezone || 'America/Los_Angeles',
    checkedAt: new Date().toISOString(),
    localDate: current.date,
    localTime: current.hhmm,
    windowMinutes,
    activeScheduleId: currentSchedule.id,
    activeScheduleName: currentSchedule.name,
    matched: [],
    skipped: [],
    errors: []
  };

  const runState = await readJson(RUN_STATE_PATH, {});
  const dueSteps = (currentSchedule.schedule || []).filter(step => isDue(step, current.minutes, windowMinutes, force));

  for (const step of dueSteps) {
    const key = `${currentSchedule.id}:${step.id}:${current.date}`;
    if (runState[key] && !force) {
      summary.skipped.push({ id: step.id, time: step.time, reason: 'already_ran_today' });
      continue;
    }

    try {
      const config2 = await readConfig();
      const applied = dryRun
        ? { ok: true, dryRun: true, requests: buildRequests(step, config2.tesla.energySiteId || '{energy_site_id}') }
        : await applyStep(step, config2);
      summary.matched.push({ id: step.id, time: step.time, applied });
      if (!dryRun) {
        runState[key] = new Date().toISOString();
        await writeJson(RUN_STATE_PATH, runState);
      }
    } catch (error) {
      summary.ok = false;
      summary.errors.push({ id: step.id, time: step.time, message: error.message });
      await logEvent('error', 'one_shot_step_failed', { id: step.id, time: step.time, message: error.message });
    }
  }

  if (dueSteps.length === 0) {
    summary.skipped.push({ reason: 'no_due_rows' });
  }

  await logEvent(summary.errors.length ? 'error' : 'info', 'one_shot_complete', summary);
  return summary;
}

function isDue(step, currentMinutes, windowMinutes, force) {
  if (!step.enabled && !force) return false;
  if (force && options.at && step.time !== options.at) return false;
  const scheduled = minutesFromHHMM(step.time);
  if (Number.isNaN(scheduled)) return false;
  const lateBy = currentMinutes - scheduled;
  return lateBy >= 0 && lateBy <= Math.max(0, windowMinutes);
}

function minutesFromHHMM(hhmm) {
  const [hour, minute] = String(hhmm || '').split(':').map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return NaN;
  return hour * 60 + minute;
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

async function teslaFetch(pathname, requestOptions = {}) {
  const config = await readConfig();
  const baseUrl = REGION_BASE_URLS[config.tesla?.region] || REGION_BASE_URLS.na;
  const accessToken = await getAccessToken();
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...requestOptions,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      ...(requestOptions.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? safeJson(text) : {};
  if (!response.ok) throw new Error(`Tesla API ${pathname} failed: ${response.status} ${text}`);
  return data;
}

async function getAccessToken() {
  const config = await readConfig();
  const tokens = await readJson(TOKENS_PATH, {});
  if (!tokens.access_token) throw new Error('Tesla is not connected. Use Connect Tesla in the web UI first.');
  if (tokens.expires_at && Date.now() < tokens.expires_at) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error('Tesla token expired and no refresh token is available.');

  const refreshed = await tokenRequest({
    grant_type: 'refresh_token',
    client_id: config.tesla.clientId,
    refresh_token: tokens.refresh_token
  });
  await saveTokens(refreshed);
  return refreshed.access_token;
}

async function tokenRequest(body) {
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
  tesla.redirectUri ||= env.TESLA_REDIRECT_URI || process.env.TESLA_REDIRECT_URI || 'http://localhost:8787/auth/callback';
  tesla.region ||= env.TESLA_REGION || process.env.TESLA_REGION || 'na';

  return {
    ...normalized,
    tesla,
    schedule: activeSchedule(normalized).schedule
  };
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

function normalizeSchedule(rows) {
  return rows.map(row => ({
    id: row.id || cryptoRandomId(),
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

function cryptoRandomId() {
  return `row-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function requireTeslaSetting(value, label) {
  if (!value) throw new Error(`${label} is required.`);
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
