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
    this.lastPayload = null;
    this.lastResponse = null;
  }

  start(intervalMs = 15_000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.publishPending().catch(() => {});
    }, intervalMs);
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
    return this.publishPending().catch((err) => ({ error: err?.message || String(err) }));
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
    return (settings?.serverAuthToken?.trim() || settings?.cloudAuthToken?.trim() || 'Wiitronics_diagnostic');
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
      this.lastPayload = payload;
      const result = await this.sendBatch(endpoint, authToken, payload);
      this.lastResponse = result?.responseData || result;
      const deliveredIds = pending.map((p) => p.id);
      this.database.markEventsDelivered(deliveredIds);
      this.deliveredCount += deliveredIds.length;
      this.lastSyncAt = new Date().toISOString();
      this.lastError = null;

      this.emit('batch_delivered', { count: deliveredIds.length, timestamp: this.lastSyncAt, result });
      return { publishedCount: deliveredIds.length, result };
    } catch (error) {
      this.lastError = error.message;
      this.lastResponse = null;
      if (this.listenerCount('error') > 0) {
        try {
          this.emit('error', error);
        } catch (_) {}
      }
      // Mark attempts for pending items
      try {
        const pending = this.database.getPendingOutboundEvents(batchSize);
        for (const row of pending) {
          this.database.markEventFailed(row.id, error.message);
        }
      } catch (_) {}
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
      isPublishing: this.isPublishing,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      deliveredCount: this.deliveredCount,
      pendingCount,
      lastPayload: this.lastPayload,
      lastResponse: this.lastResponse
    };
  }
}

module.exports = { CloudPublisher };
