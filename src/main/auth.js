const crypto = require('node:crypto');

const PASSWORD_MIN_LENGTH = 10;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`);
  }
}

function passwordRecord(password) {
  assertPassword(password);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  }).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  if (typeof password !== 'string' || !salt || !expectedHash) return false;
  const actual = crypto.scryptSync(password, salt, 64, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  const expected = Buffer.from(expectedHash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function validateUsername(username) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
    throw new Error('Username must be 3–40 characters and use only letters, numbers, dot, underscore, or hyphen.');
  }
  return username.trim().toLowerCase();
}

class SessionStore {
  constructor(ttlMs = SESSION_TTL_MS) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  issue(user) {
    this.prune();
    const token = crypto.randomUUID();
    const session = {
      token,
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      expiresAt: Date.now() + this.ttlMs
    };
    this.sessions.set(token, session);
    return session;
  }

  get(token) {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  revoke(token) {
    this.sessions.delete(token);
  }

  revokeUser(userId) {
    for (const [token, session] of this.sessions.entries()) {
      if (session.userId === userId) this.sessions.delete(token);
    }
  }

  prune() {
    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAt <= Date.now()) this.sessions.delete(token);
    }
  }
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  passwordRecord,
  verifyPassword,
  validateUsername,
  SessionStore
};
