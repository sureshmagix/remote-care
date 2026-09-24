const path = require('node:path');
const { BrowserWindow, ipcMain, screen, Notification } = require('electron');

const RENDERER_READY_TIMEOUT_MS = 3_000;

// Own the popup and its lifetime so desktop notification preferences cannot
// silently suppress alerts or choose a different timeout. Queue bursts so every
// change gets its full display time, including while the dashboard is hidden.
class NotificationCenter {
  constructor({ openDashboard }) {
    this.openDashboard = openDashboard;
    this.queue = [];
    this.current = null;
    this.window = null;
    this.ready = false;
    this.sequence = 0;
    this.timer = null;
    this.readyTimer = null;
    this.nativeNotifications = new Map();
    this.handlers = {
      'desktop-notification-ready': (event) => {
        if (!this.isSender(event)) return;
        this.ready = true;
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
        this.showNext();
      },
      'desktop-notification-visible': (event, id, height) => {
        if (!this.isSender(event) || id !== this.current?.id || this.timer) return;
        const cursor = screen.getCursorScreenPoint ? screen.getCursorScreenPoint() : { x: 0, y: 0 };
        const display = (screen.getDisplayNearestPoint ? screen.getDisplayNearestPoint(cursor) : null)
          || (screen.getPrimaryDisplay ? screen.getPrimaryDisplay() : { workArea: { x: 0, y: 0, width: 1280, height: 720 } });
        const area = display.workArea;
        const width = Math.min(360, area.width);
        const popupHeight = Math.min(Math.max(96, Number.isFinite(height) ? Math.ceil(height) : 118), area.height);
        this.window.setBounds({ x: area.x + area.width - width, y: area.y, width, height: popupHeight });
        if (typeof this.window.setVisibleOnAllWorkspaces === 'function') {
          this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        }
        if (typeof this.window.setAlwaysOnTop === 'function') {
          this.window.setAlwaysOnTop(true, 'pop-up-menu');
        }
        this.window.showInactive();
        if (typeof this.window.moveTop === 'function') {
          this.window.moveTop();
        }
        this.timer = setTimeout(() => this.dismiss(id), this.current.durationMs);
      },
      'desktop-notification-dismiss': (event, id) => {
        if (this.isSender(event)) this.dismiss(id);
      },
      'desktop-notification-open': (event, id) => {
        if (!this.isSender(event) || id !== this.current?.id) return;
        this.openDashboard();
        this.dismiss(id);
      }
    };
    for (const [channel, listener] of Object.entries(this.handlers)) ipcMain.on(channel, listener);
  }

  isSender(event) {
    return this.window && !this.window.isDestroyed() && event.sender === this.window.webContents;
  }

  show(event, durationMs) {
    this.queue.push({ ...event, id: ++this.sequence, occurredAt: event.occurredAt || new Date().toISOString(), durationMs });
    if (!this.window) this.createWindow();
    this.showNext();
  }

  createWindow() {
    this.ready = false;
    const window = new BrowserWindow({
      width: 360, height: 118, show: false, frame: false,
      resizable: false, minimizable: false, maximizable: false,
      alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#0d2132',
      title: 'Remote Care notification',
      webPreferences: {
        preload: path.join(__dirname, 'notification-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        webSecurity: true, backgroundThrottling: false
      }
    });
    this.window = window;
    if (typeof window.setAlwaysOnTop === 'function') {
      window.setAlwaysOnTop(true, 'pop-up-menu');
    }
    if (typeof window.setVisibleOnAllWorkspaces === 'function') {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.on('close', (event) => {
      event.preventDefault();
      if (this.current) this.dismiss(this.current.id);
      else window.hide();
    });
    window.webContents.on('did-fail-load', (_event, errorCode) => {
      if (errorCode !== -3) this.fallback(); // -3 is a benign cancelled navigation.
    });
    window.webContents.on('render-process-gone', () => this.fallback());
    window.loadFile(path.join(__dirname, '..', 'renderer', 'notification.html')).catch(() => this.fallback());
    this.readyTimer = setTimeout(() => {
      if (!this.ready && this.queue.length) this.fallback();
    }, RENDERER_READY_TIMEOUT_MS);
  }

  showNext() {
    if (!this.ready || this.current || !this.queue.length) return;
    this.current = this.queue.shift();
    this.window.webContents.send('desktop-notification', this.current);
  }

  dismiss(id) {
    if (id !== this.current?.id) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    this.window?.hide();
    this.showNext();
  }

  fallback() {
    const pending = [...(this.current ? [this.current] : []), ...this.queue];
    this.current = null;
    this.queue = [];
    clearTimeout(this.timer);
    this.timer = null;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.ready = false;
    this.window?.destroy();
    this.window = null;
    for (const event of pending) {
      if (!Notification.isSupported()) continue;
      const notification = new Notification({
        title: event.title,
        body: `${event.target?.locationName ? `${event.target.locationName}\n` : ''}${event.body}\n${new Date(event.occurredAt).toLocaleString()}`,
        closeButtonText: 'Close', timeoutType: 'never'
      });
      const dispose = () => {
        clearTimeout(this.nativeNotifications.get(notification));
        this.nativeNotifications.delete(notification);
      };
      notification.on('click', () => { this.openDashboard(); notification.close(); });
      notification.on('close', dispose);
      notification.on('failed', dispose);
      notification.show();
      this.nativeNotifications.set(notification, setTimeout(() => { notification.close(); dispose(); }, event.durationMs));
    }
  }

  dispose() {
    clearTimeout(this.timer);
    clearTimeout(this.readyTimer);
    for (const [notification, timer] of this.nativeNotifications) {
      clearTimeout(timer);
      notification.close();
    }
    this.nativeNotifications.clear();
    this.queue = [];
    this.current = null;
    this.window?.destroy();
    this.window = null;
    for (const [channel, listener] of Object.entries(this.handlers)) ipcMain.removeListener(channel, listener);
  }
}

module.exports = { NotificationCenter };
