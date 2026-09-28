import fsModule from 'node:fs';
import type { DB } from '../database/connection.js';
import { openDatabase, tableStats, getDatabasePath } from '../database/connection.js';
import { applyMigrations } from '../database/migrations/index.js';
import { migrationsApplied } from '../database/migrator.js';
import { config, type AppConfig } from '../config/config.js';
import { createLogger, type StructuredLogger } from '../config/logger.js';
import type { HelpScoutProvider } from '../integrations/helpscout/provider.js';
import { RealHelpScoutProvider } from '../integrations/helpscout/realProvider.js';
import { FakeHelpScoutProvider } from '../integrations/helpscout/fakeProvider.js';
import { SyncCoordinator } from '../sync/coordinator.js';
import { ConversationOperations } from './operations.js';
import { SearchEngine } from '../search/searchEngine.js';
import { AiPipeline } from '../ai/pipeline.js';
import type { AiProvider } from '../ai/provider.js';
import { LmStudioProvider, DisabledAiProvider } from '../ai/lmStudioProvider.js';
import { EvidenceBuilder } from '../ai/evidence.js';
import { AiToolRegistry } from '../ai/tools.js';
import { QdrantAdapter } from '../integrations/qdrant/qdrantAdapter.js';
import { LmStudioClient } from '../integrations/lmstudio/lmStudioClient.js';
import { AnalyticsService } from '../analytics/analyticsService.js';
import { SlaService } from '../analytics/slaService.js';
import { AutomationEngine } from '../automation/engine.js';
import { KnowledgeIngestor } from '../knowledge/ingestor.js';
import { BackupService } from './backupService.js';
import { SettingsRepository } from '../database/repositories/settingsRepo.js';
import { JobRepository } from '../database/repositories/jobRepo.js';
import { SyncRepository } from '../database/repositories/syncRepo.js';
import { AiRepository } from '../database/repositories/aiRepo.js';
import { IssueRepository } from '../database/repositories/issueRepo.js';
import { KnowledgeRepository } from '../database/repositories/knowledgeRepo.js';
import { ConversationRepository } from '../database/repositories/conversationRepo.js';
import { DocsRepository } from '../database/repositories/docsRepo.js';
import { ReferenceRepository } from '../database/repositories/referenceRepo.js';
import { PeopleRepository } from '../database/repositories/peopleRepo.js';
import { AnalyticsRepository } from '../database/repositories/analyticsRepo.js';
import { OutreachRepository } from '../database/repositories/outreachRepo.js';
import { SegmentEngine } from '../segmentation/segmentEngine.js';
import { CampaignService } from '../outreach/campaignService.js';
import { EncryptedSyncService } from './encryptedSyncService.js';
import { WorkerManager } from './workers.js';
import { ActivityRepository } from '../database/repositories/activityRepo.js';
import { TicketStateRepository } from '../database/repositories/ticketStateRepo.js';
import { InboxViewRepository } from '../database/repositories/inboxViewRepo.js';
import { NotificationRepository } from '../database/repositories/notificationRepo.js';
import { SideThreadRepository } from '../database/repositories/sideThreadRepo.js';
import { NotificationSweep } from '../notifications/notificationSweep.js';
import { OperationsCenterService } from '../operations/operationsCenter.js';
import { WorkloadService } from '../operations/workloadService.js';
import { SideThreadService } from '../collaboration/sideThreadService.js';
import { AiAttributeService } from '../ai/attributes.js';
import { CopilotService } from '../ai/copilot.js';
import { IncidentRepository } from '../database/repositories/incidentRepo.js';
import { IncidentService } from '../issues/incidentService.js';
import { IssueImpactService } from '../issues/impact.js';
import { CustomObjectRepository } from '../customobjects/customObjectsRepo.js';
import { ConnectorService } from '../connectors/connectorService.js';
import { CustomerEventRepository } from '../database/repositories/customerEventsRepo.js';
import { CustomerEventSweep } from '../timeline/customerEventSweep.js';
import { SupportHealthService } from '../analytics/supportHealth.js';
import { KnowledgeFreshnessService } from '../knowledge/freshness.js';
import { KnowledgeGapService } from '../knowledge/gapEngine.js';
import { FrictionAnalyzer } from '../ai/friction.js';
import { PostResolutionQaService } from '../ai/postResolutionQa.js';
import { TranslationService } from '../ai/translation.js';
import { ResponseEffectivenessService } from '../analytics/effectiveness.js';
import { ReportBuilderService } from '../analytics/reportBuilder.js';
import { SegmentSuggestService } from '../ai/segmentSuggest.js';
import { GraphService } from '../graph/graphService.js';
import { CoachingService } from '../coaching/coachingService.js';
import { CustomerMemoryService } from '../memory/customerMemoryService.js';

