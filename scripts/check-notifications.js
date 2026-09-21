// Optional graphical smoke check: npm run test:notifications-ui
// Uses an isolated window; never opens the user's database or starts monitors.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { NotificationCenter } = require('../src/main/notification-center');

async function until(predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for notification UI.');
    await delay(25);
  }
}

app.whenReady().then(async () => {
  const center = new NotificationCenter({ openDashboard: () => {} });
  try {
    const occurredAt = new Date().toISOString();
    center.show({ kind: 'warning', title: 'Notification display check', body: 'Monitor changed from healthy to warning.', occurredAt }, 5000);
    await until(() => center.window?.isVisible());
    const displayedAt = Date.now();
    const content = await center.window.webContents.executeJavaScript(`({
      title: document.getElementById('notification-title').textContent,
      timestamp: document.getElementById('notification-time').dateTime,
      timeText: document.getElementById('notification-time').textContent,
      closeLabel: document.getElementById('notification-close').getAttribute('aria-label'),
      fits: document.getElementById('notification').getBoundingClientRect().height <= window.innerHeight
    })`);
    assert.equal(content.title, 'Notification display check');
    assert.equal(content.timestamp, occurredAt);
    assert.ok(content.timeText.length > 10);
    assert.equal(content.closeLabel, 'Dismiss notification');
    assert.equal(content.fits, true);
    const screenshot = await center.window.webContents.capturePage();
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-care-notification-')), 'notification.png');
    fs.writeFileSync(output, screenshot.toPNG());
    await until(() => !center.window.isVisible());
    assert.ok(Date.now() - displayedAt >= 4800, 'Popup expired before its five-second duration.');
    center.show({ kind: 'recovered', title: 'Close button check', body: 'Monitor recovered.', occurredAt }, 12000);
    await until(() => center.window.isVisible());
    await center.window.webContents.executeJavaScript("document.getElementById('notification-close').click()");
    await until(() => !center.window.isVisible(), 1000);
    center.show({ kind: 'healthy', title: 'Configured duration check', body: 'Monitor is healthy.', occurredAt }, 1000);
    await until(() => center.window.isVisible());
    await until(() => !center.window.isVisible(), 2000);
    console.log(`Notification UI passed: timestamp, layout, five-second expiry, close button, configured expiry. Screenshot: ${output}`);
  } finally {
    center.dispose();
  }
}).then(() => app.exit(0)).catch((error) => { console.error(error); app.exit(1); });
