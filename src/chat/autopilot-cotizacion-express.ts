import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import { resolvePiecePriceForVehicleProfile } from '../catalog/vehicle-piece-pricing';
import {
  normalizeVehicleSizeTier,
  parseExpressVehicleSizingArgs,
  resolveBañoSeveridadFromVehicleProfile,
  resolveVehiclePricingProfile,
  type VehiclePricingProfile,
  type VehicleSizeTier,
} from '../catalog/vehicle-pricing-profile';
import { AUTO_FIX_CURRENCY, normalizeTextForMatch } from './autofix-config';
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

/** Tamaño de carrocería (eje 1). Premium es multiplicador aparte (`esPremium`). */
export type CategoriaTamanoExpress = 'Chico' | 'Mediano' | 'Grande' | 'XL';

const CATEGORIA_TAMANO_VALUES: readonly CategoriaTamanoExpress[] = [
  'Chico',
  'Mediano',
  'Grande',
  'XL',
];

export function normalizeCategoriaTamanoExpress(
  raw: unknown,
): CategoriaTamanoExpress | null {
  const tier = normalizeVehicleSizeTier(raw);
  if (!tier) {
    if (normalizeTextForMatch(String(raw ?? '')) === 'premium') {
      return null;
    }
    return null;
  }
  const map: Record<VehicleSizeTier, CategoriaTamanoExpress> = {
    Compacto: 'Chico',
    Mediano: 'Mediano',
    Grande: 'Grande',
    XL: 'XL',
  };
  return map[tier];
}

/**
 * @deprecated Premium ya no es categoría de tamaño. Usar {@link resolveBañoSeveridadFromVehicleProfile}.
 */
export function resolveCategoriaTamanoToBañoSeveridad(
  categoria: CategoriaTamanoExpress | 'Premium',
  allowed: readonly string[],
): string | null {
  const sizeTier =
    normalizeVehicleSizeTier(categoria) ?? 'Mediano';
  const profile = resolveVehiclePricingProfile({
    modeloVehiculo: 'legacy',
    sizeTier,
    isPremium: String(categoria) === 'Premium',
    tierSource: 'llm',
  });
  return resolveBañoSeveridadFromVehicleProfile(profile, allowed);
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

export type CotizacionExpressDesgloseLine = {
  pieza: string;
  severidad: string;
  precioMx: number;
};

export type ObtenerCotizacionExpressResult = {
  success: boolean;
  error?: string;
  categoriaTamaño?: CategoriaTamanoExpress;
  /** Perfil vehicular aplicado (tamaño + premium). */
  vehiclePricingProfile?: VehiclePricingProfile;
  severidadCatalogo?: string;
  modeloVehiculo?: string;
  vehicleDisplayLabel?: string;
  moneda?: typeof AUTO_FIX_CURRENCY;
  lines?: CotizacionExpressLineDto[];
  desglose?: CotizacionExpressDesgloseLine[];
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

/** Variantes del panel que comparten catalogPieza (Fascia → FD/FT, Puerta → PDI/PDD/…). */
function panelVariantsForCatalogPieza(
  catalogPieza: string,
): PanelPiezaOption[] {
  return PANEL_PIEZA_OPTIONS.filter(
    (o) =>
      o.catalogPieza === catalogPieza &&
      !o.internalDamageRange &&
      !o.refaccionManual,
  );
}

/**
 * Etiqueta de línea express: si el LLM repite un nombre genérico (Fascia × 2),
 * rota variantes del panel (delantera / trasera).
 */
export function resolveExpressLineServicioLabel(
  rawPieza: string,
  canonical: string,
  occurrenceIndex: number,
): string {
  const opt = findPanelPiezaOption(rawPieza);
  const rawNorm = normalizeTextForMatch(rawPieza);
  const canonNorm = normalizeTextForMatch(canonical);

  if (opt && rawNorm !== canonNorm) {
    return opt.fullName;
  }

  const variants = panelVariantsForCatalogPieza(canonical);
  if (variants.length > 1) {
    return variants[occurrenceIndex % variants.length]!.fullName;
  }

  return opt?.fullName ?? canonical;
}

/**
 * Consulta PriceMatrix para cotización express (piezas por tier vehicular o baño por tamaño).
 */
export function buildObtenerCotizacionExpressPayload(
  snap: MatrixPricingSnapshot,
  servicios: readonly string[],
  vehicleProfile: VehiclePricingProfile,
  options?: { leadAgendado?: boolean },
): ObtenerCotizacionExpressResult {
  const modelo = String(vehicleProfile.vehicleLabel ?? '').trim();
  if (!modelo) {
    return { success: false, error: 'Falta modeloVehiculo (marca y modelo del auto).' };
  }

  const categoriaTamaño =
    normalizeCategoriaTamanoExpress(vehicleProfile.sizeTier) ??
    (vehicleProfile.sizeTier === 'Compacto'
      ? 'Chico'
      : vehicleProfile.sizeTier);

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
      resolveBañoSeveridadFromVehicleProfile(vehicleProfile, allowed) ??
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

  const occurrenceByCanonical = new Map<string, number>();
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

    const occ = occurrenceByCanonical.get(canonical) ?? 0;
    occurrenceByCanonical.set(canonical, occ + 1);

    const label = resolveExpressLineServicioLabel(rawPieza, canonical, occ);
    const unit = resolvePiecePriceForVehicleProfile(
      snap,
      canonical,
      PIEZA_DL,
      vehicleProfile,
    );
    if (unit <= 0) continue;

    lines.push({
      servicio: label,
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
  const desglose: CotizacionExpressDesgloseLine[] = lines.map((l) => ({
    pieza: l.servicio,
    severidad: l.severidad,
    precioMx: l.precioLineaMx,
  }));

  const leadAgendado = options?.leadAgendado === true;
  const result: ObtenerCotizacionExpressResult = {
    success: true,
    categoriaTamaño,
    vehiclePricingProfile: vehicleProfile,
    severidadCatalogo: lines.find((l) => l.tipo === 'bano_pintura')?.severidad,
    modeloVehiculo: modelo,
    vehicleDisplayLabel,
    moneda: AUTO_FIX_CURRENCY,
    lines,
    desglose,
    extras: extras.length > 0 ? extras : undefined,
    subtotalMx,
    totalMx,
    diasEntrega,
    leadAgendado,
    formatoRedaccion:
      'Redacta al cliente con emojis 🛠️ por línea, total en negritas, Materiales premium Sikkens, Acabado Espejo y garantía por escrito cuando encaje. Menciona el vehículo y si aplica segmento premium.',
  };

  if (leadAgendado) {
    result.notaAgendado =
      'El cliente ya tiene cita confirmada: presenta montos como extras en su orden de servicio para el día acordado; no presiones nueva agenda ni envíes ubicación salvo que lo pida.';
  }

  return result;
}
