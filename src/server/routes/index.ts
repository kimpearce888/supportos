import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../services/context.js';
import { registerConversationRoutes } from './conversations.js';
import { registerPeopleRoutes } from './people.js';
import { registerSearchRoutes } from './search.js';
import { registerAiRoutes } from './ai.js';
import { registerAnalyticsRoutes } from './analytics.js';
import { registerKnowledgeRoutes } from './knowledge.js';
import { registerIssueRoutes } from './issues.js';
import { registerAutomationRoutes } from './automation.js';
import { registerSyncRoutes } from './sync.js';
import { registerSettingsRoutes } from './settings.js';
import { registerSystemRoutes } from './system.js';
import { registerInteractionRoutes } from './interactions.js';
import { registerDocsRoutes } from './docs.js';
import { registerEventsRoutes } from './events.js';
import { registerOutreachRoutes } from './outreach.js';
import { registerViewRoutes } from './views.js';
import { registerOperationsRoutes } from './operations.js';
import { registerNotificationRoutes } from './notifications.js';
import { registerCollaborationRoutes } from './collaboration.js';
import { registerCopilotRoutes } from './copilot.js';
import { registerAttributeRoutes } from './attributes.js';
import { registerIncidentRoutes } from './incidents.js';
import { registerCustomObjectRoutes } from './customObjects.js';
import { registerConnectorRoutes } from './connectors.js';
import { registerQualityRoutes } from './quality.js';
import { registerTranslationRoutes } from './translation.js';
import { registerGraphRoutes } from './graph.js';
import { registerCoachingRoutes } from './coaching.js';
import { registerMemoryRoutes } from './memory.js';

export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // All handlers receive ctx via route options - no globals needed for tests
  app.decorate('ctx', ctx);
  await registerConversationRoutes(app, ctx);
  await registerPeopleRoutes(app, ctx);
  await registerSearchRoutes(app, ctx);
  await registerAiRoutes(app, ctx);
  await registerAnalyticsRoutes(app, ctx);
  await registerKnowledgeRoutes(app, ctx);
  await registerIssueRoutes(app, ctx);
  await registerAutomationRoutes(app, ctx);
  await registerSyncRoutes(app, ctx);
  await registerSettingsRoutes(app, ctx);
  await registerSystemRoutes(app, ctx);
  await registerInteractionRoutes(app, ctx);
  await registerDocsRoutes(app, ctx);
  await registerEventsRoutes(app, ctx);
  await registerOutreachRoutes(app, ctx);
  await registerViewRoutes(app, ctx);
  await registerOperationsRoutes(app, ctx);
  await registerNotificationRoutes(app, ctx);
  await registerCollaborationRoutes(app, ctx);
  await registerCopilotRoutes(app, ctx);
  await registerAttributeRoutes(app, ctx);
  await registerIncidentRoutes(app, ctx);
  await registerCustomObjectRoutes(app, ctx);
  await registerConnectorRoutes(app, ctx);
  await registerQualityRoutes(app, ctx);
  await registerTranslationRoutes(app, ctx);
  await registerGraphRoutes(app, ctx);
  await registerCoachingRoutes(app, ctx);
  await registerMemoryRoutes(app, ctx);
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
