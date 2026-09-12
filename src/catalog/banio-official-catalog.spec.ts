import {
  BANIO_OFFICIAL_BASE_MXN,
  BANIO_SERVICE_IDENTITIES,
  lookupBanioCatalogBase,
  officialBanioCatalogSnap,
} from './banio-service-identity';
import { INSTANT_QUOTE_MATRIX_SEED_ROWS } from './instant-quote-matrix-seed.data';
import { computeCatalogIntegralPrice } from './catalog-pricing-rules';
import { resolveIntegralPriceForVehicleProfile } from './vehicle-integral-pricing';
import { resolveBanioCodeUnitPrice } from './vehicle-piece-pricing';
import { buildObtenerCotizacionExpressPayload } from '../chat/autopilot-cotizacion-express';
import { buildCanonicalQuoteV1 } from '../chat/canonical-quote-engine';
import { peritajeFromLegacyAnalysis } from '../domain/peritaje-v1';
import { isBanioPinturaCompletoVisionInventory } from '../chat/vision-bpc-inventory';
import { resolveVehiclePricingProfile } from './vehicle-pricing-profile';
import { buildPreliveReadinessReport } from '../certification/autonomy/prelive-readiness';
import { createVehicleId } from '../domain/peritaje-v1';

const SIZE_TIERS = ['Compacto', 'Mediano', 'Grande', 'XL'] as const;

function profile(sizeTier: (typeof SIZE_TIERS)[number], isPremium = false) {
  return resolveVehiclePricingProfile({
    modeloVehiculo: 'Cliente',
    sizeTier,
    isPremium,
    tierSource: 'operador',
  });
}

