/**
 * Vista agregada multi-vehículo.
 * Cada CanonicalQuoteV1 sigue siendo autoridad de su vehículo.
 * combinedTotal es PRESENTACIÓN, no una quote mezclada.
 */
import type { CanonicalQuoteV1 } from './types';
import {
  assembleClientQuoteMessage,
  formatQuoteMoney,
  renderCanonicalQuoteFinancialBlock,
  renderCanonicalQuoteWarningsBlock,
  type ClientQuoteMessage,
} from './quote-narrative';

export type AggregateQuoteView = {
  quoteIds: string[];
  vehicleIds: string[];
  combinedTotal: number;
  isPartial: boolean;
};

export type LabeledVehicleQuote = {
  quote: CanonicalQuoteV1;
  vehicleId?: string;
  vehicleLabel: string;
};

export function buildAggregateQuoteView(
  quotes: readonly CanonicalQuoteV1[],
): AggregateQuoteView {
  const quoteIds = quotes.map((q) => q.quoteId).filter(Boolean);
  const vehicleIds = [
    ...new Set(
      quotes.flatMap((q) =>
        q.lines.map((l) => String(l.vehicleId ?? '').trim()).filter(Boolean),
      ),
    ),
  ];
  const combinedTotal = quotes.reduce(
    (sum, q) => sum + Math.max(0, Math.round(Number(q.total) || 0)),
    0,
  );
  return {
    quoteIds,
    vehicleIds,
    combinedTotal,
    isPartial: quotes.some((q) => q.isPartial === true),
  };
}

export function renderAggregateFinancialBlock(
  quotes: readonly LabeledVehicleQuote[],
): { text: string; aggregate: AggregateQuoteView } {
  const aggregate = buildAggregateQuoteView(quotes.map((q) => q.quote));
  const sections = quotes.map((entry) => {
    const block = renderCanonicalQuoteFinancialBlock(entry.quote);
    const warnings = renderCanonicalQuoteWarningsBlock(entry.quote);
    return [`**${entry.vehicleLabel}**`, block.text, warnings.text]
      .filter(Boolean)
      .join('\n');
  });
  const combined = aggregate.isPartial
    ? `💰 **Total combinado (parcial): ${formatQuoteMoney(aggregate.combinedTotal)} MXN** *(cada vehículo se cotizó por separado; el total combinado es presentación).*`
    : `💰 **Total combinado: ${formatQuoteMoney(aggregate.combinedTotal)} MXN** *(suma determinista de las cotizaciones individuales).*`;
  return {
    text: [...sections, combined].filter(Boolean).join('\n\n'),
    aggregate,
  };
}

export function composeAggregateClientQuoteMessage(input: {
  quotes: readonly LabeledVehicleQuote[];
  contactName?: string;
  hasActiveAppointment?: boolean;
  appointmentFormatted?: string;
  mapsUrl?: string;
}): { finalMessage: string; financialBlock: string; aggregate: AggregateQuoteView } {
  const rendered = renderAggregateFinancialBlock(input.quotes);
  const name = String(input.contactName ?? '').trim() || 'Estimado cliente';
  const parts: ClientQuoteMessage = {
    intro: `${name}, te dejo el presupuesto de cada vehículo por separado.`,
    technicalExplanation: '',
    financialBlock: rendered.text,
    warningsBlock: '',
    cta: input.hasActiveAppointment
      ? input.appointmentFormatted
        ? `Tu cita queda para ${input.appointmentFormatted}.`
        : 'Tu cita ya está agendada.'
      : input.mapsUrl
        ? `Cuando quieras agendamos. Ubicación: ${input.mapsUrl}`
        : 'Cuando quieras agendamos la recepción.',
  };
  return {
    finalMessage: assembleClientQuoteMessage(parts),
    financialBlock: rendered.text,
    aggregate: rendered.aggregate,
  };
}

export function quotesMixVehicles(quotes: readonly CanonicalQuoteV1[]): boolean {
  const ids = new Set<string>();
  for (const q of quotes) {
    const inQuote = new Set(
      q.lines.map((l) => String(l.vehicleId ?? '').trim()).filter(Boolean),
    );
    if (inQuote.size > 1) return true;
    for (const id of inQuote) {
      if (ids.has(id) && quotes.length > 1) {
        /* mismo vehicleId en dos quotes no es colisión de DamageItem */
      }
      ids.add(id);
    }
  }
  return quotes.some((q) => {
    const vids = new Set(
      q.lines.map((l) => String(l.vehicleId ?? '').trim()).filter(Boolean),
    );
    return vids.size > 1;
  });
}
