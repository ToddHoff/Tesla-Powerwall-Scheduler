let config;
let selectedScheduleId;
let latestReport;
let logOrder = 'desc';
let lastLogs = [];
let logSourceFilter = 'all';
let settingsFetched = false;
let lastSettings = null;
let ratesFetched = false;
let ratesDraft = null;       // current editable draft
let ratesTeslaFallback = null;

const els = {
  viewButtons: [...document.querySelectorAll('.app-tabs button')],
  schedulesView: document.querySelector('#schedulesView'),
  netBillingView: document.querySelector('#netBillingView'),
  touCostView: document.querySelector('#touCostView'),
  settingsView: document.querySelector('#settingsView'),
  ratesView: document.querySelector('#ratesView'),
  activityView: document.querySelector('#activityView'),
  ratesEnabled: document.querySelector('#ratesEnabled'),
  ratesSave: document.querySelector('#ratesSave'),
  ratesStatus: document.querySelector('#ratesStatus'),
  ratesValidation: document.querySelector('#ratesValidation'),
  ratesSeasons: document.querySelector('#ratesSeasons'),
  ratesSourceTag: document.querySelector('#ratesSourceTag'),
  settingsRefresh: document.querySelector('#settingsRefresh'),
  settingsFetchedAt: document.querySelector('#settingsFetchedAt'),
  settingsError: document.querySelector('#settingsError'),
  settingsManaged: document.querySelector('#settingsManaged'),
  settingsLive: document.querySelector('#settingsLive'),
  settingsRawSiteInfo: document.querySelector('#settingsRawSiteInfo'),
  settingsRawLive: document.querySelector('#settingsRawLive'),
  settingsRatePlan: document.querySelector('#settingsRatePlan'),
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
  runTouReport: document.querySelector('#runTouReport'),
  touStartDate: document.querySelector('#touStartDate'),
  touEndDate: document.querySelector('#touEndDate'),
  touTimeZone: document.querySelector('#touTimeZone'),
  touStatus: document.querySelector('#touStatus'),
  touSummary: document.querySelector('#touSummary'),
  touTariffNote: document.querySelector('#touTariffNote'),
  touRatePlan: document.querySelector('#touRatePlan'),
  touCostRows: document.querySelector('#touCostRows'),
  touCostTotals: document.querySelector('#touCostTotals'),
  touAuditRows: document.querySelector('#touAuditRows'),
  touReportText: document.querySelector('#touReportText'),
  copyTouReportText: document.querySelector('#copyTouReportText'),
  refreshStatus: document.querySelector('#refreshStatus'),
  logOrderToggle: document.querySelector('#logOrderToggle'),
  logSourceFilter: document.querySelector('#logSourceFilter'),
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
    pendingMessage: 'Saving configuration and reloading launchd jobs...',
    task: async () => {
      config = collectConfig();
      const saved = await api('/api/config', { method: 'POST', body: config });
      const { launchd, ...nextConfig } = saved;
      config = nextConfig;
      selectedScheduleId = selectedScheduleId || config.activeScheduleId;
      render();
      await refreshStatus();
      const summary = summarizeLaunchd(launchd);
      setStatus(els.operationStatus, `Configuration saved. ${summary}`, launchd?.ok === false ? 'error' : 'success');
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
els.runTouReport.addEventListener('click', runTouReport);

els.copyTouReportText.addEventListener('click', async () => {
  await runWithFeedback({
    buttons: [els.copyTouReportText],
    pendingText: 'Copying...',
    successText: 'Copy',
    statusEl: els.touStatus,
    pendingMessage: 'Copying report...',
    successMessage: 'Copied report.',
    task: async () => copyText(els.touReportText.value)
  });
});

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

els.logOrderToggle.addEventListener('click', () => {
  logOrder = logOrder === 'desc' ? 'asc' : 'desc';
  updateLogOrderToggle();
  renderLogs();
});
updateLogOrderToggle();

els.logSourceFilter.addEventListener('change', () => {
  logSourceFilter = els.logSourceFilter.value || 'all';
  renderLogs();
});

els.settingsRefresh.addEventListener('click', refreshSettings);

async function refreshSettings() {
  await runWithFeedback({
    buttons: [els.settingsRefresh],
    pendingText: 'Loading...',
    successText: 'Refresh',
    statusEl: els.settingsError,
    pendingMessage: '',
    successMessage: '',
    task: async () => {
      const [live, rates] = await Promise.all([
        api('/api/live-status'),
        api('/api/rates')
      ]);
      lastSettings = { ...live, fetchedAt: new Date(), ratePlan: rates?.effective || null };
      settingsFetched = true;
      renderSettings();
    }
  });
}

function renderSettings() {
  if (!lastSettings) return;
  const siteInfo = lastSettings.siteInfo?.response || {};
  const components = siteInfo.components || {};
  const live = lastSettings.live?.response || {};

  els.settingsFetchedAt.textContent = `Fetched ${formatClockTime(lastSettings.fetchedAt)}`;

  setManagedRows([
    ['Backup reserve', formatPercent(siteInfo.backup_reserve_percent)],
    ['Operation mode', formatOperationMode(siteInfo.default_real_mode)],
    ['Energy exports', formatExportRule(components.customer_preferred_export_rule)],
    ['Grid charging from solar-installed', formatGridChargingAllowed(components.disallow_charge_from_grid_with_solar_installed)]
  ]);

  setManagedRows([
    ['Charge level', formatPercent(live.percentage_charged)],
    ['Battery power', formatPower(live.battery_power)],
    ['Solar power', formatPower(live.solar_power)],
    ['Load power', formatPower(live.load_power)],
    ['Grid power', formatPower(live.grid_power)],
    ['Grid status', formatStringOrDash(live.grid_status)],
    ['Island status', formatStringOrDash(live.island_status)],
    ['Reported at', formatTimestamp(live.timestamp)]
  ], els.settingsLive);

  renderRatePlanCard(els.settingsRatePlan, lastSettings.ratePlan, new Date());

  els.settingsRawSiteInfo.textContent = JSON.stringify(lastSettings.siteInfo, null, 2);
  els.settingsRawLive.textContent = JSON.stringify(lastSettings.live, null, 2);
}

function setManagedRows(rows, target = els.settingsManaged) {
  target.replaceChildren();
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    target.append(dt, dd);
  }
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${Math.round(Number(value) * 10) / 10}%`;
}

function formatPower(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${Math.round(Number(value))} W`;
}

function formatOperationMode(api) {
  if (!api) return '—';
  const label = api === 'self_consumption' ? 'Self-Powered' : api === 'autonomous' ? 'Time-Based Control' : api;
  return `${label} (${api})`;
}

function formatExportRule(api) {
  if (!api) return '—';
  const label = api === 'battery_ok' ? 'Everything' : api === 'never' ? 'None' : api === 'pv_only' ? 'Solar Only' : api;
  return `${label} (${api})`;
}

function formatGridChargingAllowed(disallow) {
  if (disallow === null || disallow === undefined) return '—';
  return disallow ? 'Disallowed (disallow_charge_from_grid_with_solar_installed = true)' : 'Allowed (disallow_charge_from_grid_with_solar_installed = false)';
}

function formatStringOrDash(value) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function formatTimestamp(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function formatClockTime(date) {
  if (!(date instanceof Date)) return '';
  return date.toLocaleTimeString();
}

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
  els.netBillingView.classList.toggle('hidden', selected !== 'net-billing');
  els.touCostView.classList.toggle('hidden', selected !== 'tou-cost');
  els.settingsView.classList.toggle('hidden', selected !== 'settings');
  els.ratesView.classList.toggle('hidden', selected !== 'rates');
  els.activityView.classList.toggle('hidden', selected !== 'activity');
  if (selected === 'settings' && !settingsFetched) refreshSettings();
  if (selected === 'rates' && !ratesFetched) loadRates();
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
        pendingMessage: `Activating ${schedule.name} and reloading launchd jobs...`,
        task: async () => {
          config.activeScheduleId = schedule.id;
          selectedScheduleId = schedule.id;
          const saved = await api('/api/config', { method: 'POST', body: collectConfig() });
          const { launchd, ...nextConfig } = saved;
          config = nextConfig;
          render();
          await refreshStatus();
          const summary = summarizeLaunchd(launchd);
          setStatus(els.operationStatus, `${schedule.name} is now active. ${summary}`, launchd?.ok === false ? 'error' : 'success');
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
      lastLogs = Array.isArray(status.logs) ? status.logs : [];
      refreshLogSourceFilter();
      renderLogs();
    }
  });
}

