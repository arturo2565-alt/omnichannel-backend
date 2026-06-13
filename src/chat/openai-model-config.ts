import type { ChatCompletionCreateParams } from 'openai/resources/chat/completions';
import type { ReasoningEffort } from 'openai/resources/shared';

/**
 * Capas de modelo OpenAI (override vía env).
 *
 * OPENAI_MODEL_VISION      — peritaje por fotos (default gpt-5.5)
 * OPENAI_MODEL_CHAT        — autopilot + tools (default gpt-5.5)
 * OPENAI_MODEL_NARRATIVE   — redacción cotización / baño (default gpt-5.5)
 * OPENAI_MODEL_FAST        — clasificación / probes (default gpt-5.4-mini)
 *
 * OPENAI_REASONING_EFFORT_* — none | low | medium | high | xhigh (por tier; visión default xhigh)
 * OPENAI_REASONING_EFFORT   — fallback global
 */
export type OpenAiModelTier = 'vision' | 'chat' | 'narrative' | 'fast';

const MODEL_ENV: Record<OpenAiModelTier, string> = {
  vision: 'OPENAI_MODEL_VISION',
  chat: 'OPENAI_MODEL_CHAT',
  narrative: 'OPENAI_MODEL_NARRATIVE',
  fast: 'OPENAI_MODEL_FAST',
};

const REASONING_EFFORT_ENV: Record<OpenAiModelTier, string> = {
  vision: 'OPENAI_REASONING_EFFORT_VISION',
  chat: 'OPENAI_REASONING_EFFORT_CHAT',
  narrative: 'OPENAI_REASONING_EFFORT_NARRATIVE',
  fast: 'OPENAI_REASONING_EFFORT_FAST',
};

export const OPENAI_MODEL_DEFAULTS: Record<OpenAiModelTier, string> = {
  vision: 'gpt-5.5',
  chat: 'gpt-5.5',
  narrative: 'gpt-5.5',
  fast: 'gpt-5.4-mini',
};

const REASONING_EFFORT_VALUES = new Set<string>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export const OPENAI_REASONING_EFFORT_DEFAULTS: Record<
  OpenAiModelTier,
  ReasoningEffort
> = {
  vision: 'xhigh',
  chat: 'low',
  narrative: 'low',
  fast: 'none',
};

export function resolveOpenAiModel(tier: OpenAiModelTier): string {
  const fromEnv = String(process.env[MODEL_ENV[tier]] ?? '').trim();
  return fromEnv || OPENAI_MODEL_DEFAULTS[tier];
}

export function resolveOpenAiReasoningEffort(
  tier: OpenAiModelTier,
): ReasoningEffort | undefined {
  const tierRaw = String(process.env[REASONING_EFFORT_ENV[tier]] ?? '').trim();
  const globalRaw = String(process.env.OPENAI_REASONING_EFFORT ?? '').trim();
  const raw = tierRaw || globalRaw;
  if (raw && REASONING_EFFORT_VALUES.has(raw)) {
    return raw as ReasoningEffort;
  }
  return OPENAI_REASONING_EFFORT_DEFAULTS[tier];
}

export function isReasoningCapableModel(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes('gpt-5')) return true;
  if (/^o[134]/.test(m)) return true;
  return false;
}

function allowsSamplingParams(
  model: string,
  effort: ReasoningEffort | undefined,
): boolean {
  if (!isReasoningCapableModel(model)) return true;
  return effort === 'none' || effort === 'minimal';
}

export type OpenAiChatCompletionBaseParams = Pick<
  ChatCompletionCreateParams,
  'model' | 'max_completion_tokens' | 'reasoning_effort' | 'temperature'
>;

/** Parámetros base reutilizables en chat.completions.create. */
export function openAiChatCompletionParams(input: {
  tier: OpenAiModelTier;
  maxOutputTokens?: number;
  temperature?: number;
}): OpenAiChatCompletionBaseParams {
  const model = resolveOpenAiModel(input.tier);
  const effort = resolveOpenAiReasoningEffort(input.tier);

  const params: OpenAiChatCompletionBaseParams = { model };

  if (input.maxOutputTokens != null) {
    params.max_completion_tokens = input.maxOutputTokens;
  }

  if (effort != null && isReasoningCapableModel(model)) {
    params.reasoning_effort = effort;
  }

  if (
    input.temperature != null &&
    allowsSamplingParams(model, effort)
  ) {
    params.temperature = input.temperature;
  }

  return params;
}
