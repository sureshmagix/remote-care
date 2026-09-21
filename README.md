# Remote Care Monitor — Phase 1

Remote Care Monitor is a local-first desktop monitoring application for Windows, macOS, Ubuntu and Raspberry Pi OS. It runs in the notification area, stores all data on the local device, and supports one Super Admin plus up to five Viewer accounts.

## Phase 1 capabilities

- Background tray application with automatic launch at sign-in.
- Local Super Admin setup and Viewer-only accounts.
- Connectivity monitoring: Wi-Fi/Ethernet link, default gateway and external internet.
- Configurable ICMP ping, TCP port, HTTP/HTTPS, system-service and process checks.
- Timestamped desktop alerts for every monitor status transition, including initial health, warnings, failures, and recoveries, with deduplication and per-alert toggles in Settings.
- Local SQLite dashboard, timestamped incident/check history, response timings, and audit log.
- Queue table ready for Phase 2 HTTPS or MQTT cloud publishing; Phase 1 never transmits data.

## Important behavior

The application uses its own desktop notification window on Windows, macOS, and Linux desktops, including Ubuntu and Raspberry Pi OS. Alerts appear while the dashboard is open or hidden in the tray, include the event's local date and time and a close button, and automatically hide after **5 seconds**. Bursts are queued so each alert receives its full display time; unchanged check results do not repeat alerts. The popup opens without taking focus and offers an **Open dashboard** button. Minimizing or closing the dashboard always hides it to the system tray and shows a dismissible reminder that monitoring continues in the background. Selecting **Quit Remote Care Monitor…** from the tray, or **Quit app…** in Settings, opens a password prompt; only the current Super Admin password can stop monitoring.

The Super Admin can open **Settings → Alert notifications → Notification duration (seconds)** to choose a whole number from **1–300 seconds**. This saved duration applies to new desktop alerts, tray reminders, and in-app toasts, and hovering does not extend it. Settings also independently control the tray reminder, failure/warning alerts, and healthy/recovery alerts. Alerts are enabled by default. Turning off an alert suppresses its popup; its local event history remains visible on the dashboard.

Desktop stacking and placement depend on the window manager; [Electron cannot enforce always-on-top positioning on Wayland](https://www.electronjs.org/docs/latest/api/browser-window#winsetalwaysontopflag-level-relativelevel). If the popup renderer fails, the app attempts a native notification with the same timestamp and a timed close request, whose presentation is controlled by the operating system. A graphical desktop session is required.

Every completed monitor check is stored in the local SQLite database with a UTC timestamp to millisecond precision and is shown in the dashboard in the device's local date, time, and time zone. The **History** page can filter recorded checks by date/time range, monitor, monitor type, outcome, recorded status, and monitor/message text. The tray menu also shows its local update time and the most recent recorded check.

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
