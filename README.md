# Remote Care Monitor — Phase 1

Remote Care Monitor is a local-first desktop monitoring application for Windows, macOS, Ubuntu and Raspberry Pi OS. It runs in the notification area, stores all data on the local device, and supports one Super Admin plus up to five Viewer accounts.

## Phase 1 capabilities

- Background tray application with automatic launch at sign-in.
- Local Super Admin setup and Viewer-only accounts.
- Connectivity monitoring: Wi-Fi/Ethernet link, default gateway and external internet.
- Configurable ICMP ping, TCP port, HTTP/HTTPS, system-service and process checks.
- A required location name on every monitor, shown in monitor lists, incidents, alerts, history, and reports.
- Timestamped desktop alerts for every monitor status transition, including initial health, warnings, failures, and recoveries, with deduplication and per-alert toggles in Settings.
- Local SQLite dashboard, timestamped incident/check history, response timings, audit log, and monthly CSV report export.
- Queue table ready for Phase 2 HTTPS or MQTT cloud publishing; Phase 1 never transmits data.

## Important behavior

The application uses the same app-rendered desktop notification window on Windows, macOS, Ubuntu, and Raspberry Pi OS, so alerts have the same styling, actions, timeout, and top-right placement. On Ubuntu Wayland sessions, it uses Xwayland when available because Wayland does not allow Electron to position popup windows. Native Electron/libnotify delivery, with the packaged Remote Care icon, is retained only if the popup renderer fails. Alerts include the event's local date and time and automatically hide after **5 seconds**. Bursts are queued so each alert receives its full display time; unchanged check results do not repeat alerts. Minimizing or closing the dashboard always hides it to the system tray and shows a dismissible reminder that monitoring continues in the background. Selecting **Quit Remote Care Monitor…** from the tray, or **Quit app…** in Settings, opens a password prompt; only the current Super Admin password can stop monitoring.

The Super Admin can open **Settings → Alert notifications → Notification duration (seconds)** to choose a whole number from **1–300 seconds**. This saved duration applies to new desktop alerts, tray reminders, and in-app toasts, and hovering does not extend it. Settings also independently control the tray reminder, failure/warning alerts, and healthy/recovery alerts. Alerts are enabled by default. Turning off an alert suppresses its popup; its local event history remains visible on the dashboard.

