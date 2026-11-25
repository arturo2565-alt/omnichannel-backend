import { APPROVED_CATALOG_KEYS } from './staging-catalog-import';
import { createMatrixPricingSnapshot } from './matrix-pricing-snapshot';
import type { PriceMatrix } from './entities/price-matrix.entity';
import {
  computeCatalogPiecePrice,
  isPieceBaseSeverity,
} from './catalog-pricing-rules';
import { resolvePiecePriceForVehicleProfile } from './vehicle-piece-pricing';
import { resolveVehiclePricingProfile } from './vehicle-pricing-profile';
import {
  getClientPieceLabel,
  resolveCatalogPiezaForMatrixLookup,
} from './panel-pieza-catalog';
import { quoteRowsFromDamageInventory } from '../chat/draft-quote-inventory-pricing';
import type { DetectedDamageItem } from '../chat/entities/chat.entity';
import { finalizeCanonicalQuote } from '../domain/peritaje-v1/quote-engine';
import { renderCanonicalQuoteFinancialBlock } from '../domain/peritaje-v1/quote-narrative';
import type { QuoteLine } from '../domain/peritaje-v1/types';

/**
 * Candidato para aprobación comercial. No es una tarifa guardada.
 * Compacto, sin premium, severidad fuerte: 5400 × 1.30 redondeado a $50 = $7,000.
 */
const CANDIDATE_REAR_BASE = 5400;
const FASCIA_BASE = 2900;
const HUMAN_BAND = [6500, 7500] as const;

function cell(servicio: string, precio: number): PriceMatrix {
  return {
    servicio,
    severidad: 'LEVE',
    precio,
    diasEntrega: 0,
    isInstantService: false,
  } as PriceMatrix;
}

function damage(pieza: string, severidad: string): DetectedDamageItem {
  return {
    pieza,
    severidad,
    descripcionTecnica: '',
    urls_origen: [],
    vehiculoDetectado: 'Mazda 2 2024',
    tratamiento: 'REPARAR',
    treatmentSource: 'vision',
    treatmentReason: 'vision_structured',
  };
}

function toQuoteLine(
  row: {
    serviceType?: QuoteLine['serviceType'];
    description?: string;
    precioMx?: number;
    billable?: boolean;
    priceSource?: QuoteLine['pricingSource'];
    pricingStatus?: QuoteLine['pricingStatus'];
    physicalPanelKey?: string;
  },
  index: number,
): QuoteLine {
  const unconfigured =
    row.pricingStatus === 'UNCONFIGURED' || row.priceSource === 'UNCONFIGURED';
  const amount = Math.round(row.precioMx ?? 0);
  return {
    quoteLineId: `ql_${index}`,
    damageItemId: `dmg_${row.physicalPanelKey ?? index}`,
    vehicleId: 'veh_mazda2_2024',
    serviceType: row.serviceType ?? 'REPARACION_PINTURA',
    description: row.description ?? '',
    billable: row.billable === true && !unconfigured && amount > 0,
    amount,
    pricingSource: row.priceSource,
    pricingStatus: row.pricingStatus,
    confidence: 'MEDIUM',
  };
}

