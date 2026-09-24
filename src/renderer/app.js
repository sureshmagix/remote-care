/* global remoteCare */
const state = {
  session: null,
  dashboard: null,
  adapters: null,
  users: [],
  settings: null,
  appInfo: null,
  page: 'overview',
  refreshTimer: null,
  dashboardPollTimer: null,
  clockTimer: null,
  historyFilters: {}
};

const DASHBOARD_POLL_INTERVAL_MS = 2_000;
const ADAPTER_REFRESH_INTERVAL_MS = 30_000;
let adapterRefreshInFlight = false;
let lastAdapterRefreshAt = 0;
let dashboardRefreshVersion = 0;

const root = document.getElementById('app');
const toastRegion = document.getElementById('toast-region');
const isAdmin = () => state.session?.role === 'super_admin';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function prettyType(type) {
  return ({ internet: 'Internet', interface: 'Network interface', gateway: 'Default gateway', ping: 'ICMP ping', tcp: 'TCP port', http: 'HTTP/HTTPS', system_service: 'Local service', process: 'Local process' }[type] || type);
}

function prettyTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
  });
}

function toDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const part = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function currentMonthValue() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function liveClockMarkup() {
  return '<div class="live-clock"><span>Local date &amp; time</span><time id="local-clock"></time></div>';
}

function startLiveClock() {
  const update = () => {
    const clock = document.getElementById('local-clock');
    if (!clock) return;
    const timestamp = new Date();
    clock.dateTime = timestamp.toISOString();
    clock.textContent = prettyTime(timestamp);
  };
  update();
  if (!state.clockTimer) {
    state.clockTimer = setInterval(update, 1_000);
  }
}

function stopLiveClock() {
  clearInterval(state.clockTimer);
  state.clockTimer = null;
}

function age(value) {
  if (!value) return 'Never';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function targetDestination(target) {
  if (target.type === 'http' || target.type === 'internet') return target.url;
  if (target.type === 'tcp') return `${target.host}:${target.port}`;
  if (target.type === 'ping') return target.host;
  if (target.type === 'interface') return target.interfaceName === 'auto' ? 'Automatic interface' : target.interfaceName;
  if (target.type === 'system_service') return target.serviceName;
  if (target.type === 'process') return target.processName;
  return 'Automatic local gateway';
}

function statusClass(status) {
  return ['healthy', 'down', 'warning', 'unknown'].includes(status) ? status : 'unknown';
}

function badge(status, label = status) {
  return `<span class="badge ${statusClass(status)}"><span class="dot ${statusClass(status) === 'healthy' ? 'good' : statusClass(status)}"></span>${escapeHtml(label)}</span>`;
}

let audioCtx = null;
function playNotificationChime(kind = 'info') {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (kind === 'down') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(349.23, now);
      osc.frequency.setValueAtTime(261.63, now + 0.12);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.36);
    } else if (kind === 'recovered') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(783.99, now + 0.08);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.31);
    } else {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(659.25, now);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.start(now);
      osc.stop(now + 0.19);
    }
  } catch {
    // Audio context may fail if audio is not permitted yet
  }
}

function ensureToastPopover() {
  if (toastRegion && typeof toastRegion.showPopover === 'function') {
    try {
      // A popover outside a modal dialog is inert. Keep close buttons usable.
      const dialogs = document.querySelectorAll('dialog[open]');
      const parent = dialogs[dialogs.length - 1] || document.body;
      if (toastRegion.parentElement !== parent) {
        toastRegion.hidePopover();
        parent.append(toastRegion);
        if (parent !== document.body) parent.addEventListener('close', () => {
          document.body.append(toastRegion);
          ensureToastPopover();
        }, { once: true });
      }
      if (!toastRegion.matches(':popover-open')) {
        toastRegion.showPopover();
      }
    } catch {
      // Ignored if already open or popover API unavailable
    }
  }
}

function flash(message, kind = 'info', options = {}) {
  ensureToastPopover();
  if (!options.silent) {
    playNotificationChime(kind);
  }

  const customTitle = options.title;
  const customSubtitle = options.subtitle;
  const duration = (state.settings?.notificationDurationSeconds ?? 5) * 1000;

  const presentation = kind === 'down'
    ? { title: customTitle || 'Monitoring alert', icon: '⚠', label: 'Critical alert', badge: 'ALERT' }
    : kind === 'recovered'
      ? { title: customTitle || 'Monitor recovered', icon: '✓', label: 'Recovery alert', badge: 'RECOVERED' }
      : { title: customTitle || 'Remote Care Monitor', icon: 'ℹ', label: 'Application notification', badge: 'SYSTEM' };

  const element = document.createElement('article');
  element.className = `toast ${kind}`;
  element.setAttribute('role', kind === 'down' ? 'alert' : 'status');
  element.setAttribute('aria-label', presentation.label);

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = presentation.icon;

  const copy = document.createElement('div');
  copy.className = 'toast-copy';

  const header = document.createElement('div');
  header.className = 'toast-header';

  const title = document.createElement('strong');
  title.className = 'toast-title';
  title.textContent = presentation.title;
  header.append(title);

  if (customSubtitle) {
    const sub = document.createElement('span');
    sub.className = 'toast-subtitle';
    sub.textContent = customSubtitle;
    header.append(sub);
  }

  const body = document.createElement('span');
  body.className = 'toast-body';
  body.textContent = message;

  const time = document.createElement('time');
  time.className = 'toast-time';
  time.dateTime = options.occurredAt || new Date().toISOString();
  time.textContent = prettyTime(time.dateTime);
  copy.append(header, body, time);

  if (options.actions && options.actions.length) {
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'toast-actions';
    for (const act of options.actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-btn';
      btn.textContent = act.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        act.onClick();
        dismiss();
      });
      actionsContainer.append(btn);
    }
    copy.append(actionsContainer);
  }

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '×';

  const progress = document.createElement('span');
  progress.className = 'toast-progress';
  progress.style.animationDuration = `${duration}ms`;

  let timerId = null;

  const dismiss = () => {
    if (element.dataset.closing) return;
    element.dataset.closing = 'true';
    if (timerId) clearTimeout(timerId);
    element.remove();
  };

  close.addEventListener('click', dismiss);

  element.append(icon, copy, close, progress);
  toastRegion.prepend(element);
  timerId = setTimeout(dismiss, duration);
}

async function request(action) {
  try {
    return await action();
  } catch (error) {
    if (/session has expired/i.test(error.message)) {
      stopDashboardPolling();
      clearTimeout(state.refreshTimer);
      state.session = null;
      sessionStorage.removeItem('remote-care-session');
      renderAuth();
    }
    throw error;
  }
}

