import type { TreatmentDecision } from '../../domain/peritaje-v1';

export type TreatmentSafety =
  | 'EXACT'
  | 'SAFE_DEGRADATION'
  | 'UNSAFE'
  | 'SKIP';

/**
 * EXACT: igual al expected.
 * SAFE: expected REPARAR/SUSTITUIR y el modelo se reserva (INCIERTO/PENDIENTE).
 * UNSAFE: afirma la decisión opuesta o inventa una definitiva incompatible.
 */
export function classifyTreatmentSafety(
  expected?: TreatmentDecision,
  predicted?: TreatmentDecision,
): TreatmentSafety {
  if (!expected || !predicted) return 'SKIP';
  if (expected === predicted) return 'EXACT';
  const reserved = predicted === 'INCIERTO' || predicted === 'PENDIENTE';
  if (
    reserved &&
    (expected === 'REPARAR' || expected === 'SUSTITUIR')
  ) {
    return 'SAFE_DEGRADATION';
  }
  if (
    (expected === 'SUSTITUIR' && predicted === 'REPARAR') ||
    (expected === 'REPARAR' && predicted === 'SUSTITUIR')
  ) {
    return 'UNSAFE';
  }
  if (
    (expected === 'INCIERTO' || expected === 'PENDIENTE') &&
    (predicted === 'REPARAR' || predicted === 'SUSTITUIR')
  ) {
    return 'UNSAFE';
  }
  return 'UNSAFE';
}

export function treatmentSafetyRates(
  rows: readonly { expected?: TreatmentDecision; predicted?: TreatmentDecision }[],
): { exactRate: number; safeTreatmentRate: number; unsafeTreatmentRate: number } {
  const scored = rows
    .map((r) => classifyTreatmentSafety(r.expected, r.predicted))
    .filter((s) => s !== 'SKIP');
  const n = scored.length;
  if (!n) {
    return { exactRate: 100, safeTreatmentRate: 100, unsafeTreatmentRate: 0 };
  }
  const pct = (c: number) => Math.round((c / n) * 1000) / 10;
  return {
    exactRate: pct(scored.filter((s) => s === 'EXACT').length),
    safeTreatmentRate: pct(
      scored.filter((s) => s === 'EXACT' || s === 'SAFE_DEGRADATION').length,
    ),
    unsafeTreatmentRate: pct(scored.filter((s) => s === 'UNSAFE').length),
  };
}
