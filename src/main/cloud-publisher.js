const EventEmitter = require('node:events');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

class CloudPublisher extends EventEmitter {
  constructor({ database, getSettings, ensureHeartbeat }) {
    super();
    this.database = database;
    this.getSettings = getSettings || (() => database.getAppSettings());
    this.ensureHeartbeat = ensureHeartbeat || null;
    this.timer = null;
    this.isPublishing = false;
    this.pendingPublish = false;
    this.lastSyncAt = null;
    this.lastError = null;
    this.deliveredCount = 0;
    this.lastPayload = null;
    this.lastResponse = null;
  }

  start(intervalMs) {
    if (this.timer) return;
    const settings = this.getSettings();
    const resolvedIntervalMs = intervalMs || Math.max(2_000, Number.parseInt(settings?.serverSyncIntervalSeconds ?? 15, 10) * 1000);
    this.timer = setInterval(() => {
      void this.publishPending().catch(() => {});
    }, resolvedIntervalMs);
    if (!process.versions?.electron) {
      this.timer.unref?.();
    }
    this.emit('started');
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
    if (this.lastPayload && Array.isArray(this.lastPayload.events)) {
      const latestSettings = this.getSettings();
      this.lastPayload = {
        ...this.lastPayload,
        events: this.lastPayload.events
          .map((ev) => ({
            ...ev,
            payload: this.filterEventPayload(ev.eventType, { ...(ev.payload || {}) }, latestSettings)
          }))
          .filter((ev) => ev.payload !== null)
      };
    }
    this.start();
  }

  isMonitorSelected(item, settings) {
    if (!item) return false;
    const rawIds = settings?.historySyncTargetIds;
    if (rawIds && rawIds !== 'all' && String(rawIds).trim()) {
      const cleanIds = String(rawIds).trim().toLowerCase();
      if (cleanIds === 'none' || cleanIds === '__none__') return false;
      const allowedNumericIds = new Set(cleanIds.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0));
      if (allowedNumericIds.size > 0) {
        const allTargets = this.database?.listTargets?.() || [];
        const allowedKeys = new Set();
        const allowedNames = new Set();
        for (const t of allTargets) {
          if (allowedNumericIds.has(Number(t.id))) {
            allowedKeys.add(String(t.id));
            if (t.targetUuid) allowedKeys.add(String(t.targetUuid));
            if (t.name) allowedNames.add(String(t.name).toLowerCase());
          }
        }
        const itemId = String(item.targetId ?? item.id ?? '');
        const itemName = String(item.targetName ?? item.name ?? '').toLowerCase();
        const idMatches = (itemId && (allowedKeys.has(itemId) || allowedNumericIds.has(Number(itemId)))) || (itemName && allowedNames.has(itemName));
        if (!idMatches) return false;
      }
    }

