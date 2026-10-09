# Remote Care Monitor — Phase 2 Terminal POST APIs Summary of Updates

**Document Version:** 2.0
**Date:** October 8, 2026
**Application:** Remote Care Monitor (Phase 2)
**Repository:** `WII-TOOLS/remote-care`

---

## Executive Summary

Phase 2 of the Remote Care Monitor application has been updated with the complete specification, client dispatching logic, test server ingestion, and automated test coverage for both **Terminal POST APIs**:

1. **`POST /api/history` (or `/api/diagnostic/history`)** — Logged history of monitor result changes with state transition deduplication.
2. **`POST /api/sync` (or `/api/diagnostic/sync`)** — Periodic device telemetry and heartbeat with memory/storage metrics deduplication.

Both endpoints support authentication via `x-api-key: YOUR_DIAGNOSTIC_SECRET_KEY` or `Authorization: Bearer <TOKEN>`.

---

## 1. Terminal API 1: `POST /api/history`

### 1.1 Overview
Used by remote terminals to report monitor state changes (e.g. `healthy` ➔ `down`, or `down` ➔ `healthy`).

### 1.2 Deduplication Rule
* **Rule:** Automatically **skips saving duplicate records** if the monitor status remains continuously identical.
* **Storage Criteria:** Saves to the database **only on state changes or initial entry**. Duplicate entries are counted as skipped and are not duplicated in history storage.

### 1.3 HTTP Request Details
* **Method:** `POST`
* **URL Paths:** `/api/history` *(or `/api/diagnostic/history`)*
* **Headers:**
  * `Content-Type: application/json`
  * `x-api-key: YOUR_DIAGNOSTIC_SECRET_KEY` *(or `Authorization: Bearer <TOKEN>`)*
  * `User-Agent: RemoteCareMonitor-HistorySync/2.0`

### 1.4 JSON Request Payload Schema
```json
{
  "version": "2.0",
  "dispatchedAt": "2026-10-06T13:00:00.123Z",
  "clientHostname": "store-pi-terminal-01",
  "targetIds": "all",
  "entriesCount": 2,
  "history": [
    {
      "id": 1042,
      "targetId": "1",
      "targetName": "Billing Cloud API",
      "targetType": "http",
      "locationName": "Main Office",
      "checkedAt": "2026-10-06T12:56:15.000Z",
      "ok": false,
      "status": "down",
      "message": "HTTP 502 Bad Gateway from upstream service",
      "latencyMs": 1420,
      "details": {
        "statusCode": 502,
        "url": "https://api.example.com/v1/billing/health"
      }
    },
    {
      "id": 1043,
      "targetId": "2",
      "targetName": "Local Gateway Router",
      "targetType": "gateway",
      "locationName": "Main Office",
      "checkedAt": "2026-10-06T12:57:30.000Z",
      "ok": true,
      "status": "healthy",
      "message": "Local network gateway 192.168.1.1 is reachable.",
      "latencyMs": 4,
      "details": {
        "gatewayIp": "192.168.1.1"
      }
    }
  ]
}
```

### 1.5 Expected Server Response (`200 OK`)
```json
{
  "success": true,
  "message": "Ingestion processed successfully. Inserted 1 state transition(s), skipped 1 duplicate status entry(ies).",
  "inserted_count": 1,
  "skipped_count": 1,
  "total_processed": 2
}
```

---

## 2. Terminal API 2: `POST /api/sync`

### 2.1 Overview
Dispatched periodically (e.g. every 5 minutes) to send full device health, CPU, memory, uptime, and monitor count summaries.

### 2.2 Deduplication Rule
* **Rule:** Extracts memory and storage metrics from the heartbeat payload.
* **Storage Criteria:** Saves to database **only when storage/memory levels change** or cross warning thresholds (`usedPercent >= 85%`), skipping identical repeated heartbeats.

### 2.3 HTTP Request Details
* **Method:** `POST`
* **URL Paths:** `/api/sync` *(or `/api/diagnostic/sync`)*
* **Headers:**
  * `Content-Type: application/json`
  * `x-api-key: YOUR_DIAGNOSTIC_SECRET_KEY` *(or `Authorization: Bearer <TOKEN>`)*
  * `User-Agent: RemoteCareMonitor-CloudSync/2.0`

