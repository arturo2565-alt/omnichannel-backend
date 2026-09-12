import {
  applyXorTreatmentsToInventory,
  cloneDetectedDamageItem,
  inferTreatmentDecision,
  mergePhysicalPanelItems,
  physicalInventoryMergeKey,
  resolveInventoryTreatment,
} from './piece-treatment';
import { parseVisionDamageItems } from './vision-item-normalize';
import {
  inventoryItemsToVehicleAnalysis,
  mergeVisionIntoPriorInventory,
} from './quote-cart-analysis';
import { quoteRowsFromDamageInventory } from './draft-quote-inventory-pricing';
import {
  buildVisionCanonicalShadow,
  compareLegacyVsCanonical,
  createVehicleId,
  resolveModernVehicleIdentity,
} from '../domain/peritaje-v1';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';

function snap(): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: () => 4000,
    getAmount: () => 4000,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DL', 'DM', 'DMFuerte'],
  } as MatrixPricingSnapshot;
}

function item(
  overrides: Partial<DetectedDamageItem> & Pick<DetectedDamageItem, 'pieza'>,
): DetectedDamageItem {
  return {
    severidad: 'DM',
    descripcionTecnica: 'golpe',
    urls_origen: ['https://cdn.example/a.jpg'],
    ...overrides,
  };
}

