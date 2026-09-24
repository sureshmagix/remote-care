const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BACKGROUND_ARGUMENTS,
  configureAutostart,
  desktopExecArgument,
  linuxDesktopEntry,
  startedInBackground
} = require('../src/main/autostart');

function packagedApp(overrides = {}) {
  return {
    isPackaged: true,
    getPath: () => '/home/monitor',
    setLoginItemSettings: () => {},
    getLoginItemSettings: () => ({}),
    ...overrides
  };
}

test('Linux autostart entry quotes executable paths and starts in the background', () => {
  assert.equal(desktopExecArgument('/opt/Remote Care/monitor'), '"/opt/Remote Care/monitor"');
  assert.equal(desktopExecArgument('/opt/quote"monitor'), '"/opt/quote\\"monitor"');
  const entry = linuxDesktopEntry('/opt/Remote Care/monitor');
  assert.match(entry, /^\[Desktop Entry\]/);
  assert.match(entry, /Exec="\/opt\/Remote Care\/monitor" --background/);
  assert.match(entry, /Hidden=false/);
  assert.match(entry, /X-GNOME-Autostart-enabled=true/);
  assert.match(entry, /X-GNOME-Autostart-Phase=Application/);
  assert.match(entry, /X-KDE-autostart-after=panel/);
});

test('Linux and Raspberry Pi packaged builds create an XDG graphical-session launcher', () => {
  const writes = [];
  const app = packagedApp();
  const status = configureAutostart({
    app,
    platform: 'linux',
    environment: { XDG_CONFIG_HOME: '/custom/config', APPIMAGE: '/home/monitor/Remote Care.AppImage' },
    executablePath: '/tmp/.mount/remote-care',
    fsApi: {
      mkdirSync: (directory, options) => writes.push({ kind: 'mkdir', directory, options }),
      writeFileSync: (file, contents, options) => writes.push({ kind: 'write', file, contents, options })
    }
  });

  assert.deepEqual(status, { enabled: true, message: 'Enabled — starts with your graphical desktop session' });
  assert.equal(writes[0].directory, '/custom/config/autostart');
  assert.equal(writes[1].file, '/custom/config/autostart/remote-care-monitor.desktop');
  assert.match(writes[1].contents, /Exec="\/home\/monitor\/Remote Care\.AppImage" --background/);
});

test('Windows registration uses the installed executable, background argument, and enabled registry item', () => {
  let configured;
  let verifiedWith;
  const app = packagedApp({
    setLoginItemSettings: (settings) => { configured = settings; },
    getLoginItemSettings: (settings) => {
      verifiedWith = settings;
      return { openAtLogin: true, executableWillLaunchAtLogin: true };
    }
  });
  const status = configureAutostart({ app, platform: 'win32', executablePath: 'C:\\Program Files\\Remote Care\\Remote Care.exe' });

  assert.equal(status.enabled, true);
  assert.deepEqual(configured.args, BACKGROUND_ARGUMENTS);
  assert.equal(configured.path, 'C:\\Program Files\\Remote Care\\Remote Care.exe');
  assert.equal(configured.enabled, true);
  assert.deepEqual(verifiedWith, { path: configured.path, args: BACKGROUND_ARGUMENTS });
});

test('macOS login startup is hidden by the app when the OS reports a login launch', () => {
  let configured;
  const app = packagedApp({
    setLoginItemSettings: (settings) => { configured = settings; },
    getLoginItemSettings: () => ({ status: 'enabled', wasOpenedAtLogin: true })
  });
  const status = configureAutostart({ app, platform: 'darwin' });

  assert.deepEqual(configured, { openAtLogin: true });
  assert.equal(status.enabled, true);
  assert.equal(startedInBackground({ app, platform: 'darwin', argumentsList: [] }), true);
  assert.equal(startedInBackground({ app, platform: 'win32', argumentsList: ['--background'] }), true);
});

test('source runs do not create persistent startup entries and registration errors are reported', () => {
  const sourceApp = packagedApp({ isPackaged: false });
  assert.deepEqual(configureAutostart({ app: sourceApp, platform: 'linux' }), {
    enabled: false,
    message: 'Available in installed builds only'
  });
  const failingApp = packagedApp({ setLoginItemSettings: () => { throw new Error('blocked by policy'); } });
  assert.deepEqual(configureAutostart({ app: failingApp, platform: 'win32' }), {
    enabled: false,
    message: 'Unable to register automatic startup: blocked by policy'
  });
});
