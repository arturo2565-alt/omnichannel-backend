import { parseVehiclePartIdentity } from './parse-vehicle-part-identity';
import {
  listingYearCompatible,
  validateListingAgainstIdentity,
} from './validate-market-sample';
import { classifyRawHit } from './normalize-market-sample';
import { runRefaccionMarketPipeline } from './refaccion-market.orchestrator';
import {
  computeMarketRecallMetrics,
  collectMarketAuditsFromInventory,
} from './market-audit';
import { REFACCION_MARKET_EVENTS } from './refaccion-market-events';
import { DEFAULT_REFACCION_MARKET_POLICY } from './refaccion-market.types';
import { applyCustomerMargin } from './compute-market-range';
import type { RawProviderHit } from './refaccion-market.types';
import { collapseInventoryByPhysicalPanel } from '../piece-treatment';
import type { DetectedDamageItem } from '../entities/chat.entity';
import {
  PEG_CANONICAL_TRACE_ENV,
  PEG_CANONICAL_TRACE_PREFIX,
  CANONICAL_TRACE_EVENTS,
} from '../canonical-trace';
import { logRefaccionMarketEvent } from './refaccion-market-events';
import { sanitizeToolResultForLlm } from '../llm-tool-result-sanitize';

const altimaLeft = parseVehiclePartIdentity({
  vehiculoText: 'Nissan Altima 2014',
  pieza: 'Calavera_Izquierda',
});
const altimaRight = parseVehiclePartIdentity({
  vehiculoText: 'Nissan Altima 2014',
  pieza: 'Calavera_Derecha',
});

function hit(
  title: string,
  price?: number,
  opts?: Partial<RawProviderHit>,
): RawProviderHit {
  return {
    provider: opts?.provider ?? 'GOOGLE_WEB',
    title,
    ...(price != null ? { price } : {}),
    url: opts?.url ?? `https://shop.example/${encodeURIComponent(title)}`,
    snippet: opts?.snippet ?? title,
    condition: opts?.condition,
    externalId: opts?.externalId,
    query: 'calavera izquierda Nissan Altima 2014',
    retrievedAt: '2026-09-13T00:00:00.000Z',
    ...opts,
  };
}

const ACCEPTED_TITLES = [
  'Stop trasero izq Nissan Altima 2013-2018 $2,200',
  'Calavera izquierda Nissan Altima 2014 $2,450',
  'Stop izquierdo Nissan Altima 2014 aftermarket $2,100',
  'Calavera trasera izquierda Nissan Altima 2013 a 2018 $2,350',
] as const;

describe('invariantes de política (sin cambios)', () => {
  it('minValidSamples sigue 4 y el orden de part types no cambia', () => {
    expect(DEFAULT_REFACCION_MARKET_POLICY.minValidSamples).toBe(4);
    expect(DEFAULT_REFACCION_MARKET_POLICY.preferredPartTypes).toEqual([
      'AFTERMARKET_NEW',
      'UNKNOWN',
      'OEM_NEW',
      'OEM_USED',
    ]);
    expect(DEFAULT_REFACCION_MARKET_POLICY.marginFactor).toBe(1.3);
  });
});

