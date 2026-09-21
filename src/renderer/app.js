/* global remoteCare */
const state = {
  session: null,
  dashboard: null,
  adapters: [],
  users: [],
  appInfo: null,
  page: 'overview',
  refreshTimer: null
};

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
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
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

function flash(message, kind = 'info') {
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  const title = document.createElement('strong');
  title.textContent = kind === 'down' ? 'Monitoring alert' : kind === 'recovered' ? 'Recovered' : 'Remote Care Monitor';
  const body = document.createElement('span');
  body.textContent = message;
  element.append(title, body);
  toastRegion.append(element);
  setTimeout(() => element.remove(), 6_000);
}

async function request(action) {
  try {
    return await action();
  } catch (error) {
    if (/session has expired/i.test(error.message)) {
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
  state.dashboard = await request(() => remoteCare.getDashboard(state.session.token));
  renderShell();
  await renderPage();
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
          <button data-page="about">ⓘ About</button>
        </nav>
        <div class="sidebar-footer"><div class="user-chip"><strong>${escapeHtml(state.session.displayName)}</strong>${escapeHtml(role)} · local session</div><button class="button ghost small" id="logout">Sign out</button></div>
      </aside>
      <section class="content" id="page-content"></section>
    </main>`;
  root.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', async () => {
    state.page = button.dataset.page;
    await renderPage();
  }));
  document.getElementById('logout').addEventListener('click', async () => {
    await remoteCare.logout(state.session.token);
    state.session = null;
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
  if (state.page === 'overview') return renderOverview(content);
  if (state.page === 'monitors') return renderMonitors(content);
  if (state.page === 'history') return renderHistory(content);
  if (state.page === 'users') return renderUsers(content);
  return renderAbout(content);
}

async function renderOverview(content) {
  const { summary, activeIncidents, notifications } = state.dashboard;
  const overall = overallStatus();
  content.innerHTML = `
    <header class="page-header"><div><h2>Monitoring overview</h2><p>Local checks continue while this window is hidden in the tray.</p></div><div class="status-line"><span class="dot ${overall.className}"></span>${overall.text}</div></header>
    <section class="stat-grid">
      <article class="card stat"><div class="label">Active monitors</div><div class="number">${summary.total}</div></article>
      <article class="card stat good"><div class="label">Healthy</div><div class="number">${summary.healthy}</div></article>
      <article class="card stat warning"><div class="label">Checking</div><div class="number">${summary.warning}</div></article>
      <article class="card stat down"><div class="label">Unavailable</div><div class="number">${summary.down}</div></article>
      <article class="card stat"><div class="label">Not checked yet</div><div class="number">${summary.unknown}</div></article>
    </section>
    <section class="section-grid">
      <article class="card"><div class="panel-title"><h3>Active incidents</h3><span>${activeIncidents.length} open</span></div><div class="panel-body" id="incident-list"></div></article>
      <div class="section-stack">
        <article class="card"><div class="panel-title"><h3>Network adapters</h3><span>Local device</span></div><div class="panel-body" id="adapter-list"><div class="empty">Loading adapters…</div></div></article>
        <article class="card" style="margin-top:18px"><div class="panel-title"><h3>Recent notifications</h3><span>Local history</span></div><div class="panel-body" id="notification-list"></div></article>
      </div>
    </section>`;
  const incidents = document.getElementById('incident-list');
  incidents.innerHTML = activeIncidents.length ? activeIncidents.map((incident) => `
    <div class="incident"><div class="incident-meta">${badge(incident.severity === 'critical' ? 'down' : 'warning', incident.severity)}<span>${escapeHtml(age(incident.startedAt))}</span></div><h4>${escapeHtml(incident.targetName)}</h4><p>${escapeHtml(incident.message)}</p>${isAdmin() && !incident.acknowledgedAt ? `<div><button class="button secondary small" data-ack="${incident.id}">Acknowledge</button></div>` : incident.acknowledgedAt ? '<span class="muted">Acknowledged</span>' : ''}</div>`).join('') : '<div class="empty">No active incidents. Monitoring is currently clear.</div>';
  incidents.querySelectorAll('[data-ack]').forEach((button) => button.addEventListener('click', async () => {
    await request(() => remoteCare.acknowledgeIncident(state.session.token, Number(button.dataset.ack)));
    await refreshDashboard();
  }));
  const notifyList = document.getElementById('notification-list');
  notifyList.innerHTML = notifications.length ? notifications.slice(0, 6).map((item) => `<div class="notification-item"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.body)}</span><span>${escapeHtml(age(item.deliveredAt))}</span></div>`).join('') : '<div class="empty">Notifications will be stored here.</div>';
  try {
    state.adapters = await request(() => remoteCare.getNetworkAdapters(state.session.token));
    const adapterList = document.getElementById('adapter-list');
    adapterList.innerHTML = state.adapters.length ? `<div class="adapter-list">${state.adapters.map((adapter) => `<div class="adapter"><div><strong>${escapeHtml(adapter.kind === 'wireless' ? 'Wi‑Fi' : adapter.kind === 'wired' ? 'Wired' : adapter.description)}</strong><small>${escapeHtml(adapter.name)}${adapter.linkSpeed ? ` · ${escapeHtml(adapter.linkSpeed)}` : ''}</small></div>${badge(adapter.connected ? 'healthy' : 'down', adapter.connected ? 'connected' : 'disconnected')}</div>`).join('')}</div>` : '<div class="empty">No physical adapters found.</div>';
  } catch (error) {
    document.getElementById('adapter-list').innerHTML = `<div class="empty">Unable to read adapters: ${escapeHtml(error.message)}</div>`;
  }
}

function renderMonitors(content) {
  const targets = state.dashboard.targets;
  content.innerHTML = `
    <header class="page-header"><div><h2>Monitors</h2><p>Configure local connectivity, server, and service checks.</p></div>${isAdmin() ? '<button class="button" id="add-monitor">+ Add monitor</button>' : '<div class="status-line">Viewer access · configuration locked</div>'}</header>
    <article class="card"><div class="table-wrap"><table><thead><tr><th>Monitor</th><th>Type</th><th>Status</th><th>Last check</th><th>Latency</th>${isAdmin() ? '<th>Actions</th>' : ''}</tr></thead><tbody id="monitor-table"></tbody></table></div></article>`;
  const body = document.getElementById('monitor-table');
  body.innerHTML = targets.length ? targets.map((target) => `<tr>
    <td><div class="target-name">${escapeHtml(target.name)}<small>${escapeHtml(targetDestination(target))}${target.enabled ? '' : ' · disabled'}</small></div></td>
    <td>${escapeHtml(prettyType(target.type))}</td>
    <td>${target.enabled ? badge(target.status) : badge('unknown', 'disabled')}</td>
    <td title="${escapeHtml(prettyTime(target.lastCheckedAt))}">${escapeHtml(age(target.lastCheckedAt))}</td>
    <td>${target.lastLatencyMs === null || target.lastLatencyMs === undefined ? '—' : `${target.lastLatencyMs} ms`}</td>
    ${isAdmin() ? `<td><div class="actions" style="margin:0"><button class="button secondary small" data-run="${target.id}">Run</button><button class="button ghost small" data-edit="${target.id}">Edit</button><button class="button danger small" data-delete="${target.id}">Delete</button></div></td>` : ''}
  </tr>`).join('') : `<tr><td colspan="${isAdmin() ? 6 : 5}" class="empty">No monitors configured.</td></tr>`;
  if (!isAdmin()) return;
  document.getElementById('add-monitor').addEventListener('click', () => openMonitorDialog());
  body.querySelectorAll('[data-run]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await request(() => remoteCare.runTarget(state.session.token, Number(button.dataset.run))); await refreshDashboard(); } catch (error) { flash(error.message, 'down'); } finally { button.disabled = false; }
  }));
  body.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => openMonitorDialog(targets.find((target) => target.id === Number(button.dataset.edit)))));
  body.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', async () => {
    const target = targets.find((item) => item.id === Number(button.dataset.delete));
    if (!window.confirm(`Delete monitor “${target.name}”? Its local history will also be removed.`)) return;
    try { await request(() => remoteCare.deleteTarget(state.session.token, target.id)); await refreshDashboard(); } catch (error) { flash(error.message, 'down'); }
  }));
}

function renderHistory(content) {
  const history = state.dashboard.history;
  content.innerHTML = `
    <header class="page-header"><div><h2>Check history</h2><p>Latest local results. Old results are automatically retained for 30 days.</p></div><button class="button secondary" id="refresh-history">Refresh</button></header>
    <article class="card"><div class="table-wrap"><table><thead><tr><th>Time</th><th>Monitor</th><th>Result</th><th>Message</th><th>Latency</th></tr></thead><tbody>${history.length ? history.map((result) => `<tr><td title="${escapeHtml(prettyTime(result.checkedAt))}">${escapeHtml(age(result.checkedAt))}</td><td>${escapeHtml(result.targetName)}</td><td>${badge(result.status, result.ok ? 'success' : result.status)}</td><td class="muted">${escapeHtml(result.message)}</td><td>${result.latencyMs === null || result.latencyMs === undefined ? '—' : `${result.latencyMs} ms`}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">No checks have completed yet.</td></tr>'}</tbody></table></div></article>`;
  document.getElementById('refresh-history').addEventListener('click', refreshDashboard);
}

async function renderUsers(content) {
  if (!isAdmin()) {
    content.innerHTML = `<header class="page-header"><div><h2>Local users</h2><p>Viewer accounts can see monitoring status and history but cannot make changes.</p></div></header><article class="card"><div class="panel-body"><div class="empty">You are signed in as a Viewer. User management is available only to the Super Admin.</div></div></article>`;
    return;
  }
  content.innerHTML = `<header class="page-header"><div><h2>Local users</h2><p>One Super Admin and a maximum of five Viewer accounts are stored only on this PC.</p></div><button class="button" id="add-viewer">+ Add Viewer</button></header><article class="card"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Last sign-in</th><th>Status</th><th>Actions</th></tr></thead><tbody id="user-table"><tr><td colspan="6" class="empty">Loading users…</td></tr></tbody></table></div></article>`;
  try {
    state.users = await request(() => remoteCare.listUsers(state.session.token));
    const body = document.getElementById('user-table');
    body.innerHTML = state.users.map((user) => `<tr><td>${escapeHtml(user.displayName)}</td><td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.role === 'super_admin' ? 'Super Admin' : 'Viewer')}</td><td>${escapeHtml(user.lastLoginAt ? prettyTime(user.lastLoginAt) : 'Never')}</td><td>${badge(user.active ? 'healthy' : 'down', user.active ? 'active' : 'disabled')}</td><td>${user.role === 'viewer' ? `<div class="actions" style="margin:0"><button class="button ghost small" data-password="${user.id}">Password</button><button class="button ${user.active ? 'danger' : 'secondary'} small" data-toggle="${user.id}" data-active="${user.active}">${user.active ? 'Disable' : 'Enable'}</button></div>` : '—'}</td></tr>`).join('');
    document.getElementById('add-viewer').addEventListener('click', openViewerDialog);
    body.querySelectorAll('[data-toggle]').forEach((button) => button.addEventListener('click', async () => {
      const active = button.dataset.active !== 'true';
      try { await request(() => remoteCare.setViewerActive(state.session.token, Number(button.dataset.toggle), active)); await renderUsers(content); } catch (error) { flash(error.message, 'down'); }
    }));
    body.querySelectorAll('[data-password]').forEach((button) => button.addEventListener('click', () => openResetPasswordDialog(Number(button.dataset.password))));
  } catch (error) { document.getElementById('user-table').innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(error.message)}</td></tr>`; }
}

async function renderAbout(content) {
  if (!state.appInfo) state.appInfo = await request(() => remoteCare.getAppInfo(state.session.token));
  content.innerHTML = `<header class="page-header"><div><h2>About this device</h2><p>Phase 1 works completely locally. Cloud publishing is deliberately disabled.</p></div></header><article class="card"><div class="panel-body"><div class="info-grid"><div class="info-item"><span>Application version</span><strong>${escapeHtml(state.appInfo.version)}</strong></div><div class="info-item"><span>Platform</span><strong>${escapeHtml(state.appInfo.platform)} / ${escapeHtml(state.appInfo.arch)}</strong></div><div class="info-item"><span>Data location</span><strong>${escapeHtml(state.appInfo.dataPath)}</strong></div><div class="info-item"><span>Cloud sync</span><strong>${escapeHtml(state.appInfo.cloudSync)}</strong></div></div><p class="helper" style="margin:20px 0 0">The durable local event queue is ready for a Phase 2 HTTPS or MQTT sender. It currently sends no data outside this computer.</p></div></article>`;
}

function monitorFields(type) {
  const visibility = {
    host: ['ping', 'tcp'].includes(type), port: type === 'tcp', url: ['http', 'internet'].includes(type),
    interface: type === 'interface', service: type === 'system_service', process: type === 'process', dns: type === 'internet'
  };
  document.querySelectorAll('[data-monitor-field]').forEach((element) => element.classList.toggle('hidden', !visibility[element.dataset.monitorField]));
}

function openMonitorDialog(target = null) {
  const value = (key, fallback = '') => escapeHtml(target?.[key] ?? fallback);
  const checked = target?.enabled === false ? '' : 'checked';
  const metadata = target?.metadata || {};
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `
    <div class="dialog-header"><h3>${target ? 'Edit monitor' : 'Add monitor'}</h3><button class="button ghost small" type="button" data-close>Close</button></div>
    <form id="monitor-form"><div class="dialog-body">
      <div class="two-col"><div class="field"><label>Name</label><input name="name" required maxlength="80" value="${value('name')}" placeholder="Production API" /></div><div class="field"><label>Check type</label><select name="type"><option value="internet">Internet connection</option><option value="interface">Network interface</option><option value="gateway">Default gateway</option><option value="ping">ICMP ping</option><option value="tcp">TCP port</option><option value="http">HTTP/HTTPS endpoint</option><option value="system_service">Local system service</option><option value="process">Local process</option></select></div></div>
      <div class="field" data-monitor-field="host"><label>Host or IP address</label><input name="host" value="${value('host')}" placeholder="192.168.1.20 or api.example.com" /></div>
      <div class="field" data-monitor-field="port"><label>TCP port</label><input name="port" type="number" min="1" max="65535" value="${value('port')}" placeholder="1883" /></div>
      <div class="field" data-monitor-field="url"><label>HTTP/HTTPS URL</label><input name="url" type="url" value="${value('url')}" placeholder="https://api.example.com/health" /></div>
      <div class="field" data-monitor-field="dns"><label>DNS hostname to resolve</label><input name="dnsHost" value="${escapeHtml(metadata.dnsHost || '')}" placeholder="cloudflare.com" /><span class="helper">Used before the Internet HTTPS check to distinguish DNS failure.</span></div>
      <div class="field" data-monitor-field="interface"><label>Adapter name</label><input name="interfaceName" value="${value('interfaceName', 'auto')}" placeholder="auto, wlan0, en0, Ethernet" /><span class="helper">Use “auto” to alert when no physical network adapter is connected.</span></div>
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
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = dialog.querySelector('#monitor-error');
    error.textContent = '';
    const values = Object.fromEntries(new FormData(form).entries());
    const payload = { ...values, id: target?.id, enabled: form.elements.enabled.checked, metadata: { dnsHost: values.dnsHost } };
    try { await request(() => remoteCare.saveTarget(state.session.token, payload)); dialog.close(); await refreshDashboard(); flash(`Monitor “${values.name}” saved.`); } catch (exception) { error.textContent = exception.message; }
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

function openResetPasswordDialog(userId) {
  const user = state.users.find((item) => item.id === userId);
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<div class="dialog-header"><h3>Reset Viewer password</h3><button class="button ghost small" data-close>Close</button></div><form><div class="dialog-body"><p class="helper">Set a new password for ${escapeHtml(user?.displayName || 'this Viewer')}. The account will be signed out of any active local session.</p><div class="field"><label>New password</label><input name="password" type="password" required minlength="10" /></div><div class="error"></div></div><div class="dialog-footer"><button class="button secondary" type="button" data-close>Cancel</button><button class="button" type="submit">Reset password</button></div></form>`;
  document.body.append(dialog); dialog.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => dialog.close())); dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const error = form.querySelector('.error'); try { await request(() => remoteCare.resetViewerPassword(state.session.token, userId, form.elements.password.value)); dialog.close(); flash('Viewer password reset.'); } catch (exception) { error.textContent = exception.message; } });
  dialog.showModal();
}

async function refreshDashboard() {
  if (!state.session) return;
  state.dashboard = await request(() => remoteCare.getDashboard(state.session.token));
  await renderPage();
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => refreshDashboard().catch((error) => flash(error.message, 'down')), 160);
}

remoteCare.onUpdate((event) => {
  if (event?.type === 'notification') flash(event.event.body, event.event.kind);
  scheduleRefresh();
});

(async function initialise() {
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
