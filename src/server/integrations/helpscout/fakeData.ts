/**
 * Deterministic demo dataset for FakeHelpScoutProvider.
 * All data is synthetic; it models a realistic small SaaS support mailbox
 * (timezone/scheduling, registration, viewer, integrations, billing topics)
 * so dashboards, search, issue radar and AI flows are demonstrable.
 */
import type { HsConversation, HsCustomer, HsThread, HsUser, HsMailbox, HsTag, HsField, HsSavedReply, HsWorkflow, HsTeam, HsOrganization, HsRating, HsFolder, HsWebhookConfig, HsPropertyDef, HsUserStatus } from './provider.js';

export function daysAgo(n: number, hour = 10, minute = 30): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

export interface FakeWorld {
  me: HsUser;
  users: HsUser[];
  systemUsers: HsUser[];
  teams: HsTeam[];
  mailboxes: HsMailbox[];
  folders: HsFolder[];
  tags: HsTag[];
  fields: HsField[];
  savedReplies: HsSavedReply[];
  workflows: HsWorkflow[];
  webhooks: HsWebhookConfig[];
  customerProps: HsPropertyDef[];
  orgProps: HsPropertyDef[];
  customers: HsCustomer[];
  organizations: HsOrganization[];
  conversations: HsConversation[];
  threads: HsThread[];
  ratings: HsRating[];
  userStatuses: HsUserStatus[];
}

