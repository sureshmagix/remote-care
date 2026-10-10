const os = require('node:os');

class HeartbeatService {
  constructor({ database, publisher, getSettings }) {
    this.database = database;
    this.publisher = publisher;
    this.getSettings = getSettings || (() => database.getAppSettings());
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    // Send immediate heartbeat on startup
    this.sendHeartbeat();
    const settings = this.getSettings();
    const intervalMinutes = Math.max(1, Number.parseInt(settings?.cloudHeartbeatMinutes ?? 5, 10));
    this.timer = setInterval(() => this.sendHeartbeat(), intervalMinutes * 60 * 1000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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

    const totalMonitors = dashboard?.summary?.total ?? 0;
    const healthyMonitors = dashboard?.summary?.healthy ?? 0;
    const warningMonitors = dashboard?.summary?.warning ?? 0;
    const downMonitors = dashboard?.summary?.down ?? 0;

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
        service_uuid: fullTelemetry.service_uuid,
        device_uuid: fullTelemetry.device_uuid,
        timestamp: fullTelemetry.timestamp
      };
    }

    return fullTelemetry;
  }

  sendHeartbeat() {
    try {
      const telemetry = this.collectTelemetry();
      this.database.enqueueEvent('device.heartbeat', telemetry);
      this.publisher?.trigger()?.catch?.(() => {});
      return telemetry;
    } catch (err) {
      // Non-fatal error; log or emit
      return null;
    }
  }
}

module.exports = { HeartbeatService };
