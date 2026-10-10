const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const winPrebuild = path.join(rootDir, 'prebuilds', 'win32-x64', 'better_sqlite3.node');
const macPrebuild = path.join(rootDir, 'prebuilds', 'darwin-x64', 'better_sqlite3.node');
const activeReleaseNode = path.join(rootDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

if (!fs.existsSync(winPrebuild)) {
  console.error(`[build-win] Missing Windows prebuild binary at: ${winPrebuild}`);
  process.exit(1);
}

console.log('[build-win] Preparing native better-sqlite3 Windows binary for electron-builder...');

// 1. Ensure mac backup exists
if (fs.existsSync(activeReleaseNode) && !fs.existsSync(macPrebuild)) {
  fs.mkdirSync(path.dirname(macPrebuild), { recursive: true });
  fs.copyFileSync(activeReleaseNode, macPrebuild);
}

try {
  // 2. Stage Windows binary into node_modules so electron-builder picks it up
  fs.copyFileSync(winPrebuild, activeReleaseNode);
  console.log('[build-win] Staged win32-x64 better_sqlite3.node into node_modules/better-sqlite3/build/Release');

  // 3. Run electron-builder --win
  const extraArgs = process.argv.slice(2);
  const builderArgs = extraArgs.includes('--win') ? extraArgs.slice() : ['--win', ...extraArgs];
  const electronDist = path.join(rootDir, '.cache', 'electron-win32-x64');
  if (fs.existsSync(electronDist) && !builderArgs.some((arg) => arg.includes('electronDist'))) {
    builderArgs.push(`--config.electronDist=${electronDist}`);
  }
  console.log(`[build-win] Running: npx electron-builder ${builderArgs.join(' ')}`);

  const builderRes = spawnSync('npx', ['electron-builder', ...builderArgs], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_build_from_source: 'false' }
  });

  if (builderRes.error) throw builderRes.error;
  if (builderRes.status !== 0) {
    throw new Error(`electron-builder exited with code ${builderRes.status}`);
  }

  // 4. Verify and fix unpacked output
  const unpackedNodePaths = [
    path.join(rootDir, 'release', 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    path.join(rootDir, 'release', 'win-unpacked', 'resources', 'app.asar.unpacked', 'prebuilds', 'win32-x64', 'better_sqlite3.node')
  ];

  for (const unpackedNode of unpackedNodePaths) {
    if (fs.existsSync(path.dirname(unpackedNode))) {
      fs.copyFileSync(winPrebuild, unpackedNode);
      console.log(`[build-win] Verified win32-x64 binary in unpacked output: ${unpackedNode}`);
    }
  }

  console.log('[build-win] Windows build completed successfully!');
} finally {
  // 5. Restore macOS host binary
  if (fs.existsSync(macPrebuild)) {
    fs.copyFileSync(macPrebuild, activeReleaseNode);
    console.log('[build-win] Restored macOS better_sqlite3.node to node_modules/better-sqlite3/build/Release');
  }
}
