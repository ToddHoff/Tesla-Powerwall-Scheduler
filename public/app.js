let config;
let selectedScheduleId;
let latestReport;

const els = {
  viewButtons: [...document.querySelectorAll('.app-tabs button')],
  schedulesView: document.querySelector('#schedulesView'),
  reportsView: document.querySelector('#reportsView'),
  activityView: document.querySelector('#activityView'),
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
  scheduleRows: document.querySelector('#scheduleRows'),
  rowTemplate: document.querySelector('#rowTemplate'),
  addRow: document.querySelector('#addRow'),
  copyShareText: document.querySelector('#copyShareText'),
  shareText: document.querySelector('#shareText'),
  shareStatus: document.querySelector('#shareStatus'),
  runNetBillingReport: document.querySelector('#runNetBillingReport'),
  reportStartDate: document.querySelector('#reportStartDate'),
  reportEndDate: document.querySelector('#reportEndDate'),
  reportTimeZone: document.querySelector('#reportTimeZone'),
  reportStatus: document.querySelector('#reportStatus'),
  reportSummary: document.querySelector('#reportSummary'),
  bucketRows: document.querySelector('#bucketRows'),
  hourlyRows: document.querySelector('#hourlyRows'),
  reportRows: document.querySelector('#reportRows'),
  reportText: document.querySelector('#reportText'),
  copyReportText: document.querySelector('#copyReportText'),
  refreshStatus: document.querySelector('#refreshStatus'),
  logOutput: document.querySelector('#logOutput')
};

initReportDates();
await load();

els.viewButtons.forEach(button => {
  button.addEventListener('click', () => setView(button.dataset.view));
});

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

els.runNetBillingReport.addEventListener('click', runNetBillingReport);

els.copyReportText.addEventListener('click', async () => {
  await runWithFeedback({
    buttons: [els.copyReportText],
    pendingText: 'Copying...',
    successText: 'Copy',
    statusEl: els.reportStatus,
    pendingMessage: 'Copying report...',
    successMessage: 'Copied report.',
    task: async () => copyText(els.reportText.value)
  });
});

els.copyShareText.addEventListener('click', async () => {
  await runWithFeedback({
    buttons: [els.copyShareText],
    pendingText: 'Copying...',
    successText: 'Copy',
    statusEl: els.shareStatus,
    pendingMessage: 'Copying summary...',
    successMessage: 'Copied summary.',
    task: async () => {
      await copyText(els.shareText.value);
    }
  });
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
  els.reportTimeZone.value = config.timezone || 'America/Los_Angeles';
  render();
  await refreshStatus();
}

function setView(view) {
  const selected = view || 'schedules';
  els.viewButtons.forEach(button => button.classList.toggle('active', button.dataset.view === selected));
  els.schedulesView.classList.toggle('hidden', selected !== 'schedules');
  els.reportsView.classList.toggle('hidden', selected !== 'reports');
  els.activityView.classList.toggle('hidden', selected !== 'activity');
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
  renderSchedule();
  renderShareText();
}

function ensureSchedules() {
  if (!Array.isArray(config.schedules) || config.schedules.length === 0) {
    config.schedules = [
      {
        id: 'summer',
        name: 'Summer',
        schedule: config.schedule || []
      },
      {
        id: 'winter',
        name: 'Winter',
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
      renderShareText();
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

function updateSeasonText() {
  const active = activeSchedule();
  els.seasonText.textContent = active.name;
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
        renderShareText();
      });

      els.scheduleRows.append(fragment);
    });
  renderShareText();
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
    renderShareText();
  });
}

