import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const SETTINGS_PATH = path.join(APP_DIR, 'config', 'local-settings.json');
const ENV_PATH = path.join(APP_DIR, '.env');
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const REGION_BASE_URLS = {
  na: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
  eu: 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
  cn: 'https://fleet-api.prd.cn.vn.cloud.tesla.cn'
};

const env = await loadEnvFile(ENV_PATH);
const localSettings = await readJson(SETTINGS_PATH, {});
const tesla = localSettings.tesla || {};
const region = arg('--region') || env.TESLA_REGION || tesla.region || 'na';
const baseUrl = REGION_BASE_URLS[region] || REGION_BASE_URLS.na;
const clientId = arg('--client-id') || env.TESLA_CLIENT_ID || tesla.clientId;
const clientSecret = arg('--client-secret') || env.TESLA_CLIENT_SECRET || tesla.clientSecret;
const domain = arg('--domain') || env.TESLA_APP_DOMAIN;

if (!clientId || !clientSecret || !domain) {
  console.error('Missing required values. Provide TESLA_CLIENT_ID, TESLA_CLIENT_SECRET, and TESLA_APP_DOMAIN in .env, or pass --client-id, --client-secret, and --domain.');
  process.exit(1);
}

const tokenResponse = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    audience: baseUrl
  })
});

const tokenData = await tokenResponse.json().catch(() => ({}));
if (!tokenResponse.ok) {
  console.error(`Partner token failed: ${tokenResponse.status}`);
  console.error(JSON.stringify(tokenData, null, 2));
  process.exit(1);
}

const registerResponse = await fetch(`${baseUrl}/api/1/partner_accounts`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${tokenData.access_token}`,
    'content-type': 'application/json'
  },
  body: JSON.stringify({ domain })
});

const registerData = await registerResponse.json().catch(() => ({}));
if (!registerResponse.ok) {
  console.error(`Partner registration failed: ${registerResponse.status}`);
  console.error(JSON.stringify(registerData, null, 2));
  process.exit(1);
}

console.log('Partner account registered.');
console.log(JSON.stringify(registerData, null, 2));

const keyResponse = await fetch(`${baseUrl}/api/1/partner_accounts/public_key?domain=${encodeURIComponent(domain)}`, {
  headers: { authorization: `Bearer ${tokenData.access_token}` }
});
const keyData = await keyResponse.json().catch(() => ({}));
console.log('Public key check:');
console.log(JSON.stringify(keyData, null, 2));

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] || '';
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
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}
