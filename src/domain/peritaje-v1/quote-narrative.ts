/**
 * Fase 6 — presentación y conciliación del mensaje al cliente.
 * No calcula precios. CanonicalQuoteV1 es la única autoridad financiera.
 */
import { isChargeableQuoteLine } from './quote-engine';
import { QUOTE_SCHEMA_VERSION } from './types';
import type {
  CanonicalPeritajeV1,
  CanonicalQuoteV1,
  DamageItem,
  QuoteLine,
  QuoteServiceType,
  VehicleIdentity,
} from './types';
import { validateCanonicalQuoteFinancial } from './quote-engine';

export const NARRATIVE_FLOW = {
  CANONICAL: 'CANONICAL_NARRATIVE_FLOW',
  LEGACY: 'LEGACY_NARRATIVE_FLOW',
} as const;

export type NarrativeFlow = (typeof NARRATIVE_FLOW)[keyof typeof NARRATIVE_FLOW];

export const NARRATIVE_EVENTS = {
  NARRATIVE_FINANCIAL_MISMATCH: 'NARRATIVE_FINANCIAL_MISMATCH',
  EXTRA_MONETARY_AMOUNT: 'EXTRA_MONETARY_AMOUNT',
  MISSING_REQUIRED_LINE: 'MISSING_REQUIRED_LINE',
  MISSING_REQUIRED_WARNING: 'MISSING_REQUIRED_WARNING',
  PARTIAL_QUOTE_NOT_DISCLOSED: 'PARTIAL_QUOTE_NOT_DISCLOSED',
  LLM_NARRATIVE_REJECTED: 'LLM_NARRATIVE_REJECTED',
  DETERMINISTIC_FALLBACK_USED: 'DETERMINISTIC_FALLBACK_USED',
} as const;

export type NarrativeEventCode =
  (typeof NARRATIVE_EVENTS)[keyof typeof NARRATIVE_EVENTS];

export type NarrativeObservabilityEvent = {
  event: NarrativeEventCode;
  quoteId?: string;
  detail?: string;
};

export type ClientQuoteMessage = {
  intro: string;
  technicalExplanation: string;
  financialBlock: string;
  warningsBlock: string;
  cta: string;
};

export type LlmNarrativeParts = {
  intro: string;
  technicalExplanation: string;
  cta: string;
};

export type RenderedFinancialBlock = {
  text: string;
  lineTexts: string[];
  totalText: string;
  isPartial: boolean;
  chargeableLabels: string[];
  displayedAmounts: number[];
};

export type FinalMessageValidation = {
  ok: boolean;
  errors: string[];
  events: NarrativeObservabilityEvent[];
};

export const CANONICAL_WARNING_COPY: Record<string, string> = {
  HIDDEN_DAMAGE:
    'Por la magnitud del impacto podrían existir daños internos no visibles. El presupuesto final queda sujeto a desmontaje y revisión física.',
  POSSIBLE_SUBSTITUTION:
    'A reserva de revisión física. Si los anclajes o la estructura de la pieza están comprometidos, podría requerirse sustitución y el precio se actualizará.',
  REFACCION_PENDIENTE_DE_COTIZAR:
    'La refacción queda pendiente de cotizar. El total mostrado no incluye ese concepto.',
  PENDING_TREATMENT:
    'Hay piezas pendientes de peritaje; no se incluyen como cargo en este presupuesto.',
};

const SERVICE_LABEL: Record<QuoteServiceType, string> = {
  REPARACION_PINTURA: 'Reparación y pintura',
  REFACCION: 'Refacción',
  MONTAJE_PINTURA: 'Montaje y pintura',
  PENDIENTE: 'Pendiente de revisión',
  ADVERTENCIA: 'Advertencia',
};

const SERVICE_PREFIXES = [
  /^refacci[oó]n(?:\s+de)?\s+/i,
  /^montar y pintar\s+/i,
  /^montaje y pintura(?:\s+de)?\s+/i,
  /^reparaci[oó]n y pintura(?: estimada)?(?:\s+de)?\s+/i,
  /^reparar y pintar\s+/i,
];

