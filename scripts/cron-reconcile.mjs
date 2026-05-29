import { readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

// We own only the lines between these markers in the user's crontab; anything
// else they have is left untouched.
const BLOCK_START = '# >>> powerwall-scheduler >>>';
const BLOCK_END = '# <<< powerwall-scheduler <<<';

// Fire each step one minute past its scheduled time so the clock has clearly
// crossed the boundary by the time the script POSTs. The verify loop in
// run-due.mjs adds its own settle window on top.
const TRIGGER_OFFSET_MIN = 1;

export async function reconcileCron({ schedule, appDir, nodeBin, logDir, knownSignature }) {
  const enabled = (schedule.schedule || []).filter(row => row.enabled);
  assertNoDuplicateTimes(enabled);

  const lines = [];
  const jobs = [];
  for (const step of enabled) {
    const [hourRaw, minuteRaw] = step.time.split(':').map(Number);
    let minute = minuteRaw + TRIGGER_OFFSET_MIN;
    let hour = hourRaw;
    if (minute >= 60) {
      minute -= 60;
      hour = (hour + 1) % 24;
    }
    const logFile = path.join(logDir, `run-${step.time.replace(':', '')}.log`);
    const scriptPath = path.join(appDir, 'scripts', 'run-due.mjs');
    // cron has a minimal PATH, so every path is absolute and quoted.
    const command = `${shq(nodeBin)} ${shq(scriptPath)} --step ${shq(step.id)} >> ${shq(logFile)} 2>&1`;
    lines.push(`${minute} ${hour} * * * ${command}`);
    jobs.push({ time: step.time, id: step.id, schedule: `${minute} ${hour} * * *` });
  }

  // The signature is the desired block content. If the caller tells us the same
  // block is already installed, skip touching crontab entirely — this avoids the
  // macOS Full Disk Access prompt on saves that didn't change any times.
  const signature = lines.join('\n');
  if (knownSignature != null && knownSignature === signature) {
    return { ok: true, jobs, changed: false, signature };
  }

  const current = await readCrontab();
  const next = replaceBlock(current, lines);
  const changed = next !== current;
  if (changed) await writeCrontab(next);
  return { ok: true, jobs, changed, signature };
}

export async function removeManagedCron() {
  const current = await readCrontab();
  const next = replaceBlock(current, []);
  if (next === current) return false;
  await writeCrontab(next);
  return true;
}

// One-time cleanup for people upgrading from the launchd-based versions:
// remove the per-step LaunchAgents so they don't double-fire alongside cron.
// (The always-on server LaunchAgent, if any, is handled by the install docs.)
export async function removeLegacyLaunchd() {
  if (process.platform !== 'darwin') return false;
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  if (!existsSync(dir)) return false;
  const entries = await readdir(dir).catch(() => []);
  let removed = false;
  for (const name of entries) {
    if (!name.endsWith('.plist')) continue;
    const isLegacy =
      name.startsWith('powerwall-scheduler.step.') ||
      name.startsWith('com.toddhoff.tesla.') ||
      name === 'com.toddhoff.tesla-run-due.plist';
    if (!isLegacy) continue;
    const plistPath = path.join(dir, name);
    const label = name.replace(/\.plist$/, '');
    await execFileAsync('/bin/launchctl', ['unload', plistPath]).catch(() => {});
    await execFileAsync('/bin/launchctl', ['remove', label]).catch(() => {});
    await unlink(plistPath).catch(() => {});
    removed = true;
  }
  return removed;
}

function replaceBlock(crontab, lines) {
  const out = [];
  let inBlock = false;
  for (const line of (crontab ? crontab.split('\n') : [])) {
    if (line.trim() === BLOCK_START) { inBlock = true; continue; }
    if (line.trim() === BLOCK_END) { inBlock = false; continue; }
    if (!inBlock) out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  if (lines.length) out.push(BLOCK_START, ...lines, BLOCK_END);
  return out.length ? `${out.join('\n')}\n` : '';
}

async function readCrontab() {
  try {
    const { stdout } = await execFileAsync('crontab', ['-l']);
    return stdout;
  } catch {
    // No crontab installed yet → treat as empty.
    return '';
  }
}

function writeCrontab(content) {
  return new Promise((resolve, reject) => {
    const child = execFile('crontab', ['-'], error => (error ? reject(error) : resolve()));
    child.stdin.on('error', reject);
    child.stdin.end(content);
  });
}

// Single-quote for the shell cron will run the line under.
function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function assertNoDuplicateTimes(steps) {
  const seen = new Map();
  for (const step of steps) {
    if (seen.has(step.time)) {
      throw new Error(
        `Two enabled rows share time ${step.time} ("${seen.get(step.time)}" and "${step.id}"). ` +
        `Each scheduled time must be unique.`
      );
    }
    seen.set(step.time, step.id);
  }
}
