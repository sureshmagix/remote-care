const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function elapsed(startedAt) {
  return Math.max(0, Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000));
}

function runCommand(command, args, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let completed = false;
    let child;
    let timer;
    const finish = (result) => {
      if (completed) return;
      completed = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    try {
      child = spawn(command, args, { windowsHide: true, shell: false });
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', (error) => finish({ exitCode: null, error: error.message, timedOut }));
      child.once('close', (exitCode) => finish({ exitCode, timedOut }));
    } catch (error) {
      finish({ exitCode: null, error: error.message, timedOut });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      setTimeout(() => finish({ exitCode: null, timedOut }), 200).unref();
    }, timeoutMs);
  });
}

function adapterKind(name, description = '') {
  const text = `${name} ${description}`.toLowerCase();
  if (/(wi-?fi|wireless|wlan|airport|802\.11)/.test(text)) return 'wireless';
  if (/(ethernet|wired|\blan\b|\beth\d+|\ben\d+|\ben[ops]\d+)/.test(text)) return 'wired';
  if (/(loopback|\blo\b)/.test(text)) return 'loopback';
  return 'other';
}

async function getWindowsAdapters() {
  const script = "Get-NetAdapter -IncludeHidden | Select-Object Name,InterfaceDescription,Status,MediaType,NdisPhysicalMedium,MacAddress,LinkSpeed,ifIndex | ConvertTo-Json -Compress";
  const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 6_000);
  if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error(result.error || result.stderr || 'Unable to read Windows network adapters.');
  const raw = JSON.parse(result.stdout);
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((item) => item && item.Name)
    .map((item) => {
      const description = `${item.InterfaceDescription || ''} ${item.NdisPhysicalMedium || ''} ${item.MediaType || ''}`;
      const kind = adapterKind(item.Name, description);
      return {
        name: item.Name,
        description: item.InterfaceDescription || item.Name,
        kind,
        state: String(item.Status || '').toLowerCase() === 'up' ? 'up' : 'down',
        connected: String(item.Status || '').toLowerCase() === 'up',
        mac: item.MacAddress || '',
        linkSpeed: item.LinkSpeed || ''
      };
    })
    .filter((adapter) => adapter.kind !== 'loopback');
}

function parseMacHardwarePorts(output) {
  const result = [];
  const blocks = output.split(/\n\s*\n/);
  for (const block of blocks) {
    const hardware = block.match(/Hardware Port:\s*(.+)/i)?.[1]?.trim();
    const device = block.match(/Device:\s*(.+)/i)?.[1]?.trim();
    if (hardware && device) result.push({ name: device, description: hardware, kind: adapterKind(device, hardware) });
  }
  return result;
}

async function getMacAdapters() {
  const [hardware, ifconfigResult] = await Promise.all([
    runCommand('networksetup', ['-listallhardwareports'], 5_000),
    runCommand('ifconfig', [], 3_000)
  ]);
  const ports = hardware.exitCode === 0 ? parseMacHardwarePorts(hardware.stdout) : [];
  const known = new Map(ports.map((item) => [item.name, item]));

  const blocks = new Map();
  let current = null;
  for (const line of ifconfigResult.stdout.split('\n')) {
    const match = line.match(/^([a-zA-Z0-9_]+):\s+flags=/);
    if (match) {
      current = match[1];
      blocks.set(current, line);
    } else if (current) {
      blocks.set(current, blocks.get(current) + '\n' + line);
    }
  }

  // Combine physical hardware ports plus any physical non-virtual interfaces
  const allNames = new Set([
    ...ports.map((item) => item.name),
    ...Object.keys(os.networkInterfaces()).filter((name) => !/^(lo\d*|utun\d*|llw\d*|awdl\d*|gif\d*|stf\d*|p2p\d*|ipsec\d*|ap\d*|vboxnet\d*|vmnet\d*)/i.test(name))
  ]);

  const adapters = [];
  for (const name of allNames) {
    const text = blocks.get(name) || '';
    const mapped = known.get(name);
    const hasIp = /inet\s+(?!127\.)\d+\.\d+\.\d+\.\d+/.test(text);
    const active = /status:\s+active/i.test(text) || hasIp;
    adapters.push({
      name,
      description: mapped?.description || name,
      kind: mapped?.kind || adapterKind(name, mapped?.description),
      state: active ? 'up' : 'down',
      connected: active,
      mac: text.match(/ether\s+([0-9a-f:]{17})/i)?.[1] || '',
      linkSpeed: ''
    });
  }
  return adapters.filter((adapter) => adapter.kind !== 'loopback');
}

