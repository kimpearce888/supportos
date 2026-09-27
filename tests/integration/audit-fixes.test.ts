import { describe, it, expect } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { SyncCoordinator } from '../../src/server/sync/coordinator.js';
import { FakeHelpScoutProvider } from '../../src/server/integrations/helpscout/fakeProvider.js';
import { InteractionEngine } from '../../src/server/ai/interaction/engine.js';
import { sanitizeThreadHtml } from '../../src/server/security/sanitize.js';
import { isClosingAcknowledgment } from '../../src/server/ai/interaction/engine.js';

/**
 * Regression tests for the v1.2.0 independent audit fixes. Each test names the
 * audit finding it protects against, so a future regression is self-explaining.
 */

async function setup(): Promise<{ db: ReturnType<typeof openTestDatabase>; engine: InteractionEngine }> {
  const db = openTestDatabase();
  applyMigrations(db);
  const provider = new FakeHelpScoutProvider();
  const coordinator = new SyncCoordinator(db, provider);
  await coordinator.initialSync();
  const engine = new InteractionEngine(db);
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

describe('audit fixes (v1.2.0): interaction data integrity', () => {
  it('observations are idempotent: repeated refreshes/syncs never duplicate rows (audit: duplicate observations corrupted baselines)', async () => {
    const { db, engine } = await setup();
    const conv = findConversation(db, 'Slack integration stopped posting');
    const before = (db.prepare('SELECT COUNT(*) AS n FROM client_behavior_observations WHERE conversation_id = ?').get(conv.id) as { n: number }).n;
    engine.recordCurrentInteraction(conv.id);
    engine.recordCurrentInteraction(conv.id);
    engine.recordCurrentInteraction(conv.id);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM client_behavior_observations WHERE conversation_id = ?').get(conv.id) as { n: number }).n;
    expect(after).toBe(before);
    // One row per (conversation, dimension, source)
    const dupes = db.prepare('SELECT dimension, COUNT(*) c FROM client_behavior_observations WHERE conversation_id = ? GROUP BY dimension, source HAVING c > 1').all(conv.id);
    expect(dupes).toHaveLength(0);
    closeDatabase();
  });

  it('current signals: one row per conversation, not one per refresh (audit: unbounded append)', async () => {
    const { db, engine } = await setup();
    const conv = findConversation(db, 'Slack integration stopped posting');
    engine.recordCurrentInteraction(conv.id);
    engine.recordCurrentInteraction(conv.id);
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM client_current_signals WHERE conversation_id = ?').get(conv.id) as { n: number }).n;
    expect(rows).toBe(1);
    closeDatabase();
  });

  it('resolved_after_first_response requires CLOSED status (audit: || true dead check counted open tickets as resolved)', async () => {
    const { db, engine } = await setup();
    const open = findConversation(db, 'Slack integration stopped posting'); // today's OPEN ticket
    const outcome = engine.computeOutcome(open.id);
    expect(outcome?.resolved_after_first_response).not.toBe(true);
    closeDatabase();
  });

  it('closing thank-you messages do not count as follow-ups (demo data regression guard)', async () => {
    expect(isClosingAcknowledgment('That is exactly what I needed — the dual-format monitoring suggestion made the migration straightforward. Closing from my side.')).toBe(true);
    expect(isClosingAcknowledgment('Thanks!')).toBe(true);
    expect(isClosingAcknowledgment('This is still broken, the same error appears again')).toBe(false);
    expect(isClosingAcknowledgment('Thanks, but what about the retry-after window?')).toBe(false);
  });

  it('change detection: nominal dimensions report "changed" without a fake direction (audit: tone "increase" is meaningless)', async () => {
    const { db, engine } = await setup();
    const conv = findConversation(db, 'Slack integration stopped posting');
    const card = engine.buildCard(conv.id);
    for (const c of card!.changes) {
      if (['tone', 'expectation', 'question_structure', 'response_preference'].includes(c.dimension)) {
        expect(c.direction).toBe('changed');
        expect(c.significant).toBe(false);
      }
    }
    closeDatabase();
  });

  it('preference threshold counts DISTINCT conversations, not repeated rows (audit: single-ticket overfit)', async () => {
    const { db, engine } = await setup();
    const ravi = findConversation(db, 'Slack integration stopped posting');
    const customerId = ravi.customer_local_id!;
    const profile = engine.buildProfile(customerId);
    // Ravi's demo data has no repeated explicit preference across 3+ distinct
    // conversations, so no ai_inferred preference may be inferred yet.
    const aiPrefs = profile!.preferences.filter((p) => p.origin === 'ai_inferred');
    const groups = db
      .prepare('SELECT value, COUNT(DISTINCT conversation_id) AS convs FROM client_behavior_observations WHERE customer_id = ? AND dimension = ? GROUP BY value')
      .all(customerId, 'response_preference') as { value: string; convs: number }[];
    for (const g of groups) {
      if (g.convs < 3) {
        expect(aiPrefs.some((p) => p.preference === g.value)).toBe(false);
      }
    }
    closeDatabase();
  });
});

describe('audit fixes (v1.2.0): HTML sanitizer CSS scrubbing', () => {
  it('style attributes with position:fixed / url() are stripped (audit: CSS overlay + tracking beacons)', () => {
    const dirty = '<div style="position:fixed;top:0;left:0;width:100%;height:100%;background:red">overlay</div><span style="color:blue">ok</span>';
    const clean = sanitizeThreadHtml(dirty);
    expect(clean).toContain('color:blue');
    expect(clean).not.toContain('position:fixed');
    const beacon = '<div style="background:url(//attacker.example/track)">x</div>';
    expect(sanitizeThreadHtml(beacon)).not.toContain('url(');
  });
});
