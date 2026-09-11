import {
  PANEL_PIEZA_REFACCION_CODE,
  canonicalizePanelCode,
} from '../catalog/panel-pieza-catalog';
import { resolvePiezaDisplayLabel } from './draft-quote-resume';
import type { DetectedDamageItem } from './entities/chat.entity';
import { coerceDamageLevelCode, damageLevelRank } from './autofix-config';
import { applyMarketEstimateToItem } from './refaccion-market/apply-estimate-to-item';
import { parseVehiclePartIdentity } from './refaccion-market/parse-vehicle-part-identity';
import { createRefaccionMarketService } from './refaccion-market/refaccion-market.orchestrator';
import type { RefaccionMarketEstimate as MarketEstimate } from './refaccion-market/refaccion-market.types';
import type { RefaccionMarketService } from './refaccion-market/refaccion-market.orchestrator';

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

export type RefaccionPriceSource =
  | 'AUTOFIX_CATALOG'
  | 'MARKET'
  | 'FALLBACK'
  | 'WEB_MARKET_ESTIMATE'
  | 'INSUFFICIENT_MARKET_SAMPLE';

/** MXN al cliente: costo base + 30%, redondeo comercial a $50. */
export function precioAlClienteConMargen(costoBase: number): number {
  const base = Math.max(0, Number(costoBase) || 0);
  return Math.round((base * 1.3) / 50) * 50;
}

export function buildRefaccionDisclaimer(
  pieza: string,
  monto: number,
  priceSource?: RefaccionPriceSource,
): string {
  const label = String(pieza ?? '').trim() || 'la pieza';
  const amt = Math.max(0, Math.round(Number(monto) || 0));
  if (
    priceSource === 'INSUFFICIENT_MARKET_SAMPLE' ||
    priceSource === 'FALLBACK'
  ) {
    return `📦 *Nota sobre Refacción:* No encontramos muestras de mercado suficientes para cotizar ${label} de esta unidad. El precio se confirma con número de parte en físico.`;
  }
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
  fuente: 'mercadolibre' | 'estimacion' | 'catalogo';
  priceSource: RefaccionPriceSource;
  muestra: number;
  query: string;
  error?: string;
  estimate?: MarketEstimate;
};

export type RefaccionClienteQuote = {
  costoBase: number;
  precioAlCliente: number;
  priceSource: RefaccionPriceSource;
  nombre?: string;
};

let marketServiceSingleton: RefaccionMarketService | null = null;

export async function estimarRefaccionMercado(input: {
  pieza: string;
  vehiculo: string;
  anio?: string | null;
  version?: string | null;
}): Promise<RefaccionMercadoEstimate> {
  const identity = parseVehiclePartIdentity({
    vehiculoText: input.vehiculo,
    anio: input.anio,
    version: input.version,
    pieza: input.pieza,
  });
  marketServiceSingleton ??= createRefaccionMarketService();
  const estimate = await marketServiceSingleton.estimate(identity);
  const customer = estimate.customerPriceRange;
  const market = estimate.marketPriceRange;
  return {
    success: estimate.pricingStatus === 'OK',
    pieza: identity.piezaLabel,
    vehiculo: [identity.marca, identity.modelo].filter(Boolean).join(' '),
    anio: identity.anio,
    costoBase: market?.precioCentral ?? 0,
    precioAlCliente: customer?.precioCentral ?? 0,
    fuente: estimate.pricingStatus === 'OK' ? 'mercadolibre' : 'estimacion',
    priceSource: estimate.priceSource,
    muestra: estimate.cantidadMuestras,
    query: estimate.query,
    estimate,
  };
}

export function buildRefaccionInventoryItem(
  estimate: RefaccionMercadoEstimate,
  sourcePieza: string,
): DetectedDamageItem {
  const source = canonicalizePanelCode(sourcePieza) || sourcePieza;
  const base: DetectedDamageItem = {
    pieza: `${PANEL_PIEZA_REFACCION_CODE}:${source}`,
    severidad: 'N/A',
    descripcionTecnica:
      estimate.priceSource === 'INSUFFICIENT_MARKET_SAMPLE'
        ? `Refacción ${estimate.pieza} — sin muestra de mercado suficiente.`
        : `Refacción ${estimate.pieza} — mercado MX $${estimate.precioAlCliente.toLocaleString('es-MX')} (base $${estimate.costoBase.toLocaleString('es-MX')}, +30%).`,
    urls_origen: [],
    detallesRefaccion: estimate.pieza,
    precioMx: estimate.precioAlCliente,
    refaccionDePieza: canonicalizePanelCode(sourcePieza) || sourcePieza,
    tratamiento: 'SUSTITUIR',
    priceSource: estimate.priceSource,
  };
  return estimate.estimate
    ? applyMarketEstimateToItem(base, estimate.estimate)
    : base;
}
