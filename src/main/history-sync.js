const EventEmitter = require('node:events');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const { URL } = require('node:url');

class HistorySyncService extends EventEmitter {
  constructor({ database, getSettings }) {
    super();
    this.database = database;
    this.getSettings = getSettings || (() => database.getAppSettings());
    this.timer = null;
    this.isSyncing = false;
    this.lastSyncAt = null;
    this.lastError = null;
    this.lastSentCount = 0;
    this.lastPayload = null;
  }

  getEndpointUrl() {
    const settings = this.getSettings();
    if (settings?.historySyncUrl && settings.historySyncUrl.trim()) {
      return settings.historySyncUrl.trim();
    }
    if (settings?.serverBaseUrl && settings.serverBaseUrl.trim()) {
      const base = settings.serverBaseUrl.trim().replace(/\/+$/, '');
      return `${base}/api/history`;
    }
    return '';
  }

  getAuthToken() {
    const settings = this.getSettings();
    return (settings?.serverAuthToken?.trim() || settings?.cloudAuthToken?.trim() || 'Wiitronics_diagnostic');
  }

  getTargetIds() {
    const settings = this.getSettings();
    const raw = settings?.historySyncTargetIds;
    if (!raw || raw === 'all' || !String(raw).trim()) return null;
    const items = String(raw).split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
    return items.length > 0 ? items : null;
  }

  getIntervalMinutes() {
    const settings = this.getSettings();
    return Math.max(1, Math.min(1440, Number.parseInt(settings?.historySyncIntervalMinutes ?? 5, 10)));
  }

  isEnabled() {
    const settings = this.getSettings();
    return Boolean(settings?.historySyncEnabled);
  }

  buildPayload({ previewRecent = false, limit = 50, targetIds = undefined } = {}) {
    const resolvedTargets = targetIds !== undefined ? targetIds : this.getTargetIds();
    const cursor = this.database.getHistorySyncCursor();
    const settings = this.getSettings();
    const clientHostname = settings?.terminalHostname?.trim() || settings?.clientHostname?.trim() || os.hostname();

    let entries = [];
    if (previewRecent) {
      entries = this.database.getHistoryChanges({
        targetIds: resolvedTargets,
        limit,
        reverse: true
      });
    } else {
      entries = this.database.getHistoryChanges({
        targetIds: resolvedTargets,
        sinceId: cursor.lastId,
        limit: 100
      });
    }

    return {
      version: '2.0',
      dispatchedAt: new Date().toISOString(),
      clientHostname,
      targetIds: resolvedTargets === null ? 'all' : resolvedTargets,
      entriesCount: entries.length,
      history: entries.map((entry) => ({
        ...entry,
        targetId: String(entry.targetId)
      }))
    };
  }

  sendPayload(targetUrl, authToken, payload, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(targetUrl);
      } catch (err) {
        return reject(new Error(`Invalid history sync URL: ${err.message}`));
      }

      const data = JSON.stringify(payload);
      const transport = parsedUrl.protocol === 'https:' ? https : http;
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'RemoteCareMonitor-HistorySync/2.0'
      };
      const token = authToken && String(authToken).trim() ? String(authToken).trim() : 'Wiitronics_diagnostic';
      headers['Authorization'] = `Bearer ${token}`;
      headers['x-api-key'] = token;

      const req = transport.request(parsedUrl, {
        method: 'POST',
        headers,
        timeout: timeoutMs
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            let responseData = null;
            try {
              responseData = JSON.parse(body);
            } catch {}
            resolve({ ok: true, statusCode: res.statusCode, body, responseData });
          } else {
            reject(new Error(`History sync server returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`History sync timed out after ${timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(new Error(`History sync connection failed: ${err.message}`));
      });

      req.write(data);
      req.end();
    });
  }

  async syncNow({ force = false } = {}) {
    if (this.isSyncing) {
      return { skipped: true, reason: 'History sync is currently running.' };
    }
    const endpoint = this.getEndpointUrl();
    if (!force && (!this.isEnabled() || !endpoint)) {
      return { skipped: true, reason: 'History sync is disabled or endpoint is not configured.' };
    }
    if (!endpoint) {
      return { skipped: true, reason: 'History sync URL is not configured.' };
    }

    this.isSyncing = true;
    try {
      const payload = this.buildPayload({ previewRecent: false });
      const authToken = this.getAuthToken();
      const res = await this.sendPayload(endpoint, authToken, payload);

      if (payload.history.length > 0) {
        const maxId = Math.max(...payload.history.map((e) => e.id));
        this.database.setHistorySyncCursor(maxId, payload.dispatchedAt);
      } else {
        this.database.setHistorySyncCursor(this.database.getHistorySyncCursor().lastId, payload.dispatchedAt);
      }

      this.lastSyncAt = payload.dispatchedAt;
      this.lastSentCount = payload.history.length;
      this.lastPayload = payload;
      this.lastError = null;

      this.emit('synced', { timestamp: this.lastSyncAt, count: payload.history.length, payload });
      return { ok: true, sentCount: payload.history.length, timestamp: this.lastSyncAt, payload, result: res };
    } catch (err) {
      this.lastError = err.message;
      if (this.listenerCount('error') > 0) {
        try {
          this.emit('error', err);
        } catch (_) {}
      }
      return { ok: false, error: err.message };
    } finally {
      this.isSyncing = false;
    }
  }

  start() {
    if (this.timer) return;
    const intervalMinutes = this.getIntervalMinutes();
    this.timer = setInterval(() => {
      if (this.isEnabled()) {
        void this.syncNow().catch(() => {});
      }
    }, intervalMinutes * 60 * 1000);
    this.timer.unref?.();
    this.emit('started', { intervalMinutes });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit('stopped');
  }

  restart() {
    this.stop();
    this.start();
  }

  getStatus() {
    const cursor = this.database.getHistorySyncCursor();
    return {
      enabled: this.isEnabled(),
      endpoint: this.getEndpointUrl(),
      intervalMinutes: this.getIntervalMinutes(),
      targetIds: this.getTargetIds(),
      lastSyncAt: this.lastSyncAt || cursor.lastSyncAt,
      lastError: this.lastError,
      lastSentCount: this.lastSentCount,
      lastPayload: this.lastPayload
    };
  }
}

module.exports = { HistorySyncService };