export function isCanonicalNarrativeEligible(
  quote: unknown,
): quote is CanonicalQuoteV1 {
  if (!quote || typeof quote !== 'object') return false;
  const q = quote as CanonicalQuoteV1;
  if (q.schemaVersion !== QUOTE_SCHEMA_VERSION) return false;
  if (!Array.isArray(q.lines)) return false;
  return validateCanonicalQuoteFinancial(q).length === 0;
}

export function formatQuoteMoney(amount: number): string {
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  return `$${amt.toLocaleString('es-MX')}`;
}

export function formatQuoteMoneyRange(min: number, max: number): string {
  return `${formatQuoteMoney(min)}–${formatQuoteMoney(max)}`;
}

export function inferPieceLabelFromQuoteLine(line: QuoteLine): string {
  let d = String(line.description ?? '').trim();
  d = d.replace(/\s*[—-]\s*(nivel|pendiente|mercado).*$/i, '').trim();
  for (const re of SERVICE_PREFIXES) {
    d = d.replace(re, '').trim();
  }
  return d || 'pieza';
}

export function resolveQuoteLinePieceLabel(
  line: QuoteLine,
  peritaje?: CanonicalPeritajeV1 | null,
): string {
  const fromPeritaje = peritaje?.damages.find(
    (d) => d.damageItemId === line.damageItemId,
  )?.pieceLabel;
  if (fromPeritaje?.trim()) return fromPeritaje.trim();
  return inferPieceLabelFromQuoteLine(line);
}

export function buildControlledQuoteLineLabel(
  serviceType: QuoteServiceType,
  pieceLabel: string,
): string {
  const piece = String(pieceLabel ?? '').trim() || 'pieza';
  if (serviceType === 'REFACCION') return `Refacción ${piece}`;
  if (serviceType === 'MONTAJE_PINTURA') return `Montaje y pintura ${piece}`;
  if (serviceType === 'REPARACION_PINTURA') {
    return `Reparación y pintura ${piece}`;
  }
  if (serviceType === 'PENDIENTE') return `${piece} — pendiente de revisión`;
  return `${SERVICE_LABEL[serviceType] ?? serviceType} ${piece}`.trim();
}

function lineDisplayAmount(line: QuoteLine): string | null {
  if (line.priceRange && line.priceRange.min >= 0 && line.priceRange.max >= line.priceRange.min) {
    return `${formatQuoteMoneyRange(line.priceRange.min, line.priceRange.max)} MXN`;
  }
  return `${formatQuoteMoney(line.amount)} MXN`;
}

/**
 * Bloque financiero determinista. Solo lee CanonicalQuoteV1 (+ etiquetas opcionales).
 */
export function renderCanonicalQuoteFinancialBlock(
  canonicalQuote: CanonicalQuoteV1,
  peritaje?: CanonicalPeritajeV1 | null,
): RenderedFinancialBlock {
  const lineTexts: string[] = [];
  const chargeableLabels: string[] = [];
  const displayedAmounts: number[] = [];

  for (const line of canonicalQuote.lines) {
    const piece = resolveQuoteLinePieceLabel(line, peritaje);
    const label = buildControlledQuoteLineLabel(line.serviceType, piece);

    if (isChargeableQuoteLine(line)) {
      const amountText = lineDisplayAmount(line);
      lineTexts.push(`🛠️ ${label}: ${amountText}`);
      chargeableLabels.push(label);
      displayedAmounts.push(Math.round(line.amount));
      if (line.priceRange) {
        displayedAmounts.push(
          Math.round(line.priceRange.min),
          Math.round(line.priceRange.max),
        );
      }
      continue;
    }

    if (
      line.serviceType === 'REFACCION' &&
      (line.pricingStatus === 'INSUFFICIENT_MARKET_SAMPLE' ||
        line.pricingSource === 'INSUFFICIENT_MARKET_SAMPLE' ||
        !line.billable)
    ) {
      lineTexts.push(`🛠️ ${label}: precio pendiente de estimación`);
    }
  }

  const totalAmt = Math.round(canonicalQuote.total);
  displayedAmounts.push(totalAmt);
  const isPartial = canonicalQuote.isPartial === true;
  const totalText = isPartial
    ? `💰 **Subtotal parcial / servicios cotizados: ${formatQuoteMoney(totalAmt)} MXN** *(cotización incompleta: falta el precio de refacción. El montaje/pintura no cubre la pieza de reemplazo).*`
    : `💰 **Inversión Total Estimada: ${formatQuoteMoney(totalAmt)} MXN** *(Sujeto a revisión física. Incluye materiales premium Sikkens y garantía).*`;

  const text = [...lineTexts, '', totalText].filter(Boolean).join('\n');
  return {
    text,
    lineTexts,
    totalText,
    isPartial,
    chargeableLabels,
    displayedAmounts,
  };
}

