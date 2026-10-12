const os = require('node:os');

class HeartbeatService {
  constructor({ database, publisher, getSettings }) {
    this.database = database;
    this.publisher = publisher;
    this.getSettings = getSettings || (() => database.getAppSettings());
    this.timer = null;
    this.lastHeartbeatAt = 0;
  }

  getIntervalMinutes() {
    const settings = this.getSettings();
    return Math.max(1, Math.min(1440, Number.parseInt(settings?.cloudHeartbeatMinutes ?? 5, 10)));
  }

  start({ sendImmediate = true } = {}) {
    if (this.timer) return;
    if (sendImmediate) {
      this.sendHeartbeat({ triggerPublish: true });
    }
    const intervalMinutes = this.getIntervalMinutes();
    this.timer = setInterval(() => this.sendHeartbeat({ triggerPublish: true }), intervalMinutes * 60 * 1000);
    if (!process.versions?.electron) {
      this.timer.unref?.();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  restart({ sendImmediate = true } = {}) {
    this.stop();
    this.start({ sendImmediate });
  }

  checkDue() {
    if (!this.publisher?.isEnabled?.()) return;
    if (this.publisher.isPublishing) return;
    const intervalMs = this.getIntervalMinutes() * 60 * 1000;
    const lastSyncMs = this.publisher.lastSyncAt ? new Date(this.publisher.lastSyncAt).getTime() : 0;
    const baseline = Math.max(this.lastHeartbeatAt || 0, lastSyncMs || 0);
    if (!baseline || (Date.now() - baseline >= intervalMs)) {
      this.sendHeartbeat({ triggerPublish: true });
    }
  }

  getSelectedMonitoredTargets(dashboard, settings) {
    const rawTargets = (dashboard?.targets || []).filter((t) => t.enabled !== false);
    const rawIds = settings?.historySyncTargetIds;
    let filtered = rawTargets;
    if (rawIds && rawIds !== 'all' && String(rawIds).trim()) {
      if (String(rawIds).trim().toLowerCase() === 'none') {
        filtered = [];
      } else {
        const ids = new Set(String(rawIds).split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0));
        if (ids.size > 0) {
          filtered = filtered.filter((t) => ids.has(Number(t.id)));
        }
      }
    }

    const rawTypes = settings?.historySyncTargetTypes;
    if (rawTypes && rawTypes !== 'all' && String(rawTypes).trim()) {
      const types = Array.isArray(rawTypes)
        ? rawTypes.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
        : String(rawTypes).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (types.includes('none')) {
        filtered = [];
      } else if (!types.includes('all') && types.length > 0) {
        filtered = filtered.filter((t) => {
          const tType = String(t.type || '').toLowerCase();
          return types.some((rt) => (rt === 'icmp' || rt === 'ping') ? (tType === 'icmp' || tType === 'ping') : rt === tType);
        });
      }
    }
    return filtered;
  }

  collectTelemetry() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const dashboard = this.database.getDashboard();
    const settings = this.getSettings();
    const selection = settings?.telemetrySelection || 'all';

    const hostname = settings?.terminalHostname?.trim() || settings?.clientHostname?.trim() || os.hostname();
    const service_uuid = settings?.serviceUuid?.trim() || settings?.service_uuid?.trim() || 'ASSIGNED_SERVICE_UUID';
    const device_uuid = settings?.deviceUuid?.trim() || settings?.device_uuid?.trim() || 'ASSIGNED_DEVICE_UUID';

    const monitoredTargets = this.getSelectedMonitoredTargets(dashboard, settings);
    const monitors = monitoredTargets.map((t) => ({
      id: t.targetUuid || String(t.id),
      targetId: t.targetUuid || String(t.id),
      name: t.name,
      targetName: t.name,
      type: t.type === 'ping' ? 'icmp' : t.type,
      locationName: t.locationName,
      status: t.status,
      ok: t.status === 'healthy',
      latencyMs: t.lastLatencyMs ?? null,
      lastCheckedAt: t.lastCheckedAt || null
    }));

    const totalMonitors = monitoredTargets.length;
    const healthyMonitors = monitoredTargets.filter((t) => t.status === 'healthy').length;
    const warningMonitors = monitoredTargets.filter((t) => t.status === 'warning').length;
    const downMonitors = monitoredTargets.filter((t) => t.status === 'down').length;

    const fullTelemetry = {
      hostname,
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: Math.round(os.uptime()),
      processUptimeSeconds: Math.round(process.uptime()),
      memory: {
        totalMb: Math.round(totalMem / (1024 * 1024)),
        freeMb: Math.round(freeMem / (1024 * 1024)),
        usedMb: Math.round(usedMem / (1024 * 1024)),
        usedPercent: Number(((usedMem / totalMem) * 100).toFixed(1))
      },
      loadAverage: os.loadavg(),
      cpuCores: os.cpus().length,
      monitorsSummary: {
        total: totalMonitors,
        healthy: healthyMonitors,
        warning: warningMonitors,
        down: downMonitors
      },
      monitorNames: monitoredTargets.map((t) => t.name),
      monitors,
      activeIncidentsCount: dashboard?.activeIncidents?.length || 0,
      service_uuid,
      device_uuid,
      timestamp: new Date().toISOString()
    };

    if (selection === 'system_metrics') {
      return {
        hostname: fullTelemetry.hostname,
        platform: fullTelemetry.platform,
        uptimeSeconds: fullTelemetry.uptimeSeconds,
        memory: fullTelemetry.memory,
        loadAverage: fullTelemetry.loadAverage,
        cpuCores: fullTelemetry.cpuCores,
        service_uuid: fullTelemetry.service_uuid,
        device_uuid: fullTelemetry.device_uuid,
        timestamp: fullTelemetry.timestamp
      };
    }

    if (selection === 'monitors_only') {
      return {
        hostname: fullTelemetry.hostname,
        monitorsSummary: fullTelemetry.monitorsSummary,
        monitorNames: fullTelemetry.monitorNames,
        monitors: fullTelemetry.monitors,
        activeIncidentsCount: fullTelemetry.activeIncidentsCount,
        service_uuid: fullTelemetry.service_uuid,
        device_uuid: fullTelemetry.device_uuid,
        timestamp: fullTelemetry.timestamp
      };
    }

    if (selection === 'minimal') {
      return {
        hostname: fullTelemetry.hostname,
        status: fullTelemetry.monitorsSummary.down > 0 ? 'down' : 'healthy',
        monitorNames: fullTelemetry.monitorNames,
        service_uuid: fullTelemetry.service_uuid,
        device_uuid: fullTelemetry.device_uuid,
        timestamp: fullTelemetry.timestamp
      };
    }

    return fullTelemetry;
  }

  sendHeartbeat({ triggerPublish = true } = {}) {
    try {
      this.lastHeartbeatAt = Date.now();
      const telemetry = this.collectTelemetry();
      this.database.clearPendingHeartbeats?.();
      this.database.enqueueEvent('device.heartbeat', telemetry);
      if (triggerPublish && this.publisher) {
        const enabled = typeof this.publisher.isEnabled === 'function' ? this.publisher.isEnabled() : true;
        if (enabled) {
          this.publisher.trigger({ force: true })?.catch?.(() => {});
        }
      }
      return telemetry;
    } catch (err) {
      // Non-fatal error; log or emit
      return null;
    }
  }
}

module.exports = { HeartbeatService };
