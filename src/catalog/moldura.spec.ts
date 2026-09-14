import { createDamageItemId } from '../domain/peritaje-v1';
import { damageItemFromLegacy } from '../domain/peritaje-v1/from-legacy';
import { canonicalizePanelCode, resolveCatalogPiezaForMatrixLookup } from './panel-pieza-catalog';
import {
  MOLDURA_PINTADA_CATALOG,
  PANEL_PIEZA_MOLDURA_CODE,
  humanizeMolduraPieceLabel,
  molduraMarketSearchLabel,
  molduraPhysicalPanelKey,
  parseMoldingFinishType,
  parseMoldingPosition,
  physicalPanelKeyForMolduraItem,
} from './moldura';
import { normalizeVisionDamageItem } from '../chat/vision-item-normalize';
import {
  canonicalPhysicalPanelKey,
  ensureDamageIdentity,
  physicalInventoryMergeKey,
} from '../chat/piece-treatment';
import { quoteRowsFromDamageInventory } from '../chat/draft-quote-inventory-pricing';
import { parseVehiclePartIdentity, marketCacheKey } from '../chat/refaccion-market/parse-vehicle-part-identity';
import type { MatrixPricingSnapshot } from './matrix-pricing-snapshot';
import type { DetectedDamageItem } from '../chat/entities/chat.entity';

function snap(prices: Record<string, number> = {}): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: (canonical: string, level: string) =>
      prices[`${canonical}|${level}`] ?? prices[canonical] ?? 0,
    getAmount: (pieza: string, level: string) =>
      prices[`${pieza}|${level}`] ?? 0,
    getDiasEntregaForCanonical: () => 4,
    listSeveridadesForCanonical: () => ['DL', 'LEVE', 'MONTAJE_PINTURA'],
  } as MatrixPricingSnapshot;
}

function item(
  overrides: Partial<DetectedDamageItem> & Pick<DetectedDamageItem, 'pieza'>,
): DetectedDamageItem {
  return {
    severidad: 'DF',
    descripcionTecnica: 'moldura negra del arco desprendida',
    urls_origen: [],
    vehiculoDetectado: 'Toyota Avanza 2020',
    tratamiento: 'REPARAR',
    treatmentSource: 'vision',
    treatmentReason: 'vision_structured',
    ...overrides,
  };
}

