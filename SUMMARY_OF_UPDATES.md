# Remote Care Monitor — Phase 2 Terminal POST APIs Summary of Updates

**Document Version:** 2.1
**Date:** October 10, 2026
**Application:** Remote Care Monitor (Phase 2 Commissioning Update)
**Repository:** `WII-TOOLS/remote-care`

---

## Executive Summary

The Remote Care Monitor application has been updated to fully align with the **Commissioning Specification** for both Terminal POST APIs:

1. **Authentication & Base Configuration**:
   * **Base URL**: `http://<YOUR_SERVER_IP>:3999`
   * **Content-Type**: `application/json`
   * **API Key Header**: `x-api-key: Wiitronics_diagnostic` (or configured secret key)
2. **API 1: `POST /api/history` (Monitor Status Changes)**:
   * Reports monitor status checks and state transitions (`healthy`, `warning`, `down`).
   * Adheres to exact commissioning schema with assigned `targetId` (UUID string), `targetType` (`http`, `icmp`, `gateway`, `rtsp`, `disk`), `clientHostname`, `latencyMs`, and `details` containing `service_uuid`, `device_uuid`, and `ip`.
3. **API 2: `POST /api/sync` (Heartbeat & System Telemetry)**:
   * Periodic terminal heartbeats (every 1 to 5 minutes) containing CPU, memory, uptime, system health, and commissioning identifiers (`hostname`, `service_uuid`, `device_uuid`, `monitorsSummary`, `activeIncidentsCount`).
4. **Expected Responses**:
   * **Success (`200 OK`)**:
     ```json
     {
       "success": true,
       "message": "Ingestion processed successfully.",
       "inserted_count": 1,
       "skipped_count": 0,
       "total_processed": 1
     }
     ```
   * **Invalid Key Error (`401 Unauthorized`)**:
     ```json
     {
       "success": false,
       "error": "Unauthorized: Invalid API Key"
     }
     ```

---

## 1. Authentication & Base Configuration

| Parameter | Specification | Implementation in App |
| :--- | :--- | :--- |
| **Base URL** | `http://<YOUR_SERVER_IP>:3999` | Default test server port set to `3999`; UI placeholders and dynamic derivation updated to `:3999`. |
| **Content-Type** | `application/json` | Enforced in `HistorySyncService`, `CloudPublisher`, and test server. |
| **API Key Header** | `x-api-key: Wiitronics_diagnostic` (or your configured secret key) | Default fallback key is `Wiitronics_diagnostic`. Both `x-api-key` and `Authorization: Bearer <key>` headers are sent with requests. |

---

## 2. API 1: `POST /api/history` (Monitor Status Changes)

* **Endpoint URL**: `http://<YOUR_SERVER_IP>:3999/api/history`
* **HTTP Method**: `POST`
* **Headers**:
  ```http
  Content-Type: application/json
  x-api-key: Wiitronics_diagnostic
  ```

### JSON Request Body Schema
```json
{
  "version": "2.0",
  "dispatchedAt": "2026-10-10T12:00:00.000Z",
  "clientHostname": "YOUR_TERMINAL_HOSTNAME",
  "targetIds": "all",
  "entriesCount": 1,
  "history": [
    {
      "id": 1,
      "targetId": "ASSIGNED_DEVICE_OR_SERVICE_UUID",
      "targetName": "YOUR_SERVICE_OR_DEVICE_NAME",
      "targetType": "http",
      "locationName": "YOUR_LOCATION_NAME",
      "checkedAt": "2026-10-10T12:00:00.000Z",
      "ok": true,
      "status": "healthy",
      "message": "Service responding normally",
      "latencyMs": 25,
      "details": {
        "service_uuid": "ASSIGNED_SERVICE_UUID",
        "device_uuid": "ASSIGNED_DEVICE_UUID",
        "ip": "192.168.1.100"
      }
    }
  ]
}
```

### Key Field Mappings
* `clientHostname`: Configured terminal hostname (`terminalHostname` setting, falling back to OS hostname).
* `history[].targetId`: String representing the UUID assigned during commissioning (e.g. `874a7759-40ff-4a13-8b32-5d5e6bf2455b`).
* `history[].targetType`: Monitor type (`http`, `icmp`, `gateway`, `rtsp`, `disk`). `ping` checks are normalized to `icmp`.
* `history[].details.service_uuid`: Specific monitor service UUID or site-wide commissioned service UUID.
* `history[].details.device_uuid`: Specific monitor device UUID or site-wide commissioned device UUID.
* `history[].details.ip`: Assigned or resolved IP address of the target.