describe('calibración comercial del costado trasero', () => {
  const mazda = resolveVehiclePricingProfile({
    modeloVehiculo: 'Mazda 2 2024',
  });

  it('el catálogo aprobable nombra las celdas traseras y el motor usa la base LEVE', () => {
    const severities = APPROVED_CATALOG_KEYS.filter(
      ([servicio]) => servicio === 'Salpicadera trasera',
    ).map(([, severidad]) => severidad);
    expect(severities).toEqual([
      'DF',
      'DM',
      'DMF',
      'DMFuerte',
      'DML',
      'LEVE',
      'MONTAJE_PINTURA',
    ]);
    expect(isPieceBaseSeverity('LEVE')).toBe(true);
    expect(isPieceBaseSeverity('DF')).toBe(false);
    expect(
      APPROVED_CATALOG_KEYS.some(
        ([servicio, severidad]) =>
          servicio === 'Fascia' && severidad === 'LEVE',
      ),
    ).toBe(true);
  });

  it('Mazda 2 2024 es compacto y sin premium', () => {
    expect(mazda.sizeTier).toBe('Compacto');
    expect(mazda.isPremium).toBe(false);
  });

  it('el importe 4050 no sale de la tarifa trasera publicada ni de Fascia LEVE', () => {
    const rearStrong = computeCatalogPiecePrice({
      basePrice: 2900,
      sizeTier: mazda.sizeTier,
      isPremium: mazda.isPremium,
      damageMagnitude: 'FUERTE',
    });
    const fasciaLeve = computeCatalogPiecePrice({
      basePrice: 2900,
      sizeTier: mazda.sizeTier,
      isPremium: mazda.isPremium,
      damageMagnitude: 'LEVE',
    });
    const doorStrong = computeCatalogPiecePrice({
      basePrice: 3100,
      sizeTier: mazda.sizeTier,
      isPremium: mazda.isPremium,
      damageMagnitude: 'FUERTE',
    });
    expect(resolveCatalogPiezaForMatrixLookup('CTI')).toBe('Salpicadera trasera');
    expect(resolveCatalogPiezaForMatrixLookup('STI')).toBe('Salpicadera trasera');
    expect(fasciaLeve).toBe(2900);
    expect(rearStrong).toBe(3750);
    expect(rearStrong).not.toBe(4050);
    expect(doorStrong).toBe(4050);
    expect(resolveCatalogPiezaForMatrixLookup('PTI')).toBe('Puerta');
  });

  it('la base heredada de 2900 con daño fuerte reproduce 3750 y queda fuera de la referencia', () => {
    const inherited = computeCatalogPiecePrice({
      basePrice: 2900,
      sizeTier: mazda.sizeTier,
      isPremium: mazda.isPremium,
      damageMagnitude: 'FUERTE',
    });
    expect(inherited).toBe(3750);
    expect(inherited >= HUMAN_BAND[0] && inherited <= HUMAN_BAND[1]).toBe(
      false,
    );
  });

  it('el candidato local cae en la referencia y coincide entre resolutor y cotización', () => {
    const snap = createMatrixPricingSnapshot([
      cell('Salpicadera', 2900),
      cell('Salpicadera trasera', CANDIDATE_REAR_BASE),
      cell('Fascia', FASCIA_BASE),
    ]);
    const expectedSide = computeCatalogPiecePrice({
      basePrice: CANDIDATE_REAR_BASE,
      sizeTier: mazda.sizeTier,
      isPremium: mazda.isPremium,
      damageMagnitude: 'FUERTE',
    });
    const expectedFascia = computeCatalogPiecePrice({
      basePrice: FASCIA_BASE,
      sizeTier: mazda.sizeTier,
      isPremium: mazda.isPremium,
      damageMagnitude: 'LEVE',
    });
    expect(expectedSide).toBe(7000);
    expect(expectedSide >= HUMAN_BAND[0] && expectedSide <= HUMAN_BAND[1]).toBe(
      true,
    );
    expect(expectedFascia).toBe(2900);
    expect(
      resolvePiecePriceForVehicleProfile(
        snap,
        'Salpicadera trasera',
        'FUERTE',
        mazda,
      ),
    ).toBe(expectedSide);

    const rows = quoteRowsFromDamageInventory(
      [damage('CTI', 'FUERTE'), damage('FT', 'LEVE')],
      snap,
      mazda,
    );
    const side = rows.find((row) => row.physicalPanelKey === 'STI');
    const fascia = rows.find((row) => row.physicalPanelKey === 'FT');
    expect(resolveCatalogPiezaForMatrixLookup('CTI')).toBe(
      'Salpicadera trasera',
    );
    expect(getClientPieceLabel('CTI')).toBe('Costado izquierdo');
    expect(side?.precioMx).toBe(expectedSide);
    expect(side?.severidad).toBe('DF');
    expect(side?.priceSource).toBeUndefined();
    expect(fascia?.precioMx).toBe(expectedFascia);

    const quote = finalizeCanonicalQuote({
      peritajeId: 'per_mazda2_calibracion',
      lines: rows.map(toQuoteLine),
    });
    expect(quote.isPartial).toBe(false);
    expect(quote.total).toBe(expectedSide + expectedFascia);
    const shown = renderCanonicalQuoteFinancialBlock(quote);
    expect(shown.isPartial).toBe(false);
    expect(shown.totalText).toContain('Total:');
    expect(shown.displayedAmounts).toEqual(
      expect.arrayContaining([expectedSide, expectedFascia, quote.total]),
    );
  });

  it('sin tarifa trasera la cotización queda parcial y no se presenta como total definitivo', () => {
    const snap = createMatrixPricingSnapshot([
      cell('Salpicadera', 2900),
      cell('Fascia', FASCIA_BASE),
    ]);
    const rows = quoteRowsFromDamageInventory(
      [damage('CTI', 'FUERTE'), damage('FT', 'LEVE')],
      snap,
      mazda,
    );
    const side = rows.find((row) => row.physicalPanelKey === 'STI');
    expect(side?.precioMx).toBe(0);
    expect(side?.priceSource).toBe('UNCONFIGURED');
    expect(side?.pricingStatus).toBe('UNCONFIGURED');
    expect(side?.billable).toBe(false);
    expect(side?.description).toContain('tarifa sin configurar');

    const quote = finalizeCanonicalQuote({
      peritajeId: 'per_mazda2_sin_tarifa',
      lines: rows.map(toQuoteLine),
    });
    expect(quote.isPartial).toBe(true);
    expect(quote.total).toBe(2900);
    const shown = renderCanonicalQuoteFinancialBlock(quote);
    expect(shown.text).toContain('Subtotal actual');
    expect(shown.text).toContain('pendiente de configuración');
    expect(shown.text).toContain('Cotización parcial');
    expect(shown.text).not.toContain('*Total:');
    expect(shown.displayedAmounts).not.toContain(3750);
    expect(shown.displayedAmounts).not.toContain(7000);
  });
});