describe('MOLDURA familia mínima', () => {
  it('1. alias Moldura → MOLDURA', () => {
    expect(canonicalizePanelCode('Moldura')).toBe(PANEL_PIEZA_MOLDURA_CODE);
    expect(canonicalizePanelCode('MOLDURA')).toBe(PANEL_PIEZA_MOLDURA_CODE);
    expect(canonicalizePanelCode('moldura')).toBe(PANEL_PIEZA_MOLDURA_CODE);
  });

  it('2. posición entra en physicalPanelKey', () => {
    expect(molduraPhysicalPanelKey('ARCO_DELANTERO_IZQUIERDO')).toBe(
      'MOLDURA::ARCO_DELANTERO_IZQUIERDO',
    );
    expect(
      canonicalPhysicalPanelKey('MOLDURA', {
        moldingPosition: 'ARCO_DELANTERO_IZQUIERDO',
      }),
    ).toBe('MOLDURA::ARCO_DELANTERO_IZQUIERDO');
  });

  it('3. dos molduras de distinta posición no colisionan', () => {
    const a = ensureDamageIdentity(
      item({
        pieza: 'MOLDURA',
        moldingPosition: 'ARCO_DELANTERO_IZQUIERDO',
        finishType: 'NEGRA_TEXTURIZADA',
      }),
    );
    const b = ensureDamageIdentity(
      item({
        pieza: 'MOLDURA',
        moldingPosition: 'ARCO_DELANTERO_DERECHO',
        finishType: 'NEGRA_TEXTURIZADA',
      }),
    );
    expect(physicalInventoryMergeKey(a)).not.toBe(physicalInventoryMergeKey(b));
    expect(a.damageItemId).not.toBe(b.damageItemId);
  });

  it('4. misma posición sí conserva identidad', () => {
    const a = ensureDamageIdentity(
      item({
        pieza: 'MOLDURA',
        moldingPosition: 'ARCO_DELANTERO_IZQUIERDO',
        finishType: 'NEGRA_TEXTURIZADA',
      }),
    );
    const b = ensureDamageIdentity(
      item({
        pieza: 'MOLDURA',
        moldingPosition: 'ARCO_DELANTERO_IZQUIERDO',
        finishType: 'PINTADA_CARROCERIA',
        damageItemId: a.damageItemId,
      }),
    );
    expect(a.damageItemId).toBe(b.damageItemId);
    expect(createDamageItemId({
      vehicleId: a.vehicleId!,
      physicalPanelKey: 'MOLDURA::ARCO_DELANTERO_IZQUIERDO',
    })).toBe(a.damageItemId);
  });

  it('5. finishType faltante → UNKNOWN', () => {
    const parsed = normalizeVisionDamageItem({
      pieza: 'MOLDURA',
      severidad: 'DM',
      descripcionTecnica: 'golpe',
      urls_origen: [],
    });
    expect(parsed?.finishType).toBe('UNKNOWN');
    expect(parsed?.moldingPosition).toBe('UNKNOWN');
  });

  it('6. no inferir acabado desde descripcionTecnica', () => {
    const parsed = normalizeVisionDamageItem({
      pieza: 'MOLDURA',
      severidad: 'DM',
      descripcionTecnica: 'moldura negra texturizada del arco desprendida',
      urls_origen: [],
    });
    expect(parsed?.finishType).toBe('UNKNOWN');
    expect(parseMoldingFinishType(undefined)).toBe('UNKNOWN');
  });

  it('7. PINTADA + REPARAR → MOLDURA_PINTADA', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'MOLDURA',
          moldingPosition: 'PUERTA',
          finishType: 'PINTADA_CARROCERIA',
          tratamiento: 'REPARAR',
          severidad: 'DM',
        }),
      ],
      snap({ 'MOLDURA_PINTADA|LEVE': 1200, 'MOLDURA_PINTADA|DL': 1200 }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.serviceType).toBe('REPARACION_PINTURA');
    expect(resolveCatalogPiezaForMatrixLookup('MOLDURA')).toBe(
      MOLDURA_PINTADA_CATALOG,
    );
    expect(rows[0]?.billable).toBe(true);
  });

  it('8. MOLDURA_PINTADA sin tarifa → UNCONFIGURED/no cobrable', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'MOLDURA',
          moldingPosition: 'PUERTA',
          finishType: 'PINTADA_CARROCERIA',
          tratamiento: 'REPARAR',
          severidad: 'DM',
        }),
      ],
      snap(),
    );
    expect(rows[0]?.serviceType).toBe('REPARACION_PINTURA');
    expect(rows[0]?.priceSource).toBe('UNCONFIGURED');
    expect(rows[0]?.pricingStatus).toBe('UNCONFIGURED');
    expect(rows[0]?.billable).toBe(false);
  });

  it('9. NEGRA + REPARAR → no REPARACION_PINTURA', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'MOLDURA',
          moldingPosition: 'ARCO_DELANTERO_IZQUIERDO',
          finishType: 'NEGRA_TEXTURIZADA',
          tratamiento: 'REPARAR',
        }),
      ],
      snap({ 'Estetica Exterior|DL': 3500, 'Estetica Exterior|DF': 3500 }),
    );
    expect(rows.some((r) => r.serviceType === 'REPARACION_PINTURA')).toBe(false);
    expect(rows[0]?.serviceType).toBe('PENDIENTE');
    expect(rows[0]?.precioMx).toBe(0);
  });

  it('10. UNKNOWN + REPARAR → no REPARACION_PINTURA', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'MOLDURA',
          tratamiento: 'REPARAR',
          finishType: 'UNKNOWN',
        }),
      ],
      snap({ 'Estetica Exterior|DL': 3500 }),
    );
    expect(rows.some((r) => r.serviceType === 'REPARACION_PINTURA')).toBe(false);
  });

  it('11. NEGRA + SUSTITUIR → REFACCION + MONTAJE (sin MONTAJE_PINTURA)', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'MOLDURA',
          moldingPosition: 'ARCO_DELANTERO_IZQUIERDO',
          finishType: 'NEGRA_TEXTURIZADA',
          tratamiento: 'SUSTITUIR',
          precioMx: 1800,
          priceSource: 'WEB_MARKET_ESTIMATE',
          pricingStatus: 'OK',
        }),
      ],
      snap({ 'MOLDURA_PINTADA|MONTAJE_PINTURA': 2000, 'MOLDURA|MONTAJE': 600 }),
    );
    expect(rows.map((r) => r.serviceType)).toEqual(['REFACCION', 'MONTAJE']);
    expect(rows.some((r) => r.serviceType === 'MONTAJE_PINTURA')).toBe(false);
  });

  it('12. PINTADA + SUSTITUIR → REFACCION + MONTAJE_PINTURA cuando corresponda', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'MOLDURA',
          moldingPosition: 'FASCIA',
          finishType: 'PINTADA_CARROCERIA',
          tratamiento: 'SUSTITUIR',
          precioMx: 1800,
          priceSource: 'WEB_MARKET_ESTIMATE',
          pricingStatus: 'OK',
        }),
      ],
      snap({ 'MOLDURA_PINTADA|MONTAJE_PINTURA': 2000 }),
    );
    expect(rows.map((r) => r.serviceType).sort()).toEqual(
      ['MONTAJE_PINTURA', 'REFACCION'].sort(),
    );
  });

  it('13. market query distingue posición', () => {
    const left = parseVehiclePartIdentity({
      vehiculoText: 'Toyota Avanza 2020',
      pieza: 'MOLDURA',
      moldingPosition: 'ARCO_DELANTERO_IZQUIERDO',
      finishType: 'NEGRA_TEXTURIZADA',
    });
    const right = parseVehiclePartIdentity({
      vehiculoText: 'Toyota Avanza 2020',
      pieza: 'MOLDURA',
      moldingPosition: 'ARCO_DELANTERO_DERECHO',
      finishType: 'NEGRA_TEXTURIZADA',
    });
    expect(left.piezaLabel).toContain('arco delantero izquierdo');
    expect(left.piezaLabel).toContain('negra');
    expect(left.piezaLabel).not.toMatch(/avanza/i);
    expect(marketCacheKey(left)).not.toBe(marketCacheKey(right));
    expect(molduraMarketSearchLabel({
      moldingPosition: 'ARCO_DELANTERO_IZQUIERDO',
      finishType: 'NEGRA_TEXTURIZADA',
    })).toBe('moldura arco delantero izquierdo negra');
  });

  it('14. legacy histórico Moldura sigue legible', () => {
    expect(
      physicalPanelKeyForMolduraItem({ pieza: 'Moldura' }),
    ).toBe('Moldura');
    const dmg = damageItemFromLegacy(
      { pieza: 'Moldura', severidad: 'DM', descripcionTecnica: 'histórica' },
      { vehicleId: 'veh_hist', canonicalizePanel: canonicalizePanelCode },
    );
    expect(dmg.physicalPanelKey).toBe('Moldura');
    expect(dmg.pieceCode).toBe('Moldura');
    expect(dmg.pieceLabel).toBe('Moldura');
  });

  it('15. caso real no vuelve a producir $4550 por Estetica Exterior', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'Moldura',
          moldingPosition: 'ARCO_DELANTERO_IZQUIERDO',
          finishType: 'NEGRA_TEXTURIZADA',
          tratamiento: 'INCIERTO',
          severidad: 'DF',
          descripcionTecnica: 'moldura de arco negra texturizada desprendida',
        }),
      ],
      snap({
        'Estetica Exterior|DL': 3500,
        'Estetica Exterior|DF': 3500,
        'Estetica Exterior|LEVE': 3500,
      }),
    );
    expect(resolveCatalogPiezaForMatrixLookup('Moldura')).toBe(
      MOLDURA_PINTADA_CATALOG,
    );
    expect(resolveCatalogPiezaForMatrixLookup('Moldura')).not.toBe(
      'Estetica Exterior',
    );
    expect(rows.some((r) => r.serviceType === 'REPARACION_PINTURA')).toBe(false);
    expect(rows.some((r) => r.precioMx === 4550)).toBe(false);
    expect(rows[0]?.serviceType).toBe('PENDIENTE');
    expect(humanizeMolduraPieceLabel('ARCO_DELANTERO_IZQUIERDO')).toBe(
      'Moldura arco delantero izquierdo',
    );
    expect(parseMoldingPosition('ARCO_DELANTERO_IZQUIERDO')).toBe(
      'ARCO_DELANTERO_IZQUIERDO',
    );
  });
});
