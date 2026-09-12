/**
 * AUDITORÍA — no corrige producción.
 * Replay determinista de parse → merge → canonical → persist.
 * No llama al modelo. No exige que STD conserve evidence.
 */
import { parseVisionDamageItems } from './vision-item-normalize';
import { mergeVisionIntoPriorInventory } from './quote-cart-analysis';
import { collapseVisionItemsToBpcIfNeeded } from './vision-bpc-inventory';
import { ensureDamageIdentity } from './piece-treatment';
import {
  quoteRowsFromDamageInventory,
  sumQuoteRowsSubtotal,
} from './draft-quote-inventory-pricing';
import { buildPersistedDraftQuoteItemRows } from './quote-line-identity';
import {
  createEvidenceId,
  createVehicleId,
  peritajeFromLegacyAnalysis,
} from '../domain/peritaje-v1';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';

const PHOTO = 'photo-1';

function urlsOf(items: readonly { pieza?: string; urls_origen?: string[] }[]) {
  const by = (code: string) =>
    items.find((it) => String(it.pieza).toUpperCase() === code)?.urls_origen ??
    [];
  return {
    PTD: by('PTD'),
    STD: by('STD'),
    PDD: by('PDD'),
  };
}

function snap(): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: () => 3250,
    getAmount: () => 3250,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DM'],
  } as MatrixPricingSnapshot;
}

function trace(label: string, raw: unknown) {
  const mazda = createVehicleId({ displayLabel: 'Mazda 3 2020' });
  const rows: Array<{
    etapa: string;
    PTD: string;
    STD: string;
    PDD: string;
    perdida: string;
  }> = [];

  const mark = (
    etapa: string,
    ptd: unknown,
    std: unknown,
    pdd: unknown,
    prev?: { PTD: unknown; STD: unknown; PDD: unknown },
  ) => {
    const fmt = (v: unknown) =>
      Array.isArray(v) && v.length ? JSON.stringify(v) : '—';
    const lost: string[] = [];
    if (prev) {
      for (const [k, cur] of [
        ['PTD', ptd],
        ['STD', std],
        ['PDD', pdd],
      ] as const) {
        const before = prev[k];
        const had = Array.isArray(before) && before.length > 0;
        const has = Array.isArray(cur) && cur.length > 0;
        if (had && !has) lost.push(k);
      }
    }
    rows.push({
      etapa,
      PTD: fmt(ptd),
      STD: fmt(std),
      PDD: fmt(pdd),
      perdida: lost.length ? lost.join(',') : 'no',
    });
  };

  const parsed = parseVisionDamageItems(raw);
  const u0 = urlsOf(
    (raw as { items: Array<{ pieza: string; urls_origen: string[] }> }).items,
  );
  mark('A. raw Vision JSON', u0.PTD, u0.STD, u0.PDD);
  const u1 = urlsOf(parsed);
  mark('C. parseVisionDamageItems', u1.PTD, u1.STD, u1.PDD, u0);

  const collapsed = collapseVisionItemsToBpcIfNeeded(parsed, '', {});
  const identified = collapsed.map((it) =>
    ensureDamageIdentity({
      ...it,
      vehicleId: it.vehicleId || mazda,
      tratamiento: it.tratamiento || 'REPARAR',
    }),
  );
  const u2 = urlsOf(identified);
  mark('E. newInventory + identity', u2.PTD, u2.STD, u2.PDD, u1);

  const merged = mergeVisionIntoPriorInventory([], identified);
  const u3 = urlsOf(merged.mergedInventory);
  mark('F. mergeVisionInventory', u3.PTD, u3.STD, u3.PDD, u2);

  const peritaje = peritajeFromLegacyAnalysis({
    conversationId: 'audit_conv',
    analysis: { inventory: merged.mergedInventory },
  });
  const evOf = (code: string) =>
    peritaje.damages
      .filter((d) => d.pieceCode === code)
      .flatMap((d) => d.evidence.map((e) => e.url));
  const u4 = { PTD: evOf('PTD'), STD: evOf('STD'), PDD: evOf('PDD') };
  mark('G. CanonicalPeritajeV1', u4.PTD, u4.STD, u4.PDD, u3);

  const quoteRows = quoteRowsFromDamageInventory(
    merged.mergedInventory as DetectedDamageItem[],
    snap(),
  );
  const { rows: persisted } = buildPersistedDraftQuoteItemRows({
    lines: quoteRows,
    inventory: merged.mergedInventory,
  });
  const persistUrls = (code: string) =>
    persisted.find((r) => r.pieza === code)?.urlsOrigen ?? [];
  const u5 = {
    PTD: persistUrls('PTD'),
    STD: persistUrls('STD'),
    PDD: persistUrls('PDD'),
  };
  mark('I. DraftQuoteItem persist (sin fallback)', u5.PTD, u5.STD, u5.PDD, u4);

  const { rows: persistedFb } = buildPersistedDraftQuoteItemRows({
    lines: quoteRows,
    inventory: merged.mergedInventory,
    fallbackUrls: [PHOTO],
  });
  const persistFb = (code: string) =>
    persistedFb.find((r) => r.pieza === code)?.urlsOrigen ?? [];
  mark(
    'I2. DraftQuoteItem + fallback 1 URL',
    persistFb('PTD'),
    persistFb('STD'),
    persistFb('PDD'),
    u5,
  );

  console.log(`\n===== AUDIT ${label} =====`);
  console.table(rows);
  console.log('identity', {
    damages: peritaje.damages.map((d) => ({
      pieceCode: d.pieceCode,
      damageItemId: d.damageItemId,
      evidenceIds: d.evidence.map((e) => e.evidenceId),
      urls: d.evidence.map((e) => e.url),
    })),
    quoteLines: quoteRows.map((r) => ({
      pieza: r.pieza,
      damageItemId: r.damageItemId,
      quoteLineId: r.quoteLineId,
      serviceType: r.serviceType,
    })),
    persisted: persisted.map((r) => ({
      pieza: r.pieza,
      damageItemId: r.damageItemId,
      quoteLineId: r.quoteLineId,
      urlsOrigen: r.urlsOrigen,
    })),
    sameEvidenceIdForPhoto: createEvidenceId({ url: PHOTO }),
    subtotal: sumQuoteRowsSubtotal(quoteRows),
  });

  return { rows, persisted, peritaje };
}

describe('AUDIT evidence association (no corrección)', () => {
  it('replay: Vision envió photo-1 en PTD+STD+PDD', () => {
    trace('VISION_SHARED_URL', {
      items: [
        { pieza: 'PTD', severidad: 'DM', urls_origen: [PHOTO] },
        { pieza: 'STD', severidad: 'DM', urls_origen: [PHOTO] },
        { pieza: 'PDD', severidad: 'DM', urls_origen: [PHOTO] },
      ],
    });
  });

  it('replay: Vision envió photo-1 solo en PTD (STD/PDD vacíos)', () => {
    trace('VISION_FIRST_ITEM_ONLY', {
      items: [
        { pieza: 'PTD', severidad: 'DM', urls_origen: [PHOTO] },
        { pieza: 'STD', severidad: 'DM', urls_origen: [] },
        { pieza: 'PDD', severidad: 'DM', urls_origen: [] },
      ],
    });
  });
});
