#!/usr/bin/env node
/* Create the v1.9.0 GitHub release + upload the source zip via the REST API.
 * Token comes from the SUPPORTOS_GH_TOKEN env var (or is derived from the
 * git remote used by previous releases in this workspace). */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const REPO = 'kimpearce888/supportos';
const TAG = 'v1.9.0';
const ZIP = '/tmp/supportos-v1.9.0-source.zip';
const NOTES = new URL('./release-notes-v190.md', import.meta.url).pathname;

let token = process.env.SUPPORTOS_GH_TOKEN || process.env.GH_TOKEN;
if (!token) {
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    const m = remote.match(/https:\/\/[^:]+:([^@]+)@github\.com/);
    if (m) token = m[1];
  } catch { /* ignore */ }
}
if (!token) {
  console.error('No token: set SUPPORTOS_GH_TOKEN');
  process.exit(1);
}

const notes = fs.readFileSync(NOTES, 'utf8');

async function main() {
  // 1. create (or get) the release
  let release;
  const createRes = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ tag_name: TAG, name: 'v1.9.0 — The Intelligence Release: Local Copilot, AI Attributes, AI Escalation Rules', body: notes, draft: false, prerelease: false })
  });
  if (createRes.status === 201) {
    release = await createRes.json();
    console.log('release created:', release.id);
  } else {
    const text = await createRes.text();
    console.log('create status:', createRes.status, text.slice(0, 300));
    const getRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
    if (!getRes.ok) throw new Error(`could not get release: ${getRes.status}`);
    release = await getRes.json();
    console.log('existing release:', release.id);
  }

  // 2. upload the asset (skip if it already exists)
  const existing = (release.assets ?? []).find((a) => a.name === 'supportos-v1.9.0-source.zip');
  if (existing) {
    console.log('asset already uploaded:', existing.browser_download_url);
    console.log('RELEASE_URL:', release.html_url);
    return;
  }
  const size = fs.statSync(ZIP).size;
  const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent('supportos-v1.9.0-source.zip')}`;
  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip', 'Content-Length': String(size) },
    body: fs.readFileSync(ZIP)
  });
  if (!upRes.ok) throw new Error(`asset upload failed: ${upRes.status} ${await upRes.text()}`);
  const asset = await upRes.json();
  console.log('asset uploaded:', asset.name, asset.size, 'bytes ->', asset.browser_download_url);
  console.log('RELEASE_URL:', release.html_url);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
