import { z } from 'zod';
import { AI_ATTRIBUTE_KEYS, INTERACTION_DIMENSIONS, OPERATIONAL_CONFIDENCE_VALUES, RESPONSE_PREFERENCE_VALUES } from './constants.js';

/** Runtime validation schemas for important boundaries (Help Scout API responses + local API requests). */

// ---------------- Help Scout API response shapes ----------------

export const halLinkSchema = z.object({ href: z.string() }).passthrough();
export const halLinksSchema = z.record(z.unknown()).optional();

export const hsPersonRefSchema = z
  .object({
    id: z.number().optional(),
    type: z.string().optional(),
    first: z.string().nullish(),
    last: z.string().nullish(),
    email: z.string().nullish(),
    photoUrl: z.string().nullish()
  })
  .passthrough();

export const hsTagSchema = z
  .object({ id: z.number().optional(), tag: z.string(), color: z.string().nullish() })
  .passthrough();

export const hsCustomFieldV3Schema = z
  .object({
    id: z.number(),
    name: z.string().optional(),
    value: z.union([z.string(), z.number()]).nullish(),
    text: z.string().nullish(),
    systemType: z.string().nullish()
  })
  .passthrough();

export const hsConversationV3Schema = z
  .object({
    id: z.number(),
    number: z.number().optional(),
    threads: z.number().optional(),
    type: z.string().nullish(),
    folderId: z.number().nullish(),
    status: z.string().nullish(),
    state: z.string().nullish(),
    subject: z.string().nullish(),
    preview: z.string().nullish(),
    mailboxId: z.number().optional(),
    assignee: hsPersonRefSchema.nullish(),
    assignedTeam: z.object({ id: z.number(), name: z.string().nullish() }).nullish(),
    createdBy: hsPersonRefSchema.nullish(),
    closedBy: z.number().nullish(),
    closedByUser: hsPersonRefSchema.nullish(),
    closedAt: z.string().nullish(),
    createdAt: z.string().nullish(),
    userUpdatedAt: z.string().nullish(),
    customerWaitingSince: z.object({ time: z.string().nullish() }).nullish(),
    source: z.object({ type: z.string().nullish(), via: z.string().nullish() }).nullish(),
    tags: z.array(hsTagSchema).optional(),
    cc: z.array(z.string()).nullish(),
    bcc: z.array(z.string()).nullish(),
    primaryCustomer: hsPersonRefSchema.nullish(),
    snooze: z
      .object({ snoozedBy: z.number().nullish(), snoozedUntil: z.string().nullish(), unsnoozeOnCustomerReply: z.boolean().nullish() })
      .nullish(),
    customFields: z.array(hsCustomFieldV3Schema).nullish()
  })
  .passthrough();

export const hsConversationListV3Schema = z.object({
  _embedded: z.object({ conversations: z.array(hsConversationV3Schema) }).passthrough(),
  _links: z
    .object({ next: halLinkSchema.optional(), self: halLinkSchema.optional(), first: halLinkSchema.optional() })
    .optional()
});

export const hsThreadV3Schema = z
  .object({
    id: z.number(),
    type: z.string().nullish(),
    status: z.string().nullish(),
    state: z.string().nullish(),
    action: z
      .object({ type: z.string().nullish(), text: z.string().nullish(), associatedEntities: z.record(z.unknown()).optional() })
      .nullish(),
    body: z.string().nullish(),
    source: z.object({ type: z.string().nullish(), via: z.string().nullish() }).nullish(),
    customer: hsPersonRefSchema.nullish(),
    createdBy: hsPersonRefSchema.nullish(),
    assignedTo: hsPersonRefSchema.nullish(),
    savedReplyId: z.number().nullish(),
    to: z.array(z.string()).nullish(),
    cc: z.array(z.string()).nullish(),
    bcc: z.array(z.string()).nullish(),
    createdAt: z.string().nullish(),
    openedAt: z.string().nullish(),
    attachments: z
      .array(
        z
          .object({
            id: z.number(),
            filename: z.string().nullish(),
            mimeType: z.string().nullish(),
            size: z.number().nullish(),
            width: z.number().nullish(),
            height: z.number().nullish()
          })
          .passthrough()
      )
      .nullish()
  })
  .passthrough();

export const hsThreadListV3Schema = z.object({
  _embedded: z.object({ threads: z.array(hsThreadV3Schema) }).passthrough(),
  _links: z.record(z.unknown()).optional()
});

export const hsPageEnvelope = z.object({
  page: z
    .object({
      size: z.number().optional(),
      totalElements: z.number().optional(),
      totalPages: z.number().optional(),
      number: z.number().optional()
    })
    .optional()
});