describe('Fase 3 — treatment lock', () => {
  it('1. SUSTITUIR estructurado + “rayón leve” sigue SUSTITUIR', () => {
    const src = item({
      pieza: 'FD',
      descripcionTecnica: 'rayón leve',
      tratamiento: 'SUSTITUIR',
      treatmentSource: 'vision',
      treatmentReason: 'vision_structured',
    });
    expect(resolveInventoryTreatment(src).treatment).toBe('SUSTITUIR');
    expect(cloneDetectedDamageItem(src).tratamiento).toBe('SUSTITUIR');
    const rows = quoteRowsFromDamageInventory([src], snap());
    expect(rows.every((r) => r.tratamiento === 'SUSTITUIR')).toBe(true);
    expect(rows.some((r) => r.serviceType === 'REPARACION_PINTURA')).toBe(false);
  });

  it('2. REPARAR estructurado + “hecha pedazos” no pasa a SUSTITUIR por texto', () => {
    const src = item({
      pieza: 'Cofre',
      severidad: 'DF',
      descripcionTecnica: 'hecha pedazos',
      tratamiento: 'REPARAR',
      treatmentSource: 'vision',
    });
    expect(inferTreatmentDecision(src)).toBe('REPARAR');
    expect(resolveInventoryTreatment(src).treatment).toBe('REPARAR');
    expect(resolveInventoryTreatment(src).usedLegacyInference).toBe(false);
    const merged = mergePhysicalPanelItems(
      src,
      item({
        pieza: 'Cofre',
        descripcionTecnica: 'rota y quebrada',
      }),
    );
    expect(merged.tratamiento).toBe('REPARAR');
  });

  it('3. INCIERTO estructurado permanece', () => {
    const src = item({
      pieza: 'FD',
      severidad: 'DMFuerte',
      tratamiento: 'INCIERTO',
    });
    expect(resolveInventoryTreatment(src).treatment).toBe('INCIERTO');
    expect(applyXorTreatmentsToInventory([src])[0]?.tratamiento).toBe(
      'INCIERTO',
    );
  });

  it('4. PENDIENTE estructurado permanece', () => {
    const src = item({
      pieza: 'Faro_Derecho',
      severidad: 'DF',
      tratamiento: 'PENDIENTE',
    });
    expect(resolveInventoryTreatment(src).treatment).toBe('PENDIENTE');
    const rows = quoteRowsFromDamageInventory([src], snap());
    expect(rows[0]?.serviceType).toBe('PENDIENTE');
    expect(rows[0]?.precioMx).toBe(0);
  });

  it('5. legacy sin treatment + rotura → inferencia temporal SUSTITUIR', () => {
    const src = item({
      pieza: 'Cofre',
      severidad: 'DF',
      descripcionTecnica: 'cofre roto y partido',
    });
    const resolved = resolveInventoryTreatment(src);
    expect(resolved.treatment).toBe('SUSTITUIR');
    expect(resolved.usedLegacyInference).toBe(true);
    expect(resolved.reason).toBe('legacy_inferred');
  });

  it('6. cloneDetectedDamageItem conserva treatment y hidden damage', () => {
    const src = item({
      pieza: 'FD',
      tratamiento: 'SUSTITUIR',
      treatmentSource: 'vision',
      treatmentReason: 'vision_structured',
      vehiculoDetectado: 'Mazda 3 2020',
      possibleHiddenDamage: {
        detected: true,
        areas: ['radiador'],
        requiresDisassembly: true,
      },
    });
    const cloned = cloneDetectedDamageItem(src);
    expect(cloned.tratamiento).toBe('SUSTITUIR');
    expect(cloned.treatmentSource).toBe('vision');
    expect(cloned.treatmentReason).toBe('vision_structured');
    expect(cloned.possibleHiddenDamage).toEqual(src.possibleHiddenDamage);
    expect(cloned.vehiculoDetectado).toBe('Mazda 3 2020');
    expect(cloned.vehicleId).toBe(
      resolveModernVehicleIdentity('Mazda 3 2020').vehicleId,
    );
  });

  it('7. normalize de visión conserva treatment estructurado', () => {
    const items = parseVisionDamageItems({
      items: [
        {
          pieza: 'FD',
          severidad: 'DMFuerte',
          descripcionTecnica: 'rayón leve',
          tipo_dano: 'SUSTITUCION',
          requiere_refaccion: true,
          urls_origen: ['https://cdn.example/fd.jpg'],
          possibleHiddenDamage: {
            detected: true,
            areas: ['soporte'],
            requiresDisassembly: true,
          },
        },
      ],
    });
    expect(items[0]?.tratamiento).toBe('SUSTITUIR');
    expect(items[0]?.treatmentSource).toBe('vision');
    expect(items[0]?.possibleHiddenDamage?.detected).toBe(true);
  });

  it('8. merge de misma pieza no pierde treatment', () => {
    const merged = mergePhysicalPanelItems(
      item({ pieza: 'FD', tratamiento: 'SUSTITUIR' }),
      item({ pieza: 'FD', descripcionTecnica: 'segunda foto' }),
    );
    expect(merged.tratamiento).toBe('SUSTITUIR');
    expect(merged.treatmentReason).toBe('preserved_locked_treatment');
  });

  it('9. mismo vehicleId + panel → merge', () => {
    const vid = createVehicleId({ displayLabel: 'Mazda 3 2020' });
    const out = applyXorTreatmentsToInventory([
      item({
        pieza: 'Cofre',
        vehicleId: vid,
        tratamiento: 'REPARAR',
        descripcionTecnica: 'foto 1',
      }),
      item({
        pieza: 'REFACCION:Cofre',
        vehicleId: vid,
        tratamiento: 'REPARAR',
        descripcionTecnica: 'foto 2',
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.tratamiento).toBe('REPARAR');
  });

  it('10. distinto vehicleId + mismo panel → no merge', () => {
    const a = createVehicleId({ displayLabel: 'Mazda 3 2020' });
    const b = createVehicleId({ displayLabel: 'Nissan Versa 2018' });
    expect(
      physicalInventoryMergeKey(item({ pieza: 'Cofre', vehicleId: a })),
    ).not.toBe(
      physicalInventoryMergeKey(item({ pieza: 'Cofre', vehicleId: b })),
    );
    const out = applyXorTreatmentsToInventory([
      item({ pieza: 'Cofre', vehicleId: a, tratamiento: 'REPARAR' }),
      item({ pieza: 'Cofre', vehicleId: b, tratamiento: 'SUSTITUIR' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('11. ítem moderno sin treatment → PENDIENTE, no REPARAR silencioso', () => {
    const src = item({
      pieza: 'FD',
      treatmentSource: 'vision',
      treatmentReason: 'missing_structured_treatment',
    });
    const resolved = resolveInventoryTreatment(src);
    expect(resolved.treatment).toBe('PENDIENTE');
    expect(resolved.usedLegacyInference).toBe(false);
    const rows = quoteRowsFromDamageInventory([src], snap());
    expect(rows[0]?.tratamiento).toBe('PENDIENTE');
    expect(rows[0]?.serviceType).toBe('PENDIENTE');
  });

  it('12. possibleHiddenDamage sobrevive merge', () => {
    const merged = mergePhysicalPanelItems(
      item({
        pieza: 'FD',
        tratamiento: 'REPARAR',
        possibleHiddenDamage: {
          detected: true,
          areas: ['larguero'],
          requiresDisassembly: true,
        },
      }),
      item({ pieza: 'FD', descripcionTecnica: 'más evidencia' }),
    );
    expect(merged.possibleHiddenDamage).toEqual({
      detected: true,
      areas: ['larguero'],
      requiresDisassembly: true,
    });
  });

  it('13. fotos nuevas no reabren inferencia textual si hay lock', () => {
    const prior = [
      item({
        pieza: 'FD',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        urls_origen: ['https://cdn.example/1.jpg'],
      }),
    ];
    const incoming = [
      item({
        pieza: 'FD',
        severidad: 'DF',
        descripcionTecnica: 'hecha pedazos irreparable',
        urls_origen: ['https://cdn.example/2.jpg'],
      }),
    ];
    const { mergedInventory } = mergeVisionIntoPriorInventory(prior, incoming);
    expect(mergedInventory[0]?.tratamiento).toBe('REPARAR');
  });

  it('14. carrito histórico sin treatment sigue funcionando', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'FD',
          severidad: 'DL',
          descripcionTecnica: 'rayón',
        }),
      ],
      snap(),
    );
    expect(rows[0]?.serviceType).toBe('REPARACION_PINTURA');
    expect(rows[0]?.tratamiento).toBe('REPARAR');
  });

  it('REPARAR locked vs SUSTITUIR locked → INCIERTO', () => {
    const merged = mergePhysicalPanelItems(
      item({
        pieza: 'FD',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
      }),
      item({
        pieza: 'FD',
        tratamiento: 'SUSTITUIR',
        treatmentSource: 'vision',
      }),
    );
    expect(merged.tratamiento).toBe('INCIERTO');
    expect(merged.treatmentReason).toBe('conflicting_structured_treatments');
  });

  it('16. shadow: TREATMENT_MISSING_IN_LEGACY desaparece tras lock lossless', () => {
    const visionItems = parseVisionDamageItems({
      items: [
        {
          pieza: 'FD',
          severidad: 'DMFuerte',
          descripcionTecnica: 'rayón leve',
          tipo_dano: 'SUSTITUCION',
          requiere_refaccion: true,
          urls_origen: ['https://cdn.example/1.jpg'],
        },
      ],
    });
    const analysis = inventoryItemsToVehicleAnalysis(
      visionItems,
      ['https://cdn.example/1.jpg'],
      'Mazda 3 2020',
    );
    const collapsed = applyXorTreatmentsToInventory(analysis.inventory ?? []);
    const canonical = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: visionItems,
      visionVehicleLabel: 'Mazda 3 2020',
      now: '2026-09-11T00:00:00.000Z',
    });
    const cmp = compareLegacyVsCanonical({
      canonical,
      conversationId: 'c1',
      status: 'CANONICAL_VALID',
      legacy: {
        inventory: collapsed,
        vehiculoDetectado: 'Mazda 3 2020',
      },
    });
    expect(cmp.differences.map((d) => d.type)).not.toContain(
      'TREATMENT_MISSING_IN_LEGACY',
    );
    expect(cmp.differences.map((d) => d.type)).not.toContain(
      'TREATMENT_DIFFERENCE',
    );
    expect(collapsed[0]?.tratamiento).toBe('SUSTITUIR');
  });
});
