import { recoverVisionEvidenceForPeritaje } from './vision-evidence';
import { buildVisionShadowSafe } from './canonical-shadow-write';
import { resolveAuthoritativeDraftFinance } from './canonical-quote-engine';
import { composeModernClientQuoteMessage } from './canonical-quote-narrative';
import { enrichInventoryWithMarketRefacciones } from './refaccion-market/enrich-inventory-with-market';
import { applyCustomerMargin } from './refaccion-market/compute-market-range';
import { logRefaccionMarketEvent } from './refaccion-market/refaccion-market-events';
import { canonicalPhysicalPanelKey } from './piece-treatment';
import { peritajeFromLegacyAnalysis } from '../domain/peritaje-v1';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import type { DraftQuote } from './autofix-config';
import type { RefaccionMarketEstimate, VehiclePartIdentity } from './refaccion-market/refaccion-market.types';
import {
  CANONICAL_TRACE_EVENTS,
  PEG_CANONICAL_TRACE_ENV,
  PEG_CANONICAL_TRACE_PREFIX,
  isPegCanonicalTraceEnabled,
  pegCanonicalTrace,
  redactEvidenceRefForTrace,
  runWithCanonicalTraceContext,
  sanitizeTracePayload,
} from './canonical-trace';

const SIGNED_PHOTO =
  'https://cdn.example/signed/lado-derecho.jpg?X-Amz-Signature=SECRET123&token=abc';
const PHONE = '+525512345678';

function enableTrace() {
  process.env[PEG_CANONICAL_TRACE_ENV] = 'true';
}

function disableTrace() {
  delete process.env[PEG_CANONICAL_TRACE_ENV];
}

function capturePegLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((...args) => {
    const line = args.map((a) => String(a)).join(' ');
    if (line.includes(PEG_CANONICAL_TRACE_PREFIX)) logs.push(line);
  });
  return {
    logs,
    restore: () => spy.mockRestore(),
  };
}

function item(
  overrides: Partial<DetectedDamageItem> & Pick<DetectedDamageItem, 'pieza'>,
): DetectedDamageItem {
  return {
    severidad: 'DM',
    descripcionTecnica: 'golpe',
    urls_origen: [SIGNED_PHOTO],
    vehiculoDetectado: 'Mazda 3 2020',
    ...overrides,
  };
}

function snap(): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: () => 3250,
    getAmount: () => 3250,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DL', 'DM', 'BASE', 'Mediano'],
    serviciosOrderedLongestFirst: ['Fascia', 'PTD', 'STD'],
  } as MatrixPricingSnapshot;
}

function emptyDraft(): DraftQuote {
  return {
    status: 'PENDING_APPROVAL',
    currency: 'MXN',
    reference: 'COT-AF-TEST',
    generatedAt: '2026-09-11T00:00:00.000Z',
    lines: [],
    subtotal: 0,
    total: 0,
    formalNarrative: 'Estimado cliente,',
    analysisBasis: {
      pieza: 'x',
      severidad: 'DM',
      partesAfectadas: [],
      severidadDelDano: 'DM',
      descripcionTecnica: '',
      justificacion: '',
    },
  };
}

function readyEstimate(
  identity: VehiclePartIdentity,
  central = 10000,
): RefaccionMarketEstimate {
  const market = {
    precioMinEstimado: 9000,
    precioMaxEstimado: 11000,
    precioCentral: central,
  };
  return {
    pricingType: 'RANGE',
    pricingStatus: 'OK',
    marketPriceRange: market,
    customerPriceRange: applyCustomerMargin(market),
    cantidadMuestras: 5,
    cantidadDominios: 3,
    providersUsed: ['GOOGLE_WEB'],
    priceSource: 'WEB_MARKET_ESTIMATE',
    confidence: 'MEDIUM',
    partTypeGroup: 'AFTERMARKET_NEW',
    samples: [],
    identity,
    query: identity.piezaLabel,
  };
}

