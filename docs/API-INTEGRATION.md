# Help Scout API Integration

All endpoint usage in SupportOS was **verified against the current official documentation** (developer.helpscout.com, Inbox API 2.0) at build time. The machine-readable matrix is served live at `GET /api/system/capabilities` (Settings → Capability matrix).

## Authentication (OAuth 2.0)

| Flow | Used for |
|---|---|
| **Client Credentials** (`POST /v2/oauth2/token`, `grant_type=client_credentials`) | Simplest for a personal/internal integration — one click in Settings |
| **Authorization Code** (`secure.helpscout.net/authentication/authorizeClientApplication` → `POST /v2/oauth2/token`) | Full browser flow for integrations used by other users |

- Tokens stored **server-side only** (SQLite `oauth_tokens`), never in frontend code; the browser never sees client secrets
- Access tokens expire after ~48h (`expires_in`); refresh is automatic on 401
- Disconnect/revoke available in Settings

## Read model — v3 (current)

| Operation | Endpoint | Notes |
|---|---|---|
| List conversations | `GET /v3/conversations` | Cursor pagination (25/page); filters `status` (incl. `all`), `inboxId`, `modifiedSince`, `number`, `embed=threads` for backfill |
| Get conversation | `GET /v3/conversations/{id}` | Returns **301 + Location** when merged — handled explicitly |
| List threads | `GET /v3/conversations/{id}/threads` | Returns real `system_user` types (AI agents) |
| List customers | `GET /v3/customers` | Cursor pagination; `modifiedSince` incremental |
| List system users | `GET /v3/system-users` | |

## Write model — v2 (documented operations)

| Operation | Endpoint | Semantics SupportOS applies |
|---|---|---|
| Create reply | `POST /v2/conversations/{id}/reply` | draft / status-after-send / assignTo / cc / bcc / base64 attachments |
| Create note | `POST /v2/conversations/{id}/notes` | |
| Update conversation | `PATCH /v2/conversations/{id}` (JSON Patch) | subject / status / assignTo (+`remove` to unassign) / mailboxId (move) / primaryCustomer.id / draft publish |
| Update tags | `PUT /v2/conversations/{id}/tags` | **replacement-style → SupportOS always fresh-reads + merges** (A,B + add C ⇒ A,B,C) |
| Update custom fields | `PUT /v2/conversations/{id}/fields` | full replacement; **system fields (Topics/Sentiment) preserved when omitted** (documented) — SupportOS merges fresh state |
| Snooze / unsnooze | `PUT` / `DELETE /v2/conversations/{id}/snooze` | |
| Schedule thread | `PUT` / `PATCH` (publish) / `DELETE` `.../threads/{tid}/schedule` | |
| Run workflow | `POST /v2/workflows/{id}/run` | Help Scout workflows — deliberately distinct from local SupportOS automation |

## Other verified endpoints

`GET /v2/mailboxes` (+ `/folders`, `/fields`, `/saved-replies`, `/routing`), `GET /v2/users`, `/v2/users/me`, `/v2/users/{id}/status`, `GET /v2/teams` (+ `/members`), `GET /v2/tags`, `GET /v2/customers/{id}`, `GET /v2/organizations`, `GET /v2/{customer|organization}-properties`, `GET /v2/ratings/{id}`, `GET /v2/webhooks`, `POST/DELETE /v2/webhooks`, `GET /v2/conversations/{id}/attachments/{aid}/data`, reports `GET /v2/reports/{company|conversations|happiness|productivity}`.

## Rate limiting

Help Scout rate limits per account (plan-dependent). SupportOS:

- routes **every** request through one priority API queue (P0 user reply → P1 interactive → P2 sync → P3 analytics → P4 indexing)
- tracks `X-RateLimit-Limit-Minute` / `X-RateLimit-Remaining-Minute` / `X-RateLimit-Retry-After`, counts writes double, applies a safety margin, and backs off automatically on 429
- never hammers: background sync is serialized and concurrency is configurable (Settings)

## Webhooks (optional)

Endpoint: `POST /api/webhooks/helpscout`

- Signature: `X-HelpScout-Signature` = **base64(HMAC-SHA1(raw body, secret))** — verified with a timing-safe comparison on the **raw** body
- Events are persisted first, acknowledged fast (200), processed **asynchronously**; duplicates are deduplicated by event hash; processing is idempotent
- Supported current V2 payload events: `convo.*` (created/updated/assigned/status/tags/custom-fields/moved/merged/deleted/customer reply/agent reply/note/AI answers), `customer.*`, `organization.*`, `satisfaction.ratings`, `tag.*`, `user.status.changed`
- **A localhost application cannot receive external webhooks directly** — you need a network-accessible relay (e.g. a tiny HTTPS forwarder) pointed at your local instance. Polling remains the primary sync mechanism either way; the app is fully functional with webhooks disabled.

## Error handling

All documented status codes are handled with friendly messages (400/401/403/404/409/412/413/415/423/429/500/503/504). Example: a 412 renders as *"Help Scout rejected this change because the conversation cannot currently accept another thread. No local changes were treated as successful."* — never a raw "HTTP 412". Correlation/log identifiers are preserved when present. Merged conversations (301 + Location) are stored with `merged_into_conversation_id` and historical references are kept.

## Known limitations (honest capability reporting)

- **Ratings list**: there is no documented polling endpoint that lists all satisfaction ratings; they primarily arrive via the `satisfaction.ratings` webhook. Demo mode provides seeded ratings so the feature is demonstrable; live mode imports them via webhook and conversation refreshes.
- **Chat API / Docs API / Beacon**: future extensions (see the Capability screen) — chat threads still appear through the conversation endpoints.
- Report imports cover the overall company/conversations/happiness/productivity endpoints; the many drill-down report endpoints are available via the provider for future use.
