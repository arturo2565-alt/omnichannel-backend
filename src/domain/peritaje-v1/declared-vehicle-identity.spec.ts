import { QUOTE_SCHEMA_VERSION } from './types';
import type { CanonicalQuoteV1, QuoteLine } from './types';
import { buildVisionCanonicalShadow } from './shadow';
import { refaccionIdentityGaps } from './pending-quote-requirement';
import { derivePartialQuoteReasons } from './quote-narrative';
import { renderDeterministicCta } from '../../chat/client-message-ux';
import type { ClientQuoteMessageContext } from '../../chat/client-message-ux';
import {
  applyDeclaredVehicleIdentity,
  extractDeclaredVehicleIdentity,
  extractLatestDeclaredVehicleIdentity,
} from './declared-vehicle-identity';
import { vehicleIdentityFromLegacyLabel } from './from-legacy';
import { reusePriorVehicleIdentity } from './vehicle-identity-enrich';
import type { LegacyDetectedDamageShape } from './from-legacy';

const NOW = '2026-11-02T22:57:46.000Z';

function fascia(): LegacyDetectedDamageShape {
  return {
    pieza: 'FD',
    severidad: 'DMFuerte',
    descripcionTecnica: 'Fascia delantera con daño severo',
    urls_origen: ['https://cdn.example/1.jpg'],
    vehiculoDetectado: 'Volkswagen Beetle 2015',
    tratamiento: 'SUSTITUIR',
    posibleReemplazoRefaccion: true,
  };
}

function shadow(input: {
  declaredText?: string;
  vision?: string;
  prior?: ReturnType<typeof buildVisionCanonicalShadow>;
}) {
  const declared = input.declaredText
    ? extractDeclaredVehicleIdentity(input.declaredText)
    : null;
  return buildVisionCanonicalShadow({
    conversationId: 'e68fef30',
    incomingInventory: [fascia()],
    visionVehicleLabel: input.vision ?? 'Volkswagen Beetle 2015',
    declaredVehicle: declared,
    priorCanonical: input.prior,
    now: NOW,
  });
}

function cta(doc: ReturnType<typeof buildVisionCanonicalShadow>): string {
  const vehicle = doc.vehicles[0]!;
  const gaps = refaccionIdentityGaps(vehicle);
  const ctx: ClientQuoteMessageContext = {
    mode: 'INITIAL_QUOTE',
    shouldGreet: true,
    vehicleLabel: vehicle.displayLabel,
    vehicleMake: vehicle.make,
    vehicleModel: vehicle.model,
    vehicleYear: vehicle.year,
    customerName: 'Cliente',
    quote: awaitingQuote(),
    quoteDelta: {
      addedLines: [],
      updatedLines: [],
      removedLines: [],
      unchangedLineIds: [],
      totalBefore: null,
      totalAfter: 3400,
      isPartialBefore: null,
      isPartialAfter: true,
      becameComplete: false,
      becamePartial: false,
    },
    changedLines: [],
    warnings: ['AWAITING_VEHICLE_DATA'],
    ctaType: 'ASK_MISSING_VEHICLE_DATA',
    becameComplete: false,
    technicalExplanation: 'omitted',
    shouldShareLocation: false,
    missingVehicleFields: gaps.missingFields,
    confirmationVehicleFields: gaps.confirmationFields,
  };
  return renderDeterministicCta({ ctx, hasActiveAppointment: false });
}

function line(partial: Partial<QuoteLine> & Pick<QuoteLine, 'serviceType' | 'amount'>): QuoteLine {
  return {
    quoteLineId: partial.quoteLineId ?? `ql_${partial.serviceType}`,
    damageItemId: partial.damageItemId ?? 'dmg_fascia',
    vehicleId: partial.vehicleId ?? 'veh_1',
    description: partial.description ?? 'fascia',
    billable: partial.billable ?? partial.amount > 0,
    confidence: 'HIGH',
    ...partial,
  };
}

