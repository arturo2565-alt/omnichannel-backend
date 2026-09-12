import { finalizeCanonicalQuote } from './quote-engine';
import { createQuoteId, createQuoteLineId, createVehicleId } from './ids';
import {
  buildAggregateQuoteView,
  composeAggregateClientQuoteMessage,
  quotesMixVehicles,
} from './aggregate-quote';
import type { CanonicalQuoteV1, QuoteLine } from './types';

function quoteForVehicle(
  label: string,
  amount: number,
  isPartial = false,
): CanonicalQuoteV1 {
  const vehicleId = createVehicleId({ displayLabel: label });
  const line: QuoteLine = {
    quoteLineId: createQuoteLineId({
      damageItemId: `cmi_${vehicleId}`,
      serviceType: 'REPARACION_PINTURA',
    }),
    damageItemId: `cmi_${vehicleId}`,
    vehicleId,
    serviceType: 'REPARACION_PINTURA',
    description: `Baño ${label}`,
    billable: true,
    amount,
    pricingSource: 'AUTOFIX_CATALOG',
    pricingStatus: 'OK',
    confidence: 'HIGH',
  };
  const quote = finalizeCanonicalQuote({
    lines: [line],
    peritajeId: `com_${vehicleId}`,
    quoteId: createQuoteId(),
  });
  return isPartial ? { ...quote, isPartial: true } : quote;
}

describe('AggregateQuoteView', () => {
  it('combinedTotal es presentación; cada quote sigue siendo autoridad', () => {
    const a = quoteForVehicle('Aveo 2015', 15000);
    const b = quoteForVehicle('Jetta 2019', 25000);
    const view = buildAggregateQuoteView([a, b]);
    expect(view.combinedTotal).toBe(40000);
    expect(view.quoteIds).toEqual([a.quoteId, b.quoteId]);
    expect(view.vehicleIds).toHaveLength(2);
    expect(a.total).toBe(15000);
    expect(b.total).toBe(25000);
    expect(quotesMixVehicles([a, b])).toBe(false);
  });

  it('el financialBlock combinado se genera desde las CanonicalQuotes individuales', () => {
    const a = quoteForVehicle('Aveo 2015', 15000);
    const b = quoteForVehicle('Jetta 2019', 25000);
    const composed = composeAggregateClientQuoteMessage({
      quotes: [
        { quote: a, vehicleLabel: 'Aveo 2015' },
        { quote: b, vehicleLabel: 'Jetta 2019' },
      ],
      contactName: 'Ana',
    });
    expect(composed.aggregate.combinedTotal).toBe(40000);
    expect(composed.financialBlock).toContain('Aveo 2015');
    expect(composed.financialBlock).toContain('Jetta 2019');
    expect(composed.financialBlock).toContain('$15,000');
    expect(composed.financialBlock).toContain('$25,000');
    expect(composed.financialBlock).toContain('$40,000');
    expect(composed.finalMessage).toContain(composed.financialBlock);
  });

  it('detecta líneas de dos vehículos mezcladas en una sola quote', () => {
    const mixed = quoteForVehicle('Aveo 2015', 15000);
    const other = createVehicleId({ displayLabel: 'Jetta 2019' });
    mixed.lines.push({
      ...mixed.lines[0]!,
      vehicleId: other,
      quoteLineId: createQuoteLineId({
        damageItemId: `cmi_${other}`,
        serviceType: 'REPARACION_PINTURA',
      }),
    });
    expect(quotesMixVehicles([mixed])).toBe(true);
  });
});