function refreshLogSourceFilter() {
  const sources = new Set();
  // Seed with enabled steps from the active schedule so dropdown lists every
  // step even before it has fired for the first time.
  const active = config?.schedules?.find(s => s.id === config.activeScheduleId);
  for (const row of active?.schedule || []) {
    if (row?.enabled && row.time) sources.add(`step ${row.time}`);
  }
  // Add any sources that have actually logged (covers disabled-then-fired
  // steps, server entries, and anything else on disk).
  for (const entry of lastLogs) {
    if (entry?.source) sources.add(entry.source);
  }
  const ordered = [...sources].sort((a, b) => {
    if (a === 'server') return -1;
    if (b === 'server') return 1;
    return a.localeCompare(b);
  });
  const previous = els.logSourceFilter.value || logSourceFilter;
  els.logSourceFilter.replaceChildren();
  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = `All (${lastLogs.length})`;
  els.logSourceFilter.append(allOpt);
  for (const source of ordered) {
    const opt = document.createElement('option');
    opt.value = source;
    const count = lastLogs.filter(e => e.source === source).length;
    opt.textContent = `${source} (${count})`;
    els.logSourceFilter.append(opt);
  }
  // Keep prior selection if still available.
  const available = ['all', ...ordered];
  logSourceFilter = available.includes(previous) ? previous : 'all';
  els.logSourceFilter.value = logSourceFilter;
}

function renderLogs() {
  if (!lastLogs.length) {
    els.logOutput.textContent = 'No activity yet.';
    return;
  }
  const filtered = logSourceFilter === 'all'
    ? lastLogs
    : lastLogs.filter(e => e.source === logSourceFilter);
  if (!filtered.length) {
    els.logOutput.textContent = `No entries for source "${logSourceFilter}".`;
    return;
  }
  const ordered = logOrder === 'desc' ? [...filtered].reverse() : filtered;
  els.logOutput.textContent = ordered
    .map(entry => {
      const source = entry.source ? `[${entry.source}] ` : '';
      return `${entry.ts} ${source}${(entry.level || 'info').toUpperCase()} ${entry.event}\n${JSON.stringify(entry.details, null, 2)}`;
    })
    .join('\n\n');
}