function renderAuth(setup = null) {
  root.innerHTML = `
    <main class="auth-shell">
      <section class="auth-card">
        <div class="brand"><div class="brand-mark">RC</div><div><h1>Remote Care Monitor</h1><p>Local network and service monitoring</p></div></div>
        <div id="auth-content"></div>
      </section>
    </main>`;
  const content = document.getElementById('auth-content');
  const isSetup = setup?.requiresSetup;
  content.innerHTML = isSetup ? `
    <h2>Secure the local monitor</h2>
    <p class="helper">Create the first Super Admin account. This account controls monitors, notifications, and up to five local Viewer accounts.</p>
    <form id="setup-form">
      <div class="field"><label for="setup-name">Display name</label><input id="setup-name" name="displayName" required maxlength="80" autocomplete="name" placeholder="Administrator" /></div>
      <div class="field"><label for="setup-user">Username</label><input id="setup-user" name="username" required minlength="3" maxlength="40" autocomplete="username" placeholder="admin" /></div>
      <div class="field"><label for="setup-password">Password</label><input id="setup-password" name="password" required minlength="10" type="password" autocomplete="new-password" placeholder="At least 10 characters" /></div>
      <div class="field"><label for="setup-confirm">Confirm password</label><input id="setup-confirm" required minlength="10" type="password" autocomplete="new-password" /></div>
      <div class="actions"><button class="button" type="submit">Create Super Admin</button></div><div class="error" id="auth-error"></div>
    </form>` : `
    <h2>Welcome back</h2>
    <p class="helper">Sign in to view the local monitoring dashboard.</p>
    <form id="login-form">
      <div class="field"><label for="login-user">Username</label><input id="login-user" name="username" required autocomplete="username" autofocus /></div>
      <div class="field"><label for="login-password">Password</label><input id="login-password" name="password" required type="password" autocomplete="current-password" /></div>
      <div class="actions"><button class="button" type="submit">Sign in</button></div><div class="error" id="auth-error"></div>
    </form>`;
  const form = content.querySelector('form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('auth-error');
    error.textContent = '';
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      let response;
      if (isSetup) {
        if (document.getElementById('setup-password').value !== document.getElementById('setup-confirm').value) throw new Error('The passwords do not match.');
        response = await remoteCare.setupAdmin(values);
      } else response = await remoteCare.login(values);
      state.session = response.session;
      sessionStorage.setItem('remote-care-session', JSON.stringify(state.session));
      await openDashboard();
    } catch (exception) {
      error.textContent = exception.message || 'Unable to sign in.';
    }
  });
}

async function openDashboard() {
  state.settings = await request(() => remoteCare.getAppSettings(state.session.token));
  renderShell();
  await refreshDashboard(true);
  startDashboardPolling();
  const control = await request(() => remoteCare.getAppControlState(state.session.token));
  if (control.pendingProtectedQuit) {
    if (control.canAuthorizeQuit) openQuitDialog('tray');
    else flash('A Super Admin password is required to quit the monitor.', 'info');
  }
}

function renderShell() {
  const role = isAdmin() ? 'Super Admin' : 'Viewer';
  root.innerHTML = `
    <main class="app-shell">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">RC</div><div><h1>Remote Care</h1><p>Local Monitor</p></div></div>
        <nav class="nav" aria-label="Dashboard navigation">
          <button data-page="overview">● Overview</button>
          <button data-page="monitors">◉ Monitors</button>
          <button data-page="history">◷ History</button>
          <button data-page="users">♙ Users</button>
          ${isAdmin() ? '<button data-page="settings">⚙ Settings</button>' : ''}
          <button data-page="about">ⓘ About</button>
        </nav>
        <div class="sidebar-footer">
          <div class="user-chip" id="profile-chip" title="Manage your profile and password">
            <strong>${escapeHtml(state.session.displayName)}</strong>
            <span>${escapeHtml(role)} · @${escapeHtml(state.session.username || state.session.userId)}</span>
            <small>Profile &amp; password →</small>
          </div>
          <div class="sidebar-user-actions">
            <button class="button ghost small" id="profile-btn">Account</button>
            <button class="button ghost small" id="logout">Sign out</button>
          </div>
        </div>
      </aside>
      <section class="content" id="page-content"></section>
    </main>`;
  root.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', async () => {
    state.page = button.dataset.page;
    await renderPage();
  }));
  const openProfile = () => openProfileDialog();
  document.getElementById('profile-chip')?.addEventListener('click', openProfile);
  document.getElementById('profile-btn')?.addEventListener('click', openProfile);
  document.getElementById('logout').addEventListener('click', async () => {
    await remoteCare.logout(state.session.token);
    stopLiveClock();
    stopDashboardPolling();
    clearTimeout(state.refreshTimer);
    dashboardRefreshVersion += 1;
    state.session = null;
    state.dashboard = null;
    state.adapters = null;
    lastAdapterRefreshAt = 0;
    state.historyFilters = {};
    sessionStorage.removeItem('remote-care-session');
    const setup = await remoteCare.getSetupState();
    renderAuth(setup);
  });
}

function overallStatus() {
  const summary = state.dashboard.summary;
  if (summary.down) return { text: `${summary.down} critical issue${summary.down === 1 ? '' : 's'}`, className: 'down' };
  if (summary.warning) return { text: `${summary.warning} monitor${summary.warning === 1 ? '' : 's'} checking`, className: 'warning' };
  if (summary.total === 0) return { text: 'No monitors configured', className: 'warning' };
  return { text: 'All active monitors healthy', className: 'good' };
}

async function renderPage() {
  const content = document.getElementById('page-content');
  if (!content) return;
  root.querySelectorAll('[data-page]').forEach((button) => button.classList.toggle('active', button.dataset.page === state.page));
  if (state.page === 'overview') await renderOverview(content);
  else if (state.page === 'monitors') await renderMonitors(content);
  else if (state.page === 'history') await renderHistory(content);
  else if (state.page === 'users') await renderUsers(content);
  else if (state.page === 'settings') await renderSettings(content);
  else await renderAbout(content);
  startLiveClock();
}

function renderAdapterList() {
  const adapterList = document.getElementById('adapter-list');
  if (!adapterList) return;
  const markup = !Array.isArray(state.adapters)
    ? '<div class="empty">Loading adapters…</div>'
    : state.adapters.length
      ? `<div class="adapter-list">${state.adapters.map((adapter) => `
        <div class="adapter">
          <div>
            <strong>${escapeHtml(adapter.description || (adapter.kind === 'wireless' ? 'Wi‑Fi' : adapter.kind === 'wired' ? 'Wired' : adapter.name))}</strong>
            <small>${escapeHtml(adapter.name)}${adapter.linkSpeed ? ` · ${escapeHtml(adapter.linkSpeed)}` : ''}</small>
          </div>
          ${badge(adapter.connected ? 'healthy' : 'down', adapter.connected ? 'connected' : 'disconnected')}
        </div>`).join('')}</div>`
      : '<div class="empty">No physical adapters found.</div>';
  if (adapterList._lastMarkup !== markup) {
    adapterList.innerHTML = markup;
    adapterList._lastMarkup = markup;
  }
}

function renderIncidentsList(activeIncidents) {
  const incidents = document.getElementById('incident-list');
  if (!incidents) return;
  const markup = activeIncidents.length ? activeIncidents.map((incident) => `
    <div class="incident"><div class="incident-meta">${badge(incident.severity === 'critical' ? 'down' : 'warning', incident.severity)}<time datetime="${escapeHtml(incident.startedAt)}">${escapeHtml(prettyTime(incident.startedAt))}</time></div><h4>${escapeHtml(incident.targetName)}</h4><span class="location-label">${escapeHtml(incident.locationName)}</span><p>${escapeHtml(incident.message)}</p>${isAdmin() && !incident.acknowledgedAt ? `<div><button class="button secondary small" data-ack="${incident.id}">Acknowledge</button></div>` : incident.acknowledgedAt ? `<span class="muted">Acknowledged ${escapeHtml(prettyTime(incident.acknowledgedAt))}</span>` : ''}</div>`).join('') : '<div class="empty">No active incidents. Monitoring is currently clear.</div>';
  if (incidents._lastMarkup !== markup) {
    incidents.innerHTML = markup;
    incidents._lastMarkup = markup;
    incidents.querySelectorAll('[data-ack]').forEach((button) => button.addEventListener('click', async () => {
      await request(() => remoteCare.acknowledgeIncident(state.session.token, Number(button.dataset.ack)));
      await refreshDashboard(true);
    }));
  }
}

