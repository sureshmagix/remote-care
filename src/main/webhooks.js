const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

function buildWebhookPayload(type, event) {
  const isDown = event.kind === 'down';
  const isWarning = event.kind === 'warning';
  const targetName = event.target?.name || 'Monitored Service';
  const locationName = event.target?.locationName || 'Local device';
  const message = event.body || event.message || `${targetName} transitioned to ${event.kind}`;
  const timestamp = event.occurredAt || new Date().toISOString();
  const title = event.title || `${isDown ? 'Critical Alert' : isWarning ? 'Warning' : 'Recovery'}: ${targetName}`;

  if (type === 'slack') {
    const color = isDown ? '#ef4444' : isWarning ? '#f59e0b' : '#10b981';
    return {
      text: `*[Remote Care Alert]* ${title}`,
      attachments: [{
        color,
        title,
        text: message,
        fields: [
          { title: 'Monitor', value: targetName, short: true },
          { title: 'Location', value: locationName, short: true },
          { title: 'Status', value: String(event.kind).toUpperCase(), short: true },
          { title: 'Severity', value: String(event.target?.severity || 'warning').toUpperCase(), short: true }
        ],
        ts: Math.floor(new Date(timestamp).getTime() / 1000)
      }]
    };
  }

  if (type === 'discord') {
    const color = isDown ? 15548997 : isWarning ? 16753920 : 1089307;
    return {
      content: `**[Remote Care Alert]** ${title}`,
      embeds: [{
        title,
        description: message,
        color,
        fields: [
          { name: 'Monitor', value: targetName, inline: true },
          { name: 'Location', value: locationName, inline: true },
          { name: 'Status', value: String(event.kind).toUpperCase(), inline: true }
        ],
        timestamp
      }]
    };
  }

  if (type === 'teams') {
    const themeColor = isDown ? 'ef4444' : isWarning ? 'f59e0b' : '10b981';
    return {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      summary: title,
      themeColor,
      title,
      sections: [{
        activityTitle: `Remote Care Monitor — ${locationName}`,
        activitySubtitle: new Date(timestamp).toLocaleString(),
        text: message,
        facts: [
          { name: 'Monitor:', value: targetName },
          { name: 'Location:', value: locationName },
          { name: 'Status:', value: String(event.kind).toUpperCase() }
        ]
      }]
    };
  }

  if (type === 'telegram') {
    return {
      text: `🔔 *Remote Care Alert*\n*${title}*\n\n📍 *Location:* ${locationName}\n🖥 *Monitor:* ${targetName}\n⚠️ *Status:* ${String(event.kind).toUpperCase()}\n\n_${message}_`,
      parse_mode: 'Markdown'
    };
  }

  // Default: generic JSON webhook
  return {
    source: 'remote-care-monitor',
    event: event.kind,
    title,
    message,
    target: {
      id: event.target?.id,
      name: targetName,
      locationName,
      type: event.target?.type,
      severity: event.target?.severity
    },
    occurredAt: timestamp
  };
}

function sendHttpRequest(targetUrl, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (err) {
      return reject(new Error(`Invalid webhook URL: ${err.message}`));
    }

    const data = JSON.stringify(payload);
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const req = transport.request(parsedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'RemoteCareMonitor-Webhook/2.0'
      },
      timeout: timeoutMs
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, statusCode: res.statusCode, body });
        } else {
          reject(new Error(`Webhook returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Webhook request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => {
      reject(new Error(`Webhook delivery failed: ${err.message}`));
    });

    req.write(data);
    req.end();
  });
}

async function dispatchWebhook({ webhookUrl, webhookType = 'generic', event, timeoutMs = 5000 }) {
  if (!webhookUrl || typeof webhookUrl !== 'string' || !webhookUrl.trim()) {
    return { ok: false, message: 'No webhook URL provided.' };
  }
  const payload = buildWebhookPayload(webhookType, event);
  return sendHttpRequest(webhookUrl.trim(), payload, timeoutMs);
}

module.exports = { dispatchWebhook, buildWebhookPayload };
