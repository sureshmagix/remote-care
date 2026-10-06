#!/usr/bin/env node
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LocalDatabase } = require('../main/database');
const { MonitorEngine } = require('../main/monitor-engine');
const { CloudPublisher } = require('../main/cloud-publisher');
const { HeartbeatService } = require('../main/heartbeat');
const { dispatchWebhook } = require('../main/webhooks');

function resolveDefaultDbPath() {
  if (process.env.REMOTE_CARE_DB_PATH) {
    return path.resolve(process.env.REMOTE_CARE_DB_PATH);
  }
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf('--db');
  if (dbIndex !== -1 && args[dbIndex + 1]) {
    return path.resolve(args[dbIndex + 1]);
  }

  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Remote Care Monitor', 'remote-care.sqlite');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Remote Care Monitor', 'remote-care.sqlite');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'remote-care-monitor', 'remote-care.sqlite');
}

function log(level, message, meta = '') {
  const ts = new Date().toISOString();
  const suffix = meta ? ` | ${typeof meta === 'object' ? JSON.stringify(meta) : meta}` : '';
  console.log(`[${ts}] [${level.toUpperCase()}] ${message}${suffix}`);
}

async function main() {
  const dbPath = resolveDefaultDbPath();
  log('info', `Starting Remote Care Monitor Daemon v2.0...`);
  log('info', `Database path: ${dbPath}`);

  const database = new LocalDatabase(dbPath);
  const sessionId = crypto.randomUUID();
  database.startRuntimeSession(sessionId, {
    mode: 'headless_daemon',
    platform: process.platform,
    version: '2.0.0'
  });

  const cloudPublisher = new CloudPublisher({
    database,
    getSettings: () => database.getAppSettings()
  });

  const heartbeatService = new HeartbeatService({
    database,
    publisher: cloudPublisher,
    getSettings: () => database.getAppSettings()
  });

  const notifyHandler = async (event) => {
    const settings = database.getAppSettings();
    log('alert', `${event.title} - ${event.body}`, { status: event.kind, target: event.target?.name });

    if (settings.webhookEnabled && settings.webhookUrl) {
      const shouldDispatch = settings.webhookEvents === 'all' || ['down', 'warning'].includes(event.kind);
      if (shouldDispatch) {
        try {
          await dispatchWebhook({ webhookUrl: settings.webhookUrl, webhookType: settings.webhookType, event });
          log('info', `Webhook notification dispatched for ${event.target?.name}`);
        } catch (err) {
          log('warn', `Webhook delivery failed: ${err.message}`);
        }
      }
    }

    cloudPublisher.trigger();
  };

  const monitor = new MonitorEngine({
    database,
    notify: notifyHandler,
    onEvent: notifyHandler
  });

  monitor.on('update', (data) => {
    if (data.type === 'check_complete') {
      const outcome = data.outcome;
      if (outcome) {
        const symbol = outcome.status === 'healthy' ? '✔' : outcome.status === 'warning' ? '▲' : '✖';
        log('debug', `${symbol} ${outcome.target.name}: ${outcome.status} (${outcome.result.latencyMs ?? 0}ms)`);
      }
    }
  });

  if (database.hasSuperAdmin()) {
    database.createDefaultTargets();
    monitor.start();
    cloudPublisher.start();
    heartbeatService.start();
    log('info', 'Monitoring engine and cloud sync services active.');
  } else {
    log('warn', 'No Super Admin account found. Please launch the desktop app first to initialize the administrator credentials.');
  }

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `Received ${signal}. Shutting down cleanly...`);
    heartbeatService.stop();
    cloudPublisher.stop();
    monitor.stop();
    database.endRuntimeSession(sessionId, `daemon_shutdown_${signal.toLowerCase()}`);
    database.close();
    log('info', 'Remote Care Daemon stopped.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