function updateLogOrderToggle() {
  if (!els.logOrderToggle) return;
  els.logOrderToggle.textContent = logOrder === 'desc' ? 'Newest first' : 'Oldest first';
  els.logOrderToggle.title = logOrder === 'desc'
    ? 'Showing newest first — click for oldest first'
    : 'Showing oldest first — click for newest first';
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

async function runTouReport() {
  await runWithFeedback({
    buttons: [els.runTouReport],
    pendingText: 'Running...',
    successText: 'Run Report',
    statusEl: els.touStatus,
    pendingMessage: 'Fetching energy history and applying PG&E rates...',
    successMessage: 'Report complete.',
    task: async () => {
      const params = new URLSearchParams({
        startDate: els.touStartDate.value,
        endDate: els.touEndDate.value,
        timeZone: els.touTimeZone.value.trim() || 'America/Los_Angeles'
      });
      const report = await api(`/api/reports/tou-cost?${params}`);
      renderTouReport(report);
    }
  });
}

function renderTouReport(report) {
  els.touSummary.replaceChildren();
  const totals = report.totals || {};
  const summary = [
    ['Net Cost', formatCurrency(totals.netCost)],
    ['Import Cost', formatCurrency(totals.importCost)],
    ['Export Credit', formatCurrency(totals.exportCredit)],
    ['Peak Import kWh', formatKwh(totals.peakImportKwh)],
    ['Peak Import Cost', formatCurrency(totals.peakImportCost)],
    ['% Peak Load From Battery', totals.peakAudit?.percentLoadFromBattery == null ? '—' : `${totals.peakAudit.percentLoadFromBattery}%`]
  ];
  for (const [label, value] of summary) {
    const item = document.createElement('div');
    item.className = 'report-metric';
    const s = document.createElement('span'); s.textContent = label;
    const v = document.createElement('strong'); v.textContent = value;
    item.append(s, v);
    els.touSummary.append(item);
  }

  const tariffSource = report.tariff?.source || 'tesla';
  const sourceLabel = tariffSource === 'custom' ? 'custom override' : (report.tariff?.code || 'tesla tariff');
  els.touTariffNote.textContent = report.tariff
    ? `Rate plan source: ${sourceLabel}. ${tariffSource === 'tesla' ? 'Sell rate from sell_tariff; NEM 3.0 actual export values may differ.' : 'Sell rates from your custom configuration.'}`
    : '';

  renderRatePlanCard(els.touRatePlan, report.tariff, null);

  els.touCostRows.replaceChildren();
  for (const day of report.days || []) {
    const off = findPeriodByMatcher(day.periods, isClientOffPeak);
    const partial = findPeriodByMatcher(day.periods, isClientPartialPeak);
    const peak = findPeriodByMatcher(day.periods, isClientPeak);
    const tr = document.createElement('tr');
    appendCells(tr, [
      day.date,
      day.seasonLabel || '',
      formatKwh(off.importedKwh),
      formatCurrency(off.importCost),
      partial ? formatKwh(partial.importedKwh) : '—',
      partial ? formatCurrency(partial.importCost) : '—',
      formatKwh(peak.importedKwh),
      formatCurrency(peak.importCost),
      formatCurrency(day.exportCredit),
      formatCurrency(day.netCost)
    ]);
    els.touCostRows.append(tr);
  }

  els.touCostTotals.replaceChildren();
  if (report.days?.length) {
    const tr = document.createElement('tr');
    tr.className = 'totals-row';
    const totalsByName = report.totals?.periodTotals || {};
    const off = sumPeriodTotalsByMatcher(totalsByName, isClientOffPeak);
    const partial = sumPeriodTotalsByMatcher(totalsByName, isClientPartialPeak);
    const peak = sumPeriodTotalsByMatcher(totalsByName, isClientPeak);
    const hasPartial = Object.keys(totalsByName).some(n => isClientPartialPeak(n));
    appendCells(tr, [
      'Totals',
      '',
      formatKwh(off.importedKwh),
      formatCurrency(off.importCost),
      hasPartial ? formatKwh(partial.importedKwh) : '—',
      hasPartial ? formatCurrency(partial.importCost) : '—',
      formatKwh(peak.importedKwh),
      formatCurrency(peak.importCost),
      formatCurrency(report.totals?.exportCredit ?? 0),
      formatCurrency(report.totals?.netCost ?? 0)
    ]);
    els.touCostTotals.append(tr);
  }

  els.touAuditRows.replaceChildren();
  for (const day of report.days || []) {
    const audit = day.peakAudit || {};
    const tr = document.createElement('tr');
    if (day.peakImportKwh > 0.1) tr.classList.add('peak-import-flag');
    appendCells(tr, [
      day.date,
      formatKwh(day.peakImportKwh),
      formatCurrency(day.peakImportCost),
      audit.soeAtPeakStart == null ? '—' : `${audit.soeAtPeakStart}%`,
      audit.soeMinDuringPeak == null ? '—' : `${audit.soeMinDuringPeak}%`,
      audit.soeAtPeakEnd == null ? '—' : `${audit.soeAtPeakEnd}%`,
      audit.percentLoadFromBattery == null ? '—' : `${audit.percentLoadFromBattery}%`,
      formatKwh(day.peakExportKwh)
    ]);
    els.touAuditRows.append(tr);
  }

  els.touReportText.value = formatTouReportText(report);
}

function formatTouReportText(report) {
  const totals = report.totals || {};
  const peakDays = (report.days || []).filter(d => d.peakImportKwh > 0.1);
  const totalsByName = report.totals?.periodTotals || {};
  const offTotal = sumPeriodTotalsByMatcher(totalsByName, isClientOffPeak);
  const partialTotal = sumPeriodTotalsByMatcher(totalsByName, isClientPartialPeak);
  const peakTotal = sumPeriodTotalsByMatcher(totalsByName, isClientPeak);
  const hasPartial = Object.keys(totalsByName).some(n => isClientPartialPeak(n));
  const tariffLabel = report.tariff?.code || '(unknown)';
  const tariffSource = report.tariff?.source || 'tesla';

  const verdict = peakDays.length === 0
    ? `No days had material peak-hour grid imports (> 0.1 kWh). The schedule kept load off the grid during the peak window.`
    : `${peakDays.length} day(s) had measurable peak-hour grid imports (> 0.1 kWh): ${peakDays.map(d => d.date).join(', ')}. ` +
      `On those days the battery did not fully carry the home through the peak window — check whether SOE hit the reserve floor early.`;

  const lines = [
    'Tesla Powerwall — TOU Cost Audit',
    `Site: ${report.siteId}`,
    `Range: ${report.startDate} to ${report.endDate}   (${(report.days || []).length} day(s))`,
    `Timezone: ${report.timeZone}`,
    `Rate plan: ${tariffLabel} — ${report.tariff?.utility || ''} [source: ${tariffSource}]`.trim(),
    '',
    'RATE STRUCTURE'
  ];
  for (const season of report.tariff?.seasons || []) {
    lines.push(`  ${season.label} (${describeSeasonMonths(season)})`);
    for (const period of season.periods || []) {
      const w = period.windows?.[0];
      const window = w ? `${formatMinutesAsTime(w.startMin)}–${formatMinutesAsTime(w.endMin)}` : '—';
      lines.push(`    ${padEnd(period.name, 14)} ${padEnd(window, 13)}  buy $${Number(period.buyRate || 0).toFixed(5)}/kWh   sell $${Number(period.sellRate || 0).toFixed(5)}/kWh`);
    }
  }
  lines.push(
    '',
    'WHAT THIS REPORT SHOWS',
    'Under PG&E TOU-C, electricity is more expensive 4–9 PM every day ("Peak")',
    'and cheaper at all other hours ("Off-Peak"). The scheduler keeps the Powerwall',
    'topped up during off-peak so the battery — not the grid — serves the home',
    'during peak. This report measures whether that strategy is actually working,',
    'in dollars.',
    '',
    'WHAT TO LOOK FOR',
    '  1. "Peak Import $" should be near $0. Any meaningful peak-hour grid import',
    '     means the battery ran out, the schedule didn\'t apply, or load exceeded',
    '     what the system could cover. Days above 0.1 kWh are flagged in the UI.',
    '  2. "SOE @ 9 PM" should be comfortably above the reserve floor (currently',
    '     30% summer / 50% winter). If SOE drops to the floor before 9 PM, the',
    '     battery is undersized for that day\'s load or didn\'t fully recharge',
    '     overnight — bump backup reserve, or check that the midnight grid-charge',
    '     step ran.',
    '  3. "% Load From Battery" during peak hours — higher is better. The',
    '     remainder is typically solar (good) or grid (bad).',
    '',
    'CAVEAT ON EXPORT CREDITS',
    'Export credit uses Tesla\'s flat sell_tariff rate (the rate Tesla has on file),',
    'not the hourly NEM 3.0 / NBT avoided-cost values PG&E actually pays. Real',
    'export credits can be much higher during summer peak hours. Treat the export',
    'number as a conservative floor.',
    '',
    'SUMMARY',
    `  Net cost (period):           ${formatCurrency(totals.netCost)}`,
    `  Import cost:                 ${formatCurrency(totals.importCost)}`,
    `  Export credit:               ${formatCurrency(totals.exportCredit)}`,
    `  Off-peak import:             ${formatKwh(offTotal.importedKwh)} kWh  (${formatCurrency(offTotal.importCost)})`
  );
  if (hasPartial) {
    lines.push(`  Partial-peak import:         ${formatKwh(partialTotal.importedKwh)} kWh  (${formatCurrency(partialTotal.importCost)})`);
  }
  lines.push(
    `  Peak import:                 ${formatKwh(peakTotal.importedKwh)} kWh  (${formatCurrency(peakTotal.importCost)})`,
    `  % peak load from battery:    ${totals.peakAudit?.percentLoadFromBattery == null ? '—' : `${totals.peakAudit.percentLoadFromBattery}%`}`,
    '',
    'VERDICT',
    `  ${verdict}`,
    '',
    'DAILY PG&E COST BY TOU PERIOD',
    hasPartial
      ? `${padEnd('Date', 12)} ${padEnd('Season', 8)} ${pad('Off kWh', 9)} ${pad('Off $', 8)} ${pad('Part kWh', 9)} ${pad('Part $', 8)} ${pad('Peak kWh', 9)} ${pad('Peak $', 8)} ${pad('Export $', 9)} ${pad('Net $', 9)}`
      : `${padEnd('Date', 12)} ${padEnd('Season', 8)} ${pad('Off kWh', 10)} ${pad('Off $', 10)} ${pad('Peak kWh', 10)} ${pad('Peak $', 10)} ${pad('Export $', 10)} ${pad('Net $', 10)}`
  );

  for (const day of report.days || []) {
    const off = findPeriodByMatcher(day.periods, isClientOffPeak);
    const partial = findPeriodByMatcher(day.periods, isClientPartialPeak);
    const peak = findPeriodByMatcher(day.periods, isClientPeak);
    if (hasPartial) {
      lines.push(
        `${padEnd(day.date, 12)} ${padEnd(day.seasonLabel || '', 8)} ${pad(formatKwh(off.importedKwh), 9)} ${pad(formatCurrency(off.importCost), 8)} ${pad(formatKwh(partial.importedKwh), 9)} ${pad(formatCurrency(partial.importCost), 8)} ${pad(formatKwh(peak.importedKwh), 9)} ${pad(formatCurrency(peak.importCost), 8)} ${pad(formatCurrency(day.exportCredit), 9)} ${pad(formatCurrency(day.netCost), 9)}`
      );
    } else {
      lines.push(
        `${padEnd(day.date, 12)} ${padEnd(day.seasonLabel || '', 8)} ${pad(formatKwh(off.importedKwh), 10)} ${pad(formatCurrency(off.importCost), 10)} ${pad(formatKwh(peak.importedKwh), 10)} ${pad(formatCurrency(peak.importCost), 10)} ${pad(formatCurrency(day.exportCredit), 10)} ${pad(formatCurrency(day.netCost), 10)}`
      );
    }
  }
  if (hasPartial) {
    lines.push(
      `${padEnd('TOTALS', 12)} ${padEnd('', 8)} ${pad(formatKwh(offTotal.importedKwh), 9)} ${pad(formatCurrency(offTotal.importCost), 8)} ${pad(formatKwh(partialTotal.importedKwh), 9)} ${pad(formatCurrency(partialTotal.importCost), 8)} ${pad(formatKwh(peakTotal.importedKwh), 9)} ${pad(formatCurrency(peakTotal.importCost), 8)} ${pad(formatCurrency(totals.exportCredit ?? 0), 9)} ${pad(formatCurrency(totals.netCost ?? 0), 9)}`
    );
  } else {
    lines.push(
      `${padEnd('TOTALS', 12)} ${padEnd('', 8)} ${pad(formatKwh(offTotal.importedKwh), 10)} ${pad(formatCurrency(offTotal.importCost), 10)} ${pad(formatKwh(peakTotal.importedKwh), 10)} ${pad(formatCurrency(peakTotal.importCost), 10)} ${pad(formatCurrency(totals.exportCredit ?? 0), 10)} ${pad(formatCurrency(totals.netCost ?? 0), 10)}`
    );
  }

  lines.push(
    '',
    'PEAK WINDOW AUDIT (4–9 PM)',
    `${padEnd('Date', 12)} ${pad('Peak kWh', 9)} ${pad('Peak $', 9)} ${pad('@4PM', 6)} ${pad('Min', 6)} ${pad('@9PM', 6)} ${pad('%BatLoad', 9)} ${pad('Export kWh', 11)}  Flag`
  );
  for (const day of report.days || []) {
    const a = day.peakAudit || {};
    const flag = day.peakImportKwh > 0.1 ? '⚠ peak import' : '';
    lines.push(
      `${padEnd(day.date, 12)} ${pad(formatKwh(day.peakImportKwh), 9)} ${pad(formatCurrency(day.peakImportCost), 9)} ${pad(a.soeAtPeakStart == null ? '—' : `${a.soeAtPeakStart}%`, 6)} ${pad(a.soeMinDuringPeak == null ? '—' : `${a.soeMinDuringPeak}%`, 6)} ${pad(a.soeAtPeakEnd == null ? '—' : `${a.soeAtPeakEnd}%`, 6)} ${pad(a.percentLoadFromBattery == null ? '—' : `${a.percentLoadFromBattery}%`, 9)} ${pad(formatKwh(day.peakExportKwh), 11)}  ${flag}`
    );
  }

  return lines.join('\n');
}

function isClientPeak(name) {
  const n = String(name || '').toLowerCase().replace(/[_\s-]/g, '');
  if (n.includes('partial') || n.includes('mid')) return false;
  if (n.includes('off')) return false;
  return n.includes('peak');
}
function isClientPartialPeak(name) {
  const n = String(name || '').toLowerCase().replace(/[_\s-]/g, '');
  return n.includes('partial') || n.includes('mid');
}
function isClientOffPeak(name) {
  const n = String(name || '').toLowerCase().replace(/[_\s-]/g, '');
  return n.includes('off');
}

function findPeriodByMatcher(periods, matcher) {
  return (periods || []).find(p => matcher(p.period)) || { importedKwh: 0, importCost: 0, exportedKwh: 0, exportCredit: 0 };
}

function sumPeriodTotalsByMatcher(totalsByName, matcher) {
  const out = { importedKwh: 0, importCost: 0, exportedKwh: 0, exportCredit: 0 };
  for (const [name, totals] of Object.entries(totalsByName || {})) {
    if (!matcher(name)) continue;
    out.importedKwh += totals.importedKwh || 0;
    out.importCost += totals.importCost || 0;
    out.exportedKwh += totals.exportedKwh || 0;
    out.exportCredit += totals.exportCredit || 0;
  }
  return out;
}

function renderRatePlanCard(host, plan, currentDate) {
  host.replaceChildren();
  if (!plan) {
    host.textContent = 'No rate plan available.';
    return;
  }
  const heading = document.createElement('h4');
  heading.textContent = plan.name || plan.code || 'Rate Plan';
  const tag = document.createElement('span');
  tag.className = 'rate-source-tag';
  tag.textContent = plan.source === 'custom' ? 'custom' : 'tesla';
  heading.append(tag);
  host.append(heading);

  const now = currentDate || new Date();
  const todayMonth = now.getMonth() + 1;
  const todayDay = now.getDate();
  const todayMinutes = now.getHours() * 60 + now.getMinutes();

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Season</th><th>Months</th><th>Period</th><th>Hours</th><th>Buy $/kWh</th><th>Sell $/kWh</th></tr>';
  table.append(thead);
  const tbody = document.createElement('tbody');

  for (const season of plan.seasons || []) {
    const isCurrentSeason = matchSeason(season, todayMonth, todayDay);
    const monthsText = describeSeasonMonths(season);
    for (const [pi, period] of (season.periods || []).entries()) {
      const tr = document.createElement('tr');
      if (isCurrentSeason) tr.classList.add('current-season');
      const window = period.windows?.[0];
      const inWindow = window && timeInWindowClient(todayMinutes, window.startMin, window.endMin);
      if (isCurrentSeason && inWindow) tr.classList.add('current-period');

      const tdSeason = document.createElement('td');
      if (pi === 0) tdSeason.textContent = season.label;
      tr.append(tdSeason);
      const tdMonths = document.createElement('td');
      if (pi === 0) tdMonths.textContent = monthsText;
      tr.append(tdMonths);
      tr.append(tdText(period.name || ''));
      tr.append(tdText(window ? `${formatMinutesAsTime(window.startMin)}–${formatMinutesAsTime(window.endMin)}` : '—'));
      tr.append(tdText(`$${Number(period.buyRate || 0).toFixed(5)}`));
      tr.append(tdText(`$${Number(period.sellRate || 0).toFixed(5)}`));
      tbody.append(tr);
    }
  }
  table.append(tbody);
  host.append(table);
}

function matchSeason(season, month, day) {
  // Custom plan: range is [startMonth/startDay, nextStartMonth/nextStartDay).
  if (season.nextStartMonth != null) {
    const cur = month * 100 + day;
    const start = Number(season.startMonth) * 100 + Number(season.startDay);
    const end = Number(season.nextStartMonth) * 100 + Number(season.nextStartDay);
    if (start === end) return true;
    if (start < end) return cur >= start && cur < end;
    return cur >= start || cur < end;
  }
  // Tesla plan: range is fromMonth..toMonth (with possible month wrap).
  if (season.fromMonth != null && season.toMonth != null) {
    const from = Number(season.fromMonth);
    const to = Number(season.toMonth);
    if (from <= to) return month >= from && month <= to;
    return month >= from || month <= to;
  }
  return false;
}

function describeSeasonMonths(season) {
  if (season.fromMonth != null && season.toMonth != null) {
    return `${monthName(season.fromMonth)}–${monthName(season.toMonth)}`;
  }
  if (season.startMonth != null) {
    const next = season.nextStartMonth;
    if (next != null) {
      const lastMonth = ((next - 2 + 12) % 12) + 1;
      return `${monthName(season.startMonth)} ${season.startDay}–${monthName(lastMonth)}`;
    }
    return `starts ${monthName(season.startMonth)} ${season.startDay}`;
  }
  return '—';
}

function monthName(m) {
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Math.max(1, Math.min(12, Number(m))) - 1];
}

