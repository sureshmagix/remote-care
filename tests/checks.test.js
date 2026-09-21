const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { checkTcp, checkHttp, runCommand } = require('../src/main/checks');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('TCP monitor reports an accepting local port as healthy', async () => {
  const server = net.createServer();
  const port = await listen(server);
  try {
    const result = await checkTcp('127.0.0.1', port, 2_000);
    assert.equal(result.ok, true);
    assert.equal(result.details.port, port);
  } finally {
    await close(server);
  }
});

test('HTTP monitor accepts a local 204 health response', async () => {
  const server = http.createServer((_request, response) => { response.writeHead(204); response.end(); });
  const port = await listen(server);
  try {
    const result = await checkHttp(`http://127.0.0.1:${port}/health`, 2_000);
    assert.equal(result.ok, true);
    assert.equal(result.details.statusCode, 204);
  } finally {
    await close(server);
  }
});

test('command runner captures a successful local command', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("ready")'], 2_000);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ready');
});

test('system service check reports nonexistent service as down', async () => {
  const { checkSystemService } = require('../src/main/checks');
  const result = await checkSystemService('nonexistent_random_service_12345', 2_000);
  assert.equal(result.ok, false);
  assert.match(result.message, /not running/i);
});