function renderNotificationsList(notifications) {
  const notifyList = document.getElementById('notification-list');
  if (!notifyList) return;
  const markup = notifications.length ? notifications.slice(0, 6).map((item) => `<div class="notification-item"><strong>${escapeHtml(item.title)}</strong><span class="location-label">${escapeHtml(item.locationName)}</span><span>${escapeHtml(item.body)}</span><time datetime="${escapeHtml(item.deliveredAt)}">${escapeHtml(prettyTime(item.deliveredAt))}</time></div>`).join('') : '<div class="empty">Notifications will be stored here.</div>';
  if (notifyList._lastMarkup !== markup) {
    notifyList.innerHTML = markup;
    notifyList._lastMarkup = markup;
  }
}

async function renderOverview(content) {
  const { summary, activeIncidents, notifications } = state.dashboard;
  const overall = overallStatus();
  content.innerHTML = `
    <header class="page-header"><div><h2>Monitoring overview</h2><p>Local checks continue while this window is hidden in the tray.</p></div><div class="header-tools">${liveClockMarkup()}<div class="status-line"><span class="dot ${overall.className}" id="overall-dot"></span><span id="overall-text">${overall.text}</span></div></div></header>
    <section class="stat-grid">
      <article class="card stat"><div class="label">Active monitors</div><div class="number" id="stat-total">${summary.total}</div></article>
      <article class="card stat good"><div class="label">Healthy</div><div class="number" id="stat-healthy">${summary.healthy}</div></article>
      <article class="card stat warning"><div class="label">Checking</div><div class="number" id="stat-warning">${summary.warning}</div></article>
      <article class="card stat down"><div class="label">Unavailable</div><div class="number" id="stat-down">${summary.down}</div></article>
      <article class="card stat"><div class="label">Not checked yet</div><div class="number" id="stat-unknown">${summary.unknown}</div></article>
    </section>
    <section class="section-grid">
      <article class="card"><div class="panel-title"><h3>Active incidents</h3><span id="incident-count">${activeIncidents.length} open</span></div><div class="panel-body" id="incident-list"></div></article>
      <div class="section-stack">
        <article class="card"><div class="panel-title"><h3>Network adapters</h3><span>Local device</span></div><div class="panel-body" id="adapter-list"><div class="empty">Loading adapters…</div></div></article>
        <article class="card" style="margin-top:18px"><div class="panel-title"><h3>Recent notifications</h3><span>Local history</span></div><div class="panel-body" id="notification-list"></div></article>
      </div>
    </section>`;
  renderIncidentsList(activeIncidents);
  renderNotificationsList(notifications);
  renderAdapterList();
  void refreshNetworkAdapters();
}

function updateOverviewLive() {
  const { summary, activeIncidents, notifications } = state.dashboard;
  const overall = overallStatus();
  const elTotal = document.getElementById('stat-total');
  if (elTotal && elTotal.textContent !== String(summary.total)) elTotal.textContent = summary.total;
  const elHealthy = document.getElementById('stat-healthy');
  if (elHealthy && elHealthy.textContent !== String(summary.healthy)) elHealthy.textContent = summary.healthy;
  const elWarning = document.getElementById('stat-warning');
  if (elWarning && elWarning.textContent !== String(summary.warning)) elWarning.textContent = summary.warning;
  const elDown = document.getElementById('stat-down');
  if (elDown && elDown.textContent !== String(summary.down)) elDown.textContent = summary.down;
  const elUnknown = document.getElementById('stat-unknown');
  if (elUnknown && elUnknown.textContent !== String(summary.unknown)) elUnknown.textContent = summary.unknown;

  const dot = document.getElementById('overall-dot');
  const expectedDotClass = `dot ${overall.className}`.trim();
  if (dot && dot.className !== expectedDotClass) dot.className = expectedDotClass;
  const text = document.getElementById('overall-text');
  if (text && text.textContent !== overall.text) text.textContent = overall.text;

  const incidentCount = document.getElementById('incident-count');
  if (incidentCount) incidentCount.textContent = `${activeIncidents.length} open`;

  renderIncidentsList(activeIncidents);
  renderNotificationsList(notifications);
  renderAdapterList();
}

function monitorRowMarkup(target) {
  return `
    <tr data-target-id="${target.id}">
      <td class="target-name-cell"><div class="target-name">${escapeHtml(target.name)}<small>${escapeHtml(targetDestination(target))}${target.enabled ? '' : ' · disabled'}</small></div></td>
      <td class="target-location-cell">${escapeHtml(target.locationName)}</td>
      <td class="target-type-cell">${escapeHtml(prettyType(target.type))}</td>
      <td class="target-status-cell">${target.enabled ? badge(target.status) : badge('unknown', 'disabled')}</td>
      <td class="target-time-cell"><time class="timestamp" datetime="${escapeHtml(target.lastCheckedAt || '')}">${escapeHtml(prettyTime(target.lastCheckedAt))}</time></td>
      <td class="target-latency-cell">${target.lastLatencyMs === null || target.lastLatencyMs === undefined ? '—' : `${target.lastLatencyMs} ms`}</td>
      ${isAdmin() ? `<td><div class="actions" style="margin:0"><button class="button secondary small" data-run="${target.id}">Run</button><button class="button ghost small" data-edit="${target.id}">Edit</button><button class="button danger small" data-delete="${target.id}">Delete</button></div></td>` : ''}
    </tr>`;
}

function renderMonitors(content) {
  const targets = state.dashboard.targets;
  content.innerHTML = `
    <header class="page-header"><div><h2>Monitors</h2><p>Configure local connectivity, server, and service checks.</p></div><div class="header-tools">${liveClockMarkup()}${isAdmin() ? '<button class="button" id="add-monitor">+ Add monitor</button>' : '<div class="status-line">Viewer access · configuration locked</div>'}</div></header>
    <article class="card"><div class="table-wrap"><table><thead><tr><th>Monitor</th><th>Location</th><th>Type</th><th>Status</th><th>Last check</th><th>Latency</th>${isAdmin() ? '<th>Actions</th>' : ''}</tr></thead><tbody id="monitor-table">${targets.length ? targets.map(monitorRowMarkup).join('') : `<tr><td colspan="${isAdmin() ? 7 : 6}" class="empty">No monitors configured.</td></tr>`}</tbody></table></div></article>`;
  if (!isAdmin()) return;
  document.getElementById('add-monitor')?.addEventListener('click', () => openMonitorDialog());
  attachMonitorTableListeners(document.getElementById('monitor-table'));
}

function attachMonitorTableListeners(body) {
  if (!body) return;
  const targets = state.dashboard.targets;
  body.querySelectorAll('[data-run]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const outcome = await request(() => remoteCare.runTarget(state.session.token, Number(button.dataset.run)));
      await refreshDashboard(true);
      if (!outcome?.transition) {
        const target = state.dashboard.targets.find((item) => item.id === Number(button.dataset.run));
        if (outcome?.result?.ok) {
          flash(outcome.result.message || `${target?.name || 'Monitor'} is healthy.`, 'recovered', {
            title: `Check passed: ${target?.name || 'Monitor'}`,
            subtitle: `${target?.locationName || 'Local device'} · ${outcome.result.latencyMs !== null && outcome.result.latencyMs !== undefined ? `${outcome.result.latencyMs} ms · ` : ''}Manual check`
          });
        } else {
          flash(outcome?.result?.message || `${target?.name || 'Monitor'} check failed.`, 'down', {
            title: `Check failed: ${target?.name || 'Monitor'}`,
            subtitle: `${target?.locationName || 'Local device'} · ${outcome?.status || 'warning'} · Manual check`
          });
        }
      }
    } catch (error) {
      flash(error.message, 'down', { title: 'Execution failed' });
    } finally {
      button.disabled = false;
    }
  }));
  body.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => openMonitorDialog(targets.find((target) => target.id === Number(button.dataset.edit)))));
  body.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', async () => {
    const target = targets.find((item) => item.id === Number(button.dataset.delete));
    if (!window.confirm(`Delete monitor “${target.name}”? Its local history will also be removed.`)) return;
    try { await request(() => remoteCare.deleteTarget(state.session.token, target.id)); await refreshDashboard(true); } catch (error) { flash(error.message, 'down'); }
  }));
}

