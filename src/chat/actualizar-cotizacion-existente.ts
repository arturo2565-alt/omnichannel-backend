import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import {
  findPanelPiezaOption,
  normalizePanelPiezaCode,
  resolveMatrixServicioRaw,
} from '../catalog/panel-pieza-catalog';
import {
  AUTO_FIX_CURRENCY,
  coerceDamageLevelCode,
  formatAutoFixMoney,
} from './autofix-config';

export type SeveridadInferidaTool = 'DL' | 'DM' | 'DF';

/** Entrada parseada desde la tool — sin cotizacionId (lo resuelve el backend). */
export type ActualizarCotizacionExistenteInput = {
  piezasOServicios: string[];
  severidadInferida: SeveridadInferidaTool;
  descripcionDano?: string;
};

export type PiezaResueltaCatalogo = {
  panelCode: string;
  nombreVisible: string;
  catalogServicio: string | null;
  severidad: string;
  severidadInferida: SeveridadInferidaTool;
  precioCatalogo: number;
  requiereRevisionManual: boolean;
  autoAprobable: boolean;
};

export type ActualizarCotizacionExistenteToolResult = {
  success: boolean;
  cotizacionId: string | null;
  cotizacionStatus: string | null;
  piezaAgregada: PiezaResueltaCatalogo | null;
  piezasAgregadas: PiezaResueltaCatalogo[];
  totalAnterior: number;
  totalNuevo: number;
  incremento: number;
  requiresHumanReview: boolean;
  autoAprobado: boolean;
  autopilotPausado: boolean;
  error?: string;
  instruccion?: string;
  mensajeParaCliente?: string;
};

function normalizePiezasFromRaw(raw: Record<string, unknown>): string[] {
  const fromArray = raw.piezasOServicios ?? raw.piezas_o_servicios ?? raw.servicios ?? raw.piezas;
  if (Array.isArray(fromArray)) {
    return fromArray
      .map((p) => String(p ?? '').trim())
      .filter((p) => p.length > 0);
  }
  const single = String(
    raw.piezaOServicio ??
      raw.pieza_o_servicio ??
      raw.pieza ??
      raw.servicio ??
      raw.partName ??
      '',
  ).trim();
  if (single) return [single];
  return [];
}

export function normalizeSeveridadInferida(raw: unknown): SeveridadInferidaTool | null {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (s === 'DL') return 'DL';
  if (s === 'DM' || s === 'DML') return 'DM';
  if (s === 'DF' || s === 'DMF' || s === 'DMFUERTE') return 'DF';
  return null;
}

export function isAutoAprobableSeveridad(sev: SeveridadInferidaTool): boolean {
  return sev === 'DL';
}

export function parseActualizarCotizacionExistenteArgs(
  argsJson: string,
): { ok: true; data: ActualizarCotizacionExistenteInput } | { ok: false; error: string } {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'Argumentos inválidos (JSON).' };
  }

  const piezasOServicios = normalizePiezasFromRaw(raw);
  if (!piezasOServicios.length) {
    return {
      ok: false,
      error:
        'Indica piezaOServicio o piezasOServicios. No envíes cotizacionId ni quoteId.',
    };
  }

  const severidadInferida = normalizeSeveridadInferida(
    raw.severidadInferida ??
      raw.severidad_inferida ??
      raw.severidad ??
      raw.severityHint,
  );
  if (!severidadInferida) {
    return {
      ok: false,
      error:
        'severidadInferida es obligatoria: "DL" (leve/auto-aprobable), "DM" (moderado) o "DF" (grave).',
    };
  }

  const descripcionDano = String(
    raw.descripcionDano ?? raw.descripcion_dano ?? raw.damageDescription ?? '',
  ).trim() || undefined;

  return {
    ok: true,
    data: { piezasOServicios, severidadInferida, descripcionDano },
  };
}