async function getLinuxAdapters() {
  let names = [];
  try {
    names = fs.readdirSync('/sys/class/net').filter((name) => name !== 'lo');
  } catch {
    names = Object.keys(os.networkInterfaces()).filter((name) => name !== 'lo');
  }
  const adapters = [];
  for (const name of names) {
    const base = path.join('/sys/class/net', name);
    let state = 'unknown';
    let carrier = '';
    try { state = fs.readFileSync(path.join(base, 'operstate'), 'utf8').trim(); } catch {}
    try { carrier = fs.readFileSync(path.join(base, 'carrier'), 'utf8').trim(); } catch {}
    const wireless = fs.existsSync(path.join(base, 'wireless'));
    const kind = wireless ? 'wireless' : adapterKind(name);
    const connected = state === 'up' && (carrier === '' || carrier === '1');
    let mac = '';
    try { mac = fs.readFileSync(path.join(base, 'address'), 'utf8').trim(); } catch {}
    adapters.push({ name, description: name, kind, state, connected, mac, linkSpeed: '' });
  }
  return adapters.filter((adapter) => adapter.kind !== 'loopback');
}

async function getNetworkAdapters() {
  try {
    if (process.platform === 'win32') return await getWindowsAdapters();
    if (process.platform === 'darwin') return await getMacAdapters();
    return await getLinuxAdapters();
  } catch (error) {
    return Object.entries(os.networkInterfaces())
      .filter(([name]) => !/^lo\d*$/.test(name))
      .map(([name, addresses]) => ({
        name,
        description: name,
        kind: adapterKind(name),
        state: addresses?.length ? 'unknown' : 'down',
        connected: Boolean(addresses?.some((address) => !address.internal)),
        mac: addresses?.[0]?.mac || '',
        linkSpeed: '',
        fallback: true,
        error: error.message
      }));
  }
}

async function getDefaultGateway() {
  if (process.platform === 'win32') {
    const script = "Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1 NextHop,InterfaceAlias | ConvertTo-Json -Compress";
    const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 5_000);
    if (result.exitCode === 0 && result.stdout.trim()) {
      const parsed = JSON.parse(result.stdout);
      if (parsed.NextHop && parsed.NextHop !== '0.0.0.0') return { gateway: parsed.NextHop, interfaceName: parsed.InterfaceAlias || '' };
    }
  } else if (process.platform === 'darwin') {
    const result = await runCommand('route', ['-n', 'get', 'default'], 5_000);
    const gateway = result.stdout.match(/gateway:\s*([^\s]+)/i)?.[1];
    const interfaceName = result.stdout.match(/interface:\s*([^\s]+)/i)?.[1];
    if (gateway) return { gateway, interfaceName: interfaceName || '' };
  } else {
    const result = await runCommand('ip', ['route', 'show', 'default'], 5_000);
    const gateway = result.stdout.match(/default\s+via\s+([^\s]+)/)?.[1];
    const interfaceName = result.stdout.match(/\sdev\s+([^\s]+)/)?.[1];
    if (gateway) return { gateway, interfaceName: interfaceName || '' };
  }
  return null;
}

async function checkPing(host, timeoutMs) {
  const startedAt = process.hrtime.bigint();
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', String(timeoutMs), host]
    : ['-c', '1', '-W', String(timeoutSeconds), host];
  const result = await runCommand('ping', args, timeoutMs + 1_500);
  const output = `${result.stdout}\n${result.stderr}`;
  const parsed = output.match(/(?:time[=<]\s*|Average = \d+ms, Maximum = \d+ms, Average = )(\d+(?:\.\d+)?)\s*ms/i);
  const latencyMs = parsed ? Math.round(Number(parsed[1])) : elapsed(startedAt);
  return result.exitCode === 0
    ? { ok: true, latencyMs, message: `${host} replied in ${latencyMs} ms.`, details: { host } }
    : { ok: false, latencyMs: null, message: result.timedOut ? `Ping to ${host} timed out.` : `No ICMP reply from ${host}.`, details: { host, output: output.slice(-1000) } };
}

function checkTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    const socket = net.createConnection({ host, port: Number(port) });
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish({ ok: true, latencyMs: elapsed(startedAt), message: `TCP port ${port} is reachable on ${host}.`, details: { host, port: Number(port) } }));
    socket.once('error', (error) => finish({ ok: false, latencyMs: null, message: `TCP port ${port} is not reachable on ${host}: ${error.code || error.message}`, details: { host, port: Number(port), code: error.code } }));
    const timer = setTimeout(() => finish({ ok: false, latencyMs: null, message: `TCP connection to ${host}:${port} timed out.`, details: { host, port: Number(port) } }), timeoutMs);
  });
}

