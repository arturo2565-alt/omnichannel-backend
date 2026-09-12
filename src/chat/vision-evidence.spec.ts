import {
  applyVisionEvidenceRules,
  EVIDENCE_EVENTS,
} from './vision-evidence';
import { parseVisionDamageItems } from './vision-item-normalize';
import {
  buildPersistedDraftQuoteItemRows,
  resolveDamageForQuoteRow,
} from './quote-line-identity';
import {
  cloneDetectedDamageItem,
  ensureDamageIdentity,
} from './piece-treatment';
import {
  quoteRowsFromDamageInventory,
  sumQuoteRowsSubtotal,
} from './draft-quote-inventory-pricing';
import {
  createEvidenceId,
  mergeDamageEvidence,
  peritajeFromLegacyAnalysis,
} from '../domain/peritaje-v1';
import { createVehicleId } from '../domain/peritaje-v1';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';

const PHOTO = 'https://cdn.example/lado-derecho.jpg';
const PHOTO_B = 'https://cdn.example/otra.jpg';
const PHOTO_C = 'https://cdn.example/tercera.jpg';

function snap(): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: () => 3250,
    getAmount: () => 3250,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DM'],
  } as MatrixPricingSnapshot;
}

function visionItem(
  pieza: string,
  urls: string[],
): Record<string, unknown> {
  return {
    pieza,
    severidad: 'DM',
    descripcionTecnica: pieza,
    tipo_dano: 'REPARACION',
    requiere_refaccion: false,
    urls_origen: urls,
  };
}

function parsePtdStd(ptdUrls: string[], stdUrls: string[]) {
  return parseVisionDamageItems({
    items: [visionItem('PTD', ptdUrls), visionItem('STD', stdUrls)],
  });
}

