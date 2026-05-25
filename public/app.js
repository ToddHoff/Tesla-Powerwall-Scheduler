const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let config;
let selectedScheduleId;

const els = {
  connectionPill: document.querySelector('#connectionPill'),
  seasonText: document.querySelector('#seasonText'),
  nextRunText: document.querySelector('#nextRunText'),
  siteText: document.querySelector('#siteText'),
  region: document.querySelector('#region'),
  clientId: document.querySelector('#clientId'),
  clientSecret: document.querySelector('#clientSecret'),
  redirectUri: document.querySelector('#redirectUri'),
  energySiteId: document.querySelector('#energySiteId'),
  saveConfig: document.querySelector('#saveConfig'),
  discoverSites: document.querySelector('#discoverSites'),
  liveStatus: document.querySelector('#liveStatus'),
  operationStatus: document.querySelector('#operationStatus'),
  siteResults: document.querySelector('#siteResults'),
  scheduleSwitcher: document.querySelector('#scheduleSwitcher'),
  months: document.querySelector('#months'),
  scheduleRows: document.querySelector('#scheduleRows'),
  rowTemplate: document.querySelector('#rowTemplate'),
  addRow: document.querySelector('#addRow'),
  refreshStatus: document.querySelector('#refreshStatus'),
  logOutput: document.querySelector('#logOutput')
};

await load();

els.saveConfig.addEventListener('click', async () => {
  await runWithFeedback({
    buttons: [els.saveConfig],
    pendingText: 'Saving...',
    successText: 'Saved',
    statusEl: els.operationStatus,
    pendingMessage: 'Saving configuration...',
    successMessage: 'Configuration saved.',
    task: async () => {
      config = collectConfig();
      const saved = await api('/api/config', { method: 'POST', body: config });
      config = saved;
      selectedScheduleId = selectedScheduleId || config.activeScheduleId;
      render();
      await refreshStatus();
    }
  });
});

els.addRow.addEventListener('click', () => {
  const schedule = selectedSchedule();
  schedule.schedule.push({
    id: crypto.randomUUID(),
    enabled: true,
    time: '12:00',
    backupReservePercent: 30,
    operationMode: 'Time-Based Control',
    operationModeApi: 'autonomous',
    energyExports: 'Solar Only',
    energyExportsApi: 'pv_only',
    gridCharging: false,
    purpose: ''
  });
  renderSchedule();
});

els.refreshStatus.addEventListener('click', refreshStatus);

els.discoverSites.addEventListener('click', async () => {
  await runWithFeedback({
    buttons: [els.discoverSites],
    pendingText: 'Discovering...',
    successText: 'Discover Sites',
    statusEl: els.operationStatus,
    pendingMessage: 'Asking Tesla for energy sites...',
    successMessage: 'Site discovery finished.',
    task: async () => {
      els.siteResults.textContent = 'Discovering...';
      const result = await api('/api/discover', { method: 'POST' });
      els.siteResults.textContent = result.sites.length
        ? result.sites.map(site => `${site.siteName}: ${site.energySiteId}`).join('\n')
        : 'No energy sites returned by Tesla.';
      await load();
    }
  });
});

els.liveStatus.addEventListener('click', async () => {
  await runWithFeedback({
    buttons: [els.liveStatus],
    pendingText: 'Loading...',
    successText: 'Live Status',
    statusEl: els.operationStatus,
    pendingMessage: 'Loading live Tesla status...',
    successMessage: 'Live status loaded.',
    task: async () => {
      els.siteResults.textContent = 'Loading live status...';
      const result = await api('/api/live-status');
      els.siteResults.textContent = JSON.stringify(result, null, 2);
    }
  });
});

async function load() {
  config = await api('/api/config');
  selectedScheduleId = selectedScheduleId || config.activeScheduleId;
  render();
  await refreshStatus();
}

function render() {
  ensureSchedules();
  els.region.value = config.tesla.region || 'na';
  els.clientId.value = config.tesla.clientId || '';
  els.clientSecret.value = config.tesla.clientSecret || '';
  els.redirectUri.value = config.tesla.redirectUri || '';
  els.energySiteId.value = config.tesla.energySiteId || '';
  els.connectionPill.textContent = config.auth.connected ? 'Connected' : 'Not connected';
  els.connectionPill.classList.toggle('connected', config.auth.connected);
  els.siteText.textContent = config.tesla.energySiteId || 'Not selected';
  renderScheduleSwitcher();
  renderMonths();
  renderSchedule();
}

