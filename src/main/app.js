const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage } = require('electron');
const { LocalDatabase, ROLES } = require('./database');
const { verifyPassword, SessionStore } = require('./auth');
const { MonitorEngine } = require('./monitor-engine');
const { getNetworkAdapters } = require('./checks');
const { NotificationCenter } = require('./notification-center');
const { configureAutostart, startedInBackground } = require('./autostart');
const { dispatchWebhook } = require('./webhooks');
const { CloudPublisher } = require('./cloud-publisher');
const { HeartbeatService } = require('./heartbeat');
const { HistorySyncService } = require('./history-sync');

app.setName('Remote Care Monitor');
if (process.platform === 'win32') {
  app.setAppUserModelId('in.archidtech.remotecare');
}
if (process.platform === 'linux') {
  // Match the packaged .desktop file so docks, taskbars, and the native-alert
  // fallback can associate this installed application correctly.
  app.setDesktopName('remote-care-monitor');
  // Wayland does not let Electron position a popup. Ubuntu normally exposes
  // Xwayland through DISPLAY, which lets the app-rendered notification keep
  // the same top-right placement as Windows and macOS.
  const isWaylandSession = process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY);
  if (isWaylandSession && process.env.DISPLAY) app.commandLine.appendSwitch('ozone-platform', 'x11');
}

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow;
let tray;
let database;
let monitor;
let isQuitting = false;
let notificationCenter;
let trayClockTimer;
let pendingProtectedQuit = false;
let runtimeSessionId;
let shutdownComplete = false;
let autostartStatus = { enabled: false, message: 'Automatic startup has not been checked yet' };
let startedAtLogin = false;
let cloudPublisher;
let heartbeatService;
let historySyncService;
let currentTrayMenu = null;
let lastTraySignature = '';
const sessions = new SessionStore();

