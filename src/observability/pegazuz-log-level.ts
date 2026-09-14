/**
 * Niveles Pegazuz y flags de Railway.
 *
 * Producción:
 *   LOG_LEVEL=info
 *   PEG_TRACE_MODE=compact
 *   LLM_CACHE_DEBUG  (omitir o false)
 *
 * Diagnóstico temporal:
 *   LOG_LEVEL=trace
 *   o PEG_TRACE_MODE=trace
 *
 * Compatibilidad (compact manda la salida normal):
 *   PEG_CANONICAL_TRACE, PEG_MARKET_TRACE, PEG_MARKET_TRACE_VERBOSE
 *   solo emiten JSON legado si el modo no es compact.
 */
export const PEG_LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export type PegLogLevel = (typeof PEG_LOG_LEVELS)[number];

export const PEG_TRACE_MODES = ['compact', 'debug', 'trace'] as const;
export type PegTraceMode = (typeof PEG_TRACE_MODES)[number];

const LEVEL_RANK: Record<PegLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

function flagOn(raw: string | undefined): boolean {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

export function parseLogLevel(raw?: string): PegLogLevel {
  const v = String(raw ?? process.env.LOG_LEVEL ?? 'info')
    .trim()
    .toLowerCase();
  if (v === 'verbose') return 'debug';
  if ((PEG_LOG_LEVELS as readonly string[]).includes(v)) {
    return v as PegLogLevel;
  }
  return 'info';
}

export function parsePegTraceMode(raw?: string): PegTraceMode {
  const v = String(raw ?? process.env.PEG_TRACE_MODE ?? 'compact')
    .trim()
    .toLowerCase();
  if ((PEG_TRACE_MODES as readonly string[]).includes(v)) {
    return v as PegTraceMode;
  }
  return 'compact';
}

export function getLogLevel(): PegLogLevel {
  return parseLogLevel();
}

export function getPegTraceMode(): PegTraceMode {
  return parsePegTraceMode();
}

/** Techo efectivo: TRACE_MODE puede subir el nivel, nunca silenciar ERROR. */
export function getEffectiveLogLevel(): PegLogLevel {
  const level = getLogLevel();
  const mode = getPegTraceMode();
  if (mode === 'trace' || level === 'trace') return 'trace';
  if (mode === 'debug' || level === 'debug') return 'debug';
  return level;
}

export function shouldLog(level: PegLogLevel): boolean {
  if (level === 'error') return true;
  return LEVEL_RANK[level] <= LEVEL_RANK[getEffectiveLogLevel()];
}

export function isTraceDetailEnabled(): boolean {
  return getEffectiveLogLevel() === 'trace';
}

export function isDebugDetailEnabled(): boolean {
  return LEVEL_RANK[getEffectiveLogLevel()] >= LEVEL_RANK.debug;
}

/**
 * JSON legado `[PEG_*_TRACE]`. Compact manda: no se emite aunque
 * PEG_CANONICAL_TRACE / PEG_MARKET_TRACE estén encendidos.
 */
export function shouldEmitLegacyTraceJson(): boolean {
  const mode = getPegTraceMode();
  return mode === 'debug' || mode === 'trace';
}

export function isLlmCacheDebugEnabled(): boolean {
  return flagOn(process.env.LLM_CACHE_DEBUG);
}

export function resetPegazuzLogEnvForTests(): void {
  delete process.env.LOG_LEVEL;
  delete process.env.PEG_TRACE_MODE;
  delete process.env.LLM_CACHE_DEBUG;
}
