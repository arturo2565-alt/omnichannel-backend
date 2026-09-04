import type OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';
import {
  extractChatCompletionUsage,
  logStablePromptPrefixAudit,
  reportLlmUsage,
} from './llm-audit-context';

/**
 * Wrapper de `chat.completions.create` que reporta usage/costo sin bloquear.
 */
export async function createTrackedChatCompletion(
  openai: OpenAI,
  params: ChatCompletionCreateParamsNonStreaming,
  options: { purpose: string },
): Promise<ChatCompletion> {
  const systemMsg = params.messages?.find((m) => m.role === 'system');
  const systemText =
    systemMsg && typeof systemMsg.content === 'string'
      ? systemMsg.content
      : Array.isArray(systemMsg?.content)
        ? systemMsg.content
            .map((p) =>
              p && typeof p === 'object' && 'text' in p
                ? String((p as { text?: string }).text ?? '')
                : '',
            )
            .join('')
        : '';
  if (systemText) {
    logStablePromptPrefixAudit(`chat:${options.purpose}`, systemText);
  }

  const t0 = Date.now();
  const completion = await openai.chat.completions.create(params);
  const durationMs = Date.now() - t0;
  const usage = extractChatCompletionUsage(completion.usage);
  const model = String(completion.model || params.model || '').trim();
  reportLlmUsage({
    provider: 'openai',
    model,
    purpose: options.purpose,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cachedTokens: usage.cachedTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    durationMs,
  });
  return completion;
}
