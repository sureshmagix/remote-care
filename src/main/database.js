const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { passwordRecord, validateUsername } = require('./auth');

const ROLES = Object.freeze({ SUPER_ADMIN: 'super_admin', VIEWER: 'viewer' });
const CHECK_TYPES = new Set(['internet', 'interface', 'gateway', 'ping', 'tcp', 'http', 'system_service', 'process']);
const STATUSES = new Set(['unknown', 'healthy', 'warning', 'down', 'disabled']);

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
      else if (target.status === 'unknown') status = 'warning';
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

    if (incidentEvent) {
      this.enqueueEvent(incidentEvent.kind === 'down' ? 'incident.opened' : 'incident.resolved', {
        targetId, targetName: target.name, type: target.type, severity: target.severity, message: incidentEvent.message, occurredAt: timestamp
      });
    }
    return { target: this.getTarget(targetId), result, status, transition, incidentEvent, wasHealthy };
  }

  recordNotification({ incidentId = null, targetId = null, kind, title, body, details = {} }) {
    this.db.prepare(`INSERT INTO notifications (incident_id, target_id, kind, title, body, delivered_at, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(incidentId, targetId, kind, title, body, now(), JSON.stringify(details));
  }

  getDashboard() {
    const targets = this.listTargets();
    const activeIncidents = this.db.prepare(`SELECT i.*, t.name AS target_name FROM incidents i
      JOIN targets t ON t.id = i.target_id WHERE i.resolved_at IS NULL ORDER BY i.started_at DESC`).all()
      .map((row) => ({ id: row.id, targetId: row.target_id, targetName: row.target_name, severity: row.severity, title: row.title, message: row.message, startedAt: row.started_at, acknowledgedAt: row.acknowledged_at }));
    const notifications = this.db.prepare('SELECT * FROM notifications ORDER BY delivered_at DESC LIMIT 20').all()
      .map((row) => ({ id: row.id, incidentId: row.incident_id, targetId: row.target_id, kind: row.kind, title: row.title, body: row.body, deliveredAt: row.delivered_at }));
    const history = this.db.prepare(`SELECT r.*, t.name AS target_name FROM check_results r
      JOIN targets t ON t.id = r.target_id ORDER BY r.checked_at DESC LIMIT 80`).all()
      .map((row) => ({ id: row.id, targetId: row.target_id, targetName: row.target_name, checkedAt: row.checked_at, ok: bool(row.ok), status: row.status, message: row.message, latencyMs: row.latency_ms, details: parseJson(row.details_json) }));
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

module.exports = { LocalDatabase, ROLES, CHECK_TYPES, STATUSES, validateTarget };