describe('PEG_CANONICAL_TRACE', () => {
  const prev = process.env[PEG_CANONICAL_TRACE_ENV];

  afterEach(() => {
    if (prev == null) delete process.env[PEG_CANONICAL_TRACE_ENV];
    else process.env[PEG_CANONICAL_TRACE_ENV] = prev;
    jest.restoreAllMocks();
  });

  it('flag apagado → no emite trace', () => {
    disableTrace();
    expect(isPegCanonicalTraceEnabled()).toBe(false);
    const { logs, restore } = capturePegLogs();
    pegCanonicalTrace(CANONICAL_TRACE_EVENTS.VEHICLE_IDENTITY, {
      make: 'Mazda',
      phone: PHONE,
    });
    recoverVisionEvidenceForPeritaje(
      [item({ pieza: 'STD', urls_origen: [] })],
      [SIGNED_PHOTO],
      { conversationId: 'c1' },
    );
    expect(logs).toEqual([]);
    restore();
  });

  it('flag encendido → emite VehicleIdentity, DamageItem y CanonicalQuote', () => {
    enableTrace();
    const { logs, restore } = capturePegLogs();
    const inventory = [
      item({
        pieza: 'PTD',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
      }),
    ];
    runWithCanonicalTraceContext(
      {
        conversationId: 'conv_trace',
        draftQuoteId: 'dq_trace',
        visionRunId: 'vis_trace',
        caseId: 'case_trace',
      },
      () => {
        const peritaje = buildVisionShadowSafe({
          conversationId: 'conv_trace',
          incomingInventory: inventory,
          visionVehicleLabel: 'Mazda 3 2020',
        });
        expect(peritaje).toBeTruthy();
        const finance = resolveAuthoritativeDraftFinance({
          peritaje,
          pricedInventory: inventory,
          snap: snap(),
          priorDraft: emptyDraft(),
          legacyDraft: emptyDraft(),
          legacyEstimate: 1,
          conversationId: 'conv_trace',
        });
        expect(finance.mode).toBe('canonical');
      },
    );
    const joined = logs.join('\n');
    expect(joined).toContain(CANONICAL_TRACE_EVENTS.VEHICLE_IDENTITY);
    expect(joined).toContain(CANONICAL_TRACE_EVENTS.DAMAGE_ITEM);
    expect(joined).toContain(CANONICAL_TRACE_EVENTS.CANONICAL_QUOTE);
    expect(joined).toContain(CANONICAL_TRACE_EVENTS.QUOTE_FLOW_MODE);
    expect(joined).toContain('"mode":"CANONICAL"');
    expect(joined).toContain('source');
    restore();
  });

  it('no imprime URL completa de evidence ni teléfono', () => {
    enableTrace();
    const { logs, restore } = capturePegLogs();
    runWithCanonicalTraceContext({ conversationId: 'conv_pii' }, () => {
      pegCanonicalTrace(CANONICAL_TRACE_EVENTS.VEHICLE_IDENTITY, {
        make: 'Mazda',
        phone: PHONE,
        contactName: 'Juan Pérez',
        evidenceUrl: SIGNED_PHOTO,
      });
      recoverVisionEvidenceForPeritaje(
        [item({ pieza: 'STD', urls_origen: [] })],
        [SIGNED_PHOTO],
        { conversationId: 'conv_pii' },
      );
      buildVisionShadowSafe({
        conversationId: 'conv_pii',
        incomingInventory: [
          item({
            pieza: 'STD',
            urls_origen: [SIGNED_PHOTO],
            tratamiento: 'REPARAR',
            treatmentSource: 'vision',
          }),
        ],
        visionVehicleLabel: 'Mazda 3 2020',
      });
    });
    const joined = logs.join('\n');
    expect(joined).not.toContain(SIGNED_PHOTO);
    expect(joined).not.toContain('SECRET123');
    expect(joined).not.toContain(PHONE);
    expect(joined).not.toContain('5512345678');
    expect(joined).not.toContain('Juan Pérez');
    expect(joined).toContain(CANONICAL_TRACE_EVENTS.EVIDENCE_RECOVERED_SINGLE_INPUT);
    expect(redactEvidenceRefForTrace(SIGNED_PHOTO)).toBe(
      'cdn.example/lado-derecho.jpg',
    );
    restore();
  });

  it('SUSTITUIR emite market trace', async () => {
    enableTrace();
    const { logs, restore } = capturePegLogs();
    await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Cofre',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Cofre'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 3 2020',
        inventory: [
          item({
            pieza: 'Cofre',
            tratamiento: 'SUSTITUIR',
            damageItemId: 'dmg_cofre_test',
            vehiculoDetectado: 'Mazda 3 2020',
          }),
        ],
      },
      {
        estimate: async (identity) => readyEstimate(identity),
      } as never,
    );
    const joined = logs.join('\n');
    expect(joined).toContain(
      CANONICAL_TRACE_EVENTS.REFACCION_MARKET_SEARCH_STARTED,
    );
    expect(joined).toContain(
      CANONICAL_TRACE_EVENTS.REFACCION_MARKET_ESTIMATE_READY,
    );
    expect(joined).toContain('dmg_cofre_test');
    expect(joined).not.toContain('https://');
    restore();
  });

  it('correlation IDs se mantienen cuando existen', () => {
    enableTrace();
    const { logs, restore } = capturePegLogs();
    runWithCanonicalTraceContext(
      {
        conversationId: 'conv_corr',
        draftQuoteId: 'dq_corr',
        peritajeId: 'per_corr',
        visionRunId: 'vis_corr',
        caseId: 'case_corr',
        vehicleId: 'veh_corr',
      },
      () => {
        pegCanonicalTrace(CANONICAL_TRACE_EVENTS.VEHICLE_IDENTITY, {
          make: 'Mazda',
          source: 'vision',
        });
      },
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('conv_corr');
    expect(logs[0]).toContain('dq_corr');
    expect(logs[0]).toContain('per_corr');
    expect(logs[0]).toContain('vis_corr');
    expect(logs[0]).toContain('case_corr');
    expect(logs[0]).toContain('veh_corr');
    restore();
  });

  it('sanitizeTracePayload elimina PII y redacta URLs', () => {
    const sanitized = sanitizeTracePayload({
      phone: PHONE,
      contactName: 'Ana López',
      jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb',
      url: SIGNED_PHOTO,
      make: 'Mazda',
    }) as Record<string, unknown>;
    expect(sanitized.phone).toBeUndefined();
    expect(sanitized.contactName).toBeUndefined();
    expect(sanitized.jwt).toBeUndefined();
    expect(String(sanitized.url)).not.toContain('SECRET123');
    expect(sanitized.make).toBe('Mazda');
  });

  it('mensaje final solo resume, no imprime el texto del cliente', async () => {
    enableTrace();
    const { logs, restore } = capturePegLogs();
    const peritaje = peritajeFromLegacyAnalysis({
      conversationId: 'c1',
      tallerId: 't1',
      peritajeId: 'per_narr',
      now: '2026-09-11T00:00:00.000Z',
      canonicalizePanel: canonicalPhysicalPanelKey,
      analysis: {
        vehiculoDetectado: 'Mazda 3 2020',
        inventory: [
          item({
            pieza: 'PTD',
            tratamiento: 'REPARAR',
            treatmentSource: 'vision',
          }),
        ],
      },
    });
    await composeModernClientQuoteMessage({
      canonicalQuote: {
        schemaVersion: 'quote.v1',
        quoteId: 'quo_trace',
        peritajeId: peritaje.peritajeId,
        lines: [
          {
            quoteLineId: 'ql_1',
            damageItemId: peritaje.damages[0]!.damageItemId,
            vehicleId: peritaje.vehicles[0]!.vehicleId,
            serviceType: 'REPARACION_PINTURA',
            description: 'PTD',
            billable: true,
            amount: 3250,
            confidence: 'HIGH',
          },
        ],
        subtotal: 3250,
        total: 3250,
        isPartial: false,
        warnings: [],
        generatedAt: '2026-09-11T00:00:00.000Z',
      },
      peritaje,
      contactName: 'Juan Pérez',
      hasActiveAppointment: false,
      llmParts: {
        intro: 'Hola Juan, revisamos las fotos.',
        technicalExplanation: 'La puerta tiene un golpe.',
        cta: '¿Agendamos?',
      },
    });
    const joined = logs.join('\n');
    expect(joined).toContain(
      CANONICAL_TRACE_EVENTS.FINAL_CLIENT_MESSAGE_SUMMARY,
    );
    expect(joined).not.toContain('Hola Juan');
    expect(joined).not.toContain('Juan Pérez');
    restore();
  });

  it('logRefaccionMarketEvent insuficiente sigue siendo observable', () => {
    enableTrace();
    const { logs, restore } = capturePegLogs();
    logRefaccionMarketEvent('REFACCION_MARKET_INSUFFICIENT', {
      pieza: 'STD',
      damageItemId: 'dmg_std',
      marca: 'Mazda',
      modelo: '3',
      anio: '2020',
    });
    expect(logs.join('\n')).toContain(
      CANONICAL_TRACE_EVENTS.REFACCION_MARKET_INSUFFICIENT,
    );
    restore();
  });
});
