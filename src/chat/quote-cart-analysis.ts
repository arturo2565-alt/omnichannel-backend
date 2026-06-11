import {
  coerceDamageLevelCode,
  type DamageLevel,
  damageLevelRank,
} from './autofix-config';
import type { DetectedDamageItem, VehicleDamageAnalysis } from './entities/chat.entity';
import {
  isBanioPinturaCompletoVisionInventory,
  pickVehicleLabelFromDamageInventory,
} from './vision-bpc-inventory';
import {
  findPanelPiezaOption,
  normalizePanelPiezaCode,
} from '../catalog/panel-pieza-catalog';
import {
  mergeDamageInventoryAccumulative,
  piezaLabelFromDraftLineDescription,
  type DamageInventoryMergeResult,
} from './draft-quote-resume';
import type { DraftQuote } from './autofix-config';
import type { DraftQuoteEntity } from './entities/draft-quote.entity';

function pickWorstDamageLevel(levels: string[]): DamageLevel {
  let best: DamageLevel = 'DL';
  for (const raw of levels) {
    const code = coerceDamageLevelCode(raw);
    if (damageLevelRank(code) > damageLevelRank(best)) best = code;
  }
  return best;
}

/** Clave estable por línea del carrito (código panel FD, PDI, …). */
export function inventoryLineKey(pieza: string): string {
  const trimmed = String(pieza ?? '').trim();
  if (!trimmed) return '';
  return normalizePanelPiezaCode(trimmed) || trimmed;
}

export function parseDraftImageUrls(imageUrl: string): string[] {
  const s = String(imageUrl ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((u) => String(u ?? '').trim()).filter(Boolean);
      }
    } catch {
      return [s];
    }
  }
  return [s];
}

export function inventoryItemsToVehicleAnalysis(
  items: DetectedDamageItem[],
  sourceUrls: string[],
): VehicleDamageAnalysis {
  const inv: DetectedDamageItem[] = items.map((it) => ({
    pieza: it.pieza,
    severidad: it.severidad,
    descripcionTecnica: it.descripcionTecnica,
    urls_origen: [...(it.urls_origen ?? [])],
    ...(it.vehiculoDetectado?.trim()
      ? { vehiculoDetectado: it.vehiculoDetectado.trim() }
      : {}),
  }));
  const vehiculoDetectado = pickVehicleLabelFromDamageInventory(inv);
  const partes = [...new Set(inv.map((i) => i.pieza).filter(Boolean))];
  const worst = pickWorstDamageLevel(inv.map((i) => i.severidad));
  const piezaLabel =
    partes.length === 1
      ? partes[0]
      : partes.length > 1
        ? `${partes.slice(0, 2).join(' + ')}${partes.length > 2 ? ` (+${partes.length - 2} más)` : ''}`
        : 'No identificada';
  const desc = inv
    .map(
      (it) =>
        `• ${it.pieza} (${coerceDamageLevelCode(it.severidad)}): ${it.descripcionTecnica}`,
    )
    .join('\n');
  const just = `Inventario unificado (${inv.length} concepto(s) en el carrito de la conversación).`;

  return {
    pieza: piezaLabel,
    severidad: worst,
    severidadDelDano: worst,
    descripcionTecnica: desc,
    justificacion: just,
    partesAfectadas: partes.length ? partes : ['Estetica Exterior'],
    inventory: inv,
    ...(vehiculoDetectado ? { vehiculoDetectado } : {}),
  };
}

