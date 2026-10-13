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
    this.pendingSync = false;
    this.lastSyncAt = null;
    this.lastAttemptAt = 0;
    this.lastError = null;
    this.lastSentCount = 0;
    this.lastPayload = null;
    this.lastResponse = null;
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
    if (String(raw).trim().toLowerCase() === 'none') return [];
    const items = String(raw).split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
    return items.length > 0 ? items : null;
  }

  getActiveMonitoredTargets(explicitTargetIds = undefined) {
    const allTargets = (this.database.listTargets?.() || []).filter((t) => t.enabled !== false);
    const configuredIds = explicitTargetIds !== undefined ? explicitTargetIds : this.getTargetIds();
    if (Array.isArray(configuredIds)) {
      if (configuredIds.length === 0) return [];
      const idSet = new Set(configuredIds.map(Number));
      return allTargets.filter((t) => idSet.has(Number(t.id)));
    }
    return allTargets;
  }

  getTargetTypes(explicitTargetIds = undefined) {
    const settings = this.getSettings();
    const raw = settings?.historySyncTargetTypes;
    const activeTargets = this.getActiveMonitoredTargets(explicitTargetIds);
    const activeTypesSet = new Set();
    for (const t of activeTargets) {
      if (t.type) {
        activeTypesSet.add(String(t.type).trim().toLowerCase());
      }
    }

    let configuredTypes = null;
    if (raw && raw !== 'all' && String(raw).trim()) {
      const items = Array.isArray(raw)
        ? raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
        : String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (items.includes('none')) return ['__none__'];
      if (!items.includes('all') && items.length > 0) {
        configuredTypes = items;
      }
    }

    if (configuredTypes) {
      if (activeTypesSet.size > 0) {
        const matched = configuredTypes.filter((type) => {
          if (type === 'icmp' || type === 'ping') {
            return activeTypesSet.has('icmp') || activeTypesSet.has('ping');
          }
          return activeTypesSet.has(type);
        });
        return matched.length > 0 ? matched : ['__none__'];
      }
      return configuredTypes;
    }

    if (activeTypesSet.size > 0) {
      return [...activeTypesSet];
    }
    return null;
  }

  getIntervalMinutes() {
    const settings = this.getSettings();
    return Math.max(1, Math.min(1440, Number.parseInt(settings?.historySyncIntervalMinutes ?? 5, 10)));
  }

  isEnabled() {
    const endpoint = this.getEndpointUrl();
    if (!endpoint) return false;
    const settings = this.getSettings();
    return Boolean(settings?.historySyncEnabled || endpoint);
  }

  hasUnsyncedChanges() {
    const resolvedTargets = this.getTargetIds();
    const resolvedTypes = this.getTargetTypes(resolvedTargets);
    const cursor = this.database.getHistorySyncCursor();
    const matchingTargets = this.getActiveMonitoredTargets(resolvedTargets).filter((t) => {
      if (!resolvedTypes) return true;
      if (resolvedTypes.includes('__none__') || resolvedTypes.includes('none')) return false;
      const tType = String(t.type || '').trim().toLowerCase();
      return resolvedTypes.some((rt) => (rt === 'icmp' || rt === 'ping') ? (tType === 'icmp' || tType === 'ping') : rt === tType);
    });
    const matchingTargetIds = matchingTargets.map((t) => Number(t.id));
    if (matchingTargetIds.length === 0) return false;
    const unsynced = this.database.getHistoryChanges({
      targetIds: matchingTargetIds,
      targetTypes: resolvedTypes,
      onlyEnabled: true,
      sinceId: cursor.lastId,
      limit: 1
    });
    return unsynced.length > 0;
  }

  buildPayload({ previewRecent = false, limit = 50, targetIds = undefined, targetTypes = undefined, onlyUnsynced = false } = {}) {
    const resolvedTargets = targetIds !== undefined ? targetIds : this.getTargetIds();
    const resolvedTypes = targetTypes !== undefined ? targetTypes : this.getTargetTypes(resolvedTargets);
    const cursor = this.database.getHistorySyncCursor();
    const settings = this.getSettings();
    const clientHostname = settings?.terminalHostname?.trim() || settings?.clientHostname?.trim() || os.hostname();

    const allActiveTargets = (this.database.listTargets?.() || []).filter((t) => t.enabled !== false);
    const matchingTargets = this.getActiveMonitoredTargets(resolvedTargets).filter((t) => {
      if (!resolvedTypes) return true;
      if (resolvedTypes.includes('__none__') || resolvedTypes.includes('none')) return false;
      const tType = String(t.type || '').trim().toLowerCase();
      return resolvedTypes.some((rt) => (rt === 'icmp' || rt === 'ping') ? (tType === 'icmp' || tType === 'ping') : rt === tType);
    });

    const matchingTargetIds = matchingTargets.map((t) => Number(t.id));

    let entries = [];
    if (matchingTargetIds.length > 0) {
      if (previewRecent) {
        entries = this.database.getHistoryChanges({
          targetIds: matchingTargetIds,
          targetTypes: resolvedTypes,
          onlyEnabled: true,
          limit,
          reverse: true
        });
      } else {
        entries = this.database.getHistoryChanges({
          targetIds: matchingTargetIds,
          targetTypes: resolvedTypes,
          onlyEnabled: true,
          sinceId: cursor.lastId,
          limit: 500
        });
        if (entries.length === 0 && !onlyUnsynced) {
          entries = this.database.getHistoryChanges({
            targetIds: matchingTargetIds,
            targetTypes: resolvedTypes,
            onlyEnabled: true,
            latestPerTarget: true,
            limit: 100
          });
        }
      }
    }

    const displayTypes = resolvedTypes === null
      ? (matchingTargets.length > 0 ? [...new Set(matchingTargets.map((t) => (t.type === 'ping' ? 'icmp' : t.type)))] : 'all')
      : [...new Set(resolvedTypes.filter((t) => t !== '__none__' && t !== 'none').map((t) => (t === 'ping' ? 'icmp' : t)))];

    const isAllMatching = resolvedTargets === null && (
      resolvedTypes === null ||
      (!resolvedTypes.includes('__none__') && !resolvedTypes.includes('none') && matchingTargets.length === allActiveTargets.length)
    );
    const payloadTargetIds = isAllMatching
      ? 'all'
      : (resolvedTargets !== null ? resolvedTargets : matchingTargetIds);

    return {
      version: '2.0',
      dispatchedAt: new Date().toISOString(),
      clientHostname,
      targetIds: payloadTargetIds,
      targetTypes: displayTypes,
      targetNames: matchingTargets.map((t) => t.name),
      monitors: matchingTargets.map((t) => ({
        id: t.targetUuid || String(t.id),
        targetId: t.targetUuid || String(t.id),
        name: t.name,
        targetName: t.name,
        type: t.type === 'ping' ? 'icmp' : t.type,
        locationName: t.locationName,
        status: t.status
      })),
      entriesCount: entries.length,
      history: entries.map((entry) => ({
        ...entry,
        name: entry.targetName || entry.name,
        targetName: entry.targetName || entry.name,
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
      this.pendingSync = true;
      if (!force) return { skipped: true, queued: true, reason: 'History sync is currently running.' };
      for (let i = 0; i < 50 && this.isSyncing; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.isSyncing) return { skipped: true, queued: true, reason: 'History sync is currently running.' };
    }
    const endpoint = this.getEndpointUrl();
    if (!force && (!this.isEnabled() || !endpoint)) {
      return { skipped: true, reason: 'History sync is disabled or endpoint is not configured.' };
    }
    if (!endpoint) {
      return { skipped: true, reason: 'History sync URL is not configured.' };
    }

    this.isSyncing = true;
    this.pendingSync = false;
    this.lastAttemptAt = Date.now();
    try {
      let totalSentCount = 0;
      let lastRes = null;
      let finalPayload = null;
      const allDispatchedHistory = [];
      let anyNewChanges = false;
      let iterations = 0;

      while (iterations < 20) {
        iterations += 1;
        this.pendingSync = false;
        const onlyUnsynced = iterations > 1;
        const hasNewInDb = this.hasUnsyncedChanges();
        if (hasNewInDb) anyNewChanges = true;
        const payload = this.buildPayload({ previewRecent: false, onlyUnsynced });
        if (onlyUnsynced && payload.history.length === 0) {
          break;
        }

        const authToken = this.getAuthToken();
        const res = await this.sendPayload(endpoint, authToken, payload);
        lastRes = res;

        if (payload.history.length > 0) {
          const maxId = Math.max(this.database.getHistorySyncCursor().lastId, ...payload.history.map((e) => e.id));
          this.database.setHistorySyncCursor(maxId, payload.dispatchedAt);
        } else {
          this.database.setHistorySyncCursor(this.database.getHistorySyncCursor().lastId, payload.dispatchedAt);
        }

        allDispatchedHistory.push(...payload.history);
        totalSentCount += payload.history.length;

        const allowedIds = new Set(payload.monitors.map((m) => String(m.id)));
        const allowedNames = new Set(payload.targetNames.map((n) => String(n).toLowerCase()));
        const prevFilteredHistory = (this.lastPayload?.history || []).filter((h) =>
          allowedIds.has(String(h.targetId)) || allowedNames.has(String(h.targetName || h.name || '').toLowerCase())
        );

        const fullHistory = (!anyNewChanges && prevFilteredHistory.length > 0)
          ? prevFilteredHistory
          : (allDispatchedHistory.length > 0 ? [...allDispatchedHistory] : prevFilteredHistory);

        this.lastSyncAt = payload.dispatchedAt;
        this.lastSentCount = totalSentCount;
        this.lastPayload = {
          ...payload,
          entriesCount: fullHistory.length,
          history: fullHistory
        };
        finalPayload = this.lastPayload;
        this.lastResponse = res?.responseData || res;
        this.lastError = null;

        this.emit('synced', { timestamp: this.lastSyncAt, count: payload.history.length, payload: this.lastPayload, result: res });

        if (!this.pendingSync && !this.hasUnsyncedChanges()) {
          break;
        }
      }

      return { ok: true, sentCount: totalSentCount, timestamp: this.lastSyncAt, payload: finalPayload, result: lastRes };
    } catch (err) {
      this.lastError = err.message;
      this.lastResponse = null;
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

  checkDue() {
    if (!this.isEnabled() || this.isSyncing) return Promise.resolve(null);
    const nowMs = Date.now();
    if (this.hasUnsyncedChanges() || this.lastError) {
      const retryDelayMs = 5_000;
      if (!this.lastAttemptAt || (nowMs - this.lastAttemptAt >= retryDelayMs)) {
        return this.syncNow().catch(() => null);
      }
      return Promise.resolve(null);
    }
    const intervalMs = this.getIntervalMinutes() * 60 * 1000;
    const lastSyncMs = this.lastSyncAt ? new Date(this.lastSyncAt).getTime() : 0;
    const baseline = Math.max(this.lastAttemptAt || 0, lastSyncMs || 0);
    if (!baseline || (nowMs - baseline >= intervalMs)) {
      return this.syncNow().catch(() => null);
    }
    return Promise.resolve(null);
  }

  start({ syncImmediate = true } = {}) {
    if (this.timer) return;
    if (syncImmediate && this.isEnabled()) {
      void this.syncNow({ force: true }).catch(() => {});
    }
    const intervalMinutes = this.getIntervalMinutes();
    this.timer = setInterval(() => {
      if (this.isEnabled()) {
        void this.syncNow().catch(() => {});
      }
    }, intervalMinutes * 60 * 1000);
    if (!process.versions?.electron) {
      this.timer.unref?.();
    }
    this.emit('started', { intervalMinutes });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit('stopped');
  }

  restart({ syncImmediate = true } = {}) {
    this.stop();
    if (this.lastPayload) {
      try {
        const preview = this.buildPayload({ previewRecent: true, limit: 50 });
        const allowedIds = new Set(preview.monitors.map((m) => String(m.id)));
        const allowedNames = new Set(preview.targetNames.map((n) => String(n).toLowerCase()));
        const existingFiltered = (this.lastPayload.history || []).filter((h) =>
          allowedIds.has(String(h.targetId)) || allowedNames.has(String(h.targetName || h.name || '').toLowerCase())
        );
        const keptHistory = existingFiltered.length > 0 ? existingFiltered : preview.history;
        this.lastPayload = {
          ...preview,
          entriesCount: keptHistory.length,
          history: keptHistory
        };
      } catch (_) {}
    }
    this.start({ syncImmediate });
  }

  getStatus() {
    const cursor = this.database.getHistorySyncCursor();
    return {
      enabled: this.isEnabled(),
      endpoint: this.getEndpointUrl(),
      intervalMinutes: this.getIntervalMinutes(),
      targetIds: this.getTargetIds(),
      targetTypes: this.getTargetTypes(),
      isSyncing: this.isSyncing,
      lastSyncAt: this.lastSyncAt || cursor.lastSyncAt,
      lastError: this.lastError,
      lastSentCount: this.lastSentCount,
      lastPayload: this.lastPayload,
      lastResponse: this.lastResponse
    };
  }
}

module.exports = { HistorySyncService };
