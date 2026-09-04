/**
 * Capas de prompt orientadas a Prompt Caching de OpenAI:
 * el prefijo (bloques 1–2) debe ser byte-idéntico entre llamadas del mismo taller.
 *
 * Orden obligatorio:
 * 1. Estático (rol, reglas, tools en la API)
 * 2. Tenant (catálogo / datos estables del taller)
 * 3. Dinámico (hora, gates, estado del lead)
 * 4. Historial (user/assistant / tool outputs)
 */

/** Misma zona que appointment-intent (evitar import circular). */
const WORKSHOP_TIMEZONE = 'America/Mexico_City';

export const LLM_PROMPT_DYNAMIC_MARKER = '[CONTEXTO_DINAMICO_SERVIDOR]';

/** Timestamp y “ahora” del taller — NUNCA al inicio del system/instructions. */
export function buildLlmDynamicServerTimeBlock(now = new Date()): string {
  const isoUtc = now.toISOString();
  const humanWorkshop = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: WORKSHOP_TIMEZONE,
    timeZoneName: 'short',
  });
  return [
    LLM_PROMPT_DYNAMIC_MARKER,
    `Current time is ${humanWorkshop} (workshop calendar in ${WORKSHOP_TIMEZONE}).`,
    `Server instant ISO 8601 (UTC): ${isoUtc}.`,
    `Treat these lines as authoritative “now” when resolving relative dates (“this Wednesday”, “tomorrow”, “este miércoles”).`,
  ].join('\n');
}

/**
 * @deprecated Prefer {@link buildLlmDynamicServerTimeBlock} en el bloque dinámico
 * (después del prefijo estático), no al inicio de instructions/system.
 */
export function buildLlmServerTimeSystemPrefix(now = new Date()): string {
  return buildLlmDynamicServerTimeBlock(now);
}

export type LlmPromptLayers = {
  /** Bloques 1+2: invariable + tenant. Va en `instructions` / primer system. */
  stablePrefix: string;
  /** Bloque 3: efímero. Va en mensaje de contexto antes del historial. */
  dynamicContext: string;
};

/** Une capas con separadores claros (útil en APIs que solo aceptan un string). */
export function joinLlmPromptLayers(layers: LlmPromptLayers): string {
  const stable = String(layers.stablePrefix ?? '').trim();
  const dynamic = String(layers.dynamicContext ?? '').trim();
  if (!dynamic) return stable;
  if (!stable) return dynamic;
  return `${stable}\n\n${dynamic}`;
}

/**
 * Mensajes chat.completions con prefijo cacheable:
 * system(stable) → user(dynamic opcional) → historial.
 */
export function buildCacheFriendlyChatMessages(input: {
  stableSystem: string;
  dynamicContext?: string | null;
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  /** Turno actual del usuario (si no está ya en history). */
  currentUserText?: string | null;
}): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> =
    [];
  const stable = String(input.stableSystem ?? '').trim();
  if (stable) {
    out.push({ role: 'system', content: stable });
  }
  const dynamic = String(input.dynamicContext ?? '').trim();
  if (dynamic) {
    out.push({
      role: 'user',
      content: dynamic.startsWith(LLM_PROMPT_DYNAMIC_MARKER)
        ? dynamic
        : `${LLM_PROMPT_DYNAMIC_MARKER}\n${dynamic}`,
    });
  }
  for (const m of input.history ?? []) {
    const content = String(m.content ?? '').trim();
    if (!content) continue;
    out.push({ role: m.role, content });
  }
  const current = String(input.currentUserText ?? '').trim();
  if (current) {
    out.push({ role: 'user', content: current });
  }
  return out;
}