function csvCell(value) {
  let text = String(value ?? '');
  // Spreadsheet applications can interpret leading formula characters. Reports
  // are data-only, so preserve those values as text instead.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function monthlyReportCsv(report) {
  const line = (values) => values.map(csvCell).join(',');
  const lines = [
    line(['Remote Care Monitor — monthly monitoring report']),
    line(['Report month', report.month]),
    line(['Generated at (UTC)', report.generatedAt]),
    line(['Recorded result changes', report.summary.recordedChanges]),
    line(['Successful results', report.summary.successful]),
    line(['Failed results', report.summary.failed]),
    line(['Locations', report.locations.join('; ') || 'None']),
    line([]),
    line(['Checked at (UTC)', 'Location', 'Monitor', 'Type', 'Outcome', 'Status', 'Message', 'Latency (ms)', 'Details'])
  ];
  for (const result of report.results) {
    lines.push(line([
      result.checkedAt,
      result.locationName,
      result.targetName,
      result.targetType,
      result.ok ? 'Success' : 'Failure',
      result.status,
      result.message,
      result.latencyMs ?? '',
      JSON.stringify(result.details || {})
    ]));
  }
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

function createTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="14" fill="#0e7490"/>
    <path d="M14 35c9-13 27-13 36 0M20 42c6-8 18-8 24 0M29 49a3 3 0 1 0 6 0 3 3 0 0 0-6 0" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/>
  </svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`).resize({ width: 18, height: 18 });
}

function updateTray() {
  if (!tray || !database) return;
  const dashboard = database.getDashboard();
  const { down, warning, healthy, total } = dashboard.summary;
  const state = down > 0 ? `${down} critical issue${down === 1 ? '' : 's'}` : warning > 0 ? `${warning} warning${warning === 1 ? '' : 's'}` : `${healthy}/${total} monitors healthy`;
  const latestCheck = dashboard.targets.reduce((latest, target) => {
    if (!target.lastCheckedAt) return latest;
    return !latest || target.lastCheckedAt > latest ? target.lastCheckedAt : latest;
  }, null);
  const localTime = new Date().toLocaleString();
  const lastCheckText = latestCheck ? new Date(latestCheck).toLocaleString() : 'No checks completed yet';
  tray.setToolTip(`Remote Care Monitor — ${state}\nUpdated: ${localTime}`);

  const signature = `${state}|${lastCheckText}`;
  if (signature === lastTraySignature && currentTrayMenu) return;
  lastTraySignature = signature;

  currentTrayMenu = Menu.buildFromTemplate([
    { label: `Status: ${state}`, enabled: false },
    { label: `Last recorded check: ${lastCheckText}`, enabled: false },
    { label: `Tray updated: ${localTime}`, enabled: false },
    { type: 'separator' },
    { label: 'Show dashboard', click: () => showWindow() },
    { label: 'Hide to system tray', click: () => hideWindowToTray() },
    { label: 'Run all checks now', click: () => monitor?.refreshSchedule(true) },
    { type: 'separator' },
    { label: 'Quit Remote Care Monitor…', click: () => requestProtectedQuit('tray') }
  ]);
  tray.setContextMenu(currentTrayMenu);
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function notify(event) {
  const settings = database.getAppSettings();
  const enabled = ['down', 'warning'].includes(event.kind) ? settings.showFailureNotifications : settings.showRecoveryNotifications;
  if (enabled) {
    notificationCenter.show(event, settings.notificationDurationSeconds * 1000);
    broadcast('monitor-update', { type: 'notification', event });
    if (['down', 'warning'].includes(event.kind)) {
      if (process.platform === 'darwin' && app.dock) {
        app.dock.bounce('critical');
      } else if (process.platform === 'win32' && mainWindow && !mainWindow.isFocused()) {
        mainWindow.flashFrame(true);
      }
    }
  }

  // Phase 2: Sound alerts
  if (settings.soundAlertsEnabled) {
    broadcast('sound-alert', { kind: event.kind, volume: settings.soundVolume });
  }

  // Phase 2: Webhook integration
  if (settings.webhookEnabled && settings.webhookUrl) {
    const shouldDispatch = settings.webhookEvents === 'all' || ['down', 'warning'].includes(event.kind);
    if (shouldDispatch) {
      dispatchWebhook({ webhookUrl: settings.webhookUrl, webhookType: settings.webhookType, event })
        .catch((err) => {
          database?.audit(null, 'webhook_dispatch_failed', 'application', null, { error: err.message });
        });
    }
  }

  // Phase 2: Trigger immediate cloud sync
  cloudPublisher?.trigger();
}

function showBackgroundToast() {
  const settings = database?.getAppSettings();
  if (!settings?.showTrayReminder) return;
  notificationCenter.show({
    kind: 'info',
    title: 'Remote Care Monitor is still running',
    body: 'Monitoring continues in the background. Use the system tray icon to reopen it.'
  }, settings.notificationDurationSeconds * 1000);
}

function hideWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  showBackgroundToast();
}

function requestProtectedQuit(source = 'application') {
  pendingProtectedQuit = true;
  showWindow();
  broadcast('app-control', { type: 'quit_requested', source });
}

function completeShutdown() {
  if (shutdownComplete) return;
  shutdownComplete = true;
  if (trayClockTimer) clearInterval(trayClockTimer);
  historySyncService?.stop();
  heartbeatService?.stop();
  cloudPublisher?.stop();
  database?.endRuntimeSession(runtimeSessionId, 'authorized_quit');
  monitor?.stop();
  notificationCenter?.dispose();
  database?.close();
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 650,
    show: false,
    backgroundColor: '#07131f',
    title: 'Remote Care Monitor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      devTools: !app.isPackaged
    }
  });
  if (process.platform !== 'darwin') {
    mainWindow.removeMenu();
  }
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('minimize', () => {
    showBackgroundToast();
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hideWindowToTray();
    }
  });
  mainWindow.on('closed', () => { mainWindow = undefined; });
  return mainWindow;
}

function showWindow() {
  const window = createWindow();
  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    window.show();
  }
  window.focus();
  broadcast('monitor-update', { type: 'window_focused' });
}

function requireSession(token, allowedRoles = null) {
  const session = sessions.get(token);
  if (!session) throw new Error('Your session has expired. Please sign in again.');
  if (allowedRoles) {
    const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    if (!roles.includes(session.role)) {
      if (roles.includes(ROLES.OPERATOR)) {
        throw new Error('Operator or Super Admin access is required for this action.');
      }
      throw new Error('Super Admin access is required for this action.');
    }
  }
  return session;
}

function registerIpc() {
  ipcMain.handle('setup-state', () => database.getSetupState());

  ipcMain.handle('setup-admin', (_event, payload) => {
    const user = database.createInitialAdmin(payload || {});
    database.createDefaultTargets();
    monitor.refreshSchedule(true);
    monitor.start();
    cloudPublisher = new CloudPublisher({ database, getSettings: () => database.getAppSettings() });
    cloudPublisher.start();
    heartbeatService = new HeartbeatService({ database, publisher: cloudPublisher, getSettings: () => database.getAppSettings() });
    heartbeatService.start();
    historySyncService = new HistorySyncService({ database, getSettings: () => database.getAppSettings() });
    historySyncService.start();
    const session = sessions.issue(user);
    database.markLogin(user.id);
    database.audit(user.id, 'login', 'session', session.token, {});
    updateTray();
    return { session };
  });

  ipcMain.handle('login', (_event, payload) => {
    const candidate = database.getUserForLogin(payload?.username || '');
    if (!candidate || !candidate.active || !verifyPassword(payload?.password || '', candidate.passwordSalt, candidate.passwordHash)) {
      throw new Error('Invalid username or password.');
    }
    const user = database.getUserById(candidate.id);
    const session = sessions.issue(user);
    database.markLogin(user.id);
    database.audit(user.id, 'login', 'session', session.token, {});
    return { session };
  });

  ipcMain.handle('logout', (_event, { token }) => {
    const session = requireSession(token);
    database.audit(session.userId, 'logout', 'session', token, {});
    sessions.revoke(token);
    return { ok: true };
  });

  ipcMain.handle('dashboard', (_event, { token }) => {
    requireSession(token);
    return monitor.dashboard();
  });

  ipcMain.handle('history-list', (_event, { token, filters }) => {
    requireSession(token);
    return database.listCheckHistory(filters || {});
  });

  ipcMain.handle('history-export-monthly-report', async (_event, { token, month }) => {
    const session = requireSession(token);
    const report = database.getMonthlyReport(month);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export monthly monitoring report',
      defaultPath: path.join(app.getPath('downloads'), `Remote Care Monitor report ${report.month}.csv`),
      filters: [{ name: 'CSV report', extensions: ['csv'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    });
    if (result.canceled || !result.filePath) return { cancelled: true };
    fs.writeFileSync(result.filePath, monthlyReportCsv(report), 'utf8');
    database.audit(session.userId, 'export_monthly_history_report', 'check_history', report.month, {
      month: report.month,
      recordedChanges: report.summary.recordedChanges
    });
    return { cancelled: false, filePath: result.filePath, rowCount: report.summary.recordedChanges };
  });

  ipcMain.handle('notification-test', (_event, { token }) => {
    const session = requireSession(token, [ROLES.SUPER_ADMIN, ROLES.OPERATOR]);
    const settings = database.getAppSettings();
    const event = {
      kind: 'warning',
      title: 'Test alert',
      body: 'This confirms that Remote Care Monitor can show desktop alerts on this device.',
      target: { name: 'Alert test', locationName: 'Local device', severity: 'warning' },
      occurredAt: new Date().toISOString()
    };
    notificationCenter.show(event, settings.notificationDurationSeconds * 1000);
    database.audit(session.userId, 'test_desktop_notification', 'application', null, {});
    broadcast('monitor-update', { type: 'notification', event });
    if (settings.soundAlertsEnabled) {
      broadcast('sound-alert', { kind: 'warning', volume: settings.soundVolume });
    }
    return { ok: true };
  });

  ipcMain.handle('network-adapters', async (_event, { token }) => {
    requireSession(token);
    return getNetworkAdapters();
  });

  ipcMain.handle('target-save', (_event, { token, target }) => {
    const session = requireSession(token, ROLES.SUPER_ADMIN);
    const saved = database.saveTarget(target, session.userId);
    monitor.refreshSchedule(true);
    updateTray();
    broadcast('monitor-update', { type: 'target_saved', targetId: saved.id });
    return saved;
  });

  ipcMain.handle('target-delete', (_event, { token, targetId }) => {
    const session = requireSession(token, ROLES.SUPER_ADMIN);
    database.deleteTarget(Number(targetId), session.userId);
    monitor.refreshSchedule(false);
    updateTray();
    broadcast('monitor-update', { type: 'target_deleted', targetId: Number(targetId) });
    return { ok: true };
  });

  ipcMain.handle('target-run', async (_event, { token, targetId }) => {
    requireSession(token, [ROLES.SUPER_ADMIN, ROLES.OPERATOR]);
    return monitor.runNow(Number(targetId));
  });

  ipcMain.handle('incident-acknowledge', (_event, { token, incidentId }) => {
    const session = requireSession(token, [ROLES.SUPER_ADMIN, ROLES.OPERATOR]);
    database.acknowledgeIncident(Number(incidentId), session.userId);
    broadcast('monitor-update', { type: 'incident_acknowledged', incidentId: Number(incidentId) });
    return { ok: true };
  });

  ipcMain.handle('webhook-test', async (_event, { token }) => {
    const session = requireSession(token, [ROLES.SUPER_ADMIN, ROLES.OPERATOR]);
    const settings = database.getAppSettings();
    if (!settings.webhookUrl) throw new Error('No webhook URL configured in Settings.');
    const testEvent = {
      kind: 'warning',
      title: 'Test Webhook Alert',
      body: 'This confirms that Remote Care Monitor can dispatch webhook notifications.',
      target: { name: 'Webhook Test', locationName: 'Local device', severity: 'warning' },
      occurredAt: new Date().toISOString()
    };
    const result = await dispatchWebhook({
      webhookUrl: settings.webhookUrl,
      webhookType: settings.webhookType,
      event: testEvent
    });
    database.audit(session.userId, 'test_webhook', 'application', null, { type: settings.webhookType });
    return result;
  });

  ipcMain.handle('cloud-sync-status', (_event, { token }) => {
    requireSession(token);
    return cloudPublisher?.getStatus() || { enabled: false };
  });

  ipcMain.handle('cloud-sync-trigger', async (_event, { token }) => {
    requireSession(token, [ROLES.SUPER_ADMIN, ROLES.OPERATOR]);
    return cloudPublisher?.publishPending() || { skipped: true };
  });

  ipcMain.handle('server-health-check', async (_event, { token, healthUrl }) => {
    requireSession(token, [ROLES.SUPER_ADMIN, ROLES.OPERATOR]);
    const settings = database.getAppSettings();
    let target = (healthUrl || '').trim();
    if (!target) {
      if (settings.serverHealthUrl && settings.serverHealthUrl.trim()) {
        target = settings.serverHealthUrl.trim();
      } else if (settings.serverBaseUrl && settings.serverBaseUrl.trim()) {
        target = `${settings.serverBaseUrl.trim().replace(/\/+$/, '')}/health`;
      }
    }
    if (!target) {
      throw new Error('No server health URL configured.');
    }

    const { checkHttp } = require('./checks');
    const start = Date.now();
    try {
      const res = await checkHttp({ url: target, timeoutMs: 5000, metadata: {} });
      const latency = Date.now() - start;
      return {
        ok: res.ok,
        target,
        statusCode: res.details?.statusCode || (res.ok ? 200 : 500),
        latencyMs: res.latencyMs ?? latency,
        message: res.message
      };
    } catch (err) {
      return {
        ok: false,
        target,
        statusCode: null,
        latencyMs: Date.now() - start,
        message: err.message
      };
    }
  });

  ipcMain.handle('history-sync-preview', (_event, { token, options }) => {
    requireSession(token);
    return historySyncService
      ? historySyncService.buildPayload(options || { previewRecent: true })
      : { error: 'History sync service not initialized' };
  });

  ipcMain.handle('history-sync-trigger', async (_event, { token }) => {
    requireSession(token, [ROLES.SUPER_ADMIN, ROLES.OPERATOR]);
    if (!historySyncService) return { skipped: true, reason: 'History sync service not initialized' };
    return historySyncService.syncNow({ force: true });
  });

  ipcMain.handle('history-sync-status', (_event, { token }) => {
    requireSession(token);
    return historySyncService ? historySyncService.getStatus() : { enabled: false };
  });

  ipcMain.handle('targets-export', async (_event, { token, targetIds }) => {
    const session = requireSession(token, [ROLES.SUPER_ADMIN, ROLES.OPERATOR]);
    const exportData = database.exportMonitorsJson(targetIds);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export monitors configuration',
      defaultPath: path.join(app.getPath('downloads'), `Remote Care Monitors Export ${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'JSON file', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { cancelled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2), 'utf8');
    database.audit(session.userId, 'export_monitors', 'targets', null, { count: exportData.monitors.length });
    return { cancelled: false, filePath: result.filePath, count: exportData.monitors.length };
  });

  ipcMain.handle('targets-import', async (_event, { token, options }) => {
    const session = requireSession(token, ROLES.SUPER_ADMIN);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import monitors configuration',
      filters: [{ name: 'JSON file', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths?.[0]) return { cancelled: true };
    const raw = fs.readFileSync(result.filePaths[0], 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid JSON file format.');
    }
    const outcome = database.importMonitorsJson(parsed, session.userId, options);
    monitor.refreshSchedule(true);
    updateTray();
    broadcast('monitor-update', { type: 'targets_imported', outcome });
    return { cancelled: false, ...outcome };
  });

  ipcMain.handle('users-list', (_event, { token }) => {
    requireSession(token, ROLES.SUPER_ADMIN);
    return database.listUsers();
  });

  ipcMain.handle('viewer-create', (_event, { token, user }) => {
    const session = requireSession(token, ROLES.SUPER_ADMIN);
    const created = database.createViewer(user || {}, session.userId);
    broadcast('monitor-update', { type: 'viewer_created', userId: created.id });
    return created;
  });

  ipcMain.handle('viewer-set-active', (_event, { token, userId, active }) => {
    const session = requireSession(token, ROLES.SUPER_ADMIN);
    const user = database.setViewerActive(Number(userId), Boolean(active), session.userId);
    if (!user.active) sessions.revokeUser(user.id);
    broadcast('monitor-update', { type: 'viewer_updated', userId: user.id });
    return user;
  });

  ipcMain.handle('viewer-reset-password', (_event, { token, userId, password }) => {
    const session = requireSession(token, ROLES.SUPER_ADMIN);
    database.resetViewerPassword(Number(userId), password, session.userId);
    sessions.revokeUser(Number(userId));
    return { ok: true };
  });

  ipcMain.handle('user-change-password', (_event, { token, currentPassword, newPassword }) => {
    const session = requireSession(token);
    database.changeUserPassword(session.userId, currentPassword, newPassword);
    return { ok: true };
  });

  ipcMain.handle('user-update-profile', (_event, { token, profile }) => {
    const session = requireSession(token);
    const updated = database.updateUserProfile(session.userId, profile || {});
    session.displayName = updated.displayName;
    session.username = updated.username;
    broadcast('monitor-update', { type: 'profile_updated', user: updated });
    return updated;
  });

  ipcMain.handle('viewer-update', (_event, { token, userId, updates }) => {
    const session = requireSession(token, ROLES.SUPER_ADMIN);
    const updated = database.updateViewer(Number(userId), updates || {}, session.userId);
    if (!updated.active) sessions.revokeUser(updated.id);
    broadcast('monitor-update', { type: 'viewer_updated', userId: updated.id });
    return updated;
  });

  ipcMain.handle('app-settings', (_event, { token }) => {
    requireSession(token);
    return database.getAppSettings();
  });

  ipcMain.handle('app-settings-save', (_event, { token, settings }) => {
    const session = requireSession(token, ROLES.SUPER_ADMIN);
    const saved = database.updateAppSettings(settings, session.userId);
    historySyncService?.restart();
    broadcast('monitor-update', { type: 'app_settings_updated', settings: saved });
    return saved;
  });

  ipcMain.handle('app-control-state', (_event, { token }) => {
    const session = requireSession(token);
    return { pendingProtectedQuit, canAuthorizeQuit: session.role === ROLES.SUPER_ADMIN };
  });

  ipcMain.handle('quit-with-password', (_event, { token, password, source }) => {
    const session = requireSession(token, ROLES.SUPER_ADMIN);
    const requestedFrom = ['tray', 'settings', 'application'].includes(source) ? source : 'application';
    if (!database.verifySuperAdminPassword(session.userId, password || '')) {
      database.audit(session.userId, 'failed_protected_quit', 'application', null, { source: requestedFrom });
      throw new Error('Incorrect Super Admin password. Monitoring is still running.');
    }
    database.audit(session.userId, 'authorized_protected_quit', 'application', null, { source: requestedFrom });
    pendingProtectedQuit = false;
    isQuitting = true;
    setImmediate(() => app.quit());
    return { ok: true };
  });

  ipcMain.handle('cancel-protected-quit', (_event, { token }) => {
    const session = requireSession(token);
    if (pendingProtectedQuit) database.audit(session.userId, 'cancelled_protected_quit', 'application', null, {});
    pendingProtectedQuit = false;
    return { ok: true };
  });

  ipcMain.handle('app-info', (_event, { token }) => {
    requireSession(token);
    const syncStatus = cloudPublisher?.getStatus();
    const syncText = syncStatus?.enabled
      ? (syncStatus.lastSyncAt ? `Active (last sync: ${new Date(syncStatus.lastSyncAt).toLocaleTimeString()})` : 'Active (connecting)')
      : 'Disabled in Settings';
    return {
      version: app.getVersion(), platform: process.platform, arch: process.arch, dataPath: app.getPath('userData'),
      cloudSync: syncText, runtime: database.getRuntimeStatus(), autostart: autostartStatus
    };
  });
}

