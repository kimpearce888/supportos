import type { DB } from '../database/connection.js';
import type { HelpScoutProvider } from '../integrations/helpscout/provider.js';
import { HelpScoutApiError } from '../integrations/helpscout/client.js';
import type { OutreachRepository } from '../database/repositories/outreachRepo.js';
import type { PeopleRepository } from '../database/repositories/peopleRepo.js';
import type { JobRepository } from '../database/repositories/jobRepo.js';
import type { CampaignValidation, RenderedMessage, RecipientWhyTicket } from '../../shared/segmentation.js';
import { PERSONALIZATION_VARIABLES } from '../../shared/segmentation.js';
import { serverEventBus } from '../services/eventBus.js';

/** Recipients per background job - small batches keep the queue fair (spec #29). */
const SEND_BATCH = 5;
/** Hard per-recipient attempt cap - never hammer one contact forever (spec #31). */
const MAX_ATTEMPTS = 3;

interface PersonalizationContext {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  organization: string | null;
  last_ticket_number: number | null;
  last_ticket_subject: string | null;
}

/**
 * CampaignService (v1.5.0): orchestration for Client Segmentation & Outreach.
 *
 * Pipeline (spec #29/#30/#31): campaign -> recipient jobs -> the SAME priority
 * API queue + rate limiter every other Help Scout write uses (customer-visible
 * sends go out at USER_SEND priority, below nothing). Nothing is sent in
 * parallel: the worker claims a small batch, renders personalization from the
 * recipient's own snapshot, sends one independent conversation per customer
 * and records the full attempt trail.
 *
 * Timeout policy (spec #31): a network error or 504 after the request left
 * means "may or may not have been delivered" - the recipient lands in UNKNOWN
 * and reconciliation (by customer + subject + time window) decides before any
 * retry. It is never blindly resent.
 */
export class CampaignService {
  constructor(
    private db: DB,
    private provider: HelpScoutProvider,
    private outreach: OutreachRepository,
    private people: PeopleRepository,
    private jobsRepo: JobRepository
  ) {}

  // ---------------- Personalization ----------------

  /** Variables available to campaign bodies, resolved from the recipient's own data (spec #24). */
  personalizationContext(customerLocalId: number, matchingTickets: RecipientWhyTicket[]): PersonalizationContext {
    const c = this.db
      .prepare(
        `SELECT c.first_name, c.last_name, o.name AS organization
         FROM customers c LEFT JOIN organizations o ON o.id = c.organization_id WHERE c.id = ?`
      )
      .get(customerLocalId) as { first_name: string | null; last_name: string | null; organization: string | null } | undefined;
    const last = matchingTickets[0] ?? null;
    return {
      first_name: c?.first_name ?? null,
      last_name: c?.last_name ?? null,
      company: c?.organization ?? null,
      organization: c?.organization ?? null,
      last_ticket_number: last?.number ?? null,
      last_ticket_subject: last?.subject ?? null
    };
  }

