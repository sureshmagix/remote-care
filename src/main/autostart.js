const fs = require('node:fs');
const path = require('node:path');

const BACKGROUND_ARGUMENTS = ['--background'];
const LINUX_AUTOSTART_FILE = 'remote-care-monitor.desktop';

function desktopExecArgument(value) {
  return `"${String(value).replace(/([\\"])/g, '\\$1')}"`;
}

function linuxAutostartDirectory(app, environment, pathApi) {
  const configuredDirectory = environment.XDG_CONFIG_HOME;
  const configHome = configuredDirectory && pathApi.isAbsolute(configuredDirectory)
    ? configuredDirectory
    : pathApi.join(app.getPath('home'), '.config');
  return pathApi.join(configHome, 'autostart');
}

function linuxDesktopEntry(executablePath) {
  return `[Desktop Entry]\nVersion=1.0\nType=Application\nName=Remote Care Monitor\nComment=Local network and service monitor\nExec=${desktopExecArgument(executablePath)} --background\nTerminal=false\nStartupNotify=false\nHidden=false\nX-GNOME-Autostart-enabled=true\nX-GNOME-Autostart-Phase=Application\nX-GNOME-Autostart-Delay=0\nX-KDE-autostart-after=panel\n`;
}

function disabledStatus(message) {
  return { enabled: false, message };
}

function configureAutostart({
  app,
  platform = process.platform,
  environment = process.env,
  executablePath = process.execPath,
  fsApi = fs,
  pathApi = path
} = {}) {
  if (!app) throw new Error('An Electron app instance is required to configure automatic startup.');
  if (!app.isPackaged) return disabledStatus('Available in installed builds only');

  try {
    if (platform === 'win32') {
      const settings = {
        openAtLogin: true,
        path: executablePath,
        args: BACKGROUND_ARGUMENTS,
        enabled: true,
        name: 'Remote Care Monitor'
      };
      app.setLoginItemSettings(settings);
      const current = app.getLoginItemSettings({ path: executablePath, args: BACKGROUND_ARGUMENTS });
      const enabled = current.openAtLogin === true || current.executableWillLaunchAtLogin === true;
      return enabled
        ? { enabled: true, message: 'Enabled — starts after Windows sign-in' }
        : disabledStatus('Windows has disabled this startup item');
    }

    if (platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: true });
      const current = app.getLoginItemSettings();
      const enabled = current.status === 'enabled' || current.openAtLogin === true;
      return enabled
        ? { enabled: true, message: 'Enabled — starts after macOS sign-in' }
        : disabledStatus(current.status === 'requires-approval'
          ? 'macOS approval is required in System Settings → Login Items'
          : 'macOS did not enable the login item');
    }

    if (platform === 'linux') {
      const autostartDirectory = linuxAutostartDirectory(app, environment, pathApi);
      const desktopFile = pathApi.join(autostartDirectory, LINUX_AUTOSTART_FILE);
      // AppImage uses this variable to point at the persistent package rather than
      // its temporary mounted runtime path.
      const launchPath = environment.APPIMAGE || executablePath;
      fsApi.mkdirSync(autostartDirectory, { recursive: true, mode: 0o755 });
      fsApi.writeFileSync(desktopFile, linuxDesktopEntry(launchPath), { encoding: 'utf8', mode: 0o644 });
      return { enabled: true, message: 'Enabled — starts with your graphical desktop session' };
    }

    return disabledStatus('Automatic startup is not supported on this platform');
  } catch (error) {
    return disabledStatus(`Unable to register automatic startup: ${error.message}`);
  }
}

function startedInBackground({ app, platform = process.platform, argumentsList = process.argv } = {}) {
  if (argumentsList.includes('--background')) return true;
  if (platform !== 'darwin' || !app?.isPackaged) return false;

  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true;
  } catch {
    return false;
  }
}

module.exports = {
  BACKGROUND_ARGUMENTS,
  LINUX_AUTOSTART_FILE,
  configureAutostart,
  desktopExecArgument,
  linuxAutostartDirectory,
  linuxDesktopEntry,
  startedInBackground
};