export const hsMailboxSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    slug: z.string().nullish(),
    email: z.string().nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish()
  })
  .passthrough();

export const hsMailboxListSchema = z
  .object({ _embedded: z.object({ mailboxes: z.array(hsMailboxSchema) }).passthrough() })
  .passthrough();

export const hsFolderSchema = z
  .object({ id: z.number(), name: z.string(), type: z.string().nullish(), userId: z.number().nullish(), totalCount: z.number().nullish(), activeCount: z.number().nullish() })
  .passthrough();

export const hsUserSchema = z
  .object({
    id: z.number(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    email: z.string().nullish(),
    role: z.string().nullish(),
    timezone: z.string().nullish(),
    photoUrl: z.string().nullish(),
    type: z.string().nullish(),
    mention: z.string().nullish(),
    initials: z.string().nullish(),
    jobTitle: z.string().nullish(),
    phone: z.string().nullish(),
    alternateEmails: z.array(z.string()).nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
    lastVisit: z.string().nullish()
  })
  .passthrough();

export const hsTeamSchema = z
  .object({ id: z.number(), name: z.string().nullish(), createdAt: z.string().nullish(), updatedAt: z.string().nullish() })
  .passthrough();

export const hsTagObjectSchema = z
  .object({
    id: z.number(),
    slug: z.string().nullish(),
    name: z.string().nullish(),
    color: z.string().nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
    ticketCount: z.number().nullish()
  })
  .passthrough();

export const hsFieldSchema = z
  .object({
    id: z.number(),
    required: z.boolean().nullish(),
    order: z.number().nullish(),
    type: z.string().nullish(),
    name: z.string().nullish(),
    systemType: z.string().nullish(),
    options: z
      .array(z.object({ id: z.number(), order: z.number().nullish(), label: z.string().nullish() }).passthrough())
      .nullish()
  })
  .passthrough();

export const hsSavedReplySchema = z
  .object({
    id: z.number(),
    name: z.string().nullish(),
    preview: z.string().nullish(),
    text: z.string().nullish(),
    chatPreview: z.string().nullish(),
    chatText: z.string().nullish(),
    mailboxIds: z.array(z.number()).nullish()
  })
  .passthrough();

export const hsCustomerV3Schema = z
  .object({
    id: z.number(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    photoUrl: z.string().nullish(),
    jobTitle: z.string().nullish(),
    phone: z.string().nullish(),
    background: z.string().nullish(),
    age: z.union([z.string(), z.number()]).nullish(),
    gender: z.string().nullish(),
    location: z.string().nullish(),
    address: z.record(z.unknown()).nullish(),
    emails: z.array(z.object({ value: z.string().nullish(), type: z.string().nullish() }).passthrough()).nullish(),
    chatHandles: z.array(z.object({ value: z.string().nullish(), type: z.string().nullish() }).passthrough()).nullish(),
    phones: z.array(z.object({ value: z.string().nullish(), type: z.string().nullish() }).passthrough()).nullish(),
    websites: z.array(z.object({ value: z.string().nullish() }).passthrough()).nullish(),
    socialProfiles: z.array(z.object({ value: z.string().nullish(), type: z.string().nullish() }).passthrough()).nullish(),
    organization: z.object({ id: z.number(), name: z.string().nullish() }).nullish(),
    /** Property values (shape varies by endpoint vintage; normalized downstream). */
    properties: z.array(z.record(z.unknown())).nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
    _embedded: z.record(z.unknown()).optional()
  })
  .passthrough();

export const hsCustomerListV3Schema = z.object({
  _embedded: z.object({ customers: z.array(hsCustomerV3Schema) }).passthrough(),
  _links: z.record(z.unknown()).optional()
});

export const hsOrganizationSchema = z
  .object({
    id: z.number(),
    name: z.string().nullish(),
    domains: z.array(z.string()).nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
    _embedded: z.record(z.unknown()).optional()
  })
  .passthrough();

export const hsRatingSchema = z
  .object({
    id: z.number(),
    customer: hsPersonRefSchema.nullish(),
    threadId: z.number().nullish(),
    conversationId: z.number().nullish(),
    conversationNumber: z.number().nullish(),
    mailboxId: z.number().nullish(),
    rating: z.string().nullish(),
    user: hsPersonRefSchema.nullish(),
    comments: z.string().nullish(),
    createdAt: z.string().nullish()
  })
  .passthrough();

export const hsWorkflowSchema = z
  .object({
    id: z.number(),
    mailboxId: z.number().nullish(),
    type: z.string().nullish(),
    status: z.string().nullish(),
    order: z.number().nullish(),
    name: z.string().nullish(),
    createdAt: z.string().nullish(),
    modifiedAt: z.string().nullish()
  })
  .passthrough();

export const hsWebhookSchema = z
  .object({
    id: z.number(),
    url: z.string().nullish(),
    events: z.array(z.string()).nullish(),
    status: z.string().nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish()
  })
  .passthrough();

export const hsOAuthTokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  token_type: z.string().optional(),
  expires_in: z.number().optional()
});

