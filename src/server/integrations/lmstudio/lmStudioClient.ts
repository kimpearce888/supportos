import type { SettingsRepository } from '../../database/repositories/settingsRepo.js';

export interface LmStudioModels {
  data: { id: string; object?: string; owned_by?: string }[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResult {
  content: string | null;
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  toolCalls?: { id: string; name: string; arguments: string }[];
  latencyMs: number;
}

export interface EmbeddingResult {
  vector: number[];
  model: string;
  latencyMs: number;
}

export class LmStudioError extends Error {
  constructor(message: string, public offline: boolean) {
    super(message);
    this.name = 'LmStudioError';
  }
}

/**
 * LM Studio integration (OpenAI-compatible local API).
 * Endpoints: GET /v1/models, POST /v1/chat/completions, POST /v1/embeddings.
 * No cloud AI anywhere - the base URL is expected to point at localhost.
 */
export class LmStudioClient {
  private baseUrl: string;
  private timeoutMs: number;
  private lastInference: { at: string; latencyMs: number } | null = null;

  constructor(private settings: SettingsRepository, baseUrl?: string) {
    const s = settings.getLmStudio();
    this.baseUrl = (baseUrl ?? s.base_url).replace(/\/$/, '').replace(/\/v1$/, '');
    this.timeoutMs = s.timeout_ms;
  }

  refreshFromSettings(): void {
    const s = this.settings.getLmStudio();
    this.baseUrl = s.base_url.replace(/\/$/, '').replace(/\/v1$/, '');
    this.timeoutMs = s.timeout_ms;
  }

  /** Connection test + model discovery. */
  async listModels(): Promise<LmStudioModels> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as LmStudioModels;
    } catch {
      throw new LmStudioError(
        `LM Studio is not reachable at ${this.baseUrl}. Start LM Studio, load a model, and enable the local server (Developer tab > Start Server).`,
        true
      );
    }
  }

  async chat(opts: {
    messages: ChatMessage[];
    model?: string | null;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    tools?: ChatTool[];
    timeoutMs?: number;
  }): Promise<ChatResult> {
    const settings = this.settings.getLmStudio();
    const model = opts.model ?? settings.chat_model ?? undefined;
    const started = Date.now();
    const body: Record<string, unknown> = {
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 2048,
      stream: false
    };
    if (model) body.model = model;
    if (opts.jsonMode) body.response_format = { type: 'json_object' };
    if (opts.tools?.length) body.tools = opts.tools;
    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LmStudioError(`LM Studio chat request failed (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status >= 500);
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const latencyMs = Date.now() - started;
      this.lastInference = { at: new Date().toISOString(), latencyMs };
      const choice = json.choices?.[0]?.message;
      return {
        content: choice?.content ?? null,
        model: json.model ?? model ?? 'unknown',
        usage: json.usage,
        toolCalls: choice?.tool_calls?.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments })),
        latencyMs
      };
    } catch (e) {
      if (e instanceof LmStudioError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new LmStudioError(`LM Studio request failed: ${msg}. Verify LM Studio is running with a model loaded.`, msg.includes('timeout') || msg.includes('fetch failed'));
    }
  }

  async embed(texts: string[], model?: string | null): Promise<EmbeddingResult[]> {
    const settings = this.settings.getLmStudio();
    const started = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: texts, model: model ?? settings.embedding_model ?? 'text-embedding' }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LmStudioError(`LM Studio embedding request failed (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status >= 500);
      }
      const json = (await res.json()) as { data: { embedding: number[] }[]; model?: string };
      const latencyMs = Date.now() - started;
      this.lastInference = { at: new Date().toISOString(), latencyMs };
      return json.data.map((d) => ({ vector: d.embedding, model: json.model ?? settings.embedding_model ?? 'text-embedding', latencyMs }));
    } catch (e) {
      if (e instanceof LmStudioError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new LmStudioError(`LM Studio embedding failed: ${msg}. Load an embedding model in LM Studio (e.g. nomic-embed) and retry.`, true);
    }
  }

  getLastInference(): { at: string; latencyMs: number } | null {
    return this.lastInference;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }
}
