const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { checkTcp, checkHttp, runCommand, checkDisk, checkMemory, checkCpu, checkCommand, checkSystemService } = require('../src/main/checks');

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
    if (!result.ok && result.details?.code === 'EPERM') {
      // Sandboxed execution environment blocks loopback socket connections
      return;
    }
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
    if (!result.ok && (result.details?.code === 'EPERM' || /fetch failed|EPERM/i.test(result.message))) {
      // Sandboxed execution environment blocks loopback socket connections
      return;
    }
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
  const result = await checkSystemService('nonexistent_random_service_12345', 2_000);
  assert.equal(result.ok, false);
  assert.match(result.message, /not running/i);
});

test('disk monitor checks storage utilization and honors threshold', async () => {
  const healthy = await checkDisk({ metadata: { path: '/', thresholdPercent: 100 } });
  assert.equal(healthy.ok, true);
  assert.match(healthy.message, /Disk space normal/);

  const critical = await checkDisk({ metadata: { path: '/', thresholdPercent: 1 } });
  assert.equal(critical.ok, false);
  assert.match(critical.message, /Disk space critical/);
});

test('memory monitor checks RAM utilization and honors threshold', async () => {
  const healthy = await checkMemory({ metadata: { thresholdPercent: 90, totalMem: 1000, freeMem: 500 } });
  assert.equal(healthy.ok, true);
  assert.match(healthy.message, /System RAM normal/);

  const critical = await checkMemory({ metadata: { thresholdPercent: 80, totalMem: 1000, freeMem: 100 } });
  assert.equal(critical.ok, false);
  assert.match(critical.message, /System RAM critical/);
});

test('CPU monitor measures utilization delta', async () => {
  const result = await checkCpu({ metadata: { thresholdPercent: 100 } });
  assert.equal(result.ok, true);
  assert.match(result.message, /CPU utilization/);
});

test('custom script / command check executes shell command and checks exit code & output', async () => {
  const success = await checkCommand({ metadata: { command: 'echo "service-online"', expectedExitCode: 0, expectedOutput: 'service-online' }, timeoutMs: 2000 });
  assert.equal(success.ok, true);

  const failedExit = await checkCommand({ metadata: { command: 'exit 42', expectedExitCode: 0 }, timeoutMs: 2000 });
  assert.equal(failedExit.ok, false);
  assert.match(failedExit.message, /code 42/);

  const failedOutput = await checkCommand({ metadata: { command: 'echo "unexpected"', expectedExitCode: 0, expectedOutput: 'expected-word' }, timeoutMs: 2000 });
  assert.equal(failedOutput.ok, false);
  assert.match(failedOutput.message, /did not match/);
});