// ---------------- Local API request schemas ----------------

export const replyRequestSchema = z.object({
  conversationId: z.number().int(),
  text: z.string().min(1),
  draft: z.boolean().default(false),
  cc: z.array(z.string().email()).default([]),
  bcc: z.array(z.string().email()).default([]),
  statusAfter: z.enum(['active', 'closed', 'pending', 'spam', 'open', 'inbox_predefined']).nullish(),
  assignTo: z.number().int().nullish(),
  attachmentIds: z.array(z.number().int()).default([])
});

export const noteRequestSchema = z.object({
  conversationId: z.number().int(),
  text: z.string().min(1)
});

export const statusRequestSchema = z.object({
  conversationId: z.number().int(),
  status: z.enum(['active', 'closed', 'pending', 'spam'])
});

export const assignRequestSchema = z.object({
  conversationId: z.number().int(),
  userId: z.number().int().nullable()
});

export const moveToInboxRequestSchema = z.object({
  conversationId: z.number().int(),
  mailboxId: z.number().int()
});

export const subjectRequestSchema = z.object({
  conversationId: z.number().int(),
  subject: z.string().min(1)
});

export const tagsRequestSchema = z.object({
  conversationId: z.number().int(),
  add: z.array(z.string()).default([]),
  remove: z.array(z.string()).default([]),
  set: z.array(z.string()).nullish()
});

export const fieldsRequestSchema = z.object({
  conversationId: z.number().int(),
  fields: z.array(z.object({ id: z.number().int(), value: z.string().nullish() }))
});

export const snoozeRequestSchema = z.object({
  conversationId: z.number().int(),
  snoozedUntil: z.string(),
  unsnoozeOnCustomerReply: z.boolean().default(true)
});

export const scheduleRequestSchema = z.object({
  conversationId: z.number().int(),
  threadId: z.number().int(),
  scheduledFor: z.string(),
  unscheduleOnCustomerReply: z.boolean().default(true)
});

export const bulkRequestSchema = z.object({
  conversationIds: z.array(z.number().int()).min(1),
  action: z.enum(['tag', 'untag', 'assign', 'unassign', 'status', 'close']),
  // Values may be numbers (user/status ids) or null ("unassign"); the worker
  // coerces per action. The record type keeps payloads opaque by design.
  params: z.record(z.union([z.string(), z.number(), z.null()])).default({})
});

export const searchRequestSchema = z.object({
  // v1.6.0 audit fix: a multi-megabyte query string reached SQLite FTS5/LIKE
  // and crashed the request ("LIKE or GLOB pattern too complex", 500). Search
  // queries are capped at a sane length; anything longer is a client error.
  query: z.string().max(500).default(''),
  scope: z.enum(['all', 'tickets', 'customers', 'knowledge', 'issues', 'saved_replies', 'ai']).default('all'),
  filters: z
    .object({
      status: z.string().optional(),
      mailbox_id: z.number().optional(),
      tag: z.string().optional(),
      since_days: z.number().optional(),
      assignee_id: z.number().optional()
    })
    .default({})
});

export const knowledgeImportRequestSchema = z.object({
  sourceName: z.string().default('Manual import'),
  visibility: z.enum(['customer_safe', 'internal_only']).default('internal_only'),
  documents: z
    .array(
      z.object({
        title: z.string(),
        content: z.string().min(1),
        format: z.enum(['markdown', 'txt', 'html']).default('markdown')
      })
    )
    .min(1)
});

export const lmStudioSettingsSchema = z.object({
  base_url: z.string().url(),
  chat_model: z.string().nullish(),
  embedding_model: z.string().nullish(),
  timeout_ms: z.number().int().min(1000).default(120000),
  concurrency: z.number().int().min(1).default(2)
});

/**
 * Whitelisted, type-checked settings patch (user-facing keys ONLY).
 * Internal keys (oauth_state, hs_last_ping, me_remote_id, demo_data_loaded,
 * lmstudio_base_url, ...) can never be written through the API: this blocks
 * settings poisoning such as a NaN sync interval or redirecting AI traffic
 * to an arbitrary URL.
 */