describe('catálogo oficial BPE / BPEI / BPCC', () => {
  const snap = officialBanioCatalogSnap();

  it('BPE base = 28000', () => {
    expect(BANIO_OFFICIAL_BASE_MXN.BPE).toBe(28000);
    expect(lookupBanioCatalogBase(snap, 'BPE').basePrice).toBe(28000);
    expect(lookupBanioCatalogBase(snap, 'BPE').status).toBe('READY');
  });

  it('BPEI base = 32000', () => {
    expect(BANIO_OFFICIAL_BASE_MXN.BPEI).toBe(32000);
    expect(lookupBanioCatalogBase(snap, 'BPEI').basePrice).toBe(32000);
    expect(lookupBanioCatalogBase(snap, 'BPEI').status).toBe('READY');
  });

  it('BPCC base = 39000', () => {
    expect(BANIO_OFFICIAL_BASE_MXN.BPCC).toBe(39000);
    expect(lookupBanioCatalogBase(snap, 'BPCC').basePrice).toBe(39000);
    expect(lookupBanioCatalogBase(snap, 'BPCC').status).toBe('READY');
  });

  it('BPEI no usa +15% hardcoded', () => {
    const mediano = resolveIntegralPriceForVehicleProfile(
      snap,
      'Baño de Pintura Exterior e Interiores',
      profile('Mediano'),
    );
    const plus15 = Math.round((28000 * 1.15) / 50) * 50;
    expect(mediano?.basePrice).toBe(32000);
    expect(mediano?.unitPrice).not.toBe(plus15);
    expect(mediano?.unitPrice).not.toBe(
      resolveBanioCodeUnitPrice(28000, 'BPEI', 'Mediano'),
    );
  });

  it('BPCC no usa $8k/$10k', () => {
    const compacto = resolveIntegralPriceForVehicleProfile(
      snap,
      'Baño de Pintura con Cambio de Color',
      profile('Compacto'),
    );
    expect(compacto?.unitPrice).toBe(39000);
    expect(compacto?.unitPrice).not.toBe(28000 + 8000);
    expect(compacto?.unitPrice).not.toBe(28000 + 10000);
  });

  it('BPCC CANONICAL no usa resolveBanioCodeUnitPrice legacy', () => {
    const modern = resolveIntegralPriceForVehicleProfile(
      snap,
      'Baño de Pintura con Cambio de Color',
      profile('Mediano'),
    );
    const legacy = resolveBanioCodeUnitPrice(20_000, 'BPCC', 'Mediano');
    expect(legacy).toBe(31_000);
    expect(modern?.unitPrice).not.toBe(legacy);
    expect(modern?.basePrice).toBe(39000);
  });

  it('los tres usan el multiplicador de tamaño existente', () => {
    for (const code of ['BPE', 'BPEI', 'BPCC'] as const) {
      const name = BANIO_SERVICE_IDENTITIES.find((i) => i.code === code)!
        .catalogName;
      const base = BANIO_OFFICIAL_BASE_MXN[code];
      for (const size of SIZE_TIERS) {
        const resolved = resolveIntegralPriceForVehicleProfile(
          snap,
          name,
          profile(size),
        );
        const expected = computeCatalogIntegralPrice({
          basePrice: base,
          sizeTier: size,
          isPremium: false,
        });
        expect(resolved?.unitPrice).toBe(expected);
      }
    }
  });

  it('los tres usan el factor premium existente', () => {
    for (const code of ['BPE', 'BPEI', 'BPCC'] as const) {
      const name = BANIO_SERVICE_IDENTITIES.find((i) => i.code === code)!
        .catalogName;
      const base = BANIO_OFFICIAL_BASE_MXN[code];
      const std = resolveIntegralPriceForVehicleProfile(
        snap,
        name,
        profile('Mediano', false),
      );
      const prem = resolveIntegralPriceForVehicleProfile(
        snap,
        name,
        profile('Mediano', true),
      );
      const expectedPrem = computeCatalogIntegralPrice({
        basePrice: base,
        sizeTier: 'Mediano',
        isPremium: true,
      });
      expect(prem?.unitPrice).toBe(expectedPrem);
      expect(prem?.unitPrice).toBeGreaterThan(std?.unitPrice ?? 0);
    }
  });

  it('cada código persiste por separado en el seed', () => {
    const banios = INSTANT_QUOTE_MATRIX_SEED_ROWS.filter((r) =>
      r.servicio.startsWith('Baño de Pintura'),
    );
    expect(banios.map((r) => r.servicio).sort()).toEqual(
      [
        'Baño de Pintura Exterior',
        'Baño de Pintura Exterior e Interiores',
        'Baño de Pintura con Cambio de Color',
      ].sort(),
    );
    expect(new Set(banios.map((r) => r.precio)).size).toBe(3);
    expect(banios.find((r) => r.precio === 28000)?.servicio).toBe(
      'Baño de Pintura Exterior',
    );
    expect(banios.find((r) => r.precio === 32000)?.servicio).toBe(
      'Baño de Pintura Exterior e Interiores',
    );
    expect(banios.find((r) => r.precio === 39000)?.servicio).toBe(
      'Baño de Pintura con Cambio de Color',
    );
  });

  it('express selecciona el código correcto', () => {
    const compacto = profile('Compacto');
    const bpe = buildObtenerCotizacionExpressPayload(snap, ['BPE'], compacto);
    const bpei = buildObtenerCotizacionExpressPayload(snap, ['BPEI'], compacto);
    const bpcc = buildObtenerCotizacionExpressPayload(snap, ['BPCC'], compacto);
    expect(bpe.success).toBe(true);
    expect(bpei.success).toBe(true);
    expect(bpcc.success).toBe(true);
    expect(bpe.lines?.[0]?.canonical).toBe('Baño de Pintura Exterior');
    expect(bpei.lines?.[0]?.canonical).toBe(
      'Baño de Pintura Exterior e Interiores',
    );
    expect(bpcc.lines?.[0]?.canonical).toBe(
      'Baño de Pintura con Cambio de Color',
    );
    expect(bpe.totalMx).toBe(28000);
    expect(bpei.totalMx).toBe(32000);
    expect(bpcc.totalMx).toBe(39000);
  });

  it('CanonicalQuote selecciona el código correcto', () => {
    const veh = createVehicleId({ raw: 'Mazda 3 2020' });
    for (const code of ['BPE', 'BPEI', 'BPCC'] as const) {
      const inv = [
        {
          pieza: code,
          severidad: 'Mediano',
          descripcionTecnica: code,
          tratamiento: 'REPARAR' as const,
          treatmentSource: 'vision' as const,
          vehiculoDetectado: 'Mazda 3 2020',
          vehicleId: veh,
        },
      ];
      expect(isBanioPinturaCompletoVisionInventory(inv)).toBe(true);
      const peritaje = peritajeFromLegacyAnalysis({
        analysis: { inventory: inv, vehiculoDetectado: 'Mazda 3 2020' },
        conversationId: `q-${code}`,
        canonicalizePanel: (raw) => raw,
      });
      const built = buildCanonicalQuoteV1({
        peritaje,
        pricedInventory: inv,
        snap,
        vehicleProfile: profile('Compacto'),
      });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(built.quote.lines[0]?.description).toContain(code);
      expect(built.quote.total).toBe(BANIO_OFFICIAL_BASE_MXN[code]);
    }
  });

  it('PRODUCT_DECISION_REQUIRED_BPCC ya no está pending', () => {
    const report = buildPreliveReadinessReport({ snap });
    expect(report.productDecisions.BPCC).toBe('resolved');
    expect(report.services.BPE).toBe('READY');
    expect(report.services.BPEI).toBe('READY');
    expect(report.services.BPCC).toBe('READY');
    expect(report.verdict).toBe('READY_FOR_PROMPT_V2');
  });
});
