import {
  PERITAJE_SCHEMA_VERSION,
  QUOTE_SCHEMA_VERSION,
} from '../../domain/peritaje-v1';
import type {
  CanonicalPeritajeV1,
  CanonicalQuoteV1,
  DamageItem,
  QuoteLine,
} from '../../domain/peritaje-v1';
import { buildCanonicalFreeze } from '../../chat/canonical-quote-engine';
import type { QuoteSendSnapshot } from '../../chat/autofix-config';

export const ALTAMA_TOTAL_BEFORE = 13000;
export const CALAVERA_AMOUNT = 3650;
export const CALAVERA_RANGE_MIN = 3300;
export const CALAVERA_RANGE_MAX = 3650;
export const MONTAJE_AMOUNT = 850;
export const ALTAMA_TOTAL_AFTER =
  ALTAMA_TOTAL_BEFORE + CALAVERA_AMOUNT + MONTAJE_AMOUNT;

function line(
  partial: Partial<QuoteLine> & Pick<QuoteLine, 'serviceType' | 'amount'>,
): QuoteLine {
  return {
    quoteLineId: partial.quoteLineId ?? `ql_${partial.serviceType}`,
    damageItemId: partial.damageItemId ?? 'dmg_ft',
    vehicleId: 'veh_1',
    description: partial.description ?? 'pieza',
    billable: partial.billable ?? true,
    confidence: 'HIGH',
    ...partial,
  };
}

function quote(
  partial: Partial<CanonicalQuoteV1> & { lines: QuoteLine[] },
): CanonicalQuoteV1 {
  const chargeable = partial.lines
    .filter(
      (l) =>
        l.billable &&
        l.amount > 0 &&
        l.serviceType !== 'PENDIENTE' &&
        l.serviceType !== 'ADVERTENCIA' &&
        l.pricingStatus !== 'INSUFFICIENT_MARKET_SAMPLE' &&
        l.pricingStatus !== 'AWAITING_VEHICLE_DATA' &&
        l.pricingStatus !== 'UNCONFIGURED',
    )
    .reduce((s, l) => s + l.amount, 0);
  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    quoteId: partial.quoteId ?? 'q_ux_cert',
    peritajeId: 'per_ux_cert',
    subtotal: partial.subtotal ?? chargeable,
    total: partial.total ?? chargeable,
    isPartial: partial.isPartial ?? false,
    warnings: partial.warnings ?? [],
    generatedAt: '2026-09-14T00:00:00.000Z',
    lines: partial.lines,
  };
}

function damage(
  partial: Partial<DamageItem> & Pick<DamageItem, 'damageItemId' | 'pieceCode'>,
): DamageItem {
  return {
    vehicleId: 'veh_1',
    pieceLabel: partial.pieceLabel ?? partial.pieceCode,
    physicalPanelKey: partial.physicalPanelKey ?? partial.pieceCode,
    severity: 'DM',
    descriptionTechnical: 'Se aprecia afectación visible en la pieza.',
    treatment: 'REPARAR',
    treatmentConfidence: 'HIGH',
    treatmentSource: 'vision',
    treatmentReason: 'vision',
    requiresReplacement: false,
    possibleReplacement: false,
    evidence: [],
    source: 'vision',
    ...partial,
  };
}

export function altimaPeritaje(year?: string): CanonicalPeritajeV1 {
  return {
    schemaVersion: PERITAJE_SCHEMA_VERSION,
    peritajeId: 'per_ux_cert',
    conversationId: 'c_ux_cert',
    tallerId: 't1',
    vehicles: [
      {
        vehicleId: 'veh_1',
        make: 'Nissan',
        model: 'Altima',
        year,
        displayLabel: year ? `Nissan Altima ${year}` : 'Nissan Altima',
        confidence: year ? 'HIGH' : 'MEDIUM',
        source: year ? 'user' : 'vision',
        confirmedByUser: Boolean(year),
      },
    ],
    damages: [
      damage({
        damageItemId: 'dmg_ft',
        pieceCode: 'FT',
        pieceLabel: 'Fascia trasera',
        treatment: 'REPARAR',
      }),
      damage({
        damageItemId: 'dmg_std',
        pieceCode: 'Salpicadera trasera derecha',
        pieceLabel: 'Salpicadera trasera derecha',
        treatment: 'REPARAR',
      }),
      damage({
        damageItemId: 'dmg_tapa',
        pieceCode: 'Tapa Cajuela',
        pieceLabel: 'Tapa de cajuela',
        treatment: 'REPARAR',
      }),
      damage({
        damageItemId: 'dmg_cala',
        pieceCode: 'Calavera_Derecha',
        pieceLabel: 'Calavera derecha',
        treatment: 'SUSTITUIR',
        requiresReplacement: true,
        descriptionTechnical: 'Se aprecia afectación en la calavera derecha.',
      }),
    ],
    viability: { viable: true },
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
  };
}

export const fasciaTrasera = line({
  quoteLineId: 'ql_ft',
  damageItemId: 'dmg_ft',
  serviceType: 'REPARACION_PINTURA',
  amount: 5000,
  description: 'Fascia trasera',
});

