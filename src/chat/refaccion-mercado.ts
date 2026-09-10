import {
  PANEL_PIEZA_REFACCION_CODE,
  canonicalizePanelCode,
} from '../catalog/panel-pieza-catalog';
import { resolvePiezaDisplayLabel } from './draft-quote-resume';
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
  const base = Math.max(0, Number(costoBase) || 0);
  return Math.round((base * 1.3) / 50) * 50;
}

export function buildRefaccionDisclaimer(pieza: string, monto: number): string {
  const label = String(pieza ?? '').trim() || 'la pieza';
  const amt = Math.max(0, Math.round(Number(monto) || 0));
  return `📦 *Nota sobre Refacción:* Por la magnitud del daño en ${label}, es muy probable que requiera reemplazo. Te incluimos un costo estimado de mercado de $${amt.toLocaleString('es-MX')} MXN (+30% margen logístico), sujeto a confirmación de número de parte en físico.`;
}

export function piezaLabelForRefaccion(raw: string): string {
  const label = resolvePiezaDisplayLabel(String(raw ?? '').trim());
  return label && label !== 'Servicio' ? label : String(raw ?? '').trim() || 'pieza';
}

export type RefaccionMercadoEstimate = {
  success: boolean;
  pieza: string;
  vehiculo: string;
  anio: string | null;
  costoBase: number;
  precioAlCliente: number;
  fuente: 'mercadolibre' | 'estimacion';
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
    costoBase: Math.round(costoBase),
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
  return {
    pieza: `${PANEL_PIEZA_REFACCION_CODE}:${source}`,
    severidad: 'N/A',
    descripcionTecnica: `Refacción ${estimate.pieza} — mercado MX $${estimate.precioAlCliente.toLocaleString('es-MX')} (base $${estimate.costoBase.toLocaleString('es-MX')}, +30%).`,
    urls_origen: [],
    detallesRefaccion: estimate.pieza,
    precioMx: estimate.precioAlCliente,
    refaccionDePieza: canonicalizePanelCode(sourcePieza) || sourcePieza,
  };
}