/**
 * ApplicationContext: a modular monolith (spec #163) - one process, one SQLite
 * database, background workers, no microservices. All wiring happens here.
 */
export class AppContext {
  config: AppConfig;
  db: DB;
  logger: StructuredLogger;
  provider: HelpScoutProvider;
  realProvider: RealHelpScoutProvider | null = null;
  fakeProvider: FakeHelpScoutProvider | null = null;
  coordinator: SyncCoordinator;
  operations: ConversationOperations;
  search: SearchEngine;
  aiPipeline: AiPipeline;
  aiProvider: AiProvider;
  lmStudio: LmStudioClient;
  qdrant: QdrantAdapter;
  analytics: AnalyticsService;
  sla: SlaService;
  automation: AutomationEngine;
  knowledge: KnowledgeIngestor;
  backup: BackupService;
  workers: WorkerManager;
  settingsRepo: SettingsRepository;
  jobsRepo: JobRepository;
  syncRepo: SyncRepository;
  aiRepo: AiRepository;
  issueRepo: IssueRepository;
  knowledgeRepo: KnowledgeRepository;
  conversationRepo: ConversationRepository;
  docsRepo: DocsRepository;
  referenceRepo: ReferenceRepository;
  peopleRepo: PeopleRepository;
  analyticsRepo: AnalyticsRepository;
  outreachRepo: OutreachRepository;
  segmentEngine: SegmentEngine;
  campaigns: CampaignService;
  encryptedSync: EncryptedSyncService;
  evidenceBuilder: EvidenceBuilder;
  toolRegistry: AiToolRegistry;
  // v1.7.0 activity engine
  activityRepo: ActivityRepository;
  ticketStateRepo: TicketStateRepository;
  inboxViewRepo: InboxViewRepository;
  // v1.8.0 collaboration (M2)
  notificationRepo: NotificationRepository;
  sideThreadRepo: SideThreadRepository;
  notificationSweep: NotificationSweep;
  operationsCenter: OperationsCenterService;
  workload: WorkloadService;
  sideThreads: SideThreadService;
  // v1.9.0 (M3): AI attribute layer + Local Copilot
  attributes: AiAttributeService;
  copilot: CopilotService;
  // v2.0.0 (M4): incident workspace, issue impact, custom objects,
  // connectors, customer timeline, support health, knowledge freshness
  incidents: IncidentRepository;
  incidentService: IncidentService;
  issueImpact: IssueImpactService;
  customObjects: CustomObjectRepository;
  connectors: ConnectorService;
  customerEvents: CustomerEventRepository;
  customerEventSweep: CustomerEventSweep;
  supportHealth: SupportHealthService;
  knowledgeFreshness: KnowledgeFreshnessService;
  // v2.1.0 (M5): knowledge gap engine, post-resolution QA, friction,
  // response effectiveness, translation, report builder, segment suggest
  knowledgeGaps: KnowledgeGapService;
  friction: FrictionAnalyzer;
  qa: PostResolutionQaService;
  translation: TranslationService;
  effectiveness: ResponseEffectivenessService;
  reportBuilder: ReportBuilderService;
  segmentSuggest: SegmentSuggestService;
  // v2.2.0 (M6): support graph, agent coaching, customer memory
  graph: GraphService;
  coaching: CoachingService;
  customerMemory: CustomerMemoryService;

