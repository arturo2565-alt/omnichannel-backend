import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';

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
  /** Tokens escritos a caché (si el modelo/API lo reporta). */
  cacheWriteTokens?: number;
  durationMs?: number;
  tallerId?: string | null;
  conversationId?: string | null;
};

type LlmUsageReporter = (input: LlmUsageReportInput) => void;

const llmAuditAls = new AsyncLocalStorage<LlmAuditContext>();
let reporter: LlmUsageReporter | null = null;

/** Activo por defecto; `LLM_CACHE_DEBUG=false` lo apaga. */
export function isLlmCacheDebugEnabled(): boolean {
  const raw = String(process.env.LLM_CACHE_DEBUG ?? 'true').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

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
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
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

/**
 * Lee el primer número finito >= 0; no usa `||` (evitar saltar un `0` legítimo).
 */
export function pickNonNegativeInt(...candidates: unknown[]): number {
  for (const c of candidates) {
    if (c === undefined || c === null || c === '') continue;
    const n = typeof c === 'number' ? c : Number(c);
    if (Number.isFinite(n) && n >= 0) {
      return Math.floor(n);
    }
  }
  return 0;
}

export type ExtractedLlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
};

function logUsageAudit(
  api: 'chat_completions' | 'responses',
  usage: unknown,
  extracted: ExtractedLlmUsage,
): void {
  if (!isLlmCacheDebugEnabled()) return;
  console.log(
    '[LlmCacheDebug] usage raw',
    JSON.stringify(
      {
        api,
        usage: usage ?? null,
        extracted,
        pathsTried:
          api === 'chat_completions'
            ? [
                'usage.prompt_tokens_details.cached_tokens',
                'usage.input_tokens_details.cached_tokens',
                'usage.cached_tokens',
              ]
            : [
                'usage.input_tokens_details.cached_tokens',
                'usage.prompt_tokens_details.cached_tokens',
                'usage.cached_tokens',
              ],
      },
      null,
      2,
    ),
  );
}

/** Fingerprint del prefijo estable para comparar llamadas consecutivas. */
export function logStablePromptPrefixAudit(
  source: string,
  stablePrefix: string,
): void {
  if (!isLlmCacheDebugEnabled()) return;
  const text = String(stablePrefix ?? '');
  const head = text.slice(0, 300);
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const leadingWs = text.match(/^\s*/)?.[0] ?? '';
  console.log(
    '[LlmCacheDebug] stable prefix',
    JSON.stringify(
      {
        source,
        charLength: text.length,
        sha256_16: hash,
        leadingWhitespaceCodes: [...leadingWs].map((ch) => ch.charCodeAt(0)),
        first300: head,
        startsWithDynamicMarker: text.includes('[CONTEXTO_DINAMICO_SERVIDOR]'),
      },
      null,
      2,
    ),
  );
}

export function extractChatCompletionUsage(usage: unknown): ExtractedLlmUsage {
  const u = usage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: {
          cached_tokens?: number;
          cache_write_tokens?: number;
        };
        input_tokens_details?: {
          cached_tokens?: number;
          cache_write_tokens?: number;
        };
        cached_tokens?: number;
      }
    | null
    | undefined;

  const promptTokens = pickNonNegativeInt(u?.prompt_tokens);
  const completionTokens = pickNonNegativeInt(u?.completion_tokens);
  const totalTokens = pickNonNegativeInt(
    u?.total_tokens,
    promptTokens + completionTokens,
  );
  const cachedTokens = pickNonNegativeInt(
    u?.prompt_tokens_details?.cached_tokens,
    u?.input_tokens_details?.cached_tokens,
    u?.cached_tokens,
  );
  const cacheWriteTokens = pickNonNegativeInt(
    u?.prompt_tokens_details?.cache_write_tokens,
    u?.input_tokens_details?.cache_write_tokens,
  );

  const extracted = {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheWriteTokens,
  };
  logUsageAudit('chat_completions', usage, extracted);
  return extracted;
}

export function extractResponsesApiUsage(usage: unknown): ExtractedLlmUsage {
  const u = usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
        input_tokens_details?: {
          cached_tokens?: number;
          cache_write_tokens?: number;
        };
        prompt_tokens_details?: {
          cached_tokens?: number;
          cache_write_tokens?: number;
        };
        cached_tokens?: number;
      }
    | null
    | undefined;

  const promptTokens = pickNonNegativeInt(u?.input_tokens, u?.prompt_tokens);
  const completionTokens = pickNonNegativeInt(
    u?.output_tokens,
    u?.completion_tokens,
  );
  const totalTokens = pickNonNegativeInt(
    u?.total_tokens,
    promptTokens + completionTokens,
  );
  // Responses API (docs): usage.input_tokens_details.cached_tokens
  const cachedTokens = pickNonNegativeInt(
    u?.input_tokens_details?.cached_tokens,
    u?.prompt_tokens_details?.cached_tokens,
    u?.cached_tokens,
  );
  const cacheWriteTokens = pickNonNegativeInt(
    u?.input_tokens_details?.cache_write_tokens,
    u?.prompt_tokens_details?.cache_write_tokens,
  );

  const extracted = {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheWriteTokens,
  };
  logUsageAudit('responses', usage, extracted);
  return extracted;
}

/** Clave estable por taller para routing de Prompt Caching (Responses API). */
export function buildPromptCacheKeyForTaller(
  tallerId?: string | null,
): string | undefined {
  const tid = String(tallerId ?? '').trim();
  if (tid) return `taller:${tid}:autopilot-v1`;
  const ctx = llmAuditAls.getStore();
  const fromCtx = String(ctx?.tallerId ?? '').trim();
  if (fromCtx) return `taller:${fromCtx}:autopilot-v1`;
  return undefined;
}
