import { physicalMergeKey } from './ids';
import { isStructuredTreatment } from './treatment';
import {
  PERITAJE_SCHEMA_VERSION,
  QUOTE_SCHEMA_VERSION,
  QUOTE_SERVICE_TYPES,
  type CanonicalPeritajeV1,
  type CanonicalQuoteV1,
  type DamageItem,
  type InvariantViolation,
  type QuoteLine,
  type QuoteServiceType,
  type TreatmentDecision,
} from './types';

const SERVICE_TYPE_SET = new Set<string>(QUOTE_SERVICE_TYPES);

function violation(
  code: string,
  message: string,
  path?: string,
): InvariantViolation {
  return { code, message, ...(path ? { path } : {}) };
}

/** Invariante 4: SUSTITUIR puede (y suele) producir más de una QuoteLine. */
export function expectedServiceTypesForTreatment(
  treatment: TreatmentDecision,
): QuoteServiceType[] {
  if (treatment === 'SUSTITUIR') {
    return ['REFACCION', 'MONTAJE_PINTURA'];
  }
  if (treatment === 'PENDIENTE') return ['PENDIENTE'];
  if (treatment === 'REPARAR' || treatment === 'INCIERTO') {
    return ['REPARACION_PINTURA'];
  }
  return ['PENDIENTE'];
}

export function treatmentIsDistinctFromServiceType(): true {
  return true;
}

export function validateCanonicalPeritajeV1(
  peritaje: CanonicalPeritajeV1,
): InvariantViolation[] {
  const errors: InvariantViolation[] = [];

  if (peritaje.schemaVersion !== PERITAJE_SCHEMA_VERSION) {
    errors.push(
      violation(
        'schema_version',
        `schemaVersion debe ser ${PERITAJE_SCHEMA_VERSION}`,
        'schemaVersion',
      ),
    );
  }
  if (!peritaje.peritajeId?.trim()) {
    errors.push(violation('missing_id', 'peritajeId es obligatorio', 'peritajeId'));
  }
  if (!peritaje.conversationId?.trim()) {
    errors.push(
      violation(
        'missing_conversation',
        'conversationId es obligatorio',
        'conversationId',
      ),
    );
  }

  const vehicleIds = new Set(peritaje.vehicles.map((v) => v.vehicleId));
  if (vehicleIds.size !== peritaje.vehicles.length) {
    errors.push(
      violation(
        'duplicate_vehicle',
        'vehicles[] no puede repetir vehicleId',
        'vehicles',
      ),
    );
  }

  const mergeKeys = new Set<string>();

  peritaje.damages.forEach((d, i) => {
    const base = `damages[${i}]`;
    if (!d.damageItemId?.trim()) {
      errors.push(violation('missing_id', 'damageItemId es obligatorio', `${base}.damageItemId`));
    }
    if (!d.vehicleId?.trim()) {
      errors.push(
        violation(
          'damage_requires_vehicle',
          'Un DamageItem siempre pertenece a un vehicleId',
          `${base}.vehicleId`,
        ),
      );
    } else if (!vehicleIds.has(d.vehicleId)) {
      errors.push(
        violation(
          'unknown_vehicle',
          `damage.vehicleId=${d.vehicleId} no existe en vehicles[]`,
          `${base}.vehicleId`,
        ),
      );
    }
    if (!d.physicalPanelKey?.trim()) {
      errors.push(
        violation(
          'missing_panel',
          'physicalPanelKey es obligatorio para merges',
          `${base}.physicalPanelKey`,
        ),
      );
    }
    if (!isStructuredTreatment(d.treatment)) {
      errors.push(
        violation(
          'invalid_treatment',
          'treatment debe ser REPARAR | SUSTITUIR | INCIERTO | PENDIENTE',
          `${base}.treatment`,
        ),
      );
    }
    if (hasMoneyLeak(d)) {
      errors.push(
        violation(
          'money_on_damage',
          'Los importes no forman parte de la decisión visual',
          base,
        ),
      );
    }

    if (d.vehicleId && d.physicalPanelKey) {
      const key = physicalMergeKey({
        vehicleId: d.vehicleId,
        physicalPanelKey: d.physicalPanelKey,
      });
      if (mergeKeys.has(key)) {
        errors.push(
          violation(
            'duplicate_physical_identity',
            `Identidad física duplicada: ${key}`,
            base,
          ),
        );
      }
      mergeKeys.add(key);
    }
  });

  return errors;
}