function updateMonitorsLive() {
  const body = document.getElementById('monitor-table');
  if (!body) return;
  const targets = state.dashboard.targets;
  if (!targets.length) {
    body.innerHTML = `<tr><td colspan="${isAdmin() ? 7 : 6}" class="empty">No monitors configured.</td></tr>`;
    return;
  }
  const currentRows = Array.from(body.querySelectorAll('tr[data-target-id]'));
  const currentIds = currentRows.map((r) => Number(r.dataset.targetId));
  const newIds = targets.map((t) => t.id);
  const idsMatch = currentIds.length === newIds.length && currentIds.every((id, i) => id === newIds[i]);
  if (!idsMatch) {
    body.innerHTML = targets.map(monitorRowMarkup).join('');
    attachMonitorTableListeners(body);
    return;
  }
  for (const target of targets) {
    const row = body.querySelector(`tr[data-target-id="${target.id}"]`);
    if (!row) continue;
    const nameCell = row.querySelector('.target-name-cell');
    const newNameMarkup = `<div class="target-name">${escapeHtml(target.name)}<small>${escapeHtml(targetDestination(target))}${target.enabled ? '' : ' · disabled'}</small></div>`;
    if (nameCell && nameCell.innerHTML !== newNameMarkup) nameCell.innerHTML = newNameMarkup;

    const locationCell = row.querySelector('.target-location-cell');
    const newLocation = escapeHtml(target.locationName);
    if (locationCell && locationCell.innerHTML !== newLocation) locationCell.innerHTML = newLocation;

    const typeCell = row.querySelector('.target-type-cell');
    const newType = escapeHtml(prettyType(target.type));
    if (typeCell && typeCell.textContent !== newType) typeCell.textContent = newType;

    const statusCell = row.querySelector('.target-status-cell');
    const newStatus = target.enabled ? badge(target.status) : badge('unknown', 'disabled');
    if (statusCell && statusCell.innerHTML !== newStatus) statusCell.innerHTML = newStatus;

    const timeCell = row.querySelector('.target-time-cell');
    const timeVal = escapeHtml(prettyTime(target.lastCheckedAt));
    const dtVal = escapeHtml(target.lastCheckedAt || '');
    const newTime = `<time class="timestamp" datetime="${dtVal}">${timeVal}</time>`;
    if (timeCell && timeCell.innerHTML !== newTime) timeCell.innerHTML = newTime;

    const latencyCell = row.querySelector('.target-latency-cell');
    const newLatency = target.lastLatencyMs === null || target.lastLatencyMs === undefined ? '—' : `${target.lastLatencyMs} ms`;
    if (latencyCell && latencyCell.textContent !== newLatency) latencyCell.textContent = newLatency;
  }
}

function updateDashboardLive() {
  if (state.page === 'overview') {
    if (document.getElementById('stat-total')) updateOverviewLive();
    else renderPage();
  } else if (state.page === 'monitors') {
    if (document.getElementById('monitor-table')) updateMonitorsLive();
    else renderPage();
  } else if (state.page === 'history') {
    const form = document.getElementById('history-filters');
    if (form && !form.contains(document.activeElement)) {
      loadHistory(historyFilterValues(form)).catch(() => {});
    }
  }
}

function historyFilterValues(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  return {
    from: values.from ? new Date(values.from).toISOString() : '',
    to: values.to ? new Date(values.to).toISOString() : '',
    targetId: values.targetId || '',
    type: values.type || '',
    status: values.status || '',
    outcome: values.outcome || 'all',
    search: values.search || '',
    location: values.location || '',
    limit: 200
  };
}

function renderHistoryRows(history) {
  const container = document.getElementById('history-results');
  const summary = document.getElementById('history-summary');
  if (!container || !summary) return;
  const results = history.results;
  summary.textContent = results.length === history.filters.limit
    ? `Showing the newest ${results.length} recorded changes. Refine the filters to narrow the result set.`
    : `${results.length} recorded change${results.length === 1 ? '' : 's'} found.`;
  container.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Date & time</th><th>Location</th><th>Monitor</th><th>Type</th><th>Result</th><th>Message</th><th>Latency</th></tr></thead><tbody>${results.length ? results.map((result) => `<tr><td><time class="timestamp" datetime="${escapeHtml(result.checkedAt)}">${escapeHtml(prettyTime(result.checkedAt))}</time></td><td>${escapeHtml(result.locationName)}</td><td>${escapeHtml(result.targetName)}</td><td>${escapeHtml(prettyType(result.targetType))}</td><td>${badge(result.status, result.ok ? 'success' : result.status)}</td><td class="muted">${escapeHtml(result.message)}</td><td>${result.latencyMs === null || result.latencyMs === undefined ? '—' : `${result.latencyMs} ms`}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">No checks match these filters.</td></tr>'}</tbody></table></div>`;
}

async function loadHistory(filters) {
  const history = await request(() => remoteCare.getCheckHistory(state.session.token, filters));
  state.historyFilters = history.filters;
  renderHistoryRows(history);
  return history;
}

async function renderHistory(content) {
  const filters = state.historyFilters;
  const targetOptions = state.dashboard.targets.map((target) => `<option value="${target.id}" ${Number(filters.targetId) === target.id ? 'selected' : ''}>${escapeHtml(target.name)} — ${escapeHtml(target.locationName)}</option>`).join('');
  const selected = (name, value) => filters[name] === value ? 'selected' : '';
  content.innerHTML = `
    <header class="page-header"><div><h2>Check history</h2><p>Only the first and changed monitor results are stored locally, with precise timestamps. Results are retained for 30 days.</p></div><div class="header-tools">${liveClockMarkup()}<label class="report-month"><span>Monthly report</span><input id="report-month" type="month" value="${currentMonthValue()}" max="${currentMonthValue()}" /></label><button class="button" id="export-history-report">Export CSV</button><button class="button secondary" id="refresh-history">Refresh</button></div></header>
    <article class="card history-filter-card"><div class="panel-title"><h3>Search and filters</h3><span>All dates and times are local to this device</span></div><form class="history-filters" id="history-filters">
      <div class="field"><label for="history-from">From date &amp; time</label><input id="history-from" name="from" type="datetime-local" step="1" value="${escapeHtml(toDateTimeLocal(filters.from))}" /></div>
      <div class="field"><label for="history-to">To date &amp; time</label><input id="history-to" name="to" type="datetime-local" step="1" value="${escapeHtml(toDateTimeLocal(filters.to))}" /></div>
      <div class="field"><label for="history-monitor">Monitor</label><select id="history-monitor" name="targetId"><option value="">All monitors</option>${targetOptions}</select></div>
      <div class="field"><label for="history-type">Monitor type</label><select id="history-type" name="type"><option value="">All types</option><option value="internet" ${selected('type', 'internet')}>Internet</option><option value="interface" ${selected('type', 'interface')}>Network interface</option><option value="gateway" ${selected('type', 'gateway')}>Default gateway</option><option value="ping" ${selected('type', 'ping')}>ICMP ping</option><option value="tcp" ${selected('type', 'tcp')}>TCP port</option><option value="http" ${selected('type', 'http')}>HTTP/HTTPS</option><option value="system_service" ${selected('type', 'system_service')}>Local service</option><option value="process" ${selected('type', 'process')}>Local process</option></select></div>
      <div class="field"><label for="history-outcome">Outcome</label><select id="history-outcome" name="outcome"><option value="all" ${selected('outcome', 'all')}>All outcomes</option><option value="success" ${selected('outcome', 'success')}>Successful checks</option><option value="failure" ${selected('outcome', 'failure')}>Failed checks</option></select></div>
      <div class="field"><label for="history-status">Recorded status</label><select id="history-status" name="status"><option value="">All statuses</option><option value="healthy" ${selected('status', 'healthy')}>Healthy</option><option value="warning" ${selected('status', 'warning')}>Warning</option><option value="down" ${selected('status', 'down')}>Down</option><option value="unknown" ${selected('status', 'unknown')}>Unknown</option></select></div>
      <div class="field"><label for="history-location">Location</label><input id="history-location" name="location" maxlength="100" value="${escapeHtml(filters.location || '')}" placeholder="e.g. Bengaluru office" /></div>
      <div class="field history-search"><label for="history-search">Location, monitor, or message</label><input id="history-search" name="search" maxlength="120" value="${escapeHtml(filters.search || '')}" placeholder="Search text" /></div>
      <div class="history-filter-actions"><button class="button" type="submit">Apply filters</button><button class="button ghost" type="button" id="clear-history-filters">Clear</button></div>
      <div class="error history-filter-error" id="history-filter-error"></div>
    </form></article>
    <article class="card history-result-card"><div class="panel-title"><h3>Recorded checks</h3><span id="history-summary">Loading history…</span></div><div id="history-results"><div class="empty">Loading history…</div></div></article>`;

  const form = document.getElementById('history-filters');
  const error = document.getElementById('history-filter-error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    try {
      const history = await loadHistory(historyFilterValues(form));
      form.elements.from.value = toDateTimeLocal(history.filters.from);
      form.elements.to.value = toDateTimeLocal(history.filters.to);
    } catch (exception) {
      error.textContent = exception.message || 'Unable to load the selected history.';
    }
  });
  document.getElementById('clear-history-filters').addEventListener('click', async () => {
    state.historyFilters = {};
    await renderPage();
  });
  document.getElementById('refresh-history').addEventListener('click', async () => {
    error.textContent = '';
    try { await loadHistory(historyFilterValues(form)); } catch (exception) { error.textContent = exception.message || 'Unable to refresh history.'; }
  });
  document.getElementById('export-history-report').addEventListener('click', async () => {
    const button = document.getElementById('export-history-report');
    const month = document.getElementById('report-month').value;
    error.textContent = '';
    button.disabled = true;
    try {
      const result = await request(() => remoteCare.exportMonthlyReport(state.session.token, month));
      if (!result.cancelled) flash(`Monthly report exported with ${result.rowCount} recorded change${result.rowCount === 1 ? '' : 's'}.`, 'info');
    } catch (exception) {
      error.textContent = exception.message || 'Unable to export the monthly report.';
    } finally {
      button.disabled = false;
    }
  });
  try {
    await loadHistory(filters);
  } catch (exception) {
    error.textContent = exception.message || 'Unable to load the selected history.';
    renderHistoryRows({ filters: { limit: 200 }, results: [] });
  }
}

