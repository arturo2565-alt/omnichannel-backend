/**
 * Fase 7 — QuoteLines comerciales (express / extras / BPC texto).
 * Reutiliza importes ya resueltos. No recalcula pricing.
 */
import {
  createCommercialCatalogId,
  createCommercialItemId,
  createQuoteId,
  createQuoteLineId,
  createVehicleId,
  finalizeCanonicalQuote,
  QUOTE_SCHEMA_VERSION,
  type CanonicalQuoteV1,
  type CommercialItemV1,
  type QuoteLine,
  type QuoteServiceType,
} from '../domain/peritaje-v1';
import {
  quoteLineMarketProjection,
  type QuoteRowInput,
} from './draft-quote-inventory-pricing';

export function commercialQuoteLine(input: {
  vehicleId: string;
  serviceKey: string;
  serviceLabel: string;
  amount: number;
  source: CommercialItemV1['source'];
  serviceType?: QuoteServiceType;
  discriminator?: string;
  billable?: boolean;
}): { entry: CommercialItemV1; line: QuoteLine } {
  const amount = Math.max(0, Math.round(Number(input.amount) || 0));
  const serviceType = input.serviceType ?? 'REPARACION_PINTURA';
  const commercialItemId = createCommercialItemId({
    vehicleId: input.vehicleId,
    serviceKey: input.serviceKey,
    discriminator: input.discriminator,
  });
  const billable = input.billable !== false && amount > 0;
  return {
    entry: {
      commercialItemId,
      vehicleId: input.vehicleId,
      serviceKey: input.serviceKey,
      serviceLabel: input.serviceLabel,
      source: input.source,
    },
    line: {
      quoteLineId: createQuoteLineId({
        damageItemId: commercialItemId,
        serviceType,
      }),
      damageItemId: commercialItemId,
      commercialItemId,
      vehicleId: input.vehicleId,
      serviceType,
      description: input.serviceLabel,
      billable,
      amount,
      pricingSource: 'AUTOFIX_CATALOG',
      pricingStatus: 'OK',
      confidence: 'HIGH',
    },
  };
}

export function commercialLinesFromExtras(
  extras: ReadonlyArray<{ label: string; amount: number }> | undefined,
  vehicleId: string,
  source: CommercialItemV1['source'] = 'express',
): { entries: CommercialItemV1[]; lines: QuoteLine[] } {
  const entries: CommercialItemV1[] = [];
  const lines: QuoteLine[] = [];
  for (const ex of extras ?? []) {
    const amt = Math.max(0, Math.round(Number(ex.amount) || 0));
    if (amt <= 0) continue;
    const built = commercialQuoteLine({
      vehicleId,
      serviceKey: String(ex.label ?? 'extra').trim() || 'extra',
      serviceLabel: String(ex.label ?? 'Extra').trim() || 'Extra',
      amount: amt,
      source,
      discriminator: 'addon',
    });
    entries.push(built.entry);
    lines.push(built.line);
  }
  return { entries, lines };
}

export function commercialBundleFromExpress(
  express: {
    lines?: Array<{
      servicio?: string;
      canonical?: string;
      tipo?: string;
      precioLineaMx: number;
    }>;
    extras?: Array<{ label: string; amount: number }>;
    vehicleDisplayLabel?: string;
    modeloVehiculo?: string;
  },
  conversationId?: string,
): {
  vehicleId: string;
  entries: CommercialItemV1[];
  lines: QuoteLine[];
  quote: CanonicalQuoteV1;
} {
  const vehicleId = createVehicleId({
    displayLabel:
      express.vehicleDisplayLabel || express.modeloVehiculo || 'vehiculo',
  });
  const entries: CommercialItemV1[] = [];
  const lines: QuoteLine[] = [];

  for (const row of express.lines ?? []) {
    const built = commercialQuoteLine({
      vehicleId,
      serviceKey: String(row.canonical || row.servicio || 'servicio'),
      serviceLabel: String(row.servicio || row.canonical || 'Servicio'),
      amount: row.precioLineaMx,
      source: row.tipo === 'bano_pintura' ? 'bpc' : 'express',
    });
    entries.push(built.entry);
    lines.push(built.line);
  }

  const extras = commercialLinesFromExtras(express.extras, vehicleId, 'express');
  entries.push(...extras.entries);
  lines.push(...extras.lines);

  const quote = finalizeCanonicalQuote({
    lines,
    peritajeId: createCommercialCatalogId(conversationId),
    quoteId: createQuoteId(),
  });

  return { vehicleId, entries, lines, quote };
}

