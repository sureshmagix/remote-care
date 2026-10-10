const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { passwordRecord, validateUsername, verifyPassword } = require('./auth');

const ROLES = Object.freeze({ SUPER_ADMIN: 'super_admin', OPERATOR: 'operator', VIEWER: 'viewer' });
const CHECK_TYPES = new Set(['internet', 'interface', 'gateway', 'ping', 'icmp', 'tcp', 'http', 'rtsp', 'system_service', 'process', 'disk', 'memory', 'cpu', 'command']);
const STATUSES = new Set(['unknown', 'healthy', 'warning', 'down', 'disabled']);
const HISTORY_STATUSES = new Set(['unknown', 'healthy', 'warning', 'down']);
const HISTORY_OUTCOMES = new Set(['all', 'success', 'failure']);
const DEFAULT_LOCATION_NAME = 'Local device';
const RESULT_SIGNATURE_PREFIX = 'v2:';
const VOLATILE_RESULT_DETAIL_KEYS = new Set([
  'output', 'stdout', 'stderr', 'stack', 'trace',
  'latencyms', 'durationms', 'elapsedms',
  'timestamp', 'checkedat', 'startedat', 'endedat',
  'pid', 'processid'
]);
const DEFAULT_APP_SETTINGS = Object.freeze({
  minimizeToTray: true,
  showTrayReminder: true,
  showFailureNotifications: true,
  showRecoveryNotifications: true,
  notificationDurationSeconds: 5,
  cloudSyncEnabled: false,
  cloudSyncProtocol: 'https',
  cloudHttpsUrl: '',
  cloudAuthToken: '',
  cloudHeartbeatMinutes: 5,
  webhookEnabled: false,
  webhookUrl: '',
  webhookType: 'generic',
  webhookEvents: 'failures_only',
  soundAlertsEnabled: false,
  soundVolume: 70,
  serverBaseUrl: '',
  serverHealthUrl: '',
  telemetrySelection: 'all',
  serverAuthToken: '',
  serverSyncIntervalSeconds: 15,
  historySyncEnabled: false,
  historySyncUrl: '',
  historySyncIntervalMinutes: 5,
  historySyncTargetIds: '',
  terminalHostname: '',
  serviceUuid: '',
  deviceUuid: ''
});
const APP_SETTING_KEYS = Object.freeze({
  minimizeToTray: 'minimize_to_tray',
  showTrayReminder: 'show_tray_reminder',
  showFailureNotifications: 'show_failure_notifications',
  showRecoveryNotifications: 'show_recovery_notifications',
  notificationDurationSeconds: 'notification_duration_seconds',
  cloudSyncEnabled: 'cloud_sync_enabled',
  cloudSyncProtocol: 'cloud_sync_protocol',
  cloudHttpsUrl: 'cloud_https_url',
  cloudAuthToken: 'cloud_auth_token',
  cloudHeartbeatMinutes: 'cloud_heartbeat_minutes',
  webhookEnabled: 'webhook_enabled',
  webhookUrl: 'webhook_url',
  webhookType: 'webhook_type',
  webhookEvents: 'webhook_events',
  soundAlertsEnabled: 'sound_alerts_enabled',
  soundVolume: 'sound_volume',
  serverBaseUrl: 'server_base_url',
  serverHealthUrl: 'server_health_url',
  telemetrySelection: 'telemetry_selection',
  serverAuthToken: 'server_auth_token',
  serverSyncIntervalSeconds: 'server_sync_interval_seconds',
  historySyncEnabled: 'history_sync_enabled',
  historySyncUrl: 'history_sync_url',
  historySyncIntervalMinutes: 'history_sync_interval_minutes',
  historySyncTargetIds: 'history_sync_target_ids',
  terminalHostname: 'terminal_hostname',
  serviceUuid: 'service_uuid',
  deviceUuid: 'device_uuid'
});

function now() {
  return new Date().toISOString();
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableResultDetails(value) {
  if (Array.isArray(value)) return value.map(stableResultDetails);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      // Command output and timings are useful in a saved history row, but are
      // not monitor state. They commonly change for every poll and must not
      // turn an unchanged result into a new history entry.
      if (VOLATILE_RESULT_DETAIL_KEYS.has(key.toLowerCase()) || value[key] === undefined) return result;
      result[key] = stableResultDetails(value[key]);
      return result;
    }, {});
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function resultSignature(result, status) {
  // Response timing and raw command output naturally vary between checks;
  // including them would defeat change-only history storage. Keep stable
  // result details such as HTTP status, error code, selected gateway, or
  // interface state so a real diagnostic change remains auditable.
  return `${RESULT_SIGNATURE_PREFIX}${JSON.stringify({
    ok: Boolean(result.ok),
    status,
    message: String(result.message || '').replace(/\b\d+(?:\.\d+)?\s*ms\b/gi, '<latency>'),
    details: stableResultDetails(result.details || {})
  })}`;
}

function bool(value) {
  return Boolean(value);
}

function storedBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value === 'true' || value === '1';
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: bool(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at
  };
}

function mapUserWithAuth(row) {
  if (!row) return null;
  return { ...mapUser(row), passwordSalt: row.password_salt, passwordHash: row.password_hash };
}