async function renderUsers(content) {
  if (!isAdmin()) {
    content.innerHTML = `<header class="page-header"><div><h2>Local users</h2><p>Viewer accounts can see monitoring status and history but cannot make changes.</p></div>${liveClockMarkup()}</header><article class="card"><div class="panel-body"><div class="empty">You are signed in as a Viewer. User management is available only to the Super Admin.</div></div></article>`;
    return;
  }
  content.innerHTML = `<header class="page-header"><div><h2>Local users</h2><p>One Super Admin and a maximum of five Viewer accounts are stored only on this PC.</p></div><div class="header-tools">${liveClockMarkup()}<button class="button" id="add-viewer">+ Add Viewer</button></div></header><article class="card"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Last sign-in</th><th>Status</th><th>Actions</th></tr></thead><tbody id="user-table"><tr><td colspan="6" class="empty">Loading users…</td></tr></tbody></table></div></article>`;
  try {
    state.users = await request(() => remoteCare.listUsers(state.session.token));
    const body = document.getElementById('user-table');
    body.innerHTML = state.users.map((user) => `<tr>
      <td>${escapeHtml(user.displayName)}</td>
      <td>${escapeHtml(user.username)}</td>
      <td>${escapeHtml(user.role === 'super_admin' ? 'Super Admin' : 'Viewer')}</td>
      <td>${escapeHtml(user.lastLoginAt ? prettyTime(user.lastLoginAt) : 'Never')}</td>
      <td>${badge(user.active ? 'healthy' : 'down', user.active ? 'active' : 'disabled')}</td>
      <td>${user.role === 'viewer' ? `<div class="actions" style="margin:0"><button class="button ghost small" data-edit-viewer="${user.id}">Edit</button><button class="button ghost small" data-password="${user.id}">Password</button><button class="button ${user.active ? 'danger' : 'secondary'} small" data-toggle="${user.id}" data-active="${user.active}">${user.active ? 'Disable' : 'Enable'}</button></div>` : `<div class="actions" style="margin:0"><button class="button ghost small" id="edit-admin-profile">Profile</button></div>`}</td>
    </tr>`).join('');
    document.getElementById('add-viewer').addEventListener('click', openViewerDialog);
    document.getElementById('edit-admin-profile')?.addEventListener('click', openProfileDialog);
    body.querySelectorAll('[data-edit-viewer]').forEach((button) => button.addEventListener('click', () => {
      const viewer = state.users.find((u) => u.id === Number(button.dataset.editViewer));
      if (viewer) openEditUserDialog(viewer);
    }));
    body.querySelectorAll('[data-toggle]').forEach((button) => button.addEventListener('click', async () => {
      const active = button.dataset.active !== 'true';
      try { await request(() => remoteCare.setViewerActive(state.session.token, Number(button.dataset.toggle), active)); await renderUsers(content); } catch (error) { flash(error.message, 'down'); }
    }));
    body.querySelectorAll('[data-password]').forEach((button) => button.addEventListener('click', () => openResetPasswordDialog(Number(button.dataset.password))));
  } catch (error) { document.getElementById('user-table').innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(error.message)}</td></tr>`; }
}

async function renderSettings(content) {
  if (!isAdmin()) {
    state.page = 'overview';
    return renderOverview(content);
  }
  state.settings = await request(() => remoteCare.getAppSettings(state.session.token));
  const settings = state.settings;
  const checked = (name) => settings[name] ? 'checked' : '';
  content.innerHTML = `
    <header class="page-header"><div><h2>Settings</h2><p>Choose how the monitor behaves in the background and which alerts appear on this device.</p></div>${liveClockMarkup()}</header>
    <form id="settings-form" class="settings-form">
      <article class="card"><div class="panel-title"><h3>Background behavior</h3><span>System tray</span></div><div class="panel-body settings-list">
        <label class="setting-row"><span><strong>Always run from the system tray</strong><small>Minimizing or closing the dashboard always keeps monitoring active in the background. Quitting requires the Super Admin password.</small></span><input name="minimizeToTray" type="checkbox" checked disabled aria-label="Always enabled" /></label>
        <label class="setting-row"><span><strong>Show tray reminder toast</strong><small>Show the “still running” reminder when the dashboard is hidden in the tray.</small></span><input name="showTrayReminder" type="checkbox" ${checked('showTrayReminder')} /></label>
      </div></article>
      <article class="card"><div class="panel-title"><h3>Alert notifications</h3><span>Desktop and in-app</span></div><div class="panel-body settings-list">
        <label class="setting-row"><span><strong>Failure and warning alerts</strong><small>Show a desktop popup whenever a monitor changes to warning or down, including while the dashboard is hidden.</small></span><input name="showFailureNotifications" type="checkbox" ${checked('showFailureNotifications')} /></label>
        <label class="setting-row"><span><strong>Healthy and recovery alerts</strong><small>Show a desktop popup whenever a monitor becomes healthy, including its first successful check.</small></span><input name="showRecoveryNotifications" type="checkbox" ${checked('showRecoveryNotifications')} /></label>
        <label class="setting-row"><span><strong>Notification duration (seconds)</strong><small>Automatically close each new notification after this time. Default: 5 seconds; allowed: 1–300 seconds. Applies to desktop popups, tray reminders, and in-app toasts.</small></span><input name="notificationDurationSeconds" type="number" min="1" max="300" step="1" required value="${settings.notificationDurationSeconds}" /></label>
        <div class="setting-row notification-test"><span><strong>Test desktop alert</strong><small>Show a test popup now. This bypasses the two alert toggles so you can verify system permissions and placement.</small></span><button class="button secondary small" id="test-notification" type="button">Show test alert</button></div>
      </div></article>
      <article class="card"><div class="panel-title"><h3>Protected exit</h3><span>Super Admin only</span></div><div class="panel-body protected-exit"><div><strong>Quit Remote Care Monitor</strong><p class="helper">To stop local monitoring, confirm the current Super Admin password. Closing this dashboard only sends it back to the system tray.</p></div><button class="button danger" type="button" id="request-quit">Quit app…</button></div></article>
      <div class="actions"><button class="button" type="submit">Save settings</button><span class="helper settings-help">Alert history remains available on the overview even when a display notification is turned off.</span></div>
      <div class="error" id="settings-error"></div>
    </form>`;
  const form = document.getElementById('settings-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('settings-error');
    error.textContent = '';
    const next = Object.fromEntries(Object.keys(settings).map((name) => [name,
      name === 'notificationDurationSeconds' ? form.elements[name].valueAsNumber : form.elements[name].checked
    ]));
    try {
      state.settings = await request(() => remoteCare.saveAppSettings(state.session.token, next));
      flash('Settings saved.');
    } catch (exception) {
      error.textContent = exception.message || 'Unable to save settings.';
    }
  });
  document.getElementById('test-notification').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const error = document.getElementById('settings-error');
    error.textContent = '';
    button.disabled = true;
    try {
      await request(() => remoteCare.testNotification(state.session.token));
      flash('Test alert requested. Check the top-right of the active display.', 'info', { silent: true });
    } catch (exception) {
      error.textContent = exception.message || 'Unable to show the test alert.';
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('request-quit').addEventListener('click', () => openQuitDialog('settings'));
}

async function renderAbout(content) {
  if (!state.appInfo) state.appInfo = await request(() => remoteCare.getAppInfo(state.session.token));
  const runtime = state.appInfo.runtime || {};
  const previousShutdown = runtime.lastUnexpectedShutdownAt
    ? `Unexpected shutdown recorded ${prettyTime(runtime.lastUnexpectedShutdownAt)}`
    : 'No unexpected shutdown has been recorded';
  content.innerHTML = `<header class="page-header"><div><h2>About this device</h2><p>Phase 1 works completely locally. Cloud publishing is deliberately disabled.</p></div>${liveClockMarkup()}</header><article class="card"><div class="panel-body"><div class="info-grid"><div class="info-item"><span>Application version</span><strong>${escapeHtml(state.appInfo.version)}</strong></div><div class="info-item"><span>Platform</span><strong>${escapeHtml(state.appInfo.platform)} / ${escapeHtml(state.appInfo.arch)}</strong></div><div class="info-item"><span>Data location</span><strong>${escapeHtml(state.appInfo.dataPath)}</strong></div><div class="info-item"><span>Cloud sync</span><strong>${escapeHtml(state.appInfo.cloudSync)}</strong></div><div class="info-item"><span>Runtime integrity</span><strong>${escapeHtml(previousShutdown)}</strong></div><div class="info-item"><span>Current session started</span><strong>${escapeHtml(prettyTime(runtime.startedAt))}</strong></div></div><p class="helper" style="margin:20px 0 0">The durable local event queue is ready for a Phase 2 HTTPS or MQTT sender. It currently sends no data outside this computer.</p></div></article>`;
}

function monitorFields(type) {
  const visibility = {
    host: ['ping', 'tcp'].includes(type), port: type === 'tcp', url: ['http', 'internet'].includes(type),
    interface: type === 'interface', service: type === 'system_service', process: type === 'process', dns: type === 'internet'
  };
  document.querySelectorAll('[data-monitor-field]').forEach((element) => element.classList.toggle('hidden', !visibility[element.dataset.monitorField]));
}

function interfaceOptions(current = 'auto') {
  const options = [
    { value: 'auto', label: 'Automatic (any connected network)' },
    { value: 'wireless', label: 'Wi-Fi / Wireless (alert if disconnected)' },
    { value: 'wired', label: 'Wired Ethernet (alert if disconnected)' }
  ];
  const known = new Set(options.map((o) => o.value));
  for (const adapter of state.adapters || []) {
    if (!known.has(adapter.name)) {
      known.add(adapter.name);
      const desc = adapter.description && adapter.description !== adapter.name ? ` (${adapter.description})` : '';
      const kind = adapter.kind ? ` [${adapter.kind === 'wireless' ? 'Wi‑Fi' : adapter.kind}]` : '';
      const status = adapter.connected ? 'connected' : 'disconnected';
      options.push({
        value: adapter.name,
        label: `${adapter.name}${desc}${kind} — ${status}`
      });
    }
  }
  if (current && !known.has(current)) {
    options.push({ value: current, label: `Custom interface: ${current}` });
  }
  return options.map((opt) => `<option value="${escapeHtml(opt.value)}" ${opt.value === current ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`).join('');
}

function openMonitorDialog(target = null) {
  const value = (key, fallback = '') => escapeHtml(target?.[key] ?? fallback);
  const checked = target?.enabled === false ? '' : 'checked';
  const metadata = target?.metadata || {};
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `
    <div class="dialog-header"><h3>${target ? 'Edit monitor' : 'Add monitor'}</h3><button class="button ghost small" type="button" data-close>Close</button></div>
    <form id="monitor-form"><div class="dialog-body">
      <div class="two-col"><div class="field"><label>Name</label><input name="name" required maxlength="80" value="${value('name')}" placeholder="Production API" /></div><div class="field"><label>Location name</label><input name="locationName" required minlength="2" maxlength="100" value="${value('locationName', 'Local device')}" placeholder="e.g. Bengaluru office" /></div></div>
      <div class="field"><label>Check type</label><select name="type"><option value="internet">Internet connection</option><option value="interface">Network interface</option><option value="gateway">Default gateway</option><option value="ping">ICMP ping</option><option value="tcp">TCP port</option><option value="http">HTTP/HTTPS endpoint</option><option value="system_service">Local system service</option><option value="process">Local process</option></select></div>
      <div class="field" data-monitor-field="host"><label>Host or IP address</label><input name="host" value="${value('host')}" placeholder="192.168.1.20 or api.example.com" /></div>
      <div class="field" data-monitor-field="port"><label>TCP port</label><input name="port" type="number" min="1" max="65535" value="${value('port')}" placeholder="1883" /></div>
      <div class="field" data-monitor-field="url"><label>HTTP/HTTPS URL</label><input name="url" type="url" value="${value('url')}" placeholder="https://api.example.com/health" /></div>
      <div class="field" data-monitor-field="dns"><label>DNS hostname to resolve</label><input name="dnsHost" value="${escapeHtml(metadata.dnsHost || '')}" placeholder="cloudflare.com" /><span class="helper">Used before the Internet HTTPS check to distinguish DNS failure.</span></div>
      <div class="field" data-monitor-field="interface"><label>Network interface to monitor</label><select name="interfaceName">${interfaceOptions(target?.interfaceName || 'auto')}</select><span class="helper">Select “Wi-Fi / Wireless” or a specific adapter (e.g. en0) to alert immediately when Wi-Fi is disconnected.</span></div>
      <div class="field" data-monitor-field="service"><label>Service name</label><input name="serviceName" value="${value('serviceName')}" placeholder="mosquitto.service or Mosquitto" /><span class="helper">Linux/Raspberry Pi uses systemd; Windows uses the Windows Service name; macOS uses a launchd label.</span></div>
      <div class="field" data-monitor-field="process"><label>Process name</label><input name="processName" value="${value('processName')}" placeholder="node or python3" /></div>
      <div class="two-col"><div class="field"><label>Check every (seconds)</label><input name="intervalSeconds" type="number" min="2" max="86400" value="${value('intervalSeconds', '15')}" required /></div><div class="field"><label>Timeout (milliseconds)</label><input name="timeoutMs" type="number" min="500" max="120000" value="${value('timeoutMs', '3000')}" required /></div></div>
      <div class="two-col"><div class="field"><label>Failures before alert</label><input name="failureThreshold" type="number" min="1" max="10" value="${value('failureThreshold', '2')}" required /></div><div class="field"><label>Successes before recovery</label><input name="recoveryThreshold" type="number" min="1" max="10" value="${value('recoveryThreshold', '1')}" required /></div></div>
      <div class="field"><label>Severity</label><select name="severity"><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Information</option></select></div>
      <div class="field"><label>Failure notification</label><textarea name="downMessage" required>${value('downMessage')}</textarea></div>
      <div class="field"><label>Recovery notification</label><textarea name="recoveryMessage" required>${value('recoveryMessage')}</textarea></div>
      <label class="check-label"><input name="enabled" type="checkbox" ${checked} /> Enable this monitor</label><div class="error" id="monitor-error"></div>
    </div><div class="dialog-footer"><button class="button secondary" type="button" data-close>Cancel</button><button class="button" type="submit">${target ? 'Save changes' : 'Create monitor'}</button></div></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const typeSelect = form.elements.type;
  typeSelect.value = target?.type || 'ping';
  form.elements.severity.value = target?.severity || 'warning';
  monitorFields(typeSelect.value);
  typeSelect.addEventListener('change', () => monitorFields(typeSelect.value));
  dialog.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => dialog.remove());

  if (!Array.isArray(state.adapters)) {
    remoteCare.getNetworkAdapters(state.session.token).then((adapters) => {
      state.adapters = adapters;
      const select = dialog.querySelector('select[name="interfaceName"]');
      if (select) select.innerHTML = interfaceOptions(target?.interfaceName || select.value || 'auto');
    }).catch(() => {});
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = dialog.querySelector('#monitor-error');
    error.textContent = '';
    const values = Object.fromEntries(new FormData(form).entries());
    const payload = { ...values, id: target?.id, enabled: form.elements.enabled.checked, metadata: { dnsHost: values.dnsHost } };
    try { await request(() => remoteCare.saveTarget(state.session.token, payload)); dialog.close(); await refreshDashboard(true); flash(`Monitor “${values.name}” saved.`); } catch (exception) { error.textContent = exception.message; }
  });
  dialog.showModal();
}