export function resolverPiezaEnCatalogo(
  piezaOServicio: string,
  snap: MatrixPricingSnapshot,
  opts: {
    severidadInferida: SeveridadInferidaTool;
    descripcionDano?: string;
  },
): PiezaResueltaCatalogo {
  const panelCode = normalizePanelPiezaCode(piezaOServicio);
  const opt = findPanelPiezaOption(panelCode) ?? findPanelPiezaOption(piezaOServicio);
  const nombreVisible = opt?.fullName ?? panelCode;
  const autoAprobable = isAutoAprobableSeveridad(opts.severidadInferida);
  const severidadCatalogo = coerceDamageLevelCode(opts.severidadInferida);

  const matrixRaw = resolveMatrixServicioRaw(panelCode || piezaOServicio);
  const catalogServicio = snap.matchServicio(matrixRaw);

  if (!catalogServicio) {
    return {
      panelCode: panelCode || piezaOServicio,
      nombreVisible,
      catalogServicio: null,
      severidad: severidadCatalogo,
      severidadInferida: opts.severidadInferida,
      precioCatalogo: 0,
      requiereRevisionManual: true,
      autoAprobable: false,
    };
  }

  let precioCatalogo = 0;
  if (autoAprobable) {
    precioCatalogo = snap.getAmount(catalogServicio, 'DL');
    if (precioCatalogo <= 0) {
      precioCatalogo = snap.getAmount(catalogServicio, severidadCatalogo);
    }
  } else {
    precioCatalogo = snap.getAmount(catalogServicio, severidadCatalogo);
    if (precioCatalogo <= 0) {
      precioCatalogo = snap.getAmount(catalogServicio, 'DL');
    }
  }

  const sinPrecioEnCatalogo = precioCatalogo <= 0;
  const requiereRevisionManual = !autoAprobable || sinPrecioEnCatalogo;

  return {
    panelCode: panelCode || piezaOServicio,
    nombreVisible,
    catalogServicio,
    severidad: autoAprobable ? 'DL' : severidadCatalogo,
    severidadInferida: opts.severidadInferida,
    precioCatalogo: autoAprobable ? precioCatalogo : sinPrecioEnCatalogo ? 0 : precioCatalogo,
    requiereRevisionManual,
    autoAprobable: autoAprobable && !sinPrecioEnCatalogo,
  };
}

export function formatPiezaAgregadaLinea(p: PiezaResueltaCatalogo): string {
  if (p.requiereRevisionManual || p.precioCatalogo <= 0) {
    return `${p.nombreVisible} (${p.panelCode}) — ${p.severidadInferida} — pendiente revisión humana`;
  }
  return `${p.nombreVisible} (${p.panelCode}) — ${p.severidad}: ${formatAutoFixMoney(p.precioCatalogo)} ${AUTO_FIX_CURRENCY}`;
}

export function buildMensajeClienteAutoAprobado(params: {
  piezas: PiezaResueltaCatalogo[];
  totalNuevo: number;
  incremento: number;
}): string {
  const lines = params.piezas
    .filter((p) => p.autoAprobable && p.precioCatalogo > 0)
    .map(
      (p) =>
        `• *${p.nombreVisible}*: ${formatAutoFixMoney(p.precioCatalogo)} ${AUTO_FIX_CURRENCY}`,
    );
  return [
    '¡Listo! Actualicé tu cotización con el catálogo oficial del taller:',
    '',
    ...lines,
    '',
    `*Nuevo total estimado: ${formatAutoFixMoney(params.totalNuevo)} ${AUTO_FIX_CURRENCY}*`,
    params.incremento > 0
      ? `_(Se agregaron ${formatAutoFixMoney(params.incremento)} ${AUTO_FIX_CURRENCY} por la(s) pieza(s) nueva(s))._`
      : '',
    '',
    '_Sujeto a revisión física en planta._',
  ]
    .filter(Boolean)
    .join('\n');
}
