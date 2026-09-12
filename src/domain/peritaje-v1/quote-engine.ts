/**
 * Quote Engine de dominio: totales, isPartial, warnings e invariantes
 * financieras. No calcula precios de catálogo/mercado.
 */
import { createQuoteId } from './ids';
import {
  validateCanonicalPeritajeV1,
  validateCanonicalQuoteV1,
} from './invariants';
import { isCanonicalPeritajeV1 } from './shadow';
import {
  QUOTE_SCHEMA_VERSION,
  type CanonicalPeritajeV1,
  type CanonicalQuoteV1,
  type InvariantViolation,
  type QuoteLine,
} from './types';

export const CANONICAL_QUOTE_WARNINGS = {
  REFACCION_PENDIENTE_DE_COTIZAR: 'REFACCION_PENDIENTE_DE_COTIZAR',
  HIDDEN_DAMAGE: 'HIDDEN_DAMAGE',
  POSSIBLE_SUBSTITUTION: 'POSSIBLE_SUBSTITUTION',
  PENDING_TREATMENT: 'PENDING_TREATMENT',
} as const;

export const FINANCIAL_DIFF_TYPES = [
  'TOTAL_DIFFERENCE',
  'SUBTOTAL_DIFFERENCE',
  'LINE_COUNT_DIFFERENCE',
  'SERVICE_TYPE_DIFFERENCE',
  'BILLABLE_DIFFERENCE',
  'PARTIAL_STATUS_DIFFERENCE',
  'MISSING_CANONICAL_LINE',
  'EXTRA_LEGACY_LINE',
  'LEGACY_TOTAL_FALLBACK_USED',
] as const;

export type FinancialDiffType = (typeof FINANCIAL_DIFF_TYPES)[number];

export type FinancialDifference = {
  type: FinancialDiffType;
  quoteLineId?: string;
  serviceType?: string;
  canonical?: number | string | boolean;
  legacy?: number | string | boolean;
};

/**
 * Línea cobrable para el total.
 * Defensa por contrato: billable false, PENDIENTE, ADVERTENCIA o
 * INSUFFICIENT no suman aunque amount > 0.
 */
export function isChargeableQuoteLine(line: Pick<
  QuoteLine,
  'billable' | 'amount' | 'serviceType' | 'pricingStatus' | 'pricingSource'
>): boolean {
  if (line.billable !== true) return false;
  if (line.serviceType === 'PENDIENTE' || line.serviceType === 'ADVERTENCIA') {
    return false;
  }
  if (line.pricingStatus === 'INSUFFICIENT_MARKET_SAMPLE') return false;
  if (line.pricingSource === 'INSUFFICIENT_MARKET_SAMPLE') return false;
  return Number(line.amount) > 0;
}

export function sumChargeableAmount(lines: readonly QuoteLine[]): number {
  return lines.reduce(
    (acc, line) => acc + (isChargeableQuoteLine(line) ? Math.round(line.amount) : 0),
    0,
  );
}

export function deriveCanonicalWarnings(
  lines: readonly QuoteLine[],
  peritaje?: CanonicalPeritajeV1 | null,
): string[] {
  const warnings = new Set<string>();
  for (const line of lines) {
    if (
      line.serviceType === 'REFACCION' &&
      !isChargeableQuoteLine(line)
    ) {
      warnings.add(CANONICAL_QUOTE_WARNINGS.REFACCION_PENDIENTE_DE_COTIZAR);
    }
    if (line.serviceType === 'PENDIENTE') {
      warnings.add(CANONICAL_QUOTE_WARNINGS.PENDING_TREATMENT);
    }
    if (line.serviceType === 'ADVERTENCIA') {
      warnings.add(CANONICAL_QUOTE_WARNINGS.HIDDEN_DAMAGE);
    }
  }
  for (const d of peritaje?.damages ?? []) {
    if (d.possibleHiddenDamage?.detected) {
      warnings.add(CANONICAL_QUOTE_WARNINGS.HIDDEN_DAMAGE);
    }
    if (d.treatment === 'INCIERTO' || d.possibleReplacement) {
      warnings.add(CANONICAL_QUOTE_WARNINGS.POSSIBLE_SUBSTITUTION);
    }
    if (d.treatment === 'PENDIENTE') {
      warnings.add(CANONICAL_QUOTE_WARNINGS.PENDING_TREATMENT);
    }
  }
  return [...warnings];
}

