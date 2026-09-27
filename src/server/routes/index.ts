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
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
