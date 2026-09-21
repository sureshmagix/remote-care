const { spawnSync } = require('node:child_process');
const path = require('node:path');

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, { cwd: path.join(__dirname, '..'), stdio: 'inherit', env: environment });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run(process.execPath, ['--test', 'tests/auth.test.js', 'tests/checks.test.js', 'tests/notification-center.test.js']);

// better-sqlite3 is rebuilt for Electron during packaging. Run the database test
// inside Electron's Node runtime so it validates the exact native binary used by the app.
const electronBinary = require('electron');
run(electronBinary, ['--test', 'tests/database.test.js'], { ...process.env, ELECTRON_RUN_AS_NODE: '1' });