function openViewerDialog() {
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<div class="dialog-header"><h3>Add Viewer account</h3><button class="button ghost small" data-close>Close</button></div><form><div class="dialog-body"><p class="helper">Viewer accounts can view the dashboard and history only. A maximum of five Viewer accounts is allowed.</p><div class="field"><label>Display name</label><input name="displayName" required maxlength="80" /></div><div class="field"><label>Username</label><input name="username" required minlength="3" maxlength="40" /></div><div class="field"><label>Password</label><input name="password" required type="password" minlength="10" /></div><div class="error"></div></div><div class="dialog-footer"><button class="button secondary" type="button" data-close>Cancel</button><button class="button" type="submit">Create Viewer</button></div></form>`;
  document.body.append(dialog); dialog.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => dialog.close())); dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const error = form.querySelector('.error'); try { await request(() => remoteCare.createViewer(state.session.token, Object.fromEntries(new FormData(form).entries()))); dialog.close(); await renderPage(); flash('Viewer account created.'); } catch (exception) { error.textContent = exception.message; } });
  dialog.showModal();
}

function openEditUserDialog(user) {
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `
    <div class="dialog-header"><h3>Edit Viewer account</h3><button class="button ghost small" type="button" data-close>Close</button></div>
    <form><div class="dialog-body">
      <div class="field"><label for="edit-viewer-name">Display name</label><input id="edit-viewer-name" name="displayName" required maxlength="80" value="${escapeHtml(user.displayName)}" /></div>
      <div class="field"><label for="edit-viewer-user">Username</label><input id="edit-viewer-user" name="username" required minlength="3" maxlength="40" value="${escapeHtml(user.username)}" /></div>
      <label class="check-label" style="margin-top:12px"><input name="active" type="checkbox" ${user.active ? 'checked' : ''} /> Account active</label>
      <div class="error" id="edit-viewer-error"></div>
    </div><div class="dialog-footer"><button class="button secondary" type="button" data-close>Cancel</button><button class="button" type="submit">Save changes</button></div></form>`;
  document.body.append(dialog);
  dialog.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector('#edit-viewer-error');
    error.textContent = '';
    const values = Object.fromEntries(new FormData(form).entries());
    values.active = Boolean(form.elements.active.checked);
    try {
      await request(() => remoteCare.updateViewer(state.session.token, user.id, values));
      dialog.close();
      const content = document.getElementById('page-content');
      if (content) await renderUsers(content);
      flash(`Viewer “${values.displayName}” updated.`);
    } catch (exception) {
      error.textContent = exception.message || 'Unable to update viewer.';
    }
  });
  dialog.showModal();
}

function openProfileDialog() {
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `
    <div class="dialog-header"><h3>Account settings</h3><button class="button ghost small" type="button" data-close>Close</button></div>
    <div class="dialog-body">
      <section class="dialog-section">
        <h4 class="dialog-section-title">User profile</h4>
        <form id="profile-form">
          <div class="field"><label for="profile-display-name">Display name</label><input id="profile-display-name" name="displayName" required maxlength="80" value="${escapeHtml(state.session.displayName)}" /></div>
          <div class="field"><label for="profile-username">Username</label><input id="profile-username" name="username" required minlength="3" maxlength="40" value="${escapeHtml(state.session.username || '')}" /></div>
          <button class="button secondary" type="submit">Update profile</button>
          <div class="error" id="profile-error"></div>
        </form>
      </section>
      <section class="dialog-section">
        <h4 class="dialog-section-title">Change password</h4>
        <form id="password-form">
          <div class="field"><label for="current-pwd">Current password</label><input id="current-pwd" name="currentPassword" type="password" required autocomplete="current-password" /></div>
          <div class="field"><label for="new-pwd">New password</label><input id="new-pwd" name="newPassword" type="password" required minlength="10" autocomplete="new-password" placeholder="At least 10 characters" /></div>
          <div class="field"><label for="confirm-pwd">Confirm new password</label><input id="confirm-pwd" name="confirmPassword" type="password" required minlength="10" autocomplete="new-password" /></div>
          <button class="button secondary" type="submit">Change password</button>
          <div class="error" id="password-error"></div>
        </form>
      </section>
    </div>
    <div class="dialog-footer">
      <button class="button" type="button" data-close>Done</button>
    </div>`;

  document.body.append(dialog);
  dialog.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => dialog.remove());

  const profileForm = dialog.querySelector('#profile-form');
  const profileError = dialog.querySelector('#profile-error');
  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    profileError.textContent = '';
    const values = Object.fromEntries(new FormData(profileForm).entries());
    try {
      const updated = await request(() => remoteCare.updateProfile(state.session.token, values));
      state.session.displayName = updated.displayName;
      state.session.username = updated.username;
      sessionStorage.setItem('remote-care-session', JSON.stringify(state.session));
      renderShell();
      await renderPage();
      flash('Profile details updated.');
    } catch (err) {
      profileError.textContent = err.message || 'Unable to update profile.';
    }
  });

  const pwdForm = dialog.querySelector('#password-form');
  const pwdError = dialog.querySelector('#password-error');
  pwdForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    pwdError.textContent = '';
    const values = Object.fromEntries(new FormData(pwdForm).entries());
    if (values.newPassword !== values.confirmPassword) {
      pwdError.textContent = 'New passwords do not match.';
      return;
    }
    if (values.newPassword.length < 10) {
      pwdError.textContent = 'New password must be at least 10 characters.';
      return;
    }
    try {
      await request(() => remoteCare.changePassword(state.session.token, values.currentPassword, values.newPassword));
      pwdForm.reset();
      flash('Password changed successfully.');
    } catch (err) {
      pwdError.textContent = err.message || 'Unable to change password.';
    }
  });

  dialog.showModal();
}

function openResetPasswordDialog(userId) {
  const user = state.users.find((item) => item.id === userId);
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<div class="dialog-header"><h3>Reset Viewer password</h3><button class="button ghost small" data-close>Close</button></div><form><div class="dialog-body"><p class="helper">Set a new password for ${escapeHtml(user?.displayName || 'this Viewer')}. The account will be signed out of any active local session.</p><div class="field"><label>New password</label><input name="password" type="password" required minlength="10" /></div><div class="error"></div></div><div class="dialog-footer"><button class="button secondary" type="button" data-close>Cancel</button><button class="button" type="submit">Reset password</button></div></form>`;
  document.body.append(dialog); dialog.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => dialog.close())); dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const error = form.querySelector('.error'); try { await request(() => remoteCare.resetViewerPassword(state.session.token, userId, form.elements.password.value)); dialog.close(); flash('Viewer password reset.'); } catch (exception) { error.textContent = exception.message; } });
  dialog.showModal();
}

