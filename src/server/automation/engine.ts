import type { DB } from '../database/connection.js';
import type { AutomationRule, AutomationRunRecord, AutomationActionKind } from '../../shared/types.js';
import { JobRepository } from '../database/repositories/jobRepo.js';
import { SettingsRepository } from '../database/repositories/settingsRepo.js';
import { AiRepository } from '../database/repositories/aiRepo.js';

type Condition = { field: string; operator: 'contains' | 'equals' | 'gt' | 'lt'; value: string };
type Action = { kind: AutomationActionKind; params: Record<string, string> };

/**
 * Local automation/rules engine (spec #64, #65). Distinct from Help Scout workflows.
 * Safety tiers: read / non-destructive write / destructive-customer-facing write.
 * Higher-risk actions ALWAYS require explicit approval while
 * automation_write_actions_enabled is OFF (safe default).
 */
export class AutomationEngine {
  private jobs: JobRepository;
  private settings: SettingsRepository;
  private ai: AiRepository;

  constructor(private db: DB) {
    this.jobs = new JobRepository(db);
    this.settings = new SettingsRepository(db);
    this.ai = new AiRepository(db);
  }

  static readonly RISK_TIERS: Record<AutomationActionKind, 'read' | 'non_destructive' | 'higher_risk'> = {
    analyze_ticket: 'read',
    search_similar: 'read',
    check_known_issues: 'read',
    create_ai_note: 'non_destructive',
    create_ai_draft: 'non_destructive',
    add_tag: 'non_destructive',
    manual_review_queue: 'non_destructive',
    set_status: 'higher_risk',
    assign: 'higher_risk'
  };