function mapTarget(row) {
  if (!row) return null;
  const metadata = parseJson(row.metadata_json);
  return {
    id: row.id,
    targetUuid: metadata.targetUuid || metadata.uuid || null,
    serviceUuid: metadata.serviceUuid || null,
    deviceUuid: metadata.deviceUuid || null,
    name: row.name,
    locationName: row.location_name || DEFAULT_LOCATION_NAME,
    type: row.type,
    host: row.host || '',
    port: row.port || '',
    url: row.url || '',
    interfaceName: row.interface_name || 'auto',
    serviceName: row.service_name || '',
    processName: row.process_name || '',
    intervalSeconds: row.interval_seconds,
    timeoutMs: row.timeout_ms,
    failureThreshold: row.failure_threshold,
    recoveryThreshold: row.recovery_threshold,
    severity: row.severity,
    downMessage: row.down_message,
    recoveryMessage: row.recovery_message,
    enabled: bool(row.enabled),
    status: row.status,
    consecutiveFailures: row.consecutive_failures,
    consecutiveSuccesses: row.consecutive_successes,
    lastCheckedAt: row.last_checked_at,
    lastLatencyMs: row.last_latency_ms,
    incidentStartedAt: row.incident_started_at,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validateTarget(input) {
  if (!input || typeof input !== 'object') throw new Error('Monitor configuration is required.');
  const type = String(input.type || '').trim();
  if (!CHECK_TYPES.has(type)) throw new Error('Unsupported monitor type.');
  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 80) throw new Error('Monitor name must be 2–80 characters.');
  const locationName = String(input.locationName ?? DEFAULT_LOCATION_NAME).trim();
  if (locationName.length < 2 || locationName.length > 100) throw new Error('Location name must be 2–100 characters.');

  const toPositiveInteger = (value, fallback, minimum, maximum) => {
    const result = Number.parseInt(value ?? fallback, 10);
    if (!Number.isInteger(result) || result < minimum || result > maximum) {
      throw new Error(`A value must be between ${minimum} and ${maximum}.`);
    }
    return result;
  };
  const host = String(input.host || '').trim();
  const url = String(input.url || '').trim();
  const serviceName = String(input.serviceName || '').trim();
  const processName = String(input.processName || '').trim();
  const port = input.port === '' || input.port === null || input.port === undefined ? null : toPositiveInteger(input.port, null, 1, 65535);

  if (['ping', 'icmp', 'tcp', 'rtsp'].includes(type) && !host) throw new Error('Host or IP address is required for this monitor.');
  if (type === 'tcp' && !port) throw new Error('A TCP port is required.');
  if (['http', 'internet'].includes(type)) {
    if (!url) throw new Error('A HTTP or HTTPS URL is required.');
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
    } catch {
      throw new Error('Enter a valid HTTP or HTTPS URL.');
    }
  }
  if (type === 'system_service' && !serviceName) throw new Error('A service name is required.');
  if (type === 'process' && !processName) throw new Error('A process name is required.');
  if (type === 'command' && !host && !input.metadata?.command && !input.command) {
    throw new Error('A command or script is required for this monitor.');
  }

  const metadata = input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {};
  if (input.targetUuid || input.uuid) {
    metadata.targetUuid = String(input.targetUuid || input.uuid).trim();
  }
  if (input.serviceUuid || input.service_uuid) {
    metadata.serviceUuid = String(input.serviceUuid || input.service_uuid).trim();
  }
  if (input.deviceUuid || input.device_uuid) {
    metadata.deviceUuid = String(input.deviceUuid || input.device_uuid).trim();
  }
  if (input.ip) {
    metadata.ip = String(input.ip).trim();
  }
  if (['disk', 'memory', 'cpu'].includes(type)) {
    const rawThreshold = metadata.thresholdPercent ?? input.thresholdPercent ?? 90;
    metadata.thresholdPercent = toPositiveInteger(rawThreshold, 90, 1, 100);
    if (type === 'disk') {
      metadata.path = String(metadata.path || input.path || (process.platform === 'win32' ? 'C:\\' : '/')).trim();
    }
  }
  if (type === 'command') {
    metadata.command = String(metadata.command || input.command || host).trim();
    if (metadata.expectedExitCode !== undefined && metadata.expectedExitCode !== null && metadata.expectedExitCode !== '') {
      metadata.expectedExitCode = Number.parseInt(metadata.expectedExitCode, 10) || 0;
    }
    if (metadata.expectedOutput) {
      metadata.expectedOutput = String(metadata.expectedOutput).trim();
    }
  }
  return {
    id: input.id ? Number.parseInt(input.id, 10) : null,
    name,
    locationName,
    type,
    host,
    port,
    url,
    interfaceName: String(input.interfaceName || 'auto').trim() || 'auto',
    serviceName,
    processName,
    intervalSeconds: toPositiveInteger(input.intervalSeconds, 15, 2, 86_400),
    timeoutMs: toPositiveInteger(input.timeoutMs, 3_000, 500, 120_000),
    failureThreshold: toPositiveInteger(input.failureThreshold, 2, 1, 10),
    recoveryThreshold: toPositiveInteger(input.recoveryThreshold, 1, 1, 10),
    severity: ['info', 'warning', 'critical'].includes(input.severity) ? input.severity : 'warning',
    downMessage: String(input.downMessage || `${name} is not reachable.`).trim().slice(0, 300),
    recoveryMessage: String(input.recoveryMessage || `${name} has recovered.`).trim().slice(0, 300),
    enabled: input.enabled !== false,
    metadata
  };
}

