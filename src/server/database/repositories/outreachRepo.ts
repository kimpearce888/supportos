import type { DB } from '../connection.js';
import { nowIso } from './helpers.js';
import type {
  SegmentDefinition,
  SavedSegment,
  CampaignSummary,
  CampaignDetail,
  CampaignRecipientRow,
  CampaignStatus,
  RecipientState,
  WhyLine,
  RecipientWhyTicket
} from '../../../shared/segmentation.js';

interface SegmentRow {
  id: number;
  name: string;
  description: string | null;
  condition_tree: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface CampaignRow {
  id: number;
  name: string;
  subject: string;
  body: string;
  mailbox_local_id: number | null;
  tags: string;
  status: string;
  segment_id: number | null;
  segment_snapshot: string | null;
  created_at: string;
  queued_at: string | null;
  completed_at: string | null;
}

interface RecipientRow {
  id: number;
  campaign_id: number;
  customer_local_id: number;
  customer_remote_id: number | null;
  email: string | null;
  snapshot: string;
  state: string;
  attempts: number;
  last_error: string | null;
  hs_conversation_remote_id: number | null;
  hs_conversation_number: number | null;
  sent_at: string | null;
  replied_at: string | null;
}

const EMPTY_TREE: SegmentDefinition = { combinator: 'all', conditions: [], exclude: [] };

/** Hard per-recipient attempt cap enforced at claim time (spec #31: never hammer one contact). */
const MAX_SEND_ATTEMPTS = 3;

function parseTree(raw: string | null): SegmentDefinition {
  if (!raw) return EMPTY_TREE;
  try {
    const parsed = JSON.parse(raw) as SegmentDefinition;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.conditions) && Array.isArray(parsed.exclude)) return parsed;
    return EMPTY_TREE;
  } catch {
    return EMPTY_TREE;
  }
}

/**
 * Outreach repository (v1.5.0): saved segments, campaigns, per-recipient
 * lifecycle, attempt log and the audit event trail. Every recipient stores a
 * selection SNAPSHOT (why-selected evidence + matching conversations +
 * property values at selection time) so "why did this customer receive this
 * email?" is answerable with actual evidence long after the segment changed
 * (spec #33/#34/#17).
 */
export class OutreachRepository {
  constructor(private db: DB) {}

  // ---------------- Saved segments ----------------

