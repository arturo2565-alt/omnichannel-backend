/**
 * Confirmación visual de daño, independiente del tratamiento.
 * No se infiere desde descripcionTecnica.
 */
export const DAMAGE_EVIDENCE_STATUSES = [
  'CONFIRMED_VISIBLE',
  'SUSPECTED_INVOLVEMENT',
  'NOT_ASSESSABLE',
] as const;

export type DamageEvidenceStatus =
  (typeof DAMAGE_EVIDENCE_STATUSES)[number];

const STATUS_SET = new Set<string>(DAMAGE_EVIDENCE_STATUSES);

function normalizeEvidenceToken(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

/** Solo el campo explícito. `undefined` si Vision/legacy no lo emitió. */
export function parseDamageEvidenceStatus(
  raw: unknown,
): DamageEvidenceStatus | undefined {
  const t = normalizeEvidenceToken(raw);
  if (!t) return undefined;
  if (t === 'CONFIRMED' || t === 'CONFIRMED_VISIBLE') {
    return 'CONFIRMED_VISIBLE';
  }
  if (t === 'SUSPECTED' || t === 'SUSPECTED_INVOLVEMENT') {
    return 'SUSPECTED_INVOLVEMENT';
  }
  if (t === 'NOT_ASSESSABLE' || t === 'NOTASSESSABLE') {
    return 'NOT_ASSESSABLE';
  }
  if (STATUS_SET.has(t)) return t as DamageEvidenceStatus;
  return undefined;
}

/**
 * Elegibilidad de cobro. Ausencia del campo = legacy CONFIRMED_VISIBLE.
 * No adivina desde texto.
 */
export function resolveDamageEvidenceStatusForPricing(
  raw?: string | null,
): DamageEvidenceStatus {
  return parseDamageEvidenceStatus(raw) ?? 'CONFIRMED_VISIBLE';
}

export function isConfirmedVisibleDamageEvidence(
  raw?: string | null,
): boolean {
  return resolveDamageEvidenceStatusForPricing(raw) === 'CONFIRMED_VISIBLE';
}

const EVIDENCE_RANK: Record<DamageEvidenceStatus, number> = {
  NOT_ASSESSABLE: 1,
  SUSPECTED_INVOLVEMENT: 2,
  CONFIRMED_VISIBLE: 3,
};

/** Merge: explícito gana sobre ausente; CONFIRMED gana entre explícitos. */
export function mergeDamageEvidenceStatus(
  a?: string | null,
  b?: string | null,
): DamageEvidenceStatus | undefined {
  const pa = parseDamageEvidenceStatus(a);
  const pb = parseDamageEvidenceStatus(b);
  if (!pa) return pb;
  if (!pb) return pa;
  return EVIDENCE_RANK[pa] >= EVIDENCE_RANK[pb] ? pa : pb;
}

export function pricingEligibilityReason(
  status: DamageEvidenceStatus,
): string {
  if (status === 'CONFIRMED_VISIBLE') return 'confirmed_visible';
  if (status === 'SUSPECTED_INVOLVEMENT') return 'suspected_involvement';
  return 'not_assessable';
}

export const DAMAGE_EVIDENCE_VISION_CONTRACT = `
Evidencia de daño (aditivo; independiente del tratamiento):
Cada item DEBE incluir "damageEvidenceStatus":
- CONFIRMED_VISIBLE: hay daño físico visible atribuible directamente a esa pieza.
- SUSPECTED_INVOLVEMENT: la pieza parece desalineada, cercana al impacto, afectada por ensamble/soportes o transferencia del golpe, pero NO hay evidencia visual suficiente de daño físico directo.
- NOT_ASSESSABLE: no se puede valorar adecuadamente con las imágenes actuales.

Reglas:
- No marques CONFIRMED_VISIBLE solo porque la pieza está junto al golpe.
- Desalineación sin daño directo visible → SUSPECTED_INVOLVEMENT.
- Sospecha de soporte/fijación no es daño visible de la pieza.
- possibleHiddenDamage sigue siendo independiente (daños internos no visibles). No lo mezcles con damageEvidenceStatus.
- tratamiento (REPARAR/SUSTITUIR/INCIERTO) no sustituye a damageEvidenceStatus.
`.trim();