export const settingsPatchSchema = z
  .object({
    sync_interval_minutes: z.number().int().min(1).max(1440),
    api_concurrency: z.number().int().min(1).max(10),
    ai_enabled: z.boolean(),
    automatic_analysis_enabled: z.boolean(),
    automatic_note_enabled: z.boolean(),
    automatic_draft_enabled: z.boolean(),
    automation_enabled: z.boolean(),
    automation_write_actions_enabled: z.boolean(),
    qdrant_enabled: z.boolean(),
    qdrant_url: z.string().url().max(500),
    attachment_auto_download: z.boolean(),
    // Accepted but ALWAYS forced false by the settings repo (spec #14 safety):
    // the round-trip test asserts the value can never be enabled.
    automatic_reply_sending: z.boolean(),
    retention_days: z.number().int().min(1).max(3650).nullable(),
    backup_interval_hours: z.number().int().min(1).max(720).nullable(),
    log_level: z.enum(['debug', 'info', 'warn', 'error']),
    display_timezone: z.string().max(64),
    redaction_enabled: z.boolean(),
    ai_evaluation_mode: z.boolean()
  })
  .strict()
  .partial();

export const schedulePublishRequestSchema = z.object({
  threadId: z.number().int()
});

/** v1.4.0: per-mailbox business hours + SLA targets (validated before storage). */
export const businessHoursSchema = z
  .object({
    timezone: z.string().min(1).max(64),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start_minute: z.number().int().min(0).max(1439),
    end_minute: z.number().int().min(1).max(1440),
    first_response_target_min: z.number().int().min(1).max(100000).nullable(),
    resolution_target_min: z.number().int().min(1).max(100000).nullable()
  })
  .strict()
  .refine((v) => v.end_minute > v.start_minute, { message: 'end_minute must be after start_minute' });

/** v1.4.0: webhook registration request. */
export const webhookRegisterSchema = z
  .object({
    url: z.string().url().max(500),
    events: z.array(z.enum([
      'convo.created',
      'convo.updated',
      'convo.assigned',
      'convo.status',
      'convo.tags',
      'convo.custom-fields',
      'convo.moved',
      'convo.merged',
      'convo.deleted',
      'convo.customer.reply.created',
      'convo.agent.reply.created',
      'convo.note.created',
      'satisfaction.ratings'
    ])).min(1)
  })
  .strict();

/** v1.4.0: demo webhook simulation (exercises the REAL HMAC + job path). */
export const demoWebhookSchema = z
  .object({
    event: z.enum(['convo.created', 'convo.customer.reply.created', 'convo.agent.reply.created', 'convo.note.created']),
    conversationRemoteId: z.number().int().optional(),
    replyText: z.string().max(4000).optional()
  })
  .strict();

export const knowledgeImportFileRequestSchema = z.object({
  path: z.string().min(1).max(1024),
  sourceName: z.string().max(200).optional(),
  visibility: z.enum(['customer_safe', 'internal_only']).default('internal_only')
});

export const automationRuleSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(false),
  trigger: z.enum(['new_conversation', 'customer_reply', 'ai_low_confidence', 'manual']),
  conditions: z
    .array(
      z
        .object({
          // v1.9.0 (M3, plan Phase 17): 'ai_attribute' + 'ai_verification' join the
          // closed field list. Everything stays a flat validated structure -
          // conditions are never SQL.
          field: z.enum(['subject', 'body', 'tag', 'mailbox', 'confidence', 'known_issue_match', 'ai_attribute', 'ai_verification']),
          operator: z.enum(['contains', 'equals', 'not_equals', 'gt', 'gte', 'lt', 'lte']),
          value: z.string().max(200),
          attribute: z.enum(AI_ATTRIBUTE_KEYS).optional()
        })
        .superRefine((c, ctx) => {
          if (c.field === 'ai_attribute' && !c.attribute) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attribute'], message: "field 'ai_attribute' requires the catalog attribute key (e.g. urgency)." });
          }
          if (c.field === 'ai_verification' && !['failed', 'passed', 'none'].includes(c.value)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: "field 'ai_verification' value must be 'failed', 'passed' or 'none'." });
          }
        })
    )
    .default([]),
  actions: z
    .array(
      z.object({
        kind: z.enum([
          'analyze_ticket',
          'search_similar',
          'check_known_issues',
          'create_ai_note',
          'create_ai_draft',
          'add_tag',
          'set_status',
          'assign',
          'manual_review_queue'
        ]),
        params: z.record(z.string()).default({})
      })
    )
    .min(1),
  priority: z.number().int().default(100),
  requires_approval: z.boolean().default(true)
});

