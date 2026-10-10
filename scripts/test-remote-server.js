#!/usr/bin/env node
/**
 * Test Remote Server for Remote Care Monitor
 * 
 * Features:
 * - Zero external npm dependencies (uses native node:http)
 * - HTTP Target Check endpoint (/health, /fail, /slow)
 * - Remote Care Cloud Sync endpoint (/api/sync, /api/diagnostic/sync)
 * - Result Changes History endpoint (/api/history, /api/diagnostic/history)
 * - Deduplication for state transitions and device telemetry/storage
 * - Webhook Receiver endpoint (/webhook)
 * - Live Web Dashboard on / to view received telemetry and toggle simulated outages
 * 
 * Usage:
 *   PORT=3000 FALLBACK_PORT=3001 AUTH_TOKEN=secret123 node scripts/test-remote-server.js
 */

const http = require('node:http');
const { URL } = require('node:url');

const DEFAULT_PORT = 3999;
const MAX_PORT = 65535;

function parsePort(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
    throw new Error(`${label} must be an integer between 0 and ${MAX_PORT}.`);
  }
  return port;
}

function defaultFallbackPort(port) {
  return port < MAX_PORT ? port + 1 : port - 1;
}

const PORT = parsePort(process.env.PORT ?? process.argv[2], DEFAULT_PORT, 'PORT');
const FALLBACK_PORT = parsePort(process.env.FALLBACK_PORT, defaultFallbackPort(PORT), 'FALLBACK_PORT');
const AUTH_TOKEN = process.env.AUTH_TOKEN !== undefined ? process.env.AUTH_TOKEN : 'Wiitronics_diagnostic';
const MAX_LOGS = 50;

function portCandidates(port, fallbackPort) {
  // Port zero delegates selection to the operating system. It is the final
  // fallback so a usable server can still start if both configured ports are busy.
  return [...new Set([port, fallbackPort, 0])];
}

function listenOnce(server, { host, port }) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      const address = server.address();
      cleanup();
      resolve(address);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function listenWithFallback(server, { host = '0.0.0.0', port = PORT, fallbackPort = FALLBACK_PORT } = {}) {
  const requestedPort = parsePort(port, PORT, 'port');
  const requestedFallbackPort = parsePort(fallbackPort, FALLBACK_PORT, 'fallbackPort');
  const attemptedPorts = [];

  for (const candidate of portCandidates(requestedPort, requestedFallbackPort)) {
    attemptedPorts.push(candidate);
    try {
      const address = await listenOnce(server, { host, port: candidate });
      const activePort = typeof address === 'object' && address ? address.port : candidate;
      return {
        port: activePort,
        requestedPort,
        fallbackPort: requestedFallbackPort,
        attemptedPorts,
        usedFallback: candidate !== requestedPort
      };
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    }
  }

  throw new Error(`Could not bind the test server. Ports tried: ${attemptedPorts.join(', ')}.`);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) { // 2MB limit
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        resolve({ raw: data });
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function isAuthorized(req, expectedToken) {
  if (!expectedToken) return true;
  const apiKey = req.headers['x-api-key'];
  if (apiKey && String(apiKey).trim() === expectedToken) return true;
  const authHeader = req.headers['authorization'] || '';
  if (authHeader === `Bearer ${expectedToken}`) return true;
  return false;
}

function getLocalIps() {
  const os = require('node:os');
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const item of list || []) {
      if (!item.internal && item.family === 'IPv4') {
        ips.push({ iface: name, address: item.address });
      }
    }
  }
  return ips;
}

