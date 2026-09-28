# v2.0.0 — The Workspace Release

**Incident Workspace · Issue Impact Intelligence · Radar Extensions · Custom Objects · Local Data Connectors · Customer Timeline · Support Health · Knowledge Freshness**

The fourth milestone of the 48-phase roadmap (plan phases 18–25). Eight systems, one discipline: **derived over stored, closed vocabularies, idempotent by construction, association wording for every correlation, and explicit human control over anything AI-visible or customer-facing.**

---

## 🚨 Incident / Master-Issue Workspace (plan phase 18)

When something breaks, fifty tickets arrive about one problem. SupportOS now has one place to run the outage.

- **`INC-001`-coded incidents** with status, severity, owner, product/feature, description, internal vs customer-safe explanations, known cause, workaround and resolution.
- **Conversations link to incidents** — one issue → many tickets, the plan's explicit requirement. Linked tickets show an **active-incident chip in the Inbox** so every agent sees the outage context without leaving the ticket.
- **Affected customers and organizations are DERIVED from the linked conversations at read time — never stored, so they can never drift.**
- **Engineering references, releases, related known issues/knowledge/campaigns/custom objects, notes** and an **append-only timeline** (dedup-keyed: re-runs can never double-record) complete the record.
- **Declare an incident in one action** from a known issue (explanations carried over, its conversations linked) or from a rising cluster (every member conversation linked).
- `incident_update` notifications join the closed 15-type union: declared, status/severity changes, conversations linked.

## 📊 Issue Impact Intelligence (plan phase 19)

The numbers that matter under pressure, through **one shared implementation for incidents AND known issues**:

- Affected conversations, **distinct customers** (a ticket count is never silently used as a customer count), organizations.
- First/last seen, 7-day growth with direction, trend, affected inboxes, top tags.
- Products from the local AI attribute layer — honestly `unknown` until conversations are analyzed.
- Open/closed distribution and **how many customers are waiting right now**.
- **Release correlation is a temporal association only**: conversations starting within 7 days after a recorded release date, with the non-causal wording in the data itself.

## 🧭 Issue Radar Extensions (plan phase 20)

Six new deterministic detections, every alert carrying evidence conversation links and association-only wording:

- **Reappearing issues** (quiet 30–60d ago, back in the last 30d)
- **Customer concentration** (few customers, many tickets)
- **Inbox concentration** (one mailbox dominates the cluster)
- **Release-correlation bursts** (≥60% of a cluster inside one 7-day window; releases recorded in the window are mentioned as associations)
- **Repeated unresolved patterns** (same customer, same cluster, 14+ day spans)
- **Unusual global volume** (last 7d vs previous 7d, ≥40% up)

## 📦 Custom Objects (plan phase 21)

A local extensible object model — Account, Deployment, Subscription, anything you define:

- **Typed field definitions** (text, long text, number, date, boolean, select) with immutable types once objects exist.
- **Values are JSON validated at every write by a Zod schema built from your own field definitions** — user-defined data never becomes SQL.
- **Relationship edges** to customers, organizations, conversations, known issues, incidents and campaigns, with reverse lookups and per-type reporting.
- **Full-text search** over titles and property text.

## 🔌 Local Data Connectors (plan phase 22)

Approved local data sources, refreshed on your schedule:

- Four kinds: **local JSON, CSV, SQLite file, HTTP endpoint**.
- **Snapshot semantics**: rows keyed by a key column or content hash; vanished rows pruned; failed refreshes mark `health=error` and never partially overwrite a good snapshot.
- **Fail-closed SSRF guard** (the approved plan adjustment): private ranges, loopback, link-local cloud metadata, CGNAT, IPv6 private/loopback, IPv4-mapped tricks, numeric encodings and internal hostnames are refused — validated at configuration time AND re-validated with DNS resolution before every request (rebinding shapes covered).
- Files live inside the `connectors/` folder jail; HTTP responses capped at 10MB with a 10s timeout.
- **Auth material is always redacted (`••••••`) in every read.**
- **The AI sees connector data only where you explicitly allow it** — the Local Copilot's connector tool refuses anything else and tells you what IS visible.

## 🕒 Customer Event Timeline (plan phase 23)

An append-only, dedup-keyed local event log per customer, independent of ticket history:

- Signups, conversations started/closed, first customer messages, campaign sends/replies, ratings, **incident exposure** and **linked custom object records**.
- Kinds with no observable source (subscription/account/product/integration events) stay honestly **absent** until a connector or custom object produces them.
- Organization timelines are the union over member customers; a rebuild action re-derives history idempotently.
- Migration 014 backfilled observable history (656 events derived live on the real 314-conversation demo database).

## 🩺 Customer Support Health (plan phase 24)

Operational facts with plain-language definitions and evidence links — waiting, volume, unresolved known issues, incident exposure, response delays, escalation history, an effort proxy — plus attention flags traceable to specific conversations.

**There is deliberately no aggregate "score" and no psychological or personal judgments.** A number that summarizes a human invites reading it as a judgment; the schema has no such field and the audit asserts its absence.

## 📚 Knowledge Freshness (plan phase 25)

Lifecycle observability for the local knowledge base:

- Created / updated / **last reviewed** / **last verified** / version / **usage** (bumped by local searches) / associated recurring questions.
- Six deterministic flags: **stale** content, **needs review**, **conflict candidates** (title-term overlap), **low usage**, **articles followed by support tickets** (temporal/topic association only), **articles tied to questions that keep coming back**.
- **Review and Verify are human-only timestamps — nothing is edited or published automatically.**

## 🤝 Copilot tool surface

Four new read-only tools join the registry (17 total): `search_incidents` (derived counts, the distinct-customers note travels with the data), `search_custom_objects` (type-narrowed FTS, redacted), `get_customer_timeline` (bounded recent events) and the gated `search_connector_data`.

---

## 🔬 Verification

- **541/541 tests green** (+79 over v1.9.0): 22 unit + 74 integration + 17 e2e — including a full SSRF-guard suite (range matrix, IPv4-mapped IPv6, DNS rebinding shapes, fail-closed semantics), connector snapshot semantics, derived-count invariants, rebuild idempotence, dynamic-schema validation and hostile-input hardening on every new route.
- **Black-box audit extended** (section L — 410 checks): incident hostile-creates, XSS/SQL-shaped payloads stored as data with tables asserted intact, SSRF probes across the full private-target matrix, path-jail escapes, auth redaction asserted in responses, timeline rebuild idempotence, the no-score assertion, and a radar honesty sweep that fails on any causal wording. **0 HIGH / 0 MEDIUM after fixes.**
- **Human-like browser pass on the real upgraded demo database**: incidents declared from a known issue AND a cluster through the UI, severity changed (notification + timeline event verified in the database), a conversation linked by number (which found and fixed a real bug — the flow queried a search parameter the endpoint never had; replaced with an exact-match `?number=` filter), the Inbox incident chip verified, customer timeline + support health walked, a custom object type and object created through the designer, a connector created and refreshed with the inferred schema visible, knowledge freshness exercised with the human-only Review action, and **all 18 pages walked with zero console errors**.

## ⬆️ Upgrade notes

- Forward-only migration 014 (idempotent; observable customer-event history backfilled automatically).
- The `connectors/` folder is created on first use and is gitignored — drop your JSON/CSV/SQLite sources there.
- HTTP connector targets must be public; the SSRF guard is fail-closed by design.
- Everything in this release is LOCAL SupportOS data — nothing new is written to Help Scout.
