import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import { AUTO_FIX_CURRENCY, normalizeTextForMatch } from './autofix-config';
import { coerceBañoSeveridadToCatalog } from './baño-pintura-llm';
import {
  inferBañoTierSeveridad,
  inferBañoVehicleDisplayLabel,
  isBañoDePinturaServicio,
  materializeInstantQuoteResolution,
  mentionsBañoDePinturaIntent,
  resolveBañoCanonicalFromSnap,
} from './instant-quote-from-text';

const PIEZA_DL = 'DL';

export type CotizacionExpressLineDto = {
  servicio: string;
  canonical: string;
  tipo: 'pieza' | 'bano_pintura';
  severidad: string;
  cantidad: number;
  precioUnitarioMx: number;
  precioLineaMx: number;
};

export type ObtenerCotizacionExpressResult = {
  success: boolean;
  error?: string;
  modeloVehiculo?: string;
  vehicleDisplayLabel?: string;
  moneda?: typeof AUTO_FIX_CURRENCY;
  lines?: CotizacionExpressLineDto[];
  extras?: { label: string; amount: number }[];
  subtotalMx?: number;
  totalMx?: number;
  diasEntrega?: number;
  leadAgendado?: boolean;
  notaAgendado?: string;
  formatoRedaccion?: string;
};

/** El modelo clasificó la solicitud como baño integral (no pieza suelta). */
export function servicioSolicitudLooksLikeBano(raw: string): boolean {
  const n = normalizeTextForMatch(String(raw ?? ''));
  if (!n) return false;
  if (mentionsBañoDePinturaIntent(raw)) return true;
  return /\b(bano de pintura|bano pintura|bano completo|bano integral|pintura exterior completa|baño de pintura|baño completo)\b/.test(
    n,
  );
}

/**
 * Consulta PriceMatrix para cotización express (piezas DL o baño por tamaño del vehículo).
 */
export function buildObtenerCotizacionExpressPayload(
  snap: MatrixPricingSnapshot,
  servicios: readonly string[],
  modeloVehiculo: string,
  options?: { leadAgendado?: boolean },
): ObtenerCotizacionExpressResult {
  const modelo = String(modeloVehiculo ?? '').trim();
  if (!modelo) {
    return { success: false, error: 'Falta modeloVehiculo (marca y modelo del auto).' };
  }

  const servicioList = servicios
    .map((s) => String(s ?? '').trim())
    .filter(Boolean);
  if (!servicioList.length) {
    return {
      success: false,
      error: 'Indica al menos un servicio en servicios (pieza o baño de pintura).',
    };
  }

  const tierCtx = `${modelo} ${servicioList.join(' ')}`;
  const vehicleDisplayLabel =
    inferBañoVehicleDisplayLabel(tierCtx) ||
    inferBañoVehicleDisplayLabel(modelo) ||
    modelo;

  const lines: CotizacionExpressLineDto[] = [];
  const extras: { label: string; amount: number }[] = [];
  let diasEntrega = 3;

  const banoRequests = servicioList.filter(servicioSolicitudLooksLikeBano);
  const piezaRequests = servicioList.filter((s) => !servicioSolicitudLooksLikeBano(s));

  if (banoRequests.length > 0) {
    const banoCanonical = resolveBañoCanonicalFromSnap(snap);
    if (!banoCanonical) {
      return {
        success: false,
        error: 'Baño de pintura no disponible en el catálogo actual.',
      };
    }
    const allowed = snap.listSeveridadesForCanonical(banoCanonical);
    if (!allowed.length) {
      return {
        success: false,
        error: 'Sin severidades de catálogo para baño de pintura.',
      };
    }
    const sevRaw = inferBañoTierSeveridad(tierCtx) || inferBañoTierSeveridad(modelo);
    const sevFinal =
      coerceBañoSeveridadToCatalog(sevRaw, allowed) ?? allowed[0]!;

    const resolution = materializeInstantQuoteResolution(snap, {
      canonical: banoCanonical,
      severidadLiteral: sevFinal,
      tierSourceForCambioColor: tierCtx,
      resolveVia: 'bano_pintura_synonym',
      latestPreview: modelo,
      fullCtxPreview: tierCtx,
    });

    if (!resolution) {
      return {
        success: false,
        error: 'No se pudo calcular el baño de pintura para ese vehículo.',
      };
    }

    for (const line of resolution.lines) {
      lines.push({
        servicio: line.label,
        canonical: banoCanonical,
        tipo: 'bano_pintura',
        severidad: sevFinal,
        cantidad: 1,
        precioUnitarioMx: Math.round(line.amount),
        precioLineaMx: Math.round(line.amount),
      });
    }
    for (const ex of resolution.extras) {
      extras.push({ label: ex.label, amount: Math.round(ex.amount) });
    }
    diasEntrega = Math.max(diasEntrega, resolution.diasEntrega);
  }

  const usedPiezas = new Set<string>();
  for (const rawPieza of piezaRequests) {
    const canonical = snap.matchServicio(rawPieza);
    if (!canonical) {
      continue;
    }
    if (isBañoDePinturaServicio(canonical)) {
      continue;
    }
    const k = normalizeTextForMatch(canonical);
    if (k.includes('ceramico') || (k.includes('estetica') && k.includes('automotriz'))) {
      continue;
    }
    if (usedPiezas.has(canonical)) continue;

    const unit = snap.getPriceForCanonical(canonical, PIEZA_DL);
    if (unit <= 0) continue;

    usedPiezas.add(canonical);
    lines.push({
      servicio: canonical,
      canonical,
      tipo: 'pieza',
      severidad: PIEZA_DL,
      cantidad: 1,
      precioUnitarioMx: Math.round(unit),
      precioLineaMx: Math.round(unit),
    });
  }

  if (!lines.length) {
    return {
      success: false,
      error:
        'No se encontraron precios en catálogo para los servicios indicados. Verifica nombres de pieza o incluye "baño de pintura".',
      modeloVehiculo: modelo,
    };
  }

  const subtotalMx = lines.reduce((s, l) => s + l.precioLineaMx, 0);
  const extrasTotal = extras.reduce((s, e) => s + e.amount, 0);
  const totalMx = subtotalMx + extrasTotal;

  const leadAgendado = options?.leadAgendado === true;
  const result: ObtenerCotizacionExpressResult = {
    success: true,
    modeloVehiculo: modelo,
    vehicleDisplayLabel,
    moneda: AUTO_FIX_CURRENCY,
    lines,
    extras: extras.length > 0 ? extras : undefined,
    subtotalMx,
    totalMx,
    diasEntrega,
    leadAgendado,
    formatoRedaccion:
      'Redacta al cliente con emojis 🛠️ por línea, total en negritas, Materiales premium Sikkens, Acabado Espejo y garantía por escrito cuando encaje.',
  };

  if (leadAgendado) {
    result.notaAgendado =
      'El cliente ya tiene cita confirmada: presenta montos como extras en su orden de servicio para el día acordado; no presiones nueva agenda ni envíes ubicación salvo que lo pida.';
  }

  return result;
}