describe('validación vehicular estricta + aliases', () => {
  it('rango 2013-2018 acepta 2014', () => {
    expect(
      listingYearCompatible(
        'Stop izquierdo Nissan Altima 2013-2018',
        '',
        '2014',
      ),
    ).toBe(true);
    expect(
      validateListingAgainstIdentity(
        'Stop izquierdo Nissan Altima 2013-2018 $2200',
        '',
        altimaLeft,
      ).ok,
    ).toBe(true);
  });

  it('Sentra no pasa para Altima', () => {
    const check = validateListingAgainstIdentity(
      'Calavera izquierda Nissan Sentra 2014 $2200',
      '',
      altimaLeft,
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('MODEL_MISMATCH');
  });

  it('listing sin marca/año suficientes no pasa', () => {
    const check = validateListingAgainstIdentity(
      'Calavera izquierda Altima $2200',
      '',
      altimaLeft,
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('MODEL_MISMATCH');
  });

  it('side contrario no pasa', () => {
    const check = validateListingAgainstIdentity(
      'Stop trasero der Nissan Altima 2013-2018 $2200',
      '',
      altimaLeft,
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('SIDE_MISMATCH');
  });

  it('listing sin side no se convierte en izquierda/derecha', () => {
    const check = validateListingAgainstIdentity(
      'Calavera Nissan Altima 2014 $2200',
      '',
      altimaLeft,
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('SIDE_MISSING');
  });
});

describe('pipeline Altima 2014 — recall comercial', () => {
  it('acepta stop/calavera izquierda y rechaza los fixtures inválidos', () => {
    const raw: RawProviderHit[] = [
      ...ACCEPTED_TITLES.map((title, i) =>
        hit(title, 2200 + i * 50, {
          url: `https://refac.mx/ok-${i}`,
          condition: 'NEW',
        }),
      ),
      hit('Calavera izquierda Nissan Sentra 2014 $2,200', 2200, {
        url: 'https://refac.mx/sentra',
      }),
      hit('Stop trasero der Nissan Altima 2013-2018 $2,200', 2200, {
        url: 'https://refac.mx/right',
      }),
      hit('Calavera Nissan Altima 2014 $2,200', 2200, {
        url: 'https://refac.mx/noside',
      }),
      hit('Calavera Altima $2,200', 2200, {
        url: 'https://refac.mx/vague',
      }),
      hit('Stop trasero izq Nissan Altima 2013-2018 precio MXN', undefined, {
        url: 'https://google.example/nprice',
        snippet: 'Stop trasero izq Nissan Altima 2013-2018 — comprar MXN',
      }),
      hit('Stop trasero izq Nissan Altima 2013-2018 $abc', 0, {
        url: 'https://refac.mx/badprice',
      }),
      hit('Stop trasero izq Nissan Altima 2013-2018 $2,200', 2200, {
        url: 'https://refac.mx/ok-0',
      }),
    ];

    const events: string[] = [];
    const estimate = runRefaccionMarketPipeline({
      identity: altimaLeft,
      rawHits: raw,
      providersUsed: ['GOOGLE_WEB', 'MERCADO_LIBRE'],
      emit: (event) => events.push(event),
      damageItemId: 'dmg_cal_izq',
    });

    expect(estimate.audit).toBeDefined();
    expect(estimate.audit!.pieceCode).toBe('Calavera_Izquierda');
    expect(estimate.audit!.family).toBe('CALAVERA');
    expect(estimate.audit!.rawResultCount).toBe(raw.length);
    expect(estimate.audit!.acceptedSampleCount).toBe(4);
    expect(estimate.audit!.sampleCount).toBeGreaterThanOrEqual(4);
    expect(estimate.pricingStatus).toBe('OK');
    expect(estimate.audit!.rejectedByReason.MODEL_MISMATCH).toBeGreaterThan(0);
    expect(estimate.audit!.rejectedByReason.SIDE_MISMATCH).toBe(1);
    expect(estimate.audit!.rejectedByReason.SIDE_MISSING).toBeGreaterThanOrEqual(
      1,
    );
    expect(estimate.audit!.rejectedByReason.PRICE_PARSE_FAILED).toBeGreaterThan(
      0,
    );
    expect(estimate.audit!.rejectedByReason.DUPLICATE).toBe(1);
    expect(events).toContain(REFACCION_MARKET_EVENTS.AUDIT);
    expect(JSON.stringify(estimate.audit)).not.toMatch(/Stop trasero izq Nissan Altima 2013-2018 \$2,200/);
  });

  it('Calavera_Derecha no acepta stop izquierdo', () => {
    const estimate = runRefaccionMarketPipeline({
      identity: altimaRight,
      rawHits: [
        hit('Stop trasero izq Nissan Altima 2013-2018 $2,200', 2200, {
          url: 'https://refac.mx/left-on-right',
        }),
        hit('Stop trasero derecho Nissan Altima 2013-2018 $2,200', 2200, {
          url: 'https://refac.mx/right-ok',
        }),
      ],
      providersUsed: ['GOOGLE_WEB'],
    });
    expect(estimate.audit!.rejectedByReason.SIDE_MISMATCH).toBe(1);
    expect(estimate.audit!.acceptedSampleCount).toBe(1);
    expect(estimate.pricingStatus).toBe('INSUFFICIENT_MARKET_SAMPLE');
  });

  it('2 samples válidas siguen INSUFFICIENT (minValidSamples=4)', () => {
    const estimate = runRefaccionMarketPipeline({
      identity: altimaLeft,
      rawHits: [
        hit('Stop izquierdo Nissan Altima 2014 $2,100', 2100, {
          url: 'https://a.mx/1',
        }),
        hit('Calavera izquierda Nissan Altima 2014 $2,200', 2200, {
          url: 'https://a.mx/2',
        }),
      ],
      providersUsed: ['GOOGLE_WEB'],
    });
    expect(estimate.audit!.acceptedSampleCount).toBe(2);
    expect(estimate.pricingStatus).toBe('INSUFFICIENT_MARKET_SAMPLE');
    expect(estimate.customerPriceRange).toBeUndefined();
    expect(estimate.marketPriceRange).toBeUndefined();
  });

  it('margen idéntico al helper; no se aplica dos veces', () => {
    const estimate = runRefaccionMarketPipeline({
      identity: altimaLeft,
      rawHits: ACCEPTED_TITLES.map((title, i) =>
        hit(title, 2200 + i * 80, {
          url: `https://refac.mx/m-${i}`,
          condition: 'NEW',
        }),
      ),
      providersUsed: ['GOOGLE_WEB'],
    });
    expect(estimate.customerPriceRange).toEqual(
      applyCustomerMargin(estimate.marketPriceRange!),
    );
  });
});

describe('clasificación PRICE_PARSE_FAILED / INVALID_PRICE', () => {
  it('texto comercial compatible sin precio → PRICE_PARSE_FAILED', () => {
    const classified = classifyRawHit(
      hit('Stop trasero izq Nissan Altima 2013-2018 — comprar MXN', undefined, {
        snippet: 'precio a consultar MXN',
      }),
      altimaLeft,
    );
    expect(classified.ok).toBe(false);
    if (!classified.ok) {
      expect(classified.reason).toBe('PRICE_PARSE_FAILED');
      expect(classified.compatible).toBe(true);
    }
  });

  it('compatible con price=0 → INVALID_PRICE', () => {
    const classified = classifyRawHit(
      hit('Stop trasero izq Nissan Altima 2013-2018', 0),
      altimaLeft,
    );
    expect(classified.ok).toBe(false);
    if (!classified.ok) {
      expect(classified.reason).toBe('INVALID_PRICE');
    }
  });
});

describe('harness de métricas + persistencia interna', () => {
  it('computeMarketRecallMetrics por familia', () => {
    const left = runRefaccionMarketPipeline({
      identity: altimaLeft,
      rawHits: [
        ...ACCEPTED_TITLES.map((title, i) =>
          hit(title, 2200 + i * 50, {
            url: `https://ok${i}.mx/cal-${i}`,
            condition: 'NEW',
          }),
        ),
        hit('Calavera izquierda Nissan Sentra 2014 $2,200', 2200, {
          url: 'https://bad.mx/sentra',
        }),
      ],
      providersUsed: ['GOOGLE_WEB'],
    });
    const metrics = computeMarketRecallMetrics([left.audit!]);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.family).toBe('CALAVERA');
    expect(metrics[0]!.acceptedSampleCount).toBe(4);
    expect(metrics[0]!.compatibleSampleCount).toBeGreaterThanOrEqual(4);
    expect(metrics[0]!.marketRawRecall).toBeGreaterThan(0);
    expect(metrics[0]!.rejectionRateByReason.MODEL_MISMATCH).toBeGreaterThan(0);
    expect(metrics[0]!.insufficientMarketRate).toBe(0);
  });

  it('collectMarketAuditsFromInventory no se expone al LLM', () => {
    const estimate = runRefaccionMarketPipeline({
      identity: altimaLeft,
      rawHits: ACCEPTED_TITLES.map((title, i) =>
        hit(title, 2200 + i * 50, { url: `https://ok.mx/${i}` }),
      ),
      providersUsed: ['GOOGLE_WEB'],
    });
    const inventory: DetectedDamageItem[] = [
      {
        pieza: 'Calavera_Izquierda',
        severidad: 'DMFuerte',
        descripcionTecnica: 'rota',
        urls_origen: ['https://cdn.example/izq.jpg'],
        marketAudit: estimate.audit,
      },
    ];
    expect(collectMarketAuditsFromInventory(inventory)).toHaveLength(1);
    const exposed = sanitizeToolResultForLlm(
      {
        success: true,
        quoteFlowMode: 'CANONICAL',
        marketAudit: estimate.audit,
        marketAudits: [estimate.audit],
        inventory,
      },
      { toolName: 'obtenerCotizacionExpress' },
    );
    expect(exposed.marketAudit).toBeUndefined();
    expect(exposed.marketAudits).toBeUndefined();
    expect(exposed.inventory).toBeUndefined();
  });
});

describe('side-drift — solo observabilidad', () => {
  it('izquierda y derecha no se fusionan; provenance se conserva', () => {
    const items: DetectedDamageItem[] = [
      {
        pieza: 'Calavera_Izquierda',
        severidad: 'DMFuerte',
        descripcionTecnica: 'calavera izq quebrada',
        urls_origen: ['https://cdn.example/foto-a.jpg'],
        visionBatchIndex: 0,
        visionBatchIndexes: [0],
        pieceCodeRaw: 'CAL_IZQ',
        pieceCodeCanonical: 'Calavera_Izquierda',
        vehicleId: 'veh_altima',
        physicalPanelKey: 'Calavera_Izquierda',
      },
      {
        pieza: 'Calavera_Derecha',
        severidad: 'DMFuerte',
        descripcionTecnica: 'calavera der quebrada',
        urls_origen: ['https://cdn.example/foto-b.jpg'],
        visionBatchIndex: 1,
        visionBatchIndexes: [1],
        pieceCodeRaw: 'CAL_DER',
        pieceCodeCanonical: 'Calavera_Derecha',
        vehicleId: 'veh_altima',
        physicalPanelKey: 'Calavera_Derecha',
      },
    ];
    const collapsed = collapseInventoryByPhysicalPanel(items);
    expect(collapsed).toHaveLength(2);
    const left = collapsed.find((i) => i.pieza === 'Calavera_Izquierda')!;
    const right = collapsed.find((i) => i.pieza === 'Calavera_Derecha')!;
    expect(left.visionBatchIndex).toBe(0);
    expect(right.visionBatchIndex).toBe(1);
    expect(left.urls_origen).toEqual(['https://cdn.example/foto-a.jpg']);
    expect(right.urls_origen).toEqual(['https://cdn.example/foto-b.jpg']);
    expect(left.pieceCodeRaw).toBe('CAL_IZQ');
    expect(right.pieceCodeRaw).toBe('CAL_DER');
    expect(left.pieceCodeCanonical).toBe('Calavera_Izquierda');
    expect(right.pieceCodeCanonical).toBe('Calavera_Derecha');
  });
});

describe('REFACCION_MARKET_AUDIT compacto', () => {
  afterEach(() => {
    delete process.env.PEG_TRACE_MODE;
    delete process.env.LOG_LEVEL;
    delete process.env.PEG_LOG_FORMAT;
    delete process.env[PEG_CANONICAL_TRACE_ENV];
    jest.restoreAllMocks();
  });

  it('emite counts/reasons, no listings raw ni JSON canónico', () => {
    process.env.PEG_TRACE_MODE = 'compact';
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'compact';
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map((a) => String(a)).join(' '));
    });
    runRefaccionMarketPipeline({
      identity: altimaLeft,
      rawHits: [
        hit('Stop trasero izq Nissan Altima 2013-2018 $2,200', 2200, {
          url: 'https://secret.example/listing-xyz',
        }),
        hit('Calavera izquierda Nissan Sentra 2014 $2,200', 2200, {
          url: 'https://secret.example/sentra',
        }),
      ],
      providersUsed: ['GOOGLE_WEB'],
      emit: logRefaccionMarketEvent,
    });
    const joined = logs.join('\n');
    expect(joined).not.toContain('audit=');
    expect(joined).not.toContain('accepted=');
    expect(joined).not.toContain('[MARKET]');
    expect(joined).not.toContain(PEG_CANONICAL_TRACE_PREFIX);
    expect(joined).not.toContain(CANONICAL_TRACE_EVENTS.REFACCION_MARKET_AUDIT);
    expect(joined).not.toContain('listing-xyz');
    expect(joined).not.toContain('https://secret.example');
    expect(joined).not.toContain('Stop trasero izq Nissan Altima 2013-2018');
    spy.mockRestore();
  });
});