/**
 * isPartial cuando falta valorizar una línea comercial necesaria.
 * ADVERTENCIA/hidden damage no hace parcial por sí sola.
 */
export function deriveIsPartial(lines: readonly QuoteLine[]): boolean {
  return lines.some((line) => {
    if (line.serviceType === 'ADVERTENCIA') return false;
    if (line.serviceType === 'PENDIENTE') return true;
    if (line.serviceType === 'REFACCION' && !isChargeableQuoteLine(line)) {
      return true;
    }
    if (line.pricingStatus === 'INSUFFICIENT_MARKET_SAMPLE') return true;
    if (line.pricingSource === 'UNCONFIGURED') return true;
    return false;
  });
}

export function finalizeCanonicalQuote(input: {
  lines: QuoteLine[];
  peritajeId: string;
  quoteId?: string;
  generatedAt?: string;
  peritaje?: CanonicalPeritajeV1 | null;
}): CanonicalQuoteV1 {
  const subtotal = sumChargeableAmount(input.lines);
  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    quoteId: input.quoteId || createQuoteId(),
    peritajeId: input.peritajeId,
    lines: input.lines,
    subtotal,
    total: subtotal,
    isPartial: deriveIsPartial(input.lines),
    warnings: deriveCanonicalWarnings(input.lines, input.peritaje),
    generatedAt: input.generatedAt || new Date().toISOString(),
  };
}

export function canAttemptCanonicalFinancialFlow(
  peritaje: unknown,
): peritaje is CanonicalPeritajeV1 {
  if (!isCanonicalPeritajeV1(peritaje)) return false;
  return validateCanonicalPeritajeV1(peritaje).length === 0;
}

export function isCanonicalFinancialAuthority(input: {
  peritaje?: CanonicalPeritajeV1 | null;
  quote?: CanonicalQuoteV1 | null;
}): boolean {
  if (!input.peritaje || !input.quote) return false;
  if (!canAttemptCanonicalFinancialFlow(input.peritaje)) return false;
  return validateCanonicalQuoteFinancial(input.quote, input.peritaje).length === 0;
}

export function validateCanonicalQuoteFinancial(
  quote: CanonicalQuoteV1,
  peritaje?: CanonicalPeritajeV1,
): InvariantViolation[] {
  const errors = validateCanonicalQuoteV1(quote, peritaje);
  const chargeable = sumChargeableAmount(quote.lines);
  if (Math.round(quote.subtotal) !== chargeable) {
    errors.push({
      code: 'subtotal_not_chargeable_sum',
      message: 'subtotal debe ser la suma de líneas cobrables',
      path: 'subtotal',
    });
  }
  if (Math.round(quote.total) !== Math.round(quote.subtotal)) {
    errors.push({
      code: 'total_not_subtotal',
      message: 'total debe igualar subtotal (sin impuestos modelados)',
      path: 'total',
    });
  }
  const expectedPartial = deriveIsPartial(quote.lines);
  if (quote.isPartial !== expectedPartial) {
    errors.push({
      code: 'partial_mismatch',
      message: 'isPartial no coincide con líneas no valorizadas',
      path: 'isPartial',
    });
  }

  if (peritaje) {
    const byDamage = new Map<string, QuoteLine[]>();
    for (const line of quote.lines) {
      const list = byDamage.get(line.damageItemId) ?? [];
      list.push(line);
      byDamage.set(line.damageItemId, list);
    }
    for (const d of peritaje.damages) {
      const lines = byDamage.get(d.damageItemId) ?? [];
      const types = new Set(lines.map((l) => l.serviceType));
      if (d.treatment === 'SUSTITUIR' && types.has('REPARACION_PINTURA')) {
        errors.push({
          code: 'substituir_has_repair_line',
          message:
            'SUSTITUIR no puede emitir REPARACION_PINTURA para el mismo DamageItem',
          path: `damages.${d.damageItemId}`,
        });
      }
      if (d.treatment === 'REPARAR' && types.has('REFACCION')) {
        errors.push({
          code: 'reparar_has_refaccion_line',
          message: 'REPARAR no puede emitir REFACCION sin decisión explícita',
          path: `damages.${d.damageItemId}`,
        });
      }
    }
  }

  for (const line of quote.lines) {
    if (line.amount < 0) {
      errors.push({
        code: 'negative_amount',
        message: 'amount debe ser >= 0',
        path: `lines.${line.quoteLineId}.amount`,
      });
    }
  }

  return errors;
}