  constructor(opts: { dbPath?: string; demoMode?: boolean } = {}) {
    this.config = config;
    this.logger = createLogger(this.config.logLevel);
    this.db = openDatabase(opts.dbPath);
    const migrationResult = applyMigrations(this.db);
    if (migrationResult.applied > 0) {
      this.logger.info('Migrations applied', { service: 'database', operation: 'migrate', applied: migrationResult.applied });
    }

    const demoMode = opts.demoMode ?? this.config.demoMode;
    if (demoMode) {
      this.fakeProvider = new FakeHelpScoutProvider();
      this.provider = this.fakeProvider;
      this.logger.info('Running in LOCAL DEMO MODE with a simulated Help Scout account', { service: 'helpscout' });
    } else {
      this.realProvider = new RealHelpScoutProvider({
        apiBase: this.config.helpscout.apiBase,
        db: this.db,
        clientId: this.config.helpscout.clientId,
        clientSecret: this.config.helpscout.clientSecret,
        redirectUri: this.config.helpscout.redirectUri,
        concurrency: this.config.sync.apiConcurrency,
        docsApiKey: this.config.helpscout.docsApiKey || null,
        docsApiBase: this.config.helpscout.docsApiBase
      });
      this.provider = this.realProvider;
    }

    // Repositories
    this.settingsRepo = new SettingsRepository(this.db);
    this.jobsRepo = new JobRepository(this.db);
    this.syncRepo = new SyncRepository(this.db);
    this.aiRepo = new AiRepository(this.db);
    this.issueRepo = new IssueRepository(this.db);
    this.knowledgeRepo = new KnowledgeRepository(this.db);
    this.conversationRepo = new ConversationRepository(this.db);
    this.docsRepo = new DocsRepository(this.db);
    this.referenceRepo = new ReferenceRepository(this.db);
    this.peopleRepo = new PeopleRepository(this.db);
    this.analyticsRepo = new AnalyticsRepository(this.db);
    this.outreachRepo = new OutreachRepository(this.db);
    this.segmentEngine = new SegmentEngine(this.db);
    this.activityRepo = new ActivityRepository(this.db);
    this.ticketStateRepo = new TicketStateRepository(this.db);
    this.inboxViewRepo = new InboxViewRepository(this.db);
    this.campaigns = new CampaignService(this.db, this.provider, this.outreachRepo, this.peopleRepo, this.jobsRepo);
    this.encryptedSync = new EncryptedSyncService(this.db, getDatabasePath(), this.config.backupsPath);

    // Services
    this.coordinator = new SyncCoordinator(this.db, this.provider);
    this.operations = new ConversationOperations(this.db, this.provider);
    // v1.6.0: single-conversation refreshes reuse the shared coordinator.
    this.operations.bindCoordinator(this.coordinator);
    this.search = new SearchEngine(this.db);
    this.lmStudio = new LmStudioClient(this.settingsRepo);
    const aiEnabled = this.settingsRepo.get('ai_enabled', true);
    this.aiProvider = aiEnabled ? new LmStudioProvider(this.settingsRepo) : new DisabledAiProvider();
    this.aiPipeline = new AiPipeline(this.db, this.aiProvider);
    this.evidenceBuilder = new EvidenceBuilder(this.db);
    this.toolRegistry = new AiToolRegistry(this.db);
    this.qdrant = new QdrantAdapter({ url: this.settingsRepo.getQdrant().url, enabled: this.settingsRepo.getQdrant().enabled });
    this.analytics = new AnalyticsService(this.db);
    this.sla = new SlaService(this.db);
    // v1.8.0 (M2): notification center, operations center, workload/capacity,
    // mentions + side threads. Constructed after SlaService - all three
    // services reuse the exact SLA business-minutes logic.
    this.notificationRepo = new NotificationRepository(this.db);
    this.sideThreadRepo = new SideThreadRepository(this.db);
    this.notificationSweep = new NotificationSweep(this.db, this.notificationRepo, this.sla, this.settingsRepo);
    this.operationsCenter = new OperationsCenterService(this.db, this.sla, this.settingsRepo);
    this.workload = new WorkloadService(this.db, this.sla, this.settingsRepo);
    this.sideThreads = new SideThreadService(this.db, this.notificationSweep);
    // v1.9.0 (M3): the attribute layer + Copilot reuse the same provider /
    // tool registry plumbing as the analysis pipeline. The Copilot's chat
    // dependency defaults to the shared LM Studio client (tests inject a
    // deterministic fake).
    this.attributes = new AiAttributeService(this.db, this.aiProvider);
    this.copilot = new CopilotService(this.db, this.toolRegistry, (opts) => this.lmStudio.chat(opts));
    // v2.0.0 (M4): the intelligence workspace layer. IncidentService needs
    // the notification sweep (single-funnel notify); freshness needs the
    // settings repo (stale threshold); everything else is pure SQL over the
    // migrated schema. The connector service owns the SSRF-guarded refresh
    // pipeline and the explicit AI-visibility gate.
    this.incidents = new IncidentRepository(this.db);
    this.issueImpact = new IssueImpactService(this.db);
    this.customObjects = new CustomObjectRepository(this.db);
    this.connectors = new ConnectorService(this.db);
    this.customerEvents = new CustomerEventRepository(this.db);
    this.customerEventSweep = new CustomerEventSweep(this.db, this.customerEvents);
    this.supportHealth = new SupportHealthService(this.db);
    this.knowledgeFreshness = new KnowledgeFreshnessService(this.db, this.settingsRepo);
    this.incidentService = new IncidentService(this.db, this.notificationSweep);
    // v2.1.0 (M5): quality, translation and reporting services.
    this.knowledgeGaps = new KnowledgeGapService(this.db);
    this.friction = new FrictionAnalyzer(this.db);
    this.qa = new PostResolutionQaService(this.db, (opts) => this.lmStudio.chat(opts), this.friction);
    this.translation = new TranslationService(this.db, (opts) => this.lmStudio.chat(opts));
    this.effectiveness = new ResponseEffectivenessService(this.db);
    this.reportBuilder = new ReportBuilderService(this.db);
    this.segmentSuggest = new SegmentSuggestService(this.db, (opts) => this.lmStudio.chat(opts));
    // v2.2.0 (M6): the graph is a read-time relationship layer (only human
    // edges persist); coaching is advisory-only with an injectable local
    // chat fn; customer memory composes at read time from existing tables.
    this.graph = new GraphService(this.db);
    this.coaching = new CoachingService(this.db, (opts) => this.lmStudio.chat(opts));
    this.customerMemory = new CustomerMemoryService(this.db);
    this.graph.refreshProducts();
    this.automation = new AutomationEngine(this.db);
    this.knowledge = new KnowledgeIngestor(this.db);
    this.backup = new BackupService(this.db, getDatabasePath(), this.settingsRepo, this.config.backupsPath);
    this.workers = new WorkerManager(this);
  }

