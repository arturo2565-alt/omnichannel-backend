import {
  compareCanonicalVsLegacyFinance,
  createQuoteLineId,
  createVehicleId,
  damageItemFromLegacy,
  peritajeFromLegacyAnalysis,
  resolveModernVehicleIdentity,
  vehicleIdentityFromLegacyLabel,
} from '../domain/peritaje-v1';
import {
  buildCanonicalQuoteV1,
  projectCanonicalQuoteOntoDraft,
} from './canonical-quote-engine';
import {
  stampInventoryFromCanonicalPeritaje,
} from './canonical-identity';
import {
  buildPersistedDraftQuoteItemRows,
  resolveDamageForQuoteRow,
  shouldUseLegacyPositionalPersist,
} from './quote-line-identity';
import { applyVisionEvidenceRules } from './vision-evidence';
import {
  canonicalPhysicalPanelKey,
  ensureDamageIdentity,
} from './piece-treatment';
import { quoteRowsFromDamageInventory } from './draft-quote-inventory-pricing';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import type { DraftQuote } from './autofix-config';
import type { CanonicalPeritajeV1 } from '../domain/peritaje-v1';

const PHOTO = 'https://cdn.example/avanza-fd.jpg';

function snap(amount = 3350): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: () => amount,
    getAmount: () => amount,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DL', 'DM', 'DMFuerte', 'BASE', 'Mediano'],
    serviciosOrderedLongestFirst: ['Fascia', 'FD'],
  } as MatrixPricingSnapshot;
}

function item(
  overrides: Partial<DetectedDamageItem> & Pick<DetectedDamageItem, 'pieza'>,
): DetectedDamageItem {
  return {
    severidad: 'DM',
    descripcionTecnica: 'golpe',
    urls_origen: [PHOTO],
    tratamiento: 'REPARAR',
    treatmentSource: 'vision',
    ...overrides,
  };
}

function avanzaInventory(
  extra: Partial<DetectedDamageItem> = {},
): DetectedDamageItem[] {
  return [
    item({
      pieza: 'FD',
      vehiculoDetectado: 'Toyota Avanza',
      ...extra,
    }),
  ];
}

function avanzaPeritaje(
  inventory = avanzaInventory(),
): CanonicalPeritajeV1 {
  return peritajeFromLegacyAnalysis({
    conversationId: 'c_avanza',
    tallerId: 't1',
    peritajeId: 'per_avanza',
    now: '2026-09-12T00:00:00.000Z',
    canonicalizePanel: canonicalPhysicalPanelKey,
    analysis: {
      vehiculoDetectado: 'Toyota Avanza',
      inventory,
    },
  });
}

function emptyDraft(): DraftQuote {
  return {
    status: 'PENDING_APPROVAL',
    currency: 'MXN',
    reference: 'COT-AVANZA',
    generatedAt: '2026-09-12T00:00:00.000Z',
    lines: [],
    subtotal: 0,
    total: 0,
    formalNarrative: 'Estimado cliente,',
    analysisBasis: {
      pieza: 'FD',
      severidad: 'DM',
      partesAfectadas: ['FD'],
      severidadDelDano: 'DM',
      descripcionTecnica: '',
      justificacion: '',
    },
  };
}

