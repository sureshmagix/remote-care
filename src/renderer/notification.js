/* global desktopNotification */
let currentId;
const notification = document.getElementById('notification');
document.getElementById('notification-close').addEventListener('click', () => desktopNotification.dismiss(currentId));
document.getElementById('notification-open').addEventListener('click', () => desktopNotification.openDashboard(currentId));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') desktopNotification.dismiss(currentId);
});
desktopNotification.onNotification((event) => {
  currentId = event.id;
  const kind = ['down', 'warning', 'recovered', 'healthy'].includes(event.kind) ? event.kind : 'info';
  notification.className = `toast ${kind}`;
  document.getElementById('notification-icon').textContent = ['down', 'warning'].includes(kind) ? '⚠' : ['healthy', 'recovered'].includes(kind) ? '✓' : 'ℹ';
  document.getElementById('notification-title').textContent = event.title;
  document.getElementById('notification-body').textContent = event.body;
  const time = document.getElementById('notification-time');
  time.dateTime = event.occurredAt;
  time.textContent = new Date(event.occurredAt).toLocaleString([], {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
  });
  desktopNotification.visible(event.id, notification.getBoundingClientRect().height);
});
