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

export type ActualizarCotizacionExistenteInput = {
  cotizacionId: string;
  piezaOServicio: string;
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
  totalAnterior: number;
  totalNuevo: number;
  incremento: number;
  requiresHumanReview: boolean;
  error?: string;
  instruccion?: string;
};

export function parseActualizarCotizacionExistenteArgs(
  argsJson: string,
): { ok: true; data: ActualizarCotizacionExistenteInput } | { ok: false; error: string } {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'Argumentos inválidos (JSON).' };
  }

  const cotizacionId = String(
    raw.cotizacionId ?? raw.cotizacion_id ?? raw.quoteId ?? raw.quote_id ?? '',
  ).trim();
  const piezaOServicio = String(
    raw.piezaOServicio ??
      raw.pieza_o_servicio ??
      raw.pieza ??
      raw.servicio ??
      raw.partName ??
      '',
  ).trim();

  if (!cotizacionId) {
    return { ok: false, error: 'cotizacionId es obligatorio.' };
  }
  if (!piezaOServicio) {
    return { ok: false, error: 'piezaOServicio es obligatorio.' };
  }

  const severidad = String(raw.severidad ?? raw.severityHint ?? '').trim() || undefined;
  const descripcionDano = String(
    raw.descripcionDano ?? raw.descripcion_dano ?? raw.damageDescription ?? '',
  ).trim() || undefined;

  return {
    ok: true,
    data: { cotizacionId, piezaOServicio, severidad, descripcionDano },
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
    severidad: precioCatalogo > 0 ? severidad : severidad,
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
