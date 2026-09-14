/**
 * Fase 6 — presentación y conciliación del mensaje al cliente.
 * No calcula precios. CanonicalQuoteV1 es la única autoridad financiera.
 */
import { isMolduraNonPaintableFinish } from '../../catalog/moldura';
import {
  getClientPieceLabel,
  humanizeClientPieceLabel,
  isMolduraPieza,
} from '../../catalog/panel-pieza-catalog';
import { isChargeableQuoteLine } from './quote-engine';
import { refaccionIdentityGaps } from './pending-quote-requirement';
import { QUOTE_SCHEMA_VERSION } from './types';
import { pegLogger } from '../../observability/pegazuz-logger';
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
  AWAITING_VEHICLE_DATA:
    'Para cotizar la refacción falta información del vehículo (marca, modelo o año).',
  PENDING_TREATMENT:
    'Hay piezas pendientes de peritaje; no se incluyen como cargo en este presupuesto.',
  MOLDURA_NO_PINTABLE_REQUIERE_REVISION:
    'La moldura queda pendiente de valoración para confirmar si requiere reinstalación, reparación o sustitución.',
  MOLDURA_MONTAJE_PENDIENTE:
    'El montaje de la moldura queda pendiente de confirmación en revisión física.',
  MONTAJE_TARIFA_NO_CONFIGURADA:
    'El montaje queda pendiente: el taller no tiene tarifa configurada para esa instalación.',
  SUSPECTED_INVOLVEMENT:
    'Hay piezas con posible involucramiento (desalineación o transferencia del golpe) que deben revisarse en taller antes de cotizarlas.',
  NOT_ASSESSABLE:
    'Hay piezas que no pueden valorarse con las imágenes actuales; se requiere revisión o evidencia adicional.',
};

/** Copy comprimido de presentación. No altera CanonicalQuote.warnings. */
export const PRESENTATION_HIDDEN_DAMAGE_COPY =
  'Pueden existir daños internos o fijaciones comprometidas que solo podrán confirmarse al desmontar y revisar físicamente el vehículo.';

export const PRESENTATION_PENDING_CONCEPTS_COPY =
  'Los conceptos pendientes no están incluidos en el subtotal.';

export const PRESENTATION_PARTIAL_FOOTER_GENERIC =
  'Cotización parcial: algunos conceptos continúan pendientes.';

export const PARTIAL_QUOTE_REASON = {
  INSUFFICIENT_MARKET_SAMPLE: 'INSUFFICIENT_MARKET_SAMPLE',
  AWAITING_VEHICLE_DATA: 'AWAITING_VEHICLE_DATA',
  MOLDURA_NO_PINTABLE_REQUIERE_REVISION:
    'MOLDURA_NO_PINTABLE_REQUIERE_REVISION',
  MOLDURA_PINTADA_UNCONFIGURED: 'MOLDURA_PINTADA_UNCONFIGURED',
  SUSPECTED_INVOLVEMENT: 'SUSPECTED_INVOLVEMENT',
  NOT_ASSESSABLE: 'NOT_ASSESSABLE',
  PENDING_TREATMENT: 'PENDING_TREATMENT',
  UNCONFIGURED: 'UNCONFIGURED',
  MONTAJE_TARIFA_NO_CONFIGURADA: 'MONTAJE_TARIFA_NO_CONFIGURADA',
} as const;

export type PartialQuoteReasonCode =
  (typeof PARTIAL_QUOTE_REASON)[keyof typeof PARTIAL_QUOTE_REASON];

export type PartialQuoteReason = {
  code: PartialQuoteReasonCode;
  text: string;
};

function isMolduraLine(
  line: QuoteLine,
  damage?: DamageItem,
): boolean {
  if (damage && isMolduraPieza(damage.pieceCode)) return true;
  if (isMolduraPieza(line.description)) return true;
  return /moldura/i.test(String(line.description ?? ''));
}

