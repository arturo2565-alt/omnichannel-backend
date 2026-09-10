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
import type { DetectedDamageItem } from './entities/chat.entity';
import { coerceDamageLevelCode, damageLevelRank } from './autofix-config';

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

export function buildRefaccionDisclaimer(
  pieza: string,
  monto: number,
  fuente: RefaccionMercadoEstimate['fuente'] = 'estimacion',
): string {
  const label = String(pieza ?? '').trim() || 'la pieza';
  const amt = Number.isFinite(Number(monto))
    ? Math.max(0, Math.round(Number(monto)))
    : 0;
  const origen =
    fuente === 'catalogo'
      ? 'catálogo del taller'
      : fuente === 'mercadolibre'
        ? 'mercado MX (+30% margen, redondeo a $50)'
        : 'estimación de mercado MX (+30% margen, redondeo a $50)';
  return `📦 *Nota sobre Refacción:* El renglón cubre la *pieza nueva/reemplazo* de ${label} ($${amt.toLocaleString('es-MX')} MXN, ${origen}). El montaje y la pintura de matriz se cotizan en renglones aparte si aplican. Sujeto a confirmación de número de parte en físico.`;
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
  fuente: 'catalogo' | 'mercadolibre' | 'estimacion';
  muestra: number;
  query: string;
  error?: string;
};

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function buildSearchQuery(pieza: string, vehiculo: string, anio?: string): string {
  const parts = [
    piezaLabelForRefaccion(pieza),
    String(vehiculo ?? '').trim(),
    String(anio ?? '').replace(/\D/g, '').slice(0, 4),
    'refacción',
  ].filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

async function searchMercadoLibrePrices(query: string): Promise<number[]> {
  const url = `https://api.mercadolibre.com/sites/MLM/search?q=${encodeURIComponent(query)}&limit=12`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { results?: Array<{ price?: number }> };
  const prices = (json.results ?? [])
    .map((r) => Number(r.price))
    .filter((n) => Number.isFinite(n) && n >= 200 && n <= 80_000);
  return prices;
}

/** Fallback conservador CDMX si no hay muestra de mercado. */
function fallbackCostoBase(pieza: string): number {
  const code = canonicalizePanelCode(pieza);
  const map: Record<string, number> = {
    FD: 2800,
    FT: 2600,
    SI: 2200,
    SD: 2200,
    STI: 2400,
    STD: 2400,
    CTI: 3200,
    CTD: 3200,
    PDI: 3500,
    PDD: 3500,
    PTI: 3300,
    PTD: 3300,
    EI: 1800,
    ED: 1800,
    Cofre: 4500,
    Toldo: 5000,
    'Tapa Cajuela': 3800,
    ESI: 1200,
    ESD: 1200,
    Espejo: 1200,
    Faro_Izquierdo: 3800,
    Faro_Derecho: 3800,
    Calavera_Izquierda: 2200,
    Calavera_Derecha: 2200,
    Faro_Niebla_Izquierdo: 1400,
    Faro_Niebla_Derecho: 1400,
  };
  return map[code] ?? 2500;
}

export async function estimarRefaccionMercado(input: {
  pieza: string;
  vehiculo: string;
  anio?: string | null;
}): Promise<RefaccionMercadoEstimate> {
  const pieza = String(input.pieza ?? '').trim();
  const vehiculo = String(input.vehiculo ?? '').trim();
  const anio = String(input.anio ?? '').replace(/\D/g, '').slice(0, 4) || null;
  const query = buildSearchQuery(pieza, vehiculo, anio ?? undefined);

  let prices: number[] = [];
  try {
    prices = await searchMercadoLibrePrices(query);
  } catch {
    prices = [];
  }

  const costoBase = prices.length >= 3 ? median(prices) : fallbackCostoBase(pieza);
  const fuente: RefaccionMercadoEstimate['fuente'] =
    prices.length >= 3 ? 'mercadolibre' : 'estimacion';

  return {
    success: true,
    pieza: piezaLabelForRefaccion(pieza),
    vehiculo,
    anio,
    costoBase: Math.max(0, Math.round(Number(costoBase) || 0)),
    precioAlCliente: precioAlClienteConMargen(costoBase),
    fuente,
    muestra: prices.length,
    query,
  };
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
      ? 'catálogo taller'
      : estimate.fuente === 'mercadolibre'
        ? 'mercado MX'
        : 'estimación';
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