export function validateCanonicalQuoteV1(
  quote: CanonicalQuoteV1,
  peritaje?: CanonicalPeritajeV1,
): InvariantViolation[] {
  const errors: InvariantViolation[] = [];

  if (quote.schemaVersion !== QUOTE_SCHEMA_VERSION) {
    errors.push(
      violation(
        'schema_version',
        `schemaVersion debe ser ${QUOTE_SCHEMA_VERSION}`,
        'schemaVersion',
      ),
    );
  }
  if (!quote.quoteId?.trim()) {
    errors.push(violation('missing_id', 'quoteId es obligatorio', 'quoteId'));
  }
  if (!quote.peritajeId?.trim()) {
    errors.push(
      violation('missing_peritaje', 'quoteId debe referir un peritajeId', 'peritajeId'),
    );
  }
  if (peritaje && quote.peritajeId !== peritaje.peritajeId) {
    errors.push(
      violation(
        'peritaje_mismatch',
        'quote.peritajeId no coincide con el peritaje',
        'peritajeId',
      ),
    );
  }

  const damageById = new Map(
    (peritaje?.damages ?? []).map((d) => [d.damageItemId, d]),
  );
  const lineIds = new Set<string>();

  quote.lines.forEach((line, i) => {
    const base = `lines[${i}]`;
    if (!line.quoteLineId?.trim()) {
      errors.push(violation('missing_id', 'quoteLineId es obligatorio', `${base}.quoteLineId`));
    } else if (lineIds.has(line.quoteLineId)) {
      errors.push(
        violation('duplicate_line_id', 'quoteLineId duplicado', `${base}.quoteLineId`),
      );
    } else {
      lineIds.add(line.quoteLineId);
    }

    if (!line.damageItemId?.trim()) {
      errors.push(
        violation(
          'line_requires_damage',
          'QuoteLine debe referir damageItemId (nunca emparejar por índice)',
          `${base}.damageItemId`,
        ),
      );
    }
    if (!line.vehicleId?.trim()) {
      errors.push(
        violation(
          'line_requires_vehicle',
          'QuoteLine debe conservar vehicleId',
          `${base}.vehicleId`,
        ),
      );
    }
    if (!SERVICE_TYPE_SET.has(line.serviceType)) {
      errors.push(
        violation('invalid_service_type', 'serviceType inválido', `${base}.serviceType`),
      );
    }
    if (!Number.isFinite(line.amount) || line.amount < 0) {
      errors.push(violation('invalid_amount', 'amount debe ser >= 0', `${base}.amount`));
    }

    const damage = damageById.get(line.damageItemId);
    const commercial =
      Boolean(line.commercialItemId) ||
      String(line.damageItemId ?? '').startsWith('cmi_');
    if (peritaje && !damage && !commercial) {
      errors.push(
        violation(
          'unknown_damage',
          `damageItemId=${line.damageItemId} no existe en el peritaje`,
          `${base}.damageItemId`,
        ),
      );
    }
    if (damage && damage.vehicleId !== line.vehicleId) {
      errors.push(
        violation(
          'vehicle_mismatch',
          'QuoteLine.vehicleId debe coincidir con DamageItem.vehicleId',
          `${base}.vehicleId`,
        ),
      );
    }
  });

  if (peritaje) {
    const indexAssumption = assumesIndexCorrespondence(
      peritaje.damages,
      quote.lines,
    );
    if (indexAssumption) {
      errors.push(
        violation(
          'index_correspondence',
          'No se debe asumir correspondencia 1:1 por índice entre DamageItem y QuoteLine',
          'lines',
        ),
      );
    }
  }

  const billableSum = quote.lines
    .filter((l) => l.billable)
    .reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
  if (Math.round(billableSum) !== Math.round(quote.subtotal)) {
    errors.push(
      violation(
        'subtotal_mismatch',
        'subtotal debe ser la suma de líneas billable (la narrativa no es fuente financiera)',
        'subtotal',
      ),
    );
  }
  if (Math.round(quote.total) !== Math.round(quote.subtotal) && !quote.isPartial) {
    errors.push(
      violation(
        'total_mismatch',
        'total debe coincidir con subtotal salvo cotización parcial',
        'total',
      ),
    );
  }

  if (hasNarrativeAsFinancialSource(quote)) {
    errors.push(
      violation(
        'narrative_is_not_truth',
        'La narrativa no será fuente de verdad financiera',
        'lines',
      ),
    );
  }

  return errors;
}

/**
 * Detecta el anti-patrón legacy: emparejar daño[i] con línea[i]
 * cuando las longitudes coinciden y los IDs no cruzan.
 * Si hay IDs válidos que referencian daños, no hay violación.
 */
export function assumesIndexCorrespondence(
  damages: readonly DamageItem[],
  lines: readonly QuoteLine[],
): boolean {
  if (damages.length === 0 || lines.length === 0) return false;
  if (damages.length !== lines.length) return false;
  const damageIds = new Set(damages.map((d) => d.damageItemId));
  return lines.every((line, i) => {
    const byId = damageIds.has(line.damageItemId);
    const samePos = line.damageItemId === damages[i]?.damageItemId;
    return !byId && !samePos;
  });
}

function hasMoneyLeak(damage: DamageItem): boolean {
  const rec = damage as DamageItem & {
    amount?: unknown;
    precioMx?: unknown;
    unitPrice?: unknown;
    subtotal?: unknown;
    priceRange?: unknown;
  };
  return (
    rec.amount != null ||
    rec.precioMx != null ||
    rec.unitPrice != null ||
    rec.subtotal != null ||
    rec.priceRange != null
  );
}

function hasNarrativeAsFinancialSource(quote: CanonicalQuoteV1): boolean {
  const rec = quote as CanonicalQuoteV1 & {
    formalNarrative?: unknown;
    clientMessage?: unknown;
  };
  const narrative = String(rec.formalNarrative ?? rec.clientMessage ?? '');
  if (!narrative.trim()) return false;
  const amounts = quote.lines
    .filter((l) => l.billable && l.amount > 0)
    .map((l) => l.amount);
  if (!amounts.length) return false;
  const narrativeDigits = narrative.replace(/[^\d]/g, '');
  const lineDigits = amounts.map((a) => String(Math.round(a))).join('');
  return (
    quote.subtotal === 0 &&
    quote.total === 0 &&
    narrativeDigits.length > 0 &&
    lineDigits.length > 0
  );
}