function molduraPendingRevisionCopy(pieceLabel?: string): string {
  const raw = String(pieceLabel ?? '').trim();
  const labeled = raw && /moldura/i.test(raw) ? raw : 'La moldura';
  const subject = /^la\s/i.test(labeled)
    ? labeled
    : `La ${labeled.charAt(0).toLowerCase()}${labeled.slice(1)}`;
  return `${subject} queda pendiente de valoración para confirmar si requiere reinstalación, reparación o sustitución.`;
}

/**
 * Causa estructurada de isPartial. El LLM no inventa esta razón.
 * Fuente: warnings + serviceType + pricingStatus de líneas no cobrables.
 */
export function derivePartialQuoteReasons(
  quote: CanonicalQuoteV1,
  peritaje?: CanonicalPeritajeV1 | null,
): PartialQuoteReason[] {
  const reasons: PartialQuoteReason[] = [];
  const seen = new Set<string>();
  const push = (code: PartialQuoteReasonCode, text: string) => {
    if (seen.has(code)) return;
    seen.add(code);
    reasons.push({ code, text });
  };
  const damageById = new Map(
    (peritaje?.damages ?? []).map((d) => [d.damageItemId, d]),
  );
  const warnings = new Set(quote.warnings ?? []);

  for (const line of quote.lines) {
    if (line.serviceType === 'ADVERTENCIA') continue;
    if (isChargeableQuoteLine(line)) continue;
    const damage = damageById.get(line.damageItemId);
    const pieceLabel =
      damage?.pieceLabel?.trim() || inferPieceLabelFromQuoteLine(line);
    const moldura = isMolduraLine(line, damage);
    const unconfigured =
      line.pricingStatus === 'UNCONFIGURED' ||
      line.pricingSource === 'UNCONFIGURED';

    if (line.serviceType === 'MONTAJE' && unconfigured) {
      push(
        PARTIAL_QUOTE_REASON.MONTAJE_TARIFA_NO_CONFIGURADA,
        'El montaje queda pendiente: el taller no tiene tarifa configurada para esa instalación.',
      );
      continue;
    }

    if (line.serviceType === 'REFACCION') {
      const awaiting =
        line.pricingStatus === 'AWAITING_VEHICLE_DATA' ||
        line.pricingSource === 'AWAITING_VEHICLE_DATA';
      if (awaiting) {
        const vehicle = peritaje?.vehicles?.find(
          (v) => v.vehicleId === line.vehicleId,
        );
        const gaps = refaccionIdentityGaps(vehicle);
        const needsModel =
          gaps.confirmationFields.includes('model') ||
          gaps.missingFields.includes('model');
        const needsYear =
          gaps.missingFields.includes('year') ||
          gaps.confirmationFields.includes('year');
        const text =
          needsModel && needsYear
            ? 'Para cotizar la refacción hay que confirmar modelo y año del vehículo.'
            : needsModel
              ? 'Para cotizar la refacción hay que confirmar el modelo del vehículo.'
              : needsYear &&
                  !gaps.confirmationFields.includes('make') &&
                  !gaps.confirmationFields.includes('model')
                ? 'Para cotizar la refacción falta el año del vehículo.'
                : 'Para cotizar la refacción hay que confirmar la identidad del vehículo.';
        push(PARTIAL_QUOTE_REASON.AWAITING_VEHICLE_DATA, text);
        continue;
      }
      push(
        PARTIAL_QUOTE_REASON.INSUFFICIENT_MARKET_SAMPLE,
        'La refacción está pendiente de estimación de mercado.',
      );
      continue;
    }

    if (
      unconfigured &&
      moldura &&
      line.serviceType === 'REPARACION_PINTURA'
    ) {
      push(
        PARTIAL_QUOTE_REASON.MOLDURA_PINTADA_UNCONFIGURED,
        'La tarifa de reparación/pintura de la moldura está pendiente de configuración.',
      );
      continue;
    }

    if (
      moldura &&
      (warnings.has('MOLDURA_NO_PINTABLE_REQUIERE_REVISION') ||
        line.serviceType === 'PENDIENTE' ||
        isMolduraNonPaintableFinish(damage?.finishType))
    ) {
      push(
        PARTIAL_QUOTE_REASON.MOLDURA_NO_PINTABLE_REQUIERE_REVISION,
        molduraPendingRevisionCopy(pieceLabel),
      );
      continue;
    }

    if (
      damage?.damageEvidenceStatus === 'SUSPECTED_INVOLVEMENT' ||
      /posible involucramiento/i.test(line.description)
    ) {
      const labeled = pieceLabel && pieceLabel !== 'pieza' ? pieceLabel : 'esta pieza';
      push(
        PARTIAL_QUOTE_REASON.SUSPECTED_INVOLVEMENT,
        `${/^el\s|^la\s|^los\s|^las\s/i.test(labeled) ? labeled : `El ${labeled}`} presenta posible involucramiento respecto de la zona afectada y debe revisarse en taller.`,
      );
      continue;
    }

    if (
      damage?.damageEvidenceStatus === 'NOT_ASSESSABLE' ||
      /no valorable con las im[aá]genes actuales/i.test(line.description)
    ) {
      push(
        PARTIAL_QUOTE_REASON.NOT_ASSESSABLE,
        'Hay piezas que no pueden valorarse con las imágenes actuales; se requiere revisión o evidencia adicional.',
      );
      continue;
    }

    if (unconfigured) {
      push(
        PARTIAL_QUOTE_REASON.UNCONFIGURED,
        'Hay una tarifa pendiente de configuración.',
      );
      continue;
    }

    if (line.serviceType === 'PENDIENTE' || warnings.has('PENDING_TREATMENT')) {
      push(
        PARTIAL_QUOTE_REASON.PENDING_TREATMENT,
        'El tratamiento de esta pieza debe confirmarse antes de cotizarla.',
      );
    }
  }

  return reasons;
}

