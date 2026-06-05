import { formatAutoFixMoney } from './autofix-config';
import type { DraftQuoteItem } from './entities/draft-quote-item.entity';
import {
  findPanelPiezaOption,
  normalizePanelPiezaCode,
} from '../catalog/panel-pieza-catalog';

export type ActiveQuoteSummaryLine = {
  pieza: string;
  severidad: string;
  precioMx: number;
};

function displayPiezaLabel(raw: string): string {
  const opt = findPanelPiezaOption(raw);
  return opt?.fullName ?? String(raw ?? '').trim();
}

export function buildActiveQuoteSummaryLines(
  items: readonly Pick<DraftQuoteItem, 'pieza' | 'severidad' | 'precioMx'>[],
): ActiveQuoteSummaryLine[] {
  return items.map((it) => ({
    pieza: displayPiezaLabel(it.pieza),
    severidad: String(it.severidad ?? 'DL').trim() || 'DL',
    precioMx: Math.round(Number(it.precioMx) || 0),
  }));
}

/** Texto listo para inyectar en el prompt del LLM o devolver a una tool. */
export function formatActiveQuoteSummaryForPrompt(params: {
  lines: readonly ActiveQuoteSummaryLine[];
  totalMx: number;
  vehicleLabel?: string | null;
  reference?: string | null;
  emptyMessage?: string;
}): string {
  const { lines, totalMx, vehicleLabel, reference, emptyMessage } = params;
  if (!lines.length) {
    return (
      emptyMessage ??
      'Aún no hay cotización activa en esta conversación. Usa actualizarCotizacionActiva cuando el cliente confirme piezas a repintar.'
    );
  }

  const body = lines
    .map(
      (l) =>
        `🛠️ ${l.pieza} (${l.severidad}): $${formatAutoFixMoney(l.precioMx)} MXN`,
    )
    .join('\n');

  const parts = [
    'Cotización activa del chat:',
    body,
    `💰 Total acumulado: $${formatAutoFixMoney(totalMx)} MXN`,
  ];
  if (vehicleLabel?.trim()) {
    parts.push(`🚗 Vehículo: ${vehicleLabel.trim()}`);
  }
  if (reference?.trim()) {
    parts.push(`Ref. ${reference.trim()}`);
  }
  parts.push(
    'Redacta al cliente con tono natural usando estos montos exactos (no recalcules totales).',
  );
  return parts.join('\n');
}

export function panelCodeForPiezaInput(raw: string): string {
  return normalizePanelPiezaCode(raw);
}