function ensureSchedules() {
  if (!Array.isArray(config.schedules) || config.schedules.length === 0) {
    config.schedules = [
      {
        id: 'summer',
        name: 'Summer',
        activeMonths: config.activeMonths || [6, 7, 8, 9],
        schedule: config.schedule || []
      },
      {
        id: 'winter',
        name: 'Winter',
        activeMonths: [1, 2, 3, 4, 5, 10, 11, 12],
        schedule: []
      }
    ];
  }
  if (!config.activeScheduleId) config.activeScheduleId = config.schedules[0].id;
  if (!selectedScheduleId || !config.schedules.some(schedule => schedule.id === selectedScheduleId)) {
    selectedScheduleId = config.activeScheduleId;
  }
}

function renderScheduleSwitcher() {
  els.scheduleSwitcher.replaceChildren();
  config.schedules.forEach(schedule => {
    const item = document.createElement('div');
    item.className = `schedule-card${schedule.id === selectedScheduleId ? ' selected' : ''}${schedule.id === config.activeScheduleId ? ' active' : ''}`;

    const main = document.createElement('div');
    main.className = 'schedule-select';
    main.addEventListener('click', () => {
      selectedScheduleId = schedule.id;
      render();
    });

    const title = document.createElement('input');
    title.value = schedule.name;
    title.addEventListener('input', () => {
      schedule.name = title.value || schedule.id;
      updateSeasonText();
    });
    title.addEventListener('click', event => event.stopPropagation());

    const meta = document.createElement('span');
    meta.textContent = schedule.id === config.activeScheduleId ? 'Active now' : 'Inactive';
    main.append(title, meta);

    const activate = document.createElement('button');
    activate.type = 'button';
    activate.textContent = schedule.id === config.activeScheduleId ? 'Active' : 'Activate';
    activate.className = schedule.id === config.activeScheduleId ? 'primary' : '';
    activate.disabled = schedule.id === config.activeScheduleId;
    activate.addEventListener('click', async () => {
      await runWithFeedback({
        buttons: [activate],
        pendingText: 'Activating...',
        successText: 'Active',
        statusEl: els.operationStatus,
        pendingMessage: `Activating ${schedule.name}...`,
        successMessage: `${schedule.name} is now active.`,
        task: async () => {
          config.activeScheduleId = schedule.id;
          selectedScheduleId = schedule.id;
          config = await api('/api/config', { method: 'POST', body: collectConfig() });
          render();
          await refreshStatus();
        }
      });
    });

    item.append(main, activate);
    els.scheduleSwitcher.append(item);
  });
  updateSeasonText();
}

function renderMonths() {
  const schedule = selectedSchedule();
  els.months.replaceChildren();
  monthNames.forEach((name, index) => {
    const month = index + 1;
    const label = document.createElement('label');
    label.className = 'month-chip';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = schedule.activeMonths.includes(month);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        schedule.activeMonths = [...new Set([...schedule.activeMonths, month])].sort((a, b) => a - b);
      } else {
        schedule.activeMonths = schedule.activeMonths.filter(item => item !== month);
      }
      updateSeasonText();
    });
    label.append(checkbox, name);
    els.months.append(label);
  });
  updateSeasonText();
}

function updateSeasonText() {
  const active = activeSchedule();
  els.seasonText.textContent = `${active.name}: ${formatMonths(active.activeMonths)}`;
}

function formatMonths(months) {
  return months.map(month => monthNames[month - 1]).join(', ') || 'No months enabled';
}

function renderSchedule() {
  const schedule = selectedSchedule();
  els.scheduleRows.replaceChildren();
  schedule.schedule
    .sort((a, b) => a.time.localeCompare(b.time))
    .forEach(row => {
      const fragment = els.rowTemplate.content.cloneNode(true);
      const tr = fragment.querySelector('tr');
      tr.dataset.id = row.id;

      bindInput(tr, '.enabled', row, 'enabled', 'checked');
      bindInput(tr, '.time', row, 'time', 'value');
      bindInput(tr, '.reserve', row, 'backupReservePercent', 'number');
      bindInput(tr, '.mode', row, 'operationModeApi', 'value', value => {
        row.operationMode = value === 'self_consumption' ? 'Self-Powered' : 'Time-Based Control';
      });
      bindInput(tr, '.exports', row, 'energyExportsApi', 'value', value => {
        row.energyExports = value === 'battery_ok' ? 'Everything' : value === 'never' ? 'None' : 'Solar Only';
      });
      bindInput(tr, '.gridCharging', row, 'gridCharging', 'checked');
      bindInput(tr, '.purpose', row, 'purpose', 'value');

      tr.querySelector('.dryRun').addEventListener('click', () => runRow(row.id, true, tr));
      tr.querySelector('.runNow').addEventListener('click', () => runRow(row.id, false, tr));
      tr.querySelector('.remove').addEventListener('click', () => {
        schedule.schedule = schedule.schedule.filter(item => item.id !== row.id);
        renderSchedule();
      });

      els.scheduleRows.append(fragment);
    });
}

