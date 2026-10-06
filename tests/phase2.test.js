const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
    assert.equal(preview.history[0].targetId, t1.id);

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


