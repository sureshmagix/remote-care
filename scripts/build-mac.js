const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const macX64Prebuild = path.join(rootDir, 'prebuilds', 'darwin-x64', 'better_sqlite3.node');
const macArm64Prebuild = path.join(rootDir, 'prebuilds', 'darwin-arm64', 'better_sqlite3.node');
const activeReleaseNode = path.join(rootDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

// Ensure darwin-x64 backup exists
if (fs.existsSync(activeReleaseNode) && !fs.existsSync(macX64Prebuild)) {
  fs.mkdirSync(path.dirname(macX64Prebuild), { recursive: true });
  fs.copyFileSync(activeReleaseNode, macX64Prebuild);
}

const extraArgs = process.argv.slice(2);
const wantX64 = extraArgs.includes('--x64') || (!extraArgs.includes('--x64') && !extraArgs.includes('--arm64'));
const wantArm64 = extraArgs.includes('--arm64') || (!extraArgs.includes('--x64') && !extraArgs.includes('--arm64'));
const passthroughArgs = extraArgs.filter((arg) => arg !== '--x64' && arg !== '--arm64' && arg !== '--mac');

function buildForArch(arch, prebuildPath) {
  if (!fs.existsSync(prebuildPath)) {
    console.error(`[build-mac] Missing macOS ${arch} prebuild binary at: ${prebuildPath}`);
    process.exit(1);
  }

  console.log(`[build-mac] Staging darwin-${arch} better_sqlite3.node into node_modules/better-sqlite3/build/Release...`);
  fs.copyFileSync(prebuildPath, activeReleaseNode);

  const builderArgs = ['--mac', `--${arch}`, ...passthroughArgs];
  const electronDist = path.join(rootDir, '.cache', `electron-darwin-${arch}`);
  if (fs.existsSync(electronDist) && !builderArgs.some((arg) => arg.includes('electronDist'))) {
    builderArgs.push(`--config.electronDist=${electronDist}`);
  }

  console.log(`[build-mac] Running: npx electron-builder ${builderArgs.join(' ')}`);
  const builderRes = spawnSync('npx', ['electron-builder', ...builderArgs], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_build_from_source: 'false', CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  });

  if (builderRes.error) throw builderRes.error;
  if (builderRes.status !== 0) {
    throw new Error(`electron-builder (--mac --${arch}) exited with code ${builderRes.status}`);
  }

  const appBundleDir = arch === 'arm64'
    ? path.join(rootDir, 'release', 'mac-arm64', 'Remote Care Monitor.app')
    : path.join(rootDir, 'release', 'mac', 'Remote Care Monitor.app');

  const unpackedNode = path.join(
    appBundleDir,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node'
  );

  if (fs.existsSync(path.dirname(unpackedNode))) {
    fs.copyFileSync(prebuildPath, unpackedNode);
    console.log(`[build-mac] Verified darwin-${arch} binary in unpacked app bundle: ${unpackedNode}`);
  }

  console.log(`[build-mac] macOS (${arch}) build completed successfully!`);
}

try {
  if (wantX64) {
    buildForArch('x64', macX64Prebuild);
  }
  if (wantArm64) {
    buildForArch('arm64', macArm64Prebuild);
  }
} finally {
  if (fs.existsSync(macX64Prebuild)) {
    fs.copyFileSync(macX64Prebuild, activeReleaseNode);
    console.log('[build-mac] Restored host darwin-x64 better_sqlite3.node to node_modules/better-sqlite3/build/Release');
  }
}