// ---------------- AI output schemas (structured JSON from LM Studio) ----------------

export const ticketAnalysisOutputSchema = z.object({
  intent: z.string().nullish(),
  primary_question: z.string().nullish(),
  secondary_questions: z.array(z.string()).default([]),
  customer_goal: z.string().nullish(),
  product: z.string().nullish(),
  feature: z.string().nullish(),
  problem_type: z.string().nullish(),
  requested_action: z.string().nullish(),
  urgency: z.enum(['low', 'normal', 'high', 'critical']).nullish(),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'frustrated']).nullish(),
  known_issue_candidate: z.string().nullish(),
  issue_cluster_candidate: z.string().nullish(),
  missing_information: z.array(z.string()).default([]),
  summary: z.string().nullish(),
  evidence_quality: z.enum(['strong', 'some', 'limited', 'insufficient']).nullish()
});

export const draftVerificationOutputSchema = z.object({
  verified: z.boolean(),
  unsupported_claims: z.array(z.string()).default([]),
  missing_questions: z.array(z.string()).default([]),
  internal_leakage: z.array(z.string()).default([]),
  conflicts: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([])
});

export const clusteringOutputSchema = z.object({
  clusters: z
    .array(
      z.object({
        title: z.string(),
        summary: z.string(),
        category: z.string().nullish(),
        product: z.string().nullish(),
        feature: z.string().nullish(),
        conversation_numbers: z.array(z.number()).default([])
      })
    )
    .default([])
});

// ---------------- Client Interaction Intelligence (interaction spec #34, #35, #7, #55) ----------------
// Stage 1: observation. Every field is enum-constrained so personality labels and
// diagnoses are structurally impossible; free-text fields are bounded strings
// later run through the interaction safety sanitizer.

export const interactionSignalOutputSchema = z.object({
  dimension: z.enum(INTERACTION_DIMENSIONS),
  value: z.string().min(1).max(64),
  confidence: z.enum(OPERATIONAL_CONFIDENCE_VALUES),
  evidence_excerpt: z.string().min(1).max(500).nullish(),
  evidence_thread_local_id: z.number().int().nullish()
});

export const interactionObservationOutputSchema = z.object({
  signals: z.array(interactionSignalOutputSchema).max(24).default([]),
  customer_goal: z.string().max(300).nullish(),
  notes: z.array(z.string().max(300)).default([])
});

// Stage 2: recommendation (spec #13, #14, #15, #48, #49).
export const interactionRecommendationOutputSchema = z.object({
  tone: z.string().max(120).nullish(),
  length: z.enum(['concise', 'moderate', 'detailed']).nullish(),
  start_with: z.string().max(300).nullish(),
  then: z.string().max(300).nullish(),
  avoid: z.array(z.string().max(200)).max(8).default([]),
  response_strategy: z.array(z.string().max(200)).max(8).default([]),
  de_escalation: z.boolean().default(false),
  escalation_recommendation: z.string().max(300).nullish(),
  why: z.array(z.string().max(300)).max(6).default([])
});

// ---------------- General AI Attribute Layer (v1.9.0 / M3, plan Phase 16) ----------------
// One structured run extracts AI-fillable attributes. Every enum is closed;
// missing/null = honest unknown (never stored). Evidence excerpts are bounded
// and must reference real thread content the model was shown.

export const attributeExtractionOutputSchema = z.object({
  attributes: z
    .array(
      z.object({
        attribute: z.enum(['intent', 'product', 'feature', 'issue', 'customer_goal', 'response_style']),
        value: z.string().min(1).max(300),
        confidence: z.enum(OPERATIONAL_CONFIDENCE_VALUES),
        evidence_excerpt: z.string().min(1).max(500).nullish(),
        evidence_thread_local_id: z.number().int().nullish()
      })
    )
    .max(16)
    .default([])
});

// ---------------- Local Copilot (v1.9.0 / M3, plan Phase 15) ----------------

export const copilotChatSchema = z.object({
  question: z.string().min(1).max(4000),
  conversationId: z.number().int().positive().nullish(),
  sessionId: z.number().int().positive().nullish()
});

export const copilotSessionListSchema = z.object({
  limit: z.number().int().min(1).max(200).optional()
});

// API request bodies
// Overrides are only accepted for the field the engine actually consumes
// (response preference): storing overrides for tone/detail/technical/directness
// would be dead data that silently changes nothing.
export const interactionOverrideSchema = z.object({
  field: z.literal('response_preference'),
  value: z.enum(RESPONSE_PREFERENCE_VALUES),
  reason: z.string().max(500).nullish()
});
