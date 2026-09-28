# v1.9.0 — The Intelligence Release

**Local Copilot · General AI Attribute Layer · AI Escalation Rules**

The third milestone of the 48-phase roadmap (plan phases 15–17). Three systems, one discipline: **the AI is never the authority — it reads, explains and recommends; deterministic code decides, stores and writes.**

---

## 🤝 Local Copilot (plan phase 15)

An interactive, read-only assistant inside every conversation's context pane. Ask it what a rep actually asks:

> *What is this customer asking? What happened in their previous tickets? Have we seen this issue before? What solved the previous cases? What documentation applies? What should I check before replying? Why is this ticket currently considered urgent? Show evidence for that answer.*

- **Runs fully locally via LM Studio** — no cloud LLM, ever. If AI is disabled or LM Studio is unreachable, the Copilot says so (honest 503s and visible error states) instead of pretending to work.
- **The model never sees SQL.** It can only call the allowlisted read-only tool registry — now 13 tools, including 7 new ones: conversation context, customer history, similar conversations, issue clusters, AI analyses, SupportOS metadata, and the AI attribute snapshot.
- **Every tool result is server-validated, bounded and redacted** before it reaches the prompt.
- **The tool loop is hard-bounded** (max rounds + max tool calls): a tool-looping model gets stopped and must answer from the evidence it already has — honestly.
- **Citations are machine-generated.** The source list is built by the server from the tool executions it *actually performed* — the model cannot fabricate a source that survives. Answers must cite evidence with inline markers.
- **Read-only by construction:** there is no write path anywhere in the Copilot. Sessions and messages persist locally; every turn is audited (`ai_involvement=true`) and recorded in `ai_runs` with model, prompt version and latency.
- Deterministic **starter questions** personalize from local facts (prior tickets, known-issue links, analysis state).

## 🏷️ General AI Attribute Layer (plan phase 16)

Every conversation gets first-class **local** attributes — in a closed 14-key catalog:

`intent · product · feature · issue · urgency · frustration cues · technical familiarity · customer goal · question count · risk · known issue · issue cluster · response style · escalation signal`

- **Two layers.** Deterministic slots (urgency, question count, risk, known-issue links, escalation signal…) are computed from observable local facts with **zero AI** — they always exist. AI slots (intent, product, feature, issue, customer goal, response style) are extracted by LM Studio and stored **only** with enum-closed values and evidence excerpts whose thread references were actually in the prompt — otherwise they are dropped.
- **Versioned.** Every recompute supersedes prior rows (`superseded_at`) and preserves full history per attribute.
- **Honest unknowns.** A key with no current row *is* `unknown` — never fabricated, never a guess wearing a confidence badge. Attributes never overwrite Help Scout source data; they live in their own table with their own schema version.
- **Searchable, filterable, reportable.**
  - A **live inbox filter** (`aiAttribute` / `aiAttrOp` / `aiAttrValue`) — compiled through the *same* viewEngine code path as saved Inbox Views, so a live filter and a saved view can never disagree about what `urgency: high` means.
  - **Saved Inbox Views** and **Outreach segments** can carry `ai_attribute` conditions.
  - The **AI Center → Attributes** tab shows a coverage report (known vs unknown per attribute, honest percentages) with a searchable conversation drill-down.
  - A per-ticket **snapshot card** in the AI sidebar: confidence, source (deterministic/AI), expandable evidence excerpts, honest-unknown list, one-click recompute.

## ⚡ AI Escalation Rules (plan phase 17)

Automation conditions grow two AI-aware fields:

- `ai_attribute` — requires a catalog key (`urgency`, `risk`, `question_count`, …); operator semantics follow the attribute's value type; ordered enums compare by vocabulary position.
- `ai_verification` — `failed` / `passed` / `none`, from the latest AI draft verification.

**The safety invariant is unchanged:** conditions only decide whether a rule *matches* — every action flows through the existing read / non-destructive / higher-risk approval tiers. "High urgency → review queue" is safe because the attribute decides nothing about the customer; the queue is internal, and the approval tier is unchanged. A missing attribute reads as `unknown`: it matches `equals unknown` and **never** a concrete value.

---

## Verification

- **462/462 tests green** (+54 over v1.8.0): 17 unit (catalog + repository contract + viewEngine compilation), 22 integration (deterministic layer with AI off, tool registry surface, Copilot tool loop with a deterministic fake model, escalation-rule matching), 15 e2e over real HTTP (attribute surface, live filter parity, saved views with attribute conditions, the full Copilot chat loop, the escalation-rule lifecycle, 4xx hardening).
- **Black-box audit section K** (383 checks total): injection-shaped attribute keys/values, LIKE-wildcard probes, live-filter parity asserted against the snapshot, hostile copilot bodies, closed-vocabulary automation conditions — final **0 HIGH / 0 MEDIUM**. The audit found and fixed real bugs before release: copilot citations that failed to deep-link conversations, and an unknown-session 503 that should have been a 404.
- **Human-like browser pass**: the Copilot tab (starter questions, honest offline error, session persistence), the attribute snapshot card (recompute, honest unknowns), the live filter through the real UI (URL-backed, honest notes, parity with the drill-down), the AI Center tabs, the automation rule form with the closed catalog selector — and all 17 pages walked with **zero console errors**.

## Upgrading

Migration 013 (`m3_copilot_attributes`) applies automatically on first run — it creates `ai_attributes`, `copilot_sessions` and `copilot_messages`. No backfill is forced: a bounded worker job (≤500) computes attributes for previously analyzed tickets, everything else computes lazily on its next analysis or on demand. Pre-1.9.0 history honestly reads as `unknown`.

**Full changelog:** [CHANGELOG.md](https://github.com/kimpearce888/supportos/blob/main/CHANGELOG.md)
