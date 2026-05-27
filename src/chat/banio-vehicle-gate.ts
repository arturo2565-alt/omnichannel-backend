import type { DetectedDamageItem, VehicleDamageAnalysis } from './entities/chat.entity';
import { isVisionBpcPiezaCode } from './vision-bpc-inventory';

/** Borrador guardado: peritaje visual listo, sin precio hasta tener marca/modelo. */
export const DRAFT_QUOTE_STATUS_AWAITING_VEHICLE = 'AWAITING_VEHICLE';

export type BanioPinturaGateState = {
  solicitarModeloBanio: boolean;
  intencionBanioCompleto: boolean;
  resumenDanosVisuales: string;
  inventarioVisual: DetectedDamageItem[];
  guardadoEn: string;
};

export function buildBanioVisualDamageSummary(
  inventory: readonly DetectedDamageItem[],
): string {
  if (!inventory?.length) {
    return 'El cliente envió fotos del vehículo; aún no hay detalle estructurado de daños.';
  }
  const lines = inventory
    .filter((it) => !isVisionBpcPiezaCode(it.pieza))
    .map((it) => {
      const pieza = String(it.pieza ?? '').trim() || 'Pieza';
      const sev = String(it.severidad ?? '').trim();
      const desc = String(it.descripcionTecnica ?? '').trim();
      const sevPart = sev && sev !== 'N/A' ? ` (${sev})` : '';
      return desc ? `• ${pieza}${sevPart}: ${desc}` : `• ${pieza}${sevPart}`;
    });

  const bpc = inventory.find((it) => isVisionBpcPiezaCode(it.pieza));
  if (bpc) {
    const tier = String(bpc.severidad ?? '').trim();
    const desc = String(bpc.descripcionTecnica ?? '').trim();
    const header = tier
      ? `Baño de pintura completo solicitado (tamaño referencia: ${tier}).`
      : 'Baño de pintura completo solicitado.';
    if (lines.length) {
      return `${header}\n${lines.join('\n')}`;
    }
    return desc ? `${header}\n${desc}` : header;
  }

  if (lines.length) {
    return lines.join('\n');
  }

  return inventory
    .map((it) => String(it.descripcionTecnica ?? '').trim())
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

export function buildAutopilotSolicitarModeloBanioAppend(
  gate: BanioPinturaGateState,
): string {
  return [
    '',
    '[SOLICITAR_MODELO_BANIO = true]',
    'El cliente pidió baño de pintura (o el peritaje visual sugiere baño integral), pero AÚN NO conocemos marca y modelo del vehículo con confianza.',
    'PROHIBIDO ejecutar obtenerCotizacionExpress ni inventar precios hasta que el cliente indique marca y modelo.',
    'Pregunta de forma natural y breve la marca y modelo (y año si aplica). No uses "tu vehículo" como si ya estuviera identificado.',
    'Resumen del peritaje visual ya guardado (úsalo para contextualizar, no para cotizar):',
    gate.resumenDanosVisuales,
  ].join('\n');
}

export function analysisHasBanioVehicleGate(
  analysis: VehicleDamageAnalysis | null | undefined,
): boolean {
  return Boolean(analysis?.banioPinturaGate?.solicitarModeloBanio);
}

export function pickInventarioVisualForGate(
  inventory: readonly DetectedDamageItem[],
): DetectedDamageItem[] {
  const bpc = inventory.find((it) => isVisionBpcPiezaCode(it.pieza));
  const previo = bpc?.inventarioVisualPrevio;
  if (previo?.length) {
    return previo.map((it) => ({
      pieza: it.pieza,
      severidad: it.severidad,
      descripcionTecnica: it.descripcionTecnica,
      urls_origen: [...(it.urls_origen ?? [])],
      ...(it.vehiculoDetectado ? { vehiculoDetectado: it.vehiculoDetectado } : {}),
    }));
  }
  return inventory.map((it) => ({
    pieza: it.pieza,
    severidad: it.severidad,
    descripcionTecnica: it.descripcionTecnica,
    urls_origen: [...(it.urls_origen ?? [])],
    ...(it.vehiculoDetectado ? { vehiculoDetectado: it.vehiculoDetectado } : {}),
  }));
}
