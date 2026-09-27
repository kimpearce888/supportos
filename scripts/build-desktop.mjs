#!/usr/bin/env node
/**
 * build-desktop.mjs (v1.3.0): assembles everything the Tauri shell needs into
 * src-tauri/resources/ so `tauri build` can produce self-contained installers
 * (MSI/NSIS, DMG, AppImage) that run WITHOUT a system Node.js.
 *
 * Layout produced:
 *   src-tauri/resources/
 *     server/index.cjs                  <- esbuild bundle of the Fastify server
 *                                           (better-sqlite3 kept external)
 *     server/node_modules/better-sqlite3/  <- the one native dependency,
 *                                           resolved relative to the bundle at runtime
 *     client/                           <- copy of dist/client (served by Fastify)
 *     node-bin/node | node.exe          <- official Node runtime distribution
 *
 * Decision log (why this shape):
 * - esbuild single-file bundle instead of shipping node_modules wholesale:
 *   ~4MB of pure-JS deps collapse into one readable file; only the NATIVE module
 *   needs a real node_modules directory next to the bundle for require() resolution.
 * - Node SEA / pkg rejected for now: SEA does not support require()-ing native
 *   addons from disk, and pkg is unmaintained. A stock official Node binary is
 *   the most boring, most testable runtime.
 * - The same script runs in CI on all three OSes (tar extraction is universal;
 *   Windows bsdtar handles .zip).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCES = path.join(ROOT, 'src-tauri', 'resources');
/**
 * Default the bundled runtime to the Node version RUNNING this script. The
 * installed better-sqlite3 prebuilt binary targets that exact ABI, so the
 * packaged runtime must match it (locally AND on CI runners, where setup-node
 * + npm ci install the matching prebuild). Override with SUPPORTOS_NODE_VERSION.
 */
const NODE_VERSION = process.env.SUPPORTOS_NODE_VERSION || process.versions.node;

const argv = process.argv.slice(2);
const universal = argv.includes('--universal'); // macOS only: lipo both arches into one node binary
const skipNode = argv.includes('--skip-node');

function log(step, msg) {
  console.log(`[build-desktop] ${step}: ${msg}`);
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ---------------------------------------------------------------- 1. client
log('client', 'building dist/client (vite)');
// Run vite's bin with the current Node directly: no npm.cmd/shell quirks on Windows
// (Node >= 20 refuses .cmd without a shell), identical behavior on every OS.
execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
  cwd: ROOT,
  stdio: 'inherit'
});
rmrf(path.join(RESOURCES, 'client'));
copyDir(path.join(ROOT, 'dist', 'client'), path.join(RESOURCES, 'client'));
log('client', `copied ${fs.readdirSync(path.join(RESOURCES, 'client')).length} entries`);

// ---------------------------------------------------------------- 2. server bundle
log('server', 'bundling src/server/index.ts with esbuild (better-sqlite3 external)');
rmrf(path.join(RESOURCES, 'server'));
fs.mkdirSync(path.join(RESOURCES, 'server', 'node_modules'), { recursive: true });
const esbuild = await import('esbuild');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'server', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['better-sqlite3'],
  outfile: path.join(RESOURCES, 'server', 'index.cjs'),
  logLevel: 'warning'
});
const bundleSize = (fs.statSync(path.join(RESOURCES, 'server', 'index.cjs')).size / 1024 / 1024).toFixed(2);
log('server', `bundle written (${bundleSize} MB)`);

// ---------------------------------------------------------------- 3. native module
log('native', 'copying better-sqlite3 (the only external/native dependency) + its runtime deps');
// better-sqlite3 requires 'bindings' at runtime, and bindings requires
// 'file-uri-to-path' - they must sit next to it for require() resolution in
// the packaged app (prebuild-install is install-time only and is skipped).
for (const pkg of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
  const src = path.join(ROOT, 'node_modules', pkg);
  if (!fs.existsSync(src)) {
    console.error(`[build-desktop] FATAL: ${pkg} not found in node_modules - run npm ci first.`);
    process.exit(1);
  }
  copyDir(src, path.join(RESOURCES, 'server', 'node_modules', pkg));
}
const nativeBinding = path.join(RESOURCES, 'server', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(nativeBinding)) {
  console.error('[build-desktop] FATAL: better_sqlite3.node not found - run `npm ci` first so prebuilt binaries are installed.');
  process.exit(1);
}
log('native', `better_sqlite3.node present (${(fs.statSync(nativeBinding).size / 1024 / 1024).toFixed(2)} MB, ABI of Node ${NODE_VERSION})`);

// ---------------------------------------------------------------- 4. Node runtime
const platform = os.platform(); // darwin | win32 | linux
const arch = os.arch(); // arm64 | x64

function nodeDistUrl(platformName, archName) {
  const p = platformName === 'win32' ? 'win' : platformName === 'darwin' ? 'darwin' : 'linux';
  const a = archName === 'arm64' ? 'arm64' : 'x64';
  const ext = platformName === 'win32' ? 'zip' : platformName === 'darwin' ? 'tar.gz' : 'tar.xz';
  return `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${p}-${a}.${ext}`;
}

async function downloadNode(url, label) {
  const tmp = path.join(os.tmpdir(), `supportos-node-${Date.now()}-${label}`);
  fs.mkdirSync(tmp, { recursive: true });
  const file = path.join(tmp, path.basename(url));
  log('node-runtime', `downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  // Universal extraction: plain -xf auto-detects compression (GNU tar handles
  // .tar.xz/.tar.gz; Windows bsdtar handles .zip too). No platform branching.
  execFileSync('tar', ['-xf', file, '-C', tmp]);
  const extractedDir = fs.readdirSync(tmp).find((e) => e.startsWith(`node-v${NODE_VERSION}`));
  if (!extractedDir) throw new Error(`extraction produced no node dir in ${tmp}`);
  return path.join(tmp, extractedDir, 'bin', platform === 'win32' ? 'node.exe' : 'node');
}

async function fetchNodeRuntime() {
  fs.mkdirSync(path.join(RESOURCES, 'node-bin'), { recursive: true });
  rmrf(path.join(RESOURCES, 'node-bin', 'node'));
  rmrf(path.join(RESOURCES, 'node-bin', 'node.exe'));

  if (universal && platform === 'darwin') {
    const arm64 = await downloadNode(nodeDistUrl('darwin', 'arm64'), 'arm64');
    const x64 = await downloadNode(nodeDistUrl('darwin', 'x64'), 'x64');
    const out = path.join(RESOURCES, 'node-bin', 'node');
    execFileSync('lipo', ['-create', arm64, x64, '-output', out]);
    execFileSync('chmod', ['+x', out]);
    log('node-runtime', `universal darwin binary created (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
    return;
  }

  const bin = await downloadNode(nodeDistUrl(platform, arch), platform + '-' + arch);
  const dest = path.join(RESOURCES, 'node-bin', platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(bin, dest);
  if (platform !== 'win32') execFileSync('chmod', ['+x', dest]);
  log('node-runtime', `copied ${platform}/${arch} runtime (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
}

if (skipNode) {
  log('node-runtime', 'skipped (--skip-node): reusing any existing binary in resources/node-bin');
} else {
  await fetchNodeRuntime();
}

// ---------------------------------------------------------------- summary
const total = (() => {
  let bytes = 0;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else bytes += fs.statSync(full).size;
    }
  };
  walk(RESOURCES);
  return bytes;
})();
log('done', `resources assembled: ${(total / 1024 / 1024).toFixed(1)} MB at ${path.relative(ROOT, RESOURCES)}`);
log('done', 'next: npx tauri build (or npm run desktop:build)');
