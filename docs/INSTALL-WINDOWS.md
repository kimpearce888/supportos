# Installing on Windows

## 1. Prerequisites

- **Node.js ≥ 20** — https://nodejs.org (LTS, default options). Verify: `node --version`
- **Git** (optional, to clone) — https://git-scm.com
- Optional: **Docker Desktop** (for Qdrant), **LM Studio** (for local AI), **Rust** (only for the Tauri desktop build)

## 2. Get the code

Copy the repository to your machine (e.g. download the ZIP and extract, or `git clone <url>`), then open **PowerShell** in the project folder.

## 3. Install dependencies

```powershell
npm install
```

> If `better-sqlite3` needs to compile instead of using its prebuilt binary, install the "Desktop development with C++" workload from Visual Studio Build Tools first. On normal setups the prebuilt binary is used and nothing compiles.

## 4. Configure

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill in at minimum:

```
HELPSCOUT_CLIENT_ID=...        (from Help Scout > Your Profile > My Apps)
HELPSCOUT_CLIENT_SECRET=...
HELPSCOUT_REDIRECT_URI=http://localhost:3000/oauth/callback
LOCAL_DEMO_MODE=false          (keep true to explore with the simulated mailbox first)
```

## 5. Migrate + run

```powershell
npm run db:migrate
npm run build
npm run start
```

Open **http://127.0.0.1:3000**. The first-run wizard walks you through connecting Help Scout, the initial sync, and optional LM Studio/Qdrant setup.

Development mode (hot reload): `npm run dev` → http://localhost:5173

## 6. Optional: local Qdrant

```powershell
docker run -d --name supportos-qdrant -p 6333:6333 qdrant/qdrant
```

Then Settings → Qdrant → Test → Save.

## 7. Optional: LM Studio

Install from https://lmstudio.ai, download a chat model (e.g. a 7B instruct model) and optionally an embedding model, then **Developer → Start Server**. In SupportOS: Settings → LM Studio → `http://127.0.0.1:1234` → Test → pick models → Save.

## 8. Optional: Tauri desktop build

The web application is fully functional on its own; the Tauri shell is optional packaging. **Since v1.3.0 the easiest route is downloading the MSI from the [releases page](https://github.com/kimpearce888/supportos/releases) — it bundles the Node runtime, so nothing else is needed.**

```powershell
# one-time setup
winget install Rustlang.Rustup        # or https://rustup.rs

# build everything (client + server bundle + bundled Node runtime + installers)
npm ci
npm run desktop:build
# → installers under src-tauri\target\release\bundle\ (msi\ + nsis\)

# develop the desktop shell (talks to the Vite dev server)
npm run desktop:dev
```

Notes:

- `scripts/build-desktop.mjs` assembles `src-tauri/resources/` (esbuild server bundle, `better-sqlite3`, the built client and a stock official Node runtime downloaded from nodejs.org, version-matched to your Node so the native ABI fits)
- The shell launches the bundled Node backend as a sidecar process on a free port and stores data under `%APPDATA%\com.supportos.local`
- Missing Rust/native dependencies never break the normal web build (`npm run build` / `npm run start` work without them)
- Full walkthrough of the packaging design: [docs/DESKTOP.md](DESKTOP.md)

## Daily use

- Start: `npm run start` (or launch the installed desktop app)
- Stop: `Ctrl+C` — sync state is checkpointed; nothing to clean up
- Data: `.\data\supportos.db` + `.\data\attachments\`; backups in `.\backups\`
- Health: `npm run healthcheck` or the Sync Health screen