function historyTimestamp(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be a valid date and time.`);
  return parsed.toISOString();
}

function validateHistoryFilters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('History filters must be an object.');

  const from = historyTimestamp(input.from, 'Start date');
  const to = historyTimestamp(input.to, 'End date');
  if (from && to && from > to) throw new Error('The start date and time must be before the end date and time.');

  let targetId = null;
  if (input.targetId !== undefined && input.targetId !== null && input.targetId !== '') {
    targetId = Number.parseInt(input.targetId, 10);
    if (!Number.isInteger(targetId) || targetId < 1) throw new Error('Choose a valid monitor.');
  }

  const type = String(input.type || '').trim();
  if (type && !CHECK_TYPES.has(type)) throw new Error('Choose a valid monitor type.');
  const status = String(input.status || '').trim();
  if (status && !HISTORY_STATUSES.has(status)) throw new Error('Choose a valid status.');
  const outcome = String(input.outcome || 'all').trim() || 'all';
  if (!HISTORY_OUTCOMES.has(outcome)) throw new Error('Choose a valid outcome.');

  const search = String(input.search || '').trim().slice(0, 120);
  const location = String(input.location || '').trim().slice(0, 100);
  const requestedLimit = Number.parseInt(input.limit ?? 100, 10);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
  return { from, to, targetId, type, status, outcome, search, location, limit };
}

function validateReportMonth(value) {
  const match = String(value || '').match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!match) throw new Error('Choose a valid report month.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  return { month: `${match[1]}-${match[2]}`, from: from.toISOString(), to: to.toISOString() };
}

function mapHistoryResult(row) {
  return {
    id: row.id,
    targetId: row.target_id,
    targetName: row.target_name,
    locationName: row.location_name || DEFAULT_LOCATION_NAME,
    targetType: row.target_type,
    checkedAt: row.checked_at,
    ok: bool(row.ok),
    status: row.status,
    message: row.message,
    latencyMs: row.latency_ms,
    details: parseJson(row.details_json)
  };
}

function resolveSqliteBinding() {
  const platformArch = `${process.platform}-${process.arch}`;
  const candidates = [];

  // Packaged Electron paths
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, 'app.asar.unpacked', 'prebuilds', platformArch, 'better_sqlite3.node'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
      path.join(process.resourcesPath, 'prebuilds', platformArch, 'better_sqlite3.node')
    );
  }

  // Development and project paths
  candidates.push(
    path.resolve(__dirname, '../../prebuilds', platformArch, 'better_sqlite3.node'),
    path.resolve(__dirname, '../prebuilds', platformArch, 'better_sqlite3.node'),
    path.resolve(process.cwd(), 'prebuilds', platformArch, 'better_sqlite3.node'),
    path.resolve(__dirname, '../../node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
    path.resolve(__dirname, '../../node_modules/better-sqlite3/prebuilds', platformArch, 'better_sqlite3.node')
  );

  const attempted = [];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const testDb = new Database(':memory:', { nativeBinding: candidate });
        testDb.close();
        return candidate;
      } catch (err) {
        attempted.push({ path: candidate, error: err.message });
      }
    }
  }

  // Fallback to default better-sqlite3 bindings resolution
  try {
    const testDb = new Database(':memory:');
    testDb.close();
    return null;
  } catch (err) {
    attempted.push({ path: 'default (bindings package)', error: err.message });
  }

  const failureDetails = attempted.map((a) => ` - [${a.path}]: ${a.error}`).join('\n');
  throw new Error(
    `Failed to load SQLite native database engine for ${process.platform} (${process.arch}).\n` +
    `The native module "better_sqlite3.node" could not be initialized.\n` +
    `Attempted locations:\n${failureDetails}\n` +
    `Please verify that the proper native binary for ${process.platform}-${process.arch} is present.`
  );
}

let cachedNativeBinding = undefined;
function getSqliteBinding() {
  if (cachedNativeBinding === undefined) {
    cachedNativeBinding = resolveSqliteBinding();
  }
  return cachedNativeBinding;
}

class LocalDatabase {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const binding = getSqliteBinding();
    const options = binding ? { nativeBinding: binding } : {};
    this.db = new Database(filePath, options);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('super_admin', 'operator', 'viewer')),
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        location_name TEXT NOT NULL DEFAULT 'Local device',
        type TEXT NOT NULL,
        host TEXT,
        port INTEGER,
        url TEXT,
        interface_name TEXT,
        service_name TEXT,
        process_name TEXT,
        interval_seconds INTEGER NOT NULL DEFAULT 15,
        timeout_ms INTEGER NOT NULL DEFAULT 3000,
        failure_threshold INTEGER NOT NULL DEFAULT 2,
        recovery_threshold INTEGER NOT NULL DEFAULT 1,
        severity TEXT NOT NULL DEFAULT 'warning',
        down_message TEXT NOT NULL,
        recovery_message TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'unknown',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        consecutive_successes INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT,
        last_latency_ms INTEGER,
        incident_started_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS check_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        checked_at TEXT NOT NULL,
        location_name TEXT NOT NULL DEFAULT 'Local device',
        ok INTEGER NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        latency_ms INTEGER,
        details_json TEXT NOT NULL DEFAULT '{}',
        result_signature TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_check_results_target_time ON check_results(target_id, checked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_check_results_time ON check_results(checked_at DESC);
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        location_name TEXT NOT NULL DEFAULT 'Local device',
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        started_at TEXT NOT NULL,
        resolved_at TEXT,
        acknowledged_at TEXT,
        acknowledged_by INTEGER REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_active ON incidents(target_id, resolved_at);
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER REFERENCES incidents(id) ON DELETE SET NULL,
        target_id INTEGER REFERENCES targets(id) ON DELETE SET NULL,
        location_name TEXT NOT NULL DEFAULT 'Local device',
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_runtime_sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT,
        details_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_app_runtime_sessions_end ON app_runtime_sessions(ended_at DESC);
      CREATE TABLE IF NOT EXISTS outbound_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
    `);

    // SQLite migrations for existing local installations. New tables receive
    // these fields from the schema above; existing rows retain a meaningful
    // location instead of becoming blank in history and reports.
    const columns = (table) => new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    const outboundColumns = columns('outbound_events');
    if (!outboundColumns.has('last_error')) {
      this.db.exec('ALTER TABLE outbound_events ADD COLUMN last_error TEXT');
    }
    const userSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()?.sql || '';
    if (userSql.includes("'viewer'") && !userSql.includes("'operator'")) {
      this.db.pragma('foreign_keys = OFF');
      this.db.exec(`
        DROP TABLE IF EXISTS users_migrated;
        CREATE TABLE users_migrated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('super_admin', 'operator', 'viewer')),
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_login_at TEXT
        );
        INSERT INTO users_migrated (id, username, display_name, role, password_salt, password_hash, active, created_at, updated_at, last_login_at)
          SELECT id, username, display_name, role, password_salt, password_hash, active, created_at, updated_at, last_login_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_migrated RENAME TO users;
      `);
      this.db.pragma('foreign_keys = ON');
    }
    const targetColumns = columns('targets');
    if (!targetColumns.has('location_name')) {
      this.db.exec(`ALTER TABLE targets ADD COLUMN location_name TEXT NOT NULL DEFAULT '${DEFAULT_LOCATION_NAME}'`);
    }
    const resultColumns = columns('check_results');
    if (!resultColumns.has('location_name')) {
      this.db.exec(`ALTER TABLE check_results ADD COLUMN location_name TEXT NOT NULL DEFAULT '${DEFAULT_LOCATION_NAME}'`);
    }
    if (!resultColumns.has('result_signature')) {
      this.db.exec("ALTER TABLE check_results ADD COLUMN result_signature TEXT NOT NULL DEFAULT ''");
    }
    const incidentColumns = columns('incidents');
    if (!incidentColumns.has('location_name')) {
      this.db.exec(`ALTER TABLE incidents ADD COLUMN location_name TEXT NOT NULL DEFAULT '${DEFAULT_LOCATION_NAME}'`);
    }
    const notificationColumns = columns('notifications');
    if (!notificationColumns.has('location_name')) {
      this.db.exec(`ALTER TABLE notifications ADD COLUMN location_name TEXT NOT NULL DEFAULT '${DEFAULT_LOCATION_NAME}'`);
    }
    this.db.prepare('UPDATE targets SET location_name = ? WHERE location_name IS NULL OR TRIM(location_name) = ?')
      .run(DEFAULT_LOCATION_NAME, '');
    this.db.prepare(`UPDATE check_results SET location_name = COALESCE(NULLIF((SELECT location_name FROM targets WHERE targets.id = check_results.target_id), ''), ?)
      WHERE location_name IS NULL OR TRIM(location_name) = ''`).run(DEFAULT_LOCATION_NAME);
    this.db.prepare(`UPDATE incidents SET location_name = COALESCE(NULLIF((SELECT location_name FROM targets WHERE targets.id = incidents.target_id), ''), ?)
      WHERE location_name IS NULL OR TRIM(location_name) = ''`).run(DEFAULT_LOCATION_NAME);
    this.db.prepare(`UPDATE notifications SET location_name = COALESCE(NULLIF((SELECT location_name FROM targets WHERE targets.id = notifications.target_id), ''), ?)
      WHERE location_name IS NULL OR TRIM(location_name) = ''`).run(DEFAULT_LOCATION_NAME);

    // Version 1.1.2 excludes volatile command output and timing from the
    // history fingerprint. Upgrade prior signatures in place so an unchanged
    // target does not create an extra history row immediately after updating.
    const legacyResults = this.db.prepare(`SELECT id, ok, status, message, details_json FROM check_results
      WHERE result_signature NOT LIKE ?`).all(`${RESULT_SIGNATURE_PREFIX}%`);
    if (legacyResults.length) {
      const updateSignature = this.db.prepare('UPDATE check_results SET result_signature = ? WHERE id = ?');
      const migrateSignatures = this.db.transaction((rows) => {
        for (const row of rows) {
          updateSignature.run(resultSignature({
            ok: row.ok === 1,
            message: row.message,
            details: parseJson(row.details_json)
          }, row.status), row.id);
        }
      });
      migrateSignatures(legacyResults);
    }
  }

  close() {
    this.db.close();
  }

  hasSuperAdmin() {
    return Boolean(this.db.prepare('SELECT 1 FROM users WHERE role = ? LIMIT 1').get(ROLES.SUPER_ADMIN));
  }

  getSetupState() {
    return { requiresSetup: !this.hasSuperAdmin(), viewerLimit: 5 };
  }

  getAppSettings() {
    const rows = this.db.prepare('SELECT key, value FROM app_settings').all();
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    return Object.fromEntries(Object.entries(APP_SETTING_KEYS).map(([name, key]) => {
      const val = stored.get(key);
      if (name === 'notificationDurationSeconds') {
        return [name, Number.isInteger(Number(val)) && Number(val) >= 1 && Number(val) <= 300 ? Number(val) : DEFAULT_APP_SETTINGS[name]];
      }
      if (name === 'cloudHeartbeatMinutes') {
        return [name, Number.isInteger(Number(val)) && Number(val) >= 1 && Number(val) <= 1440 ? Number(val) : DEFAULT_APP_SETTINGS[name]];
      }
      if (name === 'soundVolume') {
        return [name, Number.isInteger(Number(val)) && Number(val) >= 0 && Number(val) <= 100 ? Number(val) : DEFAULT_APP_SETTINGS[name]];
      }
      if (name === 'serverSyncIntervalSeconds') {
        return [name, Number.isInteger(Number(val)) && Number(val) >= 2 && Number(val) <= 3600 ? Number(val) : DEFAULT_APP_SETTINGS[name]];
      }
      if (name === 'historySyncIntervalMinutes') {
        return [name, Number.isInteger(Number(val)) && Number(val) >= 1 && Number(val) <= 1440 ? Number(val) : DEFAULT_APP_SETTINGS[name]];
      }
      if (typeof DEFAULT_APP_SETTINGS[name] === 'boolean') {
        return [name, storedBool(val, DEFAULT_APP_SETTINGS[name])];
      }
      return [name, val !== undefined && val !== null ? String(val) : DEFAULT_APP_SETTINGS[name]];
    }));
  }

  updateAppSettings(input, actorUserId) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings are required.');
    const settings = this.getAppSettings();
    for (const name of Object.keys(APP_SETTING_KEYS)) {
      if (!Object.hasOwn(input, name)) continue;
      if (name === 'notificationDurationSeconds') {
        if (!Number.isInteger(input[name]) || input[name] < 1 || input[name] > 300) {
          throw new Error('Notification duration must be a whole number from 1 to 300 seconds.');
        }
      } else if (name === 'cloudHeartbeatMinutes') {
        if (!Number.isInteger(input[name]) || input[name] < 1 || input[name] > 1440) {
          throw new Error('Heartbeat interval must be a whole number from 1 to 1440 minutes.');
        }
      } else if (name === 'soundVolume') {
        if (!Number.isInteger(input[name]) || input[name] < 0 || input[name] > 100) {
          throw new Error('Sound volume must be between 0 and 100.');
        }
      } else if (name === 'serverSyncIntervalSeconds') {
        if (!Number.isInteger(input[name]) || input[name] < 2 || input[name] > 3600) {
          throw new Error('Server sync interval must be between 2 and 3600 seconds.');
        }
      } else if (name === 'historySyncIntervalMinutes') {
        if (!Number.isInteger(input[name]) || input[name] < 1 || input[name] > 1440) {
          throw new Error('History sync interval must be between 1 and 1440 minutes.');
        }
      } else if (typeof DEFAULT_APP_SETTINGS[name] === 'boolean') {
        if (typeof input[name] !== 'boolean') throw new Error('Each setting must be enabled or disabled.');
      } else {
        if (name === 'historySyncTargetIds' && Array.isArray(input[name])) {
          input[name] = input[name].join(',');
        }
        if (typeof input[name] !== 'string') throw new Error(`${name} must be a string.`);
      }
      settings[name] = input[name];
    }
    const timestamp = now();
    const save = this.db.transaction(() => {
      for (const [name, key] of Object.entries(APP_SETTING_KEYS)) {
        this.db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(key, String(settings[name] ?? ''), timestamp);
      }
    });
    save();
    this.audit(actorUserId, 'update_app_settings', 'app_settings', null, settings);
    return settings;
  }

  verifySuperAdminPassword(userId, password) {
    const user = mapUserWithAuth(this.db.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(userId, ROLES.SUPER_ADMIN));
    return Boolean(user && user.active && verifyPassword(password, user.passwordSalt, user.passwordHash));
  }

  startRuntimeSession(sessionId, details = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('A runtime session ID is required.');
    const timestamp = now();
    const interrupted = this.db.prepare('SELECT id, started_at FROM app_runtime_sessions WHERE ended_at IS NULL').all();
    const save = this.db.transaction(() => {
      if (interrupted.length) {
        this.db.prepare(`UPDATE app_runtime_sessions
          SET ended_at = ?, end_reason = 'interrupted' WHERE ended_at IS NULL`).run(timestamp);
        for (const run of interrupted) {
          this.audit(null, 'unexpected_previous_shutdown', 'app_runtime_session', run.id, {
            startedAt: run.started_at,
            detectedAt: timestamp
          });
        }
      }
      this.db.prepare(`INSERT INTO app_runtime_sessions (id, started_at, details_json)
        VALUES (?, ?, ?)`).run(sessionId, timestamp, JSON.stringify(details));
      this.audit(null, 'app_started', 'app_runtime_session', sessionId, details);
    });
    save();
    return { interruptedCount: interrupted.length };
  }

  endRuntimeSession(sessionId, reason = 'authorized_quit') {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const result = this.db.prepare(`UPDATE app_runtime_sessions
      SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL`).run(now(), reason, sessionId);
    if (result.changes) this.audit(null, 'app_stopped', 'app_runtime_session', sessionId, { reason });
    return Boolean(result.changes);
  }

  getRuntimeStatus() {
    const latest = this.db.prepare(`SELECT started_at, ended_at, end_reason
      FROM app_runtime_sessions ORDER BY started_at DESC LIMIT 1`).get();
    const lastUnexpected = this.db.prepare(`SELECT started_at, ended_at
      FROM app_runtime_sessions WHERE end_reason = 'interrupted' ORDER BY ended_at DESC LIMIT 1`).get();
    return {
      startedAt: latest?.started_at || null,
      lastUnexpectedShutdownAt: lastUnexpected?.ended_at || null,
      lastUnexpectedSessionStartedAt: lastUnexpected?.started_at || null
    };
  }

  createInitialAdmin({ username, displayName, password }) {
    if (this.hasSuperAdmin()) throw new Error('The Super Admin account has already been created.');
    const normalizedUsername = validateUsername(username);
    const record = passwordRecord(password);
    const timestamp = now();
    const info = this.db.prepare(`INSERT INTO users
      (username, display_name, role, password_salt, password_hash, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(normalizedUsername, String(displayName || normalizedUsername).trim().slice(0, 80), ROLES.SUPER_ADMIN, record.salt, record.hash, timestamp, timestamp);
    this.audit(null, 'create_initial_admin', 'user', String(info.lastInsertRowid), { username: normalizedUsername });
    return this.getUserById(info.lastInsertRowid);
  }

  getUserForLogin(username) {
    const normalized = validateUsername(username);
    return mapUserWithAuth(this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(normalized));
  }

  getUserById(id) {
    return mapUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY role ASC, username ASC').all().map(mapUser);
  }

  createViewer({ username, displayName, password, role = ROLES.VIEWER }, actorUserId) {
    const targetRole = role === ROLES.OPERATOR ? ROLES.OPERATOR : ROLES.VIEWER;
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM users WHERE role IN (?, ?)').get(ROLES.VIEWER, ROLES.OPERATOR).count;
    if (count >= 5) throw new Error('A maximum of five non-admin (Viewer/Operator) accounts is allowed.');
    const normalizedUsername = validateUsername(username);
    const record = passwordRecord(password);
    const timestamp = now();
    try {
      const info = this.db.prepare(`INSERT INTO users
        (username, display_name, role, password_salt, password_hash, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(normalizedUsername, String(displayName || normalizedUsername).trim().slice(0, 80), targetRole, record.salt, record.hash, timestamp, timestamp);
      this.audit(actorUserId, targetRole === ROLES.OPERATOR ? 'create_operator' : 'create_viewer', 'user', String(info.lastInsertRowid), { username: normalizedUsername, role: targetRole });
      return this.getUserById(info.lastInsertRowid);
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(error.message)) throw new Error('That username already exists.');
      throw error;
    }
  }

  createOperator(user, actorUserId) {
    return this.createViewer({ ...user, role: ROLES.OPERATOR }, actorUserId);
  }

  setViewerActive(userId, active, actorUserId) {
    const user = this.getUserById(userId);
    if (!user || ![ROLES.VIEWER, ROLES.OPERATOR].includes(user.role)) throw new Error('Account not found.');
    this.db.prepare('UPDATE users SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, now(), userId);
    this.audit(actorUserId, active ? 'enable_user' : 'disable_user', 'user', String(userId), {});
    return this.getUserById(userId);
  }

  resetViewerPassword(userId, password, actorUserId) {
    const user = this.getUserById(userId);
    if (!user || ![ROLES.VIEWER, ROLES.OPERATOR].includes(user.role)) throw new Error('Account not found.');
    const record = passwordRecord(password);
    this.db.prepare('UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?')
      .run(record.salt, record.hash, now(), userId);
    this.audit(actorUserId, 'reset_user_password', 'user', String(userId), {});
  }

  changeUserPassword(userId, currentPassword, newPassword) {
    const userRow = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const user = mapUserWithAuth(userRow);
    if (!user || !user.active) throw new Error('User not found or inactive.');
    if (!verifyPassword(currentPassword || '', user.passwordSalt, user.passwordHash)) {
      throw new Error('Current password is incorrect.');
    }
    const record = passwordRecord(newPassword);
    this.db.prepare('UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?')
      .run(record.salt, record.hash, now(), userId);
    this.audit(userId, 'change_own_password', 'user', String(userId), {});
    return { ok: true };
  }

  updateUserProfile(userId, { username, displayName }) {
    const user = this.getUserById(userId);
    if (!user) throw new Error('User not found.');
    const normalizedUsername = validateUsername(username);
    const trimmedDisplayName = String(displayName || normalizedUsername).trim().slice(0, 80);
    try {
      this.db.prepare('UPDATE users SET username = ?, display_name = ?, updated_at = ? WHERE id = ?')
        .run(normalizedUsername, trimmedDisplayName, now(), userId);
      this.audit(userId, 'update_profile', 'user', String(userId), { username: normalizedUsername, displayName: trimmedDisplayName });
      return this.getUserById(userId);
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(error.message)) throw new Error('That username is already taken.');
      throw error;
    }
  }

  updateViewer(userId, { username, displayName, active, role } = {}, actorUserId) {
    const user = this.getUserById(userId);
    if (!user || ![ROLES.VIEWER, ROLES.OPERATOR].includes(user.role)) throw new Error('Account not found.');
    const normalizedUsername = validateUsername(username || user.username);
    const trimmedDisplayName = String(displayName || user.displayName || normalizedUsername).trim().slice(0, 80);
    const targetRole = role && [ROLES.VIEWER, ROLES.OPERATOR].includes(role) ? role : user.role;
    const isActive = active !== undefined ? Boolean(active) : user.active;
    try {
      this.db.prepare('UPDATE users SET username = ?, display_name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(normalizedUsername, trimmedDisplayName, targetRole, isActive ? 1 : 0, now(), userId);
      this.audit(actorUserId, 'update_managed_user', 'user', String(userId), { username: normalizedUsername, displayName: trimmedDisplayName, role: targetRole, active: isActive });
      return this.getUserById(userId);
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(error.message)) throw new Error('That username is already taken.');
      throw error;
    }
  }

  markLogin(userId) {
    this.db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), userId);
  }

  listTargets() {
    return this.db.prepare('SELECT * FROM targets ORDER BY enabled DESC, severity DESC, name COLLATE NOCASE ASC').all().map(mapTarget);
  }

  getTarget(id) {
    return mapTarget(this.db.prepare('SELECT * FROM targets WHERE id = ?').get(id));
  }

  createDefaultTargets() {
    if (this.db.prepare('SELECT COUNT(*) AS count FROM targets').get().count > 0) return;
    const defaults = [
      {
        name: 'Network interface', locationName: DEFAULT_LOCATION_NAME, type: 'interface', interfaceName: 'auto', intervalSeconds: 5, timeoutMs: 2000,
        failureThreshold: 1, recoveryThreshold: 1, severity: 'critical', downMessage: 'Network adapter is disconnected.', recoveryMessage: 'Network adapter is connected.', metadata: {}
      },
      {
        name: 'Default gateway', locationName: DEFAULT_LOCATION_NAME, type: 'gateway', intervalSeconds: 8, timeoutMs: 2500,
        failureThreshold: 2, recoveryThreshold: 1, severity: 'warning', downMessage: 'Local network gateway is not reachable.', recoveryMessage: 'Local network gateway is reachable again.', metadata: {}
      },
      {
        name: 'Internet connection', locationName: DEFAULT_LOCATION_NAME, type: 'internet', url: 'https://www.cloudflare.com/cdn-cgi/trace', intervalSeconds: 10, timeoutMs: 5000,
        failureThreshold: 2, recoveryThreshold: 1, severity: 'critical', downMessage: 'Internet connection has been lost.', recoveryMessage: 'Internet connection has been restored.', metadata: { dnsHost: 'cloudflare.com' }
      }
    ];
    for (const target of defaults) this.saveTarget(target, null, true);
  }

  saveTarget(input, actorUserId, internal = false) {
    const target = validateTarget(input);
    const timestamp = now();
    const values = [
      target.name, target.locationName, target.type, target.host || null, target.port, target.url || null, target.interfaceName || null,
      target.serviceName || null, target.processName || null, target.intervalSeconds, target.timeoutMs,
      target.failureThreshold, target.recoveryThreshold, target.severity, target.downMessage, target.recoveryMessage,
      target.enabled ? 1 : 0, JSON.stringify(target.metadata), timestamp
    ];
    let id = target.id;
    if (id && this.getTarget(id)) {
      this.db.prepare(`UPDATE targets SET
        name=?, location_name=?, type=?, host=?, port=?, url=?, interface_name=?, service_name=?, process_name=?, interval_seconds=?, timeout_ms=?,
        failure_threshold=?, recovery_threshold=?, severity=?, down_message=?, recovery_message=?, enabled=?, metadata_json=?, updated_at=?
        WHERE id=?`).run(...values, id);
      if (!internal) this.audit(actorUserId, 'update_monitor', 'target', String(id), { name: target.name, locationName: target.locationName, type: target.type });
    } else {
      const info = this.db.prepare(`INSERT INTO targets
        (name, location_name, type, host, port, url, interface_name, service_name, process_name, interval_seconds, timeout_ms,
        failure_threshold, recovery_threshold, severity, down_message, recovery_message, enabled, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...values, timestamp);
      id = info.lastInsertRowid;
      if (!internal) this.audit(actorUserId, 'create_monitor', 'target', String(id), { name: target.name, locationName: target.locationName, type: target.type });
    }
    return this.getTarget(id);
  }

  deleteTarget(id, actorUserId) {
    const target = this.getTarget(id);
    if (!target) throw new Error('Monitor not found.');
    this.db.prepare('DELETE FROM targets WHERE id = ?').run(id);
    this.audit(actorUserId, 'delete_monitor', 'target', String(id), { name: target.name, type: target.type });
  }

  recordCheck(targetId, result) {
    const target = this.getTarget(targetId);
    if (!target) return null;
    const timestamp = now();
    const wasDown = target.status === 'down';
    const wasHealthy = target.status === 'healthy';
    let failures = target.consecutiveFailures;
    let successes = target.consecutiveSuccesses;
    let status = target.status;
    let incidentEvent = null;

    if (result.ok) {
      failures = 0;
      successes += 1;
      if (target.status === 'unknown' || successes >= target.recoveryThreshold) status = 'healthy';
    } else {
      successes = 0;
      failures += 1;
      if (failures >= target.failureThreshold) status = 'down';
      else status = wasDown ? 'down' : 'warning';
    }

    const transition = status !== target.status;
    let incidentStartedAt = target.incidentStartedAt;
    if (!wasDown && status === 'down') {
      incidentStartedAt = timestamp;
      const incident = this.db.prepare(`INSERT INTO incidents
        (target_id, location_name, severity, title, message, started_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(target.id, target.locationName, target.severity, `${target.name} is unavailable`, target.downMessage || result.message, timestamp);
      incidentEvent = { kind: 'down', incidentId: incident.lastInsertRowid, target, message: target.downMessage || result.message };
    } else if (wasDown && status === 'healthy') {
      const activeIncident = this.db.prepare('SELECT * FROM incidents WHERE target_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1').get(target.id);
      if (activeIncident) this.db.prepare('UPDATE incidents SET resolved_at = ? WHERE id = ?').run(timestamp, activeIncident.id);
      incidentStartedAt = null;
      incidentEvent = { kind: 'recovered', incidentId: activeIncident?.id || null, target, message: target.recoveryMessage || `${target.name} has recovered.` };
    }

    this.db.prepare(`UPDATE targets SET status=?, consecutive_failures=?, consecutive_successes=?, last_checked_at=?,
      last_latency_ms=?, incident_started_at=?, updated_at=? WHERE id=?`)
      .run(status, failures, successes, timestamp, result.latencyMs ?? null, incidentStartedAt, timestamp, targetId);
    const signature = resultSignature(result, status);
    const previousResult = this.db.prepare(`SELECT result_signature FROM check_results
      WHERE target_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1`).get(targetId);
    const recorded = !previousResult || previousResult.result_signature !== signature;
    if (recorded) {
      this.db.prepare(`INSERT INTO check_results
        (target_id, checked_at, location_name, ok, status, message, latency_ms, details_json, result_signature)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(targetId, timestamp, target.locationName, result.ok ? 1 : 0, status, String(result.message || ''), result.latencyMs ?? null, JSON.stringify(result.details || {}), signature);
    }

    const finalTarget = this.getTarget(targetId);
    if (incidentEvent) {
      incidentEvent.target = finalTarget;
      this.enqueueEvent(incidentEvent.kind === 'down' ? 'incident.opened' : 'incident.resolved', {
        targetId, targetName: finalTarget.name, locationName: finalTarget.locationName, type: finalTarget.type, severity: finalTarget.severity, message: incidentEvent.message, occurredAt: timestamp
      });
    }
    return { target: finalTarget, result, status, previousStatus: target.status, transition, incidentEvent, wasHealthy, recorded };
  }

  recordNotification({ incidentId = null, targetId = null, locationName = DEFAULT_LOCATION_NAME, kind, title, body, details = {} }) {
    this.db.prepare(`INSERT INTO notifications (incident_id, target_id, location_name, kind, title, body, delivered_at, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(incidentId, targetId, locationName, kind, title, body, now(), JSON.stringify(details));
  }

  listCheckHistory(filters = {}) {
    const normalized = validateHistoryFilters(filters);
    const clauses = [];
    const parameters = [];
    if (normalized.from) {
      clauses.push('r.checked_at >= ?');
      parameters.push(normalized.from);
    }
    if (normalized.to) {
      clauses.push('r.checked_at <= ?');
      parameters.push(normalized.to);
    }
    if (normalized.targetId) {
      clauses.push('r.target_id = ?');
      parameters.push(normalized.targetId);
    }
    if (normalized.type) {
      clauses.push('t.type = ?');
      parameters.push(normalized.type);
    }
    if (normalized.status) {
      clauses.push('r.status = ?');
      parameters.push(normalized.status);
    }
    if (normalized.outcome === 'success') clauses.push('r.ok = 1');
    if (normalized.outcome === 'failure') clauses.push('r.ok = 0');
    if (normalized.location) {
      clauses.push("r.location_name LIKE ? ESCAPE '\\'");
      parameters.push(`%${normalized.location.replace(/[\\%_]/g, '\\$&')}%`);
    }
    if (normalized.search) {
      clauses.push("(t.name LIKE ? ESCAPE '\\' OR r.location_name LIKE ? ESCAPE '\\' OR r.message LIKE ? ESCAPE '\\')");
      const escapedSearch = `%${normalized.search.replace(/[\\%_]/g, '\\$&')}%`;
      parameters.push(escapedSearch, escapedSearch, escapedSearch);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT r.*, t.name AS target_name, t.type AS target_type
      FROM check_results r JOIN targets t ON t.id = r.target_id
      ${where} ORDER BY r.checked_at DESC, r.id DESC LIMIT ?`).all(...parameters, normalized.limit);
    return { filters: normalized, results: rows.map(mapHistoryResult) };
  }

  getHistoryChanges({ targetIds = null, sinceId = null, limit = 100, reverse = false } = {}) {
    let query = `
      SELECT r.id, r.target_id, t.name AS target_name, t.type AS target_type,
             t.host AS target_host, t.metadata_json AS target_metadata_json,
             r.location_name, r.checked_at, r.ok, r.status, r.message, r.latency_ms,
             r.details_json, r.result_signature
      FROM check_results r
      JOIN targets t ON t.id = r.target_id
    `;
    const clauses = [];
    const params = [];

    if (sinceId !== null && sinceId !== undefined && Number(sinceId) > 0) {
      clauses.push('r.id > ?');
      params.push(Number(sinceId));
    }

    if (Array.isArray(targetIds) && targetIds.length > 0) {
      const placeholders = targetIds.map(() => '?').join(',');
      clauses.push(`r.target_id IN (${placeholders})`);
      params.push(...targetIds.map(Number));
    }

    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(' AND ')}`;
    }

    const safeLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 500) : 100;

    const settings = this.getAppSettings();
    const globalServiceUuid = settings?.serviceUuid?.trim() || 'ASSIGNED_SERVICE_UUID';
    const globalDeviceUuid = settings?.deviceUuid?.trim() || 'ASSIGNED_DEVICE_UUID';

    const mapHistoryRow = (row) => {
      const targetMeta = parseJson(row.target_metadata_json, {});
      const parsedDetails = parseJson(row.details_json, {});

      let targetType = row.target_type;
      if (targetType === 'ping') targetType = 'icmp';

      const targetId = targetMeta.targetUuid || targetMeta.uuid ? String(targetMeta.targetUuid || targetMeta.uuid) : row.target_id;
      const serviceUuid = targetMeta.serviceUuid || targetMeta.service_uuid || parsedDetails.service_uuid || globalServiceUuid;
      const deviceUuid = targetMeta.deviceUuid || targetMeta.device_uuid || parsedDetails.device_uuid || globalDeviceUuid;

      let ip = parsedDetails.ip || targetMeta.ip;
      if (!ip && row.target_host && !row.target_host.includes('/') && !row.target_host.includes(':')) {
        ip = row.target_host;
      }
      if (!ip && parsedDetails.gatewayIp) {
        ip = parsedDetails.gatewayIp;
      }

      const details = {
        ...parsedDetails,
        service_uuid: serviceUuid,
        device_uuid: deviceUuid,
        ...(ip ? { ip } : {})
      };

      return {
        id: row.id,
        targetId,
        targetName: row.target_name,
        targetType,
        locationName: row.location_name || DEFAULT_LOCATION_NAME,
        checkedAt: row.checked_at,
        ok: Boolean(row.ok),
        status: row.status,
        message: row.message,
        latencyMs: typeof row.latency_ms === 'number' ? Math.round(row.latency_ms) : (row.latency_ms ? Number(row.latency_ms) : 0),
        details
      };
    };

    if (reverse) {
      query += ` ORDER BY r.id DESC LIMIT ?`;
      params.push(safeLimit);
      const rows = this.db.prepare(query).all(...params);
      return rows.reverse().map(mapHistoryRow);
    }

    query += ` ORDER BY r.id ASC LIMIT ?`;
    params.push(safeLimit);
    const rows = this.db.prepare(query).all(...params);
    return rows.map(mapHistoryRow);
  }

  setHistorySyncCursor(lastId, lastSyncAt) {
    const timestamp = now();
    this.db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('last_history_sync_id', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(String(lastId ?? 0), timestamp);
    if (lastSyncAt) {
      this.db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('last_history_sync_at', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(String(lastSyncAt), timestamp);
    }
  }

  getHistorySyncCursor() {
    const rowId = this.db.prepare("SELECT value FROM app_settings WHERE key = 'last_history_sync_id'").get();
    const rowAt = this.db.prepare("SELECT value FROM app_settings WHERE key = 'last_history_sync_at'").get();
    return {
      lastId: rowId && Number.isInteger(Number(rowId.value)) ? Number(rowId.value) : 0,
      lastSyncAt: rowAt ? rowAt.value : null
    };
  }

  getMonthlyReport(month) {
    const period = validateReportMonth(month);
    const rows = this.db.prepare(`SELECT r.*, t.name AS target_name, t.type AS target_type
      FROM check_results r JOIN targets t ON t.id = r.target_id
      WHERE r.checked_at >= ? AND r.checked_at < ?
      ORDER BY r.checked_at ASC, r.id ASC`).all(period.from, period.to);
    const results = rows.map(mapHistoryResult);
    const summary = results.reduce((totals, result) => {
      totals.recordedChanges += 1;
      totals[result.ok ? 'successful' : 'failed'] += 1;
      totals.statuses[result.status] = (totals.statuses[result.status] || 0) + 1;
      return totals;
    }, { recordedChanges: 0, successful: 0, failed: 0, statuses: {} });
    return {
      ...period,
      generatedAt: now(),
      locations: [...new Set(results.map((result) => result.locationName))].sort((a, b) => a.localeCompare(b)),
      summary,
      results
    };
  }

  getDashboard() {
    const rawTargets = this.listTargets();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const recentResultsStmt = this.db.prepare(`
      SELECT latency_ms, ok, status, checked_at FROM check_results
      WHERE target_id = ? ORDER BY checked_at DESC LIMIT 15
    `);
    const uptimeStmt = this.db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) as healthy
      FROM check_results WHERE target_id = ? AND checked_at >= ?
    `);

    const targets = rawTargets.map((target) => {
      const recent = recentResultsStmt.all(target.id).reverse();
      const uptimeRow = uptimeStmt.get(target.id, thirtyDaysAgo);
      const uptimePercent = uptimeRow && uptimeRow.total > 0
        ? Number(((uptimeRow.healthy / uptimeRow.total) * 100).toFixed(1))
        : 100.0;
      const sparkline = recent.map((r) => r.latency_ms ?? (r.ok ? 1 : 0));
      return { ...target, uptimePercent, sparkline, recentResults: recent };
    });

    const activeIncidents = this.db.prepare(`SELECT i.*, t.name AS target_name FROM incidents i
      JOIN targets t ON t.id = i.target_id WHERE i.resolved_at IS NULL ORDER BY i.started_at DESC`).all()
      .map((row) => ({ id: row.id, targetId: row.target_id, targetName: row.target_name, locationName: row.location_name || DEFAULT_LOCATION_NAME, severity: row.severity, title: row.title, message: row.message, startedAt: row.started_at, acknowledgedAt: row.acknowledged_at }));
    const notifications = this.db.prepare('SELECT * FROM notifications ORDER BY delivered_at DESC LIMIT 20').all()
      .map((row) => ({ id: row.id, incidentId: row.incident_id, targetId: row.target_id, locationName: row.location_name || DEFAULT_LOCATION_NAME, kind: row.kind, title: row.title, body: row.body, deliveredAt: row.delivered_at }));
    const history = this.listCheckHistory({ limit: 80 }).results;
    const summary = {
      total: targets.filter((target) => target.enabled).length,
      healthy: targets.filter((target) => target.status === 'healthy').length,
      warning: targets.filter((target) => target.status === 'warning').length,
      down: targets.filter((target) => target.status === 'down').length,
      unknown: targets.filter((target) => target.status === 'unknown').length
    };
    return { summary, targets, activeIncidents, notifications, history };
  }

  acknowledgeIncident(incidentId, actorUserId) {
    const incident = this.db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
    if (!incident) throw new Error('Incident not found.');
    this.db.prepare('UPDATE incidents SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ?').run(now(), actorUserId, incidentId);
    this.audit(actorUserId, 'acknowledge_incident', 'incident', String(incidentId), {});
  }

  audit(actorUserId, action, entityType, entityId, details = {}) {
    this.db.prepare(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(actorUserId || null, action, entityType, entityId || null, JSON.stringify(details), now());
  }

  enqueueEvent(eventType, payload) {
    this.db.prepare('INSERT INTO outbound_events (event_type, payload_json, created_at) VALUES (?, ?, ?)')
      .run(eventType, JSON.stringify(payload), now());
  }

  getPendingOutboundEvents(limit = 25) {
    return this.db.prepare(`SELECT * FROM outbound_events
      WHERE delivered_at IS NULL AND attempts < 10
      ORDER BY id ASC LIMIT ?`).all(limit);
  }

  getPendingOutboundCount() {
    return this.db.prepare('SELECT COUNT(*) as count FROM outbound_events WHERE delivered_at IS NULL').get()?.count || 0;
  }

  markEventsDelivered(ids) {
    if (!ids || !ids.length) return;
    const update = this.db.prepare('UPDATE outbound_events SET delivered_at = ? WHERE id = ?');
    const timestamp = now();
    const tx = this.db.transaction((idList) => {
      for (const id of idList) update.run(timestamp, id);
    });
    tx(ids);
  }

  markEventFailed(id, errorMessage = '') {
    this.db.prepare(`UPDATE outbound_events
      SET attempts = attempts + 1, last_error = ? WHERE id = ?`)
      .run(String(errorMessage).slice(0, 500), id);
  }

  exportMonitorsJson(targetIds = null) {
    let targets = this.listTargets();
    if (Array.isArray(targetIds) && targetIds.length) {
      const set = new Set(targetIds.map(Number));
      targets = targets.filter((t) => set.has(t.id));
    }
    const cleanMonitors = targets.map((t) => ({
      name: t.name,
      locationName: t.locationName,
      type: t.type,
      host: t.host,
      port: t.port,
      url: t.url,
      interfaceName: t.interfaceName,
      serviceName: t.serviceName,
      processName: t.processName,
      intervalSeconds: t.intervalSeconds,
      timeoutMs: t.timeoutMs,
      failureThreshold: t.failureThreshold,
      recoveryThreshold: t.recoveryThreshold,
      severity: t.severity,
      downMessage: t.downMessage,
      recoveryMessage: t.recoveryMessage,
      enabled: t.enabled,
      metadata: t.metadata
    }));
    return {
      version: '2.0',
      exportedAt: now(),
      monitors: cleanMonitors
    };
  }

  importMonitorsJson(input, actorUserId, options = { onDuplicate: 'skip' }) {
    let monitors = [];
    if (Array.isArray(input)) {
      monitors = input;
    } else if (input && Array.isArray(input.monitors)) {
      monitors = input.monitors;
    } else {
      throw new Error('Invalid JSON format: expected an array of monitors or an object with a "monitors" list.');
    }

    const existingTargets = this.listTargets();
    const existingByName = new Map(existingTargets.map((t) => [t.name.toLowerCase(), t]));
    let importedCount = 0;
    let skippedCount = 0;
    let overwrittenCount = 0;
    const onDuplicate = options?.onDuplicate || 'skip';

    const tx = this.db.transaction(() => {
      for (const item of monitors) {
        const validated = validateTarget(item);
        const existing = existingByName.get(validated.name.toLowerCase());
        if (existing) {
          if (onDuplicate === 'skip') {
            skippedCount++;
            continue;
          } else if (onDuplicate === 'overwrite') {
            validated.id = existing.id;
            this.saveTarget(validated, actorUserId);
            overwrittenCount++;
            continue;
          } else if (onDuplicate === 'rename') {
            validated.name = `${validated.name} (Imported ${Date.now().toString().slice(-4)})`;
          }
        }
        this.saveTarget(validated, actorUserId);
        existingByName.set(validated.name.toLowerCase(), validated);
        importedCount++;
      }
    });
    tx();
    this.audit(actorUserId, 'import_monitors', 'targets', null, { importedCount, skippedCount, overwrittenCount, total: monitors.length });
    return { importedCount, skippedCount, overwrittenCount, total: monitors.length };
  }

  pruneHistory(days = 30) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM check_results WHERE checked_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM notifications WHERE delivered_at < ?').run(cutoff);
  }
}

module.exports = { LocalDatabase, ROLES, CHECK_TYPES, STATUSES, validateTarget, validateHistoryFilters };
