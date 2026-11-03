import { PERITAJE_SCHEMA_VERSION, QUOTE_SCHEMA_VERSION } from '../domain/peritaje-v1';
import type {
  CanonicalPeritajeV1,
  CanonicalQuoteV1,
  DamageItem,
  QuoteLine,
  TreatmentDecision,
} from '../domain/peritaje-v1';
import { formatQuoteMoney } from '../domain/peritaje-v1';
import { composeModernClientQuoteMessage } from './canonical-quote-narrative';

function line(
  partial: Partial<QuoteLine> & Pick<QuoteLine, 'serviceType' | 'amount' | 'quoteLineId'>,
): QuoteLine {
  return {
    damageItemId: partial.damageItemId ?? partial.quoteLineId,
    vehicleId: 'veh_1',
    description: partial.description ?? 'fascia delantera',
    billable: partial.billable ?? partial.amount > 0,
    confidence: 'HIGH',
    ...partial,
  };
}

function quote(partial: Partial<CanonicalQuoteV1> & { lines: QuoteLine[] }): CanonicalQuoteV1 {
  const chargeable = partial.lines
    .filter((item) => item.billable && item.amount > 0)
    .reduce((sum, item) => sum + item.amount, 0);
  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    quoteId: 'q_ux',
    peritajeId: 'per_ux',
    subtotal: partial.subtotal ?? chargeable,
    total: partial.total ?? chargeable,
    isPartial: partial.isPartial ?? false,
    warnings: partial.warnings ?? [],
    generatedAt: '2026-11-02T00:00:00.000Z',
    lines: partial.lines,
  };
}

function damage(
  id: string,
  label: string,
  treatment: TreatmentDecision,
): DamageItem {
  return {
    damageItemId: id,
    vehicleId: 'veh_1',
    pieceCode: /\s/.test(label) ? label : 'FD',
    pieceLabel: label,
    physicalPanelKey: /\s/.test(label) ? label : 'FD',
    severity: 'DM',
    descriptionTechnical:
      'Se observa deformación estructural con transferencia de pintura y compromiso de anclajes que requiere un dictamen extendido.',
    treatment,
    treatmentConfidence: 'MEDIUM',
    treatmentSource: 'vision',
    treatmentReason: 'vision',
    requiresReplacement: treatment === 'SUSTITUIR',
    possibleReplacement: treatment === 'INCIERTO',
    evidence: [],
    source: 'vision',
  };
}

function peritaje(input: {
  vehicle?: CanonicalPeritajeV1['vehicles'][number] | null;
  damages: DamageItem[];
}): CanonicalPeritajeV1 {
  return {
    schemaVersion: PERITAJE_SCHEMA_VERSION,
    peritajeId: 'per_ux',
    conversationId: 'c1',
    tallerId: 't1',
    vehicles: input.vehicle ? [input.vehicle] : [],
    damages: input.damages,
    viability: { viable: true },
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
  };
}

const beetle = {
  vehicleId: 'veh_1',
  make: 'Volkswagen',
  model: 'Beetle',
  year: '2015',
  displayLabel: 'Volkswagen Beetle 2015',
  confidence: 'HIGH' as const,
  source: 'vision' as const,
  confirmedByUser: false,
  confirmedFields: ['model', 'year'],
};

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function questions(text: string): string[] {
  return text
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row.includes('¿') || row.includes('📅') || row.includes('📍'));
}

async function render(
  canonicalQuote: CanonicalQuoteV1,
  doc: CanonicalPeritajeV1,
) {
  return composeModernClientQuoteMessage({
    canonicalQuote,
    peritaje: doc,
    contactName: 'Arturo',
    hasActiveAppointment: false,
    mapsUrl: 'https://maps.example/taller',
    damageIntro:
      'Buenas tardes. Ya analizamos las fotografías y el dictamen técnico completo de cada panel.',
    llmParts: {
      intro:
        'Buenas tardes, Arturo. Revisamos las fotos y el golpe comprometió la estructura visible de varias piezas.',
      technicalExplanation:
        'Se observa deformación, transferencia de pintura y posible compromiso de anclajes en cada panel fotografiado.',
      cta: '¿Agendamos y también te mando el mapa?',
    },
  });
}

