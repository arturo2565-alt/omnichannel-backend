import type { ChatCompletionCreateParams } from 'openai/resources/chat/completions';
import type { ReasoningEffort } from 'openai/resources/shared';
import { isStagingRuntime } from '../config/staging-guard';

/**
 * Capas de modelo OpenAI (override vía env).
 *
 * Producción, si no hay override:
 * OPENAI_MODEL_VISION      — peritaje por fotos (default gpt-5.6-sol)
 * OPENAI_MODEL_CHAT        — autopilot + tools (default gpt-5.5)
 * OPENAI_MODEL_NARRATIVE   — redacción cotización / baño (default gpt-5.5)
 * OPENAI_MODEL_FAST        — clasificación / probes (default gpt-5.4-mini)
 *
 * Staging, si no hay override: visión, orquestador y narrativa usan gpt-6.1-sol;
 * el extractor y las tareas rápidas usan gpt-6-luna.
 *
 * OPENAI_REASONING_EFFORT_* — none | low | medium | high | xhigh (por tier; visión default high)
 * OPENAI_VISION_MAX_OUTPUT_TOKENS — cupo salida visión (default 12000; reasoning + JSON)
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
  vision: 'gpt-5.6-sol',
  chat: 'gpt-5.5',
  narrative: 'gpt-5.5',
  fast: 'gpt-5.4-mini',
};

/** Solo cuando PEGAZUZ_ENV=staging y no hay OPENAI_MODEL_* . */
export const STAGING_OPENAI_MODEL_DEFAULTS: Record<OpenAiModelTier, string> = {
  vision: 'gpt-6.1-sol',
  chat: 'gpt-6.1-sol',
  narrative: 'gpt-6.1-sol',
  fast: 'gpt-6-luna',
};

const REASONING_EFFORT_VALUES = new Set<string>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export const OPENAI_REASONING_EFFORT_DEFAULTS: Record<
  OpenAiModelTier,
  ReasoningEffort
> = {
  vision: 'high',
  chat: 'low',
  narrative: 'low',
  fast: 'none',
};

export function resolveOpenAiModel(
  tier: OpenAiModelTier,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = String(env[MODEL_ENV[tier]] ?? '').trim();
  if (fromEnv) return fromEnv;
  if (isStagingRuntime(env)) return STAGING_OPENAI_MODEL_DEFAULTS[tier];
  return OPENAI_MODEL_DEFAULTS[tier];
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
  if (m.includes('gpt-5') || m.includes('gpt-6')) return true;
  if (/^o[134]/.test(m)) return true;
  return false;
}

function isGpt6(model: string): boolean {
  return model.toLowerCase().includes('gpt-6');
}

/** GPT-6.1 Sol y GPT-6 Astra rechazan `none` y `minimal`. */
function rejectsNoneEffort(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes('gpt-6.1-sol') || m.includes('gpt-6-astra');
}

/**
 * Ajusta el effort al conjunto que el modelo admite.
 * `minimal` en GPT-6 pasa a `low`. En Sol/Astra, `none` también pasa a `low`.
 */
export function coerceReasoningEffort(
  model: string,
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (!isReasoningCapableModel(model) || effort == null) return undefined;
  if (isGpt6(model)) {
    if (effort === 'minimal' || (effort === 'none' && rejectsNoneEffort(model))) {
      return 'low';
    }
    if (
      effort === 'none' ||
      effort === 'low' ||
      effort === 'medium' ||
      effort === 'high' ||
      effort === 'xhigh' ||
      effort === 'max'
    ) {
      return effort;
    }
    return 'low';
  }
  if (REASONING_EFFORT_VALUES.has(effort)) return effort;
  return undefined;
}

function allowsSamplingParams(
  model: string,
  effort: ReasoningEffort | undefined,
): boolean {
  if (!isReasoningCapableModel(model)) return true;
  if (isGpt6(model)) return effort === 'none';
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
  /** Override puntual (p. ej. reintento visión con effort menor). */
  reasoningEffortOverride?: ReasoningEffort;
}): OpenAiChatCompletionBaseParams {
  const model = resolveOpenAiModel(input.tier);
  const effort = coerceReasoningEffort(
    model,
    input.reasoningEffortOverride ?? resolveOpenAiReasoningEffort(input.tier),
  );

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

export type OpenAiResponsesBaseParams = {
  model: string;
  max_output_tokens?: number;
  reasoning?: { effort: ReasoningEffort };
};

/** Parámetros base para `openai.responses.create` (tools + reasoning). */
export function openAiResponsesParams(input: {
  tier: OpenAiModelTier;
  maxOutputTokens?: number;
}): OpenAiResponsesBaseParams {
  const model = resolveOpenAiModel(input.tier);
  const effort = coerceReasoningEffort(model, resolveOpenAiReasoningEffort(input.tier));

  const params: OpenAiResponsesBaseParams = { model };

  if (input.maxOutputTokens != null) {
    params.max_output_tokens = input.maxOutputTokens;
  }

  if (effort != null && isReasoningCapableModel(model)) {
    params.reasoning = { effort };
  }

  return params;
}