  dbStats(): { path: string; size_bytes: number; migrations: number; tables: { table: string; rows: number }[] } {
    const fs = fsModule;
    let size = 0;
    try {
      size = fs.statSync(getDatabasePath()).size;
    } catch {
      size = 0;
    }
    return { path: getDatabasePath(), size_bytes: size, migrations: migrationsApplied(this.db), tables: tableStats(this.db) };
  }

  /** Switch AI on/off at runtime (Settings screen). */
  setAiEnabled(enabled: boolean): void {
    this.settingsRepo.set('ai_enabled', enabled);
    this.aiProvider = enabled ? new LmStudioProvider(this.settingsRepo) : new DisabledAiProvider();
    this.aiPipeline = new AiPipeline(this.db, this.aiProvider);
    this.attributes = new AiAttributeService(this.db, this.aiProvider);
    this.workers.rebindPipeline(this.aiPipeline);
  }

  switchToDemoMode(): void {
    this.fakeProvider = new FakeHelpScoutProvider();
    this.provider = this.fakeProvider;
    this.rebindProvider();
  }

  switchToRealMode(): void {
    this.realProvider = new RealHelpScoutProvider({
      apiBase: this.config.helpscout.apiBase,
      db: this.db,
      clientId: this.config.helpscout.clientId,
      clientSecret: this.config.helpscout.clientSecret,
      redirectUri: this.config.helpscout.redirectUri,
      concurrency: this.config.sync.apiConcurrency,
      docsApiKey: this.config.helpscout.docsApiKey || null,
      docsApiBase: this.config.helpscout.docsApiBase
    });
    this.provider = this.realProvider;
    this.rebindProvider();
  }

  private rebindProvider(): void {
    this.coordinator = new SyncCoordinator(this.db, this.provider);
    this.operations = new ConversationOperations(this.db, this.provider);
    this.operations.bindCoordinator(this.coordinator);
    this.campaigns = new CampaignService(this.db, this.provider, this.outreachRepo, this.peopleRepo, this.jobsRepo);
    this.workers.rebindCoordinator(this.coordinator);
  }
}

let context: AppContext | null = null;

export function getContext(opts: { dbPath?: string; demoMode?: boolean; fresh?: boolean } = {}): AppContext {
  if (!context || opts.fresh) {
    context = new AppContext(opts);
  }
  return context;
}

export function resetContext(): void {
  context = null;
}