app.whenReady().then(() => {
  startedAtLogin = startedInBackground({ app });
  autostartStatus = configureAutostart({ app });
  const databasePath = path.join(app.getPath('userData'), 'remote-care.sqlite');
  database = new LocalDatabase(databasePath);
  runtimeSessionId = crypto.randomUUID();
  database.startRuntimeSession(runtimeSessionId, {
    version: app.getVersion(),
    platform: process.platform,
    startedInBackground: startedAtLogin
  });
  monitor = new MonitorEngine({ database, notify });
  notificationCenter = new NotificationCenter({ openDashboard: showWindow });
  monitor.on('update', (event) => {
    updateTray();
    broadcast('monitor-update', event);
  });
  registerIpc();
  tray = new Tray(createTrayIcon());
  if (process.platform !== 'darwin') {
    tray.on('click', () => showWindow());
  } else {
    tray.on('double-click', () => showWindow());
  }
  updateTray();
  trayClockTimer = setInterval(updateTray, 60_000);
  trayClockTimer.unref?.();
  if (database.hasSuperAdmin()) {
    database.createDefaultTargets();
    monitor.start();
    cloudPublisher = new CloudPublisher({ database, getSettings: () => database.getAppSettings() });
    cloudPublisher.start();
    heartbeatService = new HeartbeatService({ database, publisher: cloudPublisher, getSettings: () => database.getAppSettings() });
    heartbeatService.start();
    historySyncService = new HistorySyncService({ database, getSettings: () => database.getAppSettings() });
    historySyncService.start();
  }
  createWindow();
  if (!startedAtLogin || !database.hasSuperAdmin()) showWindow();
});

app.on('second-instance', () => showWindow());
app.on('activate', () => showWindow());
// Electron quits by default on Windows and Linux when the last window closes.
// Keep an explicit listener so monitoring and native notifications continue if
// a window is closed by the desktop environment while the tray is available.
app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  if (!isQuitting) {
    event.preventDefault();
    requestProtectedQuit('application');
    return;
  }
  completeShutdown();
});