---

## 3. API 2: `POST /api/sync` (Heartbeat & System Telemetry)

* **Endpoint URL**: `http://<YOUR_SERVER_IP>:3999/api/sync`
* **HTTP Method**: `POST`
* **Headers**:
  ```http
  Content-Type: application/json
  x-api-key: Wiitronics_diagnostic
  ```

### JSON Request Body Schema
```json
{
  "version": "2.0",
  "dispatchedAt": "2026-10-10T12:00:00.000Z",
  "events": [
    {
      "id": 1,
      "eventType": "device.heartbeat",
      "createdAt": "2026-10-10T12:00:00.000Z",
      "payload": {
        "hostname": "YOUR_TERMINAL_HOSTNAME",
        "platform": "linux",
        "arch": "arm64",
        "uptimeSeconds": 86400,
        "processUptimeSeconds": 3600,
        "memory": {
          "totalMb": 8192,
          "freeMb": 4096,
          "usedMb": 4096,
          "usedPercent": 50.0
        },
        "loadAverage": [0.2, 0.15, 0.1],
        "cpuCores": 4,
        "monitorsSummary": {
          "total": 4,
          "healthy": 4,
          "warning": 0,
          "down": 0
        },
        "activeIncidentsCount": 0,
        "service_uuid": "ASSIGNED_SERVICE_UUID",
        "device_uuid": "ASSIGNED_DEVICE_UUID",
        "timestamp": "2026-10-10T12:00:00.000Z"
      }
    }
  ]
}
```

---

## 4. Expected Responses & Deduplication

### Success Response (`200 OK`)
```json
{
  "success": true,
  "message": "Ingestion processed successfully.",
  "inserted_count": 1,
  "skipped_count": 0,
  "total_processed": 1
}
```

### Invalid Key Error (`401 Unauthorized`)
```json
{
  "success": false,
  "error": "Unauthorized: Invalid API Key"
}
```

---

## 5. Modified Files Matrix

| File | Change Description |
|---|---|
| [`src/main/database.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/src/main/database.js) | Added `icmp` and `rtsp` to `CHECK_TYPES`; added `terminalHostname`, `serviceUuid`, and `deviceUuid` to settings; updated `mapTarget`, `validateTarget`, and `getHistoryChanges` to inject commissioning UUIDs, normalize `targetType` to `icmp`, and include `service_uuid`, `device_uuid`, and `ip` in `details`. |
| [`src/main/checks.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/src/main/checks.js) | Added support for `icmp` (alias of ICMP ping) and `rtsp` (RTSP stream TCP probe) in `executeCheck`. |
| [`src/main/heartbeat.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/src/main/heartbeat.js) | Updated `collectTelemetry` to use configured terminal hostname, include `service_uuid` and `device_uuid`, and populate `monitorsSummary` (`total`, `healthy`, `warning`, `down`). |
| [`src/main/history-sync.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/src/main/history-sync.js) | Default auth token set to `Wiitronics_diagnostic`; uses configured `clientHostname`; converts `targetId` to string UUID; guarantees `x-api-key` header dispatch. |
| [`src/main/cloud-publisher.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/src/main/cloud-publisher.js) | Default auth token set to `Wiitronics_diagnostic`; guarantees `x-api-key` header dispatch. |
| [`src/renderer/app.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/src/renderer/app.js) | Updated Server configuration UI with Port `3999` placeholders, default `Wiitronics_diagnostic` key, and inputs for `terminalHostname`, `serviceUuid`, and `deviceUuid`. Added commissioning UUID inputs and `icmp`/`rtsp` types in the Add/Edit Monitor dialog. |
| [`scripts/test-remote-server.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/scripts/test-remote-server.js) | Changed default port to `3999`; default auth token to `Wiitronics_diagnostic`; updated 401 response to `{ success: false, error: 'Unauthorized: Invalid API Key' }` and 200 response to `{ success: true, message: 'Ingestion processed successfully.', inserted_count, skipped_count, total_processed }`. |
| [`history-payload-sample.json`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/history-payload-sample.json) | Updated to exact commissioning sample specification. |
| [`tests/database.test.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/tests/database.test.js) | Updated `appSettings` assertions with new commissioning fields. |
| [`tests/phase2.test.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/tests/phase2.test.js) | Updated response shape assertions and added end-to-end commissioning payload verification tests. |