describe('UX-001 cotización breve de WhatsApp', () => {
  it('1. una pieza conserva el precio y cabe en un mensaje corto', async () => {
    const q = quote({
      lines: [
        line({
          quoteLineId: 'ql_fascia',
          serviceType: 'REPARACION_PINTURA',
          amount: 3400,
          description: 'fascia delantera',
        }),
      ],
    });
    const doc = peritaje({
      vehicle: beetle,
      damages: [damage('ql_fascia', 'Fascia delantera', 'REPARAR')],
    });
    const before = JSON.stringify(q);
    const composed = await render(q, doc);
    expect(composed.finalMessage).toMatch(/^Hola, Arturo\./);
    expect(composed.finalMessage).toContain('*Volkswagen Beetle 2015*');
    expect(composed.finalMessage).toContain('Reparación y pintura Fascia delantera');
    expect(composed.finalMessage).toContain('$3,400');
    expect(composed.finalMessage).toContain('*Total: $3,400 MXN*');
    expect(composed.finalMessage).not.toMatch(/Daños identificados|Se observa|Buenas tardes/);
    expect(composed.finalMessage).toContain('https://maps.example/taller');
    expect(composed.finalMessage.match(/¿/g)).toHaveLength(1);
    expect(words(composed.finalMessage)).toBeLessThan(70);
    expect(JSON.stringify(q)).toBe(before);
  });

  it('2. tres piezas aparecen todas, sin el informe pericial', async () => {
    const q = quote({
      lines: [
        line({ quoteLineId: 'a', serviceType: 'REPARACION_PINTURA', amount: 4500, description: 'fascia' }),
        line({ quoteLineId: 'b', serviceType: 'REPARACION_PINTURA', amount: 3800, description: 'salpicadera' }),
        line({ quoteLineId: 'c', serviceType: 'REPARACION_PINTURA', amount: 3200, description: 'cofre' }),
      ],
    });
    const doc = peritaje({
      vehicle: beetle,
      damages: [
        damage('a', 'Fascia delantera', 'REPARAR'),
        damage('b', 'Salpicadera', 'REPARAR'),
        damage('c', 'Cofre', 'REPARAR'),
      ],
    });
    const composed = await render(q, doc);
    expect(composed.finalMessage).toContain('$4,500');
    expect(composed.finalMessage).toContain('$3,800');
    expect(composed.finalMessage).toContain('$3,200');
    expect(composed.finalMessage).toContain(formatQuoteMoney(q.total));
    expect(composed.finalMessage).not.toMatch(/dictamen|anclajes|Se observa/);
    expect(composed.finalMessage).toContain('https://maps.example/taller');
    expect(composed.finalMessage.match(/¿/g)).toHaveLength(1);
    expect(words(composed.finalMessage)).toBeLessThanOrEqual(110);
  });

  it('3. la refacción pendiente sigue visible y el total no la suma', async () => {
    const q = quote({
      lines: [
        line({ quoteLineId: 'paint', serviceType: 'REPARACION_PINTURA', amount: 3400 }),
        line({
          quoteLineId: 'part',
          serviceType: 'REFACCION',
          amount: 0,
          billable: false,
          pricingStatus: 'AWAITING_VEHICLE_DATA',
          pricingSource: 'AWAITING_VEHICLE_DATA',
          description: 'fascia delantera',
        }),
      ],
      isPartial: true,
      warnings: ['AWAITING_VEHICLE_DATA'],
      total: 3400,
      subtotal: 3400,
    });
    const doc = peritaje({
      vehicle: { ...beetle, year: '', displayLabel: 'Volkswagen Beetle' },
      damages: [damage('paint', 'Fascia delantera', 'REPARAR')],
    });
    const composed = await render(q, doc);
    expect(composed.finalMessage).not.toContain('*Volkswagen Beetle*');
    expect(composed.finalMessage).toContain('$3,400');
    expect(composed.finalMessage).toMatch(/Subtotal actual/);
    expect(composed.finalMessage).toMatch(/pendiente/i);
    expect(composed.finalMessage).not.toContain('$0');
    expect(q.total).toBe(3400);
    expect(questions(composed.finalMessage)).toHaveLength(1);
  });

  it('4. la incertidumbre de tratamiento se dice sin quitar el precio cobrable', async () => {
    const q = quote({
      lines: [
        line({
          quoteLineId: 'ql_cofre',
          damageItemId: 'ql_cofre',
          serviceType: 'REPARACION_PINTURA',
          amount: 2800,
          description: 'cofre',
        }),
        line({
          quoteLineId: 'ql_fascia',
          damageItemId: 'ql_fascia',
          serviceType: 'PENDIENTE',
          amount: 0,
          billable: false,
          description: 'fascia delantera',
        }),
      ],
      isPartial: true,
      warnings: ['PENDING_TREATMENT'],
      total: 2800,
      subtotal: 2800,
    });
    const doc = peritaje({
      vehicle: beetle,
      damages: [
        damage('ql_cofre', 'Cofre', 'REPARAR'),
        damage('ql_fascia', 'Fascia delantera', 'INCIERTO'),
      ],
    });
    const composed = await render(q, doc);
    expect(composed.finalMessage).toContain('$2,800');
    expect(composed.finalMessage).toMatch(/tratamiento de Fascia delantera queda por confirmar/);
    expect(composed.finalMessage).toMatch(/pendiente de revisi[oó]n/i);
    expect(composed.finalMessage).not.toMatch(/Se observa deformación/);
    expect(q.total).toBe(2800);
  });

  it('5. daños internos quedan en una sola advertencia breve', async () => {
    const q = quote({
      lines: [line({ quoteLineId: 'ql_fascia', serviceType: 'REPARACION_PINTURA', amount: 3400 })],
      warnings: ['HIDDEN_DAMAGE', 'POSSIBLE_SUBSTITUTION'],
    });
    const doc = peritaje({
      vehicle: beetle,
      damages: [damage('ql_fascia', 'Fascia delantera', 'REPARAR')],
    });
    const composed = await render(q, doc);
    expect(composed.finalMessage.match(/⚠️/g)).toHaveLength(1);
    expect(composed.finalMessage).toContain('Pueden existir daños internos');
    expect(composed.finalMessage).not.toMatch(/Por la magnitud|A reserva de revisión/);
    expect(composed.finalMessage).toContain('$3,400');
    expect(q.warnings).toEqual(['HIDDEN_DAMAGE', 'POSSIBLE_SUBSTITUTION']);
  });

  it('6. un vehículo sin identificar no se nombra', async () => {
    const q = quote({
      lines: [line({ quoteLineId: 'ql_fascia', serviceType: 'REPARACION_PINTURA', amount: 1500 })],
    });
    const doc = peritaje({
      vehicle: {
        vehicleId: 'veh_unknown',
        displayLabel: 'Vehículo no identificado',
        confidence: 'LOW',
        source: 'vision',
        confirmedByUser: false,
      },
      damages: [damage('ql_fascia', 'Fascia delantera', 'REPARAR')],
    });
    const composed = await render(q, doc);
    expect(composed.finalMessage).not.toMatch(/no identificado/i);
    expect(composed.finalMessage).toContain('$1,500');
    expect(composed.finalMessage).toMatch(/^Hola, Arturo\./);
  });

  it('7. los totales y las partidas no cambian al redactar', async () => {
    const q = quote({
      lines: [
        line({ quoteLineId: 'a', serviceType: 'REPARACION_PINTURA', amount: 4500 }),
        line({ quoteLineId: 'b', serviceType: 'MONTAJE_PINTURA', amount: 900 }),
      ],
      total: 5400,
      subtotal: 5400,
    });
    const snapshot = JSON.stringify(q);
    const doc = peritaje({
      vehicle: beetle,
      damages: [damage('a', 'Fascia delantera', 'REPARAR')],
    });
    const composed = await render(q, doc);
    expect(JSON.stringify(q)).toBe(snapshot);
    expect(q.schemaVersion).toBe('quote.v1');
    expect(composed.finalMessage).toContain('$4,500');
    expect(composed.finalMessage).toContain('$900');
    expect(composed.finalMessage).toContain('$5,400');
    expect(composed.financialBlock).toContain('$5,400');
  });

  it('8. no recorta partidas para cumplir el largo objetivo', async () => {
    const amounts = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800];
    const q = quote({
      lines: amounts.map((amount, index) =>
        line({
          quoteLineId: `ql_${index}`,
          serviceType: 'REPARACION_PINTURA',
          amount,
          description: `pieza ${index}`,
        }),
      ),
      warnings: ['HIDDEN_DAMAGE'],
    });
    const doc = peritaje({
      vehicle: beetle,
      damages: amounts.map((_, index) =>
        damage(
          `ql_${index}`,
          `Panel lateral trasero del costado derecho ${index}`,
          'REPARAR',
        ),
      ),
    });
    const composed = await render(q, doc);
    for (const amount of amounts) {
      expect(composed.finalMessage).toContain(formatQuoteMoney(amount));
    }
    expect(composed.finalMessage).toContain(formatQuoteMoney(q.total));
    expect(words(composed.finalMessage)).toBeGreaterThan(110);
  });
});