function openQuitDialog(source = 'settings') {
  if (!isAdmin()) {
    flash('Sign in as a Super Admin to enter the password required to quit.', 'info');
    return;
  }
  if (document.querySelector('dialog[data-protected-quit]')) return;
  const dialog = document.createElement('dialog');
  dialog.dataset.protectedQuit = 'true';
  dialog.innerHTML = `<div class="dialog-header"><h3>Quit Remote Care Monitor?</h3><button class="button ghost small" type="button" data-close>Keep running</button></div><form><div class="dialog-body"><div class="quit-warning"><span aria-hidden="true">!</span><div><strong>Monitoring will stop on this device.</strong><p>Closing the app normally only hides it in the system tray. Enter the current Super Admin password to quit.</p></div></div><div class="field"><label for="quit-password">Super Admin password</label><input id="quit-password" name="password" type="password" required autocomplete="current-password" autofocus /></div><div class="error"></div></div><div class="dialog-footer"><button class="button secondary" type="button" data-close>Cancel</button><button class="button danger" type="submit">Quit monitoring</button></div></form>`;
  let authorizing = false;
  let cancellationSent = false;
  const cancelQuit = async () => {
    if (authorizing || cancellationSent) return;
    cancellationSent = true;
    try {
      await remoteCare.cancelProtectedQuit(state.session.token);
    } catch {
      // The local session may have expired while this dialog was open.
    }
  };
  document.body.append(dialog);
  dialog.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => {
    void cancelQuit();
    dialog.remove();
  });
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector('.error');
    error.textContent = '';
    authorizing = true;
    try {
      await request(() => remoteCare.quitWithPassword(state.session.token, form.elements.password.value, source));
    } catch (exception) {
      authorizing = false;
      error.textContent = exception.message || 'Unable to verify the password.';
      form.elements.password.select();
    }
  });
  dialog.showModal();
}