### 2.4 JSON Request Payload Schema
```json
{
  "version": "2.0",
  "dispatchedAt": "2026-10-06T13:00:00.000Z",
  "events": [
    {
      "id": 1,
      "eventType": "device.heartbeat",
      "createdAt": "2026-10-06T13:00:00.000Z",
      "payload": {
        "hostname": "store-pi-terminal-01",
        "platform": "linux",
        "arch": "arm64",
        "release": "6.6.20+rpt-rpi-2712",
        "uptimeSeconds": 864200,
        "processUptimeSeconds": 7200,
        "memory": {
          "totalMb": 8192,
          "freeMb": 4200,
          "usedMb": 3992,
          "usedPercent": 49
        },
        "loadAverage": [0.42, 0.35, 0.28],
        "cpuCores": 4,
        "monitorsSummary": {
          "total": 6,
          "healthy": 5,
          "warning": 1,
          "down": 0
        },
        "activeIncidentsCount": 0,
        "timestamp": "2026-10-06T13:00:00.000Z"
      }
    }
  ]
}
```

### 2.5 Expected Server Response (`200 OK`)
```json
{
  "ok": true,
  "received": 1,
  "timestamp": "2026-10-06T13:00:00.100Z"
}
```

---

## 3. Client & Server Implementation Details

### 3.1 Client Services
* **`HistorySyncService` (`src/main/history-sync.js`):**
  * Automatically injects `x-api-key` header alongside `Authorization: Bearer <token>` when a secret key or token is configured.
  * Captures and parses response body data (including `inserted_count` and `skipped_count`).
* **`CloudPublisher` (`src/main/cloud-publisher.js`):**
  * Automatically injects `x-api-key` header alongside `Authorization: Bearer <token>` for periodic event batches and heartbeats.
* **Renderer Settings UI (`src/renderer/app.js`):**
  * Updated **Server** configuration tab labels and descriptions to document `x-api-key` authentication and the alternate `/api/diagnostic/*` URL paths.

### 3.2 Test Remote Server (`scripts/test-remote-server.js`)
* **Multi-Route Ingestion:**
  * Route `/api/history` and `/api/diagnostic/history` (plus `/api/v1/history`).
  * Route `/api/sync` and `/api/diagnostic/sync` (plus `/api/v1/sync` and `/events`).
* **Dual Header Authentication:**
  * Implemented `isAuthorized` accepting either `x-api-key` matching `AUTH_TOKEN` or `Authorization: Bearer <AUTH_TOKEN>`.
* **State Transition Deduplication Engine:**
  * Uses a per-target status map (`targetStatusMap`) to distinguish initial entries and state transitions from identical consecutive states.
  * Formats response message: `"Ingestion processed successfully. Inserted X state transition(s), skipped Y duplicate status entry(ies)."`.
* **Telemetry Deduplication Engine:**
  * Uses a per-host metrics cache (`lastHeartbeatMetricsMap`) to evaluate RAM/storage percentage deltas and enforce the `>= 85%` warning threshold exception.
* **Server Factory Export:**
  * Exports `createTestServer` allowing isolated in-memory or programmatic server instantiation for tests.

---

## 4. Verification & Testing

The test suite in [`tests/phase2.test.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/tests/phase2.test.js) was extended with comprehensive end-to-end tests:
* Verification of `x-api-key` and `Authorization: Bearer` header construction.
* Verification of `/api/history` and `/api/diagnostic/history` deduplication (first batch insert, second batch transition vs duplicate status skip).
* Verification of `/api/sync` and `/api/diagnostic/sync` deduplication (initial save, identical skip, change save, `>= 85%` threshold trigger save).
* All **47 tests** across the entire project pass with 0 failures:
  * Unit & Check tests: 22 passed
  * Phase 2 & Server Integration tests: 25 passed

---

## 5. Modified Files Matrix

| File | Change Description |
|---|---|
| [`src/main/history-sync.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/src/main/history-sync.js) | Added `x-api-key` header and JSON response parsing. |
| [`src/main/cloud-publisher.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/src/main/cloud-publisher.js) | Added `x-api-key` header and JSON response parsing. |
| [`src/renderer/app.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/src/renderer/app.js) | Updated Server settings UI labels, placeholders, and helper text. |
| [`scripts/test-remote-server.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/scripts/test-remote-server.js) | Implemented deduplication logic for both endpoints, diagnostic paths, auth checking, and server factory. |
| [`history-payload-sample.json`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/history-payload-sample.json) | Aligned sample payload to exact 2-item terminal format. |
| [`SERVER_API_INTEGRATION_SPEC.txt`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/SERVER_API_INTEGRATION_SPEC.txt) | Updated complete integration specification with Python and Node.js examples. |
| [`remote-care-server.postman_collection.json`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/remote-care-server.postman_collection.json) | Added `apiKey` variable, `x-api-key` headers, and diagnostic requests. |
| [`tests/phase2.test.js`](file:///Users/admin/VSCODE/WII-TOOLS/remote-care/tests/phase2.test.js) | Added automated tests for headers, deduplication rules, and responses. |
