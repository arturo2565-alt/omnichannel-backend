import {
  adaptCalculatedRowsToCanonicalQuoteV1,
  buildPersistedDraftQuoteItemRows,
  resolveDamageForQuoteRow,
  stampQuoteLineId,
  validateModernQuoteAssociations,
} from './quote-line-identity';
import {
  cloneDetectedDamageItem,
  ensureDamageIdentity,
} from './piece-treatment';
import {
  quoteRowsFromDamageInventory,
  sumQuoteRowsSubtotal,
} from './draft-quote-inventory-pricing';
import { mapPanelInventoryLinesToItems } from './quote-cart-analysis';
import {
  createDamageItemId,
  createQuoteLineId,
  createVehicleId,
} from '../domain/peritaje-v1';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';

function snap(prices: Record<string, number> = {}): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: (canonical: string, level: string) =>
      prices[`${canonical}|${level}`] ?? prices[canonical] ?? 4000,
    getAmount: (pieza: string, level: string) =>
      prices[`${pieza}|${level}`] ?? prices[pieza] ?? 4000,
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
    urls_origen: [],
    ...overrides,
  };
}

describe('Fase 4 — identidad DamageItem 1:N QuoteLine', () => {
  const mazda = createVehicleId({ displayLabel: 'Mazda 3 2020' });
  const versa = createVehicleId({ displayLabel: 'Nissan Versa 2018' });

  it('1. REPARAR: 1 DamageItem → 1 QuoteLine con el mismo damageItemId', () => {
    const dmg = ensureDamageIdentity(
      item({
        pieza: 'FD',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehicleId: mazda,
        urls_origen: ['https://cdn.example/fd.jpg'],
      }),
    );
    const rows = quoteRowsFromDamageInventory([dmg], snap());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.serviceType).toBe('REPARACION_PINTURA');
    expect(rows[0]?.damageItemId).toBe(dmg.damageItemId);
    expect(rows[0]?.quoteLineId).toBe(
      createQuoteLineId({
        damageItemId: dmg.damageItemId!,
        serviceType: 'REPARACION_PINTURA',
      }),
    );
  });

  it('2. SUSTITUIR: REFACCION + MONTAJE_PINTURA, mismo damageItemId, quoteLineId distintos', () => {
    const dmg = ensureDamageIdentity(
      item({
        pieza: 'Cofre',
        tratamiento: 'SUSTITUIR',
        treatmentSource: 'vision',
        vehicleId: mazda,
        precioMx: 2500,
        detallesRefaccion: 'Cofre',
        urls_origen: ['https://cdn.example/cofre-a.jpg'],
      }),
    );
    const rows = quoteRowsFromDamageInventory(
      [dmg],
      snap({ 'Cofre|DL': 4000 }),
    );
    expect(rows.map((r) => r.serviceType)).toEqual([
      'REFACCION',
      'MONTAJE_PINTURA',
    ]);
    expect(rows[0]?.damageItemId).toBe(dmg.damageItemId);
    expect(rows[1]?.damageItemId).toBe(dmg.damageItemId);
    expect(rows[0]?.quoteLineId).not.toBe(rows[1]?.quoteLineId);
    expect(rows[0]?.quoteLineId).toBe(
      createQuoteLineId({
        damageItemId: dmg.damageItemId!,
        serviceType: 'REFACCION',
      }),
    );
  });

  it('3. SUSTITUIR + REPARAR: las 3 líneas quedan asociadas correctamente', () => {
    const sustituir = ensureDamageIdentity(
      item({
        pieza: 'FD',
        tratamiento: 'SUSTITUIR',
        treatmentSource: 'vision',
        vehicleId: mazda,
        precioMx: 1800,
        urls_origen: ['https://cdn.example/fd-a.jpg', 'https://cdn.example/fd-b.jpg'],
      }),
    );
    const reparar = ensureDamageIdentity(
      item({
        pieza: 'PDI',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehicleId: mazda,
        urls_origen: ['https://cdn.example/pdi.jpg'],
      }),
    );
    const rows = quoteRowsFromDamageInventory(
      [sustituir, reparar],
      snap({ 'Fascia|DL': 2900, 'Puerta|DL': 3100, 'Puerta|DM': 3600 }),
    );
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.damageItemId === sustituir.damageItemId)).toHaveLength(
      2,
    );
    expect(rows.filter((r) => r.damageItemId === reparar.damageItemId)).toHaveLength(
      1,
    );
    expect(
      rows.find((r) => r.serviceType === 'REPARACION_PINTURA')?.damageItemId,
    ).toBe(reparar.damageItemId);
  });

  it('4. evidencia del segundo DamageItem nunca aparece en montaje del primero', () => {
    const first = ensureDamageIdentity(
      item({
        pieza: 'FD',
        tratamiento: 'SUSTITUIR',
        treatmentSource: 'vision',
        vehicleId: mazda,
        precioMx: 1800,
        urls_origen: ['https://cdn.example/fd.jpg'],
      }),
    );
    const second = ensureDamageIdentity(
      item({
        pieza: 'PDI',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehicleId: mazda,
        urls_origen: ['https://cdn.example/pdi.jpg'],
      }),
    );
    const rows = quoteRowsFromDamageInventory(
      [first, second],
      snap({ 'Puerta|DM': 3600 }),
    );
    const { rows: persisted } = buildPersistedDraftQuoteItemRows({
      lines: rows,
      inventory: [first, second],
    });
    const montaje = persisted.find((r) => r.serviceType === 'MONTAJE_PINTURA');
    expect(montaje?.urlsOrigen).toEqual(['https://cdn.example/fd.jpg']);
    expect(montaje?.urlsOrigen).not.toContain('https://cdn.example/pdi.jpg');
    expect(montaje?.damageItemId).toBe(first.damageItemId);
  });

  it('5. reordenar quoteRows no cambia asociaciones', () => {
    const a = ensureDamageIdentity(
      item({
        pieza: 'FD',
        tratamiento: 'SUSTITUIR',
        treatmentSource: 'vision',
        vehicleId: mazda,
        precioMx: 1800,
        urls_origen: ['https://cdn.example/fd.jpg'],
      }),
    );
    const b = ensureDamageIdentity(
      item({
        pieza: 'PDI',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehicleId: mazda,
        urls_origen: ['https://cdn.example/pdi.jpg'],
      }),
    );
    const rows = quoteRowsFromDamageInventory([a, b], snap({ 'Puerta|DM': 3600 }));
    const reversed = [...rows].reverse();
    const { rows: persisted } = buildPersistedDraftQuoteItemRows({
      lines: reversed,
      inventory: [a, b],
    });
    const montaje = persisted.find((r) => r.serviceType === 'MONTAJE_PINTURA');
    const repair = persisted.find((r) => r.serviceType === 'REPARACION_PINTURA');
    expect(montaje?.urlsOrigen).toEqual(['https://cdn.example/fd.jpg']);
    expect(repair?.urlsOrigen).toEqual(['https://cdn.example/pdi.jpg']);
  });

  it('6. reordenar inventory no cambia asociaciones', () => {
    const a = ensureDamageIdentity(
      item({
        pieza: 'FD',
        tratamiento: 'SUSTITUIR',
        treatmentSource: 'vision',
        vehicleId: mazda,
        precioMx: 1800,
        urls_origen: ['https://cdn.example/fd.jpg'],
      }),
    );
    const b = ensureDamageIdentity(
      item({
        pieza: 'PDI',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehicleId: mazda,
        urls_origen: ['https://cdn.example/pdi.jpg'],
      }),
    );
    const rows = quoteRowsFromDamageInventory([a, b], snap({ 'Puerta|DM': 3600 }));
    const { rows: persisted } = buildPersistedDraftQuoteItemRows({
      lines: rows,
      inventory: [b, a],
    });
    const montaje = persisted.find((r) => r.serviceType === 'MONTAJE_PINTURA');
    expect(montaje?.urlsOrigen).toEqual(['https://cdn.example/fd.jpg']);
    expect(montaje?.damageItemId).toBe(a.damageItemId);
  });

  it('7. mismo DamageItem reconstruido conserva damageItemId', () => {
    const src = item({
      pieza: 'Cofre',
      tratamiento: 'REPARAR',
      treatmentSource: 'vision',
      vehicleId: mazda,
    });
    const first = ensureDamageIdentity(src);
    const second = ensureDamageIdentity(cloneDetectedDamageItem(first));
    expect(second.damageItemId).toBe(first.damageItemId);
    expect(first.damageItemId).toBe(
      createDamageItemId({
        vehicleId: mazda,
        physicalPanelKey: 'Cofre',
      }),
    );
  });

  it('8. mismo serviceType + mismo DamageItem conserva quoteLineId', () => {
    const dmg = ensureDamageIdentity(
      item({
        pieza: 'FD',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehicleId: mazda,
      }),
    );
    const a = quoteRowsFromDamageInventory([dmg], snap());
    const b = quoteRowsFromDamageInventory([cloneDetectedDamageItem(dmg)], snap());
    expect(a[0]?.quoteLineId).toBe(b[0]?.quoteLineId);
    expect(a[0]?.quoteLineId).toBe(
      stampQuoteLineId({
        damageItemId: dmg.damageItemId,
        serviceType: 'REPARACION_PINTURA',
      }),
    );
  });

  it('9. dos vehicleId distintos con la misma pieza generan IDs distintos', () => {
    const a = ensureDamageIdentity(
      item({ pieza: 'Cofre', vehicleId: mazda, tratamiento: 'REPARAR' }),
    );
    const b = ensureDamageIdentity(
      item({ pieza: 'Cofre', vehicleId: versa, tratamiento: 'REPARAR' }),
    );
    expect(a.damageItemId).not.toBe(b.damageItemId);
    const rowsA = quoteRowsFromDamageInventory([a], snap());
    const rowsB = quoteRowsFromDamageInventory([b], snap());
    expect(rowsA[0]?.quoteLineId).not.toBe(rowsB[0]?.quoteLineId);
  });

  it('10. registro legacy sin damageItemId usa fallback posicional controlado', () => {
    const legacyInv: DetectedDamageItem[] = [
      item({
        pieza: 'FD',
        descripcionTecnica: 'histórico',
        urls_origen: ['https://cdn.example/legacy.jpg'],
      }),
    ];
    const resolved = resolveDamageForQuoteRow({
      row: { precioMx: 1000 },
      inventory: legacyInv,
      index: 0,
      log: false,
    });
    expect(resolved.method).toBe('positional_legacy');
    expect(resolved.divergence).toBe('POSITIONAL_FALLBACK_USED');
    expect(resolved.item?.urls_origen).toEqual([
      'https://cdn.example/legacy.jpg',
    ]);
  });

  it('11. objeto moderno sin damageItemId NO usa fallback por índice', () => {
    const modernInv: DetectedDamageItem[] = [
      item({
        pieza: 'FD',
        treatmentSource: 'vision',
        treatmentReason: 'missing_structured_treatment',
        urls_origen: ['https://cdn.example/should-not-attach.jpg'],
      }),
    ];
    const resolved = resolveDamageForQuoteRow({
      row: {
        pieza: 'PDI',
        serviceType: 'REPARACION_PINTURA',
        treatmentSource: 'vision',
      },
      inventory: modernInv,
      index: 0,
      log: false,
    });
    expect(resolved.method).toBe('unresolved');
    expect(resolved.divergence).toBe('MISSING_DAMAGE_ITEM_ID');
    expect(resolved.item).toBeUndefined();
  });

  it('12. persistencia DraftQuoteItem guarda damageItemId/quoteLineId/serviceType', () => {
    const dmg = ensureDamageIdentity(
      item({
        pieza: 'FD',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehicleId: mazda,
        urls_origen: ['https://cdn.example/fd.jpg'],
      }),
    );
    const rows = quoteRowsFromDamageInventory([dmg], snap());
    const { rows: persisted } = buildPersistedDraftQuoteItemRows({
      lines: rows,
      inventory: [dmg],
    });
    expect(persisted[0]?.damageItemId).toBe(dmg.damageItemId);
    expect(persisted[0]?.quoteLineId).toBe(rows[0]?.quoteLineId);
    expect(persisted[0]?.serviceType).toBe('REPARACION_PINTURA');
    expect(persisted[0]?.vehicleId).toBe(mazda);
    expect(typeof persisted[0]?.billable).toBe('boolean');
  });

  it('13. lectura/reconstrucción posterior conserva IDs', () => {
    const src = item({
      pieza: 'Cofre',
      tratamiento: 'SUSTITUIR',
      treatmentSource: 'vision',
      vehicleId: mazda,
      precioMx: 2200,
    });
    const first = quoteRowsFromDamageInventory([ensureDamageIdentity(src)], snap());
    const again = quoteRowsFromDamageInventory(
      [ensureDamageIdentity(cloneDetectedDamageItem(ensureDamageIdentity(src)))],
      snap(),
    );
    expect(again.map((r) => r.damageItemId)).toEqual(
      first.map((r) => r.damageItemId),
    );
    expect(again.map((r) => r.quoteLineId)).toEqual(
      first.map((r) => r.quoteLineId),
    );
  });

  it('14. panel PATCH no borra IDs', () => {
    const dmg = ensureDamageIdentity(
      item({
        pieza: 'FD',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehicleId: mazda,
        urls_origen: ['https://cdn.example/fd.jpg'],
      }),
    );
    const mapped = mapPanelInventoryLinesToItems(
      [
        {
          pieza: 'FD',
          severidad: 'DM',
          precioMx: 3600,
          damageItemId: dmg.damageItemId,
          vehicleId: mazda,
          quoteLineId: createQuoteLineId({
            damageItemId: dmg.damageItemId!,
            serviceType: 'REPARACION_PINTURA',
          }),
          serviceType: 'REPARACION_PINTURA',
        },
      ],
      [dmg],
    );
    expect(mapped[0]?.damageItemId).toBe(dmg.damageItemId);
    expect(mapped[0]?.vehicleId).toBe(mazda);
    expect(mapped[0]?.urls_origen).toEqual(['https://cdn.example/fd.jpg']);
  });

  it('15. fórmulas/precios existentes no cambian', () => {
    const pricingSnap = {
      matchServicio: (s: string) => s,
      getPriceForCanonical: (canonical: string, level: string) =>
        ({
          'Fascia|DL': 2900,
          'Fascia|DM': 3600,
          'Puerta|DL': 3100,
          'Cofre|DM': 5000,
        })[`${canonical}|${level}`] ?? 0,
      getAmount: (pieza: string, level: string) =>
        ({
          'Fascia|DL': 2900,
          'Fascia|DM': 3600,
          'Puerta|DL': 3100,
          'Cofre|DM': 5000,
        })[`${pieza}|${level}`] ?? 0,
      getDiasEntregaForCanonical: () => 5,
      listSeveridadesForCanonical: () => ['DL', 'DM'],
    } as MatrixPricingSnapshot;
    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'FD',
          severidad: 'DM',
          descripcionTecnica: 'Fascia del.',
          urls_origen: [],
        },
        {
          pieza: 'FT',
          severidad: 'DL',
          descripcionTecnica: 'Fascia tras.',
          urls_origen: [],
        },
        {
          pieza: 'PDI',
          severidad: 'DL',
          descripcionTecnica: 'Puerta',
          urls_origen: [],
        },
        {
          pieza: 'Cofre',
          severidad: 'DM',
          descripcionTecnica: 'Cofre',
          urls_origen: [],
        },
      ],
      pricingSnap,
    );
    expect(rows.map((r) => r.pieza)).toEqual(['FD', 'FT', 'PDI', 'Cofre']);
    expect(sumQuoteRowsSubtotal(rows)).toBe(14850);
  });

  it('invariantes modernas: IDs presentes, únicos y referenciados', () => {
    const dmg = ensureDamageIdentity(
      item({
        pieza: 'FD',
        tratamiento: 'SUSTITUIR',
        treatmentSource: 'vision',
        vehicleId: mazda,
        precioMx: 1800,
      }),
    );
    const rows = quoteRowsFromDamageInventory([dmg], snap());
    expect(validateModernQuoteAssociations({ inventory: [dmg], rows })).toEqual(
      [],
    );
    const shadow = adaptCalculatedRowsToCanonicalQuoteV1({
      rows,
      peritajeId: 'per_test',
      quoteId: 'quo_test',
      generatedAt: '2026-09-11T00:00:00.000Z',
    });
    expect(shadow?.lines).toHaveLength(2);
    expect(shadow?.lines.every((l) => l.damageItemId === dmg.damageItemId)).toBe(
      true,
    );
    expect(shadow?.subtotal).toBe(
      rows.filter((r) => r.billable !== false).reduce((a, r) => a + r.precioMx, 0),
    );
  });
});
