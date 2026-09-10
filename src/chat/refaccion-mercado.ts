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
  fuente: RefaccionMercadoEstimate['fuente'] = 'mercadolibre',
): string {
  const label = String(pieza ?? '').trim() || 'la pieza';
  const amt = Number.isFinite(Number(monto))
    ? Math.max(0, Math.round(Number(monto)))
    : 0;
  const origen =
    fuente === 'catalogo'
      ? 'precio manual del taller'
      : 'mercado MX en tiempo real (+30% margen, redondeo a $50)';
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
  fuente: 'catalogo' | 'mercadolibre';
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

/** Query: `"${pieza} ${marca} ${modelo} ${anio} mexico"`. */
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
  const anio = String(input.anio ?? '').replace(/\D/g, '').slice(0, 4);
  const identity = [marca, modelo].filter(Boolean).join(' ').trim() || vehiculo;
  return [pieza, identity, anio, 'mexico']
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Primeros 3–5 precios MXN viables (sin inventar). */
export function selectViableMlPrices(
  results: readonly MercadoLibreSearchHit[],
): number[] {
  const prices: number[] = [];
  for (const r of results) {
    const currency = String(r.currency_id ?? 'MXN').toUpperCase();
    if (currency && currency !== 'MXN') continue;
    const n = Number(r.price);
    if (!Number.isFinite(n) || n < 200 || n > 80_000) continue;
    prices.push(n);
    if (prices.length >= 5) break;
  }
  return prices;
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

/**
 * Precio de mercado en tiempo real (MercadoLibre MLM).
 * No usa tablas estáticas. Sin 3+ resultados MXN → confirmación manual.
 */
export async function buscarCostoRefaccionOnline(input: {
  pieza: string;
  marca?: string | null;
  modelo?: string | null;
  vehiculo?: string | null;
  anio?: string | null;
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
        error: 'Se requiere año y modelo confirmados para buscar la refacción.',
      },
    );
  }

  let hits: MercadoLibreSearchHit[] = [];
  try {
    hits = await searchMercadoLibreHits(query);
  } catch {
    hits = [];
  }

  const prices = selectViableMlPrices(hits);
  if (prices.length < 3) {
    return emptyEstimate(
      { pieza, vehiculo, anio, query },
      {
        requiereConfirmacionManual: true,
        muestra: prices.length,
        error:
          'No hay suficientes resultados de mercado MXN para cotizar sin inventar un precio.',
      },
    );
  }

  const costoBase = median(prices);
  const precioAlCliente = precioAlClienteConMargen(costoBase);
  if (!Number.isFinite(precioAlCliente) || precioAlCliente <= 0) {
    return emptyEstimate(
      { pieza, vehiculo, anio, query },
      {
        requiereConfirmacionManual: true,
        muestra: prices.length,
        error: 'El precio de mercado no es numérico.',
      },
    );
  }

  return {
    success: true,
    pieza: piezaLabelForRefaccion(pieza),
    vehiculo,
    anio,
    costoBase: Math.max(0, Math.round(Number(costoBase) || 0)),
    precioAlCliente,
    fuente: 'mercadolibre',
    muestra: prices.length,
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
    estimate.fuente === 'catalogo' ? 'precio manual taller' : 'mercado MX';
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