export function formatPartialQuoteDisclosure(
  reasons: readonly PartialQuoteReason[],
): string {
  if (!reasons.length) {
    return 'Hay conceptos pendientes de confirmación.';
  }
  return reasons.map((r) => r.text).join(' ');
}

function joinSpanishList(items: string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} y ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

const FEMININE_PIECE_RE =
  /^(tapa|calavera|fascia|salpicadera|moldura|puerta|luneta|caja|parrilla)\b/i;
const MASCULINE_PIECE_RE =
  /^(montaje|cofre|faro|espejo|parachoques|paragolpes|refuerzo|costado)\b/i;

function withArticle(label: string): string {
  const raw = String(label ?? '').trim();
  if (!raw) return raw;
  if (/^(el|la|los|las)\s/i.test(raw)) return raw;
  const lower = raw.charAt(0).toLowerCase() + raw.slice(1);
  if (FEMININE_PIECE_RE.test(raw)) return `la ${lower}`;
  if (MASCULINE_PIECE_RE.test(raw)) return `el ${lower}`;
  return raw;
}

export function isPendingReviewDamage(damage?: DamageItem | null): boolean {
  if (!damage) return false;
  if (damage.treatment === 'PENDIENTE') return true;
  return (
    damage.damageEvidenceStatus === 'SUSPECTED_INVOLVEMENT' ||
    damage.damageEvidenceStatus === 'NOT_ASSESSABLE'
  );
}

function pendingConceptLabel(
  line: QuoteLine,
  peritaje?: CanonicalPeritajeV1 | null,
): string {
  if (line.serviceType === 'MONTAJE' || line.serviceType === 'MONTAJE_PINTURA') {
    return 'el montaje';
  }
  const piece = resolveQuoteLinePieceLabel(line, peritaje);
  const articulated = withArticle(piece);
  if (line.serviceType === 'REFACCION') {
    return `la refacción de ${articulated}`;
  }
  return articulated;
}

export function pendingConceptLabelsForFooter(
  quote: CanonicalQuoteV1,
  peritaje?: CanonicalPeritajeV1 | null,
): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  let montaje = false;
  for (const line of quote.lines) {
    if (isChargeableQuoteLine(line)) continue;
    if (line.serviceType === 'MONTAJE' || line.serviceType === 'MONTAJE_PINTURA') {
      montaje = true;
      continue;
    }
    const label = pendingConceptLabel(line, peritaje);
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  const out: string[] = [];
  if (montaje) out.push('el montaje');
  out.push(...labels);
  return out;
}

