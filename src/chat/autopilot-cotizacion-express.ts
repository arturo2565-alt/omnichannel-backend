import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import { AUTO_FIX_CURRENCY, normalizeTextForMatch } from './autofix-config';
import {
  buildCotizacionToolEnvelope,
  desgloseFromExpressLines,
  type CotizacionDesgloseLine,
} from './cotizacion-tool-envelope';
import { coerceBañoSeveridadToCatalog } from './baño-pintura-llm';
import {
  inferBañoVehicleDisplayLabel,
  isBañoDePinturaServicio,
  materializeInstantQuoteResolution,
  mentionsBañoDePinturaIntent,
  resolveBañoCanonicalFromSnap,
} from './instant-quote-from-text';
import {
  findPanelPiezaOption,
  PANEL_PIEZA_OPTIONS,
  type PanelPiezaOption,
} from '../catalog/panel-pieza-catalog';

const PIEZA_DL = 'DL';

/** Tamaño de carrocería que define la fila de PriceMatrix (lo envía OpenAI). */
export type CategoriaTamanoExpress = 'Chico' | 'Mediano' | 'Grande' | 'Premium';

const CATEGORIA_TAMANO_VALUES: readonly CategoriaTamanoExpress[] = [
  'Chico',
  'Mediano',
  'Grande',
  'Premium',
];

export function normalizeCategoriaTamanoExpress(
  raw: unknown,
): CategoriaTamanoExpress | null {
  const t = String(raw ?? '').trim();
  if (CATEGORIA_TAMANO_VALUES.includes(t as CategoriaTamanoExpress)) {
    return t as CategoriaTamanoExpress;
  }
  const key = normalizeTextForMatch(t);
  const byNorm: Record<string, CategoriaTamanoExpress> = {
    chico: 'Chico',
    mediano: 'Mediano',
    grande: 'Grande',
    premium: 'Premium',
  };
  return byNorm[key] ?? null;
}

/**
 * Mapea categoriaTamaño del modelo → severidad literal en catálogo (sin heurística de texto).
 */
export function resolveCategoriaTamanoToBañoSeveridad(
  categoria: CategoriaTamanoExpress,
  allowed: readonly string[],
): string | null {
  const candidates: string[] = [];
  switch (categoria) {
    case 'Chico':
      candidates.push('Chico', 'Chico Premium');
      break;
    case 'Mediano':
      candidates.push('Mediano', 'Mediano Premium');
      break;
    case 'Grande':
      candidates.push('Grande', 'XL', 'Grande Premium', 'XL Premium');
      break;
    case 'Premium':
      candidates.push(
        'Grande Premium',
        'XL Premium',
        'Mediano Premium',
        'Chico Premium',
        'Premium',
      );
      break;
    default:
      break;
  }
  for (const c of candidates) {
    const hit = coerceBañoSeveridadToCatalog(c, allowed);
    if (hit) return hit;
  }
  const needle = normalizeTextForMatch(categoria);
  for (const a of allowed) {
    if (normalizeTextForMatch(a).includes(needle)) {
      return a;
    }
  }
  return allowed[0] ?? null;
}

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
  categoriaTamaño?: CategoriaTamanoExpress;
  severidadCatalogo?: string;
  modeloVehiculo?: string;
  vehicleDisplayLabel?: string;
  moneda?: typeof AUTO_FIX_CURRENCY;
  lines?: CotizacionExpressLineDto[];
  extras?: { label: string; amount: number }[];
  subtotalMx?: number;
  totalMx?: number;
  /** Desglose autoritativo — el LLM debe usar totalGlobal, no sumar. */
  desglose?: CotizacionDesgloseLine[];
  totalGlobal?: number;
  instruccionParaModelo?: string;
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

/** Variantes de panel que comparten el mismo servicio en PriceMatrix (ej. FD/FT → Fascia). */
function panelVariantsForCatalogPieza(catalogPieza: string): PanelPiezaOption[] {
  return PANEL_PIEZA_OPTIONS.filter(
    (o) =>
      o.catalogPieza === catalogPieza &&
      !o.internalDamageRange &&
      !o.refaccionManual,
  );
}

/**
 * Etiqueta descriptiva por ocurrencia en el request.
 * Repeticiones genéricas (ej. "Fascia" × 2) → Fascia delantera, Fascia trasera, etc.
 */
