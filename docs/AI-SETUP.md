# AI Setup (LM Studio + Qdrant)

SupportOS uses **only local AI**. Nothing is ever sent to OpenAI, Anthropic, Google or any other cloud provider — ticket content stays on your machine.

## LM Studio

1. Install from https://lmstudio.ai
2. Load a **chat model** (any instruct model that runs on your hardware; a 7B–14B class model gives good analyses and drafts)
3. Optional but recommended: load an **embedding model** (e.g. `nomic-embed-text` or similar) — enables semantic search and vector indexing
4. Go to the **Developer** tab → **Start Server** (default `http://127.0.0.1:1234`)
5. In SupportOS: **Settings → LM Studio** → set the base URL → **Test connection + discover models** → pick models → **Save**

Used endpoints (OpenAI-compatible): `GET /v1/models`, `POST /v1/chat/completions` (JSON mode, tools), `POST /v1/embeddings`.

**The app remains fully usable without AI.** If LM Studio is offline, search, the inbox, all ticket operations, analytics and reports keep working; AI actions show clear errors.

## The AI pipeline

| Stage | What it does | Stored where |
|---|---|---|
| Ticket analysis | intent, primary/secondary questions, goal, product/feature, problem type, urgency, sentiment, known-issue candidate, missing info, evidence-based confidence | `ai_runs` + `ai_extracted_facts` + `ai_sources` (structural, not prose blobs) |
| Evidence package | current conversation + customer history + similar tickets + known issues + visibility-filtered knowledge + saved replies; every source carries type/id/visibility | `ai_sources` |
| Draft generation | verified-answer mode: customer-safe evidence only, anti-fabrication rules, no invented timeframes/features/fix-status | `ai_drafts` (+ sources + model + prompt version) |
| Verification | unanswered questions? unsupported claims? invented timeframe? internal leakage? contradictions? | `ai_verifications` — surfaced in the UI before you insert or send |
| AI note | clearly marked "[AI Analysis - generated locally]" internal note (only if enabled in Settings) | Help Scout note via the write-protected path |
| Customer memory | durable facts with confidence, clearly marked AI-derived vs human-entered | `customer_memories` |
| Issue clustering | AI proposes clusters from actual ticket data; counts/trends computed deterministically by SQL | `issue_clusters` |

Caching: each stage hashes its input and records the prompt version; unchanged conversations reuse previous analyses. Changed content (new threads) invalidates the cache automatically.

## Safety rules

- **AI never sends customer replies** — `automatic_reply_sending` is permanently OFF (enforced server-side; attempts to enable it are ignored)
- Customer-facing drafts may only use customer-safe evidence; internal-only knowledge is filtered out before prompting and double-checked by verification
- A redaction layer masks card numbers, CVV patterns, API keys, tokens, bearer headers and private key blocks before anything reaches the model
- The model gets bounded context (current ticket + direct history + top matches), never the whole database
- Confidence is an **operational** level (high/medium/low/unknown based on evidence quality), not a probability

## Qdrant (optional semantic search)

```bash
docker run -d -p 6333:6333 qdrant/qdrant
```

Then **Settings → Qdrant** → test → save. Index knowledge and (when an embedding model is configured) let the background worker embed chunks. Search automatically becomes hybrid (keyword + semantic) and similar-ticket scoring gains a semantic signal. Embedding-model changes are detected via stored model metadata — vectors are never silently mixed. If Qdrant goes down, a warning shows and **keyword search keeps working**.

## Golden test set / evaluation mode

AI Center → **Evaluation** lists the golden scenarios (simple question, multi-question, ambiguous, known issue, new issue, customer history, timezone, integration, billing, escalation). **AI evaluation mode** disables all Help Scout writes (no notes, replies, status or assignment changes) so you can compare analysis outputs safely. Automated runs of the deterministic pipeline parts are covered by the test suite (see TESTING.md).