/** Copy determinista singular/plural. No concatena verbos a ciegas. */
export function formatPendingConceptsCopy(labels: readonly string[]): string {
  const unique = [
    ...new Set(
      labels.map((label) => String(label ?? '').trim()).filter(Boolean),
    ),
  ];
  if (unique.length === 0) return PRESENTATION_PARTIAL_FOOTER_GENERIC;
  if (unique.length === 1) {
    return `Cotización parcial: ${unique[0]} continúa pendiente.`;
  }
  return `Cotización parcial: ${joinSpanishList(unique)} continúan pendientes.`;
}

export function formatPartialQuoteFooter(
  quote: CanonicalQuoteV1,
  peritaje?: CanonicalPeritajeV1 | null,
): string {
  if (!quote.isPartial) return '';
  return `_${formatPendingConceptsCopy(pendingConceptLabelsForFooter(quote, peritaje))}_`;
}

const SERVICE_LABEL: Record<QuoteServiceType, string> = {
  REPARACION_PINTURA: 'Reparación y pintura',
  REFACCION: 'Refacción',
  MONTAJE_PINTURA: 'Montaje y pintura',
  MONTAJE: 'Montaje',
  PENDIENTE: 'Pendiente de revisión',
  ADVERTENCIA: 'Advertencia',
};

const SERVICE_PREFIXES = [
  /^refacci[oó]n(?:\s+de)?\s+/i,
  /^montar y pintar\s+/i,
  /^montaje y pintura(?:\s+de)?\s+/i,
  /^montaje(?:\s+de)?\s+/i,
  /^reparaci[oó]n y pintura(?: estimada)?(?:\s+de)?\s+/i,
  /^reparar y pintar\s+/i,
];

export const REFACCION_AVAILABILITY_DISCLAIMER =
  'Precio aproximado sujeto a disponibilidad.';

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
  const damage = peritaje?.damages.find(
    (d) => d.damageItemId === line.damageItemId,
  );
  const fromPeritaje = damage?.pieceLabel;
  const raw = fromPeritaje?.trim() || inferPieceLabelFromQuoteLine(line);
  return (
    getClientPieceLabel(damage?.pieceCode || raw, damage) ||
    humanizeClientPieceLabel(raw) ||
    raw
  );
}

export function buildControlledQuoteLineLabel(
  serviceType: QuoteServiceType,
  pieceLabel: string,
): string {
  const piece = String(pieceLabel ?? '').trim() || 'pieza';
  if (serviceType === 'REFACCION') return `Refacción ${piece}`;
  if (serviceType === 'MONTAJE') return `Montaje ${piece}`;
  if (serviceType === 'MONTAJE_PINTURA') return `Montaje y pintura ${piece}`;
  if (serviceType === 'REPARACION_PINTURA') {
    return `Reparación y pintura ${piece}`;
  }
  if (serviceType === 'PENDIENTE') return `${piece} — pendiente de revisión`;
  return `${SERVICE_LABEL[serviceType] ?? serviceType} ${piece}`.trim();
}

/**
 * priceRange = referencia de mercado mostrable.
 * amount = importe que CanonicalQuote usa en el total.
 * El renderer nunca calcula el total desde texto.
 */
function lineDisplayAmount(line: QuoteLine): string | null {
  if (line.priceRange && line.priceRange.min >= 0 && line.priceRange.max >= line.priceRange.min) {
    return `${formatQuoteMoneyRange(line.priceRange.min, line.priceRange.max)} MXN`;
  }
  return `${formatQuoteMoney(line.amount)} MXN`;
}

