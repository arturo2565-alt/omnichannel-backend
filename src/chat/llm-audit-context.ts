import { AsyncLocalStorage } from 'async_hooks';

export type LlmAuditContext = {
  tallerId?: string | null;
  conversationId?: string | null;
  /** Propósito por defecto si el wrapper no pasa uno. */
  purpose?: string;
  provider?: string;
};

export type LlmUsageReportInput = {
  provider?: string;
  model: string;
  purpose: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  durationMs?: number;
  tallerId?: string | null;
  conversationId?: string | null;
};

type LlmUsageReporter = (input: LlmUsageReportInput) => void;

const llmAuditAls = new AsyncLocalStorage<LlmAuditContext>();
let reporter: LlmUsageReporter | null = null;

export function registerLlmUsageReporter(fn: LlmUsageReporter | null): void {
  reporter = fn;
}

export function getLlmAuditContext(): LlmAuditContext | undefined {
  return llmAuditAls.getStore();
}

/** Ejecuta `fn` con taller/conversation en contexto para el tracking LLM. */
export function runWithLlmAuditContext<T>(
  ctx: LlmAuditContext,
  fn: () => T,
): T {
  const parent = llmAuditAls.getStore();
  return llmAuditAls.run(
    {
      tallerId: ctx.tallerId ?? parent?.tallerId ?? null,
      conversationId: ctx.conversationId ?? parent?.conversationId ?? null,
      purpose: ctx.purpose ?? parent?.purpose,
      provider: ctx.provider ?? parent?.provider ?? 'openai',
    },
    fn,
  );
}

export async function runWithLlmAuditContextAsync<T>(
  ctx: LlmAuditContext,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = llmAuditAls.getStore();
  return llmAuditAls.run(
    {
      tallerId: ctx.tallerId ?? parent?.tallerId ?? null,
      conversationId: ctx.conversationId ?? parent?.conversationId ?? null,
      purpose: ctx.purpose ?? parent?.purpose,
      provider: ctx.provider ?? parent?.provider ?? 'openai',
    },
    fn,
  );
}

/** Fire-and-forget hacia el reporter Nest (si está registrado). */
export function reportLlmUsage(input: LlmUsageReportInput): void {
  if (!reporter) return;
  const ctx = llmAuditAls.getStore();
  try {
    reporter({
      provider: input.provider ?? ctx?.provider ?? 'openai',
      model: input.model,
      purpose: input.purpose || ctx?.purpose || 'unknown',
      promptTokens: input.promptTokens ?? 0,
      completionTokens: input.completionTokens ?? 0,
      totalTokens: input.totalTokens,
      cachedTokens: input.cachedTokens ?? 0,
      durationMs: input.durationMs ?? 0,
      tallerId:
        input.tallerId !== undefined ? input.tallerId : (ctx?.tallerId ?? null),
      conversationId:
        input.conversationId !== undefined
          ? input.conversationId
          : (ctx?.conversationId ?? null),
    });
  } catch (err) {
    console.warn('[reportLlmUsage] falló el reporter:', err);
  }
}

export function extractChatCompletionUsage(usage: unknown): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
} {
  const u = usage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      }
    | null
    | undefined;
  const promptTokens = Math.max(0, Number(u?.prompt_tokens) || 0);
  const completionTokens = Math.max(0, Number(u?.completion_tokens) || 0);
  const totalTokens = Math.max(
    0,
    Number(u?.total_tokens) || promptTokens + completionTokens,
  );
  const cachedTokens = Math.max(
    0,
    Number(u?.prompt_tokens_details?.cached_tokens) || 0,
  );
  return { promptTokens, completionTokens, totalTokens, cachedTokens };
}

export function extractResponsesApiUsage(usage: unknown): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
} {
  const u = usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
      }
    | null
    | undefined;
  const promptTokens = Math.max(0, Number(u?.input_tokens) || 0);
  const completionTokens = Math.max(0, Number(u?.output_tokens) || 0);
  const totalTokens = Math.max(
    0,
    Number(u?.total_tokens) || promptTokens + completionTokens,
  );
  const cachedTokens = Math.max(
    0,
    Number(u?.input_tokens_details?.cached_tokens) || 0,
  );
  return { promptTokens, completionTokens, totalTokens, cachedTokens };
}