/** Agrega o actualiza una línea sin colapsar repeticiones genéricas distintas (FD vs FT). */
export function mergeCartInventoryItem(
  inventory: readonly DetectedDamageItem[],
  incoming: DetectedDamageItem,
): DetectedDamageItem[] {
  const key = inventoryLineKey(incoming.pieza);
  if (!key) return [...inventory];

  const idx = inventory.findIndex((it) => inventoryLineKey(it.pieza) === key);
  if (idx < 0) {
    return [
      ...inventory,
      {
        pieza: incoming.pieza,
        severidad: coerceDamageLevelCode(incoming.severidad),
        descripcionTecnica: String(incoming.descripcionTecnica ?? '').trim(),
        urls_origen: [...(incoming.urls_origen ?? [])],
      },
    ];
  }

  const existing = inventory[idx]!;
  const sevNew = coerceDamageLevelCode(incoming.severidad);
  const sevOld = coerceDamageLevelCode(existing.severidad);
  const worst =
    damageLevelRank(sevNew) > damageLevelRank(sevOld) ? sevNew : sevOld;
  const descParts = [existing.descripcionTecnica, incoming.descripcionTecnica]
    .map((d) => String(d ?? '').trim())
    .filter(Boolean);

  const next = [...inventory];
  next[idx] = {
    pieza: existing.pieza,
    severidad: worst,
    descripcionTecnica: [...new Set(descParts)].join(' | '),
    urls_origen: [
      ...new Set([
        ...(existing.urls_origen ?? []),
        ...(incoming.urls_origen ?? []),
      ]),
    ],
  };
  return next;
}