async function refreshNetworkAdapters(force = false) {
  const session = state.session;
  if (!session || state.page !== 'overview' || adapterRefreshInFlight) return;
  if (!force && Date.now() - lastAdapterRefreshAt < ADAPTER_REFRESH_INTERVAL_MS) return;

  adapterRefreshInFlight = true;
  try {
    const adapters = await request(() => remoteCare.getNetworkAdapters(session.token));
    if (state.session?.token !== session.token || state.page !== 'overview') return;
    state.adapters = adapters;
    lastAdapterRefreshAt = Date.now();
    renderAdapterList();
  } catch (error) {
    if (state.session?.token === session.token && state.page === 'overview') {
      lastAdapterRefreshAt = Date.now();
      const adapterList = document.getElementById('adapter-list');
      if (adapterList) adapterList.innerHTML = `<div class="empty">Unable to read adapters: ${escapeHtml(error.message)}</div>`;
    }
  } finally {
    adapterRefreshInFlight = false;
  }
}

async function refreshDashboard(force = false) {
  const session = state.session;
  if (!session) return;
  const version = ++dashboardRefreshVersion;
  const dashboard = await request(() => remoteCare.getDashboard(session.token));
  if (version !== dashboardRefreshVersion || state.session?.token !== session.token) return;

  state.dashboard = dashboard;
  if (force) {
    await renderPage();
  } else {
    updateDashboardLive();
  }
  void refreshNetworkAdapters();
}

let refreshInFlight = false;
let refreshQueued = false;
async function triggerDashboardRefresh(force = false) {
  if (force) {
    await refreshDashboard(true);
    return;
  }
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }
  refreshInFlight = true;
  try {
    await refreshDashboard(false);
  } catch (error) {
    flash(error.message, 'down');
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      setTimeout(() => triggerDashboardRefresh(false), 120);
    }
  }
}

function scheduleRefresh() {
  if (!state.session) return;
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => triggerDashboardRefresh(false), 100);
}

function startDashboardPolling() {
  if (state.dashboardPollTimer) return;
  state.dashboardPollTimer = setInterval(() => triggerDashboardRefresh(false), DASHBOARD_POLL_INTERVAL_MS);
}

function stopDashboardPolling() {
  clearInterval(state.dashboardPollTimer);
  state.dashboardPollTimer = null;
}

window.addEventListener('focus', () => triggerDashboardRefresh(false));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) triggerDashboardRefresh(false);
});

remoteCare.onUpdate((event) => {
  if (event?.type === 'app_settings_updated') state.settings = event.settings;
  if (event?.type === 'profile_updated') {
    if (state.session && state.session.userId === event.user?.id) {
      state.session.displayName = event.user.displayName;
      state.session.username = event.user.username;
      sessionStorage.setItem('remote-care-session', JSON.stringify(state.session));
      renderShell();
    }
  }
  if (event?.type === 'notification') {
    // The main process displays the popup even when this renderer is hidden.
    playNotificationChime(event.event?.kind);
  }
  scheduleRefresh();
});

remoteCare.onAppControl((event) => {
  if (event?.type !== 'quit_requested') return;
  if (state.session && isAdmin()) openQuitDialog(event.source || 'application');
  else flash('Sign in as a Super Admin to enter the password required to quit.', 'info');
});

(async function initialise() {
  ensureToastPopover();
  const remembered = sessionStorage.getItem('remote-care-session');
  if (remembered) {
    try {
      state.session = JSON.parse(remembered);
      await openDashboard();
      return;
    } catch {
      state.session = null;
      sessionStorage.removeItem('remote-care-session');
    }
  }
  renderAuth(await remoteCare.getSetupState());
}());
