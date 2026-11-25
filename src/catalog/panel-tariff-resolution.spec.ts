import { createMatrixPricingSnapshot } from './matrix-pricing-snapshot';
import type { PriceMatrix } from './entities/price-matrix.entity';
import {
  equivalentPhysicalPanelCode,
  getClientPieceLabel,
  isIntegralPanelPieza,
  refaccionCatalogCodigoForPieza,
  resolveCatalogPiezaForMatrixLookup,
} from './panel-pieza-catalog';
import { matchServicioFromCatalog } from '../chat/autofix-config';
import {
  canonicalPhysicalPanelKey,
  collapseInventoryByPhysicalPanel,
  ensureDamageIdentity,
} from '../chat/piece-treatment';
import { quoteRowsFromDamageInventory } from '../chat/draft-quote-inventory-pricing';
import { resolvePiecePriceForVehicleProfile } from './vehicle-piece-pricing';
import { deriveIsPartial } from '../domain/peritaje-v1/quote-engine';
import type { DetectedDamageItem } from '../chat/entities/chat.entity';
import type { QuoteLine } from '../domain/peritaje-v1/types';

/**
 * Referencia humana del Mazda 2 2024. Es un caso de calibración:
 * no es una tarifa ni un resultado esperado del motor.
 */
const MAZDA2_2024_REAR_SIDE_HUMAN_REFERENCE = {
  vehicle: 'Mazda 2 2024',
  panel: 'costado trasero izquierdo',
  bandMx: [6500, 7500] as const,
  status: 'pending_catalog_configuration',
};

function cell(servicio: string, precio: number): PriceMatrix {
  return {
    servicio,
    severidad: 'LEVE',
    precio,
    diasEntrega: 0,
    isInstantService: false,
  } as PriceMatrix;
}

function snapFor(cells: PriceMatrix[]) {
  return createMatrixPricingSnapshot(cells);
}

function damage(pieza: string): DetectedDamageItem {
  return {
    pieza,
    severidad: 'LEVE',
    descripcionTecnica: '',
    urls_origen: [],
    vehiculoDetectado: 'Mazda 2 2024',
    tratamiento: 'REPARAR',
    treatmentSource: 'vision',
    treatmentReason: 'vision_structured',
  };
}

function line(row: {
  serviceType?: QuoteLine['serviceType'];
  precioMx?: number;
  billable?: boolean;
  priceSource?: QuoteLine['pricingSource'];
  pricingStatus?: QuoteLine['pricingStatus'];
  description?: string;
}): QuoteLine {
  return {
    quoteLineId: 'ql',
    damageItemId: 'dmg',
    vehicleId: 'veh',
    serviceType: row.serviceType ?? 'REPARACION_PINTURA',
    description: row.description ?? '',
    billable: row.billable === true,
    amount: row.precioMx ?? 0,
    pricingSource: row.priceSource,
    pricingStatus: row.pricingStatus,
    confidence: 'MEDIUM',
  };
}

