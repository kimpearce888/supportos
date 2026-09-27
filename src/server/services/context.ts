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
import { WorkerManager } from './workers.js';

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
  evidenceBuilder: EvidenceBuilder;
  toolRegistry: AiToolRegistry;

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

    // Services
    this.coordinator = new SyncCoordinator(this.db, this.provider);
    this.operations = new ConversationOperations(this.db, this.provider);
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