export function buildFakeWorld(): FakeWorld {
  const me: HsUser = {
    remoteId: 1001,
    firstName: 'Alex',
    lastName: 'Rivera',
    email: 'alex@zylker.io',
    role: 'owner',
    type: 'user',
    timezone: 'America/New_York',
    photoUrl: null,
    initials: 'AR',
    mention: 'alex',
    jobTitle: 'Support Lead',
    phone: null,
    alternateEmails: [],
    createdAt: daysAgo(400),
    updatedAt: daysAgo(20)
  };
  const users: HsUser[] = [
    me,
    {
      remoteId: 1002,
      firstName: 'Priya',
      lastName: 'Nair',
      email: 'priya@zylker.io',
      role: 'user',
      type: 'user',
      timezone: 'Asia/Kolkata',
      photoUrl: null,
      initials: 'PN',
      mention: 'priya',
      jobTitle: 'Support Engineer',
      phone: null,
      alternateEmails: [],
      createdAt: daysAgo(300),
      updatedAt: daysAgo(15)
    },
    {
      remoteId: 1003,
      firstName: 'Tom',
      lastName: 'Bright',
      email: 'tom@zylker.io',
      role: 'user',
      type: 'user',
      timezone: 'Europe/Berlin',
      photoUrl: null,
      initials: 'TB',
      mention: 'tom',
      jobTitle: 'Support Engineer',
      phone: null,
      alternateEmails: [],
      createdAt: daysAgo(250),
      updatedAt: daysAgo(10)
    }
  ];
  const systemUsers: HsUser[] = [
    {
      remoteId: 9001,
      firstName: 'AI Agent',
      lastName: '',
      email: 'ai-agent@zylker.io',
      role: 'user',
      type: 'system_user',
      timezone: 'UTC',
      photoUrl: null,
      initials: 'AA',
      mention: null,
      jobTitle: null,
      phone: null,
      alternateEmails: [],
      createdAt: daysAgo(60),
      updatedAt: daysAgo(60)
    }
  ];
  const teams: HsTeam[] = [
    { remoteId: 501, name: 'Tier 1', memberUserIds: [1001, 1002] },
    { remoteId: 502, name: 'Escalations', memberUserIds: [1003] }
  ];
  const mailboxes: HsMailbox[] = [
    { remoteId: 201, name: 'Support', slug: 'a1b2c3', email: 'support@zylker.io', createdAt: daysAgo(400), updatedAt: daysAgo(20) },
    { remoteId: 202, name: 'Billing', slug: 'd4e5f6', email: 'billing@zylker.io', createdAt: daysAgo(350), updatedAt: daysAgo(12) }
  ];
  const folders: HsFolder[] = [
    { remoteId: 301, mailboxId: 201, name: 'Unassigned', type: 'unassigned', userId: null, totalCount: 4, activeCount: 3 },
    { remoteId: 302, mailboxId: 201, name: 'Mine', type: 'mine', userId: 1001, totalCount: 6, activeCount: 4 },
    { remoteId: 303, mailboxId: 201, name: 'Drafts', type: 'drafts', userId: 1001, totalCount: 1, activeCount: 1 },
    { remoteId: 304, mailboxId: 202, name: 'Unassigned', type: 'unassigned', userId: null, totalCount: 2, activeCount: 1 }
  ];
  const tags: HsTag[] = [
    { remoteId: 701, name: 'timezone', slug: 'timezone', color: '#37A4FF', ticketCount: 6, createdAt: daysAgo(200), updatedAt: daysAgo(2) },
    { remoteId: 702, name: 'billing', slug: 'billing', color: '#517EDB', ticketCount: 5, createdAt: daysAgo(200), updatedAt: daysAgo(3) },
    { remoteId: 703, name: 'integration', slug: 'integration', color: '#517EDB', ticketCount: 4, createdAt: daysAgo(180), updatedAt: daysAgo(1) },
    { remoteId: 704, name: 'registration', slug: 'registration', color: '#56AF31', ticketCount: 3, createdAt: daysAgo(150), updatedAt: daysAgo(5) },
    { remoteId: 705, name: 'viewer', slug: 'viewer', color: '#56AF31', ticketCount: 3, createdAt: daysAgo(120), updatedAt: daysAgo(4) },
    { remoteId: 706, name: 'automation', slug: 'automation', color: '#929499', ticketCount: 2, createdAt: daysAgo(90), updatedAt: daysAgo(6) },
    { remoteId: 707, name: 'vip', slug: 'vip', color: '#E4BB2F', ticketCount: 2, createdAt: daysAgo(80), updatedAt: daysAgo(7) },
    { remoteId: 708, name: 'escalated', slug: 'escalated', color: '#DE5B49', ticketCount: 2, createdAt: daysAgo(70), updatedAt: daysAgo(2) },
    { remoteId: 709, name: 'release-2-4', slug: 'release-2-4', color: '#929499', ticketCount: 3, createdAt: daysAgo(14), updatedAt: daysAgo(1) },
    { remoteId: 710, name: 'docs-gap', slug: 'docs-gap', color: '#929499', ticketCount: 1, createdAt: daysAgo(30), updatedAt: daysAgo(30) },
    { remoteId: 711, name: 'api', slug: 'api', color: '#37A4FF', ticketCount: 1, createdAt: daysAgo(60), updatedAt: daysAgo(36) },
    { remoteId: 712, name: 'sso', slug: 'sso', color: '#517EDB', ticketCount: 1, createdAt: daysAgo(40), updatedAt: daysAgo(15) },
    { remoteId: 713, name: 'account', slug: 'account', color: '#929499', ticketCount: 1, createdAt: daysAgo(100), updatedAt: daysAgo(15) }
  ];
  const fields: HsField[] = [
    {
      remoteId: 104,
      mailboxId: 201,
      name: 'Topic',
      type: 'dropdown',
      systemType: null,
      required: false,
      order: 1,
      options: [
        { id: 168, order: 1, label: 'Timezone / Scheduling' },
        { id: 169, order: 2, label: 'Registration' },
        { id: 170, order: 3, label: 'Viewer' },
        { id: 171, order: 4, label: 'Integrations' },
        { id: 172, order: 5, label: 'Billing' },
        { id: 173, order: 6, label: 'Automation' }
      ]
    },
    { remoteId: 105, mailboxId: 201, name: 'ai-topic', type: 'dropdown', systemType: 'topic', required: false, order: 2, options: [{ id: 180, order: 1, label: 'Billing' }, { id: 181, order: 2, label: 'Shipping' }] },
    { remoteId: 106, mailboxId: 201, name: 'Account tier', type: 'dropdown', systemType: null, required: false, order: 3, options: [{ id: 190, order: 1, label: 'Free' }, { id: 191, order: 2, label: 'Pro' }, { id: 192, order: 3, label: 'Enterprise' }] },
    { remoteId: 107, mailboxId: 202, name: 'Plan issue', type: 'singleline', systemType: null, required: false, order: 1, options: [] }
  ];
  const savedReplies: HsSavedReply[] = [
    { remoteId: 401, name: 'Timezone - set workspace timezone', preview: 'Hi there! You can change the workspace timezone under Settings > Workspace > Regional...', text: 'Hi there!\n\nYou can change the workspace timezone under **Settings > Workspace > Regional settings**. After changing it, new scheduled items use the new timezone; existing scheduled reports keep their original time.\n\nLet me know if anything still looks off!' },
    { remoteId: 402, name: 'Registration - invite not arriving', preview: 'Sorry the invite did not arrive. Common causes: spam filtering or a typo in the address...', text: 'Hi there!\n\nSorry the invite did not arrive. The most common causes are spam filtering or a typo in the address. Could you check your spam folder and confirm the exact address you used? I have re-sent the invitation now, and I have also whitelisted your domain on our side.' },
    { remoteId: 403, name: 'Viewer role - what it can access', preview: 'Viewers can see dashboards and reports but cannot edit them...', text: 'Hi there!\n\nA Viewer can see every dashboard and report that is shared with their team, but cannot edit, comment, or create new ones. If someone needs edit rights, an Editor seat is required.' },
    { remoteId: 404, name: 'Billing - update card and retry', preview: 'You can update your card under Settings > Billing. After updating...', text: 'Hi there!\n\nYou can update your card under **Settings > Billing > Payment method**. After updating, click "Retry payment" so the pending invoice is charged again; the license re-activates immediately after a successful charge.' },
    { remoteId: 405, name: 'Integration - reconnect OAuth', preview: 'To reconnect the integration: open Integrations, click Disconnect...', text: 'Hi there!\n\nTo reconnect the integration: open **Integrations**, click **Disconnect**, then **Connect** again and approve the permission prompt. Reconnecting never deletes your historical sync data.' }
  ];
  const workflows: HsWorkflow[] = [
    { remoteId: 601, mailboxId: 201, name: 'Assign to Tier 1', type: 'manual', status: 'active', order: 1 },
    { remoteId: 602, mailboxId: 201, name: 'Spam cleanup', type: 'manual', status: 'active', order: 2 },
    { remoteId: 603, mailboxId: 202, name: 'Auto-route billing', type: 'automatic', status: 'active', order: 1 }
  ];
  const webhooks: HsWebhookConfig[] = [
    { remoteId: 801, url: 'https://relay.example.com/helpscout', events: ['convo.created', 'convo.customer.reply.created', 'satisfaction.ratings'], status: 'active' }
  ];
  const customerProps: HsPropertyDef[] = [
    { remoteId: 4101, name: 'Plan', slug: 'plan', type: 'dropdown', order: 1 },
    { remoteId: 4102, name: 'Employees', slug: 'employees', type: 'number', order: 2 }
  ];
  const orgProps: HsPropertyDef[] = [{ remoteId: 4201, name: 'Industry', slug: 'industry', type: 'text', order: 1 }];

  const customers: HsCustomer[] = [
    {
      remoteId: 3001,
      firstName: 'Lucía',
      lastName: 'Morales',
      photoUrl: null,
      jobTitle: 'Operations Manager',
      emails: [{ value: 'lucia@andeslogistics.cl', type: 'work' }, { value: 'l.morales@gmail.com', type: 'other' }],
      phones: [{ value: '+56 2 1234 5678', type: 'work' }],
      websites: [{ value: 'https://andeslogistics.cl' }],
      socialProfiles: [{ value: 'luciam', type: 'twitter' }],
      address: { line1: 'Av. Providencia 1234', line2: null, city: 'Santiago', state: null, postalCode: '7500572', country: 'Chile' },
      organization: { id: 2001, name: 'Andes Logistics' },
      createdAt: daysAgo(220),
      updatedAt: daysAgo(3)
    },
    {
      remoteId: 3002,
      firstName: 'Mateo',
      lastName: 'Morales',
      photoUrl: null,
      jobTitle: 'Dispatcher',
      emails: [{ value: 'mateo@andeslogistics.cl', type: 'work' }],
      phones: [],
      websites: [],
      socialProfiles: [],
      address: null,
      organization: { id: 2001, name: 'Andes Logistics' },
      createdAt: daysAgo(180),
      updatedAt: daysAgo(10)
    },
    {
      remoteId: 3003,
      firstName: 'Sarah',
      lastName: 'Okafor',
      photoUrl: null,
      jobTitle: 'CTO',
      emails: [{ value: 'sarah@brightpathedu.org', type: 'work' }],
      phones: [{ value: '+1 555 010 2233', type: 'mobile' }],
      websites: [{ value: 'https://brightpathedu.org' }],
      socialProfiles: [{ value: 'sarahokafor', type: 'linkedin' }],
      address: { line1: '88 Kingsway', line2: null, city: 'London', state: null, postalCode: 'WC2B 6AA', country: 'United Kingdom' },
      organization: { id: 2002, name: 'BrightPath Education' },
      createdAt: daysAgo(150),
      updatedAt: daysAgo(5)
    },
    {
      remoteId: 3004,
      firstName: 'Daniel',
      lastName: 'Kim',
      photoUrl: null,
      jobTitle: 'Developer',
      emails: [{ value: 'daniel.kim@brightpathedu.org', type: 'work' }],
      phones: [],
      websites: [],
      socialProfiles: [],
      address: null,
      organization: { id: 2002, name: 'BrightPath Education' },
      createdAt: daysAgo(90),
      updatedAt: daysAgo(8)
    },
    {
      remoteId: 3005,
      firstName: 'Emma',
      lastName: 'Lindqvist',
      photoUrl: null,
      jobTitle: null,
      emails: [{ value: 'emma.lindqvist@nordicmail.se', type: 'work' }],
      phones: [],
      websites: [],
      socialProfiles: [],
      address: null,
      organization: null,
      createdAt: daysAgo(60),
      updatedAt: daysAgo(12)
    },
    {
      remoteId: 3006,
      firstName: 'Ravi',
      lastName: 'Sundaram',
      photoUrl: null,
      jobTitle: 'IT Admin',
      emails: [{ value: 'ravi@pixelworks.in', type: 'work' }],
      phones: [],
      websites: [{ value: 'https://pixelworks.in' }],
      socialProfiles: [],
      address: null,
      organization: null,
      createdAt: daysAgo(45),
      updatedAt: daysAgo(6)
    },
    {
      remoteId: 3007,
      firstName: 'Chloe',
      lastName: 'Dubois',
      photoUrl: null,
      jobTitle: 'Finance Lead',
      emails: [{ value: 'chloe@atelierfrance.fr', type: 'work' }],
      phones: [],
      websites: [],
      socialProfiles: [],
      address: null,
      organization: null,
      createdAt: daysAgo(30),
      updatedAt: daysAgo(2)
    },
    {
      remoteId: 3008,
      firstName: 'Hiro',
      lastName: 'Tanaka',
      photoUrl: null,
      jobTitle: 'Product Manager',
      emails: [{ value: 'hiro.tanaka@sakuradata.jp', type: 'work' }],
      phones: [],
      websites: [],
      socialProfiles: [],
      address: null,
      organization: null,
      createdAt: daysAgo(20),
      updatedAt: daysAgo(1)
    }
  ];
  const organizations: HsOrganization[] = [
    { remoteId: 2001, name: 'Andes Logistics', domains: ['andeslogistics.cl'], createdAt: daysAgo(220), updatedAt: daysAgo(10) },
    { remoteId: 2002, name: 'BrightPath Education', domains: ['brightpathedu.org'], createdAt: daysAgo(150), updatedAt: daysAgo(5) }
  ];

  // --- Conversations + threads ---
  const conversations: HsConversation[] = [];
  const threads: HsThread[] = [];
  let convNum = 5000;
  let threadId = 10000;

  function thread(conv: HsConversation, opts: Partial<HsThread> & { body: string; createdAt: string }): HsThread {
    const t: HsThread = {
      remoteId: ++threadId,
      conversationId: conv.remoteId,
      type: opts.type ?? 'customer',
      state: opts.state ?? 'published',
      status: null,
      actionType: opts.actionType ?? null,
      actionText: opts.actionText ?? null,
      body: opts.body,
      sourceType: 'email',
      sourceVia: opts.type === 'customer' ? 'customer' : 'user',
      customer: opts.customer ?? null,
      createdBy: opts.createdBy ?? null,
      assignedTo: null,
      savedReplyId: opts.savedReplyId ?? null,
      to: opts.to ?? [],
      cc: opts.cc ?? [],
      bcc: [],
      createdAt: opts.createdAt,
      attachments: opts.attachments ?? []
    };
    threads.push(t);
    conv.threadCount = threads.filter((x) => x.conversationId === conv.remoteId).length;
    return t;
  }

  function conversation(opts: {
    subject: string;
    preview: string;
    mailboxId: number;
    customer: HsCustomer;
    status: 'active' | 'pending' | 'closed';
    tags: string[];
    assigneeId?: number | null;
    createdDaysAgo: number;
    closedDaysAgo?: number;
    snoozedUntil?: string | null;
    customFields?: { fieldId: number; value: string; text: string; systemType?: string | null }[];
  }): HsConversation {
    const c: HsConversation = {
      remoteId: convNum + 100000,
      number: ++convNum,
      type: 'email',
      folderId: null,
      status: opts.status,
      state: 'published',
      subject: opts.subject,
      preview: opts.preview,
      mailboxId: opts.mailboxId,
      assigneeId: opts.assigneeId ?? null,
      assigneeType: opts.assigneeId ? 'user' : null,
      assignedTeamId: null,
      closedAt: opts.closedDaysAgo !== undefined ? daysAgo(opts.closedDaysAgo, 16, 5) : null,
      createdAt: daysAgo(opts.createdDaysAgo, 9, 12),
      userUpdatedAt: daysAgo(Math.max(0, opts.createdDaysAgo - 1), 14, 40),
      tags: opts.tags.map((name) => ({ remoteId: tags.find((t) => t.name === name)?.remoteId ?? null, name, color: null })),
      primaryCustomerId: opts.customer.remoteId,
      primaryCustomerName: `${opts.customer.firstName} ${opts.customer.lastName}`,
      primaryCustomerEmail: opts.customer.emails[0]?.value ?? null,
      cc: [],
      bcc: [],
      snoozedUntil: opts.snoozedUntil ?? null,
      customFields: opts.customFields ?? [],
      threadCount: 0
    };
    conversations.push(c);
    return c;
  }

  const cust = (id: number) => customers.find((c) => c.remoteId === id)!;

  // 1. Timezone issue (Lucía) - recurring topic, knowledge exists
  const c1 = conversation({
    subject: 'Scheduled report sent at wrong hour (Santiago time)',
    preview: 'Our daily dispatch report is being sent at 3 AM Chilean time instead of 8 AM...',
    mailboxId: 201,
    customer: cust(3001),
    status: 'active',
    tags: ['timezone', 'vip'],
    assigneeId: 1001,
    createdDaysAgo: 3,
    customFields: [{ fieldId: 104, value: '168', text: 'Timezone / Scheduling' }]
  });
  thread(c1, {
    body: '<p>Hello,</p><p>Our daily dispatch report is being sent at 3 AM Chilean time instead of 8 AM as configured. We are in Santiago (UTC-4 currently due to daylight saving). The workspace timezone says "America/Santiago" in the settings page but the schedule editor still shows UTC times.</p><p>Can you tell me how to make the schedule follow our local timezone? This affects our morning operations meeting.</p><p>Thank you,<br>Lucía Morales<br>Andes Logistics</p>',
    createdAt: daysAgo(3, 9, 12),
    customer: { id: 3001, first: 'Lucía', last: 'Morales', email: 'lucia@andeslogistics.cl' },
    createdBy: { id: 3001, type: 'customer', first: 'Lucía', last: 'Morales', email: 'lucia@andeslogistics.cl' },
    to: ['support@zylker.io']
  });
  thread(c1, {
    type: 'reply',
    body: '<p>Hi Lucía,</p><p>Thanks for the details. I can see the workspace is set to America/Santiago and the "Daily dispatch" schedule is currently stored with a UTC offset from before the daylight-saving change.</p><p>Could you open the schedule and re-save it once? That re-stamps it with the current offset. I am checking with engineering whether a mid-cycle DST change can re-anchor schedules automatically.</p><p>Best,<br>Alex</p>',
    createdAt: daysAgo(3, 13, 5),
    createdBy: { id: 1001, type: 'user', first: 'Alex', last: 'Rivera', email: 'alex@zylker.io' },
    to: ['lucia@andeslogistics.cl']
  });
  thread(c1, {
    body: '<p>I re-saved the schedule and it now shows 8 AM correctly. But a second report ("Weekly summary") is still one hour off.</p>',
    createdAt: daysAgo(2, 10, 22),
    customer: { id: 3001, first: 'Lucía', last: 'Morales', email: 'lucia@andeslogistics.cl' },
    createdBy: { id: 3001, type: 'customer', first: 'Lucía', last: 'Morales', email: 'lucia@andeslogistics.cl' },
    to: ['support@zylker.io']
  });

  // 2. Second timezone ticket (Mateo, same company) - shows recurrence/cluster
  const c2 = conversation({
    subject: 'Meeting reminders in wrong timezone after DST',
    preview: 'Since the clock change last weekend all meeting reminders arrive one hour late...',
    mailboxId: 201,
    customer: cust(3002),
    status: 'active',
    tags: ['timezone', 'release-2-4'],
    assigneeId: null,
    createdDaysAgo: 5,
    customFields: [{ fieldId: 104, value: '168', text: 'Timezone / Scheduling' }]
  });
  thread(c2, {
    body: '<p>Since the clock change last weekend all meeting reminders arrive one hour late. We are in Chile. Is there a fix?</p>',
    createdAt: daysAgo(5, 11, 3),
    customer: { id: 3002, first: 'Mateo', last: 'Morales', email: 'mateo@andeslogistics.cl' },
    createdBy: { id: 3002, type: 'customer', first: 'Mateo', last: 'Morales', email: 'mateo@andeslogistics.cl' },
    to: ['support@zylker.io']
  });

  // 3. Old closed timezone ticket - historical resolution for retrieval
  const c3 = conversation({
    subject: 'Timezone for scheduled exports',
    preview: 'How do I set the timezone used for scheduled exports?',
    mailboxId: 201,
    customer: cust(3005),
    status: 'closed',
    tags: ['timezone'],
    assigneeId: 1002,
    createdDaysAgo: 40,
    closedDaysAgo: 39,
    customFields: [{ fieldId: 104, value: '168', text: 'Timezone / Scheduling' }]
  });
  thread(c3, {
    body: '<p>How do I set the timezone used for scheduled exports? They all arrive in UTC and my team is in Stockholm.</p>',
    createdAt: daysAgo(40, 9, 45),
    customer: { id: 3005, first: 'Emma', last: 'Lindqvist', email: 'emma.lindqvist@nordicmail.se' },
    createdBy: { id: 3005, type: 'customer', first: 'Emma', last: 'Lindqvist', email: 'emma.lindqvist@nordicmail.se' },
    to: ['support@zylker.io']
  });
  thread(c3, {
    type: 'reply',
    body: '<p>Hi Emma,</p><p>Scheduled exports follow the workspace timezone: Settings > Workspace > Regional settings. After changing it, re-save each schedule once so the stored times re-anchor to the new timezone.</p><p>Best,<br>Priya</p>',
    createdAt: daysAgo(40, 12, 10),
    createdBy: { id: 1002, type: 'user', first: 'Priya', last: 'Nair', email: 'priya@zylker.io' },
    to: ['emma.lindqvist@nordicmail.se']
  });
  thread(c3, {
    body: '<p>That worked, thank you!</p>',
    createdAt: daysAgo(39, 8, 30),
    customer: { id: 3005, first: 'Emma', last: 'Lindqvist', email: 'emma.lindqvist@nordicmail.se' },
    createdBy: { id: 3005, type: 'customer', first: 'Emma', last: 'Lindqvist', email: 'emma.lindqvist@nordicmail.se' },
    to: ['support@zylker.io']
  });

  // 4. Registration invite issue (Sarah)
  const c4 = conversation({
    subject: 'Invitation email never arrives for new teammate',
    preview: 'I invited daniel@brightpathedu.org three times but no email arrives...',
    mailboxId: 201,
    customer: cust(3003),
    status: 'pending',
    tags: ['registration'],
    assigneeId: 1002,
    createdDaysAgo: 6,
    customFields: [{ fieldId: 104, value: '169', text: 'Registration' }]
  });
  thread(c4, {
    body: '<p>Hello,</p><p>I invited daniel@brightpathedu.org three times yesterday but no invitation email arrives. Our mail provider logs show nothing from your domain either. Could you check whether the invitations are being sent?</p><p>Thanks,<br>Sarah</p>',
    createdAt: daysAgo(6, 10, 5),
    customer: { id: 3003, first: 'Sarah', last: 'Okafor', email: 'sarah@brightpathedu.org' },
    createdBy: { id: 3003, type: 'customer', first: 'Sarah', last: 'Okafor', email: 'sarah@brightpathedu.org' },
    to: ['support@zylker.io']
  });
  thread(c4, {
    type: 'note',
    body: '<p>Checked mail logs - invitation to daniel@brightpathedu.org bounced with "550 policy reasons" from their provider. Re-sent after whitelisting; asked customer to confirm arrival. If it bounces again we will recommend sending to an alias address.</p>',
    createdAt: daysAgo(6, 15, 20),
    createdBy: { id: 1002, type: 'user', first: 'Priya', last: 'Nair', email: 'priya@zylker.io' }
  });
  thread(c4, {
    type: 'reply',
    body: '<p>Hi Sarah,</p><p>The invitation to daniel@brightpathedu.org was bouncing with a policy rejection from your mail provider. I have re-sent it and whitelisted your domain on our side. Could you confirm whether it arrives in the next few minutes? If not, we can send it to an alternate address.</p><p>Best,<br>Priya</p>',
    createdAt: daysAgo(6, 15, 25),
    createdBy: { id: 1002, type: 'user', first: 'Priya', last: 'Nair', email: 'priya@zylker.io' },
    to: ['sarah@brightpathedu.org']
  });

  // 5. Viewer permissions (Daniel)
  const c5 = conversation({
    subject: 'What can a Viewer see?',
    preview: 'What is the difference between Viewer and Editor? Can viewers see all reports...',
    mailboxId: 201,
    customer: cust(3004),
    status: 'closed',
    tags: ['viewer'],
    assigneeId: 1001,
    createdDaysAgo: 12,
    closedDaysAgo: 11,
    customFields: [{ fieldId: 104, value: '170', text: 'Viewer' }]
  });
  thread(c5, {
    body: '<p>What is the difference between Viewer and Editor? Can viewers see all reports or only ones shared with them? Can they export data?</p>',
    createdAt: daysAgo(12, 9, 40),
    customer: { id: 3004, first: 'Daniel', last: 'Kim', email: 'daniel.kim@brightpathedu.org' },
    createdBy: { id: 3004, type: 'customer', first: 'Daniel', last: 'Kim', email: 'daniel.kim@brightpathedu.org' },
    to: ['support@zylker.io']
  });
  thread(c5, {
    type: 'reply',
    body: '<p>Hi Daniel,</p><p>A Viewer can see every dashboard and report shared with their team, but cannot edit, comment, or create new ones. Viewers can export data from reports they can see (CSV/PDF). An Editor seat is required for edit rights.</p><p>Best,<br>Alex</p>',
    createdAt: daysAgo(12, 11, 15),
    createdBy: { id: 1001, type: 'user', first: 'Alex', last: 'Rivera', email: 'alex@zylker.io' },
    savedReplyId: 403,
    to: ['daniel.kim@brightpathedu.org']
  });

  // 6a. Ravi history: detailed, technical, calm closed tickets (Client Interaction Intelligence demo baseline)
  const c6h1 = conversation({
    subject: 'Webhook payload format after v2.4 upgrade',
    preview: 'After upgrading to v2.4 our webhook receiver rejects the payload schema...',
    mailboxId: 201,
    customer: cust(3006),
    status: 'closed',
    tags: ['integration'],
    assigneeId: 1002,
    createdDaysAgo: 70,
    closedDaysAgo: 68,
    customFields: [{ fieldId: 104, value: '171', text: 'Integrations' }]
  });
  thread(c6h1, {
    body: '<p>Hello,</p><p>After upgrading to v2.4 last Saturday our webhook receiver started rejecting the payload schema. I captured the failing delivery from the integrations log (delivery ID WH-10231) and diffed it against the v2.3 format:</p><p>- The "event.type" field now uses dot notation ("conversation.updated" instead of "conversationUpdated")<br>- The "payload" object is base64-encoded rather than plain JSON<br>- Headers include a new X-Signature-v2 alongside the legacy X-Signature</p><p>Our receiver validates against a strict JSON schema and returns HTTP 422 before the handler runs, so nothing is processed. I could relax the schema, but I would rather understand the intended contract first. Is there a changelog entry describing the new format, and is the legacy format supported during a transition period? We process roughly 4,000 events per day through this endpoint, so I want to migrate deliberately rather than reactively.</p><p>Thanks,<br>Ravi Sundaram<br>PixelWorks IT</p>',
    createdAt: daysAgo(70, 9, 40),
    customer: { id: 3006, first: 'Ravi', last: 'Sundaram', email: 'ravi@pixelworks.in' },
    createdBy: { id: 3006, type: 'customer', first: 'Ravi', last: 'Sundaram', email: 'ravi@pixelworks.in' },
    to: ['support@zylker.io']
  });
  thread(c6h1, {
    type: 'reply',
    body: '<p>Hi Ravi,</p><p>The v2.4 release notes cover the webhook contract change under "Breaking changes". The legacy format is supported until the end of the quarter via the workspace setting "Webhooks: legacy payload", after which dot-notation events become the only format. Both signature headers validate with the same secret during the transition.</p><p>Recommended migration order: add schema acceptance for both shapes first, monitor dual-format traffic for a week, then drop the legacy branch.</p><p>Best,<br>Priya</p>',
    createdAt: daysAgo(69, 11, 20),
    createdBy: { id: 1002, type: 'user', first: 'Priya', last: 'Nair', email: 'priya@zylker.io' },
    to: ['ravi@pixelworks.in']
  });
  thread(c6h1, {
    body: '<p>That is exactly what I needed — the dual-format monitoring suggestion made the migration straightforward. Receiver deployed with both schemas accepted and traffic looks clean. Closing from my side.</p>',
    createdAt: daysAgo(68, 8, 15),
    customer: { id: 3006, first: 'Ravi', last: 'Sundaram', email: 'ravi@pixelworks.in' },
    createdBy: { id: 3006, type: 'customer', first: 'Ravi', last: 'Sundaram', email: 'ravi@pixelworks.in' },
    to: ['support@zylker.io']
  });

  const c6h2 = conversation({
    subject: 'API rate limits for bulk export endpoint',
    preview: 'What are the documented rate limits for the bulk export API and do they reset per token...',
    mailboxId: 201,
    customer: cust(3006),
    status: 'closed',
    tags: ['api'],
    assigneeId: 1002,
    createdDaysAgo: 38,
    closedDaysAgo: 36,
    customFields: [{ fieldId: 104, value: '171', text: 'Integrations' }]
  });
  thread(c6h2, {
    body: '<p>Hello,</p><p>Two questions about the bulk export API (<code>/v3/exports</code>):</p><p>1. The documentation mentions a per-minute rate limit but not whether it applies per API token, per workspace, or per endpoint. Which is it? We run two workers with separate tokens from the same workspace and saw inconsistent 429 behavior.<br>2. When a 429 returns the Retry-After header, does the documented limit reset at that instant or at the next window boundary?</p><p>Context: we schedule exports nightly with a 15-minute window, and a mid-run 429 currently aborts the whole job. I would rather back off and resume than abort, but I need to know which clock the limit resets on.</p><p>Thanks,<br>Ravi</p>',
    createdAt: daysAgo(38, 10, 5),
    customer: { id: 3006, first: 'Ravi', last: 'Sundaram', email: 'ravi@pixelworks.in' },
    createdBy: { id: 3006, type: 'customer', first: 'Ravi', last: 'Sundaram', email: 'ravi@pixelworks.in' },
    to: ['support@zylker.io']
  });
  thread(c6h2, {
    type: 'reply',
    body: '<p>Hi Ravi,</p><p>Answers below:</p><p>1. The limit is per API token, not per workspace. Your two workers each have the full documented quota, which explains the inconsistency you saw — one worker was likely consuming a shared proxy cache.<br>2. The window is a fixed rolling 60 seconds counted from the first request; Retry-After points to the end of the current window, so backing off until that timestamp is correct and resuming is safe.</p><p>Your resume-instead-of-abort plan is exactly what the header is for.</p><p>Best,<br>Priya</p>',
    createdAt: daysAgo(37, 9, 50),
    createdBy: { id: 1002, type: 'user', first: 'Priya', last: 'Nair', email: 'priya@zylker.io' },
    to: ['ravi@pixelworks.in']
  });
  thread(c6h2, {
    body: '<p>Clear and complete. Implemented per-token accounting with resume-on-429 and the nightly job has been clean since. Thank you!</p>',
    createdAt: daysAgo(36, 9, 10),
    customer: { id: 3006, first: 'Ravi', last: 'Sundaram', email: 'ravi@pixelworks.in' },
    createdBy: { id: 3006, type: 'customer', first: 'Ravi', last: 'Sundaram', email: 'ravi@pixelworks.in' },
    to: ['support@zylker.io']
  });

  const c6h3 = conversation({
    subject: 'SSO SAML metadata renewal question',
    preview: 'Our identity provider is rotating certificates next month - what do we need to update...',
    mailboxId: 201,
    customer: cust(3006),
    status: 'closed',
    tags: ['sso', 'account'],
    assigneeId: 1001,
    createdDaysAgo: 17,
    closedDaysAgo: 15,
    customFields: [{ fieldId: 104, value: '169', text: 'Account & Billing' }]
  });
  thread(c6h3, {
    body: '<p>Hello,</p><p>Our identity provider rotates SAML signing certificates annually and the next rotation lands on the first of next month. Before that date I want to confirm the renewal procedure on your side so logins do not break for our 120 users:</p><p>- Does the workspace accept a metadata URL that serves both the current and the upcoming certificate during overlap, or must the new certificate be uploaded manually?<br>- Is there a documented propagation delay after metadata refresh that we should schedule around?<br>- Are there logs in the admin panel that would show a failing assertion signature specifically, so I can distinguish a rotation issue from a clock-skew issue?</p><p>Historically the annual rotation has been smooth, but last year the overlap window was shorter than the propagation delay and a few users hit a failed login loop. I would like to avoid a repeat.</p><p>Thanks,<br>Ravi</p>',
    createdAt: daysAgo(17, 9, 25),
    customer: { id: 3006, first: 'Ravi', last: 'Sundaram', email: 'ravi@pixelworks.in' },
    createdBy: { id: 3006, type: 'customer', first: 'Ravi', last: 'Sundaram', email: 'ravi@pixelworks.in' },
    to: ['support@zylker.io']
  });
  thread(c6h3, {
    type: 'reply',
    body: '<p>Hi Ravi,</p><p>The metadata URL path is the recommended one: we fetch it nightly and accept every certificate it advertises, so serving both during the overlap period is exactly right. Propagation is at most 24 hours after the nightly fetch, so start the overlap window two days early. Admin → Security → SSO log entries distinguish "assertion signature validation failed" (rotation) from "assertion time window exceeded" (clock skew).</p><p>Best,<br>Alex</p>',
    createdAt: daysAgo(16, 14, 5),
    createdBy: { id: 1001, type: 'user', first: 'Alex', last: 'Rivera', email: 'alex@zylker.io' },
    to: ['ravi@pixelworks.in']
  });
  thread(c6h3, {
    body: '<p>Started the overlap window today as suggested. Rotation completed overnight with zero failed logins — the log filter you pointed out made verification quick. Thanks again.</p>',
    createdAt: daysAgo(15, 9, 0),
    customer: { id: 3006, first: 'Ravi', last: 'Sundaram', email: 'ravi@pixelworks.in' },
    createdBy: { id: 3006, type: 'customer', first: 'Ravi', last: 'Sundaram', email: 'ravi@pixelworks.in' },
    to: ['support@zylker.io']
  });

  // 6. Integration broken (Ravi) - escalated
  const c6 = conversation({
    subject: 'Slack integration stopped posting updates',
    preview: 'Since last week the Slack integration no longer posts updates to our channel...',
    mailboxId: 201,
    customer: cust(3006),
    status: 'active',
    tags: ['integration', 'escalated', 'release-2-4'],
    assigneeId: 1003,
    createdDaysAgo: 4,
    customFields: [{ fieldId: 104, value: '171', text: 'Integrations' }]
  });
  thread(c6, {
    body: '<p>Hi,</p><p>Since last week the Slack integration no longer posts updates to our #ops channel. I disconnected and reconnected once already. We use it for alerting so this is urgent for us.</p><p>Log ID from the integrations page: INT-88231.</p><p>Ravi</p>',
    createdAt: daysAgo(4, 8, 55),
    customer: { id: 3006, first: 'Ravi', last: 'Sundaram', email: 'ravi@pixelworks.in' },
    createdBy: { id: 3006, type: 'customer', first: 'Ravi', last: 'Sundaram', email: 'ravi@pixelworks.in' },
    to: ['support@zylker.io'],
    attachments: [{ id: 9001, filename: 'integration-log.txt', mimeType: 'text/plain', size: 2048 }]
  });
  thread(c6, {
    type: 'note',
    body: '<p>INT-88231 shows repeated 401 from Slack side after their token rotation policy change. Escalating to engineering - reference ENG-4471. Customer-facing wording must stay generic until engineering confirms.</p>',
    createdAt: daysAgo(3, 9, 30),
    createdBy: { id: 1003, type: 'user', first: 'Tom', last: 'Bright', email: 'tom@zylker.io' }
  });
  thread(c6, {
    type: 'reply',
    body: '<p>Hi Ravi,</p><p>Thanks for the log ID. We traced the failure to an authentication change on Slack\'s side affecting some workspaces. Our engineering team is working on a fix and I will update you as soon as it is deployed. Your historical data is unaffected.</p><p>Best,<br>Tom</p>',
    createdAt: daysAgo(3, 9, 45),
    createdBy: { id: 1003, type: 'user', first: 'Tom', last: 'Bright', email: 'tom@zylker.io' },
    to: ['ravi@pixelworks.in']
  });

  // 7. Billing failed charge (Chloe)
  const c7 = conversation({
    subject: 'Card payment failing but card is valid',
    preview: 'Our subscription shows past due but our card works everywhere else...',
    mailboxId: 202,
    customer: cust(3007),
    status: 'active',
    tags: ['billing'],
    assigneeId: null,
    createdDaysAgo: 2,
    customFields: [{ fieldId: 107, value: 'Card declined (do_not_honor)', text: 'Card declined (do_not_honor)' }]
  });
  thread(c7, {
    body: '<p>Bonjour,</p><p>Our subscription shows "past due" but our card works everywhere else. The bank says no charge was even attempted this month. Can you retry the payment?</p><p>Merci,<br>Chloe Dubois<br>Atelier France</p>',
    createdAt: daysAgo(2, 9, 5),
    customer: { id: 3007, first: 'Chloe', last: 'Dubois', email: 'chloe@atelierfrance.fr' },
    createdBy: { id: 3007, type: 'customer', first: 'Chloe', last: 'Dubois', email: 'chloe@atelierfrance.fr' },
    to: ['billing@zylker.io']
  });

  // 8. Billing VAT invoice (Chloe)
  const c8 = conversation({
    subject: 'Need VAT number on invoices',
    preview: 'Can you add our VAT number FR40303265045 to all invoices...',
    mailboxId: 202,
    customer: cust(3007),
    status: 'closed',
    tags: ['billing'],
    assigneeId: 1001,
    createdDaysAgo: 25,
    closedDaysAgo: 24
  });
  thread(c8, {
    body: '<p>Can you add our VAT number FR40303265045 to all invoices, including past ones? Our accounting needs it for the annual filing.</p>',
    createdAt: daysAgo(25, 10, 15),
    customer: { id: 3007, first: 'Chloe', last: 'Dubois', email: 'chloe@atelierfrance.fr' },
    createdBy: { id: 3007, type: 'customer', first: 'Chloe', last: 'Dubois', email: 'chloe@atelierfrance.fr' },
    to: ['billing@zylker.io']
  });
  thread(c8, {
    type: 'reply',
    body: '<p>Hi Chloe,</p><p>I have added VAT number FR40303265045 to your billing profile and re-issued the last 12 invoices as PDFs; they are attached to your billing history. Future invoices will include it automatically.</p><p>Best,<br>Alex</p>',
    createdAt: daysAgo(24, 14, 0),
    createdBy: { id: 1001, type: 'user', first: 'Alex', last: 'Rivera', email: 'alex@zylker.io' },
    to: ['chloe@atelierfrance.fr'],
    attachments: [
      { id: 9002, filename: 'invoice-2024-11.pdf', mimeType: 'application/pdf', size: 118000 },
      { id: 9003, filename: 'invoice-2024-12.pdf', mimeType: 'application/pdf', size: 119500 }
    ]
  });

  // 9. Automation question (Hiro)
  const c9 = conversation({
    subject: 'Can automation rules run on a schedule?',
    preview: 'Can I schedule an automation rule to run every morning at 9 and tag stale tickets...',
    mailboxId: 201,
    customer: cust(3008),
    status: 'active',
    tags: ['automation'],
    assigneeId: 1002,
    createdDaysAgo: 1,
    customFields: [{ fieldId: 104, value: '173', text: 'Automation' }]
  });
  thread(c9, {
    body: '<p>Hello,</p><p>Two questions about automation rules:</p><p>1) Can I schedule a rule to run every morning at 9 AM, e.g. to tag stale tickets?</p><p>2) Is there an API to trigger rules externally?</p><p>Thank you,<br>Hiro Tanaka</p>',
    createdAt: daysAgo(1, 8, 20),
    customer: { id: 3008, first: 'Hiro', last: 'Tanaka', email: 'hiro.tanaka@sakuradata.jp' },
    createdBy: { id: 3008, type: 'customer', first: 'Hiro', last: 'Tanaka', email: 'hiro.tanaka@sakuradata.jp' },
    to: ['support@zylker.io']
  });

  // 10. Registration duplicate (Emma) - closed
  const c10 = conversation({
    subject: 'Duplicate account created',
    preview: 'I accidentally signed up twice with two emails. Can you merge the accounts...',
    mailboxId: 201,
    customer: cust(3005),
    status: 'closed',
    tags: ['registration'],
    assigneeId: 1001,
    createdDaysAgo: 55,
    closedDaysAgo: 54
  });
  thread(c10, {
    body: '<p>I accidentally signed up twice with two emails. Can you merge the accounts? The one to keep is emma.lindqvist@nordicmail.se.</p>',
    createdAt: daysAgo(55, 13, 30),
    customer: { id: 3005, first: 'Emma', last: 'Lindqvist', email: 'emma.lindqvist@nordicmail.se' },
    createdBy: { id: 3005, type: 'customer', first: 'Emma', last: 'Lindqvist', email: 'emma.lindqvist@nordicmail.se' },
    to: ['support@zylker.io']
  });
  thread(c10, {
    type: 'reply',
    body: '<p>Hi Emma,</p><p>I merged the accounts and moved the license to emma.lindqvist@nordicmail.se. The duplicate address can no longer be used to log in.</p><p>Best,<br>Alex</p>',
    createdAt: daysAgo(54, 10, 0),
    createdBy: { id: 1001, type: 'user', first: 'Alex', last: 'Rivera', email: 'alex@zylker.io' },
    to: ['emma.lindqvist@nordicmail.se']
  });

  // 11. Pending snoozed conversation (Sarah, waiting for customer)
  const c11 = conversation({
    subject: 'Data export format question',
    preview: 'Can exports include the raw JSON fields in addition to CSV...',
    mailboxId: 201,
    customer: cust(3003),
    status: 'pending',
    tags: [],
    assigneeId: 1001,
    createdDaysAgo: 8,
    snoozedUntil: daysAgo(-2, 9, 0)
  });
  thread(c11, {
    body: '<p>Can exports include the raw JSON fields in addition to CSV? We want to load them into our warehouse.</p>',
    createdAt: daysAgo(8, 11, 11),
    customer: { id: 3003, first: 'Sarah', last: 'Okafor', email: 'sarah@brightpathedu.org' },
    createdBy: { id: 3003, type: 'customer', first: 'Sarah', last: 'Okafor', email: 'sarah@brightpathedu.org' },
    to: ['support@zylker.io']
  });
  thread(c11, {
    type: 'reply',
    body: '<p>Hi Sarah,</p><p>CSV is the only scheduled-export format today. I have noted your interest in JSON. Would a one-off manual export work for you in the meantime?</p><p>Best,<br>Alex</p>',
    createdAt: daysAgo(8, 15, 45),
    createdBy: { id: 1001, type: 'user', first: 'Alex', last: 'Rivera', email: 'alex@zylker.io' },
    to: ['sarah@brightpathedu.org']
  });

  // 12. Merged conversation: c12 was merged into c2
  const c12 = conversation({
    subject: 'Reminder one hour late',
    preview: 'Meeting reminders are one hour late since the weekend.',
    mailboxId: 201,
    customer: cust(3002),
    status: 'closed',
    tags: ['timezone'],
    assigneeId: null,
    createdDaysAgo: 5
  });
  (c12 as HsConversation & { mergedInto?: number }).mergedInto = c2.remoteId;

  const ratings: HsRating[] = [
    { remoteId: 601, conversationId: c3.remoteId, threadId: null, rating: 'great', comments: 'Quick and clear, thank you!', customerId: 3005, customerName: 'Emma Lindqvist', userId: 1002, createdAt: daysAgo(39, 9, 0) },
    { remoteId: 602, conversationId: c5.remoteId, threadId: null, rating: 'great', comments: null, customerId: 3004, customerName: 'Daniel Kim', userId: 1001, createdAt: daysAgo(11, 12, 0) },
    { remoteId: 603, conversationId: c8.remoteId, threadId: null, rating: 'okay', comments: 'Fine, but would like this self-service.', customerId: 3007, customerName: 'Chloe Dubois', userId: 1001, createdAt: daysAgo(24, 15, 0) },
    { remoteId: 604, conversationId: c10.remoteId, threadId: null, rating: 'great', comments: null, customerId: 3005, customerName: 'Emma Lindqvist', userId: 1001, createdAt: daysAgo(54, 11, 0) }
  ];

  const userStatuses: HsUserStatus[] = [
    { userId: 1001, emailStatus: 'active', emailUpdatedAt: daysAgo(1, 8, 0), chatStatus: 'active', mailboxStatuses: { '201': 'assign', '202': 'assign' } },
    { userId: 1002, emailStatus: 'active', emailUpdatedAt: daysAgo(1, 8, 0), chatStatus: 'assign', mailboxStatuses: { '201': 'assign' } },
    { userId: 1003, emailStatus: 'away', emailUpdatedAt: daysAgo(2, 9, 0), chatStatus: 'unavailable', mailboxStatuses: {} }
  ];

  return { me, users, systemUsers, teams, mailboxes, folders, tags, fields, savedReplies, workflows, webhooks, customerProps, orgProps, customers, organizations, conversations, threads, ratings, userStatuses };
}
