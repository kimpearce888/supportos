import type { Database } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { KnowledgeRepository } from '../database/repositories/knowledgeRepo.js';
import { IssueRepository } from '../database/repositories/issueRepo.js';
import { AiRepository } from '../database/repositories/aiRepo.js';
import { IncidentRepository } from '../database/repositories/incidentRepo.js';
import { CustomObjectRepository } from '../customobjects/customObjectsRepo.js';
import { ConnectorService } from '../connectors/connectorService.js';
import { CustomerEventRepository } from '../database/repositories/customerEventsRepo.js';
import { CustomerEventSweep } from '../timeline/customerEventSweep.js';
import { FrictionAnalyzer } from '../ai/friction.js';
import { PostResolutionQaService } from '../ai/postResolutionQa.js';
import { KnowledgeGapService } from '../knowledge/gapEngine.js';
import { InteractionEngine } from '../ai/interaction/engine.js';

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

  // v2.1.0 (M5): a REPEATED question across two conversations - the honest
  // input the knowledge gap engine exists for. Both analyses carry the same
  // primary question with no covering document, so the gap rebuild derives a
  // repeated_question_uncovered candidate (the same deterministic detection
  // a real instance runs on demand).
  const repeatedQuestion = 'How do I connect my own custom domain to my workspace?';
  for (const number of [5005, 5010]) {
    const conv = byNumber(number);
    if (!conv) continue;
    const analysis = {
      intent: 'how_to',
      primary_question: repeatedQuestion,
      secondary_questions: [],
      customer_goal: 'Serve the product from their own domain.',
      product: 'Workspace',
      feature: 'Domains',
      problem_type: 'how_to',
      requested_action: 'Provide custom domain setup steps.',
      urgency: 'normal',
      sentiment: 'neutral',
      known_issue_candidate: null,
      issue_cluster_candidate: 'custom domains',
      frustration_level: 'low',
      confidence: 0.9
    };
    const signature = ai.getAnalysisSignature(conv.id);
    const inputHash = ai.inputHash(conv.id, signature);
    const runId = ai.startRun('ticket_analysis', { conversationId: conv.id, promptVersion: 'ticket_analysis_v1', inputHash, inputRefs: [conv.id] });
    ai.completeRun(runId, analysis, 700);
    ai.saveAnalysis(runId, conv.id, analysis as never, []);
  }
  console.log('Seeded 1 repeated question across 2 conversations (gap-engine input).');

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

  // ---------------- v2.0.0 (M4): incidents, custom objects, connector, timeline ----------------
  const incidents = new IncidentRepository(db);
  const slackConvs = conversations.filter((c) => (c.subject ?? '').match(/slack/i)).map((c) => c.id);
  const tzConvsAll = conversations.filter((c) => (c.subject ?? '').match(/timezone|hour|reminder|schedule/i)).map((c) => c.id);
  let incidentCount = 0;
  if (slackConvs.length > 0) {
    const inc = incidents.create({
      title: 'Slack integration stops posting after token rotation',
      severity: 'sev2',
      status: 'identified',
      product: 'Integrations',
      feature: 'Slack',
      description: 'Workspaces connected before the Slack token-rotation policy change report the integration stopped posting updates (repeated 401s in integration logs).',
      internalExplanation: 'ENG-4471 tracks the automatic re-auth flow. Refresh tokens were invalidated for older connections; disconnect/reconnect restores service.',
      customerSafeExplanation: 'An authentication change on Slack\u2019s side is affecting some workspaces. Reconnecting the integration restores updates; historical data is unaffected.',
      knownCause: 'Slack token rotation policy invalidated refresh tokens for older connections.',
      workaround: 'Disconnect and reconnect the integration; historical data is preserved.',
      source: 'known_issue',
      conversationIds: slackConvs
    });
    incidents.addRelated(inc.id, 'known_issue', ki2, 'Declared from this known issue', null);
    incidents.addRef(inc.id, { system: 'linear', reference: 'ENG-4471', title: 'Slack auto re-auth', status: 'in progress', url: 'https://linear.app/example/issue/ENG-4471' });
    incidents.addRelease(inc.id, {
      versionLabel: 'v4.12.0',
      releasedAt: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10),
      notes: 'Slack app permissions scope change rolled out server-side by Slack.',
      correlation: 'First 401 reports appeared within days of this window - a temporal association, not a causal claim.'
    });
    incidents.addNote(inc.id, 'Confirmed with three affected workspaces: disconnect/reconnect restores posting immediately.', null);
    incidentCount++;
  }
  if (tzConvsAll.length > 0) {
    const inc = incidents.create({
      title: 'Scheduled reports drift one hour after DST changes',
      severity: 'sev3',
      status: 'fix_in_progress',
      product: 'Reports',
      feature: 'Schedules',
      description: 'Scheduled reports fire one hour off after daylight-saving changes until the schedule is re-saved.',
      internalExplanation: 'ENG-4472: re-anchor job scheduled for next release; schedule store keeps absolute UTC offsets.',
      customerSafeExplanation: 'A known issue affects scheduled items around daylight-saving changes: times can be off by one hour until the schedule is re-saved.',
      knownCause: 'Stored schedule times anchor to the UTC offset at save time.',
      workaround: 'Open each schedule and re-save it once after the DST change.',
      source: 'known_issue',
      conversationIds: tzConvsAll
    });
    incidents.addRelated(inc.id, 'known_issue', ki1, 'Declared from this known issue', null);
    incidents.addRef(inc.id, { system: 'linear', reference: 'ENG-4472', title: 'Re-anchor schedules after DST', status: 'in progress' });
    incidentCount++;
  }
  console.log(`Seeded ${incidentCount} incidents (master issues) with refs, releases and notes.`);

  // Custom object types: Account + Deployment (the plan's examples).
  const customObjects = new CustomObjectRepository(db);
  let accountType: { id: number } | null = null;
  let deploymentType: { id: number } | null = null;
  try {
    const created = customObjects.createType({
      name: 'Account',
      description: 'Commercial account record for a customer organization.',
      fields: [
        { key: 'plan_tier', label: 'Plan tier', fieldType: 'select', required: true, options: ['free', 'starter', 'growth', 'enterprise'] },
        { key: 'mrr', label: 'MRR (USD)', fieldType: 'number', required: false },
        { key: 'renewal_date', label: 'Renewal date', fieldType: 'date', required: false },
        { key: 'csm', label: 'Customer success manager', fieldType: 'text', required: false }
      ]
    });
    accountType = { id: created.id };
  } catch { /* type already exists from a previous demo seed */ }
  const existingAccountType = accountType ?? customObjects.getTypeBySlug('account');
  if (existingAccountType) accountType = { id: existingAccountType.id };
  try {
    const created = customObjects.createType({
      name: 'Deployment',
      description: 'A product deployment/release record.',
      fields: [
        { key: 'version', label: 'Version', fieldType: 'text', required: true },
        { key: 'environment', label: 'Environment', fieldType: 'select', required: true, options: ['production', 'staging'] },
        { key: 'deployed_at', label: 'Deployed at', fieldType: 'date', required: true },
        { key: 'status', label: 'Status', fieldType: 'select', required: false, options: ['healthy', 'degraded', 'rolled_back'] }
      ]
    });
    deploymentType = { id: created.id };
  } catch { /* type already exists */ }
  const existingDeploymentType = deploymentType ?? customObjects.getTypeBySlug('deployment');
  if (existingDeploymentType) deploymentType = { id: existingDeploymentType.id };

  const orgIdByName = (name: string): number | null => (db.prepare('SELECT id FROM organizations WHERE name = ?').get(name) as { id: number } | undefined)?.id ?? null;
  const customerOfConversation = (n: number): number | null => byNumber(n)?.customer_local_id ?? null;
  let objectCount = 0;
  if (accountType && (customObjects.listObjects({ typeId: accountType.id }).total === 0)) {
    const andesOrg = orgIdByName('Andes Logistics');
    const andesCustomer = customerOfConversation(5001);
    const brightPathCustomer = customerOfConversation(5004);
    const harborCustomer = customerOfConversation(5005);
    const candidates: { title: string; properties: Record<string, unknown>; org: number | null; customer: number | null }[] = [
      { title: 'Andes Logistics', properties: { plan_tier: 'enterprise', mrr: 4800, renewal_date: '2026-03-01', csm: 'Priya Nair' }, org: andesOrg, customer: andesCustomer },
      { title: 'Bright Path Education', properties: { plan_tier: 'starter', mrr: 240, renewal_date: '2025-12-15', csm: 'Marcus Chen' }, org: orgIdByName('Bright Path Education'), customer: brightPathCustomer },
      { title: 'Harbor Fitness', properties: { plan_tier: 'growth', mrr: 990, renewal_date: '2026-01-10', csm: 'Sofia Reyes' }, org: orgIdByName('Harbor Fitness'), customer: harborCustomer }
    ];
    for (const cand of candidates) {
      if (!cand.customer && !cand.org) continue;
      try {
        customObjects.createObject({
          typeId: accountType.id,
          title: cand.title,
          properties: cand.properties,
          links: [
            ...(cand.customer ? [{ targetKind: 'customer' as const, targetLocalId: cand.customer }] : []),
            ...(cand.org ? [{ targetKind: 'organization' as const, targetLocalId: cand.org }] : [])
          ]
        });
        objectCount++;
      } catch { /* demo data tolerant */ }
    }
  }
  if (deploymentType && (customObjects.listObjects({ typeId: deploymentType.id }).total === 0)) {
    const slackIncident = db.prepare("SELECT id FROM incidents WHERE code = 'INC-001'").get() as { id: number } | undefined;
    const releases = [
      { title: 'v4.12.0 production', properties: { version: 'v4.12.0', environment: 'production', deployed_at: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10), status: 'degraded' }, incident: slackIncident?.id ?? null },
      { title: 'v4.11.2 production', properties: { version: 'v4.11.2', environment: 'production', deployed_at: new Date(Date.now() - 34 * 86_400_000).toISOString().slice(0, 10), status: 'healthy' }, incident: null }
    ];
    for (const rel of releases) {
      try {
        customObjects.createObject({
          typeId: deploymentType.id,
          title: rel.title,
          properties: rel.properties,
          links: rel.incident ? [{ targetKind: 'incident' as const, targetLocalId: rel.incident }] : []
        });
        objectCount++;
      } catch { /* demo data tolerant */ }
    }
  }
  console.log(`Seeded ${objectCount} custom objects (accounts + deployments).`);

  // Sample local JSON connector (AI-visible, the plan's "Product releases" idea).
  const connectors = new ConnectorService(db);
  connectors.ensureConnectorsDir();
  const releaseFile = path.join(connectors.connectorsDir(), 'product-releases.json');
  try {
    fs.writeFileSync(releaseFile, JSON.stringify([
      { version: 'v4.12.0', channel: 'production', released_at: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10), notes: 'Slack scopes change window' },
      { version: 'v4.11.2', channel: 'production', released_at: new Date(Date.now() - 34 * 86_400_000).toISOString().slice(0, 10), notes: 'Scheduling engine patch' },
      { version: 'v4.10.0', channel: 'production', released_at: new Date(Date.now() - 62 * 86_400_000).toISOString().slice(0, 10), notes: 'Billing retry backoff fix' }
    ], null, 2));
    if (!connectors.repository.getByName('Product releases')) {
      const connector = connectors.repository.create({
        name: 'Product releases',
        kind: 'local_json',
        config: { kind: 'local_json', file: 'product-releases.json', keyColumn: 'version' },
        auth: { mode: 'none' },
        refreshMethod: 'manual',
        refreshSeconds: 3600,
        allowedAi: true
      });
      void connectors.refresh(connector.id).then((r) => {
        if (!r.ok) console.log(`Demo connector refresh failed: ${r.error}`);
      });
    }
    console.log('Seeded 1 local JSON connector (Product releases, AI-visible).');
  } catch (e) {
    console.log(`Demo connector seed skipped: ${(e as Error).message}`);
  }

  // Knowledge freshness: give two docs human review/verify stamps so the
  // freshness view shows variety (others stay honestly unstamped).
  try {
    const docA = docIdByTitle(db, 'Inviting teammates');
    const docB = docIdByTitle(db, 'Viewer role capabilities');
    if (docA) db.prepare("UPDATE knowledge_documents SET last_reviewed_at = datetime('now', '-12 days') WHERE id = ?").run(docA);
    if (docB) db.prepare("UPDATE knowledge_documents SET last_verified_at = datetime('now', '-40 days'), last_reviewed_at = datetime('now', '-40 days') WHERE id = ?").run(docB);
  } catch { /* freshness columns always exist post-migration */ }

  // Derive the customer event timeline once (same idempotent SQL as the
  // migration backfill + incident/custom-object derivations).
  const events = new CustomerEventRepository(db);
  const sweep = new CustomerEventSweep(db, events);
  const derived = sweep.rebuild();
  console.log(`Derived ${derived.created} customer timeline events.`);

  // ---------------- v2.1.0 (M5): quality layer seeds ----------------
  // Friction findings + post-resolution QA rows + knowledge-gap candidates
  // are all DETERMINISTIC derivations over the demo world - the same code
  // paths a real instance runs on demand (no fake data).
  try {
    // Interaction outcomes (deterministic): the same engine the workers'
    // post-sync backfill uses, so effectiveness/QA/friction all have data
    // even when the demo DB was seeded via a direct initialSync.
    const engine = new InteractionEngine(db);
    const convs = db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL').all() as { id: number }[];
    for (const c of convs) engine.computeOutcome(c.id);
    console.log(`Seeded interaction outcomes for ${convs.length} conversations.`);
  } catch (e) {
    console.log(`Demo outcome seed skipped: ${(e as Error).message}`);
  }

  try {
    const friction = new FrictionAnalyzer(db);
    const fr = friction.rebuild();
    console.log(`Seeded ${fr.findings} friction findings across ${fr.conversations} conversations.`);
  } catch (e) {
    console.log(`Demo friction seed skipped: ${(e as Error).message}`);
  }

  try {
    const qa = new PostResolutionQaService(db, null, new FrictionAnalyzer(db));
    const seeded = qa.rebuild();
    console.log(`Seeded deterministic post-resolution QA for ${seeded.conversations} closed conversations.`);
  } catch (e) {
    console.log(`Demo QA seed skipped: ${(e as Error).message}`);
  }

  try {
    const gaps = new KnowledgeGapService(db);
    const built = gaps.rebuild(90);
    console.log(`Seeded ${built.candidates} knowledge-gap candidates (${built.new} new).`);
    // Give the demo world one human decision so the lifecycle is visible:
    // approve the most frequent candidate if any exist.
    // Approve one candidate ONLY when at least two exist, so the demo world
    // always keeps an open candidate for the lifecycle UI.
    const openCount = (db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates WHERE status = 'candidate'").get() as { n: number }).n;
    if (openCount >= 2) {
      const first = db.prepare("SELECT id FROM knowledge_candidates WHERE status = 'candidate' ORDER BY occurrence_count DESC LIMIT 1").get() as { id: number } | undefined;
      if (first) gaps.decide(first.id, 'approved', 'Demo decision: document this answer.', null);
    }
  } catch (e) {
    console.log(`Demo gap seed skipped: ${(e as Error).message}`);
  }

  // One saved report definition so the builder opens with an example.
  try {
    const existing = db.prepare("SELECT COUNT(*) AS n FROM report_definitions").get() as { n: number };
    if (existing.n === 0) {
      const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      db.prepare("INSERT INTO report_definitions (name, config, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))").run(
        'Conversations per day (last 30 days)',
        JSON.stringify({ metric: 'conversations', dimension: 'day', dateFrom: from, dateTo: to, comparison: 'previous_period', filters: {}, sort: 'dimension_asc', limit: 40 })
      );
      console.log('Seeded 1 saved report definition (conversations per day).');
    }
  } catch (e) {
    console.log(`Demo report seed skipped: ${(e as Error).message}`);
  }

  console.log('Demo seed complete.');
  console.log('NOTE: all seeded AI content is marked ai_generated; demo data never mixes with production data.');
}