export function resolveExpressLineServicioLabel(
  rawPieza: string,
  canonical: string,
  canonicalOccurrenceByIndex: Map<string, number>,
): string {
  const idx = canonicalOccurrenceByIndex.get(canonical) ?? 0;

  const fromRaw = findPanelPiezaOption(rawPieza);
  if (
    fromRaw?.catalogPieza === canonical &&
    !fromRaw.internalDamageRange &&
    !fromRaw.refaccionManual
  ) {
    canonicalOccurrenceByIndex.set(canonical, idx + 1);
    return fromRaw.fullName;
  }

  canonicalOccurrenceByIndex.set(canonical, idx + 1);
  const variants = panelVariantsForCatalogPieza(canonical);
  if (variants.length > 1) {
    return variants[idx % variants.length]!.fullName;
  }
  if (variants.length === 1) {
    return variants[0]!.fullName;
  }
  return canonical;
}

/**
 * Consulta PriceMatrix para cotización express (piezas DL o baño por tamaño del vehículo).
 */
export function buildObtenerCotizacionExpressPayload(
  snap: MatrixPricingSnapshot,
  servicios: readonly string[],
  modeloVehiculo: string,
  categoriaTamaño: CategoriaTamanoExpress,
  options?: { leadAgendado?: boolean },
): ObtenerCotizacionExpressResult {
  const modelo = String(modeloVehiculo ?? '').trim();
  if (!modelo) {
    return { success: false, error: 'Falta modeloVehiculo (marca y modelo del auto).' };
  }

  if (!normalizeCategoriaTamanoExpress(categoriaTamaño)) {
    return {
      success: false,
      error:
        'categoriaTamaño inválida. Debe ser Chico, Mediano, Grande o Premium.',
    };
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
    const sevFinal =
      resolveCategoriaTamanoToBañoSeveridad(categoriaTamaño, allowed) ??
      allowed[0]!;

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

  const canonicalOccurrenceByIndex = new Map<string, number>();
  console.log('[DEBUG COTIZACIÓN] buildObtenerCotizacionExpressPayload — piezaRequests:', piezaRequests);
  for (const rawPieza of piezaRequests) {
    const canonical = snap.matchServicio(rawPieza);
    if (!canonical) {
      console.log('[DEBUG COTIZACIÓN] buildObtenerCotizacionExpressPayload — sin match:', {
        rawPieza,
        canonical: null,
      });
      continue;
    }
    if (isBañoDePinturaServicio(canonical)) {
      console.log('[DEBUG COTIZACIÓN] buildObtenerCotizacionExpressPayload — omitida (baño pintura):', {
        rawPieza,
        canonical,
      });
      continue;
    }
    const k = normalizeTextForMatch(canonical);
    if (k.includes('ceramico') || (k.includes('estetica') && k.includes('automotriz'))) {
      console.log('[DEBUG COTIZACIÓN] buildObtenerCotizacionExpressPayload — omitida (cerámico/estética):', {
        rawPieza,
        canonical,
      });
      continue;
    }

    const unit = snap.getPriceForCanonical(canonical, PIEZA_DL);
    const servicioLabel = resolveExpressLineServicioLabel(
      rawPieza,
      canonical,
      canonicalOccurrenceByIndex,
    );
    console.log('[DEBUG COTIZACIÓN] buildObtenerCotizacionExpressPayload — precio catálogo:', {
      rawPieza,
      canonical,
      servicioLabel,
      severidad: PIEZA_DL,
      precioUnitarioMx: unit,
      seAgregaALines: unit > 0,
    });
    if (unit <= 0) continue;

    lines.push({
      servicio: servicioLabel,
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
  const desglose = desgloseFromExpressLines(lines, extras);

  const leadAgendado = options?.leadAgendado === true;
  const envelope = buildCotizacionToolEnvelope(desglose, {
    success: true,
    categoriaTamaño,
    severidadCatalogo: lines.find((l) => l.tipo === 'bano_pintura')?.severidad,
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
      'Redacta al cliente con emojis 🛠️ por línea usando desglose (pieza + precio), totalGlobal en negritas tal cual, Materiales premium Sikkens, Acabado Espejo y garantía por escrito cuando encaje.',
  });

  const result = envelope as ObtenerCotizacionExpressResult;

  console.log('[DEBUG COTIZACIÓN] buildObtenerCotizacionExpressPayload — totales calculados:', {
    subtotalMx,
    totalMx,
    totalGlobal: result.totalGlobal,
    desglose,
    lineCount: lines.length,
    lines: lines.map((l) => ({
      servicio: l.servicio,
      precioLineaMx: l.precioLineaMx,
    })),
  });

  if (leadAgendado) {
    result.notaAgendado =
      'El cliente ya tiene cita confirmada: presenta montos como extras en su orden de servicio para el día acordado; no presiones nueva agenda ni envíes ubicación salvo que lo pida.';
  }

  return result;
}
