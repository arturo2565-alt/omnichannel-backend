import {
  PANEL_PIEZA_REFACCION_CODE,
  canonicalizePanelCode,
  findPanelPiezaOption,
  isOpticaPanelPieza,
} from '../catalog/panel-pieza-catalog';
import {
  precioSugeridoAlCliente,
  redondearRefaccionA50,
} from '../catalog/refaccion-catalog-pricing';
import {
  inferSizeTierFromVehicleText,
  type VehicleSizeTier,
} from '../catalog/vehicle-pricing-profile';
import type { DetectedDamageItem } from './entities/chat.entity';
import { coerceDamageLevelCode, damageLevelRank } from './autofix-config';
import {
  buildRefaccionWebQuery,
  isViableRefaccionPrice,
  searchRefaccionWebPrices,
} from './refaccion-web-search';

const BREAKAGE_RE =
  /\b(rota|roto|rotura|quebrada|quebrado|partida|partido|destruida|destruido|desprendida|desprendido|faltante|hueco|perforad|estrellad|hecha\s+pedazos)\b/i;

export function looksLikeEvidentBreakage(
  severidad: string,
  descripcionTecnica?: string,
): boolean {
  const level = coerceDamageLevelCode(severidad);
  if (damageLevelRank(level) < damageLevelRank('DF')) return false;
  const blob = String(descripcionTecnica ?? '').trim();
  if (!blob) return true;
  return BREAKAGE_RE.test(blob);
}

/** MXN al cliente: costo base + 30%, redondeo comercial a $50. */
export function precioAlClienteConMargen(costoBase: number): number {
  const suggested = precioSugeridoAlCliente(costoBase, 30);
  return redondearRefaccionA50(suggested);
}

export function looksLikeOpticaOrUnusablePart(
  pieza: string,
  severidad: string,
  descripcionTecnica?: string,
): boolean {
  const blob = String(descripcionTecnica ?? '');
  const unusable =
    BREAKAGE_RE.test(blob) ||
    /\b(inservible|irreparable|estrellad|fisurad|reemplaz|cambiar la pieza)\b/i.test(
      blob,
    );
  if (isOpticaPanelPieza(pieza)) {
    if (unusable) return true;
    const level = coerceDamageLevelCode(severidad);
    return damageLevelRank(level) >= damageLevelRank('DF');
  }
  return looksLikeEvidentBreakage(severidad, descripcionTecnica);
}

export type RefaccionQuoteNoteLine = {
  label: string;
  monto: number;
  fuente?: RefaccionMercadoEstimate['fuente'];
};

function origenRefaccion(fuente?: RefaccionMercadoEstimate['fuente']): string {
  if (fuente === 'catalogo') return 'precio manual del taller';
  if (fuente === 'estimacion_categoria') {
    return 'estimado comercial por gama, sujeto a revisión física';
  }
  if (fuente === 'web') return 'búsqueda web MX/CDMX (+30% margen, redondeo a $50)';
  return 'mercado MX (+30% margen, redondeo a $50)';
}

export function buildRefaccionDisclaimer(
  pieza: string,
  monto: number,
  fuente: RefaccionMercadoEstimate['fuente'] = 'web',
): string {
  return buildConsolidatedRefaccionQuoteNote([
    { label: pieza, monto, fuente },
  ]);
}

/** Un solo bloque comercial; varias piezas van en viñetas (no N notas repetidas). */
export function buildConsolidatedRefaccionQuoteNote(
  lines: readonly RefaccionQuoteNoteLine[],
): string {
  const valid = lines
    .map((l) => ({
      label: String(l.label ?? '').trim() || 'la pieza',
      monto: Number.isFinite(Number(l.monto))
        ? Math.max(0, Math.round(Number(l.monto)))
        : 0,
      fuente: l.fuente,
    }))
    .filter((l) => l.monto > 0);
  if (!valid.length) return '';
  const hasCategoria = valid.some((l) => l.fuente === 'estimacion_categoria');
  const footer = hasCategoria
    ? 'El montaje y la pintura de matriz van en renglones aparte. *Estimado comercial por gama — se confirma número de parte en la revisión física.*'
    : 'El montaje y la pintura de matriz van en renglones aparte. Sujeto a confirmación de número de parte en físico.';
  if (valid.length === 1) {
    const row = valid[0]!;
    return `📦 *Nota de Refacción:* Pieza nueva/reemplazo de *${row.label}* — $${row.monto.toLocaleString('es-MX')} MXN (${origenRefaccion(row.fuente)}). ${footer}`;
  }
  const bullets = valid
    .map(
      (r) =>
        `• ${r.label} — $${r.monto.toLocaleString('es-MX')} MXN`,
    )
    .join('\n');
  return `📦 *Nota de Refacción:* Incluimos el costo estimado de las piezas nuevas/reemplazo (mercado MX +30%, redondeo a $50):\n${bullets}\n${footer}`;
}

