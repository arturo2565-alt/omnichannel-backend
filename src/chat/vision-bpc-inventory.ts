import type {
  DetectedDamageItem,
  VehicleDamageAnalysis,
} from './entities/chat.entity';
import { coerceDamageLevelCode, damageLevelRank, type DamageLevel } from './autofix-config';
import {
  cambioDeColorAddonMxForSizeTier,
  flattenBañoTierSource,
  inferBañoTierSeveridad,
  isPlaceholderBañoVehicleLabel,
} from './instant-quote-from-text';
import type { VehicleSizeTier } from '../catalog/vehicle-pricing-profile';

/** Default de colapso (baño exterior). Legacy BPC se trata como BPE. */
export const VISION_BPC_PIEZA_CODE = 'BPE';
export const VISION_BANIO_CODES = ['BPE', 'BPEI', 'BPCC', 'BPC'] as const;
export type VisionBanioCode = (typeof VISION_BANIO_CODES)[number];

const BPC_PIEZA_ALIASES = new Set([
  'bpc',
  'bpe',
  'bpei',
  'bpcc',
  'bano de pintura completo',
  'bano pintura completo',
  'bano completo',
  'bano integral',
  'pintura exterior completa',
  'bano de pintura exterior',
  'baño de pintura completo',
  'baño pintura completo',
  'baño completo',
  'baño de pintura exterior',
  'bano de pintura exterior e interiores',
  'baño de pintura exterior e interiores',
  'bano de pintura con cambio de color',
  'baño de pintura con cambio de color',
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
  return (
    key === 'bpc' ||
    key === 'bpe' ||
    key === 'bpei' ||
    key === 'bpcc' ||
    /\b(bpc|bpe|bpei|bpcc)\b/.test(key)
  );
}

/** Mapea intención de chat/visión a BPE | BPEI | BPCC. */
export function resolveVisionBanioCode(
  contextText: string,
  items: readonly DetectedDamageItem[],
  visionRoot?: unknown,
): 'BPE' | 'BPEI' | 'BPCC' {
  const fromItem = items.find((it) => isVisionBpcPiezaCode(it.pieza));
  const rawCode = normalizePiezaKey(fromItem?.pieza ?? '');
  if (rawCode === 'bpcc') return 'BPCC';
  if (rawCode === 'bpei') return 'BPEI';
  if (rawCode === 'bpe') return 'BPE';

  let tipo = '';
  if (visionRoot && typeof visionRoot === 'object') {
    const o = visionRoot as Record<string, unknown>;
    tipo = normalizePiezaKey(
      String(o.tipo_banio ?? o.tipoBanio ?? o.tipo_bano ?? ''),
    );
  }
  const blob = normalizePiezaKey(
    [contextText, tipo, items.map((i) => `${i.pieza} ${i.descripcionTecnica}`).join(' ')].join(' '),
  );
  if (
    /\bcambio( de)? color\b/.test(blob) ||
    /\bcolor completo\b/.test(blob) ||
    tipo === 'bpcc'
  ) {
    return 'BPCC';
  }
  if (
    tipo === 'bpei' ||
    /\binteriores?\b/.test(blob) ||
    /\binterior(es)? de puertas?\b/.test(blob) ||
    /\bmarco(s)? de puertas?\b/.test(blob)
  ) {
    return 'BPEI';
  }
  return 'BPE';
}

/** BPEI: +15% interiores. BPCC: suplemento de cambio de color / desarmado. */
export function applyBanioCodePriceAdjustments(
  unitPrice: number,
  banioCode: string,
  sizeTier?: VehicleSizeTier | null,
): number {
  let price = Math.max(0, Math.round(Number(unitPrice) || 0));
  if (price <= 0) return 0;
  const code = String(banioCode ?? '').toUpperCase().trim();
  if (code === 'BPEI') {
    price = Math.round((price * 1.15) / 50) * 50;
  }
  if (code === 'BPCC') {
    price += cambioDeColorAddonMxForSizeTier(sizeTier ?? 'Mediano');
  }
  return price;
}

/** Lee vehículo del JSON crudo de visión (snake_case o camelCase). */
export function extractVisionDetectedVehicle(visionRoot?: unknown): string | null {
  if (!visionRoot || typeof visionRoot !== 'object') return null;
  const o = visionRoot as Record<string, unknown>;
  const keys = [
    'vehiculo_detectado',
    'vehiculoDetectado',
    'vehículo_detectado',
    'modelo_vehiculo',
    'modeloVehiculo',
    'vehicle_detected',
    'detected_vehicle',
  ] as const;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Etiqueta de vehículo usable para plantillas BPC (sin placeholders ni basura). */
export function pickUsableVisionVehicleLabel(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const raw of candidates) {
    const t = String(raw ?? '').trim();
    if (!t || t.length > 72) continue;
    if (t.includes('\n')) continue;
    if (t.includes('http://') || t.includes('https://')) continue;
    if (t.includes('cloudinary')) continue;
    if (isPlaceholderBañoVehicleLabel(t)) continue;
    return t;
  }
  return null;
}

/** Vehículo guardado en inventario BPC o en el análisis agregado. */
export function pickVehicleLabelFromDamageInventory(
  inventory: readonly DetectedDamageItem[] | undefined,
  analysisVehiculo?: string | null,
): string | null {
  const fromAnalysis = pickUsableVisionVehicleLabel(analysisVehiculo);
  if (fromAnalysis) return fromAnalysis;
  if (!inventory?.length) return null;
  const bpc = inventory.find((it) => isVisionBpcPiezaCode(it.pieza));
  const fromBpc = pickUsableVisionVehicleLabel(bpc?.vehiculoDetectado);
  if (fromBpc) return fromBpc;
  for (const it of inventory) {
    const v = pickUsableVisionVehicleLabel(it.vehiculoDetectado);
    if (v) return v;
  }
  return null;
}

/** Vehículo para mercado de refacciones: root de análisis primero, no cada ítem. */
export function resolveMarketVehicleText(
  analysis: Pick<
    VehicleDamageAnalysis,
    'vehiculoDetectado' | 'inventory' | 'quoteCartMeta'
  >,
): string {
  return (
    pickUsableVisionVehicleLabel(analysis.vehiculoDetectado) ||
    pickVehicleLabelFromDamageInventory(
      analysis.inventory,
      analysis.vehiculoDetectado,
    ) ||
    pickUsableVisionVehicleLabel(
      analysis.quoteCartMeta?.vehiclePricingProfile?.vehicleLabel,
    ) ||
    ''
  );
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

  const vehiculoDetectado = pickUsableVisionVehicleLabel(
    extractVisionDetectedVehicle(visionRoot),
    ...items.map((it) => it.vehiculoDetectado),
  );

  const banioCode = resolveVisionBanioCode(contextText, items, visionRoot);

  console.log(
    `[VisionBPC] Colapsando ${items.length} ítem(s) → ${banioCode} (${tierSeveridad}); piezas sueltas omitidas del presupuesto.`,
    vehiculoDetectado ? `vehículo visión: ${vehiculoDetectado}` : '',
  );

  const inventarioVisualPrevio = items.map((it) => ({
    pieza: it.pieza,
    severidad: it.severidad,
    descripcionTecnica: it.descripcionTecnica,
    urls_origen: [...(it.urls_origen ?? [])],
    ...(it.vehiculoDetectado ? { vehiculoDetectado: it.vehiculoDetectado } : {}),
  }));

  return [
    {
      pieza: banioCode,
      severidad: tierSeveridad,
      descripcionTecnica,
      urls_origen: urls.length ? urls : [...(bpcRow.urls_origen ?? [])],
      ...(vehiculoDetectado ? { vehiculoDetectado } : {}),
      inventarioVisualPrevio,
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
