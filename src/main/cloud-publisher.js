const EventEmitter = require('node:events');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

class CloudPublisher extends EventEmitter {
  constructor({ database, getSettings }) {
    super();
    this.database = database;
    this.getSettings = getSettings || (() => database.getAppSettings());
    this.timer = null;
    this.isPublishing = false;
    this.lastSyncAt = null;
    this.lastError = null;
    this.deliveredCount = 0;
  }

  start(intervalMs = 15_000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.publishPending(), intervalMs);
    this.timer.unref?.();
    this.emit('started');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit('stopped');
  }

  trigger() {
    return this.publishPending();
  }

  getEndpointUrl() {
    const settings = this.getSettings();
    if (settings?.serverBaseUrl && settings.serverBaseUrl.trim()) {
      const base = settings.serverBaseUrl.trim().replace(/\/+$/, '');
      return `${base}/api/sync`;
    }
    return settings?.cloudHttpsUrl?.trim() || '';
  }

  getAuthToken() {
    const settings = this.getSettings();
    return (settings?.serverAuthToken?.trim() || settings?.cloudAuthToken?.trim() || '');
  }

  async publishPending(batchSize = 25) {
    if (this.isPublishing) return;
    const settings = this.getSettings();
    const endpoint = this.getEndpointUrl();
    if (!settings?.cloudSyncEnabled || !endpoint) {
      return { skipped: true, reason: 'Cloud/Server sync is disabled or endpoint is not configured.' };
    }

    this.isPublishing = true;
    try {
      const pending = this.database.getPendingOutboundEvents(batchSize);
      if (!pending || pending.length === 0) {
        return { publishedCount: 0 };
      }

      const payload = {
        version: '2.0',
        dispatchedAt: new Date().toISOString(),
        events: pending.map((row) => ({
          id: row.id,
          eventType: row.event_type,
          payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json,
          createdAt: row.created_at
        }))
      };

      const authToken = this.getAuthToken();
      const result = await this.sendBatch(endpoint, authToken, payload);
      const deliveredIds = pending.map((p) => p.id);
      this.database.markEventsDelivered(deliveredIds);
      this.deliveredCount += deliveredIds.length;
      this.lastSyncAt = new Date().toISOString();
      this.lastError = null;

      this.emit('batch_delivered', { count: deliveredIds.length, timestamp: this.lastSyncAt });
      return { publishedCount: deliveredIds.length, result };
    } catch (error) {
      this.lastError = error.message;
      this.emit('error', error);
      // Mark attempts for pending items
      const pending = this.database.getPendingOutboundEvents(batchSize);
      for (const row of pending) {
        this.database.markEventFailed(row.id, error.message);
      }
      return { error: error.message };
    } finally {
      this.isPublishing = false;
    }
  }

  sendBatch(targetUrl, authToken, payload, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(targetUrl);
      } catch (err) {
        return reject(new Error(`Invalid cloud URL: ${err.message}`));
      }

      const data = JSON.stringify(payload);
      const transport = parsedUrl.protocol === 'https:' ? https : http;
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'RemoteCareMonitor-CloudSync/2.0'
      };
      if (authToken && String(authToken).trim()) {
        headers['Authorization'] = `Bearer ${String(authToken).trim()}`;
      }

      const req = transport.request(parsedUrl, {
        method: 'POST',
        headers,
        timeout: timeoutMs
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, statusCode: res.statusCode });
          } else {
            reject(new Error(`Cloud server returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Cloud request timed out after ${timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(new Error(`Cloud connection failed: ${err.message}`));
      });

      req.write(data);
      req.end();
    });
  }

  getStatus() {
    const settings = this.getSettings();
    const endpoint = this.getEndpointUrl();
    let protocol = 'https';
    if (endpoint) {
      try {
        protocol = new URL(endpoint).protocol.replace(':', '');
      } catch {
        protocol = 'http';
      }
    }
    const pendingCount = this.database.getPendingOutboundCount?.() ?? 0;
    return {
      enabled: Boolean(settings?.cloudSyncEnabled),
      protocol,
      endpoint: endpoint || null,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      deliveredCount: this.deliveredCount,
      pendingCount
    };
  }
}

module.exports = { CloudPublisher };