    const rawTypes = settings?.historySyncTargetTypes;
    if (rawTypes && rawTypes !== 'all' && String(rawTypes).trim()) {
      const types = Array.isArray(rawTypes)
        ? rawTypes.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
        : String(rawTypes).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (types.includes('none') || types.includes('__none__')) return false;
      if (!types.includes('all') && types.length > 0) {
        const mType = String(item.type || item.targetType || '').trim().toLowerCase();
        if (mType) {
          const matched = types.some((rt) => (rt === 'icmp' || rt === 'ping') ? (mType === 'icmp' || mType === 'ping') : rt === mType);
          if (!matched) return false;
        }
      }
    }
    return true;
  }

  filterEventPayload(eventType, eventPayload, latestSettings) {
    if (!eventPayload || typeof eventPayload !== 'object') return eventPayload;
    if (eventType === 'incident.opened' || eventType === 'incident.resolved') {
      if (!this.isMonitorSelected({
        id: eventPayload.targetId,
        targetId: eventPayload.targetId,
        name: eventPayload.targetName || eventPayload.name,
        type: eventPayload.type
      }, latestSettings)) {
        return null;
      }
      return eventPayload;
    }

    if (eventType === 'device.heartbeat') {
      if (Array.isArray(eventPayload.monitors)) {
        const filteredMonitors = eventPayload.monitors.filter((m) => this.isMonitorSelected(m, latestSettings));
        eventPayload.monitors = filteredMonitors;
        eventPayload.monitorNames = filteredMonitors.map((m) => m.name || m.targetName);
        if (eventPayload.monitorsSummary) {
          eventPayload.monitorsSummary = {
            total: filteredMonitors.length,
            healthy: filteredMonitors.filter((m) => m.status === 'healthy').length,
            warning: filteredMonitors.filter((m) => m.status === 'warning').length,
            down: filteredMonitors.filter((m) => m.status === 'down').length
          };
        }
        if (typeof eventPayload.status === 'string') {
          eventPayload.status = filteredMonitors.some((m) => m.status === 'down') ? 'down' : 'healthy';
        }
      } else if (Array.isArray(eventPayload.monitorNames)) {
        const allTargets = (this.database?.listTargets?.() || []).filter((t) => t.enabled !== false);
        const allowedNames = new Set(
          allTargets.filter((t) => this.isMonitorSelected(t, latestSettings)).map((t) => t.name)
        );
        eventPayload.monitorNames = eventPayload.monitorNames.filter((name) => allowedNames.has(name));
      }
    }
    return eventPayload;
  }

  trigger({ force = false } = {}) {
    return this.publishPending(25, { force }).catch((err) => ({ error: err?.message || String(err) }));
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

  isEnabled() {
    const endpoint = this.getEndpointUrl();
    if (!endpoint) return false;
    const settings = this.getSettings();
    return Boolean(settings?.cloudSyncEnabled || endpoint);
  }

  async publishPending(batchSize = 25, { force = false } = {}) {
    if (this.isPublishing) {
      this.pendingPublish = true;
      if (!force) return { skipped: true, queued: true, reason: 'Cloud publish already in progress.' };
      // Wait for current in-flight publish to finish when forced manually
      for (let i = 0; i < 50 && this.isPublishing; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.isPublishing) return { skipped: true, queued: true, reason: 'Cloud publish already in progress.' };
    }
    const endpoint = this.getEndpointUrl();
    if (!endpoint) {
      return { skipped: true, reason: 'Cloud/Server endpoint is not configured.' };
    }
    if (!force && !this.isEnabled()) {
      return { skipped: true, reason: 'Cloud/Server sync is disabled.' };
    }

    this.isPublishing = true;
    this.pendingPublish = false;
    try {
      let totalPublished = 0;
      let lastResult = null;
      const allDispatchedEvents = [];
      let iterations = 0;

      while (iterations < 20) {
        iterations += 1;
        this.pendingPublish = false;
        let pending = this.database.getPendingOutboundEvents(batchSize);
        if ((!pending || pending.length === 0) && iterations === 1 && (force || !this.lastSyncAt) && typeof this.ensureHeartbeat === 'function') {
          try {
            this.ensureHeartbeat();
            pending = this.database.getPendingOutboundEvents(batchSize);
          } catch (_) {}
        }
        if (!pending || pending.length === 0) {
          break;
        }

        const latestSettings = this.getSettings();
        const latestHostname = latestSettings?.terminalHostname?.trim() || latestSettings?.clientHostname?.trim();
        const latestServiceUuid = latestSettings?.serviceUuid?.trim() || latestSettings?.service_uuid?.trim();
        const latestDeviceUuid = latestSettings?.deviceUuid?.trim() || latestSettings?.device_uuid?.trim();

        const filteredEvents = [];
        for (const row of pending) {
          let eventPayload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : { ...(row.payload_json || {}) };
          if (eventPayload && typeof eventPayload === 'object') {
            if (latestHostname) eventPayload.hostname = latestHostname;
            if (latestServiceUuid) eventPayload.service_uuid = latestServiceUuid;
            if (latestDeviceUuid) eventPayload.device_uuid = latestDeviceUuid;
            if (eventPayload.targetName && !eventPayload.name) {
              eventPayload.name = eventPayload.targetName;
            }
            eventPayload = this.filterEventPayload(row.event_type, eventPayload, latestSettings);
          }
          if (eventPayload === null) continue;
          filteredEvents.push({
            id: row.id,
            eventType: row.event_type,
            payload: eventPayload,
            createdAt: row.created_at
          });
        }

        const deliveredIds = pending.map((p) => p.id);
        if (filteredEvents.length === 0) {
          this.database.markEventsDelivered(deliveredIds);
          if (!this.pendingPublish && pending.length < batchSize) break;
          continue;
        }

        const payload = {
          version: '2.0',
          dispatchedAt: new Date().toISOString(),
          events: filteredEvents
        };

        const authToken = this.getAuthToken();
        allDispatchedEvents.push(...filteredEvents);
        this.lastPayload = {
          ...payload,
          events: [...allDispatchedEvents]
        };
        const result = await this.sendBatch(endpoint, authToken, payload);
        lastResult = result;
        this.lastResponse = result?.responseData || result;
        this.database.markEventsDelivered(deliveredIds);
        this.deliveredCount += filteredEvents.length;
        totalPublished += filteredEvents.length;
        this.lastSyncAt = new Date().toISOString();
        this.lastError = null;

        this.emit('batch_delivered', { count: filteredEvents.length, timestamp: this.lastSyncAt, result });
        if (!this.pendingPublish && pending.length < batchSize) {
          break;
        }
      }

      if (totalPublished === 0) {
        return { publishedCount: 0 };
      }
      return { publishedCount: totalPublished, result: lastResult };
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
    const settings = this.getSettings();
    const intervalMinutes = Math.max(1, Math.min(1440, Number.parseInt(settings?.cloudHeartbeatMinutes ?? 5, 10)));
    return {
      enabled: this.isEnabled(),
      protocol,
      endpoint: endpoint || null,
      intervalMinutes,
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