describe('identidad canónica — stamp y persistencia', () => {
  it('1-3. VehicleIdentity e inventory usan el mismo vehicleId (Toyota Avanza)', () => {
    const structured = resolveModernVehicleIdentity('Toyota Avanza');
    const fromLabel = vehicleIdentityFromLegacyLabel('Toyota Avanza');
    expect(structured.vehicleId).toBe(fromLabel.vehicleId);
    expect(structured.vehicleId).not.toBe(
      createVehicleId({ displayLabel: 'Toyota Avanza' }),
    );

    const peritaje = avanzaPeritaje();
    const stamped = stampInventoryFromCanonicalPeritaje(
      avanzaInventory(),
      peritaje,
    );
    expect(stamped[0]?.vehicleId).toBe(peritaje.vehicles[0]?.vehicleId);
    expect(stamped[0]?.damageItemId).toBe(peritaje.damages[0]?.damageItemId);
    expect(ensureDamageIdentity(stamped[0]!).damageItemId).toBe(
      peritaje.damages[0]?.damageItemId,
    );
  });

  it('4-5. QuoteLine y proyección conservan damageItemId/quoteLineId canónicos', () => {
    const inventory = stampInventoryFromCanonicalPeritaje(
      avanzaInventory(),
      avanzaPeritaje(),
    );
    const peritaje = avanzaPeritaje(inventory);
    const built = buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: inventory,
      snap: snap(),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const line = built.quote.lines[0]!;
    expect(line.damageItemId).toBe(peritaje.damages[0]?.damageItemId);
    expect(line.quoteLineId).toBe(
      createQuoteLineId({
        damageItemId: line.damageItemId,
        serviceType: 'REPARACION_PINTURA',
      }),
    );
    const projected = projectCanonicalQuoteOntoDraft(
      emptyDraft(),
      built.quote,
      snap(),
      built.rows,
    );
    expect(projected.lines[0]?.damageItemId).toBe(line.damageItemId);
    expect(projected.lines[0]?.quoteLineId).toBe(line.quoteLineId);
  });

  it('6-9. persistencia canónica: evidence + sin ORPHAN', () => {
    const peritaje = avanzaPeritaje();
    const inventory = stampInventoryFromCanonicalPeritaje(
      avanzaInventory(),
      peritaje,
    );
    const ql = createQuoteLineId({
      damageItemId: peritaje.damages[0]!.damageItemId,
      serviceType: 'REPARACION_PINTURA',
    });
    const resolved = resolveDamageForQuoteRow({
      row: {
        damageItemId: peritaje.damages[0]!.damageItemId,
        quoteLineId: ql,
      },
      inventory,
      index: 0,
      canonicalPeritaje: peritaje,
      log: false,
    });
    expect(resolved.method).toBe('canonical_identity');
    expect(resolved.divergence).toBeUndefined();

    const { rows, divergences } = buildPersistedDraftQuoteItemRows({
      lines: [
        {
          damageItemId: peritaje.damages[0]!.damageItemId,
          quoteLineId: ql,
          serviceType: 'REPARACION_PINTURA',
          pieza: 'FD',
          subtotal: 3350,
        },
      ],
      inventory: [{ ...inventory[0]!, urls_origen: [] }],
      fallbackUrls: ['https://cdn.example/should-not-use.jpg'],
      canonicalPeritaje: peritaje,
    });
    expect(divergences.filter((d) => d.code === 'ORPHAN_QUOTE_LINE')).toEqual([]);
    expect(rows[0]?.damageItemId).toBe(peritaje.damages[0]?.damageItemId);
    expect(rows[0]?.quoteLineId).toBe(ql);
    expect(rows[0]?.urlsOrigen).toEqual([PHOTO]);
  });

  it('8. ChatView recibe urlsOrigen (forma DTO DraftQuoteItem)', () => {
    const peritaje = avanzaPeritaje();
    const { rows } = buildPersistedDraftQuoteItemRows({
      lines: [
        {
          damageItemId: peritaje.damages[0]!.damageItemId,
          quoteLineId: createQuoteLineId({
            damageItemId: peritaje.damages[0]!.damageItemId,
            serviceType: 'REPARACION_PINTURA',
          }),
          serviceType: 'REPARACION_PINTURA',
          subtotal: 3350,
        },
      ],
      inventory: avanzaInventory(),
      canonicalPeritaje: peritaje,
    });
    const dto = {
      damageItemId: rows[0]?.damageItemId,
      quoteLineId: rows[0]?.quoteLineId,
      urlsOrigen: rows[0]?.urlsOrigen,
    };
    expect(Array.isArray(dto.urlsOrigen) && dto.urlsOrigen.length).toBe(1);
  });

  it('10. canonical_vs_legacy no inventa MISSING+EXTRA por IDs distintos', () => {
    const inventory = stampInventoryFromCanonicalPeritaje(
      avanzaInventory(),
      avanzaPeritaje(),
    );
    const peritaje = avanzaPeritaje(inventory);
    const built = buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: inventory,
      snap: snap(),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const legacyRows = quoteRowsFromDamageInventory(inventory, snap());
    const diffs = compareCanonicalVsLegacyFinance({
      canonical: built.quote,
      legacy: {
        total: built.quote.total,
        subtotal: built.quote.subtotal,
        isPartial: built.quote.isPartial,
        lines: legacyRows.map((r) => ({
          quoteLineId: r.quoteLineId,
          serviceType: r.serviceType,
          billable: r.billable,
          amount: r.precioMx,
        })),
      },
    });
    expect(diffs.filter((d) => d.type === 'MISSING_CANONICAL_LINE')).toEqual([]);
    expect(diffs.filter((d) => d.type === 'EXTRA_LEGACY_LINE')).toEqual([]);
  });

  it('11. reordenar inventory no afecta asociación', () => {
    const ptd = item({ pieza: 'PTD', vehiculoDetectado: 'Toyota Avanza' });
    const fd = item({ pieza: 'FD', vehiculoDetectado: 'Toyota Avanza' });
    const peritaje = peritajeFromLegacyAnalysis({
      conversationId: 'c1',
      canonicalizePanel: canonicalPhysicalPanelKey,
      analysis: { vehiculoDetectado: 'Toyota Avanza', inventory: [fd, ptd] },
    });
    const stamped = stampInventoryFromCanonicalPeritaje([ptd, fd], peritaje);
    const fdId = peritaje.damages.find((d) => d.pieceCode === 'FD')!.damageItemId;
    const { rows } = buildPersistedDraftQuoteItemRows({
      lines: [
        {
          damageItemId: fdId,
          quoteLineId: createQuoteLineId({
            damageItemId: fdId,
            serviceType: 'REPARACION_PINTURA',
          }),
          serviceType: 'REPARACION_PINTURA',
          subtotal: 3350,
        },
      ],
      inventory: stamped,
      canonicalPeritaje: peritaje,
    });
    expect(rows[0]?.damageItemId).toBe(fdId);
    expect(rows[0]?.urlsOrigen).toEqual([PHOTO]);
  });

  it('12. mismo panel en dos vehículos no colisiona', () => {
    const avanza = resolveModernVehicleIdentity('Toyota Avanza');
    const mazda = resolveModernVehicleIdentity('Mazda 3 2020');
    const a = damageItemFromLegacy(
      { pieza: 'FD', severidad: 'DM', urls_origen: [PHOTO], tratamiento: 'REPARAR' },
      { vehicleId: avanza.vehicleId, canonicalizePanel: canonicalPhysicalPanelKey },
    );
    const b = damageItemFromLegacy(
      { pieza: 'FD', severidad: 'DM', urls_origen: [PHOTO], tratamiento: 'REPARAR' },
      { vehicleId: mazda.vehicleId, canonicalizePanel: canonicalPhysicalPanelKey },
    );
    expect(a.damageItemId).not.toBe(b.damageItemId);
    expect(a.physicalPanelKey).toBe(b.physicalPanelKey);
  });

  it('13. multi-vehículo sin identidad no se empareja por pieceCode', () => {
    const avanza = resolveModernVehicleIdentity('Toyota Avanza');
    const mazda = resolveModernVehicleIdentity('Mazda 3 2020');
    const peritaje: CanonicalPeritajeV1 = {
      ...avanzaPeritaje(),
      vehicles: [avanza, mazda],
      damages: [
        damageItemFromLegacy(
          { pieza: 'FD', severidad: 'DM', urls_origen: [PHOTO], tratamiento: 'REPARAR' },
          { vehicleId: avanza.vehicleId, canonicalizePanel: canonicalPhysicalPanelKey },
        ),
        damageItemFromLegacy(
          { pieza: 'FD', severidad: 'DM', urls_origen: [PHOTO], tratamiento: 'REPARAR' },
          { vehicleId: mazda.vehicleId, canonicalizePanel: canonicalPhysicalPanelKey },
        ),
      ],
    };
    const stamped = stampInventoryFromCanonicalPeritaje(
      [item({ pieza: 'FD', urls_origen: [PHOTO], tratamiento: 'REPARAR' })],
      peritaje,
    );
    expect(stamped[0]?.damageItemId).toBeUndefined();
  });

  it('14. legacy histórico sigue usando persistencia posicional', () => {
    const legacyInv = [
      {
        pieza: 'FD',
        severidad: 'DM',
        descripcionTecnica: 'golpe',
        urls_origen: [PHOTO],
      },
    ];
    const lines = [{ subtotal: 1000 }];
    expect(shouldUseLegacyPositionalPersist(lines, legacyInv)).toBe(true);
  });

  it('15. single-image recovery sigue funcionando', () => {
    const parsed = [
      item({ pieza: 'FD', urls_origen: [], vehiculoDetectado: 'Toyota Avanza' }),
    ];
    const { items, events } = applyVisionEvidenceRules(parsed, [PHOTO]);
    expect(items[0]?.urls_origen).toEqual([PHOTO]);
    expect(events.some((e) => e.event === 'EVIDENCE_RECOVERED_SINGLE_INPUT')).toBe(
      true,
    );
  });

  it('16-J. Toyota Avanza FD REPARAR conserva $3,350 y treatment', () => {
    const inventory = stampInventoryFromCanonicalPeritaje(
      avanzaInventory(),
      avanzaPeritaje(),
    );
    const peritaje = avanzaPeritaje(inventory);
    expect(peritaje.damages[0]?.treatment).toBe('REPARAR');
    const built = buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: inventory,
      snap: snap(3350),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(peritaje.damages[0]?.treatment).toBe('REPARAR');
    expect(inventory[0]?.tratamiento).toBe('REPARAR');
    const { rows } = buildPersistedDraftQuoteItemRows({
      lines: [
        {
          damageItemId: peritaje.damages[0]!.damageItemId,
          quoteLineId: built.quote.lines[0]!.quoteLineId,
          serviceType: 'REPARACION_PINTURA',
          subtotal: 3350,
        },
      ],
      inventory,
      canonicalPeritaje: peritaje,
    });
    expect(rows[0]?.precioMx).toBe(3350);
    expect(rows[0]?.damageItemId).toBe(peritaje.damages[0]?.damageItemId);
  });
});
