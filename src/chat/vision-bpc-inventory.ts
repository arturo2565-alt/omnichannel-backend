import type { DetectedDamageItem } from './entities/chat.entity';
import { coerceDamageLevelCode, damageLevelRank, type DamageLevel } from './autofix-config';
import { flattenBañoTierSource, inferBañoTierSeveridad } from './instant-quote-from-text';

export const VISION_BPC_PIEZA_CODE = 'BPC';

const BPC_PIEZA_ALIASES = new Set([
  'bpc',
  'bano de pintura completo',
  'bano pintura completo',
  'bano completo',
  'bano integral',
  'pintura exterior completa',
  'baño de pintura completo',
  'baño pintura completo',
  'baño completo',
]);

function normalizePiezaKey(pieza: string): string {
  return String(pieza ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function isVisionBpcPiezaCode(pieza: string): boolean {
  const key = normalizePiezaKey(pieza);
  if (!key) return false;
  if (BPC_PIEZA_ALIASES.has(key)) return true;
  return key === 'bpc' || /\bbpc\b/.test(key);
}

export function visionJsonIndicatesBanioCompleto(root: unknown): boolean {
  if (!root || typeof root !== 'object') return false;
  const o = root as Record<string, unknown>;
  const flag = o['intencion_banio_completo_detectada'];
  if (flag === true || flag === 'true' || flag === 1 || flag === '1') {
    return true;
  }
  if (typeof flag === 'string' && /^(si|sí|yes|true|1)$/i.test(flag.trim())) {
    return true;
  }
  return false;
}

export function visionItemsIndicateBanioCompleto(
  items: readonly DetectedDamageItem[],
  visionRoot?: unknown,
): boolean {
  if (visionJsonIndicatesBanioCompleto(visionRoot)) return true;
  return items.some((it) => isVisionBpcPiezaCode(it.pieza));
}

function pickWorstBodyworkLevel(levels: string[]): DamageLevel | null {
  const codes = levels
    .map((s) => coerceDamageLevelCode(String(s ?? '').trim()))
    .filter((c) => c !== 'N/A');
  if (!codes.length) return null;
  let worst = codes[0]!;
  for (let i = 1; i < codes.length; i++) {
    if (damageLevelRank(codes[i]!) > damageLevelRank(worst)) worst = codes[i]!;
  }
  return worst;
}

/** Severidad hojalatería media/alta (DM o peor) para disclaimer en baño completo. */
export function banioCompletoNeedsHeavyBodyworkDisclaimer(
  items: readonly DetectedDamageItem[],
): boolean {
  const levels = items
    .filter((it) => !isVisionBpcPiezaCode(it.pieza))
    .map((it) => it.severidad);
  const worst = pickWorstBodyworkLevel(levels);
  if (worst && damageLevelRank(worst) >= damageLevelRank('DM')) return true;
  const bpcDesc = items.find((it) => isVisionBpcPiezaCode(it.pieza))
    ?.descripcionTecnica;
  if (bpcDesc && /\[Hojalater[ií]a referenciada en fotos:\s*(DM|DMF|DF|DMFuerte)/i.test(bpcDesc)) {
    return true;
  }
  return false;
}

/**
 * Si el JSON de visión marca baño completo (BPC), devuelve un único ítem BPC
 * con tamaño de carrocería en `severidad` (Grande, Mediano, …) y descarta piezas sueltas.
 */
export function collapseVisionItemsToBpcIfNeeded(
  items: DetectedDamageItem[],
  contextText: string,
  visionRoot?: unknown,
): DetectedDamageItem[] {
  if (!items.length) return items;
  if (!visionItemsIndicateBanioCompleto(items, visionRoot)) return items;

  const tierSource = [
    flattenBañoTierSource(contextText),
    ...items.map(
      (it) =>
        `${it.pieza} ${it.severidad} ${it.descripcionTecnica ?? ''}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');

  const tierSeveridad = inferBañoTierSeveridad(tierSource);

  const bpcRow =
    items.find((it) => isVisionBpcPiezaCode(it.pieza)) ?? items[0]!;
  const descParts = items
    .map((it) => String(it.descripcionTecnica ?? '').trim())
    .filter(Boolean);
  const worstBody = pickWorstBodyworkLevel(
    items
      .filter((it) => !isVisionBpcPiezaCode(it.pieza))
      .map((it) => it.severidad),
  );
  let descripcionTecnica =
    String(bpcRow.descripcionTecnica ?? '').trim() ||
    (descParts.length
      ? `Baño de pintura completo (consolidado). ${descParts.slice(0, 3).join(' ')}`
      : 'Baño de pintura completo exterior según análisis visual y contexto del chat.');
  if (
    worstBody &&
    damageLevelRank(worstBody) >= damageLevelRank('DM')
  ) {
    descripcionTecnica += ` [Hojalatería referenciada en fotos: ${worstBody}]`;
  }

  const urls = [
    ...new Set(
      items.flatMap((it) =>
        Array.isArray(it.urls_origen)
          ? it.urls_origen.map((u) => String(u).trim()).filter(Boolean)
          : [],
      ),
    ),
  ];

  console.log(
    `[VisionBPC] Colapsando ${items.length} ítem(s) → BPC (${tierSeveridad}); piezas sueltas omitidas del presupuesto.`,
  );

  return [
    {
      pieza: VISION_BPC_PIEZA_CODE,
      severidad: tierSeveridad,
      descripcionTecnica,
      urls_origen: urls.length ? urls : [...(bpcRow.urls_origen ?? [])],
    },
  ];
}

export function isBanioPinturaCompletoVisionInventory(
  items: readonly DetectedDamageItem[] | undefined,
): boolean {
  if (!items?.length) return false;
  if (items.length === 1 && isVisionBpcPiezaCode(items[0]!.pieza)) return true;
  return items.every((it) => isVisionBpcPiezaCode(it.pieza));
}
