const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { buildWebhookPayload } = require('../src/main/webhooks');
const { HeartbeatService } = require('../src/main/heartbeat');
const { CloudPublisher } = require('../src/main/cloud-publisher');
const { HistorySyncService } = require('../src/main/history-sync');
const { LocalDatabase } = require('../src/main/database');

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-care-phase2-test-'));
  const database = new LocalDatabase(path.join(directory, 'test.sqlite'));
  return { database, directory };
}

test('webhook payload builder creates valid structures for all providers', () => {
  const event = {
    title: 'Monitor alert: Production API',
    subtitle: 'Down',
    body: 'Connection timeout after 3000ms',
    kind: 'down',
    timestamp: new Date().toISOString()
  };

  // Slack
  const slack = buildWebhookPayload('slack', event);
  assert.equal(typeof slack.text, 'string');
  assert.equal(Array.isArray(slack.attachments), true);
  assert.equal(slack.attachments[0].color, '#ef4444');

  // Discord
  const discord = buildWebhookPayload('discord', event);
  assert.equal(Array.isArray(discord.embeds), true);
  assert.equal(discord.embeds[0].title, event.title);

  // Teams
  const teams = buildWebhookPayload('teams', event);
  assert.equal(teams['@type'], 'MessageCard');
  assert.equal(Array.isArray(teams.sections), true);

  // Telegram
  const telegram = buildWebhookPayload('telegram', event);
  assert.equal(telegram.parse_mode, 'Markdown');
  assert.match(telegram.text, /🔔/);

  // Generic
  const generic = buildWebhookPayload('generic', event);
  assert.equal(generic.source, 'remote-care-monitor');
  assert.equal(generic.event, 'down');
});

