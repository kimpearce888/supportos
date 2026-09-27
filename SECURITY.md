# Security Policy

## Reporting a vulnerability

Please open a **private security advisory** (GitHub → Security → Report a vulnerability) or email the repo owner via the contact on their GitHub profile. Please do not open public issues for suspected vulnerabilities.

## Security model (summary)

- **Local-first:** the server binds to `127.0.0.1` by default and warns loudly before binding elsewhere; CORS is localhost-only.
- **Secrets:** OAuth tokens live server-side in SQLite and are never exposed to the browser; `.env` is git-ignored; no credentials are hard-coded.
- **Redaction:** payment data, tokens, and API keys are scrubbed from logs and AI prompts (`src/server/security/redaction.ts`).
- **Untrusted HTML:** Help Scout thread HTML is sanitized before render — no scripts, no event handlers, no `javascript:` URLs (`src/server/security/sanitize.ts`).
- **Webhooks:** HMAC-SHA1 timing-safe signature verification, persist-first processing, hash deduplication.
- **Write safety:** every remote mutation is validated, authorized, merged against a fresh read, confirmed, persisted, and audited; duplicate replies are blocked by idempotency keys.
- **AI safety:** customer-facing drafts are evidence-backed and verified; automatic sending is permanently OFF; internal-only knowledge never enters customer drafts.

See `docs/ARCHITECTURE.md` for the full model.

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | yes       |
