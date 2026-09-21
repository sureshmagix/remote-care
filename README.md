# Remote Care Monitor — Phase 1

Remote Care Monitor is a local-first desktop monitoring application for Windows, macOS, Ubuntu and Raspberry Pi OS. It runs in the notification area, stores all data on the local device, and supports one Super Admin plus up to five Viewer accounts.

## Phase 1 capabilities

- Background tray application with automatic launch at sign-in.
- Local Super Admin setup and Viewer-only accounts.
- Connectivity monitoring: Wi-Fi/Ethernet link, default gateway and external internet.
- Configurable ICMP ping, TCP port, HTTP/HTTPS, system-service and process checks.
- Native desktop alerts for failures and recoveries, with alert deduplication.
- Local SQLite dashboard, incident history, response timings, and audit log.
- Queue table ready for Phase 2 HTTPS or MQTT cloud publishing; Phase 1 never transmits data.

## Important behavior

The application uses native operating-system notifications. Their exact screen position is controlled by Windows, macOS or the Linux desktop environment. The tray application remains running when the dashboard window is closed; select **Quit** from the tray menu to stop it.

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

## Architecture

```text
Electron main process
  ├── Local SQLite database
  ├── Monitor scheduler
  │     ├── Network adapters / gateway
  │     ├── Internet / HTTP / TCP / ICMP checks
  │     └── Local service / process checks
  ├── Native notification and tray layer
  └── Secure preload IPC bridge
          └── Local dashboard renderer
```

## Test and validation

```bash
npm test
npm run lint
```

## Phase 2 placeholder

Every changed status is added to a local `outbound_events` table. No network publishing code is enabled in Phase 1. Phase 2 can read this durable queue and send only approved status events through HTTPS or MQTT with device-specific credentials.
# remote-care
