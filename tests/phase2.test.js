const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildWebhookPayload } = require('../src/main/webhooks');
const { HeartbeatService } = require('../src/main/heartbeat');
const { CloudPublisher } = require('../src/main/cloud-publisher');
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