  listRules(): AutomationRule[] {
    const rows = this.db.prepare('SELECT * FROM automation_rules ORDER BY priority, id').all() as (Record<string, unknown>)[];
    return rows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      enabled: Number(r.enabled) === 1 ? 1 : 0,
      trigger: String(r.trigger) as AutomationRule['trigger'],
      conditions: JSON.parse(String(r.conditions ?? '[]')) as Condition[],
      actions: JSON.parse(String(r.actions ?? '[]')) as Action[],
      priority: Number(r.priority),
      requires_approval: Number(r.requires_approval) === 1 ? 1 : 0,
      last_run_at: (r.last_run_at as string | null) ?? null,
      run_count: Number(r.run_count ?? 0)
    }));
  }

  createRule(rule: { name: string; enabled?: boolean; trigger: AutomationRule['trigger']; conditions: Condition[]; actions: Action[]; priority?: number; requires_approval?: boolean }): number {
    const r = this.db
      .prepare('INSERT INTO automation_rules (name, enabled, trigger, conditions, actions, priority, requires_approval) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(rule.name, rule.enabled ? 1 : 0, rule.trigger, JSON.stringify(rule.conditions), JSON.stringify(rule.actions), rule.priority ?? 100, rule.requires_approval === false ? 0 : 1);
    return Number(r.lastInsertRowid);
  }

  updateRule(id: number, patch: Partial<Omit<AutomationRule, 'id'>>): void {
    const sets: string[] = [];
    const args: Record<string, unknown> = { id };
    if (patch.name !== undefined) {
      sets.push('name = @name');
      args.name = patch.name;
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = @enabled');
      args.enabled = patch.enabled ? 1 : 0;
    }
    if (patch.trigger !== undefined) {
      sets.push('trigger = @trigger');
      args.trigger = patch.trigger;
    }
    if (patch.conditions !== undefined) {
      sets.push('conditions = @conditions');
      args.conditions = JSON.stringify(patch.conditions);
    }
    if (patch.actions !== undefined) {
      sets.push('actions = @actions');
      args.actions = JSON.stringify(patch.actions);
    }
    if (patch.priority !== undefined) {
      sets.push('priority = @priority');
      args.priority = patch.priority;
    }
    if (patch.requires_approval !== undefined) {
      sets.push('requires_approval = @requires_approval');
      args.requires_approval = patch.requires_approval ? 1 : 0;
    }
    if (sets.length > 0) this.db.prepare(`UPDATE automation_rules SET ${sets.join(', ')} WHERE id = @id`).run(args);
  }

  deleteRule(id: number): void {
    this.db.prepare('DELETE FROM automation_rules WHERE id = ?').run(id);
  }

  listRuns(limit = 100): AutomationRunRecord[] {
    return this.db.prepare('SELECT * FROM automation_runs ORDER BY id DESC LIMIT ?').all(limit) as AutomationRunRecord[];
  }

  /**
   * Fire triggers for a conversation. Returns executed runs.
   * Never destructive by default: higher-risk actions are queued as awaiting approval
   * unless automation_write_actions_enabled is explicitly ON.
   */
  async fireTrigger(trigger: AutomationRule['trigger'], conversationId: number): Promise<AutomationRunRecord[]> {
    const appSettings = this.settings.getAllSettings();
    if (!appSettings.automation_enabled) return [];
    const conv = this.db
      .prepare(
        `SELECT c.id, c.number, c.subject, c.preview, c.mailbox_local_id,
           (SELECT GROUP_CONCAT(t.name) FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = c.id) AS tags,
           (SELECT m.name FROM mailboxes m WHERE m.id = c.mailbox_local_id) AS mailbox_name
         FROM conversations c WHERE c.id = ?`
      )
      .get(conversationId) as
      | { id: number; number: number; subject: string | null; preview: string | null; mailbox_local_id: number | null; tags: string | null; mailbox_name: string | null }
      | undefined;
    if (!conv) return [];
    const analysis = this.ai.getLatestAnalysis(conversationId);
    const runs: AutomationRunRecord[] = [];
    for (const rule of this.listRules().filter((r) => r.enabled && r.trigger === trigger)) {
      const matched = rule.conditions.every((cond) => this.matches(conv, analysis?.analysis ?? null, cond));
      if (!matched) {
        this.record(rule.id, conversationId, 'skipped', 'Conditions not matched');
        continue;
      }
      const writeEnabled = appSettings.automation_write_actions_enabled;
      for (const action of rule.actions) {
        const tier = AutomationEngine.RISK_TIERS[action.kind] ?? 'read';
        if (tier === 'read') {
          await this.executeReadAction(action.kind, conversationId);
          this.record(rule.id, conversationId, 'completed', `Executed read action ${action.kind}`);
        } else if (tier === 'non_destructive') {
          if (rule.requires_approval && !writeEnabled) {
            this.jobs.enqueue('ai', 'automation_action_awaiting_approval', { ruleId: rule.id, conversationId, action }, 2, 1);
            this.record(rule.id, conversationId, 'awaiting_approval', `Action ${action.kind} requires approval (non-destructive)`);
          } else {
            await this.executeNonDestructive(action.kind, conversationId, action.params);
            this.record(rule.id, conversationId, 'completed', `Executed ${action.kind}`);
          }
        } else {
          // higher-risk: always requires explicit approval in v1
          this.jobs.enqueue('ai', 'automation_action_awaiting_approval', { ruleId: rule.id, conversationId, action }, 2, 1);
          this.record(rule.id, conversationId, 'awaiting_approval', `Action ${action.kind} is a write action and requires explicit approval`);
        }
      }
      this.db.prepare("UPDATE automation_rules SET run_count = run_count + 1, last_run_at = datetime('now') WHERE id = ?").run(rule.id);
      const last = this.db.prepare('SELECT * FROM automation_runs ORDER BY id DESC LIMIT 1').get() as AutomationRunRecord;
      runs.push(last);
    }
    return runs;
  }

  private matches(conv: { subject: string | null; preview: string | null; tags: string | null; mailbox_name: string | null }, analysis: { intent: string | null; known_issue_candidate: string | null; confidence: string } | null, cond: Condition): boolean {
    const value = cond.value.toLowerCase();
    switch (cond.field) {
      case 'subject':
        return cond.operator === 'contains' ? (conv.subject ?? '').toLowerCase().includes(value) : (conv.subject ?? '').toLowerCase() === value;
      case 'body':
        return (conv.preview ?? '').toLowerCase().includes(value);
      case 'tag':
        return (conv.tags ?? '').toLowerCase().split(',').some((t) => (cond.operator === 'contains' ? t.includes(value) : t.trim() === value));
      case 'mailbox':
        return (conv.mailbox_name ?? '').toLowerCase().includes(value);
      case 'confidence': {
        const levels = ['unknown', 'low', 'medium', 'high'];
        const idx = levels.indexOf(analysis?.confidence ?? 'unknown');
        const target = levels.indexOf(value);
        if (cond.operator === 'lt') return idx < target;
        if (cond.operator === 'gt') return idx > target;
        return idx === target;
      }
      case 'known_issue_match':
        return !!analysis?.known_issue_candidate && analysis.known_issue_candidate.toLowerCase().includes(value);
      default:
        return false;
    }
  }

  private async executeReadAction(kind: AutomationActionKind, conversationId: number): Promise<void> {
    if (kind === 'analyze_ticket') {
      // enqueued as a job so the AI worker handles it with normal retries
      this.jobs.enqueue('ai', 'analyze_ticket', { conversationId }, 3, 2);
    }
    // search_similar / check_known_issues are performed as part of analyze_ticket evidence
  }

  // v1.6.0 audit fix: public entry point for APPROVED awaiting-approval jobs -
  // the worker calls this after a human approves the parked action in the Queue
  // panel. Same dispatch as the non-destructive path.
  async executeApprovedAction(kind: AutomationActionKind, conversationId: number, params: Record<string, string>): Promise<void> {
    await this.executeNonDestructive(kind, conversationId, params);
  }

  recordApprovedRun(ruleId: number, conversationId: number, kind: string): void {
    this.record(ruleId, conversationId, 'completed', `Approved by human: executed ${kind}`);
  }

  private async executeNonDestructive(kind: AutomationActionKind, conversationId: number, params: Record<string, string>): Promise<void> {
    if (kind === 'create_ai_note') {
      this.jobs.enqueue('ai', 'create_ai_note', { conversationId }, 2, 1);
    } else if (kind === 'create_ai_draft') {
      this.jobs.enqueue('ai', 'generate_draft', { conversationId }, 2, 1);
    } else if (kind === 'add_tag' && params.tag) {
      this.jobs.enqueue('api', 'add_tag', { conversationId, tag: params.tag }, 1, 2);
    } else if (kind === 'manual_review_queue') {
      this.db.prepare('UPDATE conversations SET is_unread = 1 WHERE id = ?').run(conversationId);
    }
  }

  private record(ruleId: number, conversationId: number | null, status: AutomationRunRecord['status'], detail: string): void {
    this.db.prepare('INSERT INTO automation_runs (rule_id, conversation_id, status, detail) VALUES (?, ?, ?, ?)').run(ruleId, conversationId, status, detail);
  }
}
