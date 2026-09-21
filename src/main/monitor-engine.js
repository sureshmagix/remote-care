const EventEmitter = require('node:events');
const { executeCheck } = require('./checks');

class MonitorEngine extends EventEmitter {
  constructor({ database, notify }) {
    super();
    this.database = database;
    this.notify = notify;
    this.nextRunAt = new Map();
    this.runningTargets = new Set();
    this.timer = null;
    this.pruneTimer = null;
  }

  start() {
    if (this.timer) return;
    this.refreshSchedule(true);
    this.timer = setInterval(() => this.tick(), 500);
    this.timer.unref?.();
    this.pruneTimer = setInterval(() => this.database.pruneHistory(30), 24 * 60 * 60 * 1000);
    this.pruneTimer.unref?.();
    this.emit('update', { type: 'engine_started' });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.timer = null;
    this.pruneTimer = null;
    this.nextRunAt.clear();
    this.emit('update', { type: 'engine_stopped' });
  }

  refreshSchedule(runImmediately = false) {
    const targets = this.database.listTargets();
    const validIds = new Set(targets.map((target) => target.id));
    for (const id of this.nextRunAt.keys()) if (!validIds.has(id)) this.nextRunAt.delete(id);
    const current = Date.now();
    for (const target of targets) {
      if (!target.enabled) {
        this.nextRunAt.delete(target.id);
        continue;
      }
      if (runImmediately || !this.nextRunAt.has(target.id)) this.nextRunAt.set(target.id, current);
    }
  }

  async tick() {
    const now = Date.now();
    const targets = this.database.listTargets();
    const tasks = [];
    for (const target of targets) {
      if (!target.enabled || this.runningTargets.has(target.id)) continue;
      const nextAt = this.nextRunAt.get(target.id) ?? now;
      if (nextAt <= now && tasks.length < 4) tasks.push(this.runTarget(target));
    }
    if (tasks.length) await Promise.allSettled(tasks);
  }

  async runTarget(target) {
    if (!target?.enabled || this.runningTargets.has(target.id)) return null;
    this.runningTargets.add(target.id);
    this.nextRunAt.set(target.id, Date.now() + target.intervalSeconds * 1000);
    try {
      const result = await executeCheck(target);
      const outcome = this.database.recordCheck(target.id, result);
      if (outcome?.incidentEvent) {
        const event = outcome.incidentEvent;
        const title = event.kind === 'down' ? `Critical: ${event.target.name}` : `Recovered: ${event.target.name}`;
        this.database.recordNotification({
          incidentId: event.incidentId,
          targetId: target.id,
          kind: event.kind,
          title,
          body: event.message,
          details: { severity: event.target.severity, result }
        });
        await this.notify?.({ kind: event.kind, title, body: event.message, target: event.target, result });
      }
      this.emit('update', { type: 'check_complete', targetId: target.id, outcome });
      return outcome;
    } finally {
      this.runningTargets.delete(target.id);
    }
  }

  async runNow(targetId) {
    const target = this.database.getTarget(Number(targetId));
    if (!target) throw new Error('Monitor not found.');
    if (!target.enabled) throw new Error('Enable the monitor before running it.');
    return this.runTarget(target);
  }

  dashboard() {
    return this.database.getDashboard();
  }
}

module.exports = { MonitorEngine };