  listSegments(): SavedSegment[] {
    const rows = this.db.prepare('SELECT * FROM segments ORDER BY updated_at DESC').all() as SegmentRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      definition: parseTree(r.condition_tree),
      version: r.version,
      created_at: r.created_at,
      updated_at: r.updated_at
    }));
  }

  getSegment(id: number): SavedSegment | null {
    const row = this.db.prepare('SELECT * FROM segments WHERE id = ?').get(id) as SegmentRow | undefined;
    if (!row) return null;
    return { id: row.id, name: row.name, description: row.description, definition: parseTree(row.condition_tree), version: row.version, created_at: row.created_at, updated_at: row.updated_at };
  }

  saveSegment(input: { id?: number; name: string; description?: string | null; definition: SegmentDefinition }): number {
    const tree = JSON.stringify(input.definition);
    if (input.id != null) {
      const existing = this.db.prepare('SELECT version FROM segments WHERE id = ?').get(input.id) as { version: number } | undefined;
      if (!existing) return this.saveSegment({ name: input.name, description: input.description, definition: input.definition });
      this.db
        .prepare('UPDATE segments SET name = ?, description = ?, condition_tree = ?, version = version + 1, updated_at = datetime(\'now\') WHERE id = ?')
        .run(input.name, input.description ?? null, tree, input.id);
      return input.id;
    }
    const r = this.db.prepare('INSERT INTO segments (name, description, condition_tree) VALUES (?, ?, ?)').run(input.name, input.description ?? null, tree);
    return Number(r.lastInsertRowid);
  }

  deleteSegment(id: number): boolean {
    const r = this.db.prepare('DELETE FROM segments WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // ---------------- Campaigns ----------------

  createCampaign(input: {
    name: string;
    subject: string;
    body: string;
    mailbox_local_id: number;
    tags: string[];
    segment_id?: number | null;
    segment_snapshot?: SegmentDefinition | null;
    recipients: { customer_local_id: number; customer_remote_id: number | null; email: string | null; why: WhyLine[]; matching_tickets: RecipientWhyTicket[]; property_values: { name: string; value: string | null }[] }[];
  }): number {
    const tx = this.db.transaction(() => {
      const r = this.db
        .prepare('INSERT INTO outreach_campaigns (name, subject, body, mailbox_local_id, tags, status, segment_id, segment_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.name, input.subject, input.body, input.mailbox_local_id, JSON.stringify(input.tags), 'draft', input.segment_id ?? null, input.segment_snapshot ? JSON.stringify(input.segment_snapshot) : null);
      const campaignId = Number(r.lastInsertRowid);
      const ins = this.db.prepare('INSERT OR IGNORE INTO outreach_recipients (campaign_id, customer_local_id, customer_remote_id, email, snapshot) VALUES (?, ?, ?, ?, ?)');
      for (const rec of input.recipients) {
        ins.run(campaignId, rec.customer_local_id, rec.customer_remote_id, rec.email, JSON.stringify({ why: rec.why, matching_tickets: rec.matching_tickets, property_values: rec.property_values, selected_at: nowIso() }));
      }
      this.logEvent(campaignId, null, 'campaign_created', `${input.recipients.length} recipients snapshotted`);
      return campaignId;
    });
    return tx() as number;
  }

  listCampaigns(): CampaignSummary[] {
    const rows = this.db
      .prepare(
        `SELECT oc.*, m.name AS mailbox_name, s.name AS segment_name,
           (SELECT COUNT(*) FROM outreach_recipients r WHERE r.campaign_id = oc.id) AS recipients,
           (SELECT COUNT(*) FROM outreach_recipients r WHERE r.campaign_id = oc.id AND r.state = 'sent') AS sent,
           (SELECT COUNT(*) FROM outreach_recipients r WHERE r.campaign_id = oc.id AND r.state = 'failed') AS failed,
           (SELECT COUNT(*) FROM outreach_recipients r WHERE r.campaign_id = oc.id AND r.state = 'skipped') AS skipped,
           (SELECT COUNT(*) FROM outreach_recipients r WHERE r.campaign_id = oc.id AND r.state = 'unknown') AS unknown,
           (SELECT COUNT(*) FROM outreach_recipients r WHERE r.campaign_id = oc.id AND r.replied_at IS NOT NULL) AS replied
         FROM outreach_campaigns oc
         LEFT JOIN mailboxes m ON m.id = oc.mailbox_local_id
         LEFT JOIN segments s ON s.id = oc.segment_id
         ORDER BY oc.created_at DESC`
      )
      .all() as (CampaignRow & {
      mailbox_name: string | null;
      segment_name: string | null;
      recipients: number;
      sent: number;
      failed: number;
      skipped: number;
      unknown: number;
      replied: number;
    })[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      subject: r.subject,
      status: r.status as CampaignStatus,
      mailbox_local_id: r.mailbox_local_id,
      mailbox_name: r.mailbox_name,
      segment_id: r.segment_id,
      segment_name: r.segment_name,
      recipients: r.recipients,
      sent: r.sent,
      failed: r.failed,
      skipped: r.skipped,
      unknown: r.unknown,
      replied: r.replied,
      created_at: r.created_at,
      queued_at: r.queued_at,
      completed_at: r.completed_at
    }));
  }

  getCampaign(id: number): CampaignDetail | null {
    const row = this.db
      .prepare(
        `SELECT oc.*, m.name AS mailbox_name, s.name AS segment_name,
           (SELECT COUNT(*) FROM outreach_recipients r WHERE r.campaign_id = oc.id) AS recipients,
           (SELECT COUNT(*) FROM outreach_recipients r WHERE r.campaign_id = oc.id AND r.state = 'sent') AS sent,
           (SELECT COUNT(*) FROM outreach_recipients r WHERE r.campaign_id = oc.id AND r.state = 'failed') AS failed,
           (SELECT COUNT(*) FROM outreach_recipients r WHERE r.campaign_id = oc.id AND r.state = 'skipped') AS skipped,
           (SELECT COUNT(*) FROM outreach_recipients r WHERE r.campaign_id = oc.id AND r.state = 'unknown') AS unknown,
           (SELECT COUNT(*) FROM outreach_recipients r WHERE r.campaign_id = oc.id AND r.replied_at IS NOT NULL) AS replied
         FROM outreach_campaigns oc
         LEFT JOIN mailboxes m ON m.id = oc.mailbox_local_id
         LEFT JOIN segments s ON s.id = oc.segment_id
         WHERE oc.id = ?`
      )
      .get(id) as (CampaignRow & {
      mailbox_name: string | null;
      segment_name: string | null;
      recipients: number;
      sent: number;
      failed: number;
      skipped: number;
      unknown: number;
      replied: number;
    }) | undefined;
    if (!row) return null;
    const recipients = this.listRecipients(id, 1000);
    return {
      id: row.id,
      name: row.name,
      subject: row.subject,
      body: row.body,
      status: row.status as CampaignStatus,
      mailbox_local_id: row.mailbox_local_id,
      mailbox_name: row.mailbox_name,
      segment_id: row.segment_id,
      segment_name: row.segment_name,
      tags: JSON.parse(row.tags || '[]'),
      segment_snapshot: parseTree(row.segment_snapshot),
      recipients: row.recipients,
      sent: row.sent,
      failed: row.failed,
      skipped: row.skipped,
      unknown: row.unknown,
      replied: row.replied,
      created_at: row.created_at,
      queued_at: row.queued_at,
      completed_at: row.completed_at,
      recipients_list: recipients
    };
  }

  listRecipients(campaignId: number, limit = 500): CampaignRecipientRow[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, c.first_name, c.last_name
         FROM outreach_recipients r LEFT JOIN customers c ON c.id = r.customer_local_id
         WHERE r.campaign_id = ? ORDER BY c.last_name, c.first_name LIMIT ?`
      )
      .all(campaignId, limit) as (RecipientRow & { first_name: string | null; last_name: string | null })[];
    return rows.map((r) => {
      let snap: { why?: WhyLine[]; matching_tickets?: RecipientWhyTicket[] } = {};
      try {
        snap = JSON.parse(r.snapshot) as typeof snap;
      } catch {
        snap = {};
      }
      return {
        id: r.id,
        customer_local_id: r.customer_local_id,
        customer_remote_id: r.customer_remote_id,
        first_name: r.first_name,
        last_name: r.last_name,
        email: r.email,
        state: r.state as RecipientState,
        attempts: r.attempts,
        last_error: r.last_error,
        hs_conversation_remote_id: r.hs_conversation_remote_id,
        hs_conversation_number: r.hs_conversation_number,
        sent_at: r.sent_at,
        replied_at: r.replied_at,
        why: snap.why ?? [],
        matching_tickets: snap.matching_tickets ?? []
      };
    });
  }

  updateCampaignStatus(id: number, status: CampaignStatus): void {
    const extra = status === 'queued' ? ', queued_at = datetime(\'now\')' : status === 'completed' ? ', completed_at = datetime(\'now\')' : '';
    this.db.prepare(`UPDATE outreach_campaigns SET status = ?, updated_at = datetime('now')${extra} WHERE id = ?`).run(status, id);
  }

  deleteCampaign(id: number): boolean {
    const r = this.db.prepare('DELETE FROM outreach_campaigns WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // ---------------- Recipient lifecycle ----------------

  claimPendingRecipients(campaignId: number, batch: number): { id: number; customer_local_id: number; customer_remote_id: number | null; email: string | null; snapshot: string; attempts: number; campaign: { subject: string; body: string; mailbox_remote_id: number | null; tags: string[] } }[] {
    const campaign = this.db
      .prepare(
        `SELECT oc.subject, oc.body, oc.tags, m.remote_id AS mailbox_remote_id
         FROM outreach_campaigns oc LEFT JOIN mailboxes m ON m.id = oc.mailbox_local_id WHERE oc.id = ?`
      )
      .get(campaignId) as { subject: string; body: string; tags: string; mailbox_remote_id: number | null } | undefined;
    if (!campaign) return [];
    const rows = this.db
      .prepare(
        `SELECT id, customer_local_id, customer_remote_id, email, snapshot, attempts FROM outreach_recipients
         WHERE campaign_id = ? AND state IN ('selected','queued') AND attempts < ? ORDER BY id LIMIT ?`
      )
      .all(campaignId, MAX_SEND_ATTEMPTS, batch) as { id: number; customer_local_id: number; customer_remote_id: number | null; email: string | null; snapshot: string; attempts: number }[];
    const tx = this.db.transaction(() => {
      const upd = this.db.prepare("UPDATE outreach_recipients SET state = 'sending' WHERE id = ?");
      for (const r of rows) upd.run(r.id);
    });
    tx();
    return rows.map((r) => ({ ...r, campaign: { subject: campaign.subject, body: campaign.body, mailbox_remote_id: campaign.mailbox_remote_id, tags: JSON.parse(campaign.tags || '[]') } }));
  }

  countRemaining(campaignId: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ? AND state IN ('selected','queued','sending')").get(campaignId) as { n: number }).n;
  }

  markSent(recipientId: number, hsRemoteId: number, hsNumber: number | null): void {
    this.db
      .prepare("UPDATE outreach_recipients SET state = 'sent', hs_conversation_remote_id = ?, hs_conversation_number = ?, sent_at = datetime('now'), last_error = NULL WHERE id = ?")
      .run(hsRemoteId, hsNumber, recipientId);
  }

  markFailed(recipientId: number, error: string, permanent: boolean): void {
    this.db.prepare("UPDATE outreach_recipients SET state = ?, last_error = ? WHERE id = ?").run(permanent ? 'failed' : 'queued', error.slice(0, 500), recipientId);
  }

  markUnknown(recipientId: number, error: string): void {
    this.db.prepare("UPDATE outreach_recipients SET state = 'unknown', last_error = ? WHERE id = ?").run(error.slice(0, 500), recipientId);
  }

  markSkipped(recipientId: number, reason: string): void {
    this.db.prepare("UPDATE outreach_recipients SET state = 'skipped', last_error = ? WHERE id = ?").run(reason.slice(0, 500), recipientId);
  }

  listUnknownRecipients(campaignId: number): { id: number; customer_remote_id: number | null; email: string | null; started_at: string | null; subject: string }[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.customer_remote_id, r.email, r.campaign_id, oc.subject,
           (SELECT a.started_at FROM outreach_attempts a WHERE a.recipient_id = r.id ORDER BY a.id DESC LIMIT 1) AS started_at
         FROM outreach_recipients r JOIN outreach_campaigns oc ON oc.id = r.campaign_id
         WHERE r.campaign_id = ? AND r.state = 'unknown'`
      )
      .all(campaignId) as { id: number; customer_remote_id: number | null; email: string | null; started_at: string | null; subject: string }[];
    return rows;
  }

  setReplied(recipientId: number, at: string | null): void {
    this.db.prepare('UPDATE outreach_recipients SET replied_at = ? WHERE id = ?').run(at, recipientId);
  }

  /** Retry control (spec #32): retry failed, cancel remaining. */
  resetFailedToQueued(campaignId: number): number {
    // v1.6.0 audit fix: a manual retry also resets the attempt budget - without
    // this, re-queued rows kept attempts=3 and were swept straight back to
    // 'failed' (or never claimed), making Retry failed a silent no-op.
    const r = this.db.prepare("UPDATE outreach_recipients SET state = 'queued', attempts = 0, last_error = 'retried at ' || datetime('now') WHERE campaign_id = ? AND state = 'failed'").run(campaignId);
    return r.changes;
  }

  // v1.6.0 audit fix: see campaignService.sendBatch - rows that exhausted their
  // attempt budget while still queued/selected are terminally failed here so
  // the campaign can complete instead of re-enqueueing forever.
  sweepExhaustedRecipients(campaignId: number): number {
    const r = this.db
      .prepare("UPDATE outreach_recipients SET state = 'failed', last_error = 'Exceeded max send attempts' WHERE campaign_id = ? AND state IN ('selected','queued') AND attempts >= ?")
      .run(campaignId, MAX_SEND_ATTEMPTS);
    return r.changes;
  }

  cancelRemaining(campaignId: number): number {
    const r = this.db.prepare("UPDATE outreach_recipients SET state = 'cancelled' WHERE campaign_id = ? AND state IN ('selected','queued')").run(campaignId);
    return r.changes;
  }

  // ---------------- Attempts + events (audit trail) ----------------

  startAttempt(recipientId: number): number {
    const attemptNo = (this.db.prepare('SELECT attempts FROM outreach_recipients WHERE id = ?').get(recipientId) as { attempts: number }).attempts + 1;
    this.db.prepare('UPDATE outreach_recipients SET attempts = attempts + 1 WHERE id = ?').run(recipientId);
    const r = this.db.prepare("INSERT INTO outreach_attempts (recipient_id, attempt_no, started_at) VALUES (?, ?, datetime('now'))").run(recipientId, attemptNo);
    return Number(r.lastInsertRowid);
  }

  finishAttempt(attemptId: number, result: 'sent' | 'failed' | 'unknown', error?: string | null): void {
    this.db.prepare("UPDATE outreach_attempts SET finished_at = datetime('now'), result = ?, error = ? WHERE id = ?").run(result, error?.slice(0, 500) ?? null, attemptId);
  }

  logEvent(campaignId: number, recipientId: number | null, event: string, detail?: string | null): void {
    this.db.prepare('INSERT INTO outreach_events (campaign_id, recipient_id, event, detail) VALUES (?, ?, ?, ?)').run(campaignId, recipientId, event, detail?.slice(0, 500) ?? null);
  }

  listEvents(campaignId: number, limit = 200): { id: number; recipient_id: number | null; event: string; detail: string | null; at: string }[] {
    return this.db.prepare('SELECT id, recipient_id, event, detail, at FROM outreach_events WHERE campaign_id = ? ORDER BY id DESC LIMIT ?').all(campaignId, limit) as {
      id: number;
      recipient_id: number | null;
      event: string;
      detail: string | null;
      at: string;
    }[];
  }

  // ---------------- Do Not Contact ----------------

  listDnc(): { customer_local_id: number; first_name: string | null; last_name: string | null; reason: string | null; created_at: string }[] {
    return this.db
      .prepare(
        `SELECT d.customer_local_id, c.first_name, c.last_name, d.reason, d.created_at
         FROM do_not_contact d LEFT JOIN customers c ON c.id = d.customer_local_id ORDER BY d.created_at DESC`
      )
      .all() as { customer_local_id: number; first_name: string | null; last_name: string | null; reason: string | null; created_at: string }[];
  }

  addDnc(customerLocalId: number, reason?: string | null): void {
    this.db.prepare('INSERT INTO do_not_contact (customer_local_id, reason) VALUES (?, ?) ON CONFLICT(customer_local_id) DO UPDATE SET reason = excluded.reason').run(customerLocalId, reason ?? null);
  }

  // v1.6.0 audit fix: report whether a row was actually removed (routes 404 otherwise).
  removeDnc(customerLocalId: number): boolean {
    const r = this.db.prepare('DELETE FROM do_not_contact WHERE customer_local_id = ?').run(customerLocalId);
    return r.changes > 0;
  }
}