export function piezaLabelForRefaccion(raw: string): string {
  const opt = findPanelPiezaOption(raw);
  return opt?.fullName || String(raw ?? '').trim() || 'pieza';
}

export type RefaccionMercadoEstimate = {
  success: boolean;
  pieza: string;
  vehiculo: string;
  anio: string | null;
  costoBase: number;
  precioAlCliente: number;
  fuente: 'catalogo' | 'mercadolibre' | 'web' | 'estimacion_categoria';
  muestra: number;
  query: string;
  error?: string;
  requiereAnioModelo?: boolean;
  requiereConfirmacionManual?: boolean;
};

export type MercadoLibreSearchHit = {
  price?: number;
  currency_id?: string;
  title?: string;
};

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Query web: `precio "${pieza}" "${marca} ${modelo}" ${anio} comprar mexico cdmx`. */
export function buildRefaccionMarketQuery(input: {
  pieza: string;
  marca?: string | null;
  modelo?: string | null;
  vehiculo?: string | null;
  anio?: string | null;
}): string {
  const pieza = piezaLabelForRefaccion(input.pieza);
  const marca = String(input.marca ?? '').trim();
  const modelo = String(input.modelo ?? '').trim();
  const vehiculo = String(input.vehiculo ?? '').trim();
  const identity =
    [marca, modelo].filter(Boolean).join(' ').trim() || vehiculo;
  return buildRefaccionWebQuery({
    pieza,
    marca,
    modelo: identity && !modelo ? identity : modelo,
    anio: input.anio,
  });
}

/** Primeros precios MXN viables ($600–$12,000). */
export function selectViableMlPrices(
  results: readonly MercadoLibreSearchHit[],
): number[] {
  const prices: number[] = [];
  for (const r of results) {
    const currency = String(r.currency_id ?? 'MXN').toUpperCase();
    if (currency && currency !== 'MXN') continue;
    const n = Number(r.price);
    if (!isViableRefaccionPrice(n)) continue;
    prices.push(Math.round(n));
    if (prices.length >= 5) break;
  }
  return prices;
}

type RefaccionCategoriaEstimada = 'optica' | 'iluminacion' | 'plastico' | 'colision';

function categoriaEstimadaDePieza(pieza: string): RefaccionCategoriaEstimada {
  const n = String(pieza ?? '').toLowerCase();
  if (/niebla|antiniebla|faro_niebla/.test(n)) return 'iluminacion';
  if (isOpticaPanelPieza(pieza) || /faro|calavera|optica/.test(n)) return 'optica';
  if (/mold|guia|plast/.test(n)) return 'plastico';
  return 'colision';
}

/** Base comercial CDMX por categoría de pieza × gama (costo, antes del +30%). */
const CATEGORIA_COSTO_POR_GAMA: Record<
  RefaccionCategoriaEstimada,
  Record<VehicleSizeTier, number>
> = {
  optica: { Compacto: 2200, Mediano: 2800, Grande: 3800, XL: 4500 },
  iluminacion: { Compacto: 900, Mediano: 1200, Grande: 1600, XL: 2000 },
  plastico: { Compacto: 800, Mediano: 1100, Grande: 1500, XL: 1800 },
  colision: { Compacto: 2500, Mediano: 3200, Grande: 4200, XL: 5000 },
};

export function estimarCostoBasePorCategoria(
  pieza: string,
  sizeTier: VehicleSizeTier = 'Mediano',
): number {
  const cat = categoriaEstimadaDePieza(pieza);
  return CATEGORIA_COSTO_POR_GAMA[cat][sizeTier] ?? CATEGORIA_COSTO_POR_GAMA[cat].Mediano;
}

