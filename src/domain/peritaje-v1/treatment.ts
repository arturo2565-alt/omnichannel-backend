import {
  TREATMENT_DECISIONS,
  type TreatmentDecision,
  type TreatmentSource,
} from './types';

const TREATMENT_RANK: Record<TreatmentDecision, number> = {
  PENDIENTE: 1,
  REPARAR: 2,
  INCIERTO: 3,
  SUSTITUIR: 4,
};

export function isStructuredTreatment(
  raw: unknown,
): raw is TreatmentDecision {
  return (
    typeof raw === 'string' &&
    (TREATMENT_DECISIONS as readonly string[]).includes(raw)
  );
}

export function parseStructuredTreatment(
  raw: unknown,
): TreatmentDecision | undefined {
  const t = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
  if (t === 'REPARAR' || t === 'REPAIR') return 'REPARAR';
  if (t === 'SUSTITUIR' || t === 'REEMPLAZAR' || t === 'REPLACE') {
    return 'SUSTITUIR';
  }
  if (t === 'INCIERTO' || t === 'UNCERTAIN') return 'INCIERTO';
  if (t === 'PENDIENTE' || t === 'PENDING') return 'PENDIENTE';
  return undefined;
}

export type TreatmentResolution = {
  treatment: TreatmentDecision;
  source: TreatmentSource;
  reason: string;
  locked: boolean;
};

/**
 * Una vez que existe un tratamiento estructurado válido, ninguna capa
 * posterior puede reconstruirlo desde texto/severidad.
 *
 * Permitido:
 * - preserve: conservar
 * - validate: conservar si incoming coincide; si no, INCIERTO explícito
 * - combine_stronger: regla explícita de rango (PENDIENTE < REPARAR < INCIERTO < SUSTITUIR)
 * - degrade_incierto: degradación explícita
 * - explicit_replace: reemplazo consciente (usuario/operador/visión nueva)
 */
export type TreatmentLockMode =
  | 'preserve'
  | 'validate'
  | 'combine_stronger'
  | 'degrade_incierto'
  | 'explicit_replace';

export function resolveLockedTreatment(input: {
  existing?: TreatmentDecision;
  incoming?: TreatmentDecision;
  mode: TreatmentLockMode;
  incomingSource?: TreatmentSource;
}): TreatmentResolution {
  const existingLocked = isStructuredTreatment(input.existing);
  const incomingValid = isStructuredTreatment(input.incoming);

  if (input.mode === 'degrade_incierto' && existingLocked) {
    return {
      treatment: 'INCIERTO',
      source: 'degraded',
      reason: `degraded_from_${input.existing}`,
      locked: true,
    };
  }

  if (!existingLocked && incomingValid) {
    return {
      treatment: input.incoming!,
      source: input.incomingSource ?? 'legacy',
      reason: 'adopt_incoming_no_prior_lock',
      locked: true,
    };
  }

  if (!existingLocked && !incomingValid) {
    return {
      treatment: 'PENDIENTE',
      source: 'legacy',
      reason: 'missing_structured_treatment',
      locked: false,
    };
  }

  const existing = input.existing!;

  if (input.mode === 'preserve') {
    return {
      treatment: existing,
      source: input.incomingSource ?? 'merge_rule',
      reason: 'preserved_locked_treatment',
      locked: true,
    };
  }

  if (input.mode === 'validate') {
    if (!incomingValid || input.incoming === existing) {
      return {
        treatment: existing,
        source: input.incomingSource ?? 'merge_rule',
        reason: 'validated_unchanged',
        locked: true,
      };
    }
    return {
      treatment: 'INCIERTO',
      source: 'degraded',
      reason: `validation_conflict_${existing}_vs_${input.incoming}`,
      locked: true,
    };
  }

  if (input.mode === 'combine_stronger') {
    if (!incomingValid) {
      return {
        treatment: existing,
        source: 'merge_rule',
        reason: 'combine_kept_existing_no_incoming',
        locked: true,
      };
    }
    const winner =
      TREATMENT_RANK[input.incoming!] >= TREATMENT_RANK[existing]
        ? input.incoming!
        : existing;
    return {
      treatment: winner,
      source: 'merge_rule',
      reason: `combine_stronger_${existing}_with_${input.incoming}`,
      locked: true,
    };
  }

  if (input.mode === 'explicit_replace' && incomingValid) {
    return {
      treatment: input.incoming!,
      source: input.incomingSource ?? 'operator',
      reason: `explicit_replace_${existing}_to_${input.incoming}`,
      locked: true,
    };
  }

  return {
    treatment: existing,
    source: 'merge_rule',
    reason: 'preserved_locked_treatment',
    locked: true,
  };
}

/**
 * Prohibido: si el tratamiento ya está locked, ignorar cualquier inferencia
 * desde descripcionTecnica / severidad / texto.
 */
export function rejectTextInferenceWhenLocked(input: {
  existing?: TreatmentDecision;
  inferredFromText?: TreatmentDecision;
}): TreatmentDecision | undefined {
  if (isStructuredTreatment(input.existing)) {
    return input.existing;
  }
  return undefined;
}

export function treatmentImpliesReplacement(
  treatment: TreatmentDecision,
): boolean {
  return treatment === 'SUSTITUIR';
}

/**
 * Contradicción entre dos tratamientos ya estructurados.
 * Mismo treatment → conservar.
 * REPARAR vs SUSTITUIR (u otra contradicción estructurada sin precedencia
 * explícita) → INCIERTO. No consulta texto. Unlocked no entra aquí.
 */
export function mergeLockedTreatments(
  existing?: TreatmentDecision,
  incoming?: TreatmentDecision,
): TreatmentResolution {
  const a = isStructuredTreatment(existing);
  const b = isStructuredTreatment(incoming);
  if (a && b && existing !== incoming) {
    return {
      treatment: 'INCIERTO',
      source: 'degraded',
      reason: 'conflicting_structured_treatments',
      locked: true,
    };
  }
  if (a) {
    return resolveLockedTreatment({
      existing,
      incoming,
      mode: 'preserve',
      incomingSource: 'merge_rule',
    });
  }
  if (b) {
    return resolveLockedTreatment({
      incoming,
      mode: 'preserve',
      incomingSource: 'vision',
    });
  }
  return resolveLockedTreatment({
    existing,
    incoming,
    mode: 'preserve',
  });
}
