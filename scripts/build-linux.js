const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const linuxPrebuild = path.join(rootDir, 'prebuilds', 'linux-x64', 'better_sqlite3.node');
const macPrebuild = path.join(rootDir, 'prebuilds', 'darwin-x64', 'better_sqlite3.node');
const activeReleaseNode = path.join(rootDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

if (!fs.existsSync(linuxPrebuild)) {
  console.error(`[build-linux] Missing Linux prebuild binary at: ${linuxPrebuild}`);
  process.exit(1);
}

console.log('[build-linux] Preparing native better-sqlite3 Linux x64 binary for electron-builder...');

// 1. Ensure mac backup exists
if (fs.existsSync(activeReleaseNode) && !fs.existsSync(macPrebuild)) {
  fs.mkdirSync(path.dirname(macPrebuild), { recursive: true });
  fs.copyFileSync(activeReleaseNode, macPrebuild);
}

try {
  // 2. Stage Linux binary into node_modules so electron-builder picks it up
  fs.copyFileSync(linuxPrebuild, activeReleaseNode);
  console.log('[build-linux] Staged linux-x64 better_sqlite3.node into node_modules/better-sqlite3/build/Release');

  // 3. Run electron-builder --linux
  const extraArgs = process.argv.slice(2);
  const builderArgs = extraArgs.includes('--linux') ? extraArgs.slice() : ['--linux', ...extraArgs];
  const electronDist = path.join(rootDir, '.cache', 'electron-linux-x64');
  if (fs.existsSync(electronDist) && !builderArgs.some((arg) => arg.includes('electronDist'))) {
    builderArgs.push(`--config.electronDist=${electronDist}`);
  }
  console.log(`[build-linux] Running: npx electron-builder ${builderArgs.join(' ')}`);

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
    path.join(rootDir, 'release', 'linux-unpacked', 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    path.join(rootDir, 'release', 'linux-unpacked', 'resources', 'app.asar.unpacked', 'prebuilds', 'linux-x64', 'better_sqlite3.node')
  ];

  for (const unpackedNode of unpackedNodePaths) {
    if (fs.existsSync(path.dirname(unpackedNode))) {
      fs.copyFileSync(linuxPrebuild, unpackedNode);
      console.log(`[build-linux] Verified linux-x64 binary in unpacked output: ${unpackedNode}`);
    }
  }

  console.log('[build-linux] Linux Ubuntu build completed successfully!');
} finally {
  // 5. Restore macOS host binary
  if (fs.existsSync(macPrebuild)) {
    fs.copyFileSync(macPrebuild, activeReleaseNode);
    console.log('[build-linux] Restored macOS better_sqlite3.node to node_modules/better-sqlite3/build/Release');
  }
}