  /** Render {{variables}}; unresolved ones are reported, never silently swallowed (spec #27). */
  render(text: string, ctx: PersonalizationContext): { text: string; unresolved: string[] } {
    const unresolved: string[] = [];
    const out = text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, rawName: string) => {
      const name = rawName.toLowerCase();
      if (!(PERSONALIZATION_VARIABLES as readonly string[]).includes(name)) {
        // Unknown variable: left verbatim AND flagged - validation must catch
        // placeholders that would ship literally to customers (spec #27).
        unresolved.push(name);
        return `{{${rawName}}}`;
      }
      const v = (ctx as unknown as Record<string, unknown>)[name];
      if (v == null || v === '') {
        unresolved.push(name);
        return '';
      }
      return String(v);
    });
    return { text: out, unresolved };
  }

  /** Render subject+body for one recipient (preview + send share ONE implementation, spec #26). */
  renderFor(customerLocalId: number, matchingTickets: RecipientWhyTicket[], subject: string, body: string): RenderedMessage {
    const ctx = this.personalizationContext(customerLocalId, matchingTickets);
    const s = this.render(subject, ctx);
    const b = this.render(body, ctx);
    return { subject: s.text, body: b.text, unresolved: [...s.unresolved, ...b.unresolved] };
  }

  // ---------------- Validation (spec #27) ----------------

  validate(campaignId: number): CampaignValidation {
    const campaign = this.outreach.getCampaign(campaignId);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!campaign) {
      return { ok: false, errors: ['Campaign not found.'], warnings, counts: { recipients: 0, ready: 0, invalid_email: 0, already_sent: 0, on_dnc: 0, no_email: 0 } };
    }
    if (!campaign.subject.trim()) errors.push('Subject is empty.');
    if (!campaign.body.trim()) errors.push('Message body is empty.');
    if (campaign.mailbox_local_id == null) errors.push('No sending mailbox selected.');
    else {
      const mailbox = this.db.prepare('SELECT remote_id FROM mailboxes WHERE id = ?').get(campaign.mailbox_local_id) as { remote_id: number } | undefined;
      if (!mailbox) errors.push('The selected mailbox no longer exists.');
    }
    // v1.5.0 audit fix: counts are computed over ALL recipients with SQL, not
    // over the (capped) recipients_list - a >1000-recipient campaign used to be
    // under-validated and could be refused despite being fully sendable.
    const dnc = new Set((this.db.prepare('SELECT customer_local_id FROM do_not_contact').all() as { customer_local_id: number }[]).map((r) => r.customer_local_id));
    const emailOk = (e: string | null): boolean => e != null && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
    let ready = 0;
    let invalidEmail = 0;
    let alreadySent = 0;
    let onDnc = 0;
    let noEmail = 0;
    const allRecipients = this.db
      .prepare('SELECT customer_local_id, email, state FROM outreach_recipients WHERE campaign_id = ?')
      .all(campaignId) as { customer_local_id: number; email: string | null; state: string }[];
    for (const r of allRecipients) {
      if (r.state === 'sent') alreadySent++;
      if (r.state === 'sent' || r.state === 'cancelled') continue;
      if (dnc.has(r.customer_local_id)) {
        onDnc++;
        continue;
      }
      if (!r.email) {
        noEmail++;
        continue;
      }
      if (!emailOk(r.email)) {
        invalidEmail++;
        continue;
      }
      ready++;
    }
    if (alreadySent > 0) warnings.push(`${alreadySent} recipient(s) were already sent this campaign and will not be sent again.`);
    if (onDnc > 0) warnings.push(`${onDnc} recipient(s) are on the Do-Not-Contact list and will be skipped.`);
    if (noEmail > 0) warnings.push(`${noEmail} recipient(s) have no usable email address and will be skipped.`);
    if (invalidEmail > 0) errors.push(`${invalidEmail} recipient(s) have an invalid email address.`);
    if (ready === 0) errors.push('No recipients are ready to send.');
    // Personalization variables must resolve or be knowingly empty (spec #27: no unresolved placeholders)
    const sample = campaign.recipients_list.slice(0, 25);
    const unresolvedVars = new Set<string>();
    for (const r of sample) {
      const rendered = this.renderFor(r.customer_local_id, r.matching_tickets, campaign.subject, campaign.body);
      for (const v of rendered.unresolved) unresolvedVars.add(v);
    }
    if (unresolvedVars.size > 0) warnings.push(`Personalization variable(s) with no value for some recipients: ${[...unresolvedVars].join(', ')} (they render as empty text).`);
    return { ok: errors.length === 0, errors, warnings, counts: { recipients: campaign.recipients, ready, invalid_email: invalidEmail, already_sent: alreadySent, on_dnc: onDnc, no_email: noEmail } };
  }

  // ---------------- Sending ----------------

  /** Queue a campaign: validate, mark queued, enqueue the first batch job. */
  queue(campaignId: number): { ok: boolean; message: string } {
    const campaign = this.outreach.getCampaign(campaignId);
    if (!campaign) return { ok: false, message: 'Campaign not found.' };
    if (campaign.status !== 'draft' && campaign.status !== 'paused') return { ok: false, message: `Campaign is ${campaign.status}; only draft or paused campaigns can be queued.` };
    const validation = this.validate(campaignId);
    if (!validation.ok) return { ok: false, message: `Validation failed: ${validation.errors.join(' ')}` };
    this.outreach.updateCampaignStatus(campaignId, 'queued');
    this.outreach.logEvent(campaignId, null, 'campaign_queued', `${validation.counts.ready} ready of ${validation.counts.recipients}`);
    this.jobsRepo.enqueue('outreach', 'outreach_send_batch', { campaignId }, 1, 5);
    this.emitProgress(campaignId);
    return { ok: true, message: `Campaign queued: ${validation.counts.ready} conversations will be created (one per customer).` };
  }

  /**
   * One send pass (job worker): claim a small batch, send each independently,
   * re-enqueue while recipients remain. Sends go through the provider's API
   * queue at USER_SEND priority - the same queue and rate limiter as manual
   * replies, protecting the account from Help Scout rate limits (spec #29).
   */
  async sendBatch(campaignId: number): Promise<{ sent: number; failed: number; unknown: number; remaining: number }> {
    const campaign = this.outreach.getCampaign(campaignId);
    if (!campaign) return { sent: 0, failed: 0, unknown: 0, remaining: 0 };
    if (campaign.status === 'paused' || campaign.status === 'cancelled') {
      // Any recipients stuck mid-batch when pause landed are returned to queued
      this.db.prepare("UPDATE outreach_recipients SET state = 'queued' WHERE campaign_id = ? AND state = 'sending'").run(campaignId);
      this.outreach.logEvent(campaignId, null, `campaign_${campaign.status}`, null);
      return { sent: 0, failed: 0, unknown: 0, remaining: this.outreach.countRemaining(campaignId) };
    }
    if (campaign.status === 'completed') return { sent: 0, failed: 0, unknown: 0, remaining: 0 };
    if (campaign.status === 'draft') this.outreach.updateCampaignStatus(campaignId, 'sending');
    // v1.5.0 audit fix: recipients claimed by a batch that died with the process
    // (state='sending', nothing running it) would be stuck forever - countRemaining()
    // includes them but claimPendingRecipients() never picks them. The worker is
    // strictly sequential (one sendBatch at a time), so returning stale 'sending'
    // rows to the queue here can never race a live batch.
    this.db.prepare("UPDATE outreach_recipients SET state = 'queued' WHERE campaign_id = ? AND state = 'sending'").run(campaignId);

    // v1.6.0 audit fix (HIGH - send-queue livelock): claimPendingRecipients()
    // filters `attempts < MAX_SEND_ATTEMPTS` while countRemaining() counts ALL
    // selected/queued rows. A recipient that failed MAX times with a RETRYABLE
    // error ended up state='queued', attempts=3: never claimable again, but
    // still counted as remaining -> sendBatch re-enqueued itself forever and
    // the campaign could never complete. Sweep those rows to 'failed' up front
    // so remaining reaches zero and the reconcile/completion path runs.
    const capped = this.outreach.sweepExhaustedRecipients(campaignId);
    if (capped > 0) {
      this.outreach.logEvent(campaignId, null, 'recipients_failed_max_attempts', `${capped} recipient(s) exceeded ${MAX_ATTEMPTS} send attempts and are marked failed. Use Retry failed to give them a fresh attempt budget.`);
    }

    const dnc = new Set((this.db.prepare('SELECT customer_local_id FROM do_not_contact').all() as { customer_local_id: number }[]).map((r) => r.customer_local_id));
    const batch = this.outreach.claimPendingRecipients(campaignId, SEND_BATCH);
    let sent = 0;
    let failed = 0;
    let unknown = 0;
    for (const r of batch) {
      if (dnc.has(r.customer_local_id)) {
        this.outreach.markSkipped(r.id, 'On the Do-Not-Contact list');
        this.outreach.logEvent(campaignId, r.id, 'recipient_skipped', 'do-not-contact');
        continue;
      }
      if (r.attempts >= MAX_ATTEMPTS) {
        // claimPending should filter these; guard anyway (belt + suspenders)
        this.outreach.markFailed(r.id, `Exceeded ${MAX_ATTEMPTS} attempts`, true);
        failed++;
        continue;
      }
      let matchingTickets: RecipientWhyTicket[] = [];
      try {
        matchingTickets = (JSON.parse(r.snapshot) as { matching_tickets?: RecipientWhyTicket[] }).matching_tickets ?? [];
      } catch {
        matchingTickets = [];
      }
      const rendered = this.renderFor(r.customer_local_id, matchingTickets, r.campaign.subject, r.campaign.body);
      const attemptId = this.outreach.startAttempt(r.id);
      try {
        if (r.campaign.mailbox_remote_id == null) throw new HelpScoutApiError(0, 'No mailbox remote id', 'The sending mailbox could not be resolved.', null, false);
        const result = await this.provider.createConversation({
          subject: rendered.subject,
          mailboxRemoteId: r.campaign.mailbox_remote_id,
          text: rendered.body,
          customerRemoteId: r.customer_remote_id,
          customerEmail: r.email,
          tags: r.campaign.tags
        });
        this.outreach.markSent(r.id, result.conversationRemoteId, result.number);
        this.outreach.finishAttempt(attemptId, 'sent', null);
        this.outreach.logEvent(campaignId, r.id, 'recipient_sent', `conversation ${result.number ?? result.conversationRemoteId}${result.createdCustomer ? ' (created new Help Scout contact)' : ''}`);
        // v1.6.0 audit fix: the created conversation used to land in the local
        // mirror only on the NEXT 5-minute incremental tick - the operator saw
        // 'sent' with nothing in the Inbox. Enqueue the single-conversation sync
        // immediately (same path simulate-incoming and webhooks use).
        this.jobsRepo.enqueue('sync', 'sync_conversation', { remoteId: result.conversationRemoteId, source: 'outreach' }, 2, 3);
        sent++;
      } catch (e) {
        const err = e as HelpScoutApiError;
        const msg = err instanceof Error ? err.message : String(e);
        // Timeout semantics (spec #31): the request MAY have been delivered.
        const ambiguous = err instanceof HelpScoutApiError && (err.statusCode === 0 || err.statusCode === 504) && err.retryable;
        const permanent = err instanceof HelpScoutApiError && !err.retryable;
        if (ambiguous) {
          this.outreach.markUnknown(r.id, `Ambiguous outcome: ${msg}`);
          this.outreach.finishAttempt(attemptId, 'unknown', msg);
          this.outreach.logEvent(campaignId, r.id, 'recipient_unknown', msg);
          unknown++;
        } else {
          this.outreach.markFailed(r.id, msg, permanent);
          this.outreach.finishAttempt(attemptId, 'failed', msg);
          this.outreach.logEvent(campaignId, r.id, 'recipient_failed', msg);
          failed++;
        }
      }
    }

    const remaining = this.outreach.countRemaining(campaignId);
    if (remaining > 0) {
      this.jobsRepo.enqueue('outreach', 'outreach_send_batch', { campaignId }, 1, 5);
    } else {
      // No selected/queued/sending left. Reconcile unknowns before declaring completion.
      this.jobsRepo.enqueue('outreach', 'outreach_reconcile', { campaignId }, 1, 5);
    }
    this.emitProgress(campaignId);
    return { sent, failed, unknown, remaining };
  }

  /**
   * Resolve UNKNOWN recipients (spec #31): did a matching conversation appear
   * for that customer after the attempt started? If yes -> sent. If no ->
   * safe to retry (attempts cap still applies). Runs after every batch
   * finishes and can be triggered manually from the campaign monitor.
   */
  async reconcile(campaignId: number): Promise<{ resolvedSent: number; returnedToQueue: number; stillUnknown: number }> {
    const unknowns = this.outreach.listUnknownRecipients(campaignId);
    let resolvedSent = 0;
    let returned = 0;
    let stillUnknown = 0;
    for (const u of unknowns) {
      if (u.customer_remote_id == null) {
        this.outreach.markFailed(u.id, 'Unknown outcome and no customer id to reconcile against', true);
        continue;
      }
      try {
        const page = await this.provider.listConversations({ status: 'all', contactId: u.customer_remote_id, pageSize: 50 });
        const cutoff = u.started_at ? new Date(u.started_at.replace(' ', 'T') + 'Z').getTime() : 0;
        const match = page.items.find((c) => (c.subject ?? '').trim().toLowerCase() === (u.subject ?? '').trim().toLowerCase() && new Date(c.createdAt ?? 0).getTime() >= cutoff - 60_000);
        const attempts = (this.db.prepare('SELECT attempts FROM outreach_recipients WHERE id = ?').get(u.id) as { attempts: number }).attempts;
        if (match) {
          this.outreach.markSent(u.id, match.remoteId, match.number);
          this.outreach.logEvent(campaignId, u.id, 'recipient_reconciled_sent', `found conversation ${match.number}`);
          resolvedSent++;
        } else if (attempts < MAX_ATTEMPTS) {
          this.outreach.markFailed(u.id, 'Reconciled: not delivered, safe to retry', false);
          this.outreach.logEvent(campaignId, u.id, 'recipient_reconciled_retry', null);
          returned++;
        } else {
          this.outreach.logEvent(campaignId, u.id, 'recipient_reconciled_unknown', 'not found but attempts exhausted');
          stillUnknown++;
        }
      } catch (e) {
        this.outreach.logEvent(campaignId, u.id, 'reconcile_error', String(e));
        stillUnknown++;
      }
    }
    const remaining = this.outreach.countRemaining(campaignId);
    if (remaining > 0) {
      this.jobsRepo.enqueue('outreach', 'outreach_send_batch', { campaignId }, 1, 5);
    } else if (stillUnknown === 0 && resolvedSent >= 0) {
      const campaign = this.outreach.getCampaign(campaignId);
      if (campaign && campaign.status !== 'completed' && campaign.status !== 'cancelled' && campaign.status !== 'paused') {
        this.outreach.updateCampaignStatus(campaignId, 'completed');
        this.outreach.logEvent(campaignId, null, 'campaign_completed', `${campaign.sent} sent, ${campaign.failed} failed, ${campaign.skipped} skipped`);
      }
    }
    this.emitProgress(campaignId);
    return { resolvedSent, returnedToQueue: returned, stillUnknown };
  }

  // ---------------- Reply intelligence (spec #51/#52) ----------------

  /**
   * Update replied_at for sent recipients from the LOCAL mirror: a customer
   * thread arriving after our sent_at = a reply. Honest note: this reflects
   * the local mirror (sync-dependent), not a delivery-read receipt.
   */
  refreshReplies(campaignId: number): number {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.hs_conversation_remote_id, r.sent_at FROM outreach_recipients r
         WHERE r.campaign_id = ? AND r.state = 'sent' AND r.replied_at IS NULL AND r.hs_conversation_remote_id IS NOT NULL`
      )
      .all(campaignId) as { id: number; hs_conversation_remote_id: number; sent_at: string | null }[];
    let replied = 0;
    for (const r of rows) {
      const conv = this.db.prepare('SELECT id FROM conversations WHERE remote_id = ?').get(r.hs_conversation_remote_id) as { id: number } | undefined;
      if (!conv) continue;
      const customerThread = this.db
        .prepare(
          `SELECT remote_created_at FROM threads
           WHERE conversation_id = ? AND type = 'customer' AND deleted_at IS NULL
             AND julianday(remote_created_at) > julianday(COALESCE(?, '1970-01-01')) ORDER BY remote_created_at ASC LIMIT 1`
        )
        .get(conv.id, r.sent_at) as { remote_created_at: string } | undefined;
      if (customerThread) {
        this.outreach.setReplied(r.id, customerThread.remote_created_at);
        this.outreach.logEvent(campaignId, r.id, 'recipient_replied', null);
        replied++;
      }
    }
    return replied;
  }

  /** Campaign outcome report (spec #52) - conversation outcomes, honestly labeled. */
  report(campaignId: number): {
    campaign: { id: number; name: string; status: string } | null;
    totals: { recipients: number; sent: number; failed: number; skipped: number; cancelled: number; unknown: number; replied: number; reply_rate: number | null };
    replies: { customer: string; conversation_number: number | null; conversation_local_id: number | null; replied_at: string | null }[];
    note: string;
  } {
    const campaign = this.outreach.getCampaign(campaignId);
    if (!campaign) return { campaign: null, totals: { recipients: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0, unknown: 0, replied: 0, reply_rate: null }, replies: [], note: 'Campaign not found.' };
    this.refreshReplies(campaignId);
    const detail = this.outreach.getCampaign(campaignId);
    // Counts over ALL recipients via SQL (recipients_list is a capped view).
    const cancelled = (this.db.prepare("SELECT COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ? AND state = 'cancelled'").get(campaignId) as { n: number }).n;
    const replyRows = this.db
      .prepare(
        `SELECT r.customer_local_id, r.email, r.hs_conversation_number, r.replied_at,
           c.first_name, c.last_name, cv.id AS conversation_local_id
         FROM outreach_recipients r
         LEFT JOIN customers c ON c.id = r.customer_local_id
         LEFT JOIN conversations cv ON cv.remote_id = r.hs_conversation_remote_id
         WHERE r.campaign_id = ? AND r.replied_at IS NOT NULL
         ORDER BY r.replied_at DESC LIMIT 500`
      )
      .all(campaignId) as { customer_local_id: number; email: string | null; hs_conversation_number: number | null; replied_at: string | null; first_name: string | null; last_name: string | null; conversation_local_id: number | null }[];
    const replies = replyRows.map((r) => ({
      customer: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || `customer ${r.customer_local_id}`,
      conversation_number: r.hs_conversation_number,
      conversation_local_id: r.conversation_local_id,
      replied_at: r.replied_at
    }));
    const replyRate = detail && detail.sent > 0 ? Math.round((detail.replied / detail.sent) * 100) / 100 : null;
    return {
      campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
      totals: {
        recipients: campaign.recipients,
        sent: campaign.sent,
        failed: campaign.failed,
        skipped: campaign.skipped,
        cancelled,
        unknown: campaign.unknown,
        replied: campaign.replied,
        reply_rate: replyRate
      },
      replies,
      note: 'These are SupportOS campaign conversation outcomes based on Help Scout conversation state in the local mirror - not email-delivery analytics.'
    };
  }

  // ---------------- Controls (spec #32) ----------------

  pause(campaignId: number): { ok: boolean; message: string } {
    const c = this.outreach.getCampaign(campaignId);
    if (!c) return { ok: false, message: 'Campaign not found.' };
    if (c.status !== 'queued' && c.status !== 'sending') return { ok: false, message: `Only queued or sending campaigns can be paused (current: ${c.status}).` };
    this.outreach.updateCampaignStatus(campaignId, 'paused');
    this.outreach.logEvent(campaignId, null, 'campaign_paused', null);
    this.emitProgress(campaignId);
    return { ok: true, message: 'Campaign paused. Already-sent recipients are untouched.' };
  }

  resume(campaignId: number): { ok: boolean; message: string } {
    const c = this.outreach.getCampaign(campaignId);
    if (!c) return { ok: false, message: 'Campaign not found.' };
    if (c.status !== 'paused') return { ok: false, message: `Only paused campaigns can be resumed (current: ${c.status}).` };
    this.outreach.updateCampaignStatus(campaignId, 'queued');
    this.outreach.logEvent(campaignId, null, 'campaign_resumed', null);
    this.jobsRepo.enqueue('outreach', 'outreach_send_batch', { campaignId }, 1, 5);
    this.emitProgress(campaignId);
    return { ok: true, message: 'Campaign resumed.' };
  }

  cancelRemaining(campaignId: number): { ok: boolean; message: string } {
    const c = this.outreach.getCampaign(campaignId);
    if (!c) return { ok: false, message: 'Campaign not found.' };
    const cancelled = this.outreach.cancelRemaining(campaignId);
    this.outreach.updateCampaignStatus(campaignId, 'cancelled');
    this.outreach.logEvent(campaignId, null, 'campaign_cancelled', `${cancelled} remaining recipients cancelled`);
    this.emitProgress(campaignId);
    return { ok: true, message: `${cancelled} remaining recipient(s) cancelled. Sent recipients are untouched.` };
  }

  retryFailed(campaignId: number): { ok: boolean; message: string } {
    const c = this.outreach.getCampaign(campaignId);
    if (!c) return { ok: false, message: 'Campaign not found.' };
    const reset = this.outreach.resetFailedToQueued(campaignId);
    if (reset > 0) {
      this.outreach.updateCampaignStatus(campaignId, 'queued');
      this.outreach.logEvent(campaignId, null, 'campaign_retry_failed', `${reset} recipients re-queued (attempt budget reset)`);
      this.jobsRepo.enqueue('outreach', 'outreach_send_batch', { campaignId }, 1, 5);
    }
    this.emitProgress(campaignId);
    return { ok: true, message: reset > 0 ? `${reset} failed recipient(s) re-queued.` : 'No failed recipients to retry.' };
  }

  /** Execute one outreach job (the worker and tests share the exact dispatch). */
  async executeJob(type: string, payload: Record<string, unknown>): Promise<void> {
    if (type === 'outreach_send_batch') await this.sendBatch(Number(payload.campaignId));
    else if (type === 'outreach_reconcile') await this.reconcile(Number(payload.campaignId));
  }

  private emitProgress(campaignId: number): void {
    const c = this.outreach.getCampaign(campaignId);
    if (!c) return;
    serverEventBus.emit('campaign-updated', {
      campaignId,
      status: c.status,
      sent: c.sent,
      failed: c.failed,
      unknown: c.unknown,
      remaining: this.outreach.countRemaining(campaignId),
      at: new Date().toISOString()
    });
  }
}