function isMarketRefaccionLine(line: QuoteLine): boolean {
  return (
    line.serviceType === 'REFACCION' &&
    (line.pricingSource === 'WEB_MARKET_ESTIMATE' ||
      line.pricingSource === 'MARKET')
  );
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
  const pendingPiecesRendered = new Set<string>();
  const damageById = new Map(
    (peritaje?.damages ?? []).map((d) => [d.damageItemId, d]),
  );

  for (const line of canonicalQuote.lines) {
    const piece = resolveQuoteLinePieceLabel(line, peritaje);
    const label = buildControlledQuoteLineLabel(line.serviceType, piece);
    const damage = damageById.get(line.damageItemId);

    if (isPendingReviewDamage(damage) || line.serviceType === 'PENDIENTE') {
      if (pendingPiecesRendered.has(line.damageItemId)) continue;
      pendingPiecesRendered.add(line.damageItemId);
      lineTexts.push(`🟡 ${piece} — pendiente de revisión`);
      continue;
    }

    if (isChargeableQuoteLine(line)) {
      const amountText = lineDisplayAmount(line);
      lineTexts.push(`🛠️ ${label}: ${amountText}`);
      if (isMarketRefaccionLine(line)) {
        lineTexts.push(`_${REFACCION_AVAILABILITY_DISCLAIMER}_`);
      }
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

    if (line.serviceType === 'REFACCION' && !isChargeableQuoteLine(line)) {
      const awaiting =
        line.pricingStatus === 'AWAITING_VEHICLE_DATA' ||
        line.pricingSource === 'AWAITING_VEHICLE_DATA';
      lineTexts.push(
        awaiting
          ? `🔧 ${piece} — refacción pendiente de datos del vehículo`
          : `🛠️ ${label}: precio pendiente de estimación`,
      );
      continue;
    }

    if (line.serviceType === 'MONTAJE' && !isChargeableQuoteLine(line)) {
      lineTexts.push(`🔩 Montaje — tarifa pendiente`);
      continue;
    }

    if (!isChargeableQuoteLine(line)) {
      lineTexts.push(`🛠️ ${label}: pendiente de configuración`);
    }
  }

  const totalAmt = Math.round(canonicalQuote.total);
  displayedAmounts.push(totalAmt);
  const isPartial = canonicalQuote.isPartial === true;
  const footer = formatPartialQuoteFooter(canonicalQuote, peritaje);
  const totalText = isPartial
    ? [`💰 *Subtotal actual: ${formatQuoteMoney(totalAmt)} MXN*`, footer]
        .filter(Boolean)
        .join('\n')
    : `💰 *Total: ${formatQuoteMoney(totalAmt)} MXN*`;

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

function serviceShortLabelForValidation(serviceType: QuoteServiceType): string {
  if (serviceType === 'REFACCION') return 'Refacción';
  if (serviceType === 'MONTAJE') return 'Montaje';
  if (serviceType === 'MONTAJE_PINTURA') return 'Montaje y pintura';
  if (serviceType === 'REPARACION_PINTURA') return 'Reparación y pintura';
  if (serviceType === 'PENDIENTE') return 'Pendiente';
  return String(serviceType);
}

function quoteLineLabelAppearsInMessage(
  message: string,
  line: QuoteLine,
  piece: string,
): boolean {
  const full = buildControlledQuoteLineLabel(line.serviceType, piece);
  if (message.includes(full)) return true;
  const short = serviceShortLabelForValidation(line.serviceType);
  const piecePresent =
    message.includes(`*${piece}*`) ||
    message.includes(piece) ||
    message.includes(`*${piece}:*`);
  if (piecePresent && message.includes(`${short}:`)) return true;
  if (
    (line.serviceType === 'PENDIENTE' || line.serviceType === 'ADVERTENCIA') &&
    piecePresent &&
    /pendiente de revisi[oó]n/i.test(message)
  ) {
    return true;
  }
  return false;
}

const HIDDEN_DAMAGE_PRESENTATION_CODES = new Set([
  'HIDDEN_DAMAGE',
  'POSSIBLE_SUBSTITUTION',
  'SUSPECTED_INVOLVEMENT',
]);

const PENDING_PRESENTATION_CODES = new Set([
  'AWAITING_VEHICLE_DATA',
  'REFACCION_PENDIENTE_DE_COTIZAR',
  'MONTAJE_TARIFA_NO_CONFIGURADA',
  'PENDING_TREATMENT',
  'NOT_ASSESSABLE',
  'MOLDURA_NO_PINTABLE_REQUIERE_REVISION',
  'MOLDURA_MONTAJE_PENDIENTE',
]);

function warningAppearsInMessage(code: string, message: string): boolean {
  const canonical = CANONICAL_WARNING_COPY[code];
  if (canonical && message.includes(canonical)) return true;
  if (
    HIDDEN_DAMAGE_PRESENTATION_CODES.has(code) &&
    message.includes(PRESENTATION_HIDDEN_DAMAGE_COPY)
  ) {
    return true;
  }
  if (
    PENDING_PRESENTATION_CODES.has(code) &&
    (/Cotización parcial:/i.test(message) ||
      message.includes(PRESENTATION_PENDING_CONCEPTS_COPY) ||
      message.includes(PRESENTATION_PARTIAL_FOOTER_GENERIC))
  ) {
    return true;
  }
  return false;
}

function requiredWarningCodes(quote: CanonicalQuoteV1): string[] {
  return (quote.warnings ?? []).filter((w) =>
    Boolean(CANONICAL_WARNING_COPY[w] || w === 'REFACCION_PENDIENTE_DE_COTIZAR'),
  );
}

export type ClientMessageValidationScope = {
  presentation?: 'FULL' | 'DELTA' | 'NONE';
  requiredQuoteLineIds?: readonly string[];
};

export function validateFinalClientQuoteMessage(input: {
  canonicalQuote: CanonicalQuoteV1;
  renderedFinancialBlock: string;
  finalMessage: string;
  warningsBlock?: string;
  peritaje?: CanonicalPeritajeV1 | null;
  scope?: ClientMessageValidationScope;
}): FinalMessageValidation {
  const errors: string[] = [];
  const events: NarrativeObservabilityEvent[] = [];
  const quote = input.canonicalQuote;
  const message = String(input.finalMessage ?? '');
  const block = String(input.renderedFinancialBlock ?? '');
  const quoteId = quote.quoteId;
  const presentation = input.scope?.presentation ?? 'FULL';
  const requiredIds = input.scope?.requiredQuoteLineIds
    ? new Set(input.scope.requiredQuoteLineIds)
    : null;

  const push = (event: NarrativeEventCode, error: string) => {
    errors.push(error);
    events.push({ event, quoteId, detail: error });
  };

  if (presentation === 'NONE') {
    const extraHits = extractMonetaryAmounts(message);
    if (extraHits.length) {
      push(
        NARRATIVE_EVENTS.EXTRA_MONETARY_AMOUNT,
        `Importes extra en respuesta sin quote: ${extraHits.map((h) => h.raw).join(', ')}`,
      );
    }
    return { ok: errors.length === 0, errors, events };
  }

  if (!block || !message.includes(block)) {
    push(
      NARRATIVE_EVENTS.NARRATIVE_FINANCIAL_MISMATCH,
      'El financialBlock determinista no está contenido en el mensaje final',
    );
  }

  for (const line of quote.lines) {
    if (!isChargeableQuoteLine(line)) continue;
    if (requiredIds && !requiredIds.has(line.quoteLineId)) continue;
    const piece = resolveQuoteLinePieceLabel(line, input.peritaje);
    if (!quoteLineLabelAppearsInMessage(message, line, piece)) {
      push(
        NARRATIVE_EVENTS.MISSING_REQUIRED_LINE,
        `Falta línea requerida: ${buildControlledQuoteLineLabel(line.serviceType, piece)}`,
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
      !/parcial|incompleta|pendiente de cotizar|pendiente de estimaci|pendiente de valoraci|pendiente de configuraci|debe confirmarse/i.test(
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
  if (presentation === 'FULL') {
    for (const code of requiredWarningCodes(quote)) {
      if (!warningAppearsInMessage(code, message)) {
        push(
          NARRATIVE_EVENTS.MISSING_REQUIRED_WARNING,
          `Falta warning obligatorio ${code}`,
        );
      }
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
    pegLogger.debug('NARRATIVE', {
      event: ev.event,
      quoteId: ev.quoteId,
      detail: ev.detail,
    });
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
    input.damages?.length
      ? ({ damages: input.damages } as CanonicalPeritajeV1)
      : null,
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
