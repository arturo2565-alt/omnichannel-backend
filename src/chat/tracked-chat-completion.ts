import type OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';
import {
  extractChatCompletionUsage,
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
    durationMs,
  });
  return completion;
}
