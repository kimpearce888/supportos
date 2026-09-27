import { describe, it, expect } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { SyncCoordinator } from '../../src/server/sync/coordinator.js';
import { FakeHelpScoutProvider } from '../../src/server/integrations/helpscout/fakeProvider.js';
import { InteractionEngine } from '../../src/server/ai/interaction/engine.js';

/**
 * Client Interaction Intelligence integration tests over the REAL sync engine
 * and the fake provider world (no production messages possible).
 * Interaction spec #3, #5, #10, #16, #17, #19, #22, #25, #26, #39, #46, #50, #52, #56.
 */
async function setup(): Promise<{ db: ReturnType<typeof openTestDatabase>; engine: InteractionEngine }> {
  const db = openTestDatabase();
  applyMigrations(db);
  const provider = new FakeHelpScoutProvider();
  const coordinator = new SyncCoordinator(db, provider);
  await coordinator.initialSync();
  const engine = new InteractionEngine(db);
  // Materialize interaction history the way workers.onAfterInitialSync does
  const convs = db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL').all() as { id: number }[];
  for (const c of convs) {
    engine.recordCurrentInteraction(c.id);
    engine.computeOutcome(c.id);
  }
  const customers = db.prepare('SELECT DISTINCT customer_local_id AS cid FROM conversations WHERE customer_local_id IS NOT NULL').all() as { cid: number }[];
  for (const cu of customers) engine.rebuildBaseline(cu.cid);
  return { db, engine };
}

function findConversation(db: ReturnType<typeof openTestDatabase>, subjectLike: string): { id: number; customer_local_id: number | null } {
  const row = db.prepare('SELECT id, customer_local_id FROM conversations WHERE subject LIKE ? AND deleted_at IS NULL').get(`%${subjectLike}%`) as { id: number; customer_local_id: number | null } | undefined;
  if (!row) throw new Error(`conversation "${subjectLike}" not found`);
  return row;
}

describe('client interaction intelligence (interaction spec)', () => {
  it('builds a returning-client card with current signals, baseline, changes and a recommendation (spec #26)', async () => {
    const { db, engine } = await setup();
    const conv = findConversation(db, 'Slack integration stopped posting');
    const card = engine.buildCard(conv.id);
    expect(card).not.toBeNull();
    expect(card!.client_kind).toBe('returning');
    expect(card!.current.signals.length).toBeGreaterThan(3);
    expect(card!.baseline).not.toBeNull();
    expect(card!.recommendation).not.toBeNull();
    closeDatabase();
  });

  it('detects today vs baseline change: normally detailed, today shorter and more urgent (spec #5, #19)', async () => {
    const { db, engine } = await setup();
    const conv = findConversation(db, 'Slack integration stopped posting');
    const card = engine.buildCard(conv.id);
    const detailChange = card!.changes.find((c) => c.dimension === 'detail');
    const urgencyChange = card!.changes.find((c) => c.dimension === 'urgency');
    expect(detailChange).toBeDefined();
    expect(detailChange!.direction).toBe('decrease');
    expect(urgencyChange!.direction).toBe('increase');
    closeDatabase();
  });

  it('first-time client gets no baseline and no invented history (spec #3, #27)', async () => {
    const { db, engine } = await setup();
    const row = db
      .prepare('SELECT c.id FROM conversations c WHERE c.deleted_at IS NULL AND (SELECT COUNT(*) FROM conversations x WHERE x.customer_local_id = c.customer_local_id AND x.deleted_at IS NULL) = 1 LIMIT 1')
      .get() as { id: number } | undefined;
    if (!row) throw new Error('no single-conversation customer found');
    const card = engine.buildCard(row.id);
    expect(card!.client_kind).toBe('first_time');
    expect(card!.baseline).toBeNull();
    expect(card!.changes.length).toBe(0);
    expect(card!.recommendation).not.toBeNull();
    closeDatabase();
  });

  it('requires repeated evidence before a preference counts as a pattern (spec #39, #40)', async () => {
    const { db, engine } = await setup();
    const ravi = findConversation(db, 'Slack integration stopped posting');
    expect(ravi.customer_local_id).not.toBeNull();
    const profile = engine.buildProfile(ravi.customer_local_id!);
    for (const p of profile!.preferences) {
      if (p.origin !== 'human_entered') expect(p.evidence_count).toBeGreaterThanOrEqual(3);
    }
    closeDatabase();
  });

  it('human override takes precedence and is revertible (spec #22, #56)', async () => {
    const { db, engine } = await setup();
    const ravi = findConversation(db, 'Slack integration stopped posting');
    const customerId = ravi.customer_local_id!;
    // New value-keyed semantics: the override materializes on the preference
    // VALUE row ('concise'), not on a row named after the field.
    engine.repo.setHumanOverride(customerId, 'concise', 'detailed', 'Customer asked for short answers');
    const pref = engine.repo.getPreferences(customerId).find((p) => p.preference === 'concise');
    expect(pref?.human_override?.value).toBe('concise');
    expect(pref?.human_override?.reason).toContain('short answers');
    expect(pref?.origin).toBe('human_entered');
    const card = engine.buildCard(ravi.id);
    expect(card!.recommendation!.length).toBe('concise');
    expect(card!.recommendation!.source).toBe('ai+human-override');
    engine.repo.clearHumanOverride(customerId);
    // After revert the override-created row is fully removed (no phantom
    // "human-entered preference with 0 interactions"), and AI semantics apply again.
    const cleared = engine.repo.getPreferences(customerId).find((p) => p.preference === 'concise');
    expect(cleared?.human_override ?? null).toBeNull();
    expect(engine.repo.getPreferences(customerId).some((p) => p.origin === 'human_entered')).toBe(false);
    const cardAfter = engine.buildCard(ravi.id);
    expect(cardAfter!.recommendation!.source).not.toBe('ai+human-override');
    closeDatabase();
  });

  it('computes support outcomes with effort score and resolution history (spec #16, #17, #52)', async () => {
    const { db, engine } = await setup();
    const ravi = findConversation(db, 'Slack integration stopped posting');
    const summary = engine.outcomeSummary(ravi.customer_local_id!);
    expect(summary).not.toBeNull();
    expect(summary!.total_conversations).toBeGreaterThanOrEqual(4);
    expect(summary!.first_response_resolution_rate).not.toBeNull();
    expect(summary!.avg_effort_score).not.toBeNull();
    expect(summary!.effective_approaches.length).toBeGreaterThan(0);
    closeDatabase();
  });

  it('detects the recurring integration issue across Ravi tickets (spec #50)', async () => {
    const { db, engine } = await setup();
    const conv = findConversation(db, 'Slack integration stopped posting');
    const repeat = engine.detectRepeatIssue(conv.id);
    expect(repeat).not.toBeNull();
    expect(repeat!.related_conversations.length).toBeGreaterThanOrEqual(1);
    closeDatabase();
  });

  it('customer profile assembles timeline, playbook and baseline (spec #25, #46)', async () => {
    const { db, engine } = await setup();
    const ravi = findConversation(db, 'Slack integration stopped posting');
    const profile = engine.buildProfile(ravi.customer_local_id!);
    expect(profile!.timeline.length).toBeGreaterThan(1);
    expect(profile!.playbook).not.toBeNull();
    expect(profile!.playbook!.historically_successful).toBeTruthy();
    expect(profile!.baseline!.observation_count).toBeGreaterThan(10);
    closeDatabase();
  });
});