function collectConfig() {
  const active = activeSchedule();
  return {
    timezone: config.timezone || 'America/Los_Angeles',
    activeScheduleId: config.activeScheduleId,
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

function renderShareText() {
  const schedule = selectedSchedule();
  const activeText = schedule.id === config.activeScheduleId ? 'Yes' : 'No';
  const lines = [
    `${schedule.name} Tesla Powerwall Schedule`,
    `Active: ${activeText}`,
    `Timezone: ${config.timezone || 'America/Los_Angeles'}`,
    ''
  ];

  const rows = [...schedule.schedule].sort((a, b) => a.time.localeCompare(b.time));
  rows.forEach(row => {
    lines.push(formatTime(row.time));
    lines.push(`  Enabled: ${row.enabled ? 'Yes' : 'No'}`);
    lines.push(`  Backup Reserve: ${row.backupReservePercent}%`);
    lines.push(`  Operational Mode: ${row.operationMode || modeLabel(row.operationModeApi)}`);
    lines.push(`  Energy Exports: ${row.energyExports || exportLabel(row.energyExportsApi)}`);
    lines.push(`  Grid Charging: ${row.gridCharging ? 'Enabled' : 'Disabled'}`);
    if (row.purpose?.trim()) lines.push(`  Purpose: ${row.purpose.trim()}`);
    lines.push('');
  });

  els.shareText.value = lines.join('\n').trimEnd();
}

async function runNetBillingReport() {
  await runWithFeedback({
    buttons: [els.runNetBillingReport],
    pendingText: 'Running...',
    successText: 'Run Report',
    statusEl: els.reportStatus,
    pendingMessage: 'Fetching Tesla energy history...',
    successMessage: 'Report complete.',
    task: async () => {
      const params = new URLSearchParams({
        startDate: els.reportStartDate.value,
        endDate: els.reportEndDate.value,
        timeZone: els.reportTimeZone.value.trim() || 'America/Los_Angeles'
      });
      latestReport = await api(`/api/reports/net-billing?${params}`);
      renderReport(latestReport);
    }
  });
}

function renderReport(report) {
  els.reportSummary.replaceChildren();
  const summaryItems = [
    ['Imported', `${formatKwh(report.totals.importedKwh)} kWh`],
    ['Exported', `${formatKwh(report.totals.exportedKwh)} kWh`],
    ['Net Balance', `${formatSignedKwh(report.totals.netKwh)} kWh`],
    ['Battery Export', `${formatKwh(report.totals.batteryExportedKwh)} kWh`]
  ];
  summaryItems.forEach(([label, value]) => {
    const item = document.createElement('div');
    item.className = 'report-metric';
    const span = document.createElement('span');
    span.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    item.append(span, strong);
    els.reportSummary.append(item);
  });

  els.reportRows.replaceChildren();
  renderReportTable(els.bucketRows, report.buckets || [], bucket => [
    bucket.label,
    bucket.window,
    formatKwh(bucket.importedKwh),
    formatKwh(bucket.exportedKwh),
    formatSignedKwh(bucket.netKwh),
    formatKwh(bucket.batteryExportedKwh),
    formatKwh(bucket.solarExportedKwh),
    formatKwh(bucket.batteryImportedFromGridKwh),
    formatKwh(bucket.consumerImportedFromGridKwh)
  ]);

  renderReportTable(els.hourlyRows, report.hourly || [], hour => [
    formatHourLabel(hour.hour),
    String(hour.intervalCount || 0),
    formatKwh(hour.importedKwh),
    formatKwh(hour.exportedKwh),
    formatSignedKwh(hour.netKwh),
    formatKwh(hour.batteryExportedKwh),
    formatKwh(hour.solarExportedKwh),
    formatKwh(hour.batteryImportedFromGridKwh),
    formatKwh(hour.consumerImportedFromGridKwh)
  ]);

  els.reportRows.replaceChildren();
  report.days.forEach(day => {
    const tr = document.createElement('tr');
    [
      day.date,
      String(day.intervalCount || 0),
      formatKwh(day.importedKwh),
      formatKwh(day.exportedKwh),
      formatSignedKwh(day.netKwh),
      formatKwh(day.batteryExportedKwh),
      formatKwh(day.solarExportedKwh),
      formatKwh(day.batteryImportedFromGridKwh),
      formatKwh(day.consumerImportedFromGridKwh)
    ].forEach(value => {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    });
    els.reportRows.append(tr);
  });

  els.reportText.value = formatReportText(report);
}

function renderReportTable(tbody, rows, cellsForRow) {
  tbody.replaceChildren();
  rows.forEach(row => {
    const tr = document.createElement('tr');
    cellsForRow(row).forEach(value => {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    });
    tbody.append(tr);
  });
}

function formatReportText(report) {
  const lines = [
    `Tesla Net Billing Audit`,
    `Site: ${report.siteId}`,
    `Range: ${report.startDate} to ${report.endDate}`,
    `Timezone: ${report.timeZone}`,
    '',
    `Totals`,
    `  Grid Imported: ${formatKwh(report.totals.importedKwh)} kWh`,
    `  Grid Exported: ${formatKwh(report.totals.exportedKwh)} kWh`,
    `  Net Balance: ${formatSignedKwh(report.totals.netKwh)} kWh`,
    `  Battery Export: ${formatKwh(report.totals.batteryExportedKwh)} kWh`,
    `  Solar Export: ${formatKwh(report.totals.solarExportedKwh)} kWh`,
    '',
    `Time Windows`,
    `Window              | Time        | Imported | Exported | Net     | Battery Export`
  ];

  (report.buckets || []).forEach(bucket => {
    lines.push(`${padEnd(bucket.label, 19)} | ${padEnd(bucket.window, 11)} | ${pad(formatKwh(bucket.importedKwh), 8)} | ${pad(formatKwh(bucket.exportedKwh), 8)} | ${pad(formatSignedKwh(bucket.netKwh), 7)} | ${pad(formatKwh(bucket.batteryExportedKwh), 14)}`);
  });

  lines.push(
    '',
    `Hourly Detail`,
    `Hour              | Imported | Exported | Net     | Battery Export | Solar Export`
  );

  (report.hourly || []).forEach(hour => {
    lines.push(`${padEnd(formatHourLabel(hour.hour), 17)} | ${pad(formatKwh(hour.importedKwh), 8)} | ${pad(formatKwh(hour.exportedKwh), 8)} | ${pad(formatSignedKwh(hour.netKwh), 7)} | ${pad(formatKwh(hour.batteryExportedKwh), 14)} | ${formatKwh(hour.solarExportedKwh)}`);
  });

  lines.push(
    '',
    `Daily Detail`,
    `Date        | Intervals | Imported | Exported | Net     | Battery Export | Solar Export`
  );

  report.days.forEach(day => {
    lines.push(`${day.date}  | ${pad(day.intervalCount || 0, 9)} | ${pad(formatKwh(day.importedKwh), 8)} | ${pad(formatKwh(day.exportedKwh), 8)} | ${pad(formatSignedKwh(day.netKwh), 7)} | ${pad(formatKwh(day.batteryExportedKwh), 14)} | ${formatKwh(day.solarExportedKwh)}`);
  });

  return lines.join('\n');
}

function initReportDates() {
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 6);
  els.reportStartDate.value = dateInputValue(start);
  els.reportEndDate.value = dateInputValue(today);
}

function dateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatKwh(value) {
  return Number(value || 0).toFixed(2);
}

function formatSignedKwh(value) {
  const numeric = Number(value || 0);
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(2)}`;
}

function pad(value, length) {
  return String(value).padStart(length, ' ');
}

function padEnd(value, length) {
  return String(value).padEnd(length, ' ');
}

function formatHourLabel(hour) {
  if (!hour) return '';
  const date = hour.slice(0, 10);
  const hourText = hour.slice(11, 13);
  return `${date} ${formatTime(`${hourText}:00`)}`;
}

function formatTime(hhmm) {
  const [hourText, minuteText] = String(hhmm || '00:00').split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return hhmm || '--:--';
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function modeLabel(api) {
  return api === 'self_consumption' ? 'Self-Powered' : 'Time-Based Control';
}

function exportLabel(api) {
  if (api === 'battery_ok') return 'Everything';
  if (api === 'never') return 'None';
  return 'Solar Only';
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  els.shareText.focus();
  els.shareText.select();
  document.execCommand('copy');
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