async function checkHttp(url, timeoutMs) {
  const startedAt = process.hrtime.bigint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'follow' });
    await response.body?.cancel();
    const latencyMs = elapsed(startedAt);
    const ok = response.status >= 200 && response.status < 400;
    return {
      ok,
      latencyMs,
      message: ok ? `${new URL(url).host} replied with HTTP ${response.status}.` : `${new URL(url).host} returned HTTP error ${response.status}.`,
      details: { url, statusCode: response.status }
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: null,
      message: error.name === 'AbortError' ? `HTTP request to ${url} timed out.` : `HTTP request to ${url} failed: ${error.message}`,
      details: { url, error: error.message }
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkInterface(target) {
  const adapters = await getNetworkAdapters();
  const rawRequested = String(target.interfaceName || 'auto').trim().toLowerCase();

  let candidates;
  if (!rawRequested || rawRequested === 'auto') {
    const physical = adapters.filter((adapter) => adapter.kind === 'wireless' || adapter.kind === 'wired');
    candidates = physical.length > 0 ? physical : adapters.filter((adapter) => adapter.kind !== 'loopback');
  } else if (['wireless', 'wifi', 'wi-fi', 'wlan'].includes(rawRequested)) {
    candidates = adapters.filter((adapter) => adapter.kind === 'wireless' || /wi-?fi|wireless/i.test(adapter.description) || /wi-?fi|wireless/i.test(adapter.name));
    if (candidates.length === 0) {
      return { ok: false, latencyMs: null, message: 'No Wi‑Fi / wireless network adapter was found on this device.', details: { adapters } };
    }
  } else if (['wired', 'ethernet', 'lan'].includes(rawRequested)) {
    candidates = adapters.filter((adapter) => adapter.kind === 'wired' || /ethernet|lan|wired/i.test(adapter.description) || /ethernet|lan|wired/i.test(adapter.name));
    if (candidates.length === 0) {
      return { ok: false, latencyMs: null, message: 'No Ethernet / wired network adapter was found on this device.', details: { adapters } };
    }
  } else {
    candidates = adapters.filter((adapter) =>
      adapter.name.toLowerCase() === rawRequested ||
      adapter.description.toLowerCase() === rawRequested ||
      adapter.description.toLowerCase().includes(rawRequested)
    );
    if (candidates.length === 0) {
      return { ok: false, latencyMs: null, message: `Network adapter “${target.interfaceName}” was not found.`, details: { adapters } };
    }
  }

  const connected = candidates.filter((adapter) => adapter.connected);
  if (connected.length > 0) {
    const labels = connected.map((adapter) => `${adapter.kind === 'wireless' ? 'Wi‑Fi' : adapter.kind === 'wired' ? 'Wired' : 'Network'} (${adapter.description || adapter.name})`).join(', ');
    return { ok: true, latencyMs: 0, message: `${labels} connected.`, details: { adapters: candidates, connected } };
  }

  const isWifiTarget = ['wireless', 'wifi', 'wi-fi', 'wlan'].includes(rawRequested) || candidates.some((a) => a.kind === 'wireless');
  const isWiredTarget = ['wired', 'ethernet', 'lan'].includes(rawRequested) || candidates.some((a) => a.kind === 'wired');
  const targetLabel = isWifiTarget && !isWiredTarget
    ? 'Wi‑Fi connection is disconnected.'
    : isWiredTarget && !isWifiTarget
      ? 'Wired network is disconnected.'
      : candidates.length === 1
        ? `${candidates[0].description || candidates[0].name} is disconnected.`
        : 'Network adapter is disconnected.';

  return { ok: false, latencyMs: null, message: targetLabel, details: { adapters: candidates } };
}

async function checkGateway(target) {
  const gateway = await getDefaultGateway();
  if (!gateway?.gateway) return { ok: false, latencyMs: null, message: 'No default gateway is configured. The local network may be disconnected.', details: {} };
  const result = await checkPing(gateway.gateway, target.timeoutMs);
  return { ...result, message: result.ok ? `Default gateway ${gateway.gateway} is reachable.` : `Default gateway ${gateway.gateway} is not reachable.`, details: { ...result.details, ...gateway } };
}

async function checkInternet(target) {
  const dnsHost = String(target.metadata?.dnsHost || new URL(target.url).hostname);
  try {
    const answers = await dns.resolve4(dnsHost);
    if (!answers.length) return { ok: false, latencyMs: null, message: `DNS did not return an address for ${dnsHost}.`, details: { dnsHost } };
  } catch (error) {
    return { ok: false, latencyMs: null, message: `DNS lookup failed for ${dnsHost}: ${error.code || error.message}`, details: { dnsHost, code: error.code } };
  }
  const http = await checkHttp(target.url, target.timeoutMs);
  return { ...http, message: http.ok ? `Internet connection is available (${new URL(target.url).host}).` : `Internet HTTPS check failed: ${http.message}` };
}

async function checkSystemService(serviceName, timeoutMs) {
  let result;
  if (process.platform === 'win32') {
    result = await runCommand('sc.exe', ['query', serviceName], timeoutMs);
    const active = result.exitCode === 0 && /STATE\s*:\s*4\s+RUNNING/i.test(result.stdout);
    return {
      ok: active,
      latencyMs: 0,
      message: active ? `Windows service “${serviceName}” is running.` : `Windows service “${serviceName}” is not running.`,
      details: { serviceName, output: (result.stdout || result.stderr || '').slice(-1000) }
    };
  }
  if (process.platform === 'darwin') {
    result = await runCommand('launchctl', ['print', `system/${serviceName}`], timeoutMs);
    if (result.exitCode !== 0) {
      result = await runCommand('launchctl', ['print', `gui/${process.getuid()}/${serviceName}`], timeoutMs);
    }
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    // launchctl print exits with 0 even when service is stopped (state = not running).
    // Validate that the service explicitly has running state or an active non-zero PID.
    const isRunningState = /\bstate\s*=\s*running\b/i.test(combinedOutput);
    const hasActivePid = /\bpid\s*=\s*[1-9]\d*\b/i.test(combinedOutput);
    let active = result.exitCode === 0 && (isRunningState || hasActivePid);

    if (!active && result.exitCode !== 0) {
      const listCheck = await runCommand('launchctl', ['list', serviceName], timeoutMs);
      if (listCheck.exitCode === 0) {
        active = /"PID"\s*=\s*[1-9]\d*/i.test(listCheck.stdout);
      }
    }

    return {
      ok: active,
      latencyMs: 0,
      message: active ? `launchd service “${serviceName}” is running.` : `launchd service “${serviceName}” is not running.`,
      details: { serviceName, output: combinedOutput.slice(-1000) }
    };
  }
  result = await runCommand('systemctl', ['is-active', serviceName], timeoutMs);
  const statusText = (result.stdout || '').trim().toLowerCase();
  const active = result.exitCode === 0 && statusText === 'active';
  return {
    ok: active,
    latencyMs: 0,
    message: active ? `systemd service “${serviceName}” is running.` : `systemd service “${serviceName}” is not running (${statusText || 'inactive'}).`,
    details: { serviceName, output: `${result.stdout}\n${result.stderr}`.slice(-1000) }
  };
}

async function checkProcess(processName, timeoutMs) {
  if (process.platform === 'win32') {
    const result = await runCommand('tasklist.exe', ['/FI', `IMAGENAME eq ${processName}`, '/NH'], timeoutMs);
    const active = result.exitCode === 0 && result.stdout.toLowerCase().includes(processName.toLowerCase());
    return { ok: active, latencyMs: 0, message: active ? `Process “${processName}” is running.` : `Process “${processName}” is not running.`, details: { processName } };
  }
  const result = await runCommand('ps', ['-A', '-o', 'comm='], timeoutMs);
  const expected = processName.toLowerCase();
  const active = result.exitCode === 0 && result.stdout.split(/\r?\n/).some((name) => path.basename(name.trim()).toLowerCase() === expected);
  return { ok: active, latencyMs: 0, message: active ? `Process “${processName}” is running.` : `Process “${processName}” is not running.`, details: { processName } };
}

async function executeCheck(target) {
  try {
    switch (target.type) {
      case 'internet': return await checkInternet(target);
      case 'interface': return await checkInterface(target);
      case 'gateway': return await checkGateway(target);
      case 'ping': return await checkPing(target.host, target.timeoutMs);
      case 'tcp': return await checkTcp(target.host, target.port, target.timeoutMs);
      case 'http': return await checkHttp(target.url, target.timeoutMs);
      case 'system_service': return await checkSystemService(target.serviceName, target.timeoutMs);
      case 'process': return await checkProcess(target.processName, target.timeoutMs);
      default: return { ok: false, latencyMs: null, message: 'Unsupported monitor type.', details: {} };
    }
  } catch (error) {
    return { ok: false, latencyMs: null, message: `Monitor execution failed: ${error.message}`, details: { error: error.message } };
  }
}

module.exports = { executeCheck, getNetworkAdapters, getDefaultGateway, runCommand, checkPing, checkTcp, checkHttp, checkSystemService, checkProcess };