export function renderCanonicalQuoteWarningsBlock(
  canonicalQuote: CanonicalQuoteV1,
): { text: string; shownWarnings: string[] } {
  const shown: string[] = [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const raw of canonicalQuote.warnings ?? []) {
    const code = String(raw ?? '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const copy =
      CANONICAL_WARNING_COPY[code] ??
      'Hay una condición adicional sujeta a revisión en taller.';
    shown.push(code);
    lines.push(`⚠️ ${copy}`);
  }
  return {
    text: lines.join('\n'),
    shownWarnings: shown,
  };
}

export function assembleClientQuoteMessage(parts: ClientQuoteMessage): string {
  return [
    parts.intro,
    parts.technicalExplanation,
    parts.financialBlock,
    parts.warningsBlock,
    parts.cta,
  ]
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

const YEAR_RE = /\b(?:19|20)\d{2}\b/;
const TIME_RE = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/;
const DURATION_RE =
  /\b\d+\s*(?:a[nñ]o|a[nñ]os|d[ií]a|d[ií]as|hora|horas|semana|semanas|mes|meses)\b/i;
const WARRANTY_RE = /\bgarant[ií]a\s+(?:de\s+)?\d+\s*a[nñ]os?\b/i;

export type MonetaryHit = {
  raw: string;
  amount?: number;
  kind: 'currency' | 'spoken_thousands';
};

function stripAllowedNonCurrencyNumbers(text: string): string {
  return String(text ?? '')
    .replace(WARRANTY_RE, ' ')
    .replace(DURATION_RE, ' ')
    .replace(TIME_RE, ' ')
    .replace(YEAR_RE, ' ');
}

const CURRENCY_TOKEN_RE =
  /\$\s*[\d]{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\$\s*\d+(?:[.,]\d+)?|\b\d{1,3}(?:[.,]\d{3})+\s*(?:pesos|mxn|m\.?n\.?)?\b|\b\d+(?:[.,]\d+)?\s*(?:pesos|mxn|m\.?n\.?)\b/gi;

const SPOKEN_THOUSANDS_RE =
  /\b(?:unos|alrededor\s+de|aprox(?:imadamente)?)\s+\d[\d.,]*\s*mil(?:\s+pesos)?\b|\b\d{1,3}\s*mil(?:\s+pesos|\s+mxn)?\b|\b(?:un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento)\s+mil(?:\s+pesos)?\b/gi;

function parseMoneyToken(raw: string): number | undefined {
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return undefined;
  const n = Number(digits);
  return Number.isFinite(n) ? n : undefined;
}

export function extractMonetaryAmounts(text: string): MonetaryHit[] {
  const scanned = stripAllowedNonCurrencyNumbers(text);
  const hits: MonetaryHit[] = [];
  const seen = new Set<string>();

  for (const re of [CURRENCY_TOKEN_RE, SPOKEN_THOUSANDS_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scanned))) {
      const raw = m[0].trim();
      if (!raw || seen.has(raw.toLowerCase())) continue;
      seen.add(raw.toLowerCase());
      const spoken = SPOKEN_THOUSANDS_RE.test(raw) || /\bmil\b/i.test(raw);
      SPOKEN_THOUSANDS_RE.lastIndex = 0;
      hits.push({
        raw,
        amount: spoken && /\d/.test(raw)
          ? (parseMoneyToken(raw) ?? 0) * (/\bmil\b/i.test(raw) ? 1000 : 1)
          : parseMoneyToken(raw),
        kind: spoken ? 'spoken_thousands' : 'currency',
      });
    }
  }
  return hits;
}

export function llmNarrativeContainsForbiddenMoney(text: string): boolean {
  return extractMonetaryAmounts(text).length > 0;
}

export function sanitizeLlmNarrativeParts(
  parts: LlmNarrativeParts,
): { ok: true; parts: LlmNarrativeParts } | { ok: false; reason: string } {
  const joined = `${parts.intro}\n${parts.technicalExplanation}\n${parts.cta}`;
  if (llmNarrativeContainsForbiddenMoney(joined)) {
    return { ok: false, reason: 'llm_monetary_amount' };
  }
  if (
    /inversi[oó]n total|subtotal parcial|:\s*\$\s*\d/i.test(joined) ||
    /🛠️\s+(?:refacci[oó]n|montaje|reparaci[oó]n)/i.test(joined)
  ) {
    return { ok: false, reason: 'llm_second_quote' };
  }
  return { ok: true, parts };
}

function requiredWarningCodes(quote: CanonicalQuoteV1): string[] {
  return (quote.warnings ?? []).filter((w) =>
    Boolean(CANONICAL_WARNING_COPY[w] || w === 'REFACCION_PENDIENTE_DE_COTIZAR'),
  );
}

export function validateFinalClientQuoteMessage(input: {
  canonicalQuote: CanonicalQuoteV1;
  renderedFinancialBlock: string;
  finalMessage: string;
  warningsBlock?: string;
  peritaje?: CanonicalPeritajeV1 | null;
}): FinalMessageValidation {
  const errors: string[] = [];
  const events: NarrativeObservabilityEvent[] = [];
  const quote = input.canonicalQuote;
  const message = String(input.finalMessage ?? '');
  const block = String(input.renderedFinancialBlock ?? '');
  const quoteId = quote.quoteId;

  const push = (event: NarrativeEventCode, error: string) => {
    errors.push(error);
    events.push({ event, quoteId, detail: error });
  };

  if (!block || !message.includes(block)) {
    push(
      NARRATIVE_EVENTS.NARRATIVE_FINANCIAL_MISMATCH,
      'El financialBlock determinista no está contenido en el mensaje final',
    );
  }

  for (const line of quote.lines) {
    if (!isChargeableQuoteLine(line)) continue;
    const piece = resolveQuoteLinePieceLabel(line, input.peritaje);
    const label = buildControlledQuoteLineLabel(line.serviceType, piece);
    if (!message.includes(label)) {
      push(
        NARRATIVE_EVENTS.MISSING_REQUIRED_LINE,
        `Falta línea requerida: ${label}`,
      );
    }
    if (line.priceRange) {
      const range = formatQuoteMoneyRange(line.priceRange.min, line.priceRange.max);
      if (!message.includes(range)) {
        push(
          NARRATIVE_EVENTS.NARRATIVE_FINANCIAL_MISMATCH,
          `El rango ${range} no aparece tal cual`,
        );
      }
    } else if (!message.includes(formatQuoteMoney(line.amount))) {
      push(
        NARRATIVE_EVENTS.NARRATIVE_FINANCIAL_MISMATCH,
        `Falta importe ${formatQuoteMoney(line.amount)}`,
      );
    }
  }

  const totalFmt = formatQuoteMoney(quote.total);
  if (!message.includes(totalFmt)) {
    push(
      NARRATIVE_EVENTS.NARRATIVE_FINANCIAL_MISMATCH,
      `El total ${totalFmt} no aparece`,
    );
  }

  if (quote.isPartial) {
    if (
      !/parcial|incompleta|pendiente de cotizar|pendiente de estimaci/i.test(
        message,
      )
    ) {
      push(
        NARRATIVE_EVENTS.PARTIAL_QUOTE_NOT_DISCLOSED,
        'isPartial no se comunica en el mensaje',
      );
    }
    if (
      /inversi[oó]n total estimada/i.test(message) &&
      !/parcial|incompleta/i.test(message)
    ) {
      push(
        NARRATIVE_EVENTS.PARTIAL_QUOTE_NOT_DISCLOSED,
        'Un total parcial se presentó como alcance completo',
      );
    }
  }

  if (input.warningsBlock && !message.includes(input.warningsBlock)) {
    push(
      NARRATIVE_EVENTS.MISSING_REQUIRED_WARNING,
      'El bloque de warnings determinista no está en el mensaje',
    );
  }
  for (const code of requiredWarningCodes(quote)) {
    const copy = CANONICAL_WARNING_COPY[code];
    if (copy && !message.includes(copy)) {
      push(
        NARRATIVE_EVENTS.MISSING_REQUIRED_WARNING,
        `Falta warning obligatorio ${code}`,
      );
    }
  }

  const remainder = message.replace(block, '');
  const extraHits = extractMonetaryAmounts(remainder);
  if (extraHits.length) {
    push(
      NARRATIVE_EVENTS.EXTRA_MONETARY_AMOUNT,
      `Importes extra fuera del financialBlock: ${extraHits.map((h) => h.raw).join(', ')}`,
    );
  }

  for (const line of quote.lines) {
    if (line.serviceType === 'PENDIENTE' || line.serviceType === 'ADVERTENCIA') {
      if (
        line.amount > 0 &&
        new RegExp(
          `${line.serviceType === 'PENDIENTE' ? 'pendiente de revisi[oó]n' : 'advertencia'}[^\\n]*${formatQuoteMoney(line.amount).replace(/\$/g, '\\$')}`,
          'i',
        ).test(message)
      ) {
        push(
          NARRATIVE_EVENTS.NARRATIVE_FINANCIAL_MISMATCH,
          `${line.serviceType} no debe imprimirse como cargo`,
        );
      }
    }
    if (
      line.serviceType === 'REFACCION' &&
      !isChargeableQuoteLine(line) &&
      line.pricingStatus === 'INSUFFICIENT_MARKET_SAMPLE' &&
      message.includes(`${buildControlledQuoteLineLabel('REFACCION', resolveQuoteLinePieceLabel(line, input.peritaje))}: ${formatQuoteMoney(line.amount)}`)
    ) {
      push(
        NARRATIVE_EVENTS.NARRATIVE_FINANCIAL_MISMATCH,
        'REFACCION insuficiente no debe aparecer como precio definitivo',
      );
    }
    if (!isChargeableQuoteLine(line) && line.amount > 0 && line.billable === false) {
      const label = buildControlledQuoteLineLabel(
        line.serviceType,
        resolveQuoteLinePieceLabel(line, input.peritaje),
      );
      if (message.includes(`${label}: ${formatQuoteMoney(line.amount)}`)) {
        push(
          NARRATIVE_EVENTS.NARRATIVE_FINANCIAL_MISMATCH,
          'Línea no cobrable no debe aparecer como cargo',
        );
      }
    }
  }

  const byDamage = new Map<string, QuoteLine[]>();
  for (const line of quote.lines) {
    const list = byDamage.get(line.damageItemId) ?? [];
    list.push(line);
    byDamage.set(line.damageItemId, list);
  }
  for (const [damageItemId, lines] of byDamage) {
    const hasRefaccion = lines.some((l) => l.serviceType === 'REFACCION');
    const hasRepairLine = lines.some(
      (l) => l.serviceType === 'REPARACION_PINTURA',
    );
    if (!hasRefaccion || hasRepairLine) continue;
    const piece = resolveQuoteLinePieceLabel(lines[0], input.peritaje);
    const repairLabel = buildControlledQuoteLineLabel(
      'REPARACION_PINTURA',
      piece,
    );
    if (message.includes(`${repairLabel}:`)) {
      push(
        NARRATIVE_EVENTS.NARRATIVE_FINANCIAL_MISMATCH,
        `SUSTITUIR (${damageItemId}) no debe comunicarse como reparación simultánea`,
      );
    }
  }

  return { ok: errors.length === 0, errors, events };
}

export function logNarrativeEvents(
  events: readonly NarrativeObservabilityEvent[],
): void {
  for (const ev of events) {
    console.log(
      '[QuoteNarrative]',
      JSON.stringify({
        event: ev.event,
        quoteId: ev.quoteId,
        detail: ev.detail,
      }),
    );
  }
}

export function renderDeterministicClientQuoteFallback(input: {
  contactName: string;
  vehicle?: VehicleIdentity | null;
  damages?: DamageItem[];
  canonicalQuote: CanonicalQuoteV1;
  hasActiveAppointment: boolean;
  appointmentFormatted?: string;
  mapsUrl?: string;
  damageIntro?: string;
  isComplement?: boolean;
}): ClientQuoteMessage {
  const name = String(input.contactName ?? '').trim() || 'Estimado cliente';
  const vehicleLabel =
    input.vehicle?.displayLabel?.trim() ||
    [input.vehicle?.make, input.vehicle?.model, input.vehicle?.year]
      .filter(Boolean)
      .join(' ') ||
    '';
  const introBits = [
    `👋 ¡Listo, ${name}!`,
    String(input.damageIntro ?? '').trim() ||
      (vehicleLabel
        ? `Ya analizamos las fotos de tu ${vehicleLabel}.`
        : 'Ya analizamos las fotos de tu vehículo.'),
  ];
  if (input.isComplement) {
    introBits.push(
      'Este desglose actualiza tu presupuesto con los conceptos vigentes.',
    );
  }

  const tech = (input.damages ?? [])
    .map((d) => {
      const desc = String(d.descriptionTechnical ?? '').trim();
      if (!desc) return '';
      return `${d.pieceLabel}: ${desc}`;
    })
    .filter(Boolean)
    .slice(0, 6)
    .join(' ');

  const financial = renderCanonicalQuoteFinancialBlock(
    input.canonicalQuote,
  );
  const warnings = renderCanonicalQuoteWarningsBlock(input.canonicalQuote);

  const cta = input.hasActiveAppointment
    ? `**Te esperamos este ${String(input.appointmentFormatted ?? '').trim() || 'el día acordado para tu visita'} con tu vehículo en el taller.**\n\n¿Tienes alguna duda con las piezas o quieres ajustar algo antes de tu visita? 😊✨`
    : `📍 Estamos aquí, fácil de llegar: ${String(input.mapsUrl ?? '').trim() || 'https://goo.gl/maps/tu-ubicacion-real'}\n\n📅 Tenemos espacios esta semana. ¿Qué día te queda mejor para ingresar tu unidad?`;

  return {
    intro: introBits.join(' ').replace(/\s+/g, ' ').trim(),
    technicalExplanation: tech,
    financialBlock: financial.text,
    warningsBlock: warnings.text,
    cta,
  };
}

export type NarrativeSendSnapshotFields = {
  finalMessage: string;
  financialBlock: string;
  shownWarnings: string[];
  narrativeFlow: NarrativeFlow;
  sentAt: string;
};

export function buildNarrativeSnapshotFields(input: {
  finalMessage: string;
  financialBlock: string;
  shownWarnings: string[];
  narrativeFlow: NarrativeFlow;
  sentAt?: string;
}): NarrativeSendSnapshotFields {
  return {
    finalMessage: String(input.finalMessage ?? ''),
    financialBlock: String(input.financialBlock ?? ''),
    shownWarnings: [...(input.shownWarnings ?? [])],
    narrativeFlow: input.narrativeFlow,
    sentAt: input.sentAt || new Date().toISOString(),
  };
}