export function canonicalQuoteFromInstantResolution(
  resolution: {
    lines?: Array<{ label: string; amount: number }>;
    extras?: Array<{ label: string; amount: number }>;
  },
  opts?: { conversationId?: string; vehicleLabel?: string; quoteId?: string },
): CanonicalQuoteV1 {
  const vehicleId = createVehicleId({
    displayLabel: opts?.vehicleLabel || 'vehiculo',
  });
  const lines: QuoteLine[] = [];
  for (const row of resolution.lines ?? []) {
    lines.push(
      commercialQuoteLine({
        vehicleId,
        serviceKey: row.label,
        serviceLabel: row.label,
        amount: row.amount,
        source: 'bpc',
      }).line,
    );
  }
  for (const ex of resolution.extras ?? []) {
    lines.push(
      commercialQuoteLine({
        vehicleId,
        serviceKey: ex.label,
        serviceLabel: ex.label,
        amount: ex.amount,
        source: 'bpc',
        discriminator: 'addon',
      }).line,
    );
  }
  return finalizeCanonicalQuote({
    lines,
    peritajeId: createCommercialCatalogId(opts?.conversationId),
    quoteId: opts?.quoteId || createQuoteId(),
  });
}

export function mergeCommercialLinesIntoQuote(
  base: CanonicalQuoteV1,
  extraLines: readonly QuoteLine[],
): CanonicalQuoteV1 {
  const seen = new Set(base.lines.map((l) => l.quoteLineId));
  const appended = extraLines.filter((l) => !seen.has(l.quoteLineId));
  if (!appended.length) return base;
  return finalizeCanonicalQuote({
    lines: [...base.lines, ...appended],
    peritajeId: base.peritajeId,
    quoteId: base.quoteId,
    generatedAt: base.generatedAt,
  });
}

export function quoteLinesFromPricedRows(
  rows: readonly QuoteRowInput[],
  vehicleIdFallback: string,
): QuoteLine[] {
  return rows.map((row) => {
    const amount = Math.max(0, Math.round(Number(row.precioMx) || 0));
    const serviceType = (row.serviceType ||
      'REPARACION_PINTURA') as QuoteServiceType;
    const insufficient =
      row.pricingStatus === 'INSUFFICIENT_MARKET_SAMPLE' ||
      row.priceSource === 'INSUFFICIENT_MARKET_SAMPLE';
    const nonChargeable =
      serviceType === 'PENDIENTE' || serviceType === 'ADVERTENCIA';
    const damageItemId =
      String(row.damageItemId ?? '').trim() ||
      String(row.quoteLineId ?? '').trim() ||
      createCommercialItemId({
        vehicleId: vehicleIdFallback,
        serviceKey: String(row.pieza ?? 'servicio'),
      });
    const commercial = damageItemId.startsWith('cmi_');
    return {
      quoteLineId:
        String(row.quoteLineId ?? '').trim() ||
        createQuoteLineId({ damageItemId, serviceType }),
      damageItemId,
      ...(commercial ? { commercialItemId: damageItemId } : {}),
      vehicleId: String(row.vehicleId ?? '').trim() || vehicleIdFallback,
      serviceType,
      description: String(row.description ?? row.descripcionServicio ?? row.pieza ?? ''),
      billable: row.billable === true && amount > 0 && !insufficient && !nonChargeable,
      amount,
      confidence: 'MEDIUM' as const,
      ...(row.priceSource
        ? { pricingSource: row.priceSource as QuoteLine['pricingSource'] }
        : {}),
      ...(row.pricingStatus
        ? { pricingStatus: row.pricingStatus as QuoteLine['pricingStatus'] }
        : {}),
      ...quoteLineMarketProjection(row),
    };
  });
}

export function buildCanonicalQuoteFromPricedSources(input: {
  conversationId?: string;
  quoteId?: string;
  vehicleId: string;
  rows: readonly QuoteRowInput[];
  extraLines?: readonly QuoteLine[];
  peritajeId?: string;
}): CanonicalQuoteV1 {
  const lines = [
    ...quoteLinesFromPricedRows(input.rows, input.vehicleId),
    ...(input.extraLines ?? []),
  ];
  return finalizeCanonicalQuote({
    lines,
    peritajeId:
      input.peritajeId || createCommercialCatalogId(input.conversationId),
    quoteId: input.quoteId || createQuoteId(),
  });
}

export function assertQuoteSchema(quote: CanonicalQuoteV1): boolean {
  return quote.schemaVersion === QUOTE_SCHEMA_VERSION && Array.isArray(quote.lines);
}
