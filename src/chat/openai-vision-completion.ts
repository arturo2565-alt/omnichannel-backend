import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ReasoningEffort } from 'openai/resources/shared';
import {
  openAiChatCompletionParams,
  resolveOpenAiReasoningEffort,
} from './openai-model-config';
import {
  extractChatCompletionUsage,
  logStablePromptPrefixAudit,
  reportLlmUsage,
} from './llm-audit-context';

/** Presupuesto de salida para visión (reasoning + JSON). Override: OPENAI_VISION_MAX_OUTPUT_TOKENS */
export function resolveOpenAiVisionMaxOutputTokens(): number {
  const raw = Number(process.env.OPENAI_VISION_MAX_OUTPUT_TOKENS ?? '');
  if (Number.isFinite(raw) && raw >= 2000) {
    return Math.floor(raw);
  }
  return 12_000;
}

export type VisionCompletionAttemptMeta = {
  content: string;
  finishReason: string | null;
  reasoningEffort: ReasoningEffort | undefined;
  attempt: number;
  maxOutputTokens: number;
  completionTokens: number | null;
  reasoningTokens: number | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  model: string;
};

function readCompletionContent(
  completion: OpenAI.Chat.Completions.ChatCompletion,
): string {
  const choice = completion.choices[0];
  const msg = choice?.message;
  const direct = String(msg?.content ?? '').trim();
  if (direct) return direct;

  const refusal = String(
    (msg as { refusal?: string | null } | undefined)?.refusal ?? '',
  ).trim();
  if (refusal) return refusal;

  return '';
}

function usageSnapshot(completion: OpenAI.Chat.Completions.ChatCompletion): {
  completionTokens: number | null;
  reasoningTokens: number | null;
  promptTokens: number | null;
  cachedTokens: number | null;
} {
  const details = completion.usage?.completion_tokens_details as
    | { reasoning_tokens?: number }
    | undefined;
  const extracted = extractChatCompletionUsage(completion.usage);
  return {
    completionTokens:
      completion.usage?.completion_tokens != null
        ? Number(completion.usage.completion_tokens)
        : null,
    reasoningTokens:
      details?.reasoning_tokens != null
        ? Number(details.reasoning_tokens)
        : null,
    promptTokens: extracted.promptTokens || null,
    cachedTokens: extracted.cachedTokens || null,
  };
}

function visionRetryEfforts(primary: ReasoningEffort | undefined): ReasoningEffort[] {
  const ordered: ReasoningEffort[] = [];
  const push = (e: ReasoningEffort) => {
    if (!ordered.includes(e)) ordered.push(e);
  };
  if (primary) push(primary);
  push('medium');
  push('low');
  return ordered;
}

/**
 * Visión multimodal con reintentos si `content` vacío (tokens agotados en reasoning).
 */
export async function createVisionDamageAnalysisCompletion(
  openai: OpenAI,
  messages: readonly ChatCompletionMessageParam[],
): Promise<VisionCompletionAttemptMeta> {
  const maxOutputTokens = resolveOpenAiVisionMaxOutputTokens();
  const primaryEffort = resolveOpenAiReasoningEffort('vision');
  const efforts = visionRetryEfforts(primaryEffort);

  let lastMeta: VisionCompletionAttemptMeta = {
    content: '',
    finishReason: null,
    reasoningEffort: primaryEffort,
    attempt: 0,
    maxOutputTokens,
    completionTokens: null,
    reasoningTokens: null,
    promptTokens: null,
    cachedTokens: null,
    model: '',
  };

  for (let i = 0; i < efforts.length; i++) {
    const effort = efforts[i]!;
    const base = openAiChatCompletionParams({
      tier: 'vision',
      maxOutputTokens,
      reasoningEffortOverride: effort,
    });

    if (i === 0) {
      const sys = messages.find((m) => m.role === 'system');
      const sysText =
        sys && typeof sys.content === 'string' ? sys.content : '';
      if (sysText) {
        logStablePromptPrefixAudit('chat:vision_peritaje', sysText);
      }
    }

    const t0 = Date.now();
    const completion = await openai.chat.completions.create({
      ...base,
      response_format: { type: 'json_object' },
      messages: [...messages],
    });
    const durationMs = Date.now() - t0;

    const content = readCompletionContent(completion);
    const usage = usageSnapshot(completion);
    const finishReason = completion.choices[0]?.finish_reason ?? null;
    const model = String(completion.model || base.model || '').trim();

    lastMeta = {
      content,
      finishReason,
      reasoningEffort: effort,
      attempt: i + 1,
      maxOutputTokens,
      completionTokens: usage.completionTokens,
      reasoningTokens: usage.reasoningTokens,
      promptTokens: usage.promptTokens,
      cachedTokens: usage.cachedTokens,
      model,
    };

    const extracted = extractChatCompletionUsage(completion.usage);
    reportLlmUsage({
      provider: 'openai',
      model,
      purpose: 'vision_peritaje',
      promptTokens: extracted.promptTokens,
      completionTokens: extracted.completionTokens,
      totalTokens: extracted.totalTokens,
      cachedTokens: extracted.cachedTokens,
      cacheWriteTokens: extracted.cacheWriteTokens,
      durationMs,
    });

    console.log(
      '[Vision] Intento OpenAI',
      JSON.stringify({
        attempt: i + 1,
        model: lastMeta.model,
        reasoningEffort: effort,
        maxOutputTokens,
        finishReason,
        contentChars: content.length,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        promptTokens: usage.promptTokens,
        durationMs,
      }),
    );

    if (content.length > 0) {
      return lastMeta;
    }

    const truncated = finishReason === 'length';
    if (!truncated && i === efforts.length - 1) {
      break;
    }
    if (i < efforts.length - 1) {
      console.warn(
        '[Vision] content vacío; reintento con menor reasoning_effort',
        JSON.stringify({ priorEffort: effort, nextEffort: efforts[i + 1] }),
      );
    }
  }

  return lastMeta;
}
