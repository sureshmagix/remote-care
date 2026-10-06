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

    return {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      uptimeSeconds: os.uptime(),
      processUptimeSeconds: Math.round(process.uptime()),
      memory: {
        totalMb: Math.round(totalMem / (1024 * 1024)),
        freeMb: Math.round(freeMem / (1024 * 1024)),
        usedMb: Math.round(usedMem / (1024 * 1024)),
        usedPercent: Math.round((usedMem / totalMem) * 100)
      },
      loadAverage: os.loadavg(),
      cpuCores: os.cpus().length,
      monitorsSummary: dashboard?.summary || { total: 0, healthy: 0, warning: 0, down: 0 },
      activeIncidentsCount: dashboard?.activeIncidents?.length || 0,
      timestamp: new Date().toISOString()
    };
  }

  sendHeartbeat() {
    try {
      const telemetry = this.collectTelemetry();
      this.database.enqueueEvent('device.heartbeat', telemetry);
      this.publisher?.trigger();
      return telemetry;
    } catch (err) {
      // Non-fatal error; log or emit
      return null;
    }
  }
}

module.exports = { HeartbeatService };
