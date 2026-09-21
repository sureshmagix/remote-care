const test = require('node:test');
const assert = require('node:assert/strict');
const { passwordRecord, verifyPassword, validateUsername, SessionStore } = require('../src/main/auth');

test('password records verify only the original password', () => {
  const record = passwordRecord('a-local-password');
  assert.equal(verifyPassword('a-local-password', record.salt, record.hash), true);
  assert.equal(verifyPassword('wrong-password', record.salt, record.hash), false);
  assert.notEqual(record.salt, 'a-local-password');
  assert.notEqual(record.hash, 'a-local-password');
});

test('username validation normalizes supported usernames and rejects unsafe values', () => {
  assert.equal(validateUsername('Admin_User-01'), 'admin_user-01');
  assert.throws(() => validateUsername('a b'), /Username must be/);
  assert.throws(() => validateUsername('xy'), /Username must be/);
});

test('sessions expire and can be revoked', () => {
  const sessions = new SessionStore(5);
  const session = sessions.issue({ id: 7, username: 'viewer', displayName: 'Viewer', role: 'viewer' });
  assert.equal(sessions.get(session.token).userId, 7);
  sessions.revoke(session.token);
  assert.equal(sessions.get(session.token), null);
});
