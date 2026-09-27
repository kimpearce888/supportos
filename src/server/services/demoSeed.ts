import type { Database } from 'better-sqlite3';
import { KnowledgeRepository } from '../database/repositories/knowledgeRepo.js';
import { IssueRepository } from '../database/repositories/issueRepo.js';
import { AiRepository } from '../database/repositories/aiRepo.js';

function docIdByTitle(db: Database, title: string): number {
  const row = db.prepare('SELECT id FROM knowledge_documents WHERE title = ?').get(title) as { id: number } | undefined;
  return row?.id ?? 0;
}

export function seedDemoData(db: import('better-sqlite3').Database): void {
  // Safety: never mix demo data with production data
  const provider = db.prepare("SELECT value FROM application_settings WHERE key='demo_data_loaded'").get() as { value: string } | undefined;
  const isDemo = process.env.LOCAL_DEMO_MODE === 'true' || (provider && JSON.parse(provider.value) === true) || process.env.FORCE_SEED === 'true';
  if (!isDemo) {
    throw new Error('Refusing to seed demo data: this does not look like a demo database. Demo data must stay separate from production data.');
  }

  const conversations = db.prepare('SELECT id, number, subject, customer_local_id, closed_at FROM conversations WHERE deleted_at IS NULL').all() as { id: number; number: number; subject: string | null; customer_local_id: number | null; closed_at: string | null }[];
  const byNumber = (n: number): { id: number; number: number; subject: string | null; customer_local_id: number | null } | undefined => conversations.find((c) => c.number === n);
  console.log(`Seeding demo intelligence for ${conversations.length} conversations…`);

  // ---------------- Knowledge ----------------
  const knowledge = new KnowledgeRepository(db);
  const sourceId = knowledge.getSource('Demo product docs')?.id ?? knowledge.createSource('Demo product docs', 'import', 'customer_safe');
  const internalSourceId = knowledge.getSource('Demo internal runbook')?.id ?? knowledge.createSource('Demo internal runbook', 'import', 'internal_only');
  const docs: [number, string, string, 'customer_safe' | 'internal_only'][] = [
    [sourceId, 'Timezones and scheduled reports', `# Timezones and scheduled reports\n\nScheduled reports follow the **workspace timezone**: Settings > Workspace > Regional settings.\n\nAfter changing the workspace timezone, open each schedule and re-save it once so the stored times re-anchor to the new timezone.\n\nDaylight-saving changes do not automatically re-anchor schedules that were saved before the change; re-saving after a DST change fixes the stored offset.\n\nAll schedule times are displayed in the workspace timezone.`, 'customer_safe'],
    [sourceId, 'Inviting teammates', `# Inviting teammates\n\nGo to Settings > Users > Invite. Invitation emails are sent immediately.\n\nIf an invitation does not arrive, common causes are spam filtering or a typo in the address. Ask your mail provider to whitelist our sending domain. Invitations can be re-sent from the Users screen at any time.`, 'customer_safe'],
    [sourceId, 'Viewer role capabilities', `# Viewer role\n\nA Viewer can see every dashboard and report shared with their team, but cannot edit, comment or create new ones. Viewers can export data (CSV/PDF) from reports they can see. An Editor seat is required for edit rights.`, 'customer_safe'],
    [sourceId, 'Updating your payment method', `# Updating your payment method\n\nYou can update your card under Settings > Billing > Payment method. After updating, click "Retry payment" so the pending invoice is charged again; the license re-activates immediately after a successful charge.\n\nIf your bank reports no charge attempt, the invoice may have entered a retry backoff - retrying manually triggers it immediately.`, 'customer_safe'],
    [internalSourceId, 'Slack integration 401 runbook (ENG-4471)', `# Slack integration 401 runbook - INTERNAL\n\nSymptom: workspaces report the Slack integration stopped posting updates; integration log shows repeated 401 from Slack.\n\nCause: Slack token rotation policy change; refresh tokens were invalidated for workspaces connected before <policy date>.\n\nFix status: engineering is deploying automatic re-auth flow (ENG-4471). Until deployed, instruct customers to disconnect/reconnect the integration - historical sync data is preserved.\n\nCustomer-facing wording must stay generic: "an authentication change on Slack's side" - do not mention internal ticket IDs.`, 'internal_only']
  ];
  for (const [sid, title, content, visibility] of docs) {
    knowledge.upsertDocument(sid, title, content, { visibility, format: 'markdown' });
  }
  console.log(`Seeded ${docs.length} knowledge documents (customer-safe + internal-only).`);

  // ---------------- Known issues ----------------
  const issues = new IssueRepository(db);
  const timezoneConv = byNumber(5001);
  const slackConv = byNumber(5006);
  const ki1 = issues.createKnownIssue({
    title: 'Schedules keep previous DST offset after a clock change',
    symptoms: 'Scheduled reports and reminders fire one hour late/early after a daylight-saving change until the schedule is re-saved.',
    product: 'Reports',
    feature: 'Schedules',
    known_cause: 'Stored schedule times anchor to the UTC offset at save time; mid-cycle DST changes are not re-anchored automatically.',
    workaround: 'Open each schedule and re-save it once after the DST change.',
    customer_safe_explanation: 'A known issue affects scheduled items around daylight-saving changes: times can be off by one hour until the schedule is re-saved. Our team is working on re-anchoring schedules automatically.',
    internal_explanation: 'ENG-4472: re-anchor job scheduled for next release. Root cause: schedule store keeps absolute UTC offsets.',
    status: 'fix_in_progress',
    conversation_ids: timezoneConv ? [timezoneConv.id] : [],
    provenance: 'human_local'
  });
  const ki2 = issues.createKnownIssue({
    title: 'Slack integration stops posting after Slack token rotation',
    symptoms: 'Slack channel stops receiving updates; integration log shows repeated 401 from Slack.',
    product: 'Integrations',
    feature: 'Slack',
    known_cause: 'Slack token rotation policy invalidated refresh tokens for older connections.',
    workaround: 'Disconnect and reconnect the integration; historical data is preserved.',
    customer_safe_explanation: 'An authentication change on Slack\u2019s side is affecting some workspaces. Reconnecting the integration restores updates; your historical data is unaffected.',
    internal_explanation: 'ENG-4471: automatic re-auth flow in progress. Do not share internal IDs with customers.',
    status: 'identified',
    conversation_ids: slackConv ? [slackConv.id] : [],
    provenance: 'human_local'
  });
  issues.addEngineeringRef(ki1, { system: 'linear', reference_id: 'ENG-4472', title: 'Re-anchor schedules after DST', status: 'in progress' });
  issues.addEngineeringRef(ki2, { system: 'linear', reference_id: 'ENG-4471', title: 'Slack auto re-auth', status: 'in progress' });
  console.log('Seeded 2 known issues with engineering references.');

  // ---------------- Issue clusters ----------------
  const tzConvs = conversations.filter((c) => (c.subject ?? '').match(/timezone|hour|reminder/i)).map((c) => c.id);
  if (tzConvs.length >= 2) {
    issues.upsertCluster({
      title: 'timezone schedules after DST change',
      summary: 'Customers in DST-observing regions report scheduled items firing one hour off after clock changes.',
      category: 'Timezone / Scheduling',
      product: 'Reports',
      feature: 'Schedules',
      conversation_ids: tzConvs,
      known_issue_id: ki1,
      ai_generated: true
    });
  }
  const billingConvs = conversations.filter((c) => (c.subject ?? '').match(/card|invoice|VAT|payment/i)).map((c) => c.id);
  if (billingConvs.length >= 2) {
    issues.upsertCluster({
      title: 'billing payment issues',
      summary: 'Failed charges and invoice/VAT questions from finance contacts.',
      category: 'Billing',
      product: 'Billing',
      feature: 'Payments',
      conversation_ids: billingConvs,
      known_issue_id: null,
      ai_generated: true
    });
  }
  issues.computeTrends();
  console.log('Seeded issue clusters.');

  // ---------------- Sample AI analyses (marked ai_generated, demo provenance) ----------------
  const ai = new AiRepository(db);
  const samples: { number: number; analysis: Record<string, unknown>; sources: { source_type: string; source_id: number; title: string; relevance: number; visibility: string; timestamp: null }[] }[] = [
    {
      number: 5001,
      analysis: {
        intent: 'bug_report',
        primary_question: 'How can the daily dispatch report schedule be made to follow the Santiago timezone after the DST change?',
        secondary_questions: ['Why does the schedule editor still show UTC times?'],
        customer_goal: 'Receive the daily dispatch report at 8 AM Chilean time, every day of the year.',
        product: 'Reports',
        feature: 'Schedules',
        problem_type: 'defect',
        requested_action: 'Fix the schedule to follow the workspace timezone, or provide steps to correct it.',
        urgency: 'high',
        sentiment: 'negative',
        known_issue_candidate: 'Schedules keep previous DST offset after a clock change',
        issue_cluster_candidate: 'timezone schedules',
        missing_information: [],
        summary: 'A VIP operations customer in Chile reports that a daily scheduled report fires at 3 AM local time after a DST change. Re-saving the schedule fixed one report; a second one remains offset. This matches an identified known issue about schedule re-anchoring.',
        confidence: 'high'
      },
      sources: [
        { source_type: 'conversation', source_id: byNumber(5003)?.id ?? 0, title: '#5003 Timezone for scheduled exports', relevance: 0.9, visibility: 'internal_only', timestamp: null },
        { source_type: 'known_issue', source_id: ki1, title: 'Schedules keep previous DST offset', relevance: 0.95, visibility: 'uncertain', timestamp: null },
        { source_type: 'knowledge_document', source_id: docIdByTitle(db, 'Timezones and scheduled reports') ?? 0, title: 'Timezones and scheduled reports', relevance: 0.9, visibility: 'customer_safe', timestamp: null }
      ]
    },
    {
      number: 5006,
      analysis: {
        intent: 'bug_report',
        primary_question: 'Why did the Slack integration stop posting updates and when will it be fixed?',
        secondary_questions: [],
        customer_goal: 'Restore Slack alerting for their ops channel.',
        product: 'Integrations',
        feature: 'Slack',
        problem_type: 'defect',
        requested_action: 'Fix the integration urgently; they use it for alerting.',
        urgency: 'critical',
        sentiment: 'frustrated',
        known_issue_candidate: 'Slack integration stops posting after Slack token rotation',
        issue_cluster_candidate: 'slack integration auth',
        missing_information: [],
        summary: 'A customer reports the Slack integration stopped posting updates, with log ID INT-88231. This matches a known engineering issue (Slack token rotation). Escalation note exists; customer-facing wording must stay generic.',
        confidence: 'high'
      },
      sources: [
        { source_type: 'known_issue', source_id: ki2, title: 'Slack integration stops posting', relevance: 0.95, visibility: 'uncertain', timestamp: null },
        { source_type: 'knowledge_document', source_id: docIdByTitle(db, 'Slack integration 401 runbook (ENG-4471)') ?? 0, title: 'Slack integration 401 runbook', relevance: 0.9, visibility: 'internal_only', timestamp: null }
      ]
    },
    {
      number: 5004,
      analysis: {
        intent: 'question',
        primary_question: 'Why is the invitation email for a new teammate not arriving?',
        secondary_questions: [],
        customer_goal: 'Get their teammate onboarded.',
        product: 'Accounts',
        feature: 'Invitations',
        problem_type: 'configuration',
        requested_action: 'Resend or fix the invitation delivery.',
        urgency: 'normal',
        sentiment: 'neutral',
        known_issue_candidate: null,
        issue_cluster_candidate: 'invite delivery',
        missing_information: ['Confirmation whether the re-sent invite arrived'],
        summary: 'Invitations to brightpathedu.org are bouncing with a provider policy rejection. An internal note documents the whitelist fix and the re-send; awaiting customer confirmation.',
        confidence: 'medium'
      },
      sources: [{ source_type: 'knowledge_document', source_id: docIdByTitle(db, 'Inviting teammates') ?? 0, title: 'Inviting teammates', relevance: 0.8, visibility: 'customer_safe', timestamp: null }]
    },
    {
      number: 5007,
      analysis: {
        intent: 'billing',
        primary_question: 'Can the failed card payment be retried?',
        secondary_questions: [],
        customer_goal: 'Restore the subscription to active.',
        product: 'Billing',
        feature: 'Payments',
        problem_type: 'billing',
        requested_action: 'Retry the charge on their valid card.',
        urgency: 'high',
        sentiment: 'negative',
        known_issue_candidate: null,
        issue_cluster_candidate: 'billing payment issues',
        missing_information: [],
        summary: 'Subscription shows past-due but the bank reports no charge attempt - the invoice likely entered a retry backoff. The documented self-service path is updating the card and clicking Retry payment.',
        confidence: 'high'
      },
      sources: [{ source_type: 'knowledge_document', source_id: docIdByTitle(db, 'Updating your payment method') ?? 0, title: 'Updating your payment method', relevance: 0.9, visibility: 'customer_safe', timestamp: null }]
    }
  ];
  let seededAnalyses = 0;
  for (const s of samples) {
    const conv = byNumber(s.number);
    if (!conv) continue;
    const signature = ai.getAnalysisSignature(conv.id);
    const inputHash = ai.inputHash(conv.id, signature);
    const runId = ai.startRun('ticket_analysis', { conversationId: conv.id, promptVersion: 'ticket_analysis_v1', inputHash, inputRefs: [conv.id] });
    ai.completeRun(runId, s.analysis, 850 + Math.floor(Math.random() * 900));
    ai.saveAnalysis(runId, conv.id, s.analysis as never, s.sources as never);
    seededAnalyses++;
  }
  console.log(`Seeded ${seededAnalyses} sample AI analyses (marked ai_generated).`);

  // ---------------- Customer memories ----------------
  const lucia = byNumber(5001);
  if (lucia?.customer_local_id) {
    ai.upsertMemory(lucia.customer_local_id, 'operates_in_chile', 'Operations in Santiago, Chile (America/Santiago timezone, UTC-4 during DST).', { source: 'ai', origin: 'conversation', conversationId: lucia.id, confidence: 'high' });
    ai.upsertMemory(lucia.customer_local_id, 'vip_account', 'Andes Logistics is a VIP account (vip tag applied).', { source: 'ai', origin: 'conversation', conversationId: lucia.id, confidence: 'high' });
  }
  console.log('Seeded customer memories.');

  // ---------------- Support cases ----------------
  const closedTz = byNumber(5003);
  if (closedTz) {
    issues.upsertSupportCase({
      conversation_id: closedTz.id,
      customer_id: closedTz.customer_local_id,
      problem: 'Scheduled exports arrive in UTC instead of local time',
      root_question: 'How do I set the timezone used for scheduled exports?',
      resolution: 'Direct to Settings > Workspace > Regional settings; re-save each schedule after changing the timezone.',
      answer: 'Scheduled exports follow the workspace timezone (Settings > Workspace > Regional settings). After changing it, re-save each schedule once so stored times re-anchor.',
      product: 'Reports',
      feature: 'Schedules',
      tags: ['timezone'],
      rating: 'great'
    });
  }
  console.log('Seeded support case.');

  console.log('Demo seed complete.');
  console.log('NOTE: all seeded AI content is marked ai_generated; demo data never mixes with production data.');
}