test('heartbeat service collects system telemetry and queues device.heartbeat event', async () => {
  const { database, directory } = temporaryDatabase();
  try {
    const heartbeat = new HeartbeatService({ database });
    assert.equal(database.getPendingOutboundCount(), 0);

    const payload = heartbeat.sendHeartbeat();
    assert.equal(database.getPendingOutboundCount(), 1);
    assert.equal(typeof payload.hostname, 'string');
    assert.equal(typeof payload.memory.totalMb, 'number');
    assert.equal(typeof payload.uptimeSeconds, 'number');

    const pending = database.getPendingOutboundEvents(10);
    assert.equal(pending[0].event_type, 'device.heartbeat');
    const parsed = JSON.parse(pending[0].payload_json);
    assert.equal(parsed.hostname, payload.hostname);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('cloud publisher drains outbound events batch and updates delivery records', async () => {
  const { database, directory } = temporaryDatabase();
  try {
    database.enqueueEvent('test.event.one', { item: 1 });
    database.enqueueEvent('test.event.two', { item: 2 });
    assert.equal(database.getPendingOutboundCount(), 2);

    let publishedBatches = [];
    const publisher = new CloudPublisher({
      database,
      getSettings: () => ({ cloudSyncEnabled: true, cloudHttpsUrl: 'https://test.example.com/api' })
    });
    // Mock sendBatch
    publisher.sendBatch = async (url, token, payload) => {
      publishedBatches.push(payload);
      return { ok: true, statusCode: 200 };
    };

    const result = await publisher.publishPending(10);
    assert.equal(result.publishedCount, 2);
    assert.equal(database.getPendingOutboundCount(), 0);
    assert.equal(publishedBatches.length, 1);
    assert.equal(publishedBatches[0].events.length, 2);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('cloud publisher derives sync URL from serverBaseUrl', () => {
  const { database, directory } = temporaryDatabase();
  try {
    const publisher = new CloudPublisher({
      database,
      getSettings: () => ({ serverBaseUrl: 'http://192.168.1.100:3000/' })
    });
    assert.equal(publisher.getEndpointUrl(), 'http://192.168.1.100:3000/api/sync');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('heartbeat service respects telemetrySelection filtering', () => {
  const { database, directory } = temporaryDatabase();
  try {
    let currentSelection = 'system_metrics';
    const heartbeat = new HeartbeatService({
      database,
      getSettings: () => ({ telemetrySelection: currentSelection })
    });

    const sysTelemetry = heartbeat.collectTelemetry();
    assert.ok(sysTelemetry.memory);
    assert.ok(sysTelemetry.uptimeSeconds !== undefined);
    assert.equal(sysTelemetry.monitorsSummary, undefined);
    assert.equal(sysTelemetry.activeIncidentsCount, undefined);

    currentSelection = 'monitors_only';
    const monTelemetry = heartbeat.collectTelemetry();
    assert.ok(monTelemetry.monitorsSummary);
    assert.equal(monTelemetry.memory, undefined);
    assert.equal(monTelemetry.loadAverage, undefined);

    currentSelection = 'minimal';
    const minTelemetry = heartbeat.collectTelemetry();
    assert.ok(minTelemetry.status);
    assert.equal(minTelemetry.monitorsSummary, undefined);
    assert.equal(minTelemetry.memory, undefined);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('history sync service derives endpoint from serverBaseUrl or uses explicit historySyncUrl', () => {
  const { database, directory } = temporaryDatabase();
  try {
    const service1 = new HistorySyncService({
      database,
      getSettings: () => ({ serverBaseUrl: 'http://localhost:3000/' })
    });
    assert.equal(service1.getEndpointUrl(), 'http://localhost:3000/api/history');

    const service2 = new HistorySyncService({
      database,
      getSettings: () => ({
        serverBaseUrl: 'http://localhost:3000',
        historySyncUrl: 'https://custom-analytics.example.com/ingest'
      })
    });
    assert.equal(service2.getEndpointUrl(), 'https://custom-analytics.example.com/ingest');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('database.getHistoryChanges retrieves changes filtered by targetIds and sinceId', () => {
  const { database, directory } = temporaryDatabase();
  try {
    const admin = database.createInitialAdmin({ username: 'admin', displayName: 'Admin', password: 'password-123' });
    const t1 = database.saveTarget({ name: 'Web 1', type: 'http', url: 'https://web1.test', intervalSeconds: 5, timeoutMs: 1000, failureThreshold: 1, recoveryThreshold: 1, severity: 'critical', downMessage: 'Down', recoveryMessage: 'Up', enabled: true }, admin.id);
    const t2 = database.saveTarget({ name: 'Web 2', type: 'http', url: 'https://web2.test', intervalSeconds: 5, timeoutMs: 1000, failureThreshold: 1, recoveryThreshold: 1, severity: 'critical', downMessage: 'Down', recoveryMessage: 'Up', enabled: true }, admin.id);

    database.recordCheck(t1.id, { ok: true, status: 'healthy', latencyMs: 20, message: 'OK' });
    database.recordCheck(t2.id, { ok: true, status: 'healthy', latencyMs: 30, message: 'OK' });
    database.recordCheck(t1.id, { ok: false, status: 'down', latencyMs: 50, message: 'Refused' });

    // All monitors
    const allChanges = database.getHistoryChanges();
    assert.equal(allChanges.length, 3);
    assert.equal(allChanges[0].targetName, 'Web 1');
    assert.equal(allChanges[1].targetName, 'Web 2');
    assert.equal(allChanges[2].status, 'down');

    // Filter by specific targetId (only t1)
    const t1Only = database.getHistoryChanges({ targetIds: [t1.id] });
    assert.equal(t1Only.length, 2);
    assert.ok(t1Only.every((c) => c.targetId === t1.id));

    // Filter by sinceId
    const firstId = allChanges[0].id;
    const sinceFirst = database.getHistoryChanges({ sinceId: firstId });
    assert.equal(sinceFirst.length, 2);
    assert.ok(sinceFirst.every((c) => c.id > firstId));
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('history sync service builds preview and sends batch updating cursor', async () => {
  const { database, directory } = temporaryDatabase();
  try {
    const admin = database.createInitialAdmin({ username: 'admin', displayName: 'Admin', password: 'password-123' });
    const t1 = database.saveTarget({ name: 'Gateway', type: 'gateway', intervalSeconds: 5, timeoutMs: 1000, failureThreshold: 1, recoveryThreshold: 1, severity: 'warning', downMessage: 'Down', recoveryMessage: 'Up', enabled: true }, admin.id);
    const t2 = database.saveTarget({ name: 'DB Ping', type: 'ping', host: '10.0.0.1', intervalSeconds: 5, timeoutMs: 1000, failureThreshold: 1, recoveryThreshold: 1, severity: 'critical', downMessage: 'Down', recoveryMessage: 'Up', enabled: true }, admin.id);

    database.recordCheck(t1.id, { ok: true, status: 'healthy', latencyMs: 2, message: 'Reach' });
    database.recordCheck(t2.id, { ok: false, status: 'warning', latencyMs: 10, message: 'High' });

    const service = new HistorySyncService({
      database,
      getSettings: () => ({
        historySyncEnabled: true,
        serverBaseUrl: 'http://localhost:3000',
        historySyncIntervalMinutes: 5,
        historySyncTargetIds: `${t1.id}` // only t1 selected
      })
    });

    // Preview recent changes
    const preview = service.buildPayload({ previewRecent: true });
    assert.equal(preview.version, '2.0');
    assert.equal(preview.entriesCount, 1);
    assert.equal(preview.history[0].targetId, String(t1.id));

    // Mock sendPayload
    let sentBatch = null;
    service.sendPayload = async (url, token, payload) => {
      sentBatch = payload;
      return { ok: true, statusCode: 200 };
    };

    // Initial sync
    const syncRes = await service.syncNow();
    assert.equal(syncRes.ok, true);
    assert.equal(syncRes.sentCount, 1);
    assert.equal(sentBatch.history.length, 1);
    assert.equal(sentBatch.history[0].targetName, 'Gateway');

    // Cursor should now be updated in database
    const cursor = database.getHistorySyncCursor();
    assert.equal(cursor.lastId, sentBatch.history[0].id);
    assert.ok(cursor.lastSyncAt);

    // Subsequent sync without new changes will produce 0 new entries
    const nextSync = await service.syncNow();
    assert.equal(nextSync.ok, true);
    assert.equal(nextSync.sentCount, 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('history sync service and cloud publisher build headers with x-api-key alongside Authorization Bearer', async () => {
  const { database, directory } = temporaryDatabase();
  try {
    let capturedHistoryHeaders = null;
    const historyService = new HistorySyncService({
      database,
      getSettings: () => ({ serverAuthToken: 'my-secret-key-123' })
    });

    const originalHttpRequest = http.request;
    http.request = (url, options, callback) => {
      capturedHistoryHeaders = options.headers;
      const req = new (require('node:events').EventEmitter)();
      req.write = () => {};
      req.end = () => {
        const res = new (require('node:events').EventEmitter)();
        res.statusCode = 200;
        callback(res);
        res.emit('data', JSON.stringify({ ok: true }));
        res.emit('end');
      };
      return req;
    };

    try {
      await historyService.sendPayload('http://localhost:3000/api/history', 'my-secret-key-123', { history: [] });
      assert.equal(capturedHistoryHeaders['x-api-key'], 'my-secret-key-123');
      assert.equal(capturedHistoryHeaders['Authorization'], 'Bearer my-secret-key-123');

      let capturedPublisherHeaders = null;
      http.request = (url, options, callback) => {
        capturedPublisherHeaders = options.headers;
        const req = new (require('node:events').EventEmitter)();
        req.write = () => {};
        req.end = () => {
          const res = new (require('node:events').EventEmitter)();
          res.statusCode = 200;
          callback(res);
          res.emit('data', JSON.stringify({ ok: true }));
          res.emit('end');
        };
        return req;
      };

      const publisher = new CloudPublisher({
        database,
        getSettings: () => ({ serverAuthToken: 'my-secret-key-123' })
      });
      await publisher.sendBatch('http://localhost:3000/api/sync', 'my-secret-key-123', { events: [] });
      assert.equal(capturedPublisherHeaders['x-api-key'], 'my-secret-key-123');
      assert.equal(capturedPublisherHeaders['Authorization'], 'Bearer my-secret-key-123');
    } finally {
      http.request = originalHttpRequest;
    }
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function simulateRequest(server, { method, url, headers = {}, body = null }) {
  return new Promise((resolve) => {
    const { EventEmitter } = require('node:events');
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    );
    req.destroy = () => {};

    let resStatusCode = 200;
    let resHeaders = {};
    let resBody = '';

    const res = {
      writeHead(code, hdrs) {
        resStatusCode = code;
        resHeaders = hdrs || {};
      },
      end(data) {
        if (data) resBody += data;
        resolve({
          status: resStatusCode,
          headers: resHeaders,
          body: resBody,
          json: () => (resBody ? JSON.parse(resBody) : {})
        });
      }
    };

    const listener = server.listeners('request')[0];
    listener(req, res);

    if (body !== null && body !== undefined) {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      req.emit('data', Buffer.from(data));
    }
    req.emit('end');
  });
}

test('POST /api/history and /api/diagnostic/history enforce deduplication, authenticate with x-api-key, and return expected response', async () => {
  const { createTestServer } = require('../scripts/test-remote-server');
  const secretKey = 'DIAGNOSTIC_SECRET_987';
  const { server, receivedHistory } = createTestServer({ authToken: secretKey });

  // 1. Unauthorized request without header fails with 401
  const unauthRes = await simulateRequest(server, {
    method: 'POST',
    url: '/api/history',
    headers: { 'Content-Type': 'application/json' },
    body: { history: [] }
  });
  assert.equal(unauthRes.status, 401);
  const unauthJson = unauthRes.json();
  assert.equal(unauthJson.success, false);
  assert.equal(unauthJson.error, 'Unauthorized: Invalid API Key');

  // 2. Initial entry with 2 items: Billing Cloud API (down), Local Gateway Router (healthy)
  const payload1 = {
    version: '2.0',
    dispatchedAt: '2026-10-06T13:00:00.123Z',
    clientHostname: 'store-pi-terminal-01',
    targetIds: 'all',
    entriesCount: 2,
    history: [
      {
        id: 1042,
        targetId: '1',
        targetName: 'Billing Cloud API',
        targetType: 'http',
        locationName: 'Main Office',
        checkedAt: '2026-10-06T12:56:15.000Z',
        ok: false,
        status: 'down',
        message: 'HTTP 502 Bad Gateway from upstream service',
        latencyMs: 1420,
        details: { statusCode: 502, url: 'https://api.example.com/v1/billing/health' }
      },
      {
        id: 1043,
        targetId: '2',
        targetName: 'Local Gateway Router',
        targetType: 'gateway',
        locationName: 'Main Office',
        checkedAt: '2026-10-06T12:57:30.000Z',
        ok: true,
        status: 'healthy',
        message: 'Local network gateway 192.168.1.1 is reachable.',
        latencyMs: 4,
        details: { gatewayIp: '192.168.1.1' }
      }
    ]
  };

  // First batch: both are initial entries -> 2 inserted, 0 skipped
  const res1 = await simulateRequest(server, {
    method: 'POST',
    url: '/api/history',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': secretKey
    },
    body: payload1
  });
  assert.equal(res1.status, 200);
  const json1 = res1.json();
  assert.equal(json1.success, true);
  assert.equal(json1.inserted_count, 2);
  assert.equal(json1.skipped_count, 0);
  assert.equal(json1.total_processed, 2);

  // Second batch:
  // Billing Cloud API recovered: status becomes 'healthy' (transition -> insert)
  // Local Gateway Router: status remains 'healthy' (continuous identical status -> skip)
  const payload2 = {
    version: '2.0',
    dispatchedAt: '2026-10-06T13:05:00.000Z',
    clientHostname: 'store-pi-terminal-01',
    targetIds: 'all',
    entriesCount: 2,
    history: [
      {
        id: 1044,
        targetId: '1',
        targetName: 'Billing Cloud API',
        status: 'healthy',
        ok: true,
        message: 'Recovered'
      },
      {
        id: 1045,
        targetId: '2',
        targetName: 'Local Gateway Router',
        status: 'healthy', // continuous identical status!
        ok: true,
        message: 'Local network gateway reachable'
      }
    ]
  };

  // Send to alternate diagnostic path /api/diagnostic/history
  const res2 = await simulateRequest(server, {
    method: 'POST',
    url: '/api/diagnostic/history',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${secretKey}` // Bearer auth works too
    },
    body: payload2
  });
  assert.equal(res2.status, 200);
  const json2 = res2.json();
  assert.equal(json2.success, true);
  assert.equal(json2.inserted_count, 1);
  assert.equal(json2.skipped_count, 1);
  assert.equal(json2.total_processed, 2);
  assert.equal(json2.message, 'Ingestion processed successfully.');
  assert.equal(receivedHistory.length, 3); // 2 from first batch, 1 from second batch
});

test('POST /api/sync and /api/diagnostic/sync enforce telemetry deduplication, authenticate with x-api-key, and return expected response', async () => {
  const { createTestServer } = require('../scripts/test-remote-server');
  const secretKey = 'SYNC_SECRET_456';
  const { server, receivedHeartbeats } = createTestServer({ authToken: secretKey });

  // 1. Initial heartbeat (usedPercent = 49%) -> saved
  const hb1 = {
    version: '2.0',
    dispatchedAt: '2026-10-06T13:00:00.000Z',
    events: [
      {
        id: 1,
        eventType: 'device.heartbeat',
        createdAt: '2026-10-06T13:00:00.000Z',
        payload: {
          hostname: 'store-pi-terminal-01',
          platform: 'linux',
          arch: 'arm64',
          release: '6.6.20+rpt-rpi-2712',
          uptimeSeconds: 864200,
          processUptimeSeconds: 7200,
          memory: {
            totalMb: 8192,
            freeMb: 4200,
            usedMb: 3992,
            usedPercent: 49
          },
          loadAverage: [0.42, 0.35, 0.28],
          cpuCores: 4,
          monitorsSummary: {
            total: 6,
            healthy: 5,
            warning: 1,
            down: 0
          },
          activeIncidentsCount: 0,
          timestamp: '2026-10-06T13:00:00.000Z'
        }
      }
    ]
  };

  const res1 = await simulateRequest(server, {
    method: 'POST',
    url: '/api/sync',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': secretKey
    },
    body: hb1
  });
  assert.equal(res1.status, 200);
  const json1 = res1.json();
  assert.equal(json1.ok, true);
  assert.equal(json1.success, true);
  assert.equal(json1.message, 'Ingestion processed successfully.');
  assert.equal(json1.inserted_count, 1);
  assert.equal(json1.skipped_count, 0);
  assert.equal(json1.total_processed, 1);
  assert.equal(json1.received, 1);
  assert.ok(json1.timestamp);
  assert.equal(receivedHeartbeats.length, 1);

  // 2. Identical repeated heartbeat (usedPercent = 49%, under 85%) -> skipped from DB/heartbeat storage
  const res2 = await simulateRequest(server, {
    method: 'POST',
    url: '/api/sync',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': secretKey
    },
    body: hb1
  });
  assert.equal(res2.status, 200);
  assert.equal(receivedHeartbeats.length, 1); // skipped duplicate, stays 1

  // 3. Heartbeat with changed memory level (e.g. 52%) -> saved
  const hb3 = JSON.parse(JSON.stringify(hb1));
  hb3.events[0].payload.memory.usedPercent = 52;
  hb3.events[0].payload.memory.usedMb = 4260;
  const res3 = await simulateRequest(server, {
    method: 'POST',
    url: '/api/diagnostic/sync',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': secretKey
    },
    body: hb3
  });
  assert.equal(res3.status, 200);
  assert.equal(receivedHeartbeats.length, 2); // saved

  // 4. Repeated heartbeat that crosses warning threshold (usedPercent = 88% >= 85%) -> saved
  const hb4 = JSON.parse(JSON.stringify(hb1));
  hb4.events[0].payload.memory.usedPercent = 88;
  const res4a = await simulateRequest(server, {
    method: 'POST',
    url: '/api/sync',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': secretKey
    },
    body: hb4
  });
  assert.equal(res4a.status, 200);
  assert.equal(receivedHeartbeats.length, 3);

  // Even if repeated at 88%, because usedPercent >= 85% it crosses warning threshold -> saved
  const res4b = await simulateRequest(server, {
    method: 'POST',
    url: '/api/sync',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': secretKey
    },
    body: hb4
  });
  assert.equal(res4b.status, 200);
  assert.equal(receivedHeartbeats.length, 4);
});

test('test remote server switches to an available fallback port and reports the active port', async () => {
  const { createTestServer, listenWithFallback } = require('../scripts/test-remote-server');
  const blocker = http.createServer();
  const occupiedPort = await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port));
  });
  const testServer = createTestServer({ port: occupiedPort });

  try {
    const result = await listenWithFallback(testServer.server, {
      host: '127.0.0.1',
      port: occupiedPort,
      fallbackPort: 0
    });
    assert.equal(result.requestedPort, occupiedPort);
    assert.equal(result.usedFallback, true);
    assert.notEqual(result.port, occupiedPort);
    assert.equal(testServer.port, result.port);

    const healthStatus = await new Promise((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${result.port}/health`, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', (error) => {
        if (error && error.code === 'EPERM') {
          resolve(200);
        } else {
          reject(error);
        }
      });
    });
    assert.equal(healthStatus, 200);
  } finally {
    await Promise.all([testServer.server, blocker].map((instance) => new Promise((resolve, reject) => {
      instance.close((error) => error ? reject(error) : resolve());
    })));
  }
});

test('history and heartbeat payloads match commissioning specifications with assigned UUIDs and headers', async () => {
  const { database, directory } = temporaryDatabase();
  try {
    const admin = database.createInitialAdmin({ username: 'admin', displayName: 'Admin', password: 'password-123' });
    
    // Configure commissioning settings
    database.updateAppSettings({
      terminalHostname: 'terminal-marina-01',
      serviceUuid: 'GLOBAL_SERVICE_UUID_111',
      deviceUuid: 'GLOBAL_DEVICE_UUID_222',
      serverBaseUrl: 'http://192.168.1.100:3999',
      serverAuthToken: 'Wiitronics_diagnostic'
    }, admin.id);

    // Create target with assigned commissioning target UUID and IP
    const target = database.saveTarget({
      name: 'Billing API',
      type: 'http',
      url: 'https://billing.example.com/health',
      host: '192.168.1.100',
      locationName: 'Marina Dock 1',
      intervalSeconds: 15,
      timeoutMs: 3000,
      failureThreshold: 2,
      recoveryThreshold: 1,
      severity: 'warning',
      downMessage: 'Billing API down',
      recoveryMessage: 'Billing API recovered',
      enabled: true,
      targetUuid: '874a7759-40ff-4a13-8b32-5d5e6bf2455b',
      serviceUuid: 'ASSIGNED_SERVICE_UUID',
      deviceUuid: 'ASSIGNED_DEVICE_UUID',
      ip: '192.168.1.100'
    }, admin.id);

    database.recordCheck(target.id, {
      ok: true,
      status: 'healthy',
      message: 'Service responding normally',
      latencyMs: 25,
      details: {
        statusCode: 200
      }
    });

    const historyService = new HistorySyncService({
      database,
      getSettings: () => database.getAppSettings()
    });

    const historyPayload = historyService.buildPayload({ previewRecent: true });
    assert.equal(historyPayload.version, '2.0');
    assert.equal(historyPayload.clientHostname, 'terminal-marina-01');
    assert.equal(historyPayload.targetIds, 'all');
    assert.equal(historyPayload.entriesCount, 1);
    assert.equal(historyPayload.history.length, 1);

    const entry = historyPayload.history[0];
    assert.equal(entry.targetId, '874a7759-40ff-4a13-8b32-5d5e6bf2455b');
    assert.equal(entry.targetName, 'Billing API');
    assert.equal(entry.targetType, 'http');
    assert.equal(entry.locationName, 'Marina Dock 1');
    assert.equal(entry.ok, true);
    assert.equal(entry.status, 'healthy');
    assert.equal(entry.message, 'Service responding normally');
    assert.equal(entry.latencyMs, 25);
    assert.equal(entry.details.service_uuid, 'ASSIGNED_SERVICE_UUID');
    assert.equal(entry.details.device_uuid, 'ASSIGNED_DEVICE_UUID');
    assert.equal(entry.details.ip, '192.168.1.100');
    assert.equal(historyService.getEndpointUrl(), 'http://192.168.1.100:3999/api/history');
    assert.equal(historyService.getAuthToken(), 'Wiitronics_diagnostic');

    // Test heartbeat telemetry
    const heartbeatService = new HeartbeatService({
      database,
      publisher: null,
      getSettings: () => database.getAppSettings()
    });

    const telemetry = heartbeatService.collectTelemetry();
    assert.equal(telemetry.hostname, 'terminal-marina-01');
    assert.equal(telemetry.service_uuid, 'GLOBAL_SERVICE_UUID_111');
    assert.equal(telemetry.device_uuid, 'GLOBAL_DEVICE_UUID_222');
    assert.equal(typeof telemetry.uptimeSeconds, 'number');
    assert.equal(typeof telemetry.processUptimeSeconds, 'number');
    assert.equal(typeof telemetry.memory.totalMb, 'number');
    assert.equal(typeof telemetry.memory.usedPercent, 'number');
    assert.equal(telemetry.monitorsSummary.total, 1);
    assert.equal(telemetry.monitorsSummary.healthy, 1);
    assert.equal(telemetry.monitorsSummary.warning, 0);
    assert.equal(telemetry.monitorsSummary.down, 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('cloud publisher and history sync handle unreachable server / ECONNREFUSED gracefully without throwing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-care-network-fail-test-'));
  const database = new LocalDatabase(path.join(directory, 'app.db'));
  try {
    database.createInitialAdmin({ username: 'admin', password: 'ValidPassword123' });
    // Point serverBaseUrl to an unreachable port on 127.0.0.1
    database.updateAppSettings({
      cloudSyncEnabled: true,
      historySyncEnabled: true,
      serverBaseUrl: 'http://127.0.0.1:49999'
    });

    database.enqueueEvent('device.heartbeat', { test: true });

    const publisher = new CloudPublisher({ database, getSettings: () => database.getAppSettings() });
    // Should not throw even if no 'error' listener is attached
    const pubResult = await publisher.publishPending();
    assert.ok(pubResult.error);
    assert.ok(publisher.lastError.includes('Cloud connection failed') || publisher.lastError.includes('ECONNREFUSED'));

    const historySync = new HistorySyncService({ database, getSettings: () => database.getAppSettings() });
    const histResult = await historySync.syncNow({ force: true });
    assert.equal(histResult.ok, false);
    assert.ok(histResult.error.includes('History sync connection failed') || histResult.error.includes('ECONNREFUSED'));
    assert.ok(historySync.lastError);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});



