import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import {
  findPanelPiezaOption,
  normalizePanelPiezaCode,
  resolveMatrixServicioRaw,
} from '../catalog/panel-pieza-catalog';
import {
  coerceDamageLevelCode,
  formatAutoFixMoney,
  resolveDamageLevelFromText,
} from './autofix-config';
import type { DraftQuote } from './autofix-config';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { QuoteLineSource } from './text-client-quote.types';

export type ActualizarCotizacionAction =
  | 'pintar'
  | 'reparar_pintar'
  | 'cambiar_pintar'
  | 'ajustar'
  | 'otro';

export type ActualizarCotizacionSeverityHint = 'DML' | 'DM' | 'DF' | 'unknown';

export type ActualizarCotizacionItemInput = {
  partName: string;
  action: ActualizarCotizacionAction;
  damageDescription?: string;
  severityHint?: ActualizarCotizacionSeverityHint;
  serviceCodeHint?: string;
  source: QuoteLineSource;
  evidenceImageIds?: string[];
};

export type ActualizarCotizacionInput = {
  conversationId: string;
  tallerId: string;
  quoteId?: string;
  customerText: string;
  items: ActualizarCotizacionItemInput[];
};

export type FormattedQuoteLine = {
  panelCode: string;
  nombreVisible: string;
  catalogServicio: string | null;
  severidad: string;
  precioOficial: number;
  precioFinal: number;
  fuente: QuoteLineSource;
  evidencia: string;
  estadoRevision: 'pendiente_revision_fisica' | 'requiere_revision_manual';
  action: ActualizarCotizacionAction;
  notasInternas: string;
};

export type ActualizarCotizacionResult = {
  success: boolean;
  quoteId: string | null;
  itemsAdded: FormattedQuoteLine[];
  itemsPending: FormattedQuoteLine[];
  total: number;
  subtotal: number;
  formattedLines: FormattedQuoteLine[];
  requiresHumanReview: boolean;
  customerMessageData: {
    pricedLines: Array<{
      label: string;
      amount: number;
      currency: string;
    }>;
    pendingLines: string[];
    total: number;
    currency: string;
    disclaimer: string;
  };
  error?: string;
};

function resolveSeverityForItem(item: ActualizarCotizacionItemInput): string {
  const hint = String(item.severityHint ?? '').trim();
  if (hint === 'DML' || hint === 'DM' || hint === 'DF') {
    return hint;
  }
  const blob = [item.damageDescription, item.partName, item.action].filter(Boolean).join(' ');
  const fromText = resolveDamageLevelFromText('', blob);
  if (fromText && fromText !== 'N/A') {
    return fromText;
  }
  if (item.action === 'pintar' || item.action === 'ajustar') {
    return 'DL';
  }
  return 'DM';
}

function resolvePanelCodeForItem(item: ActualizarCotizacionItemInput): string {
  const hint = String(item.serviceCodeHint ?? '').trim();
  if (hint) {
    return normalizePanelPiezaCode(hint);
  }
  return normalizePanelPiezaCode(item.partName);
}

function buildNotasInternas(item: ActualizarCotizacionItemInput): string {
  const parts = [
    item.partName,
    item.action !== 'otro' ? `acción: ${item.action}` : '',
    item.damageDescription?.trim() ?? '',
  ].filter(Boolean);
  return parts.join(' | ');
}

export function resolveCatalogItemToQuoteLine(
  item: ActualizarCotizacionItemInput,
  snap: MatrixPricingSnapshot,
  evidenceUrls: string[],
): FormattedQuoteLine {
  const panelCode = resolvePanelCodeForItem(item);
  const opt = findPanelPiezaOption(panelCode);
  const nombreVisible = opt?.fullName ?? panelCode;
  const severidad = coerceDamageLevelCode(resolveSeverityForItem(item));
  const matrixRaw = resolveMatrixServicioRaw(panelCode);
  const catalogServicio = snap.matchServicio(matrixRaw);
  const notasInternas = buildNotasInternas(item);
  const evidencia =
    evidenceUrls.length > 0
      ? evidenceUrls.join(', ')
      : 'sin foto / declarado por cliente';

  if (!catalogServicio) {
    return {
      panelCode,
      nombreVisible,
      catalogServicio: null,
      severidad,
      precioOficial: 0,
      precioFinal: 0,
      fuente: item.source,
      evidencia,
      estadoRevision: 'requiere_revision_manual',
      action: item.action,
      notasInternas,
    };
  }

  let precioOficial = snap.getAmount(catalogServicio, severidad);
  if (precioOficial <= 0 && severidad !== 'DL') {
    precioOficial = snap.getAmount(catalogServicio, 'DL');
  }

  if (precioOficial <= 0) {
    return {
      panelCode,
      nombreVisible,
      catalogServicio,
      severidad,
      precioOficial: 0,
      precioFinal: 0,
      fuente: item.source,
      evidencia,
      estadoRevision: 'requiere_revision_manual',
      action: item.action,
      notasInternas,
    };
  }

  return {
    panelCode,
    nombreVisible,
    catalogServicio,
    severidad,
    precioOficial,
    precioFinal: precioOficial,
    fuente: item.source,
    evidencia,
    estadoRevision: 'pendiente_revision_fisica',
    action: item.action,
    notasInternas,
  };
}