export function compareCanonicalVsLegacyFinance(input: {
  canonical: Pick<CanonicalQuoteV1, 'total' | 'subtotal' | 'isPartial' | 'lines'>;
  legacy: {
    total?: number;
    subtotal?: number;
    isPartial?: boolean;
    lines?: Array<{
      quoteLineId?: string;
      serviceType?: string;
      billable?: boolean;
      amount?: number;
    }>;
  };
}): FinancialDifference[] {
  const diffs: FinancialDifference[] = [];
  const legacyTotal = Math.round(Number(input.legacy.total) || 0);
  const legacySub = Math.round(Number(input.legacy.subtotal) || 0);
  if (legacyTotal !== Math.round(input.canonical.total)) {
    diffs.push({
      type: 'TOTAL_DIFFERENCE',
      canonical: input.canonical.total,
      legacy: legacyTotal,
    });
  }
  if (legacySub !== Math.round(input.canonical.subtotal)) {
    diffs.push({
      type: 'SUBTOTAL_DIFFERENCE',
      canonical: input.canonical.subtotal,
      legacy: legacySub,
    });
  }
  const legacyLines = input.legacy.lines ?? [];
  if (legacyLines.length !== input.canonical.lines.length) {
    diffs.push({
      type: 'LINE_COUNT_DIFFERENCE',
      canonical: input.canonical.lines.length,
      legacy: legacyLines.length,
    });
  }
  if (
    input.legacy.isPartial != null &&
    input.legacy.isPartial !== input.canonical.isPartial
  ) {
    diffs.push({
      type: 'PARTIAL_STATUS_DIFFERENCE',
      canonical: input.canonical.isPartial,
      legacy: input.legacy.isPartial,
    });
  }
  const legacyById = new Map(
    legacyLines.filter((l) => l.quoteLineId).map((l) => [l.quoteLineId!, l]),
  );
  for (const line of input.canonical.lines) {
    const other = legacyById.get(line.quoteLineId);
    if (!other) {
      diffs.push({
        type: 'MISSING_CANONICAL_LINE',
        quoteLineId: line.quoteLineId,
        serviceType: line.serviceType,
      });
      continue;
    }
    if (other.serviceType && other.serviceType !== line.serviceType) {
      diffs.push({
        type: 'SERVICE_TYPE_DIFFERENCE',
        quoteLineId: line.quoteLineId,
        canonical: line.serviceType,
        legacy: other.serviceType,
      });
    }
    if (other.billable != null && other.billable !== line.billable) {
      diffs.push({
        type: 'BILLABLE_DIFFERENCE',
        quoteLineId: line.quoteLineId,
        canonical: line.billable,
        legacy: other.billable,
      });
    }
  }
  for (const line of legacyLines) {
    if (
      line.quoteLineId &&
      !input.canonical.lines.some((l) => l.quoteLineId === line.quoteLineId)
    ) {
      diffs.push({
        type: 'EXTRA_LEGACY_LINE',
        quoteLineId: line.quoteLineId,
        serviceType: line.serviceType,
      });
    }
  }
  return diffs;
}