export const salpicaderaTraseraDerecha = line({
  quoteLineId: 'ql_std',
  damageItemId: 'dmg_std',
  serviceType: 'REPARACION_PINTURA',
  amount: 4500,
  description: 'Salpicadera trasera derecha',
});

export const tapaCajuela = line({
  quoteLineId: 'ql_tapa',
  damageItemId: 'dmg_tapa',
  serviceType: 'REPARACION_PINTURA',
  amount: 3500,
  description: 'Tapa de cajuela',
});

export const calaveraPending = line({
  quoteLineId: 'ql_cala_ref',
  damageItemId: 'dmg_cala',
  serviceType: 'REFACCION',
  amount: 0,
  billable: false,
  description: 'Calavera derecha',
  pricingStatus: 'AWAITING_VEHICLE_DATA',
  pricingSource: 'AWAITING_VEHICLE_DATA',
});

export const calaveraPriced = line({
  quoteLineId: 'ql_cala_ref',
  damageItemId: 'dmg_cala',
  serviceType: 'REFACCION',
  amount: CALAVERA_AMOUNT,
  description: 'Calavera derecha',
  pricingSource: 'WEB_MARKET_ESTIMATE',
  pricingStatus: 'OK',
  priceRange: {
    min: CALAVERA_RANGE_MIN,
    max: CALAVERA_RANGE_MAX,
    central: CALAVERA_AMOUNT,
  },
});

export const calaveraMontaje = line({
  quoteLineId: 'ql_cala_mon',
  damageItemId: 'dmg_cala',
  serviceType: 'MONTAJE',
  amount: MONTAJE_AMOUNT,
  description: 'Calavera derecha',
});

export const espejoUpdate = line({
  quoteLineId: 'ql_espejo',
  damageItemId: 'dmg_espejo',
  serviceType: 'REPARACION_PINTURA',
  amount: 2200,
  description: 'Espejo derecho',
});

export function partialAltimaQuote(): CanonicalQuoteV1 {
  const q = quote({
    quoteId: 'q_ux_cert_partial',
    lines: [fasciaTrasera, salpicaderaTraseraDerecha, tapaCajuela, calaveraPending],
    isPartial: true,
    warnings: ['AWAITING_VEHICLE_DATA', 'HIDDEN_DAMAGE', 'POSSIBLE_SUBSTITUTION'],
  });
  if (q.total !== ALTAMA_TOTAL_BEFORE) {
    throw new Error(`fixture totalBefore ${q.total} != ${ALTAMA_TOTAL_BEFORE}`);
  }
  return q;
}

export function resumedAltimaQuote(): CanonicalQuoteV1 {
  const q = quote({
    quoteId: 'q_ux_cert_resumed',
    lines: [
      fasciaTrasera,
      salpicaderaTraseraDerecha,
      tapaCajuela,
      calaveraPriced,
      calaveraMontaje,
    ],
    warnings: ['HIDDEN_DAMAGE', 'POSSIBLE_SUBSTITUTION'],
  });
  if (q.total !== ALTAMA_TOTAL_AFTER) {
    throw new Error(`fixture totalAfter ${q.total} != ${ALTAMA_TOTAL_AFTER}`);
  }
  return q;
}

export function correctedAltima2015Quote(): CanonicalQuoteV1 {
  return quote({
    quoteId: 'q_ux_cert_2015',
    lines: [
      fasciaTrasera,
      salpicaderaTraseraDerecha,
      tapaCajuela,
      {
        ...calaveraPriced,
        amount: 3800,
        priceRange: { min: 3500, max: 4100, central: 3800 },
      },
      calaveraMontaje,
    ],
    warnings: ['HIDDEN_DAMAGE'],
  });
}

export function updatedAltimaQuote(): CanonicalQuoteV1 {
  return quote({
    quoteId: 'q_ux_cert_update',
    lines: [
      fasciaTrasera,
      salpicaderaTraseraDerecha,
      tapaCajuela,
      calaveraPriced,
      calaveraMontaje,
      espejoUpdate,
    ],
    warnings: ['HIDDEN_DAMAGE'],
  });
}

export function sendSnapshot(
  q: CanonicalQuoteV1,
  extra?: Partial<QuoteSendSnapshot>,
): QuoteSendSnapshot {
  return {
    sentAt: '2026-09-14T10:00:00.000Z',
    total: q.total,
    subtotal: q.subtotal,
    desglose: q.lines.map((l) => ({
      pieza: l.description,
      severidad: 'DM',
      precioMx: l.amount,
      precioMaximo: l.priceRange?.max,
      quoteLineId: l.quoteLineId,
      damageItemId: l.damageItemId,
      serviceType: l.serviceType,
    })),
    finalMessage:
      extra?.finalMessage ??
      'Hola Arturo, ya revisamos las fotografías de tu Nissan Altima.',
    canonicalFreeze: buildCanonicalFreeze(q),
    shownWarnings: [...q.warnings],
    ...extra,
  };
}