export function formattedLinesToDetectedDamageItems(
  lines: readonly FormattedQuoteLine[],
): DetectedDamageItem[] {
  return lines.map((l) => ({
    pieza: l.panelCode,
    severidad: l.severidad,
    descripcionTecnica: l.notasInternas,
    urls_origen: l.evidencia.startsWith('http') ? [l.evidencia] : [],
    fuente: l.fuente,
    nombreVisible: l.nombreVisible,
    catalogServicio: l.catalogServicio ?? undefined,
    precioOficial: l.precioOficial,
    precioFinal: l.precioFinal,
    evidencia: l.evidencia,
    estadoRevision: l.estadoRevision,
    notasInternas: l.notasInternas,
  }));
}

export function buildCustomerMessageDataFromQuote(
  quote: DraftQuote,
  itemsAdded: readonly FormattedQuoteLine[],
  itemsPending: readonly FormattedQuoteLine[],
): ActualizarCotizacionResult['customerMessageData'] {
  const currency = quote.currency;
  const pricedLines = (quote.lines ?? []).map((l) => ({
    label: l.description,
    amount: Math.round(Number(l.subtotal ?? l.unitPrice ?? 0)),
    currency,
  }));

  return {
    pricedLines,
    pendingLines: itemsPending.map(
      (p) => p.nombreVisible || p.panelCode,
    ),
    total: Math.round(Number(quote.total ?? 0)),
    currency,
    disclaimer:
      'Importes del catálogo oficial del taller. Sujetos a revisión física en planta.',
  };
}

export function buildFormattedLinesSummary(
  lines: readonly FormattedQuoteLine[],
): string[] {
  return lines.map((l) => {
    if (l.precioFinal > 0) {
      return `${l.nombreVisible} (${l.panelCode}) — ${l.severidad}: ${formatAutoFixMoney(l.precioFinal)}`;
    }
    return `${l.nombreVisible} (${l.panelCode}) — pendiente de revisión manual`;
  });
}

export function parseActualizarCotizacionToolArgs(
  argsJson: string,
): { ok: true; data: Omit<ActualizarCotizacionInput, 'conversationId' | 'tallerId'> } | { ok: false; error: string } {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'Argumentos inválidos (JSON).' };
  }

  const customerText = String(raw.customerText ?? raw.customer_text ?? '').trim();
  const quoteId = String(raw.quoteId ?? raw.quote_id ?? '').trim() || undefined;
  const itemsRaw = raw.items;
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
    return { ok: false, error: 'Se requiere al menos un item en items[].' };
  }

  const items: ActualizarCotizacionItemInput[] = [];
  for (const row of itemsRaw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const partName = String(r.partName ?? r.part_name ?? r.pieza ?? '').trim();
    if (!partName) continue;
    const actionRaw = String(r.action ?? 'pintar').trim() as ActualizarCotizacionAction;
    const action: ActualizarCotizacionAction = [
      'pintar',
      'reparar_pintar',
      'cambiar_pintar',
      'ajustar',
      'otro',
    ].includes(actionRaw)
      ? actionRaw
      : 'pintar';
    const sourceRaw = String(r.source ?? 'ai_suggestion').trim() as QuoteLineSource;
    const source: QuoteLineSource = [
      'texto_cliente',
      'vision',
      'manual',
      'ai_suggestion',
    ].includes(sourceRaw)
      ? sourceRaw
      : 'ai_suggestion';
    const sevRaw = String(r.severityHint ?? r.severity_hint ?? 'unknown').trim();
    const severityHint: ActualizarCotizacionSeverityHint = ['DML', 'DM', 'DF'].includes(
      sevRaw,
    )
      ? (sevRaw as ActualizarCotizacionSeverityHint)
      : 'unknown';
    const evidenceRaw = r.evidenceImageIds ?? r.evidence_image_ids;
    const evidenceImageIds = Array.isArray(evidenceRaw)
      ? evidenceRaw.map((id) => String(id ?? '').trim()).filter(Boolean)
      : undefined;

    items.push({
      partName,
      action,
      damageDescription: String(r.damageDescription ?? r.damage_description ?? '').trim() || undefined,
      severityHint,
      serviceCodeHint: String(r.serviceCodeHint ?? r.service_code_hint ?? '').trim() || undefined,
      source,
      evidenceImageIds,
    });
  }

  if (!items.length) {
    return { ok: false, error: 'Ningún item válido en items[].' };
  }

  return {
    ok: true,
    data: {
      quoteId,
      customerText: customerText || '(sin texto del cliente)',
      items,
    },
  };
}
