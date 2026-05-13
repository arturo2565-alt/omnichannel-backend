import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import {
  AUTO_FIX_CURRENCY,
  formatAutoFixMoney,
  normalizeTextForMatch,
} from './autofix-config';

export type InstantQuoteLine = { label: string; amount: number };

export type InstantQuoteResolution = {
  lines: InstantQuoteLine[];
  extras: InstantQuoteLine[];
  subtotal: number;
  total: number;
  currency: typeof AUTO_FIX_CURRENCY;
};

const BAÑO_CANON_SUBSTR = 'baño de pintura';

function isBañoDePinturaServicio(canonical: string): boolean {
  return normalizeTextForMatch(canonical).includes(BAÑO_CANON_SUBSTR);
}

/** Severidad en BD para filas de Baño de Pintura Exterior (tamaño / variante). */
function inferBañoTierSeveridad(userText: string): string {
  const n = normalizeTextForMatch(userText);
  const rules: { re: RegExp; sev: string }[] = [
    { re: /\bxl\s*premium\b/, sev: 'XL Premium' },
    { re: /\bgrande\s*premium\b/, sev: 'Grande Premium' },
    { re: /\bmediano\s*premium\b/, sev: 'Mediano Premium' },
    { re: /\bchico\s*premium\b/, sev: 'Chico Premium' },
    { re: /\bxl\b/, sev: 'XL' },
    { re: /\bgrande\b/, sev: 'Grande' },
    { re: /\bmediano\b/, sev: 'Mediano' },
    { re: /\bchico\b/, sev: 'Chico' },
  ];
  for (const { re, sev } of rules) {
    if (re.test(n)) return sev;
  }
  return 'Mediano';
}

export function mentionsCambioDeColor(userText: string): boolean {
  const n = normalizeTextForMatch(userText);
  return (
    /\bcambio\s+de\s+color\b/.test(n) ||
    /\bcambio\s+color\b/.test(n) ||
    /\bcambio\s+de\s+pintura\s+.*color\b/.test(n) ||
    /\bcolor\s+diferente\b/.test(n) ||
    /\bcambiar\s+(el\s+)?color\b/.test(n)
  );
}

/** Suplemento MXN por cambio de color con baño de pintura (según tamaño). */
export function cambioDeColorAddonMx(severidadBaño: string): number {
  const s = normalizeTextForMatch(severidadBaño);
  if (/\b(grande|xl)\b/.test(s)) return 10_000;
  if (/\b(chico|mediano)\b/.test(s)) return 8_000;
  return 8_000;
}

/**
 * Si el texto encaja con un servicio InstantQuote en catálogo, devuelve líneas y total.
 * No usa borrador ni visión.
 */
export function tryResolveInstantQuoteFromUserText(
  userText: string,
  snap: MatrixPricingSnapshot,
): InstantQuoteResolution | null {
  const t = String(userText ?? '').trim();
  if (!t) return null;

  const canonical = snap.matchServicio(t);
  if (!canonical) return null;

  let severidadLiteral: string;
  if (canonical === 'Estética Automotriz') {
    severidadLiteral = 'N/A';
  } else if (isBañoDePinturaServicio(canonical)) {
    severidadLiteral = inferBañoTierSeveridad(t);
  } else {
    severidadLiteral = 'N/A';
  }

  const base = snap.getPriceExact(t, severidadLiteral);
  if (base <= 0) return null;
  if (!snap.isInstantExact(t, severidadLiteral)) return null;

  const lines: InstantQuoteLine[] = [
    {
      label: `${canonical} (${severidadLiteral})`,
      amount: base,
    },
  ];
  const extras: InstantQuoteLine[] = [];

  let add = 0;
  if (isBañoDePinturaServicio(canonical) && mentionsCambioDeColor(t)) {
    add = cambioDeColorAddonMx(severidadLiteral);
    extras.push({
      label: 'Cambio de color (suplemento)',
      amount: add,
    });
  }

  const subtotal = base;
  const total = base + add;
  return {
    lines,
    extras,
    subtotal,
    total,
    currency: AUTO_FIX_CURRENCY,
  };
}

/** Formato amigable tipo WhatsApp / panel (negritas con *). */
export function formatInstantQuoteClientMessage(r: InstantQuoteResolution): string {
  const blocks: string[] = [
    '¡Hola! Te comparto una cotización *orientativa* con los precios vigentes del catálogo:',
    '',
    ...r.lines.map((l) => `• *${l.label}*: ${formatAutoFixMoney(l.amount)} ${r.currency}`),
  ];
  if (r.extras.length) {
    blocks.push(
      '',
      ...r.extras.map((l) => `• *${l.label}*: ${formatAutoFixMoney(l.amount)} ${r.currency}`),
    );
  }
  blocks.push(
    '',
    `*Total aproximado: ${formatAutoFixMoney(r.total)} ${r.currency}*`,
    '',
    'Los importes y tiempos pueden ajustarse tras una revisión en taller. Si quieres, te ayudo a agendar una visita.',
  );
  return blocks.join('\n');
}
