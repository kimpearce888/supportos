import { describe, it, expect } from 'vitest';
import { openTestDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { SyncCoordinator } from '../../src/server/sync/coordinator.js';
import { FakeHelpScoutProvider } from '../../src/server/integrations/helpscout/fakeProvider.js';
import { AnalyticsService } from '../../src/server/analytics/analyticsService.js';
import { AutomationEngine } from '../../src/server/automation/engine.js';
import { AiRepository } from '../../src/server/database/repositories/aiRepo.js';
import { IssueRepository } from '../../src/server/database/repositories/issueRepo.js';
import { SettingsRepository } from '../../src/server/database/repositories/settingsRepo.js';
import { BackupService } from '../../src/server/services/backupService.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

async function setup(): Promise<{ db: ReturnType<typeof openTestDatabase>; analytics: AnalyticsService; automation: AutomationEngine; provider: FakeHelpScoutProvider }> {
  const db = openTestDatabase();
  applyMigrations(db);
  const provider = new FakeHelpScoutProvider();
  const coordinator = new SyncCoordinator(db, provider);
  await coordinator.initialSync();
  return { db, analytics: new AnalyticsService(db), automation: new AutomationEngine(db), provider };
}

describe('analytics (spec #46-#52, #153)', () => {
  it('computes dashboard counts deterministically with labeled sources', async () => {
    const { analytics } = await setup();
    const d = analytics.dashboard(new Date(Date.now() - 90 * 86400000).toISOString(), new Date().toISOString());
    expect(d.new_conversations).toBe(14);
    expect(d.active_conversations).toBe(5);
    expect(d.closed_conversations).toBe(7);
    expect(d.unassigned).toBeGreaterThanOrEqual(2);
    expect(d.replies_sent).toBe(11);
    expect(d.source).toEqual(['local']);
    expect(d.ratings.great).toBe(3);
    expect(d.by_mailbox.length).toBe(2);
    expect(d.by_tag.some((t) => t.name === 'timezone')).toBe(true);
  });

  it('first response time is computed from thread data', async () => {
    const { analytics } = await setup();
    const d = analytics.dashboard(new Date(Date.now() - 90 * 86400000).toISOString(), new Date().toISOString());
    expect(d.first_response_time_avg_min).not.toBeNull();
    expect(d.first_response_time_avg_min!).toBeGreaterThan(0);
  });

  it('every local metric has a definition (spec #120)', async () => {
    const { analytics } = await setup();
    const defs = analytics.metricDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(11);
    expect(defs.every((d) => d.formula && d.source && d.limitations !== undefined)).toBe(true);
    const frt = defs.find((d) => d.key === 'first_response_time_local');
    expect(frt?.source).toBe('local');
    expect(frt?.limitations).toContain('may differ');
  });

  it('issue radar alerts carry supporting ticket links and never claim causation (spec #42)', async () => {
    const { db, analytics } = await setup();
    // create a cluster so radar has something to say
    const issues = new IssueRepository(db);
    const convIds = (db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL LIMIT 4').all() as { id: number }[]).map((r) => r.id);
    issues.upsertCluster({ title: 'test cluster timezone', summary: 'test', conversation_ids: convIds, ai_generated: true });
    issues.computeTrends();
    const alerts = analytics.issueRadar();
    for (const a of alerts) {
      expect(a.conversation_ids).toBeDefined();
    }
    const ratingAlerts = alerts.filter((a) => a.kind === 'rating_correlated');
    for (const a of ratingAlerts) {
      expect(a.detail).toMatch(/association|not proof/i);
    }
  });

  it('top questions / why-contacting derive from stored AI analyses (spec #50)', async () => {
    const { db, analytics } = await setup();
    const ai = new AiRepository(db);
    const conv = db.prepare('SELECT id FROM conversations WHERE number = 5001').get() as { id: number };
    const runId = ai.startRun('ticket_analysis', { conversationId: conv.id, promptVersion: 'ticket_analysis_v1', inputHash: 'x', inputRefs: [] });
    ai.completeRun(runId, { primary_question: 'how do timezones work for schedules', issue_cluster_candidate: 'timezone schedules', confidence: 'high' }, 100);
    ai.saveAnalysis(runId, conv.id, { primary_question: 'how do timezones work for schedules', issue_cluster_candidate: 'timezone schedules', confidence: 'high' } as never, []);
    const cats = analytics.whyCustomersContact(90);
    expect(cats.some((c) => c.category.includes('timezone'))).toBe(true);
    const qs = analytics.topQuestions(90);
    expect(qs.some((q) => q.question.includes('timezones work for schedules'))).toBe(true);
    expect(qs.every((q) => Array.isArray(q.conversation_ids))).toBe(true);
  });
});

describe('automation engine (spec #64, #65)', () => {
  it('higher-risk actions always require approval while write actions are off', async () => {
    const { db, automation } = await setup();
    const convId = (db.prepare('SELECT id FROM conversations WHERE number = 5001').get() as { id: number }).id;
    automation.createRule({
      name: 'Auto-close timezone tickets',
      enabled: true,
      trigger: 'new_conversation',
      conditions: [{ field: 'subject', operator: 'contains', value: 'hour' }],
      actions: [
        { kind: 'analyze_ticket', params: {} },
        { kind: 'set_status', params: { status: 'closed' } }
      ],
      requires_approval: true
    });
    // automation is disabled by default -> no runs
    const noRuns = await automation.fireTrigger('new_conversation', convId);
    expect(noRuns.length).toBe(0);
    // enable engine but NOT write actions
    const settings = new SettingsRepository(db);
    settings.set('automation_enabled', true);
    settings.set('automation_write_actions_enabled', false);
    const runs = await automation.fireTrigger('new_conversation', convId);
    expect(runs.length).toBe(1);
    const awaiting = runs.filter((r) => r.status === 'awaiting_approval');
    expect(awaiting.length).toBe(1);
    // nothing was closed remotely
    const status = db.prepare('SELECT status FROM conversations WHERE id = ?').get(convId) as { status: string };
    expect(status.status).not.toBe('closed');
  });

  it('read actions run without approval', async () => {
    const { db, automation } = await setup();
    const convId = (db.prepare('SELECT id FROM conversations WHERE number = 5002').get() as { id: number }).id;
    automation.createRule({
      name: 'analyze only',
      enabled: true,
      trigger: 'customer_reply',
      conditions: [],
      actions: [{ kind: 'analyze_ticket', params: {} }],
      requires_approval: false
    });
    const settings = new SettingsRepository(db);
    settings.set('automation_enabled', true);
    const runs = await automation.fireTrigger('customer_reply', convId);
    expect(runs.some((r) => r.status === 'completed')).toBe(true);
  });

  it('skips rules whose conditions do not match', async () => {
    const { db, automation } = await setup();
    const convId = (db.prepare('SELECT id FROM conversations WHERE number = 5001').get() as { id: number }).id;
    automation.createRule({ name: 'no match', enabled: true, trigger: 'new_conversation', conditions: [{ field: 'subject', operator: 'contains', value: 'zzz-unmatchable' }], actions: [{ kind: 'analyze_ticket', params: {} }], requires_approval: false });
    const settings = new SettingsRepository(db);
    settings.set('automation_enabled', true);
    const runs = await automation.fireTrigger('new_conversation', convId);
    expect(runs.every((r) => r.status === 'skipped')).toBe(true);
  });
});

describe('AI analysis caching + change detection (spec #124, #125)', () => {
  it('cache hit reuses the previous analysis without a new run', async () => {
    const { db } = await setup();
    const ai = new AiRepository(db);
    const convId = (db.prepare('SELECT id FROM conversations WHERE number = 5003').get() as { id: number }).id;
    const sig = ai.getAnalysisSignature(convId);
    const hash = ai.inputHash(convId, sig);
    // first run
    const run1 = ai.startRun('ticket_analysis', { conversationId: convId, promptVersion: 'ticket_analysis_v1', inputHash: hash, inputRefs: [convId] });
    ai.completeRun(run1, { summary: 'first analysis', confidence: 'high' }, 500);
    // cached lookup finds it
    const cached = ai.findCachedRun('ticket_analysis', hash, 'ticket_analysis_v1');
    expect(cached).toBeDefined();
    expect(cached?.id).toBe(run1);
    // changed content -> different hash -> no cache hit
    const sig2 = ai.getAnalysisSignature(convId) + ':changed';
    const hash2 = ai.inputHash(convId, sig2);
    expect(ai.findCachedRun('ticket_analysis', hash2, 'ticket_analysis_v1')).toBeUndefined();
  });

  it('signature changes when threads change', async () => {
    const { db, provider } = await setup();
    const ai = new AiRepository(db);
    const convRow = db.prepare('SELECT id, remote_id FROM conversations WHERE number = 5001').get() as { id: number; remote_id: number };
    const before = ai.getAnalysisSignature(convRow.id);
    provider.customerReplies(convRow.remote_id, 'New message changes the signature');
    // simulate the sync that would bring the thread in
    const coordinator = new SyncCoordinator(db, provider);
    await coordinator.syncSingleConversation(convRow.remote_id);
    const after = ai.getAnalysisSignature(convRow.id);
    expect(after).not.toBe(before);
  });
});

describe('backups (spec #61, #62)', () => {
  it('creates a verified backup with settings and lists it', async () => {
    const { db } = await setup();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-backup-'));
    const settings = new SettingsRepository(db);
    const backup = new BackupService(db, path.join(tmpDir, 'app.db'), settings, tmpDir);
    const result = backup.backup();
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.path).toBeDefined();
    expect(fs.existsSync(result.path!)).toBe(true);
    const list = backup.listBackups();
    expect(list.length).toBe(1);
    expect(list[0]?.verified).toBe(true);
    const settingsFile = list[0]?.file.replace(/\.db$/, '.settings.json');
    expect(fs.existsSync(path.join(tmpDir, settingsFile ?? ''))).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports conversations CSV with customer data scope note', async () => {
    const { db } = await setup();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-export-'));
    const settings = new SettingsRepository(db);
    const backup = new BackupService(db, path.join(tmpDir, 'app.db'), settings, tmpDir);
    const result = backup.exportConversationsCsv();
    expect(result.ok).toBe(true);
    const content = fs.readFileSync(result.path!, 'utf8');
    expect(content.split('\n').length).toBeGreaterThan(5);
    expect(content).toContain('number,subject,status');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('settings safety (spec #112, #14)', () => {
  it('automatic_reply_sending can NEVER be enabled, even if asked', async () => {
    const { db } = await setup();
    const settings = new SettingsRepository(db);
    const updated = settings.updateSettings({ automatic_reply_sending: true } as never);
    expect(updated.automatic_reply_sending).toBe(false);
  });
});
