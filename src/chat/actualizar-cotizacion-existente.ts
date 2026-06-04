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
  resolveDamageLevelFromText,
} from './autofix-config';

/** Entrada parseada desde la tool — sin cotizacionId (lo resuelve el backend). */
export type ActualizarCotizacionExistenteInput = {
  piezasOServicios: string[];
  severidad?: string;
  descripcionDano?: string;
};

export type PiezaResueltaCatalogo = {
  panelCode: string;
  nombreVisible: string;
  catalogServicio: string | null;
  severidad: string;
  precioCatalogo: number;
  requiereRevisionManual: boolean;
};

export type ActualizarCotizacionExistenteToolResult = {
  success: boolean;
  cotizacionId: string | null;
  piezaAgregada: PiezaResueltaCatalogo | null;
  piezasAgregadas: PiezaResueltaCatalogo[];
  totalAnterior: number;
  totalNuevo: number;
  incremento: number;
  requiresHumanReview: boolean;
  error?: string;
  instruccion?: string;
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
        'Indica al menos una pieza en piezasOServicios (array) o piezaOServicio (string). No envíes cotizacionId ni quoteId.',
    };
  }

  const severidad = String(raw.severidad ?? raw.severityHint ?? '').trim() || undefined;
  const descripcionDano = String(
    raw.descripcionDano ?? raw.descripcion_dano ?? raw.damageDescription ?? '',
  ).trim() || undefined;

  return {
    ok: true,
    data: { piezasOServicios, severidad, descripcionDano },
  };
}

export function resolverPiezaEnCatalogo(
  piezaOServicio: string,
  snap: MatrixPricingSnapshot,
  opts?: { severidad?: string; descripcionDano?: string },
): PiezaResueltaCatalogo {
  const panelCode = normalizePanelPiezaCode(piezaOServicio);
  const opt = findPanelPiezaOption(panelCode) ?? findPanelPiezaOption(piezaOServicio);
  const nombreVisible = opt?.fullName ?? panelCode;

  const fromHint = opts?.severidad
    ? coerceDamageLevelCode(opts.severidad)
    : null;
  const fromText = resolveDamageLevelFromText(
    '',
    [opts?.descripcionDano, piezaOServicio].filter(Boolean).join(' '),
  );
  const severidad = fromHint ?? fromText ?? 'DL';

  const matrixRaw = resolveMatrixServicioRaw(panelCode || piezaOServicio);
  const catalogServicio = snap.matchServicio(matrixRaw);

  if (!catalogServicio) {
    return {
      panelCode: panelCode || piezaOServicio,
      nombreVisible,
      catalogServicio: null,
      severidad,
      precioCatalogo: 0,
      requiereRevisionManual: true,
    };
  }

  let precioCatalogo = snap.getAmount(catalogServicio, severidad);
  if (precioCatalogo <= 0 && severidad !== 'DL') {
    precioCatalogo = snap.getAmount(catalogServicio, 'DL');
  }

  return {
    panelCode: panelCode || piezaOServicio,
    nombreVisible,
    catalogServicio,
    severidad,
    precioCatalogo,
    requiereRevisionManual: precioCatalogo <= 0,
  };
}

export function formatPiezaAgregadaLinea(p: PiezaResueltaCatalogo): string {
  if (p.requiereRevisionManual || p.precioCatalogo <= 0) {
    return `${p.nombreVisible} (${p.panelCode}) — pendiente revisión manual`;
  }
  return `${p.nombreVisible} (${p.panelCode}) — ${p.severidad}: ${formatAutoFixMoney(p.precioCatalogo)} ${AUTO_FIX_CURRENCY}`;
}