async function searchMercadoLibreHits(
  query: string,
): Promise<MercadoLibreSearchHit[]> {
  const url = `https://api.mercadolibre.com/sites/MLM/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { results?: MercadoLibreSearchHit[] };
  return Array.isArray(json.results) ? json.results : [];
}

function emptyEstimate(
  input: {
    pieza: string;
    vehiculo: string;
    anio: string | null;
    query: string;
  },
  extra: Partial<RefaccionMercadoEstimate>,
): RefaccionMercadoEstimate {
  return {
    success: false,
    pieza: piezaLabelForRefaccion(input.pieza),
    vehiculo: input.vehiculo,
    anio: input.anio,
    costoBase: 0,
    precioAlCliente: 0,
    fuente: 'mercadolibre',
    muestra: 0,
    query: input.query,
    ...extra,
  };
}

export async function buscarCostoRefaccionOnline(input: {
  pieza: string;
  marca?: string | null;
  modelo?: string | null;
  vehiculo?: string | null;
  anio?: string | null;
  sizeTier?: VehicleSizeTier | null;
}): Promise<RefaccionMercadoEstimate> {
  const pieza = String(input.pieza ?? '').trim();
  const anio = String(input.anio ?? '').replace(/\D/g, '').slice(0, 4) || null;
  const marca = String(input.marca ?? '').trim();
  const modelo = String(input.modelo ?? '').trim();
  const vehiculo =
    String(input.vehiculo ?? '').trim() ||
    [marca, modelo, anio].filter(Boolean).join(' ').trim();
  const query = buildRefaccionMarketQuery({
    pieza,
    marca,
    modelo,
    vehiculo,
    anio,
  });

  if (!anio || !modelo) {
    return emptyEstimate(
      { pieza, vehiculo, anio, query },
      {
        requiereAnioModelo: true,
        error: 'Se requiere marca, modelo y año (ej. Mazda 2 2018).',
      },
    );
  }

  const webPrices: number[] = [];
  try {
    const webHits = await searchRefaccionWebPrices(query);
    webPrices.push(...webHits.map((h) => h.price).filter(isViableRefaccionPrice));
  } catch {
    /* ML / fallback */
  }

  let mlHits: MercadoLibreSearchHit[] = [];
  try {
    mlHits = await searchMercadoLibreHits(
      `${piezaLabelForRefaccion(pieza)} ${marca} ${modelo} ${anio}`.trim(),
    );
  } catch {
    mlHits = [];
  }
  const mlPrices = selectViableMlPrices(mlHits);
  const prices = [...webPrices, ...mlPrices];
  const unique = [...new Set(prices)].sort((a, b) => a - b);

  if (unique.length >= 1) {
    const costoBase = unique.length === 1 ? unique[0]! : median(unique);
    const precioAlCliente = precioAlClienteConMargen(costoBase);
    if (Number.isFinite(precioAlCliente) && precioAlCliente > 0) {
      return {
        success: true,
        pieza: piezaLabelForRefaccion(pieza),
        vehiculo,
        anio,
        costoBase: Math.max(0, Math.round(Number(costoBase) || 0)),
        precioAlCliente,
        fuente: webPrices.length ? 'web' : 'mercadolibre',
        muestra: unique.length,
        query,
      };
    }
  }

  const tier =
    input.sizeTier ??
    inferSizeTierFromVehicleText([marca, modelo, vehiculo].filter(Boolean).join(' '));
  const costoBase = estimarCostoBasePorCategoria(pieza, tier);
  const precioAlCliente = precioAlClienteConMargen(costoBase);
  return {
    success: true,
    pieza: piezaLabelForRefaccion(pieza),
    vehiculo,
    anio,
    costoBase,
    precioAlCliente,
    fuente: 'estimacion_categoria',
    muestra: 0,
    query,
  };
}

export async function estimarRefaccionMercado(input: {
  pieza: string;
  vehiculo?: string | null;
  marca?: string | null;
  modelo?: string | null;
  anio?: string | null;
}): Promise<RefaccionMercadoEstimate> {
  return buscarCostoRefaccionOnline(input);
}

export function buildRefaccionInventoryItem(
  estimate: RefaccionMercadoEstimate,
  sourcePieza: string,
): DetectedDamageItem {
  const source = canonicalizePanelCode(sourcePieza) || sourcePieza;
  const precio = Number.isFinite(Number(estimate.precioAlCliente))
    ? Math.max(0, Math.round(Number(estimate.precioAlCliente)))
    : 0;
  const base = Number.isFinite(Number(estimate.costoBase))
    ? Math.max(0, Math.round(Number(estimate.costoBase)))
    : 0;
  const origen =
    estimate.fuente === 'catalogo'
      ? 'precio manual taller'
      : estimate.fuente === 'estimacion_categoria'
        ? 'estimado por gama'
        : estimate.fuente === 'web'
          ? 'web MX/CDMX'
          : 'mercado MX';
  return {
    pieza: `${PANEL_PIEZA_REFACCION_CODE}:${source}`,
    severidad: 'N/A',
    descripcionTecnica: `Refacción ${estimate.pieza} — pieza nueva/reemplazo $${precio.toLocaleString('es-MX')} (${origen}, base $${base.toLocaleString('es-MX')}). Montaje/pintura de matriz aparte si aplica.`,
    urls_origen: [],
    detallesRefaccion: estimate.pieza,
    precioMx: precio,
    refaccionDePieza: canonicalizePanelCode(sourcePieza) || sourcePieza,
  };
}