function timeInWindowClient(cur, startMin, endMin) {
  if (startMin == null || endMin == null) return false;
  if (startMin === endMin) return true;
  if (startMin < endMin) return cur >= startMin && cur < endMin;
  return cur >= startMin || cur < endMin;
}

function formatMinutesAsTime(min) {
  if (min == null) return '—';
  const m = Math.max(0, Math.min(1440, Math.round(min)));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function appendCells(tr, values) {
  for (const v of values) {
    const td = document.createElement('td');
    td.textContent = v;
    tr.append(td);
  }
}

function formatCurrency(value) {
  const n = Number(value || 0);
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
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
  // TOU report defaults to month-to-date.
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  els.touStartDate.value = dateInputValue(monthStart);
  els.touEndDate.value = dateInputValue(today);
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

function summarizeLaunchd(launchd) {
  if (!launchd) return '';
  if (launchd.ok === false) return `Launchd reload failed: ${launchd.error || 'unknown error'}`;
  const parts = [];
  if (launchd.added?.length) parts.push(`+${launchd.added.length} added`);
  if (launchd.updated?.length) parts.push(`~${launchd.updated.length} updated`);
  if (launchd.removed?.length) parts.push(`-${launchd.removed.length} removed`);
  if (launchd.unchanged?.length && parts.length === 0) parts.push(`${launchd.unchanged.length} unchanged`);
  return parts.length ? `Launchd: ${parts.join(', ')}.` : 'Launchd: no jobs.';
}

// ---- Rates tab -------------------------------------------------------------

const DEFAULT_PERIODS = [
  { name: 'Off-Peak',             startTime: '00:00', endTime: '15:00', buyRate: 0, sellRate: 0.03 },
  { name: 'Partial-Peak Morning', startTime: '15:00', endTime: '16:00', buyRate: 0, sellRate: 0.03 },
  { name: 'Peak',                 startTime: '16:00', endTime: '21:00', buyRate: 0, sellRate: 0.03 },
  { name: 'Partial-Peak Evening', startTime: '21:00', endTime: '24:00', buyRate: 0, sellRate: 0.03 }
];

const DEFAULT_DRAFT = {
  enabled: false,
  seasons: [
    { name: 'Summer', startMonth: 6,  startDay: 1, periods: DEFAULT_PERIODS.map(p => ({ ...p })) },
    { name: 'Winter', startMonth: 10, startDay: 1, periods: DEFAULT_PERIODS.map(p => ({ ...p })) }
  ]
};

async function loadRates() {
  try {
    const data = await api('/api/rates');
    ratesTeslaFallback = data.tesla;
    ratesDraft = data.custom
      ? deepClone(data.custom)
      : seedFromTesla(data.tesla);
    ratesFetched = true;
    renderRates();
  } catch (error) {
    setStatus(els.ratesStatus, error.message, 'error');
  }
}

function seedFromTesla(teslaPlan) {
  // Tesla plan has ON_PEAK + OFF_PEAK only. Synthesize a Partial-Peak shell so
  // the user has a starting point matching what they actually pay.
  if (!teslaPlan?.seasons?.length) return deepClone(DEFAULT_DRAFT);
  return {
    enabled: false,
    seasons: teslaPlan.seasons.map(season => {
      const periods = [];
      for (const p of season.periods || []) {
        const w = p.windows?.[0];
        periods.push({
          name: humanPeriodName(p.name),
          startTime: minutesToTime(w?.startMin),
          endTime: minutesToTime(w?.endMin),
          buyRate: Number(p.buyRate || 0),
          sellRate: Number(p.sellRate || 0)
        });
      }
      // Sort Off-Peak / Partial-Peak / Peak for editing.
      periods.sort((a, b) => periodSortKey(a.name) - periodSortKey(b.name));
      return {
        name: season.label,
        startMonth: Number(season.startMonth) || Number(season.fromMonth) || 1,
        startDay: Number(season.startDay) || 1,
        periods
      };
    })
  };
}

function humanPeriodName(raw) {
  const n = String(raw || '').toLowerCase().replace(/[_\s-]/g, '');
  if (n === 'onpeak' || n === 'peak') return 'Peak';
  if (n === 'partialpeak' || n === 'midpeak') return 'Partial-Peak';
  if (n === 'offpeak') return 'Off-Peak';
  return raw;
}

function periodSortKey(name) {
  if (isClientOffPeak(name)) return 0;
  if (isClientPartialPeak(name)) return 1;
  if (isClientPeak(name)) return 2;
  return 3;
}

function minutesToTime(min) {
  if (min == null) return '00:00';
  const m = Math.max(0, Math.min(1440, Math.round(min)));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function timeToMinutes(text) {
  const m = String(text || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  if (h === 24 && min !== 0) return null;
  return h * 60 + min;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function renderRates() {
  els.ratesEnabled.checked = !!ratesDraft.enabled;
  els.ratesSourceTag.textContent = ratesDraft.enabled
    ? 'Custom rates in use'
    : `Tesla data in use${ratesTeslaFallback?.code ? ` (${ratesTeslaFallback.code})` : ''}`;
  els.ratesView.classList.toggle('rates-disabled', !ratesDraft.enabled);

  els.ratesSeasons.replaceChildren();
  for (const [si, season] of ratesDraft.seasons.entries()) {
    els.ratesSeasons.append(renderSeasonCard(si, season));
  }
  renderRatesValidation();
}

function renderSeasonCard(seasonIndex, season) {
  const card = document.createElement('div');
  card.className = 'rate-season';

  const h = document.createElement('h3');
  h.textContent = season.name || `Season ${seasonIndex + 1}`;
  card.append(h);

  const meta = document.createElement('div');
  meta.className = 'rate-season-meta';
  meta.append(numberInput('Start month', season.startMonth, 1, 12, v => { season.startMonth = v; renderRatesValidation(); }));
  meta.append(numberInput('Start day',   season.startDay,   1, 31, v => { season.startDay = v; renderRatesValidation(); }));
  card.append(meta);

  const table = document.createElement('table');
  table.className = 'rate-period-table';
  const head = document.createElement('thead');
  head.innerHTML = '<tr><th>Period</th><th>Start</th><th>End</th><th>Buy $/kWh</th><th>Sell $/kWh</th><th></th></tr>';
  table.append(head);
  const body = document.createElement('tbody');
  for (const [pi, period] of season.periods.entries()) {
    body.append(renderPeriodRow(season, pi));
  }
  table.append(body);
  card.append(table);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'add-period';
  addBtn.textContent = '+ Add period';
  addBtn.addEventListener('click', () => {
    season.periods.push({
      name: 'Partial-Peak',
      startTime: '00:00',
      endTime: '00:00',
      buyRate: 0,
      sellRate: 0.03
    });
    renderRates();
  });
  card.append(addBtn);

  const coverage = document.createElement('div');
  coverage.className = 'rate-season-coverage';
  coverage.dataset.seasonIndex = String(seasonIndex);
  card.append(coverage);

  return card;
}

function renderPeriodRow(season, periodIndex) {
  const period = season.periods[periodIndex];
  const tr = document.createElement('tr');
  tr.append(tdName(period.name, v => { period.name = v; renderRatesValidation(); }));
  tr.append(tdTime(period.startTime, v => { period.startTime = v; renderRatesValidation(); }));
  tr.append(tdTime(period.endTime,   v => { period.endTime = v; renderRatesValidation(); }));
  tr.append(tdRate(period.buyRate,   v => { period.buyRate = v; }));
  tr.append(tdRate(period.sellRate,  v => { period.sellRate = v; }));
  tr.append(tdRemove(() => {
    season.periods.splice(periodIndex, 1);
    renderRates();
  }));
  return tr;
}

function tdName(value, onChange) {
  const td = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = 'Period name';
  input.className = 'period-name';
  input.addEventListener('change', () => onChange(input.value));
  td.append(input);
  return td;
}

function tdRemove(onClick) {
  const td = document.createElement('td');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'remove-period';
  btn.textContent = '✕';
  btn.title = 'Remove period';
  btn.addEventListener('click', onClick);
  td.append(btn);
  return td;
}

function tdText(value) {
  const td = document.createElement('td');
  td.textContent = value;
  return td;
}

function tdTime(value, onChange) {
  const td = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = 'HH:MM';
  input.addEventListener('change', () => onChange(input.value));
  td.append(input);
  return td;
}

function tdRate(value, onChange) {
  const td = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.001';
  input.min = '0';
  input.value = String(value);
  input.addEventListener('change', () => onChange(Number(input.value)));
  td.append(input);
  return td;
}

function numberInput(label, value, min, max, onChange) {
  const wrap = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.addEventListener('change', () => onChange(Number(input.value)));
  wrap.append(span, input);
  return wrap;
}

function renderRatesValidation() {
  const errors = validateRatesDraft(ratesDraft);
  els.ratesSave.disabled = errors.length > 0;
  // Per-season coverage badges.
  for (const div of els.ratesSeasons.querySelectorAll('.rate-season-coverage')) {
    const si = Number(div.dataset.seasonIndex);
    const seasonErrors = errors.filter(e => e.seasonIndex === si);
    if (seasonErrors.length) {
      div.textContent = '✗ ' + seasonErrors.map(e => e.message).join('; ');
      div.classList.remove('ok'); div.classList.add('error');
    } else {
      div.textContent = '✓ 24h covered, no overlaps';
      div.classList.remove('error'); div.classList.add('ok');
    }
  }
  if (errors.length === 0) {
    els.ratesValidation.textContent = '';
  } else {
    const generic = errors.filter(e => e.seasonIndex == null).map(e => e.message);
    els.ratesValidation.textContent = generic.length ? generic.join(' • ') : '';
  }
}

function validateRatesDraft(draft) {
  const errors = [];
  if (!draft?.seasons?.length) {
    errors.push({ message: 'At least one season required.' });
    return errors;
  }
  for (const [si, season] of draft.seasons.entries()) {
    if (!Number.isInteger(season.startMonth) || season.startMonth < 1 || season.startMonth > 12) {
      errors.push({ seasonIndex: si, message: 'Start month must be 1–12' });
    }
    if (!Number.isInteger(season.startDay) || season.startDay < 1 || season.startDay > 31) {
      errors.push({ seasonIndex: si, message: 'Start day must be 1–31' });
    }
    const coverage = new Array(1440).fill(0);
    for (const period of season.periods || []) {
      const start = timeToMinutes(period.startTime);
      const end = timeToMinutes(period.endTime);
      if (start == null || end == null) {
        errors.push({ seasonIndex: si, message: `${period.name}: invalid time` });
        continue;
      }
      if (!(Number(period.buyRate) >= 0)) {
        errors.push({ seasonIndex: si, message: `${period.name}: buy rate ≥ 0` });
      }
      const endNorm = end === 0 ? 1440 : end;
      if (start < endNorm) {
        for (let i = start; i < endNorm; i++) coverage[i]++;
      } else {
        for (let i = start; i < 1440; i++) coverage[i]++;
        for (let i = 0; i < endNorm; i++) coverage[i]++;
      }
    }
    if (coverage.some(v => v > 1)) errors.push({ seasonIndex: si, message: 'periods overlap' });
    if (coverage.some(v => v === 0)) errors.push({ seasonIndex: si, message: 'periods leave gaps' });
  }
  return errors;
}

els.ratesEnabled.addEventListener('change', () => {
  ratesDraft.enabled = els.ratesEnabled.checked;
  els.ratesView.classList.toggle('rates-disabled', !ratesDraft.enabled);
  els.ratesSourceTag.textContent = ratesDraft.enabled
    ? 'Custom rates in use'
    : `Tesla data in use${ratesTeslaFallback?.code ? ` (${ratesTeslaFallback.code})` : ''}`;
});

els.ratesSave.addEventListener('click', async () => {
  await runWithFeedback({
    buttons: [els.ratesSave],
    pendingText: 'Saving...',
    successText: 'Save',
    statusEl: els.ratesStatus,
    pendingMessage: 'Saving rate structure...',
    successMessage: 'Rate structure saved.',
    task: async () => {
      const result = await api('/api/rates', { method: 'POST', body: ratesDraft });
      if (!result.ok) throw new Error((result.errors || ['Save failed']).join('; '));
    }
  });
});

function clearStatusLater(element) {
  const message = element.textContent;
  window.setTimeout(() => {
    if (element.textContent === message) {
      element.textContent = '';
      element.classList.remove('pending', 'success', 'error');
    }
  }, 4000);
}
