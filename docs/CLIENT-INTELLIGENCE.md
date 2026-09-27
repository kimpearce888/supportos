# Client Interaction Intelligence

SupportOS v1.1.0 adds **Client Interaction Intelligence**: for every ticket, the system answers four questions beyond "what is the customer asking?":

1. **How is this client approaching us right now?** (current interaction signals)
2. **How does this client normally interact with support?** (historical baseline)
3. **What changed today vs their normal behavior?** (change detection)
4. **How should the rep approach this conversation?** (support-approach recommendation)

Plus a customer-scoped **Client Interaction Profile** with timeline, observed preferences (human-overridable), previous support outcomes, and a repeat-client **Support Playbook**.

## The most important design rule

> The AI learns the client's **support-interaction history** — it never pretends it has diagnosed the person.

The feature reports **observable communication behavior only**: tone, directness, detail level, technical language, question structure, urgency cues, frustration cues, expectation, response preference. It never produces personality labels, psychological claims, diagnoses, or inferences about protected attributes.

## How it works

```
Customer messages (Help Scout mirror, local SQLite)
        │
        ├─ Deterministic engine (ZERO AI required)
        │    ├─ heuristic signals          observable markers, word-boundary matched
        │    ├─ behavioral baseline        recency-weighted (90-day half-life), CLOSED conversations only
        │    ├─ change detection           current vs baseline per dimension
        │    ├─ support outcomes           first-response resolution, follow-ups, effort score, friction
        │    └─ repeat-issue detection      customer + problem recurrence
        │
        ├─ AI stages (LM Studio, optional — graceful degradation)
        │    ├─ Stage 1: Observation       evidence-backed signals only (enum-constrained JSON)
        │    └─ Stage 2: Recommendation    support approach, response strategy, avoid list
        │
        └─ Draft pipeline integration
             └─ communication approach + "what the customer already provided"
                injected into the customer-draft prompt (never asks for info twice)
```

### Safety model (defense in depth)

1. **Schema constraint** — every dimension value must be one of the fixed observable enums (`src/shared/constants.ts`); a personality label like "narcissistic" is not in any vocabulary, so it cannot pass parsing.
2. **Evidence requirement** — significant AI signals without a quoted evidence excerpt are dropped.
3. **Free-text sanitizer** — any AI-generated free text containing mental-health language, personality typing, protected-attribute inference, clinical diagnosis language, or moral-character judgments is rejected (`src/server/ai/interaction/safety.ts`).
4. **Prompt architecture** — Stage 1 explicitly extracts observable signals; the system prompt forbids diagnosis and sensitive-trait inference.
5. **UI labeling** — every surface carries "Observable support-communication behavior — never a psychological assessment."

### Anti-overfitting (one angry email must not label anyone)

- **Temporary vs stable**: current frustration/urgency are *current-ticket* signals; only repeated observations across 3+ interactions become *preferences* (`INTERACTION_MIN_OBSERVATIONS_FOR_PREFERENCE`).
- **Recency weighting**: observations decay with a 90-day half-life; old behavior never dominates today's recommendation.
- **Baseline = closed conversations only**: today's open ticket is "current", not "normal".
- **Explicit requests win**: if the customer writes "please keep it short", that overrides every inferred preference.

### Precedence chain (spec #56)

```
current explicit customer request
        ↓
human-entered preference (override)
        ↓
recent observed behavior
        ↓
older observed behavior
        ↓
generic communication heuristic
```

Human overrides are set from the customer profile page with an optional reason, are fully audited, and can be reverted to fall back to AI inference.

## Where it appears

| Surface | Contents |
|---|---|
| **Inbox sidebar — Client Intelligence card** | returning/first-time badge, current signal chips (hover = evidence), historical pattern, today's significant changes, recommended approach (tone/length/start-with/strategy/avoid + why), effort score, friction, recurring-issue flag, View Evidence drawer, link to full profile |
| **Customer page — Client Interaction Profile** | historical interaction pattern, observed communication preferences (with human override UI), month-by-month timeline (clickable), previous support outcomes (first-response resolution, follow-up/clarification/escalation rates, avg effort, historically effective approaches, friction flags), Support Playbook |
| **AI draft generation** | communication approach + already-provided facts injected into the draft prompt; drafts never re-ask for information the customer already supplied |

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/interaction/:conversationId` | ticket-scoped interaction card |
| `POST /api/interaction/:conversationId/refresh` | recompute (deterministic + optional two-stage AI) |
| `GET /api/interaction/:conversationId/evidence` | evidence-linked observations |
| `GET /api/interaction/profile/:customerId` | full client profile |
| `POST /api/interaction/profile/:customerId/override` | set human preference override — body: `{ field: 'response_preference', value: <preference>, reason? }`; `value` must be one of `concise \| detailed \| step_by_step \| technical \| conversational \| outcome_focused` |
| `DELETE /api/interaction/profile/:customerId/override/response_preference` | revert to AI-inferred (fully removes the override-created preference row) |

All outputs are stored as **derived data** (tables `client_*`, migration 005) — they never modify Help Scout source records, and every row is labeled `heuristic` or `ai_generated` provenance.

## Demo story

The demo world ships with **Ravi Sundaram**, a returning client with three historical tickets (detailed, technical, calm — all resolved on first response) and today's Slack-integration ticket (short, urgent, frustrated). Open ticket #5009 to see the feature at its best: the baseline says "usually detailed, usually calm", the change detector flags frustration/urgency increases as significant, and the recommendation tells the rep to acknowledge impact and answer directly — with evidence behind every claim.

## Testing

- Unit: heuristics vocabulary, word-boundary matching, evidence requirements, forbidden-claim sanitizer
- Integration: full engine over the real sync engine — returning vs first-time clients, change directions, override precedence + revert, outcome metrics, repeat-issue detection, profile assembly
- E2E: all six API endpoints over the real Fastify app, including the 422 validation path and safety labeling

Run: `npm run test:all` (130 tests).