Desktop stacking and placement depend on the window manager; [Electron cannot enforce window positioning on Wayland](https://www.electronjs.org/docs/latest/api/browser-window#platform-notices), so the app uses Xwayland when it is available. If an app-rendered popup cannot load, the app attempts a native notification with the same timestamp and a timed close request. A graphical desktop session is required.

The first monitor result and every later material change in outcome, status, message, or stable result details are stored in the local SQLite database with a UTC timestamp to millisecond precision. Response-time variation and volatile diagnostics such as command output, timestamps, and process IDs do **not** create another history row; the live monitor status and latency still update on every completed check. Version 1.1.2 also upgrades existing fingerprints so an unchanged monitor does not create a one-time duplicate immediately after the update. The **History** page can filter recorded changes by date/time range, location, monitor, monitor type, outcome, recorded status, and text, and can export any selected month as a local CSV report. The tray menu also shows its local update time and the most recent completed check.

Each app run is recorded locally. If a prior run did not get a clean, password-authorized shutdown—for example, because the process was terminated—the next launch records it as an unexpected shutdown and surfaces it in **About this device**. An ordinary desktop app cannot prevent an operating-system administrator from ending its process or reliably restart itself after a force kill. For managed, organization-owned devices that require automatic recovery after termination, deploy the monitor under an approved OS service/watchdog and device-management policy.

An ICMP ping is not a universal availability test because some devices intentionally block ping. Use **TCP Port** or **HTTP/HTTPS** when a reachable application service is what matters.

## Install and run

Install Node.js 22 or later, then run:

```bash
npm install
npm start
```

The first launch asks you to create the Super Admin account. Closing the window hides it into the tray.

## Packaging

Build installers on the corresponding operating system and CPU architecture:

```bash
npm run dist
```

Outputs are written to `release/`.

| Platform | Typical command | Output |
| --- | --- | --- |
| Windows x64 | `npm run dist` | NSIS installer and portable `.exe` |
| macOS Intel / Apple Silicon | `npm run dist` | `.dmg` and `.zip` |
| Ubuntu x64 | `npm run dist` | `.deb` and AppImage |
| Raspberry Pi OS 64-bit | `npm run dist` | ARM64 `.deb` and AppImage |

For a Raspberry Pi without a graphical desktop, Electron cannot show local notifications. The reusable monitoring core can later be run as a system service and publish to the Phase 2 cloud endpoint.

## Install from GitHub Releases

Download the installer for the computer from the [GitHub Releases page](https://github.com/sureshmagix/remote-care/releases). The commands below use the current `1.1.2` asset names; use the matching version in a newer release.

### Windows x64

Download **`Remote Care Monitor Setup 1.1.2.exe`**, run it, and follow the installer prompts. It supports choosing the installation directory. To run without installing, download **`Remote Care Monitor 1.1.2.exe`** instead and launch it directly.

### macOS

Download the disk image that matches the Mac processor:

| Mac | Download |
| --- | --- |
| Apple Silicon (M1/M2/M3/M4) | `Remote Care Monitor-1.1.2-arm64.dmg` |
| Intel | `Remote Care Monitor-1.1.2.dmg` |

Open the `.dmg`, drag **Remote Care Monitor** to **Applications**, then launch it from Applications. If macOS blocks the unsigned build after you have chosen to trust it, remove its quarantine flag in Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Remote Care Monitor.app"
```

### Ubuntu / Debian Linux x64

Confirm that the computer is `amd64`, download **`remote-care-phase1_1.1.2_amd64.deb`** from GitHub Releases, then install it from the download directory:

```bash
dpkg --print-architecture
cd ~/Downloads
sudo apt install ./remote-care-phase1_1.1.2_amd64.deb
```

Start **Remote Care Monitor** from the desktop application menu. To upgrade, download the newer `.deb` and run the same `sudo apt install ./...deb` command.

If installing a `.deb` is not suitable, use the portable **`Remote Care Monitor-1.1.2.AppImage`** instead:

```bash
cd ~/Downloads
chmod +x "Remote Care Monitor-1.1.2.AppImage"
./"Remote Care Monitor-1.1.2.AppImage"
```

### Raspberry Pi OS 64-bit

This build is for **Raspberry Pi OS 64-bit with a graphical desktop**. Raspberry Pi OS Lite/headless systems and 32-bit Raspberry Pi OS are not supported by the Electron desktop app. Confirm the architecture is `aarch64`, download **`remote-care-phase1_1.1.2_arm64.deb`**, and install it:

```bash
uname -m
cd ~/Downloads
sudo apt update
sudo apt install ./remote-care-phase1_1.1.2_arm64.deb
```

Launch **Remote Care Monitor** from the Raspberry Pi desktop menu. To use the portable ARM64 package instead:

```bash
cd ~/Downloads
chmod +x "Remote Care Monitor-1.1.2-arm64.AppImage"
./"Remote Care Monitor-1.1.2-arm64.AppImage"
```

The app must run in a graphical desktop session for its dashboard, tray icon, and desktop alerts. For a headless Pi, run monitoring through an approved service/watchdog deployment instead.

## Start automatically after a reboot

After the installed application is opened once, it registers itself to start automatically when that user next signs in. It starts hidden in the tray and resumes monitoring without opening the dashboard.

- Windows: an enabled per-user Startup item is created for the installed executable.
- macOS: a Login Item is registered. If **About this device → Automatic startup** says approval is required, enable Remote Care Monitor in **System Settings → General → Login Items**.
- Ubuntu and Raspberry Pi OS with a graphical desktop: the app creates `~/.config/autostart/remote-care-monitor.desktop` (or `$XDG_CONFIG_HOME/autostart/...`) and starts at the next desktop-session login. AppImage installations use the persistent AppImage path.

The **About this device** page reports whether registration succeeded, so it can be checked before rebooting. This is a desktop-session startup feature: the Electron dashboard, tray, and alerts cannot start before a user signs in or on Raspberry Pi OS Lite/headless systems.

## Check types

| Type | Use it for |
| --- | --- |
| Internet | DNS and HTTPS connectivity to a configurable endpoint |
| Network interface | Wi-Fi or wired adapter link state |
| Default gateway | Local router reachability |
| ICMP ping | A device that explicitly supports ICMP |
| TCP port | MQTT, SSH, database, or another listening service |
| HTTP/HTTPS | API health endpoints and web applications |
| Local system service | Windows Service, Linux systemd, or macOS launchd service |
| Local process | A named process that must be running |

## Security model

- Passwords use per-user salt plus Node.js `scrypt` hashing; plain passwords are never written to disk.
- The main Electron process owns the database and monitoring engine. The UI can only use an explicit, validated preload bridge.
- Electron uses `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderers, and no remote module.
- Viewer users can view status and history only. The Super Admin controls monitors, users, and application settings.
- Application roles do not stop a Windows Administrator, macOS administrator, or Linux root user from altering files on the same computer.
- A force kill cannot be logged at the moment it occurs; it is detected and recorded on the next successful app start.

## Architecture

```text
Electron main process
  ├── Local SQLite database
  ├── Monitor scheduler
  │     ├── Network adapters / gateway
  │     ├── Internet / HTTP / TCP / ICMP checks
  │     └── Local service / process checks
  ├── Timed desktop notification queue and tray layer
  └── Secure preload IPC bridge
          └── Local dashboard renderer
```

## Test and validation

```bash
npm test
npm run lint
```

On a graphical desktop, `npm run test:notifications-ui` opens isolated test popups and checks timestamps, layout, the close button, default expiry, and a custom duration. It saves a screenshot to a temporary directory and does not open the app database or start monitoring. Run this smoke check on each target operating system when validating a release.

## Phase 2 placeholder

Every changed status is added to a local `outbound_events` table. No network publishing code is enabled in Phase 1. Phase 2 can read this durable queue and send only approved status events through HTTPS or MQTT with device-specific credentials.
# remote-care
