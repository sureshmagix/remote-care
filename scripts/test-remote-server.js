#!/usr/bin/env node
/**
 * Test Remote Server for Remote Care Monitor
 * 
 * Features:
 * - Zero external npm dependencies (uses native node:http)
 * - HTTP Target Check endpoint (/health, /fail, /slow)
 * - Remote Care Cloud Sync endpoint (/api/sync)
 * - Webhook Receiver endpoint (/webhook)
 * - Live Web Dashboard on / to view received telemetry and toggle simulated outages
 * 
 * Usage:
 *   PORT=3000 AUTH_TOKEN=secret123 node scripts/test-remote-server.js
 */

const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number.parseInt(process.env.PORT || process.argv[2] || 3000, 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

// In-memory state for testing
let isSimulatingFailure = false;
let simulatedDelayMs = 0;
const receivedHeartbeats = [];
const receivedEvents = [];
const receivedWebhooks = [];
const MAX_LOGS = 50;

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

function renderHtmlDashboard() {
  const latestHeartbeat = receivedHeartbeats[0] || null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Remote Care Test Server</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --success: #22c55e;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 24px;
      line-height: 1.5;
    }
    .container { max-width: 1000px; margin: 0 auto; }
    h1, h2, h3 { margin-top: 0; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
    .badge { padding: 4px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; display: inline-block; }
    .badge-ok { background: rgba(34, 197, 94, 0.2); color: var(--success); border: 1px solid var(--success); }
    .badge-fail { background: rgba(239, 68, 68, 0.2); color: var(--danger); border: 1px solid var(--danger); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 18px; }
    .btn { cursor: pointer; padding: 8px 16px; border-radius: 6px; font-weight: 600; border: none; transition: 0.2s; }
    .btn-danger { background: var(--danger); color: white; }
    .btn-success { background: var(--success); color: white; }
    .btn:hover { opacity: 0.9; }
    pre { background: #090d16; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; border: 1px solid var(--border); color: #cbd5e1; }
    code { font-family: monospace; }
    .endpoint-list { list-style: none; padding: 0; margin: 0; }
    .endpoint-list li { margin-bottom: 8px; font-family: monospace; font-size: 14px; background: #0f172a; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border); }
    .tag { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: bold; margin-right: 6px; }
    .tag-get { background: #0284c7; color: white; }
    .tag-post { background: #059669; color: white; }
    .meta-item { display: flex; justify-content: space-between; margin-bottom: 6px; border-bottom: 1px dashed var(--border); padding-bottom: 4px; }
    .meta-label { color: var(--muted); }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>Remote Care — Test Remote Server</h1>
        <div style="color: var(--muted); font-size: 14px;">Running on port <strong>${PORT}</strong> | Auth Token: <strong>${AUTH_TOKEN ? 'Enabled' : 'None (Open)'}</strong></div>
      </div>
      <div>
        <form method="POST" action="/api/toggle-simulation" style="display: inline;">
          <button type="submit" class="btn ${isSimulatingFailure ? 'btn-success' : 'btn-danger'}">
            ${isSimulatingFailure ? 'Restore Service (Make Healthy)' : 'Simulate Outage (Return 500 Error)'}
          </button>
        </form>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h3>Server Health Status</h3>
        <p>Current health test outcome for <code>/health</code>:</p>
        <div style="margin: 12px 0;">
          <span class="badge ${isSimulatingFailure ? 'badge-fail' : 'badge-ok'}">
            ${isSimulatingFailure ? 'SIMULATING OUTAGE (500 ERROR)' : 'HEALTHY (200 OK)'}
          </span>
        </div>
        <p style="color: var(--muted); font-size: 13px;">
          Use the button above to simulate a service outage or recovery and watch Remote Care trigger desktop alerts.
        </p>
      </div>

      <div class="card">
        <h3>Endpoints for Remote Care Config</h3>
        <ul class="endpoint-list">
          <li><span class="tag tag-get">GET</span><code>/health</code> — Target HTTP monitor</li>
          <li><span class="tag tag-get">GET</span><code>/fail</code> — Guaranteed 500 failure</li>
          <li><span class="tag tag-get">GET</span><code>/slow</code> — Delayed response test</li>
          <li><span class="tag tag-post">POST</span><code>/api/sync</code> — Cloud Sync URL</li>
          <li><span class="tag tag-post">POST</span><code>/webhook</code> — Webhook Alerts URL</li>
        </ul>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h3>Latest Device Telemetry (Heartbeat)</h3>
        ${latestHeartbeat ? `
          <div class="meta-item"><span class="meta-label">Hostname:</span> <strong>${latestHeartbeat.hostname || 'Unknown'}</strong></div>
          <div class="meta-item"><span class="meta-label">Platform / Arch:</span> <span>${latestHeartbeat.platform} (${latestHeartbeat.arch})</span></div>
          <div class="meta-item"><span class="meta-label">CPU Cores:</span> <span>${latestHeartbeat.cpuCores}</span></div>
          <div class="meta-item"><span class="meta-label">Memory Used:</span> <span>${latestHeartbeat.memory?.usedPercent ?? 0}% (${latestHeartbeat.memory?.usedMb} MB / ${latestHeartbeat.memory?.totalMb} MB)</span></div>
          <div class="meta-item"><span class="meta-label">Monitors:</span> <span>Healthy: ${latestHeartbeat.monitorsSummary?.healthy ?? 0} | Down: ${latestHeartbeat.monitorsSummary?.down ?? 0}</span></div>
          <div class="meta-item"><span class="meta-label">Received At:</span> <span>${new Date(latestHeartbeat.receivedAt).toLocaleTimeString()}</span></div>
        ` : '<p style="color: var(--muted);">No heartbeats received yet. Configure Cloud Sync in Remote Care to send heartbeats.</p>'}
      </div>

      <div class="card">
        <h3>Sync & Webhook Counts</h3>
        <div class="meta-item"><span class="meta-label">Received Sync Events:</span> <strong>${receivedEvents.length}</strong></div>
        <div class="meta-item"><span class="meta-label">Received Heartbeats:</span> <strong>${receivedHeartbeats.length}</strong></div>
        <div class="meta-item"><span class="meta-label">Received Webhooks:</span> <strong>${receivedWebhooks.length}</strong></div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 24px;">
      <h3>Recent Events & Alerts Received</h3>
      ${receivedEvents.length === 0 && receivedWebhooks.length === 0 ? '<p style="color: var(--muted);">Waiting for sync events or webhooks from Remote Care...</p>' : ''}
      ${receivedWebhooks.length > 0 ? `
        <h4 style="color: var(--accent); margin-bottom: 6px;">Webhooks:</h4>
        <pre>${JSON.stringify(receivedWebhooks.slice(0, 5), null, 2)}</pre>
      ` : ''}
      ${receivedEvents.length > 0 ? `
        <h4 style="color: var(--accent); margin-bottom: 6px;">Cloud Sync Events:</h4>
        <pre>${JSON.stringify(receivedEvents.slice(0, 5), null, 2)}</pre>
      ` : ''}
    </div>
  </div>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method;

  // Logging
  const logPrefix = `[${new Date().toISOString()}] ${method} ${pathname}`;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  // 1. Dashboard UI
  if (method === 'GET' && pathname === '/') {
    const html = renderHtmlDashboard();
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
    // If coming from form submit, redirect back to /
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

  // 6. Cloud Publisher Sync Receiver
  if (method === 'POST' && (pathname === '/api/sync' || pathname === '/api/v1/sync' || pathname === '/events')) {
    // Check Authorization header if token configured
    if (AUTH_TOKEN) {
      const authHeader = req.headers['authorization'] || '';
      const expected = `Bearer ${AUTH_TOKEN}`;
      if (authHeader !== expected) {
        console.log(`${logPrefix} -> 401 Unauthorized (Invalid or missing Bearer token)`);
        return sendJson(res, 401, { error: 'Unauthorized: invalid bearer token' });
      }
    }

    try {
      const payload = await parseBody(req);
      const events = Array.isArray(payload.events) ? payload.events : [];
      console.log(`${logPrefix} -> Received Cloud Sync Batch: ${events.length} event(s)`);

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
          receivedHeartbeats.unshift({ ...ev.payload, receivedAt: new Date().toISOString() });
          if (receivedHeartbeats.length > MAX_LOGS) receivedHeartbeats.pop();
          console.log(`   [Heartbeat] Host: ${ev.payload.hostname} | Memory: ${ev.payload.memory?.usedPercent}% | Monitors: Healthy ${ev.payload.monitorsSummary?.healthy || 0}`);
        } else {
          console.log(`   [Event] Type: ${ev.eventType}`);
        }
      }

      return sendJson(res, 200, { ok: true, received: events.length, timestamp: new Date().toISOString() });
    } catch (err) {
      console.error(`${logPrefix} -> Error parsing sync body:`, err.message);
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 7. Webhook Receiver
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

  // 8. Query received data via API
  if (method === 'GET' && pathname === '/api/data') {
    return sendJson(res, 200, {
      isSimulatingFailure,
      heartbeats: receivedHeartbeats,
      events: receivedEvents,
      webhooks: receivedWebhooks
    });
  }

  // 404 Fallback
  sendJson(res, 404, { error: 'Not found', pathname });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('====================================================');
  console.log(`  Remote Care Monitor — Test Remote Server`);
  console.log(`  Listening on: http://0.0.0.0:${PORT}`);
  console.log(`  Web Dashboard: http://localhost:${PORT}/`);
  if (AUTH_TOKEN) {
    console.log(`  Cloud Sync Auth Token: ${AUTH_TOKEN}`);
  } else {
    console.log(`  Cloud Sync Auth Token: None (Open)`);
  }
  console.log('====================================================');
  console.log('Available Endpoints:');
  console.log(`  GET  /health           -> 200 OK (or 500 when toggled)`);
  console.log(`  GET  /fail             -> 500 Error (Negative test)`);
  console.log(`  GET  /slow?delay=4000  -> Delayed response test`);
  console.log(`  POST /api/sync         -> Cloud Publisher target`);
  console.log(`  POST /webhook          -> Webhook Alerts receiver`);
  console.log('====================================================');
});
