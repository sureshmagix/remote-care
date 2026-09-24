const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalDatabase } = require('../src/main/database');

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-care-test-'));
  const database = new LocalDatabase(path.join(directory, 'remote-care.sqlite'));
  return { database, directory };
}

test('local database bootstraps an admin and stores monitor state transitions', () => {
  const { database, directory } = temporaryDatabase();
  try {
    assert.equal(database.getSetupState().requiresSetup, true);
    const admin = database.createInitialAdmin({ username: 'admin', displayName: 'Local Admin', password: 'monitor-password' });
    assert.equal(admin.role, 'super_admin');
    database.createDefaultTargets();
    assert.equal(database.listTargets().length, 3);
    const target = database.saveTarget({
      name: 'Local test port', locationName: 'Bengaluru office', type: 'tcp', host: '127.0.0.1', port: 5555, intervalSeconds: 5, timeoutMs: 1000,
      failureThreshold: 2, recoveryThreshold: 1, severity: 'critical', downMessage: 'Test service down', recoveryMessage: 'Test service recovered', enabled: true
    }, admin.id);
    assert.equal(target.locationName, 'Bengaluru office');
    const first = database.recordCheck(target.id, { ok: false, message: 'Connection refused', details: {} });
    assert.equal(first.status, 'warning');
    const second = database.recordCheck(target.id, { ok: false, message: 'Connection refused', details: {} });
    assert.equal(second.status, 'down');
    assert.equal(second.incidentEvent.kind, 'down');
    const recovered = database.recordCheck(target.id, { ok: true, message: 'Connected', latencyMs: 2, details: {} });
    assert.equal(recovered.status, 'healthy');
    assert.equal(recovered.incidentEvent.kind, 'recovered');
    assert.equal(database.getDashboard().activeIncidents.length, 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('app notification and tray settings use safe defaults and persist changes', () => {
  const { database, directory } = temporaryDatabase();
  try {
    const admin = database.createInitialAdmin({ username: 'admin', displayName: 'Local Admin', password: 'monitor-password' });
    assert.equal(database.verifySuperAdminPassword(admin.id, 'monitor-password'), true);
    assert.equal(database.verifySuperAdminPassword(admin.id, 'wrong-password'), false);
    assert.deepEqual(database.getAppSettings(), {
      minimizeToTray: true,
      showTrayReminder: true,
      showFailureNotifications: true,
      showRecoveryNotifications: true,
      notificationDurationSeconds: 5
    });
    const saved = database.updateAppSettings({
      minimizeToTray: true,
      showTrayReminder: false,
      showFailureNotifications: false,
      showRecoveryNotifications: true
    }, admin.id);
    assert.equal(saved.showTrayReminder, false);
    assert.equal(saved.showFailureNotifications, false);
    assert.deepEqual(database.getAppSettings(), saved);
    assert.equal(database.updateAppSettings({ notificationDurationSeconds: 12 }, admin.id).notificationDurationSeconds, 12);
    for (const value of [0, -1, 301, 1.5, '5', true, null, NaN, Infinity]) {
      assert.throws(() => database.updateAppSettings({ notificationDurationSeconds: value }, admin.id), /whole number/);
    }
    database.close();
    const reopened = new LocalDatabase(path.join(directory, 'remote-care.sqlite'));
    try {
      assert.equal(reopened.getAppSettings().notificationDurationSeconds, 12);
      reopened.db.prepare("UPDATE app_settings SET value = 'invalid' WHERE key = 'notification_duration_seconds'").run();
      assert.equal(reopened.getAppSettings().notificationDurationSeconds, 5);
    } finally {
      reopened.close();
    }
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('every changed monitor status notifies once, including warnings and initial health', async () => {
  const { database, directory } = temporaryDatabase();
  try {
    const admin = database.createInitialAdmin({ username: 'admin', displayName: 'Admin', password: 'monitor-password' });
    const target = database.saveTarget({
      name: 'Transition test', type: 'tcp', host: 'localhost', port: 80,
      intervalSeconds: 5, timeoutMs: 1000, failureThreshold: 2, recoveryThreshold: 2,
      severity: 'critical', downMessage: 'Offline', recoveryMessage: 'Recovered', enabled: true
    }, admin.id);
    let ok = true;
    const events = [];
    const updates = [];
    const { MonitorEngine } = require('../src/main/monitor-engine');
    const engine = new MonitorEngine({ database, check: async () => ({ ok, message: ok ? 'Connected' : 'Refused' }), notify: (event) => events.push(event) });
    engine.on('update', (event) => updates.push(event));
    const run = async (success) => { ok = success; return engine.runNow(target.id); };
    await run(true); // unknown → healthy
    await run(true); // no duplicate
    await run(false); // healthy → warning
    await run(true); // recovery threshold not reached
    await run(true); // warning → healthy
    await run(false); // healthy → warning
    await run(false); // warning → down
    await run(false); // no duplicate
    await run(true); // partial recovery
    assert.equal((await run(false)).status, 'down'); // keep the incident open
    await run(true);
    await run(true); // down → healthy
    assert.deepEqual(events.map((event) => event.kind), ['healthy', 'warning', 'recovered', 'warning', 'down', 'recovered']);
    for (const event of events) assert.equal(event.occurredAt, event.target.lastCheckedAt);
    assert.equal(database.getDashboard().notifications.length, events.length);
    assert.equal(database.getDashboard().activeIncidents.length, 0);
    assert.equal(updates.length, 12);

    engine.notify = () => { throw new Error('Desktop unavailable'); };
    const deliveryErrors = [];
    engine.on('notification-error', (error) => deliveryErrors.push(error));
    await run(false);
    assert.equal(deliveryErrors.length, 1);
    assert.equal(updates.length, 13);
    assert.equal(engine.runningTargets.size, 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an unfinished runtime session is marked as an unexpected shutdown on the next launch', () => {
  const { database, directory } = temporaryDatabase();
  try {
    database.startRuntimeSession('previous-run', { platform: 'test' });
    const nextRun = database.startRuntimeSession('current-run', { platform: 'test' });
    assert.equal(nextRun.interruptedCount, 1);
    const status = database.getRuntimeStatus();
    assert.ok(status.startedAt);
    assert.ok(status.lastUnexpectedShutdownAt);
    database.endRuntimeSession('current-run');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('check history keeps exact timestamps and applies database-side filters', () => {
  const { database, directory } = temporaryDatabase();
  try {
    const admin = database.createInitialAdmin({ username: 'admin', displayName: 'Local Admin', password: 'monitor-password' });
    const target = database.saveTarget({
      name: 'Filtered TCP service', type: 'tcp', host: '127.0.0.1', port: 8123, intervalSeconds: 5, timeoutMs: 1000,
      failureThreshold: 2, recoveryThreshold: 1, severity: 'warning', downMessage: 'Service unavailable', recoveryMessage: 'Service recovered', enabled: true
    }, admin.id);
    database.recordCheck(target.id, { ok: false, message: 'Connection refused', details: {} });
    database.recordCheck(target.id, { ok: false, message: 'Connection refused', details: {} });
    database.recordCheck(target.id, { ok: true, message: 'Connected', latencyMs: 4, details: {} });

    const failures = database.listCheckHistory({ targetId: target.id, outcome: 'failure', search: 'refused' });
    assert.equal(failures.results.length, 2);
    assert.equal(failures.results[0].targetType, 'tcp');
    assert.equal(failures.results[0].ok, false);
    assert.match(failures.results[0].checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const healthy = database.listCheckHistory({ type: 'tcp', outcome: 'success', status: 'healthy' });
    assert.equal(healthy.results.length, 1);
    assert.equal(healthy.results[0].message, 'Connected');

    assert.throws(() => database.listCheckHistory({ from: '2026-01-02T12:00:00Z', to: '2026-01-01T12:00:00Z' }), /before the end date/);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('history snapshots the location and records only material result changes', () => {
  const { database, directory } = temporaryDatabase();
  try {
    const admin = database.createInitialAdmin({ username: 'admin', displayName: 'Local Admin', password: 'monitor-password' });
    const target = database.saveTarget({
      name: 'Warehouse gateway', locationName: 'Mysuru warehouse', type: 'ping', host: '192.168.1.1', intervalSeconds: 5, timeoutMs: 1000,
      failureThreshold: 1, recoveryThreshold: 1, severity: 'warning', downMessage: 'Gateway unavailable', recoveryMessage: 'Gateway recovered', enabled: true
    }, admin.id);
    const first = database.recordCheck(target.id, {
      ok: true, message: 'Gateway replied.', latencyMs: 4,
      details: { gateway: '192.168.1.1', output: 'reply time=4ms', checkedAt: '2026-09-24T10:00:00.000Z' }
    });
    const unchanged = database.recordCheck(target.id, {
      ok: true, message: 'Gateway replied.', latencyMs: 19,
      details: { gateway: '192.168.1.1', output: 'reply time=19ms', checkedAt: '2026-09-24T10:00:19.000Z' }
    });
    const changed = database.recordCheck(target.id, {
      ok: true, message: 'Gateway replied.', latencyMs: 6,
      details: { gateway: '192.168.1.254', output: 'reply time=6ms', checkedAt: '2026-09-24T10:00:25.000Z' }
    });

    assert.equal(first.recorded, true);
    assert.equal(unchanged.recorded, false);
    assert.equal(changed.recorded, true);
    assert.equal(database.getTarget(target.id).lastLatencyMs, 6);

    const history = database.listCheckHistory({ location: 'Mysuru' });
    assert.equal(history.results.length, 2);
    assert.ok(history.results.every((result) => result.locationName === 'Mysuru warehouse'));

    const month = new Date().toISOString().slice(0, 7);
    const report = database.getMonthlyReport(month);
    assert.equal(report.month, month);
    assert.equal(report.summary.recordedChanges, 2);
    assert.deepEqual(report.locations, ['Mysuru warehouse']);
    assert.throws(() => database.getMonthlyReport('not-a-month'), /valid report month/i);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an upgraded history signature does not record an unchanged check again', () => {
  const { database, directory } = temporaryDatabase();
  try {
    const admin = database.createInitialAdmin({ username: 'admin', displayName: 'Local Admin', password: 'monitor-password' });
    const target = database.saveTarget({
      name: 'Upgrade signature test', type: 'system_service', serviceName: 'remote-care', intervalSeconds: 5, timeoutMs: 1000,
      failureThreshold: 1, recoveryThreshold: 1, severity: 'warning', downMessage: 'Service unavailable', recoveryMessage: 'Service recovered', enabled: true
    }, admin.id);
    database.recordCheck(target.id, { ok: true, message: 'Service is running.', details: { serviceName: 'remote-care', output: 'pid=101' } });
    // Simulate a database created by the previous signature format.
    database.db.prepare("UPDATE check_results SET result_signature = 'legacy-signature' WHERE target_id = ?").run(target.id);
    database.close();

    const reopened = new LocalDatabase(path.join(directory, 'remote-care.sqlite'));
    try {
      const unchanged = reopened.recordCheck(target.id, { ok: true, message: 'Service is running.', details: { serviceName: 'remote-care', output: 'pid=202' } });
      assert.equal(unchanged.recorded, false);
      assert.equal(reopened.listCheckHistory({ targetId: target.id }).results.length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    try { database.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('monitor engine dispatches notifications with appropriate severity and titles on service down and recovery', async () => {
  const { database, directory } = temporaryDatabase();
  try {
    const admin = database.createInitialAdmin({ username: 'admin', displayName: 'Local Admin', password: 'monitor-password' });
    const target = database.saveTarget({
      name: 'Auth Microservice', type: 'system_service', serviceName: 'auth-service', intervalSeconds: 5, timeoutMs: 1000,
      failureThreshold: 2, recoveryThreshold: 1, severity: 'critical', downMessage: 'Auth Microservice is down', recoveryMessage: 'Auth Microservice is up', enabled: true
    }, admin.id);

    const notifications = [];
    const { MonitorEngine } = require('../src/main/monitor-engine');
    const engine = new MonitorEngine({
      database,
      notify: async (event) => { notifications.push(event); }
    });

    database.recordCheck(target.id, { ok: true, message: 'Running' });
    assert.equal(database.getTarget(target.id).status, 'healthy');

    const fail1 = database.recordCheck(target.id, { ok: false, message: 'Service stopped' });
    assert.equal(fail1.status, 'warning');
    assert.equal(fail1.incidentEvent, null);

    const fail2 = database.recordCheck(target.id, { ok: false, message: 'Service stopped' });
    assert.equal(fail2.status, 'down');
    assert.ok(fail2.incidentEvent);
    assert.equal(fail2.incidentEvent.kind, 'down');
    assert.equal(fail2.incidentEvent.target.status, 'down');

    database.recordNotification({
      incidentId: fail2.incidentEvent.incidentId,
      targetId: target.id,
      kind: fail2.incidentEvent.kind,
      title: `Critical: ${target.name}`,
      body: fail2.incidentEvent.message
    });
    await engine.notify({ kind: 'down', title: `Critical: ${target.name}`, body: fail2.incidentEvent.message, target: fail2.incidentEvent.target });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].kind, 'down');
    assert.equal(notifications[0].title, 'Critical: Auth Microservice');
    assert.equal(notifications[0].body, 'Auth Microservice is down');

    const recovery = database.recordCheck(target.id, { ok: true, message: 'Service running' });
    assert.equal(recovery.status, 'healthy');
    assert.ok(recovery.incidentEvent);
    assert.equal(recovery.incidentEvent.kind, 'recovered');
    assert.equal(recovery.incidentEvent.target.status, 'healthy');

    database.recordNotification({
      incidentId: recovery.incidentEvent.incidentId,
      targetId: target.id,
      kind: recovery.incidentEvent.kind,
      title: `Recovered: ${target.name}`,
      body: recovery.incidentEvent.message
    });
    await engine.notify({ kind: 'recovered', title: `Recovered: ${target.name}`, body: recovery.incidentEvent.message, target: recovery.incidentEvent.target });

    assert.equal(notifications.length, 2);
    assert.equal(notifications[1].kind, 'recovered');
    assert.equal(notifications[1].title, 'Recovered: Auth Microservice');
    assert.equal(notifications[1].body, 'Auth Microservice is up');

    const dashboard = database.getDashboard();
    assert.equal(dashboard.notifications.length, 2);
    assert.equal(dashboard.activeIncidents.length, 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('user password change and profile management validate input and enforce constraints', () => {
  const { database, directory } = temporaryDatabase();
  try {
    const admin = database.createInitialAdmin({ username: 'admin', displayName: 'Super Admin', password: 'initial-admin-pwd' });
    const viewer = database.createViewer({ username: 'viewer1', displayName: 'Viewer One', password: 'viewer-initial-pwd' }, admin.id);

    // Profile update
    const updatedAdmin = database.updateUserProfile(admin.id, { username: 'admin_updated', displayName: 'Lead Admin' });
    assert.equal(updatedAdmin.username, 'admin_updated');
    assert.equal(updatedAdmin.displayName, 'Lead Admin');

    // Duplicate username should fail
    assert.throws(() => database.updateUserProfile(viewer.id, { username: 'admin_updated', displayName: 'Viewer One' }), /already taken/i);

    // Password change with wrong current password should fail
    assert.throws(() => database.changeUserPassword(admin.id, 'wrong-pwd', 'new-secure-password'), /Current password is incorrect/i);

    // Password change with too short new password should fail
    assert.throws(() => database.changeUserPassword(admin.id, 'initial-admin-pwd', 'short'), /at least 10 characters/i);

    // Successful password change
    const changeRes = database.changeUserPassword(admin.id, 'initial-admin-pwd', 'new-super-secret-password');
    assert.equal(changeRes.ok, true);

    // Verify new password works
    assert.equal(database.verifySuperAdminPassword(admin.id, 'new-super-secret-password'), true);
    assert.equal(database.verifySuperAdminPassword(admin.id, 'initial-admin-pwd'), false);

    // Admin updates viewer details and active status
    const updatedViewer = database.updateViewer(viewer.id, { username: 'viewer_renamed', displayName: 'Renamed Viewer', active: false }, admin.id);
    assert.equal(updatedViewer.username, 'viewer_renamed');
    assert.equal(updatedViewer.displayName, 'Renamed Viewer');
    assert.equal(updatedViewer.active, false);

    // Viewer changes own password
    database.setViewerActive(viewer.id, true, admin.id);
    database.changeUserPassword(viewer.id, 'viewer-initial-pwd', 'viewer-new-password');
    const viewerLogin = database.getUserForLogin('viewer_renamed');
    const { verifyPassword } = require('../src/main/auth');
    assert.equal(verifyPassword('viewer-new-password', viewerLogin.passwordSalt, viewerLogin.passwordHash), true);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