function renderHtmlDashboard({
  reqHost,
  port,
  authToken,
  isSimulatingFailure,
  receivedHeartbeats,
  receivedEvents,
  receivedHistory,
  receivedWebhooks
}) {
  const latestHeartbeat = receivedHeartbeats[0] || null;
  const localIps = getLocalIps();
  const lanIp = localIps[0]?.address || '127.0.0.1';
  const displayHost = reqHost || `localhost:${port}`;
  const lanBaseUrl = `http://${lanIp}:${port}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Remote Care — Test Remote Server</title>
  <style>
    :root {
      --bg: #0b1320;
      --card: #132238;
      --card-alt: #182b47;
      --border: #263d60;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --success: #22c55e;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 24px;
      line-height: 1.5;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    h1, h2, h3, h4 { margin-top: 0; color: #fff; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 18px;
      flex-wrap: wrap;
      gap: 16px;
    }
    .badge { padding: 4px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; display: inline-block; }
    .badge-ok { background: rgba(34, 197, 94, 0.2); color: var(--success); border: 1px solid var(--success); }
    .badge-fail { background: rgba(239, 68, 68, 0.2); color: var(--danger); border: 1px solid var(--danger); }
    .badge-info { background: rgba(56, 189, 248, 0.2); color: var(--accent); border: 1px solid var(--accent); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; box-shadow: 0 4px 16px rgba(0,0,0,0.25); }
    .btn { cursor: pointer; padding: 8px 16px; border-radius: 6px; font-weight: 600; border: none; transition: 0.15s; font-size: 13px; }
    .btn-danger { background: var(--danger); color: white; }
    .btn-success { background: var(--success); color: white; }
    .btn-secondary { background: var(--border); color: #e2e8f0; }
    .btn:hover { opacity: 0.9; }
    pre { background: #070d17; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; border: 1px solid var(--border); color: #cbd5e1; max-height: 260px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .url-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    .url-table th, .url-table td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
    .url-table th { color: var(--muted); text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; background: #0c1829; }
    .url-table tr:hover { background: #182b47; }
    .url-table code { color: #38bdf8; font-weight: 600; word-break: break-all; }
    .tag { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: bold; margin-right: 6px; }
    .tag-get { background: #0284c7; color: white; }
    .tag-post { background: #059669; color: white; }
    .copy-btn { padding: 3px 8px; font-size: 11px; background: #263d60; color: #fff; border: none; border-radius: 4px; cursor: pointer; margin-left: 8px; }
    .copy-btn:hover { background: #38bdf8; color: #000; }
    .meta-item { display: flex; justify-content: space-between; margin-bottom: 7px; border-bottom: 1px dashed var(--border); padding-bottom: 5px; font-size: 13px; }
    .meta-label { color: var(--muted); }
    .tab-section-title { color: #7dd3fc; margin-bottom: 6px; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
    .instruction-box { background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>Remote Care — Test Remote Server</h1>
        <p style="color: var(--muted); margin: 0;">Multi-Endpoint Diagnostic Server for Cloud Sync, History of Changes, and Webhooks</p>
      </div>
      <div>
        ${authToken ? `<span class="badge badge-info" style="margin-right: 8px;">Auth: ${authToken}</span>` : '<span class="badge badge-ok" style="margin-right: 8px;">Auth: None (Open)</span>'}
        ${isSimulatingFailure ? '<span class="badge badge-fail">Outage Simulated (500)</span>' : '<span class="badge badge-ok">Normal Operation (200)</span>'}
      </div>
    </div>

    <div class="instruction-box">
      <strong>Quick Setup Guide:</strong> In your Remote Care Monitor desktop app, go to <strong>⚙ Settings</strong> &gt; <strong>☁ Server</strong> and enter:
      <br><strong>Server Base URL:</strong> <code>http://localhost:${port}</code> (or <code>${lanBaseUrl}</code> if connecting from Raspberry Pi or another machine on LAN).
      <br><strong>Headers Supported:</strong> <code>x-api-key: YOUR_KEY</code> or <code>Authorization: Bearer YOUR_KEY</code>.
      <br>Endpoints <code>/api/history</code> (or <code>/api/diagnostic/history</code>) and <code>/api/sync</code> (or <code>/api/diagnostic/sync</code>) automatically apply deduplication rules.
    </div>

    <!-- Grid 1: Controls & Status -->
    <div class="grid">
      <div class="card">
        <h3>Simulated Target Outage Control</h3>
        <p style="color: var(--muted); font-size: 13px;">Toggle the status of <code>/health</code> to test if Remote Care detects down events and sends desktop alerts or webhooks.</p>
        <div style="display: flex; gap: 10px; align-items: center; margin-top: 14px;">
          <form method="POST" action="/api/toggle-simulation" style="margin: 0;">
            <button type="submit" class="btn ${isSimulatingFailure ? 'btn-success' : 'btn-danger'}">
              ${isSimulatingFailure ? '✓ Recover Service (Return 200 OK)' : '⚠ Trigger Simulated Outage (Return 500)'}
            </button>
          </form>
          <span style="font-size: 13px; color: var(--muted);">Current <code>/health</code> status: <strong>${isSimulatingFailure ? '500 ERROR' : '200 HEALTHY'}</strong></span>
        </div>
      </div>

      <div class="card">
        <h3>Server & Ingest Status Summary</h3>
        <div class="meta-item">
          <span class="meta-label">Port / PID:</span>
          <span>Port ${port} (PID ${process.pid})</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Uptime:</span>
          <span>${Math.round(process.uptime())}s</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Heartbeats Ingested:</span>
          <strong style="color: var(--accent);">${receivedHeartbeats.length}</strong>
        </div>
        <div class="meta-item">
          <span class="meta-label">History Transitions Stored:</span>
          <strong style="color: var(--accent);">${receivedHistory.length}</strong>
        </div>
        <div class="meta-item">
          <span class="meta-label">Webhooks Received:</span>
          <strong style="color: var(--accent);">${receivedWebhooks.length}</strong>
        </div>
      </div>
    </div>

    <!-- URLs Table -->
    <div class="card" style="margin-bottom: 24px;">
      <h3>Available Server Endpoints</h3>
      <table class="url-table">
        <thead>
          <tr>
            <th>Purpose</th>
            <th>Method</th>
            <th>Path</th>
            <th>Local URL (Same PC)</th>
            <th>LAN URL (Multi-Machine)</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>☁ Server Tab</strong><br><small style="color:var(--muted)">Base URL (Auto-derives sync, history & health)</small></td>
            <td><span class="tag tag-get">BASE</span></td>
            <td><code>/</code></td>
            <td><code>http://localhost:${port}</code></td>
            <td><code>${lanBaseUrl}</code></td>
            <td><button class="copy-btn" onclick="navigator.clipboard.writeText('http://localhost:${port}')">Copy</button></td>
          </tr>
          <tr>
            <td><strong>☁ Server Tab</strong><br><small style="color:var(--muted)">Telemetry & Heartbeat Ingest (/api/sync or /api/diagnostic/sync)</small></td>
            <td><span class="tag tag-post">POST</span></td>
            <td><code>/api/sync</code></td>
            <td><code>http://localhost:${port}/api/sync</code></td>
            <td><code>${lanBaseUrl}/api/sync</code></td>
            <td><button class="copy-btn" onclick="navigator.clipboard.writeText('http://localhost:${port}/api/sync')">Copy</button></td>
          </tr>
          <tr>
            <td><strong>☁ Server Tab</strong><br><small style="color:var(--accent)">Result Changes History Ingest (/api/history or /api/diagnostic/history)</small></td>
            <td><span class="tag tag-post">POST</span></td>
            <td><code>/api/history</code></td>
            <td><code>http://localhost:${port}/api/history</code></td>
            <td><code>${lanBaseUrl}/api/history</code></td>
            <td><button class="copy-btn" onclick="navigator.clipboard.writeText('http://localhost:${port}/api/history')">Copy</button></td>
          </tr>
          <tr>
            <td><strong>☁ Server Tab</strong><br><small style="color:var(--muted)">Separate Health Check URL</small></td>
            <td><span class="tag tag-get">GET</span></td>
            <td><code>/health</code></td>
            <td><code>http://localhost:${port}/health</code></td>
            <td><code>${lanBaseUrl}/health</code></td>
            <td><a href="/health" target="_blank" style="color:#38bdf8;font-size:11px;text-decoration:none;">Test ↗</a></td>
          </tr>
          <tr>
            <td><strong>⚑ Webhooks Tab</strong><br><small style="color:var(--muted)">Alert Webhook Receiver</small></td>
            <td><span class="tag tag-post">POST</span></td>
            <td><code>/webhook</code></td>
            <td><code>http://localhost:${port}/webhook</code></td>
            <td><code>${lanBaseUrl}/webhook</code></td>
            <td><button class="copy-btn" onclick="navigator.clipboard.writeText('http://localhost:${port}/webhook')">Copy</button></td>
          </tr>
          <tr>
            <td><strong>◉ Monitors View</strong><br><small style="color:var(--muted)">Simulated Outage Target</small></td>
            <td><span class="tag tag-get">GET</span></td>
            <td><code>/health</code></td>
            <td><code>http://localhost:${port}/health</code></td>
            <td><code>${lanBaseUrl}/health</code></td>
            <td><a href="/health" target="_blank" style="color:#38bdf8;font-size:11px;text-decoration:none;">Test ↗</a></td>
          </tr>
          <tr>
            <td><strong>◉ Monitors View</strong><br><small style="color:var(--muted)">Permanent Failure Target (Always 500)</small></td>
            <td><span class="tag tag-get">GET</span></td>
            <td><code>/fail</code></td>
            <td><code>http://localhost:${port}/fail</code></td>
            <td><code>${lanBaseUrl}/fail</code></td>
            <td><a href="/fail" target="_blank" style="color:#ef4444;font-size:11px;text-decoration:none;">Fail ↗</a></td>
          </tr>
          <tr>
            <td><strong>◉ Monitors View</strong><br><small style="color:var(--muted)">Latency & Timeout Test Target</small></td>
            <td><span class="tag tag-get">GET</span></td>
            <td><code>/slow?delay=4000</code></td>
            <td><code>http://localhost:${port}/slow?delay=4000</code></td>
            <td><code>${lanBaseUrl}/slow?delay=4000</code></td>
            <td><a href="/slow?delay=4000" target="_blank" style="color:#f59e0b;font-size:11px;text-decoration:none;">Delay ↗</a></td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Grid 2: Telemetry & Live Data -->
    <div class="grid">
      <div class="card">
        <h3>Latest Client Heartbeat & Telemetry (JSON)</h3>
        ${latestHeartbeat ? `
          <div class="meta-item"><span class="meta-label">Hostname:</span> <strong>${latestHeartbeat.hostname || 'Unknown'}</strong></div>
          <div class="meta-item"><span class="meta-label">Platform:</span> <span>${latestHeartbeat.platform || '—'} (${latestHeartbeat.arch || '—'})</span></div>
          ${latestHeartbeat.cpuCores ? `<div class="meta-item"><span class="meta-label">CPU Cores:</span> <span>${latestHeartbeat.cpuCores}</span></div>` : ''}
          ${latestHeartbeat.memory ? `<div class="meta-item"><span class="meta-label">Memory:</span> <span>${latestHeartbeat.memory.usedPercent}% (${latestHeartbeat.memory.usedMb} MB / ${latestHeartbeat.memory.totalMb} MB)</span></div>` : ''}
          ${latestHeartbeat.monitorsSummary ? `<div class="meta-item"><span class="meta-label">Monitors:</span> <span>Healthy: ${latestHeartbeat.monitorsSummary.healthy} | Down: ${latestHeartbeat.monitorsSummary.down}</span></div>` : ''}
          ${latestHeartbeat.status ? `<div class="meta-item"><span class="meta-label">Status:</span> <span>${latestHeartbeat.status}</span></div>` : ''}
          <div class="meta-item"><span class="meta-label">Received At:</span> <span>${new Date(latestHeartbeat.receivedAt).toLocaleTimeString()}</span></div>
          <h4 style="color: var(--accent); margin: 12px 0 6px;">Raw Telemetry Payload:</h4>
          <pre>${JSON.stringify(latestHeartbeat, null, 2)}</pre>
        ` : '<p style="color: var(--muted);">No heartbeats received yet. In Remote Care, save the <strong>☁ Server</strong> configuration and click <strong>"Publish now"</strong>.</p>'}
      </div>

      <div class="card">
        <h3>History of Result Changes Ingest Log</h3>
        ${receivedHistory.length > 0 ? `
          <p style="color: var(--success); font-size: 13px; margin-bottom: 8px;">✓ ${receivedHistory.length} state transition(s) recorded from client</p>
          <div style="max-height: 250px; overflow-y: auto; margin-bottom: 12px; border: 1px solid var(--border); border-radius: 6px;">
            <table class="url-table" style="font-size: 12px;">
              <thead>
                <tr>
                  <th>Monitor</th>
                  <th>Status</th>
                  <th>Checked At</th>
                  <th>Latency</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                ${receivedHistory.slice(0, 15).map(h => `
                  <tr>
                    <td><strong>${h.targetName || '—'}</strong><br><small style="color:var(--muted)">${h.targetType || ''}</small></td>
                    <td><span class="tag ${h.ok ? 'tag-get' : 'tag-post'}">${h.status}</span></td>
                    <td><small>${new Date(h.checkedAt || h.receivedAt).toLocaleTimeString()}</small></td>
                    <td>${h.latencyMs !== null && h.latencyMs !== undefined ? `${h.latencyMs}ms` : '—'}</td>
                    <td><small>${h.message || ''}</small></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          <h4 style="color: var(--accent); margin-bottom: 6px;">Latest History Batch JSON:</h4>
          <pre>${JSON.stringify(receivedHistory.slice(0, 3), null, 2)}</pre>
        ` : '<p style="color: var(--muted);">No monitor result change history received yet. In Remote Care, configure History Sync in <strong>☁ Server</strong> tab and click <strong>"Sync History Now"</strong>.</p>'}

        <h3 style="margin-top: 18px;">Incoming Webhooks & Events Log</h3>
        ${receivedWebhooks.length > 0 ? `
          <h4 style="color: var(--accent); margin-bottom: 6px;">Latest Webhook Received:</h4>
          <pre>${JSON.stringify(receivedWebhooks[0], null, 2)}</pre>
        ` : '<p style="color: var(--muted);">No webhooks received yet. Use <strong>"Send Test Webhook"</strong> in the <strong>⚑ Webhooks</strong> tab.</p>'}
        
        ${receivedEvents.length > 0 ? `
          <h4 style="color: var(--accent); margin-top: 14px; margin-bottom: 6px;">Latest Sync Event Batch:</h4>
          <pre>${JSON.stringify(receivedEvents[0], null, 2)}</pre>
        ` : ''}
      </div>
    </div>
  </div>
</body>
</html>`;
}

function createTestServer({ port = PORT, authToken = AUTH_TOKEN } = {}) {
  let activePort = port;
  let isSimulatingFailure = false;
  let simulatedDelayMs = 0;
  const receivedHeartbeats = [];
  const receivedEvents = [];
  const receivedWebhooks = [];
  const receivedHistory = [];
  const targetStatusMap = new Map();
  const lastHeartbeatMetricsMap = new Map();

  const serverInstance = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method;

    const logPrefix = `[${new Date().toISOString()}] ${method} ${pathname}`;

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key'
      });
      return res.end();
    }

    // 1. Dashboard UI
    if (method === 'GET' && pathname === '/') {
      const html = renderHtmlDashboard({
        reqHost: req.headers.host,
        port: activePort,
        authToken,
        isSimulatingFailure,
        receivedHeartbeats,
        receivedEvents,
        receivedHistory,
        receivedWebhooks
      });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html)
      });
      return res.end(html);
    }

    // 2. Outage Simulation Toggle
    if (method === 'POST' && (pathname === '/api/toggle-simulation' || pathname === '/api/simulate')) {
      isSimulatingFailure = !isSimulatingFailure;
      console.log(`${logPrefix} -> Simulated failure toggled to: ${isSimulatingFailure}`);
      if (req.headers['content-type']?.includes('form')) {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      return sendJson(res, 200, { ok: true, isSimulatingFailure });
    }

    // 3. HTTP Target Monitor Health Check
    if (method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {
      if (isSimulatingFailure) {
        console.log(`${logPrefix} -> 500 (Simulated Outage)`);
        return sendJson(res, 500, { status: 'error', message: 'Simulated service failure' });
      }
      if (simulatedDelayMs > 0) {
        await new Promise(r => setTimeout(r, simulatedDelayMs));
      }
      return sendJson(res, 200, { status: 'healthy', uptime: process.uptime(), timestamp: new Date().toISOString() });
    }

    // 4. Force failure endpoint for negative testing
    if (method === 'GET' && pathname === '/fail') {
      console.log(`${logPrefix} -> 500 Force Failure`);
      return sendJson(res, 500, { status: 'error', error: 'Induced failure for testing' });
    }

    // 5. Slow response endpoint for testing latency & timeout
    if (method === 'GET' && pathname === '/slow') {
      const delay = Number.parseInt(url.searchParams.get('delay') || '4000', 10);
      console.log(`${logPrefix} -> Delaying response by ${delay}ms`);
      setTimeout(() => {
        sendJson(res, 200, { status: 'healthy', delayedMs: delay });
      }, delay);
      return;
    }

    // 6. Cloud Publisher / Telemetry Sync Receiver (POST /api/sync or /api/diagnostic/sync)
    if (method === 'POST' && (pathname === '/api/sync' || pathname === '/api/diagnostic/sync' || pathname === '/api/v1/sync' || pathname === '/events')) {
      if (authToken && !isAuthorized(req, authToken)) {
        console.log(`${logPrefix} -> 401 Unauthorized (Invalid or missing x-api-key / Bearer token)`);
        return sendJson(res, 401, { success: false, error: 'Unauthorized: Invalid API Key' });
      }

      try {
        const payload = await parseBody(req);
        const events = Array.isArray(payload.events) ? payload.events : [];
        console.log(`${logPrefix} -> Received Telemetry Sync Batch: ${events.length} event(s)`);

        let insertedCount = 0;
        let skippedCount = 0;

        for (const ev of events) {
          const item = {
            id: ev.id,
            eventType: ev.eventType,
            payload: ev.payload,
            createdAt: ev.createdAt,
            receivedAt: new Date().toISOString()
          };
          receivedEvents.unshift(item);
          if (receivedEvents.length > MAX_LOGS) receivedEvents.pop();

          // If it's a device telemetry heartbeat
          if (ev.eventType === 'device.heartbeat' && ev.payload) {
            const hb = ev.payload;
            const hostname = hb.hostname || 'default';
            // Extract memory/storage metrics
            const memUsedPercent = hb.memory?.usedPercent ?? null;
            const memUsedMb = hb.memory?.usedMb ?? null;
            const storageUsedPercent = hb.storage?.usedPercent ?? hb.disk?.usedPercent ?? null;

            // Deduplication Rule: Extracts memory/storage metrics. Saves to DB only when storage levels change
            // or cross warning thresholds (usedPercent >= 85%), skipping identical repeated heartbeats.
            const isWarning = (memUsedPercent !== null && memUsedPercent >= 85) ||
                              (storageUsedPercent !== null && storageUsedPercent >= 85);
            const prev = lastHeartbeatMetricsMap.get(hostname);
            const levelsChanged = !prev ||
              prev.memUsedPercent !== memUsedPercent ||
              prev.storageUsedPercent !== storageUsedPercent ||
              (prev.memUsedMb !== null && memUsedMb !== null && Math.abs(prev.memUsedMb - memUsedMb) >= 1);

            if (isWarning || levelsChanged) {
              insertedCount++;
              lastHeartbeatMetricsMap.set(hostname, { memUsedPercent, memUsedMb, storageUsedPercent });
              receivedHeartbeats.unshift({ ...hb, receivedAt: new Date().toISOString() });
              if (receivedHeartbeats.length > MAX_LOGS) receivedHeartbeats.pop();
              console.log(`   [Heartbeat Saved] Host: ${hb.hostname} | Memory: ${memUsedPercent}% | Warning: ${isWarning}`);
            } else {
              skippedCount++;
              console.log(`   [Heartbeat Skipped - Duplicate] Host: ${hb.hostname} | Identical metrics (Memory: ${memUsedPercent}%)`);
            }
          } else {
            insertedCount++;
            console.log(`   [Event] Type: ${ev.eventType}`);
          }
        }

        return sendJson(res, 200, {
          success: true,
          ok: true,
          message: 'Ingestion processed successfully.',
          inserted_count: insertedCount,
          skipped_count: skippedCount,
          total_processed: events.length,
          received: events.length,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error(`${logPrefix} -> Error parsing sync body:`, err.message);
        return sendJson(res, 400, { success: false, error: err.message });
      }
    }

    // 7. Result Changes History Sync Receiver (POST /api/history or /api/diagnostic/history)
    if (method === 'POST' && (pathname === '/api/history' || pathname === '/api/diagnostic/history' || pathname === '/api/v1/history')) {
      if (authToken && !isAuthorized(req, authToken)) {
        console.log(`${logPrefix} -> 401 Unauthorized (Invalid or missing x-api-key / Bearer token)`);
        return sendJson(res, 401, { success: false, error: 'Unauthorized: Invalid API Key' });
      }

      try {
        const payload = await parseBody(req);
        const historyList = Array.isArray(payload.history) ? payload.history : [];
        console.log(`${logPrefix} -> Received History Sync Batch: ${historyList.length} change(s) from ${payload.clientHostname || 'client'}`);

        // Deduplication Rule: Automatically skips saving duplicate records if the status remains
        // continuously identical. Saves to DB only on state changes or initial entry.
        let insertedCount = 0;
        let skippedCount = 0;

        for (const item of historyList) {
          const clientHost = payload.clientHostname || 'default';
          const targetKey = `${clientHost}:${item.targetId ?? item.targetName}`;
          const prevStatus = targetStatusMap.get(targetKey);
          const isDuplicate = prevStatus !== undefined && prevStatus === item.status;

          if (isDuplicate) {
            skippedCount++;
            console.log(`   [History Skipped - Duplicate Status] ${item.targetName || 'Monitor #' + item.targetId} continuously identical status "${item.status}"`);
          } else {
            insertedCount++;
            targetStatusMap.set(targetKey, item.status);
            const record = {
              ...item,
              receivedAt: new Date().toISOString()
            };
            receivedHistory.unshift(record);
            if (receivedHistory.length > MAX_LOGS) receivedHistory.pop();
            console.log(`   [History Saved - ${prevStatus === undefined ? 'Initial' : 'Transition'}] ${item.targetName || 'Monitor #' + item.targetId} -> ${item.status?.toUpperCase()} (${item.latencyMs !== null && item.latencyMs !== undefined ? item.latencyMs + 'ms' : '—'}) [${item.message || ''}]`);
          }
        }

        return sendJson(res, 200, {
          success: true,
          ok: true,
          message: 'Ingestion processed successfully.',
          inserted_count: insertedCount,
          skipped_count: skippedCount,
          total_processed: historyList.length,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error(`${logPrefix} -> Error parsing history body:`, err.message);
        return sendJson(res, 400, { success: false, error: err.message });
      }
    }

    // 8. Webhook Receiver
    if (method === 'POST' && (pathname === '/webhook' || pathname === '/api/webhook')) {
      try {
        const payload = await parseBody(req);
        const webhookEntry = {
          receivedAt: new Date().toISOString(),
          payload
        };
        receivedWebhooks.unshift(webhookEntry);
        if (receivedWebhooks.length > MAX_LOGS) receivedWebhooks.pop();

        console.log(`${logPrefix} -> Received Webhook Alert:`);
        console.log('   ', JSON.stringify(payload));
        return sendJson(res, 200, { ok: true, status: 'webhook received' });
      } catch (err) {
        console.error(`${logPrefix} -> Error parsing webhook body:`, err.message);
        return sendJson(res, 400, { error: err.message });
      }
    }

    // 9. Query received data via API
    if (method === 'GET' && pathname === '/api/data') {
      return sendJson(res, 200, {
        isSimulatingFailure,
        heartbeats: receivedHeartbeats,
        events: receivedEvents,
        history: receivedHistory,
        webhooks: receivedWebhooks
      });
    }

    // 404 Fallback
    sendJson(res, 404, { error: 'Not found', pathname });
  });

  serverInstance.on('listening', () => {
    const address = serverInstance.address();
    if (address && typeof address === 'object') activePort = address.port;
  });

  return {
    server: serverInstance,
    get port() { return activePort; },
    targetStatusMap,
    lastHeartbeatMetricsMap,
    receivedHeartbeats,
    receivedEvents,
    receivedHistory,
    receivedWebhooks,
    setSimulatingFailure: (val) => { isSimulatingFailure = val; },
    setSimulatedDelay: (ms) => { simulatedDelayMs = ms; }
  };
}

const defaultApp = createTestServer({ port: PORT, authToken: AUTH_TOKEN });
const server = defaultApp.server;

if (require.main === module) {
  listenWithFallback(server, { port: PORT, fallbackPort: FALLBACK_PORT }).then(({ port, requestedPort, fallbackPort, attemptedPorts, usedFallback }) => {
    const localIps = getLocalIps();
    const lanIp = localIps[0]?.address || '127.0.0.1';

    console.log('================================================================');
    console.log('  Remote Care Monitor — Test Remote Server v2.0');
    console.log('================================================================');
    if (usedFallback) {
      const fallbackDescription = fallbackPort === 0 ? 'an operating-system-selected free port' : `fallback port ${port}`;
      console.warn(`  Requested port ${requestedPort} is unavailable; using ${fallbackDescription}.`);
      console.warn(`  Ports checked: ${attemptedPorts.join(', ')}`);
    }
    console.log(`  Local Web Dashboard: http://localhost:${port}/`);
    console.log(`  LAN Web Dashboard:   http://${lanIp}:${port}/`);
    console.log(`  Auth Token:          ${AUTH_TOKEN ? AUTH_TOKEN : 'None (Open)'}`);
    console.log('----------------------------------------------------------------');
    console.log('  CLIENT CONFIGURATION GUIDE:');
    console.log('  1. "☁ Server" Tab:');
    console.log(`     - Server Base URL:      http://localhost:${port}`);
    console.log(`       (For other machines:  http://${lanIp}:${port})`);
    console.log(`     - Derived Sync URL:     http://localhost:${port}/api/sync`);
    console.log(`     - Diagnostic Sync URL:  http://localhost:${port}/api/diagnostic/sync`);
    console.log(`     - Derived History URL:  http://localhost:${port}/api/history`);
    console.log(`     - Diagnostic Hist URL:  http://localhost:${port}/api/diagnostic/history`);
    console.log(`     - Health Check URL:     http://localhost:${port}/health`);
    console.log('  2. "⚑ Webhooks" Tab:');
    console.log(`     - Webhook URL:          http://localhost:${port}/webhook`);
    console.log(`       (For other machines:  http://${lanIp}:${port}/webhook)`);
    console.log('  3. "◉ Monitors" Tab:');
    console.log(`     - Health Target URL:    http://localhost:${port}/health`);
    console.log(`     - Fail Target URL:      http://localhost:${port}/fail`);
    console.log(`     - Slow Target URL:      http://localhost:${port}/slow?delay=4000`);
    console.log('================================================================');
  }).catch((error) => {
    console.error(`Unable to start the test remote server: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  createServer: createTestServer,
  createTestServer,
  listenWithFallback,
  portCandidates,
  server,
  isAuthorized
};
