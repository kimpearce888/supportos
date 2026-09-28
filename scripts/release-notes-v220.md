# v2.2.0 — The Memory Release (Roadmap Complete)

The memory release — and the closing release of the six-milestone roadmap: SupportOS now understands how everything in a support operation connects, coaches replies before they are sent, remembers customers safely, and stays fast while doing it.

## 🕸️ Support Graph (plan phase 34)

A relationship layer over the twelve node kinds the plan enumerates — customer, organization, conversation, known issue, issue cluster, incident, knowledge document, agent, campaign, product, custom object, connector row — implemented exactly as the plan prescribes: **relational tables, no heavyweight graph database**.

- **Derived edges are computed live from the mirror at read time** — 26 parameterized SQL branches, each bounded and label-resolving in the same query (no N+1). There is no second copy of any relationship to go stale.
- **Only human-asserted edges are persisted** (`support_graph_edges`, closed five-relation union: related_to / depends_on / blocks / mentions / duplicate_of) — a human judgment is information the database does not already contain.
- Products become a first-class registry, derived INSERT-OR-IGNORE from the product strings incidents and known issues already carry; a rebuild can only ever add names.
- Every edge carries provenance (Help Scout mirror / deterministic / AI-derived evidence / human); **connector rows honestly have no derived links** — the stats page says so.
- Graph Explorer page: live counts, node search, relation-grouped neighbor lists, human-edge manager; bounded subgraph exploration (depth ≤ 2, ≤ 250 nodes).
- Three read-only Copilot tools join the registry (22 total): `get_graph_neighbors`, `get_graph_stats`, `get_customer_memory`.

## 🎓 Pre-Send Agent Coaching (plan phase 35)

The plan's ten checks in the composer — **advisory only, ever**: no code path blocks, delays or annotates the send.

- Nine deterministic checks always compute: unanswered customer questions, duplicated questions, **explicit timeframe commitments cross-checked against linked ACTIVE incidents**, missing acknowledgment when frustration cues exist, excessive wording (preference-aware), insufficient detail, **internal information leakage as verbatim 6-gram spans against the conversation's own notes + linked incident/known-issue internals + cited internal-only documents**, wrong customer context (foreign conversation numbers, greeting-name mismatch), communication-preference mismatch with human-override precedence.
- Two local-model checks (unsupported claims, wrong context) under their own `ai_runs` type `agent_coaching` — closed verdicts, honest unparseable failure, honest unavailability when the model is down.
- The full pass/flagged/not-applicable checklist renders with evidence per finding; the last review persists as an audit trail of what the agent was told.

## 🧠 Customer Support Memory (plan phase 36)

**Composed at read time from the tables that already hold each fact** — memory can never drift from its sources.

- Nine sections: known-issue history, previous resolutions with outcome facts, communication preferences (override state), recurring friction patterns (evidence-pinned, "patterns, not judgments"), support-outcome aggregates, campaign history, product & account facts, human-written entries, AI-extracted entries.
- Every entry carries source, timestamp, confidence, freshness and evidence — "unknown" means no observation, never a guess.
- Human-written entries are the only persisted rows; **AI rows are immutable** (they re-derive); human rows edit and delete freely.
- **The personality red line is enforced in code, twice**: a closed quarantine pattern list pulls matching stored entries out of usable memory (listed with a reason, purgeable), and human writes matching the list are refused outright with the policy message.

## ⚡ Performance Polish (plan phase 41)

- Bounded the remaining unbounded hot paths (gap report, issue-cluster Copilot tool, radar escalated/rating queries, per-customer observations, effectiveness analysis) — bounds disclosed in the data where they bind.
- The interaction engine's per-GET history backfill is now guarded by cheap COUNT queries.
- Targeted indexes: customer-ordered conversation history, observation recency, outreach recipient lookups, issue/cluster reverse links.
- **The project's first performance regression guards**: a synthetic 2,000-conversation × 400-customer world with CI-safe budgets plus deterministic EXPLAIN QUERY PLAN index assertions.

## Verification

- **647/647 tests green** (+53 over v2.1.0): 8 unit + 24 integration + 8 perf-guard + 13 e2e.
- **Black-box audit section N (446 checks, 0 HIGH / 0 MEDIUM)**: graph/coaching/memory hostile matrices, injection-as-data with tables asserted intact, the red-line refusal surface, AI-availability honesty with no model running.
- **Human-like browser pass** on the real upgraded 313-conversation database: centered the graph on INC-001 with derived edges and provenance, asserted a human edge through the UI (DB-verified), watched coaching flag a "within 2 hours" promise against the active incident **and catch a verbatim internal-explanation leak with the incident quoted as evidence**, saw the honest LM-Studio-down coaching state, wrote a human memory entry through the UI (DB-verified), had a personality-shaped write refused by policy (zero rows stored), and walked all 20 pages with zero console errors.

## Fixed

- Gap-candidate report totals were computed from the (previously unbounded) row set; now exact via dedicated COUNT queries regardless of the display bound.
- Copilot `get_issue_clusters` loaded the full cluster table into JS before filtering; the filter now runs inside SQLite with a row bound.

**Upgrade path**: migration 016 (products registry, support_graph_edges, coaching_reviews, customer_memories.kind, performance indexes) applies automatically on first boot; the graph, memory and coaching surfaces derive from data you already have. The demo seed grew a human graph edge and a human memory entry (empty demo databases only).
