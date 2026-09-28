# v2.2.1 — The Polish Release: Full-Project Audit, 45 Fixes, Zero New Features

After the roadmap completed at v2.2.0, a **completely fresh, independent audit** re-examined the entire project from a neutral standpoint: four parallel adversarial passes (backend, frontend, consistency/docs, security) that deliberately did not trust the existing test suite, every finding verified and root-caused before a line was changed, plus a human-like browser pass on the real database. It found **45 confirmed defects in existing functionality**. This release fixes all of them — and adds no features and removes none.

## 🔬 Data correctness

- **Report builder `organizations` metric threw on every run** — the SQL referenced a nonexistent `conversations.organization_id` column; resolved through the conversation's customer now.
- **Sample conversations on grouped reports were always empty** — the sample query bound display labels against id group keys (`c.mailbox_local_id = 'Support'`); samples now bind the raw group key (NULL groups via `IS NULL`) and respect the aggregate's filters.
- **Customer memory upsert could mislabel its source** — AI writes can no longer clobber human-authored entries; human writes relabel honestly.
- **Campaigns with exhausted unknown-outcome recipients stayed `sending` forever** — completion guard tautology fixed; the completion event discloses unknowns.
- **`related_ticket_estimate` counted knowledge-FTS self-matches, not tickets** — now the distinct conversations whose AI analysis cited the document.
- **Conversation detail crashed on analyses lacking optional fields** — found by the browser pass on a conversation no automated test had opened.
- Status writes are atomic; LIKE wildcards are escaped in customer/organization search.

## 🖥️ Broken or dead UI functionality

- **The composer's typed reply, AI draft and panel state bled across conversations** — a draft for ticket A was one click away from ticket B's customer; the detail pane remounts per conversation.
- **A whole family of CSS utilities was referenced but never defined** (`.col`, `.between`, gap/margin steps, `.btn.tiny`, `table.compact`, …) — stacked panels silently laid out as horizontal rows.
- The report builder no longer dead-ends after switching to a total-only metric.
- **The OAuth "Authorize via browser" flow is completed** — `/oauth/callback` finishes the advertised exchange server-side and verifies the single-use `state` parameter.
- The Copilot citation "open" link navigates; the AI Center evaluation toggle reflects immediately; the snooze modal pre-fills local time.
- Outreach campaigns no longer silently exclude recipients beyond the first 100 (all matching pages load, bounded by the 5,000-recipient snapshot cap, with honest warnings); organizations beyond the first 50 are reachable through a pager.
- Eight missing empty-state icons; the mentions mark-read button works; timelines render local relative time; a slow translation can no longer land on the wrong message; Escape closes only the topmost dialog; unknown URLs get a 404 page; Cmd/Ctrl+Enter opens the same send confirmation as the button.

## 🛡️ Reliability & hardening of existing surfaces

- Stuck `running` jobs heal via a periodic sweep; the server handles SIGINT/SIGTERM.
- Campaign creation is bounded (was: 100,000 recipients evaluated in one request).
- The e2e port collision that broke CI on multi-core runners is gone — and config files now join the typecheck/lint surface (the invalid `sequential: true` option was invisible to CI).
- The unanchored `screenshots/` gitignore no longer swallows the README gallery (44 images versioned again).
- **DNS-rebinding guard**: non-loopback `Host` headers are refused — a rebinding page is same-origin from the browser's viewpoint, so the CORS allowlist enforced nothing against it.
- GET endpoints no longer trigger synchronous rebuilds; the legacy `/api/ai/memory` route enforces the personality red line; known-issue PATCH, release-events and AI integer params validate with zod (422s, not 500/503s).
- The CLI db scripts load `.env` like the server (a custom `DATABASE_PATH` no longer silently migrates the wrong database).

## ✅ Verification

672/672 tests green (+25 audit regression locks), 452 black-box audit checks (new section O, 0 HIGH / 0 MEDIUM), and a full human-like browser pass on the real 313-conversation database — every fix verified in the running app, all 20 pages plus detail pages walked with zero console errors.

**The same project, with the same scope — fixed, synchronized, tested, and documented.**