export function piezaMatchesQuery(pieza: string, query: string): boolean {
  const q = String(query ?? '').trim();
  if (!q) return false;
  const key = inventoryLineKey(pieza);
  const qKey = inventoryLineKey(q);
  if (key && qKey && key === qKey) return true;

  const norm = (s: string) =>
    String(s ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  const np = norm(pieza);
  const nq = norm(q);
  if (np.includes(nq) || nq.includes(np)) return true;

  const opt = findPanelPiezaOption(pieza);
  const qOpt = findPanelPiezaOption(q);
  if (opt && qOpt && opt.code === qOpt.code) return true;
  if (opt && norm(opt.fullName).includes(nq)) return true;
  if (opt && norm(opt.catalogPieza).includes(nq)) return true;
  return false;
}

/** Serializa evidencias visuales para `draft_quotes.imageUrl`. */
export function persistDraftImageUrlField(imageUrls: readonly string[]): string {
  const urls = [
    ...new Set(imageUrls.map((u) => String(u).trim()).filter(Boolean)),
  ];
  if (!urls.length) return '';
  return urls.length === 1 ? urls[0]! : JSON.stringify(urls);
}

/** Inventario previo del borrador activo (visión + chat + express). */
export function extractPriorInventoryFromDraft(
  existingDraft: Pick<
    DraftQuoteEntity,
    'damageAnalysis' | 'quotePayload'
  > | null,
): DetectedDamageItem[] {
  if (!existingDraft) return [];
  const fromAnalysis = existingDraft.damageAnalysis?.inventory;
  if (Array.isArray(fromAnalysis) && fromAnalysis.length > 0) {
    return fromAnalysis.map((it) => ({
      pieza: it.pieza,
      severidad: it.severidad,
      descripcionTecnica: it.descripcionTecnica,
      urls_origen: [...(it.urls_origen ?? [])],
    }));
  }
  const fromBasis = existingDraft.quotePayload?.analysisBasis?.inventory;
  if (Array.isArray(fromBasis) && fromBasis.length > 0) {
    return fromBasis.map((it) => ({
      pieza: it.pieza,
      severidad: it.severidad,
      descripcionTecnica: it.descripcionTecnica,
      urls_origen: [...(it.urls_origen ?? [])],
    }));
  }
  const lines = existingDraft.quotePayload?.lines ?? [];
  if (lines.length > 0) {
    return lines.map((line) => ({
      pieza: piezaLabelFromDraftLineDescription(line.description),
      severidad: 'DL',
      descripcionTecnica: line.description,
      urls_origen: [],
    }));
  }
  return [];
}

export type VisionInventoryMergeResult = {
  mergedInventory: DetectedDamageItem[];
  complementMeta: Pick<
    DamageInventoryMergeResult,
    'previousPiezas' | 'newPiezas'
  > | null;
};

/**
 * Acumula inventario de visión sobre el carrito existente (fotos previas + chat/express).
 * Baño completo (BPC) reemplaza el inventario acumulado, igual que el flujo legacy.
 */
export function mergeVisionIntoPriorInventory(
  priorInventory: readonly DetectedDamageItem[],
  newInventory: readonly DetectedDamageItem[],
): VisionInventoryMergeResult {
  if (isBanioPinturaCompletoVisionInventory(newInventory)) {
    return {
      mergedInventory: newInventory.map((it) => ({
        pieza: it.pieza,
        severidad: it.severidad,
        descripcionTecnica: it.descripcionTecnica,
        urls_origen: [...(it.urls_origen ?? [])],
        ...(it.vehiculoDetectado?.trim()
          ? { vehiculoDetectado: it.vehiculoDetectado.trim() }
          : {}),
      })),
      complementMeta: null,
    };
  }

  if (priorInventory.length > 0) {
    const mergedInv = mergeDamageInventoryAccumulative(
      priorInventory,
      newInventory,
      (raw) => normalizePanelPiezaCode(raw) || raw,
    );
    return {
      mergedInventory: mergedInv.merged,
      complementMeta: {
        previousPiezas: mergedInv.previousPiezas,
        newPiezas: mergedInv.newPiezas,
      },
    };
  }

  return {
    mergedInventory: newInventory.map((it) => ({
      pieza: it.pieza,
      severidad: it.severidad,
      descripcionTecnica: it.descripcionTecnica,
      urls_origen: [...(it.urls_origen ?? [])],
      ...(it.vehiculoDetectado?.trim()
        ? { vehiculoDetectado: it.vehiculoDetectado.trim() }
        : {}),
    })),
    complementMeta: null,
  };
}

export function attachImageUrlToDraftQuote(
  quote: DraftQuote,
  imageUrls: readonly string[],
): DraftQuote & { imageUrl: string } {
  return { ...quote, imageUrl: persistDraftImageUrlField(imageUrls) };
}

/** Convierte filas del panel en inventario persistente del carrito. */
export function mapPanelInventoryLinesToItems(
  linesDto: ReadonlyArray<{
    pieza: string;
    severidad: string;
    descripcionTecnica?: string;
    descripcion?: string;
    detallesRefaccion?: string;
    urls_origen?: string[];
    urls_asociadas?: string[];
  }>,
  prevInv: readonly DetectedDamageItem[],
): DetectedDamageItem[] {
  return linesDto.map((L, i) => {
    const prev = prevInv[i] as DetectedDamageItem & {
      descripcion?: string;
      urls_asociadas?: string[];
    };
    const refaccionDetalle = String(L.detallesRefaccion ?? '').trim();
    const descFromDto =
      refaccionDetalle ||
      (typeof L.descripcionTecnica === 'string' && L.descripcionTecnica.trim()
        ? L.descripcionTecnica.trim()
        : typeof L.descripcion === 'string' && L.descripcion.trim()
          ? L.descripcion.trim()
          : '');
    const desc =
      descFromDto ||
      prev?.descripcionTecnica ||
      prev?.descripcion ||
      (prev
        ? 'Sin descripción técnica disponible.'
        : 'Pieza añadida manualmente desde el panel de cotización.');

    let urls_origen: string[];
    if (Object.prototype.hasOwnProperty.call(L, 'urls_origen')) {
      urls_origen = Array.isArray(L.urls_origen)
        ? L.urls_origen.map(String).filter(Boolean)
        : [];
    } else if (Object.prototype.hasOwnProperty.call(L, 'urls_asociadas')) {
      urls_origen = Array.isArray(L.urls_asociadas)
        ? L.urls_asociadas.map(String).filter(Boolean)
        : [];
    } else {
      urls_origen =
        Array.isArray(prev?.urls_origen) && prev.urls_origen.length > 0
          ? [...prev.urls_origen]
          : Array.isArray(prev?.urls_asociadas) && prev.urls_asociadas.length
            ? [...prev.urls_asociadas]
            : [];
    }

    const panelOpt = findPanelPiezaOption(String(L.pieza).trim());
    return {
      pieza: panelOpt?.code ?? String(L.pieza).trim(),
      severidad: String(L.severidad).trim(),
      descripcionTecnica: desc,
      urls_origen,
    };
  });
}