function bindInput(root, selector, row, key, mode, afterChange) {
  const input = root.querySelector(selector);
  if (mode === 'checked') input.checked = Boolean(row[key]);
  else input.value = row[key] ?? '';
  input.addEventListener('input', () => {
    if (mode === 'checked') row[key] = input.checked;
    else if (mode === 'number') row[key] = Number(input.value);
    else row[key] = input.value;
    afterChange?.(row[key]);
  });
}

function collectConfig() {
  const active = activeSchedule();
  return {
    timezone: config.timezone || 'America/Los_Angeles',
    activeScheduleId: config.activeScheduleId,
    activeMonths: active.activeMonths,
    schedules: config.schedules,
    tesla: {
      region: els.region.value,
      clientId: els.clientId.value.trim(),
      clientSecret: els.clientSecret.value.trim(),
      redirectUri: els.redirectUri.value.trim(),
      energySiteId: els.energySiteId.value.trim()
    },
    schedule: active.schedule
  };
}

async function runRow(id, dryRun, rowEl) {
  const dryRunButton = rowEl.querySelector('.dryRun');
  const runNowButton = rowEl.querySelector('.runNow');
  const rowStatus = rowEl.querySelector('.row-status');
  await runWithFeedback({
    buttons: [dryRunButton, runNowButton],
    activeButton: dryRun ? dryRunButton : runNowButton,
    pendingText: dryRun ? 'Checking...' : 'Running...',
    successText: dryRun ? 'Dry Run' : 'Run Now',
    statusEl: rowStatus,
    pendingMessage: dryRun ? 'Building Tesla payload...' : 'Sending commands to Tesla...',
    successMessage: dryRun ? 'Dry run complete.' : 'Run complete.',
    task: async () => {
      await api('/api/config', { method: 'POST', body: collectConfig() });
      const result = await api(`/api/run/${encodeURIComponent(id)}?dryRun=${dryRun ? '1' : '0'}&scheduleId=${encodeURIComponent(selectedScheduleId)}`, { method: 'POST' });
      els.logOutput.textContent = JSON.stringify(result, null, 2);
      await refreshStatus();
    }
  });
}

async function refreshStatus() {
  await runWithFeedback({
    buttons: [els.refreshStatus],
    pendingText: 'Refreshing...',
    successText: 'Refresh',
    statusEl: els.operationStatus,
    pendingMessage: '',
    successMessage: '',
    quiet: true,
    task: async () => {
      const status = await api('/api/status');
      els.nextRunText.textContent = status.nextRun || '--';
      els.logOutput.textContent = status.logs
        .map(entry => `${entry.ts} ${entry.level.toUpperCase()} ${entry.event}\n${JSON.stringify(entry.details, null, 2)}`)
        .join('\n\n') || 'No activity yet.';
    }
  });
}

function selectedSchedule() {
  return config.schedules.find(schedule => schedule.id === selectedScheduleId) || activeSchedule();
}

function activeSchedule() {
  return config.schedules.find(schedule => schedule.id === config.activeScheduleId) || config.schedules[0];
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function runWithFeedback({ buttons, activeButton, pendingText, successText, statusEl, pendingMessage, successMessage, task, quiet = false }) {
  const targetButton = activeButton || buttons[0];
  const originalText = targetButton?.textContent;
  const originalSuccessText = successText || originalText;
  setButtonsDisabled(buttons, true);
  if (targetButton && pendingText) targetButton.textContent = pendingText;
  if (statusEl && pendingMessage) setStatus(statusEl, pendingMessage, 'pending');

  try {
    await task();
    if (targetButton && originalSuccessText) targetButton.textContent = originalSuccessText;
    if (statusEl && successMessage) setStatus(statusEl, successMessage, 'success');
    if (statusEl && !quiet) clearStatusLater(statusEl);
  } catch (error) {
    if (targetButton && originalText) targetButton.textContent = originalText;
    if (statusEl) setStatus(statusEl, error.message, 'error');
  } finally {
    setButtonsDisabled(buttons, false);
  }
}

function setButtonsDisabled(buttons, disabled) {
  buttons.filter(Boolean).forEach(button => {
    button.disabled = disabled;
    button.classList.toggle('busy', disabled);
  });
}

function setStatus(element, message, state) {
  element.textContent = message;
  element.classList.remove('pending', 'success', 'error');
  element.classList.add(state);
}

function clearStatusLater(element) {
  const message = element.textContent;
  window.setTimeout(() => {
    if (element.textContent === message) {
      element.textContent = '';
      element.classList.remove('pending', 'success', 'error');
    }
  }, 4000);
}
