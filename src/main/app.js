const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, Menu, Notification, Tray, nativeImage } = require('electron');
const { LocalDatabase, ROLES } = require('./database');
const { verifyPassword, SessionStore } = require('./auth');
const { MonitorEngine } = require('./monitor-engine');
const { getNetworkAdapters } = require('./checks');

app.setName('Remote Care Monitor');

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow;
let tray;
let database;
let monitor;
let isQuitting = false;
const sessions = new SessionStore();

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
  tray.setToolTip(`Remote Care Monitor — ${state}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Status: ${state}`, enabled: false },
    { type: 'separator' },
    { label: 'Show dashboard', click: () => showWindow() },
    { label: 'Run all checks now', click: () => monitor?.refreshSchedule(true) },
    { type: 'separator' },
    { label: 'Quit Remote Care Monitor', click: () => { isQuitting = true; app.quit(); } }
  ]));
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function notify(event) {
  const urgency = event.kind === 'down' && event.target.severity === 'critical' ? 'critical' : 'normal';
  if (Notification.isSupported()) {
    new Notification({ title: event.title, body: event.body, urgency }).show();
  }
  broadcast('monitor-update', { type: 'notification', event });
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
      devTools: !app.isPackaged
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = undefined; });
  return mainWindow;
}

function showWindow() {
  const window = createWindow();
  window.show();
  window.focus();
}

function setupAutostart() {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: ['--background'] });
    return;
  }
  if (process.platform === 'linux' && app.isPackaged) {
    const autostartDir = path.join(app.getPath('home'), '.config', 'autostart');
    fs.mkdirSync(autostartDir, { recursive: true });
    const execPath = process.execPath.replace(/"/g, '\\"');
    fs.writeFileSync(path.join(autostartDir, 'remote-care-monitor.desktop'), `[Desktop Entry]\nType=Application\nName=Remote Care Monitor\nComment=Local network and service monitor\nExec=\"${execPath}\" --background\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
  }
}

function requireSession(token, requiredRole = null) {
  const session = sessions.get(token);
  if (!session) throw new Error('Your session has expired. Please sign in again.');
  if (requiredRole && session.role !== requiredRole) throw new Error('Super Admin access is required for this action.');
  return session;
}

function registerIpc() {
  ipcMain.handle('setup-state', () => database.getSetupState());

  ipcMain.handle('setup-admin', (_event, payload) => {
    const user = database.createInitialAdmin(payload || {});
    database.createDefaultTargets();
    monitor.refreshSchedule(true);
    monitor.start();
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
    requireSession(token, ROLES.SUPER_ADMIN);
    return monitor.runNow(Number(targetId));
  });

  ipcMain.handle('incident-acknowledge', (_event, { token, incidentId }) => {
    const session = requireSession(token, ROLES.SUPER_ADMIN);
    database.acknowledgeIncident(Number(incidentId), session.userId);
    broadcast('monitor-update', { type: 'incident_acknowledged', incidentId: Number(incidentId) });
    return { ok: true };
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

  ipcMain.handle('app-info', (_event, { token }) => {
    requireSession(token);
    return { version: app.getVersion(), platform: process.platform, arch: process.arch, dataPath: app.getPath('userData'), cloudSync: 'Phase 2 disabled' };
  });
}

app.whenReady().then(() => {
  const databasePath = path.join(app.getPath('userData'), 'remote-care.sqlite');
  database = new LocalDatabase(databasePath);
  monitor = new MonitorEngine({ database, notify });
  monitor.on('update', (event) => {
    updateTray();
    broadcast('monitor-update', event);
  });
  registerIpc();
  tray = new Tray(createTrayIcon());
  tray.on('click', () => showWindow());
  updateTray();
  setupAutostart();

  if (database.hasSuperAdmin()) {
    database.createDefaultTargets();
    monitor.start();
  }
  createWindow();
  if (!process.argv.includes('--background') || !database.hasSuperAdmin()) showWindow();
});

app.on('second-instance', () => showWindow());
app.on('activate', () => showWindow());
app.on('before-quit', () => {
  isQuitting = true;
  monitor?.stop();
  database?.close();
});
