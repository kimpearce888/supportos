# Desktop packaging (MSI / DMG / AppImage)

SupportOS ships as real desktop installers with **no prerequisites**: the Node runtime, the built server, the native SQLite module and the built client are all bundled inside the package. This document explains what's inside, why it's built this way, and how to build your own.

## Download

Grab a ready-made installer from the [releases page](https://github.com/kimpearce888/supportos/releases):

| Platform | Artifact | Notes |
|---|---|---|
| Windows | `.msi` (WiX) + `.exe` (NSIS) | WebView2 bootstrapper embedded |
| macOS | `.dmg` | **Universal** — runs on Intel and Apple Silicon |
| Linux | `.AppImage` | Built on Ubuntu 22.04; needs a modern glibc |

Data lives in your user profile (`%APPDATA%\com.supportos.local` on Windows, `~/Library/Application Support/com.supportos.local` on macOS, `~/.local/share/com.supportos.local` on Linux). The macOS build is **not code-signed** (no Apple Developer certificate) — the first launch requires the usual right-click → Open, or `xattr -d com.apple.quarantine` on the app bundle.

## What's inside the package

```
SupportOS.app / SupportOS.exe
└── resources/
    ├── node-bin/node          ← official Node runtime (version-matched, see below)
    ├── server/index.cjs       ← esbuild bundle of the Fastify server (~15 MB)
    ├── server/node_modules/
    │   ├── better-sqlite3/    ← the ONE native dependency (SQLite, FTS5 enabled)
    │   ├── bindings/          └── its two runtime deps
    │   └── file-uri-to-path/
    └── client/                ← the built React app (served by Fastify)
```

The Tauri shell (`src-tauri/src/lib.rs`) does exactly four things: bind a free localhost port, spawn the bundled `node` against `server/index.cjs` with data-dir environment overrides, wait for `GET /health` to return 200, and open a webview window at `http://127.0.0.1:<port>`. On exit it kills the child process; a second launch focuses the existing window (single-instance plugin).

## Why this design (the decision log)

**esbuild bundle instead of shipping `node_modules` wholesale.** The server's pure-JavaScript dependencies collapse into one ~15 MB file that is readable and diffable. Only the native module needs a real `node_modules` directory next to the bundle, because `require('better-sqlite3')` resolves through the standard Node algorithm at runtime.

**A stock official Node binary instead of Node SEA / pkg.** Node's Single Executable Applications feature does not support `require()`-ing native addons from disk, and `pkg` is unmaintained. A stock Node runtime is boring — which is a feature: you can debug a packaged app with `node --inspect`, and the runtime behaves exactly like a normal Node install.

**The runtime version is matched to the build machine on purpose.** `better_sqlite3.node` is a native binary compiled for one exact Node ABI. `scripts/build-desktop.mjs` therefore defaults the bundled runtime to `process.versions.node` — the same Node that installed the native module during `npm ci` — so the ABI always matches. Override with `SUPPORTOS_NODE_VERSION` if you know what you're doing. On macOS, `--universal` downloads both architectures and `lipo`s them into a single universal binary; the Rust shell is built with `--target universal-apple-darwin`.

**Cross-platform builds happen in CI, not on your laptop.** A Windows MSI cannot be produced on Linux, and signing/quarantine behavior differs per OS. `.github/workflows/desktop-release.yml` runs the same assembly script on `windows-latest`, `macos-latest` and `ubuntu-22.04`, then hands off to `tauri-apps/tauri-action`, which attaches the installers to the release. The `resources/` directory is **assembled, never committed** (it's gitignored).

**Security posture is unchanged.** The packaged app is the same local-first Fastify server: it binds to `127.0.0.1` on a random free port, serves the SPA and the API to the embedded webview, and speaks to Help Scout only through the official API. No new network surface is opened by packaging.

## Build your own

Prerequisites: Node ≥ 20, npm, and Rust (`rustup.rs`) with the platform's Tauri dependencies (on Linux: `libwebkit2gtk-4.1-dev`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`).

```bash
npm ci
npm run desktop:build     # = node scripts/build-desktop.mjs + tauri build
```

Installers appear under `src-tauri/target/release/bundle/` (`msi/`, `nsis/`, `dmg/`, `appimage/`).

Useful variants:

```bash
npm run desktop:prepare              # assemble resources only (no Rust toolchain needed)
node scripts/build-desktop.mjs --skip-node   # reuse the previously downloaded runtime
node scripts/build-desktop.mjs --universal   # macOS: universal Node via lipo
npm run desktop:dev                  # tauri dev: talks to the Vite dev server, no sidecar
npm run desktop:icon                 # regenerate the icon set from scripts/make_icon.py
```

## Verifying a package by hand

The sidecar is a normal Node process, so you can boot it exactly like the shell does:

```bash
PORT=8791 \
DATABASE_PATH=/tmp/supportos-test.db \
ATTACHMENTS_PATH=/tmp/supportos-attachments \
BACKUPS_PATH=/tmp/supportos-backups \
SUPPORTOS_CLIENT_DIST=./src-tauri/resources/client \
LOCAL_DEMO_MODE=true \
./src-tauri/resources/node-bin/node ./src-tauri/resources/server/index.cjs

curl http://127.0.0.1:8791/health        # → {"status":"ok",...}
curl -N http://127.0.0.1:8791/api/events # → SSE hello frame
```

This is the same verification CI performs implicitly on every release: if health, the SPA, the docs API and the SSE stream respond on the bundled runtime, the package is sound.
