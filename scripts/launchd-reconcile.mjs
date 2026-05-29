import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const LABEL_PREFIX = 'powerwall-scheduler.step.';
// Old labels we sweep away on reconcile so upgraders don't keep orphaned jobs:
// the original every-5-min cron, and the previous personalized per-step prefix.
const LEGACY_LABELS = ['com.toddhoff.tesla-run-due'];
const LEGACY_STEP_PREFIXES = ['com.toddhoff.tesla.'];

// Fire each step one minute past its scheduled time so the clock has clearly
// crossed the boundary by the time the script POSTs. The verify loop adds its
// own 45 s settle window on top.
const TRIGGER_OFFSET_MIN = 1;

export async function reconcileLaunchd({ schedule, appDir, nodeBin, logDir }) {
  await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });

  const enabled = (schedule.schedule || []).filter(row => row.enabled);
  assertNoDuplicateTimes(enabled);

  const desired = new Map();
  for (const step of enabled) {
    const label = labelForStep(step);
    desired.set(label, {
      label,
      plistPath: path.join(LAUNCH_AGENTS_DIR, `${label}.plist`),
      content: renderPlist({ step, label, appDir, nodeBin, logDir })
    });
  }

  const existing = await listExistingPlists();
  const result = { added: [], updated: [], removed: [], unchanged: [] };

  for (const file of existing) {
    if (!desired.has(file.label)) {
      await unloadAndDelete(file);
      result.removed.push(file.label);
    }
  }

  for (const want of desired.values()) {
    const existingFile = existing.find(file => file.label === want.label);
    if (existingFile && existingFile.content === want.content) {
      // Ensure it's loaded, but don't rewrite or restart.
      await ensureLoaded(want);
      result.unchanged.push(want.label);
      continue;
    }
    await writeAndLoad(want);
    if (existingFile) result.updated.push(want.label);
    else result.added.push(want.label);
  }

  return result;
}

export async function removeLegacyPlist() {
  let removedAny = false;
  for (const label of LEGACY_LABELS) {
    const plistPath = path.join(LAUNCH_AGENTS_DIR, `${label}.plist`);
    if (existsSync(plistPath)) {
      await unloadAndDelete({ label, plistPath });
      removedAny = true;
    }
  }
  return removedAny;
}

function labelForStep(step) {
  return `${LABEL_PREFIX}${step.time.replace(':', '')}`;
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

function renderPlist({ step, label, appDir, nodeBin, logDir }) {
  const [hourStr, minuteStr] = step.time.split(':');
  let hour = Number(hourStr);
  let minute = Number(minuteStr) + TRIGGER_OFFSET_MIN;
  if (minute >= 60) {
    minute -= 60;
    hour = (hour + 1) % 24;
  }

  const logFile = path.join(logDir, `run-${step.time.replace(':', '')}.log`);
  const scriptPath = path.join(appDir, 'scripts', 'run-due.mjs');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${label}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escapeXml(nodeBin)}</string>`,
    `    <string>${escapeXml(scriptPath)}</string>`,
    '    <string>--step</string>',
    `    <string>${escapeXml(step.id)}</string>`,
    '  </array>',
    `  <key>WorkingDirectory</key><string>${escapeXml(appDir)}</string>`,
    '  <key>StartCalendarInterval</key>',
    '  <dict>',
    `    <key>Hour</key><integer>${hour}</integer>`,
    `    <key>Minute</key><integer>${minute}</integer>`,
    '  </dict>',
    `  <key>StandardOutPath</key><string>${escapeXml(logFile)}</string>`,
    `  <key>StandardErrorPath</key><string>${escapeXml(logFile)}</string>`,
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function listExistingPlists() {
  if (!existsSync(LAUNCH_AGENTS_DIR)) return [];
  const entries = await readdir(LAUNCH_AGENTS_DIR);
  const matches = entries.filter(name => {
    if (!name.endsWith('.plist')) return false;
    if (name.startsWith(LABEL_PREFIX)) return true;
    if (LEGACY_STEP_PREFIXES.some(prefix => name.startsWith(prefix))) return true;
    if (LEGACY_LABELS.some(label => name === `${label}.plist`)) return true;
    return false;
  });
  const out = [];
  for (const name of matches) {
    const plistPath = path.join(LAUNCH_AGENTS_DIR, name);
    const label = name.replace(/\.plist$/, '');
    let content = '';
    try {
      content = await readFile(plistPath, 'utf8');
    } catch {
      // ignore unreadable plists; they'll be rewritten or removed
    }
    out.push({ label, plistPath, content });
  }
  return out;
}

async function unloadAndDelete({ label, plistPath }) {
  await launchctl(['unload', plistPath]).catch(() => {});
  await launchctl(['remove', label]).catch(() => {});
  if (existsSync(plistPath)) await unlink(plistPath);
}

async function writeAndLoad({ plistPath, content }) {
  await launchctl(['unload', plistPath]).catch(() => {});
  await writeFile(plistPath, content);
  await launchctl(['load', plistPath]);
}

async function ensureLoaded({ label, plistPath }) {
  try {
    await launchctl(['list', label]);
    return;
  } catch {
    // not loaded; load it.
  }
  await launchctl(['load', plistPath]);
}

async function launchctl(args) {
  return execFileAsync('/bin/launchctl', args);
}