describe('resolución de tarifa por panel', () => {
  const frontAndFascia = snapFor([
    cell('Salpicadera', 4500),
    cell('Fascia', 2900),
  ]);

  it('separa salpicadera delantera y costado trasero', () => {
    expect(resolveCatalogPiezaForMatrixLookup('SI')).toBe('Salpicadera');
    expect(resolveCatalogPiezaForMatrixLookup('SD')).toBe('Salpicadera');
    expect(resolveCatalogPiezaForMatrixLookup('STI')).toBe(
      'Salpicadera trasera',
    );
    expect(resolveCatalogPiezaForMatrixLookup('STD')).toBe(
      'Salpicadera trasera',
    );
    expect(resolveCatalogPiezaForMatrixLookup('CTI')).toBe(
      'Salpicadera trasera',
    );
    expect(resolveCatalogPiezaForMatrixLookup('CTD')).toBe(
      'Salpicadera trasera',
    );
    expect(getClientPieceLabel('CTI')).toBe('Costado izquierdo');
    expect(getClientPieceLabel('SI')).toBe('Salpicadera delantera izquierda');
  });

  it('STI/CTI y STD/CTD son un solo panel físico', () => {
    expect(equivalentPhysicalPanelCode('CTI')).toBe('STI');
    expect(equivalentPhysicalPanelCode('STI')).toBe('STI');
    expect(canonicalPhysicalPanelKey('CTI')).toBe(
      canonicalPhysicalPanelKey('STI'),
    );
    expect(canonicalPhysicalPanelKey('CTD')).toBe(
      canonicalPhysicalPanelKey('STD'),
    );
    const collapsed = collapseInventoryByPhysicalPanel([
      damage('CTI'),
      damage('STI'),
      damage('FT'),
    ]);
    expect(collapsed).toHaveLength(2);
    expect(
      collapsed.map((item) => canonicalPhysicalPanelKey(item.pieza)).sort(),
    ).toEqual(['FT', 'STI']);
  });

  it('agente y resolutor usan la misma tarifa configurada', () => {
    const snap = snapFor([
      cell('Salpicadera', 4500),
      cell('Salpicadera trasera', 5200),
      cell('Fascia', 2900),
    ]);
    const rows = quoteRowsFromDamageInventory(
      [damage('CTI'), damage('FT')],
      snap,
    );
    const side = rows.find((row) => row.physicalPanelKey === 'STI');
    const fascia = rows.find((row) => row.physicalPanelKey === 'FT');
    expect(side?.precioMx).toBe(
      resolvePiecePriceForVehicleProfile(snap, 'Salpicadera trasera', 'LEVE'),
    );
    expect(side?.precioMx).toBe(5200);
    expect(fascia?.precioMx).toBe(2900);
    expect(side?.priceSource).toBeUndefined();
    expect(deriveIsPartial([line(side!), line(fascia!)])).toBe(false);
  });

  it('el costado no hereda la salpicadera delantera', () => {
    expect(
      matchServicioFromCatalog('Salpicadera trasera', [
        'Salpicadera',
        'Fascia',
      ]),
    ).toBeNull();
    expect(
      matchServicioFromCatalog('costado trasero izquierdo', [
        'Salpicadera',
        'Fascia',
      ]),
    ).toBeNull();
    const rows = quoteRowsFromDamageInventory([damage('CTI')], frontAndFascia);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.precioMx).toBe(0);
    expect(rows[0]?.priceSource).toBe('UNCONFIGURED');
    expect(rows[0]?.pricingStatus).toBe('UNCONFIGURED');
    expect(rows[0]?.billable).toBe(false);
    expect(rows[0]?.precioMx).not.toBe(4500);
  });

  it('una tarifa ausente no inventa un importe final', () => {
    const rows = quoteRowsFromDamageInventory(
      [damage('CTI'), damage('FT')],
      frontAndFascia,
    );
    const side = rows.find((row) => row.physicalPanelKey === 'STI');
    const fascia = rows.find((row) => row.physicalPanelKey === 'FT');
    expect(side).toBeDefined();
    expect(fascia).toBeDefined();
    const quote = [line(side ?? {}), line(fascia ?? {})];
    expect(deriveIsPartial(quote)).toBe(true);
    expect(
      quote.reduce((sum, item) => sum + (item.billable ? item.amount : 0), 0),
    ).toBe(2900);
  });

  it('la fascia trasera conserva su tarifa', () => {
    expect(resolveCatalogPiezaForMatrixLookup('FT')).toBe('Fascia');
    const rows = quoteRowsFromDamageInventory([damage('FT')], frontAndFascia);
    expect(rows[0]?.precioMx).toBe(2900);
    expect(rows[0]?.priceSource).toBeUndefined();
    expect(rows[0]?.billable).toBe(true);
  });

  it('no reescribe la identidad de una cotización ya guardada', () => {
    const historical = ensureDamageIdentity({
      ...damage('CTI'),
      damageItemId: 'dmg_historico',
      physicalPanelKey: 'CTI',
    });
    expect(historical.damageItemId).toBe('dmg_historico');
    expect(historical.physicalPanelKey).toBe('CTI');
  });

  it('refacciones y baño siguen en su propia identidad', () => {
    expect(refaccionCatalogCodigoForPieza('FT')).toBe('FASCIA_TRAS');
    expect(refaccionCatalogCodigoForPieza('CTI')).toBe('SALPICADERA');
    expect(isIntegralPanelPieza('BPE')).toBe(true);
    expect(resolveCatalogPiezaForMatrixLookup('BPE')).toBeNull();
    expect(resolveCatalogPiezaForMatrixLookup('FT')).toBe('Fascia');
  });

  it('el Mazda 2 2024 queda como calibración, no como precio del motor', () => {
    const rows = quoteRowsFromDamageInventory([damage('CTI')], frontAndFascia);
    const quoted = rows[0]?.precioMx ?? 0;
    const [low, high] = MAZDA2_2024_REAR_SIDE_HUMAN_REFERENCE.bandMx;
    expect(MAZDA2_2024_REAR_SIDE_HUMAN_REFERENCE.status).toBe(
      'pending_catalog_configuration',
    );
    expect(quoted).toBe(0);
    expect(quoted >= low && quoted <= high).toBe(false);
  });
});
