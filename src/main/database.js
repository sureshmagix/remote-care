const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { passwordRecord, validateUsername, verifyPassword } = require('./auth');

const ROLES = Object.freeze({ SUPER_ADMIN: 'super_admin', VIEWER: 'viewer' });
const CHECK_TYPES = new Set(['internet', 'interface', 'gateway', 'ping', 'tcp', 'http', 'system_service', 'process']);
const STATUSES = new Set(['unknown', 'healthy', 'warning', 'down', 'disabled']);
const HISTORY_STATUSES = new Set(['unknown', 'healthy', 'warning', 'down']);
const HISTORY_OUTCOMES = new Set(['all', 'success', 'failure']);
const DEFAULT_APP_SETTINGS = Object.freeze({
  minimizeToTray: true,
  showTrayReminder: true,
  showFailureNotifications: true,
  showRecoveryNotifications: true,
  notificationDurationSeconds: 5
});
const APP_SETTING_KEYS = Object.freeze({
  minimizeToTray: 'minimize_to_tray',
  showTrayReminder: 'show_tray_reminder',
  showFailureNotifications: 'show_failure_notifications',
  showRecoveryNotifications: 'show_recovery_notifications',
  notificationDurationSeconds: 'notification_duration_seconds'
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
  return {
    id: row.id,
    name: row.name,
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
    metadata: parseJson(row.metadata_json),
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

  if (['ping', 'tcp'].includes(type) && !host) throw new Error('Host or IP address is required for this monitor.');
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

  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  return {
    id: input.id ? Number.parseInt(input.id, 10) : null,
    name,
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
  const requestedLimit = Number.parseInt(input.limit ?? 100, 10);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
  return { from, to, targetId, type, status, outcome, search, limit };
}

function mapHistoryResult(row) {
  return {
    id: row.id,
    targetId: row.target_id,
    targetName: row.target_name,
    targetType: row.target_type,
    checkedAt: row.checked_at,
    ok: bool(row.ok),
    status: row.status,
    message: row.message,
    latencyMs: row.latency_ms,
    details: parseJson(row.details_json)
  };
}

class LocalDatabase {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
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
        role TEXT NOT NULL CHECK(role IN ('super_admin', 'viewer')),
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
        ok INTEGER NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        latency_ms INTEGER,
        details_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_check_results_target_time ON check_results(target_id, checked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_check_results_time ON check_results(checked_at DESC);
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
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
        attempts INTEGER NOT NULL DEFAULT 0
      );
    `);
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
    return Object.fromEntries(Object.entries(APP_SETTING_KEYS).map(([name, key]) => [
      name,
      name === 'notificationDurationSeconds'
        ? (Number.isInteger(Number(stored.get(key))) && Number(stored.get(key)) >= 1 && Number(stored.get(key)) <= 300
          ? Number(stored.get(key)) : DEFAULT_APP_SETTINGS[name])
        : storedBool(stored.get(key), DEFAULT_APP_SETTINGS[name])
    ]));
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
      } else if (typeof input[name] !== 'boolean') throw new Error('Each setting must be enabled or disabled.');
      settings[name] = input[name];
    }
    const timestamp = now();
    const save = this.db.transaction(() => {
      for (const [name, key] of Object.entries(APP_SETTING_KEYS)) {
        this.db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(key, String(settings[name]), timestamp);
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

  createViewer({ username, displayName, password }, actorUserId) {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM users WHERE role = ?').get(ROLES.VIEWER).count;
    if (count >= 5) throw new Error('A maximum of five Viewer accounts is allowed.');
    const normalizedUsername = validateUsername(username);
    const record = passwordRecord(password);
    const timestamp = now();
    try {
      const info = this.db.prepare(`INSERT INTO users
        (username, display_name, role, password_salt, password_hash, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(normalizedUsername, String(displayName || normalizedUsername).trim().slice(0, 80), ROLES.VIEWER, record.salt, record.hash, timestamp, timestamp);
      this.audit(actorUserId, 'create_viewer', 'user', String(info.lastInsertRowid), { username: normalizedUsername });
      return this.getUserById(info.lastInsertRowid);
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(error.message)) throw new Error('That username already exists.');
      throw error;
    }
  }

  setViewerActive(userId, active, actorUserId) {
    const user = this.getUserById(userId);
    if (!user || user.role !== ROLES.VIEWER) throw new Error('Viewer account not found.');
    this.db.prepare('UPDATE users SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, now(), userId);
    this.audit(actorUserId, active ? 'enable_viewer' : 'disable_viewer', 'user', String(userId), {});
    return this.getUserById(userId);
  }

  resetViewerPassword(userId, password, actorUserId) {
    const user = this.getUserById(userId);
    if (!user || user.role !== ROLES.VIEWER) throw new Error('Viewer account not found.');
    const record = passwordRecord(password);
    this.db.prepare('UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?')
      .run(record.salt, record.hash, now(), userId);
    this.audit(actorUserId, 'reset_viewer_password', 'user', String(userId), {});
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

  updateViewer(userId, { username, displayName, active }, actorUserId) {
    const user = this.getUserById(userId);
    if (!user || user.role !== ROLES.VIEWER) throw new Error('Viewer account not found.');
    const normalizedUsername = validateUsername(username);
    const trimmedDisplayName = String(displayName || normalizedUsername).trim().slice(0, 80);
    const isActive = active !== false;
    try {
      this.db.prepare('UPDATE users SET username = ?, display_name = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(normalizedUsername, trimmedDisplayName, isActive ? 1 : 0, now(), userId);
      this.audit(actorUserId, 'update_viewer', 'user', String(userId), { username: normalizedUsername, displayName: trimmedDisplayName, active: isActive });
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
        name: 'Network interface', type: 'interface', interfaceName: 'auto', intervalSeconds: 5, timeoutMs: 2000,
        failureThreshold: 1, recoveryThreshold: 1, severity: 'critical', downMessage: 'Network adapter is disconnected.', recoveryMessage: 'Network adapter is connected.', metadata: {}
      },
      {
        name: 'Default gateway', type: 'gateway', intervalSeconds: 8, timeoutMs: 2500,
        failureThreshold: 2, recoveryThreshold: 1, severity: 'warning', downMessage: 'Local network gateway is not reachable.', recoveryMessage: 'Local network gateway is reachable again.', metadata: {}
      },
      {
        name: 'Internet connection', type: 'internet', url: 'https://www.cloudflare.com/cdn-cgi/trace', intervalSeconds: 10, timeoutMs: 5000,
        failureThreshold: 2, recoveryThreshold: 1, severity: 'critical', downMessage: 'Internet connection has been lost.', recoveryMessage: 'Internet connection has been restored.', metadata: { dnsHost: 'cloudflare.com' }
      }
    ];
    for (const target of defaults) this.saveTarget(target, null, true);
  }

  saveTarget(input, actorUserId, internal = false) {
    const target = validateTarget(input);
    const timestamp = now();
    const values = [
      target.name, target.type, target.host || null, target.port, target.url || null, target.interfaceName || null,
      target.serviceName || null, target.processName || null, target.intervalSeconds, target.timeoutMs,
      target.failureThreshold, target.recoveryThreshold, target.severity, target.downMessage, target.recoveryMessage,
      target.enabled ? 1 : 0, JSON.stringify(target.metadata), timestamp
    ];
    let id = target.id;
    if (id && this.getTarget(id)) {
      this.db.prepare(`UPDATE targets SET
        name=?, type=?, host=?, port=?, url=?, interface_name=?, service_name=?, process_name=?, interval_seconds=?, timeout_ms=?,
        failure_threshold=?, recovery_threshold=?, severity=?, down_message=?, recovery_message=?, enabled=?, metadata_json=?, updated_at=?
        WHERE id=?`).run(...values, id);
      if (!internal) this.audit(actorUserId, 'update_monitor', 'target', String(id), { name: target.name, type: target.type });
    } else {
      const info = this.db.prepare(`INSERT INTO targets
        (name, type, host, port, url, interface_name, service_name, process_name, interval_seconds, timeout_ms,
        failure_threshold, recovery_threshold, severity, down_message, recovery_message, enabled, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...values, timestamp);
      id = info.lastInsertRowid;
      if (!internal) this.audit(actorUserId, 'create_monitor', 'target', String(id), { name: target.name, type: target.type });
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
        (target_id, severity, title, message, started_at) VALUES (?, ?, ?, ?, ?)`)
        .run(target.id, target.severity, `${target.name} is unavailable`, target.downMessage || result.message, timestamp);
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
    this.db.prepare(`INSERT INTO check_results (target_id, checked_at, ok, status, message, latency_ms, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(targetId, timestamp, result.ok ? 1 : 0, status, String(result.message || ''), result.latencyMs ?? null, JSON.stringify(result.details || {}));

    const finalTarget = this.getTarget(targetId);
    if (incidentEvent) {
      incidentEvent.target = finalTarget;
      this.enqueueEvent(incidentEvent.kind === 'down' ? 'incident.opened' : 'incident.resolved', {
        targetId, targetName: finalTarget.name, type: finalTarget.type, severity: finalTarget.severity, message: incidentEvent.message, occurredAt: timestamp
      });
    }
    return { target: finalTarget, result, status, previousStatus: target.status, transition, incidentEvent, wasHealthy };
  }

  recordNotification({ incidentId = null, targetId = null, kind, title, body, details = {} }) {
    this.db.prepare(`INSERT INTO notifications (incident_id, target_id, kind, title, body, delivered_at, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(incidentId, targetId, kind, title, body, now(), JSON.stringify(details));
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
    if (normalized.search) {
      clauses.push("(t.name LIKE ? ESCAPE '\\' OR r.message LIKE ? ESCAPE '\\')");
      const escapedSearch = `%${normalized.search.replace(/[\\%_]/g, '\\$&')}%`;
      parameters.push(escapedSearch, escapedSearch);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT r.*, t.name AS target_name, t.type AS target_type
      FROM check_results r JOIN targets t ON t.id = r.target_id
      ${where} ORDER BY r.checked_at DESC, r.id DESC LIMIT ?`).all(...parameters, normalized.limit);
    return { filters: normalized, results: rows.map(mapHistoryResult) };
  }

  getDashboard() {
    const targets = this.listTargets();
    const activeIncidents = this.db.prepare(`SELECT i.*, t.name AS target_name FROM incidents i
      JOIN targets t ON t.id = i.target_id WHERE i.resolved_at IS NULL ORDER BY i.started_at DESC`).all()
      .map((row) => ({ id: row.id, targetId: row.target_id, targetName: row.target_name, severity: row.severity, title: row.title, message: row.message, startedAt: row.started_at, acknowledgedAt: row.acknowledged_at }));
    const notifications = this.db.prepare('SELECT * FROM notifications ORDER BY delivered_at DESC LIMIT 20').all()
      .map((row) => ({ id: row.id, incidentId: row.incident_id, targetId: row.target_id, kind: row.kind, title: row.title, body: row.body, deliveredAt: row.delivered_at }));
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

  pruneHistory(days = 30) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM check_results WHERE checked_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM notifications WHERE delivered_at < ?').run(cutoff);
  }
}

module.exports = { LocalDatabase, ROLES, CHECK_TYPES, STATUSES, validateTarget, validateHistoryFilters };