function awaitingQuote(): CanonicalQuoteV1 {
  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    quoteId: 'q_beetle',
    peritajeId: 'per_beetle',
    subtotal: 3400,
    total: 3400,
    isPartial: true,
    warnings: ['AWAITING_VEHICLE_DATA'],
    generatedAt: NOW,
    lines: [
      line({
        serviceType: 'REPARACION_PINTURA',
        amount: 3400,
        billable: true,
        pricingStatus: 'OK',
        pricingSource: 'AUTOFIX_CATALOG',
      }),
      line({
        quoteLineId: 'ql_ref',
        serviceType: 'REFACCION',
        amount: 0,
        billable: false,
        pricingStatus: 'AWAITING_VEHICLE_DATA',
        pricingSource: 'AWAITING_VEHICLE_DATA',
      }),
    ],
  };
}

describe('IDENTITY-001 declaración del cliente', () => {
  it('1. fotos y después «Es un Beetle 2015» dejan modelo y año declarados', () => {
    const doc = shadow({ declaredText: 'Es un Beetle 2015' });
    const vehicle = doc.vehicles[0]!;
    expect(vehicle.make).toBe('Volkswagen');
    expect(vehicle.model).toBe('Beetle');
    expect(vehicle.year).toBe('2015');
    expect(vehicle.confirmedFields).toEqual(expect.arrayContaining(['model', 'year']));
    expect(vehicle.confirmedFields).not.toContain('make');
    expect(vehicle.confirmedByUser).toBe(false);
    expect(refaccionIdentityGaps(vehicle).readyForMarket).toBe(false);
    expect(cta(doc)).toBe('¿Confirmas que la marca es *Volkswagen*?');
    expect(cta(doc)).not.toMatch(/modelo y año/i);
  });

  it('2. «Es un Beetle 2015» antes de las fotos usa la misma declaración', () => {
    const declared = extractLatestDeclaredVehicleIdentity([
      'Es un Beetle 2015',
      'data:image/jpeg;base64,AAAA',
    ]);
    const doc = shadow({ declaredText: 'Es un Beetle 2015' });
    expect(declared?.model).toBe('Beetle');
    expect(declared?.year).toBe('2015');
    expect(doc.vehicles[0]!.confirmedFields).toEqual(
      expect.arrayContaining(['model', 'year']),
    );
    expect(refaccionIdentityGaps(doc.vehicles[0]).readyForMarket).toBe(false);
  });

  it('3. solo fotos piden confirmar la identidad inferida', () => {
    const doc = shadow({});
    const vehicle = doc.vehicles[0]!;
    expect(vehicle.source).toBe('vision');
    expect(vehicle.confirmedByUser).toBe(false);
    expect(vehicle.confirmedFields ?? []).toEqual([]);
    expect(refaccionIdentityGaps(vehicle)).toMatchObject({
      missingFields: [],
      confirmationFields: ['make', 'model', 'year'],
      readyForMarket: false,
    });
    expect(cta(doc)).toBe('¿Confirmas que es un *Volkswagen Beetle 2015*?');
  });

  it('4. «No es 2015, es 2017» corrige el año declarado', () => {
    const first = shadow({
      declaredText: 'Buenas tardes quiero arreglar mi Beetle 2015',
    });
    const corrected = shadow({
      prior: first,
      declaredText: 'No es 2015, es 2017',
    });
    const vehicle = corrected.vehicles[0]!;
    expect(vehicle.year).toBe('2017');
    expect(vehicle.model).toBe('Beetle');
    expect(vehicle.confirmedFields).toEqual(expect.arrayContaining(['year', 'model']));
    expect(vehicle.confirmedByUser).toBe(false);
    expect(vehicle.vehicleId).toBe(first.vehicles[0]!.vehicleId);
    expect(refaccionIdentityGaps(vehicle).readyForMarket).toBe(false);
  });

  it('5. una visión posterior no pisa el modelo ni el año declarados', () => {
    const declared = shadow({
      declaredText: 'Buenas tardes quiero arreglar mi Beetle 2015',
    });
    const contradicted = shadow({
      prior: declared,
      vision: 'Nissan Versa 2018',
    });
    const vehicle = contradicted.vehicles[0]!;
    expect(vehicle.make).toBe('Volkswagen');
    expect(vehicle.model).toBe('Beetle');
    expect(vehicle.year).toBe('2015');
    expect(vehicle.confirmedByUser).toBe(false);
    expect(refaccionIdentityGaps(vehicle).readyForMarket).toBe(false);
  });

  it('6. el mismo texto repetido produce una sola declaración', () => {
    const sentence = 'Buenas tardes quiero arreglar mi Beetle 2015';
    const once = extractDeclaredVehicleIdentity(sentence);
    const twice = extractLatestDeclaredVehicleIdentity([sentence, sentence]);
    expect(twice).toEqual(once);
    expect(once).toMatchObject({
      model: 'Beetle',
      year: '2015',
      declaredFields: ['model', 'year'],
      correctsYear: false,
    });
  });

  it('7. la pregunta de identidad no altera la cotización parcial', () => {
    const doc = shadow({ declaredText: 'Es un Beetle 2015' });
    const quote = awaitingQuote();
    quote.lines[1]!.vehicleId = doc.vehicles[0]!.vehicleId;
    const before = JSON.stringify(quote);
    const reasons = derivePartialQuoteReasons(quote, doc);
    expect(reasons.map((reason) => reason.text).join(' ')).toMatch(/marca es Volkswagen/);
    expect(quote.schemaVersion).toBe('quote.v1');
    expect(quote.total).toBe(3400);
    expect(quote.lines.map((row) => row.amount)).toEqual([3400, 0]);
    expect(JSON.stringify(quote)).toBe(before);
    expect(cta(doc)).not.toMatch(/modelo y año/i);
  });

  it('marca, modelo y año declarados juntos sí confirman la identidad', () => {
    const doc = shadow({ declaredText: 'Es un Volkswagen Beetle 2015' });
    const vehicle = doc.vehicles[0]!;
    expect(vehicle.confirmedByUser).toBe(true);
    expect(vehicle.source).toBe('user');
    expect(refaccionIdentityGaps(vehicle).readyForMarket).toBe(true);
  });

  it('la pregunta comercial no sustituye un modelo numérico declarado', () => {
    const declared = extractDeclaredVehicleIdentity(
      'Cuanto me sale este golpe? Mazda 2 2024',
    );
    expect(declared).toMatchObject({
      make: 'Mazda',
      model: '2',
      year: '2024',
      declaredFields: ['make', 'model', 'year'],
    });
    expect(
      extractDeclaredVehicleIdentity('¿Cuánto cuesta este golpe? Audi A4 2019'),
    ).toMatchObject({ make: 'Audi', model: 'A4', year: '2019' });
    const declaredVehicle = applyDeclaredVehicleIdentity(
      vehicleIdentityFromLegacyLabel('Hyundai Grand i10', { source: 'vision' }),
      declared!,
    );
    expect(declaredVehicle).toMatchObject({
      make: 'Mazda',
      model: '2',
      year: '2024',
      displayLabel: 'Mazda 2 2024',
      source: 'user',
    });
    const later = reusePriorVehicleIdentity(
      declaredVehicle,
      vehicleIdentityFromLegacyLabel('Nissan Versa 2018', { source: 'vision' }),
    );
    expect(later.make).toBe('Mazda');
    expect(later.model).toBe('2');
    expect(later.year).toBe('2024');
    const doc = shadow({
      declaredText: 'Cuanto me sale este golpe? Mazda 2 2024',
      vision: 'Hyundai Grand i10',
    });
    expect(doc.vehicles.map((vehicle) => vehicle.displayLabel).join(' ')).not.toMatch(
      /cuanto/i,
    );
  });
});
