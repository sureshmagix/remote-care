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
      name: 'Local test port', type: 'tcp', host: '127.0.0.1', port: 5555, intervalSeconds: 5, timeoutMs: 1000,
      failureThreshold: 2, recoveryThreshold: 1, severity: 'critical', downMessage: 'Test service down', recoveryMessage: 'Test service recovered', enabled: true
    }, admin.id);
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
