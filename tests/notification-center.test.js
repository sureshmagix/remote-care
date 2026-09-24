const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function harness(t, platform = process.platform) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const windows = [];
  const natives = [];
  const ipcMain = new EventEmitter();
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (_channel, event) => { this.event = event; };
      windows.push(this);
    }
    isDestroyed() { return Boolean(this.destroyed); }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    removeMenu() {}
    loadFile() { return Promise.resolve(); }
    setBounds(bounds) { this.bounds = bounds; }
    showInactive() { this.visible = true; this.emit('show'); }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.visible = false; }
  }
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; natives.push(this); }
    show() { this.visible = true; }
    close() { this.visible = false; this.emit('close'); }
  }
  const electron = {
    BrowserWindow, Notification, ipcMain,
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: -1280, y: 0, width: 1280, height: 720 } }) }
  };
  const sourcePath = path.join(__dirname, '../src/main/notification-center.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    module, __dirname: path.dirname(sourcePath), require: (name) => name === 'electron' ? electron : require(name),
    setTimeout, clearTimeout
  });
  let opened = 0;
  const center = new module.exports.NotificationCenter({ openDashboard: () => { opened += 1; }, platform });
  const send = (channel, ...args) => ipcMain.emit(`desktop-notification-${channel}`, { sender: center.window.webContents }, ...args);
  const show = (title = 'Monitor changed', duration = 5000) => center.show({ title, body: 'Service changed', kind: 'warning', occurredAt: '2026-09-22T10:00:00.000Z' }, duration);
  t.after(() => center.dispose());
  return { center, windows, natives, ipcMain, send, show, opened: () => opened };
}

test('desktop popup counts five seconds from visibility and queues every change', (t) => {
  const h = harness(t);
  h.show('First');
  h.show('Second');
  const window = h.windows[0];
  t.mock.timers.tick(2_500); // Loading time must not consume display time.
  assert.equal(window.visible, false);
  h.send('ready');
  assert.equal(window.event.title, 'First');
  assert.equal(window.event.occurredAt, '2026-09-22T10:00:00.000Z');
  const firstId = window.event.id;
  h.send('visible', firstId, 180);
  assert.equal(window.visible, true);
  assert.equal(window.bounds.x, -360); // Respect a secondary display's origin.
  t.mock.timers.tick(4999);
  assert.equal(window.visible, true);
  t.mock.timers.tick(1);
  assert.equal(window.visible, false);
  assert.equal(window.event.title, 'Second');
  const secondId = window.event.id;
  h.send('visible', secondId, 180);
  h.send('dismiss', firstId); // Stale close cannot dismiss a newer alert.
  assert.equal(window.visible, true);
  t.mock.timers.tick(5000);
  assert.equal(window.visible, false);
  assert.equal(h.center.current, null);
});

test('custom durations, close button, open action, and IPC sender validation', (t) => {
  const h = harness(t);
  h.show('Longer alert', 12000);
  h.send('ready');
  const window = h.windows[0];
  const id = window.event.id;
  h.send('visible', id, 190);
  h.ipcMain.emit('desktop-notification-dismiss', { sender: {} }, id);
  t.mock.timers.tick(5000);
  assert.equal(window.visible, true);
  t.mock.timers.tick(7000);
  assert.equal(window.visible, false);
  h.show('Close early');
  h.send('visible', window.event.id, 190);
  h.send('dismiss', window.event.id);
  assert.equal(window.visible, false);
  h.show('Open dashboard');
  h.send('visible', window.event.id, 190);
  h.send('open', window.event.id);
  assert.equal(h.opened(), 1);
  assert.equal(window.visible, false);
});

test('a failed popup renderer falls back to timestamped native alerts and cleans up', (t) => {
  const h = harness(t);
  h.show();
  h.show('Queued');
  h.send('ready');
  h.windows[0].webContents.emit('render-process-gone');
  assert.equal(h.natives.length, 2);
  assert.equal(h.windows[0].destroyed, true);
  assert.match(h.natives[0].options.body, /Service changed\n.+/);
  assert.equal(h.natives[0].visible, true);
  t.mock.timers.tick(5000);
  assert.equal(h.natives[0].visible, false);
  assert.equal(h.center.nativeNotifications.size, 0);
  h.center.dispose();
  assert.equal(h.ipcMain.listenerCount('desktop-notification-ready'), 0);
});

test('a popup that never signals readiness falls back to native alerts', (t) => {
  const h = harness(t);
  h.show('Renderer timeout');
  t.mock.timers.tick(3_000);
  assert.equal(h.natives.length, 1);
  assert.equal(h.natives[0].visible, true);
  assert.equal(h.windows[0].destroyed, true);
  t.mock.timers.tick(5_000);
  assert.equal(h.natives[0].visible, false);
});

test('Linux uses native critical alerts while the dashboard is in the background', (t) => {
  const h = harness(t, 'linux');
  h.show('Linux monitor alert');

  assert.equal(h.windows.length, 0);
  assert.equal(h.natives.length, 1);
  assert.equal(h.natives[0].options.timeoutType, 'never');
  assert.equal(h.natives[0].options.urgency, 'critical');
  assert.equal(h.natives[0].visible, true);
  h.natives[0].emit('click');
  assert.equal(h.opened(), 1);
  assert.equal(h.natives[0].visible, false);
});

test('Linux falls back to a notification-type alert window when native delivery fails', (t) => {
  const h = harness(t, 'linux');
  h.show('Native fallback');
  h.natives[0].emit('failed');

  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].options.type, 'notification');
  h.send('ready');
  h.send('visible', h.windows[0].event.id, 118);
  assert.equal(h.windows[0].visible, true);
});