describe('visión evidence — single/multi image, persistencia y merge', () => {
  const mazda = createVehicleId({ displayLabel: 'Mazda 3 2020' });

  it('1. 1 imagen → PTD + STD con la misma urls_origen conservan evidence', () => {
    const parsed = parsePtdStd([PHOTO], [PHOTO]);
    const { items, events } = applyVisionEvidenceRules(parsed, [PHOTO]);
    expect(items.map((it) => it.urls_origen)).toEqual([[PHOTO], [PHOTO]]);
    const peritaje = peritajeFromLegacyAnalysis({
      conversationId: 'c1',
      analysis: { inventory: items },
    });
    expect(peritaje.damages).toHaveLength(2);
    expect(peritaje.damages.every((d) => d.evidence[0]?.url === PHOTO)).toBe(
      true,
    );
    expect(
      events.filter((e) => e.event === EVIDENCE_EVENTS.UNKNOWN_INPUT_URL),
    ).toEqual([]);
  });

  it('2b. una imagen + tres items vacíos → los tres reciben la URL', () => {
    const parsed = parseVisionDamageItems({
      items: [
        visionItem('PTD', []),
        visionItem('STD', []),
        visionItem('PDD', []),
      ],
    });
    const { items } = applyVisionEvidenceRules(parsed, [PHOTO]);
    expect(items.map((it) => it.urls_origen)).toEqual([
      [PHOTO],
      [PHOTO],
      [PHOTO],
    ]);
  });

  it('2c. un item ya tiene URL → no se duplica', () => {
    const parsed = parsePtdStd([PHOTO], []);
    const { items } = applyVisionEvidenceRules(parsed, [PHOTO]);
    expect(items[0]?.urls_origen).toEqual([PHOTO]);
    expect(items[1]?.urls_origen).toEqual([PHOTO]);
  });

  it('2. 1 imagen → segundo item sin urls_origen recupera la única URL', () => {
    const parsed = parsePtdStd([PHOTO], []);
    expect(parsed[1]?.urls_origen).toEqual([]);
    const { items } = applyVisionEvidenceRules(parsed, [PHOTO]);
    expect(items[0]?.urls_origen).toEqual([PHOTO]);
    expect(items[1]?.urls_origen).toEqual([PHOTO]);
  });

  it('3. recovery genera EVIDENCE_RECOVERED_SINGLE_INPUT', () => {
    const parsed = parsePtdStd([], []);
    const { events } = applyVisionEvidenceRules(parsed, [PHOTO], {
      conversationId: 'conv_audit',
      visionRunId: 'visrun_test',
    });
    const recovered = events.filter(
      (e) => e.event === EVIDENCE_EVENTS.EVIDENCE_RECOVERED_SINGLE_INPUT,
    );
    expect(recovered).toHaveLength(2);
    expect(recovered.map((e) => e.pieceCode).sort()).toEqual(['PTD', 'STD']);
    expect(recovered.every((e) => e.url === PHOTO)).toBe(true);
    expect(recovered.every((e) => e.cantidadInputImages === 1)).toBe(true);
    expect(recovered.every((e) => e.conversationId === 'conv_audit')).toBe(
      true,
    );
    expect(recovered.every((e) => e.visionRunId === 'visrun_test')).toBe(true);
  });

  it('4. 3 imágenes → item sin urls NO recibe las 3', () => {
    const parsed = parsePtdStd([PHOTO], []);
    const { items } = applyVisionEvidenceRules(parsed, [
      PHOTO,
      PHOTO_B,
      PHOTO_C,
    ]);
    expect(items[0]?.urls_origen).toEqual([PHOTO]);
    expect(items[1]?.urls_origen).toEqual([]);
  });

  it('5. multi-image missing → EVIDENCE_MISSING_FROM_VISION', () => {
    const parsed = parsePtdStd([PHOTO], []);
    const { events } = applyVisionEvidenceRules(parsed, [PHOTO, PHOTO_B]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: EVIDENCE_EVENTS.EVIDENCE_MISSING_FROM_VISION,
          pieceCode: 'STD',
          cantidadInputImages: 2,
        }),
      ]),
    );
    expect(
      events.some(
        (e) => e.event === EVIDENCE_EVENTS.EVIDENCE_RECOVERED_SINGLE_INPUT,
      ),
    ).toBe(false);
  });

  it('6. misma URL en tres daños puede pertenecer a los tres', () => {
    const parsed = parseVisionDamageItems({
      items: [
        visionItem('PTD', [PHOTO]),
        visionItem('STD', [PHOTO]),
        visionItem('ED', [PHOTO]),
      ],
    });
    const { items } = applyVisionEvidenceRules(parsed, [PHOTO]);
    expect(items.every((it) => it.urls_origen[0] === PHOTO)).toBe(true);
    const peritaje = peritajeFromLegacyAnalysis({
      conversationId: 'c1',
      analysis: { inventory: items },
    });
    expect(peritaje.damages).toHaveLength(3);
    expect(new Set(peritaje.damages.map((d) => d.damageItemId)).size).toBe(3);
    expect(peritaje.damages.every((d) => d.evidence[0]?.url === PHOTO)).toBe(
      true,
    );
  });

  it('7. misma URL repetida en un DamageItem → una sola DamageEvidence', () => {
    const item = peritajeFromLegacyAnalysis({
      conversationId: 'c1',
      analysis: {
        inventory: [
          {
            pieza: 'PTD',
            severidad: 'DM',
            urls_origen: [PHOTO, PHOTO, PHOTO],
            tratamiento: 'REPARAR',
          },
        ],
      },
    }).damages[0]!;
    expect(item.evidence).toHaveLength(1);
    expect(item.evidence[0]?.evidenceId).toBe(createEvidenceId({ url: PHOTO }));
  });

  it('8. nueva foto del mismo DamageItem acumula evidence anterior + nueva', () => {
    const prior = mergeDamageEvidence([], [PHOTO], 'msg-1');
    const next = mergeDamageEvidence(prior, [PHOTO_B], 'msg-2');
    expect(next.map((e) => e.url)).toEqual([PHOTO, PHOTO_B]);
    const again = mergeDamageEvidence(next, [PHOTO], 'msg-3');
    expect(again).toHaveLength(2);
    expect(again[0]?.evidenceId).toBe(prior[0]?.evidenceId);
  });

  it('9. persistencia/reload: evidence sigue ligado al damageItemId', () => {
    const parsed = parsePtdStd([PHOTO], []);
    const recovered = applyVisionEvidenceRules(parsed, [PHOTO]).items;
    const inventory = recovered.map((it) =>
      ensureDamageIdentity({ ...it, vehicleId: mazda, tratamiento: 'REPARAR' }),
    );
    const rows = quoteRowsFromDamageInventory(inventory, snap());
    const { rows: persisted } = buildPersistedDraftQuoteItemRows({
      lines: rows,
      inventory,
    });
    for (const dmg of inventory) {
      const resolved = resolveDamageForQuoteRow({
        row: { damageItemId: dmg.damageItemId },
        inventory,
        index: 99,
        log: false,
      });
      expect(resolved.method).toBe('identity');
      expect(resolved.item?.urls_origen).toEqual([PHOTO]);
      expect(
        persisted.find((p) => p.damageItemId === dmg.damageItemId)?.urlsOrigen,
      ).toEqual([PHOTO]);
    }
  });

  it('10. DraftQuoteItem / panel: PTD y STD muestran la misma foto', () => {
    const parsed = parsePtdStd([PHOTO], []);
    const recovered = applyVisionEvidenceRules(parsed, [PHOTO]).items;
    const inventory = recovered.map((it) =>
      ensureDamageIdentity({ ...it, vehicleId: mazda, tratamiento: 'REPARAR' }),
    );
    const rows = quoteRowsFromDamageInventory(inventory, snap());
    const { rows: persisted } = buildPersistedDraftQuoteItemRows({
      lines: rows,
      inventory,
    });
    const ptd = persisted.find((r) => r.pieza === 'PTD');
    const std = persisted.find((r) => r.pieza === 'STD');
    expect(ptd?.urlsOrigen).toEqual([PHOTO]);
    expect(std?.urlsOrigen).toEqual([PHOTO]);
    expect(ptd?.urlsOrigen).toEqual(std?.urlsOrigen);
  });

  it('11. reordenar DamageItems/QuoteLines no altera evidence', () => {
    const parsed = parsePtdStd([PHOTO], [PHOTO]);
    const recovered = applyVisionEvidenceRules(parsed, [PHOTO]).items;
    const inventory = recovered.map((it) =>
      ensureDamageIdentity({ ...it, vehicleId: mazda, tratamiento: 'REPARAR' }),
    );
    const rows = quoteRowsFromDamageInventory(inventory, snap());
    const reversedLines = [...rows].reverse();
    const reversedInv = [...inventory].reverse();
    const { rows: persisted } = buildPersistedDraftQuoteItemRows({
      lines: reversedLines,
      inventory: reversedInv,
    });
    expect(
      persisted.find((p) => p.pieza === 'PTD')?.urlsOrigen,
    ).toEqual([PHOTO]);
    expect(
      persisted.find((p) => p.pieza === 'STD')?.urlsOrigen,
    ).toEqual([PHOTO]);
  });

  it('12. total y precios no cambian tras recovery de evidence', () => {
    const raw: DetectedDamageItem[] = parsePtdStd([], []).map((it) => ({
      ...it,
      tratamiento: 'REPARAR',
      vehicleId: mazda,
    }));
    const before = quoteRowsFromDamageInventory(
      raw.map((it) => ensureDamageIdentity(cloneDetectedDamageItem(it))),
      snap(),
    );
    const recovered = applyVisionEvidenceRules(raw, [PHOTO]).items;
    const after = quoteRowsFromDamageInventory(
      recovered.map((it) => ensureDamageIdentity(cloneDetectedDamageItem(it))),
      snap(),
    );
    expect(sumQuoteRowsSubtotal(after)).toBe(sumQuoteRowsSubtotal(before));
    expect(after.map((r) => r.precioMx)).toEqual(before.map((r) => r.precioMx));
    expect(after.map((r) => r.tratamiento)).toEqual(
      before.map((r) => r.tratamiento),
    );
  });

  it('URL inventada por Vision no se confía (UNKNOWN_INPUT_URL)', () => {
    const fake = 'https://evil.example/inventada.jpg';
    const parsed = parsePtdStd([fake], []);
    const { items, events } = applyVisionEvidenceRules(parsed, [PHOTO]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: EVIDENCE_EVENTS.UNKNOWN_INPUT_URL,
          url: fake,
        }),
        expect.objectContaining({
          event: EVIDENCE_EVENTS.EVIDENCE_RECOVERED_SINGLE_INPUT,
          pieceCode: 'PTD',
          url: PHOTO,
        }),
      ]),
    );
    expect(items.every((it) => it.urls_origen[0] === PHOTO)).toBe(true);
    expect(items.every((it) => !it.urls_origen.includes(fake))).toBe(true);
  });
});
