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

const BAÑO_CANON_NORM = 'bano de pintura';

function isBañoDePinturaServicio(canonical: string): boolean {
  return normalizeTextForMatch(canonical).includes(BAÑO_CANON_NORM);
}

type CanonicalResolve = { canonical: string; via: 'direct' | 'bano_pintura_synonym' };

/**
 * Alinea texto libre del usuario con el nombre exacto en `price_matrix`.
 * Ej.: "Baño de pintura para Audi A5" → "Baño de Pintura Exterior" (no inventar servicio).
 */
export function resolveInstantCanonicalServicio(
  userText: string,
  snap: MatrixPricingSnapshot,
): CanonicalResolve | null {
  const t = String(userText ?? '').trim();
  if (!t) return null;

  const direct = snap.matchServicio(t);
  if (direct) return { canonical: direct, via: 'direct' };

  const n = normalizeTextForMatch(t);
  if (!n.includes('bano de pintura')) return null;

  for (const svc of snap.serviciosOrderedLongestFirst) {
    const ks = normalizeTextForMatch(svc);
    if (ks.includes('bano de pintura')) {
      return { canonical: svc, via: 'bano_pintura_synonym' };
    }
  }
  return null;
}

/** Severidad en BD para filas de Baño de Pintura Exterior (tamaño / variante). */
function inferBañoTierSeveridad(userText: string): string {
  const n = normalizeTextForMatch(userText);

  // Sedán / coupé premium mediano (catálogo: fila "Mediano Premium")
  if (
    /\baud?i\s*a\s*[45]\b/.test(n) ||
    /\baud?i\s*a[45]\b/.test(n) ||
    /\bbmw\s*(3[0-9]{2}i?|serie\s*3)\b/.test(n) ||
    /\bserie\s*3\b/.test(n) ||
    /\bmercedes[\s-]*(benz\s*)?(c[\s-]*(class|200|220|250|300)|clase\s*c)\b/.test(
      n,
    ) ||
    /\bclase\s*c\b/.test(n) ||
    /\bc[\s-]*class\b/.test(n) ||
    /\bmazda\s*6\b/.test(n)
  ) {
    return 'Mediano Premium';
  }

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

function logInstantResolution(payload: Record<string, unknown>): void {
  console.log('[InstantQuote]', JSON.stringify(payload));
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

  const resolved = resolveInstantCanonicalServicio(t, snap);
  if (!resolved) {
    logInstantResolution({
      matched: false,
      reason: 'no_canonical',
      inputPreview: t.slice(0, 400),
    });
    return null;
  }
  const { canonical, via } = resolved;

  let severidadLiteral: string;
  if (canonical === 'Estética Automotriz') {
    severidadLiteral = 'N/A';
  } else if (isBañoDePinturaServicio(canonical)) {
    severidadLiteral = inferBañoTierSeveridad(t);
  } else {
    severidadLiteral = 'N/A';
  }

  const base = snap.getPriceForCanonical(canonical, severidadLiteral);
  const isInstant = snap.isInstantForCanonical(canonical, severidadLiteral);

  if (base <= 0 || !isInstant) {
    logInstantResolution({
      matched: false,
      reason: base <= 0 ? 'price_zero' : 'not_instant_service_cell',
      inputPreview: t.slice(0, 400),
      resolveVia: via,
      canonicalServicioDb: canonical,
      severidadLiteral,
      precioMx: base,
      isInstantService: isInstant,
    });
    return null;
  }

  logInstantResolution({
    matched: true,
    inputPreview: t.slice(0, 400),
    resolveVia: via,
    canonicalServicioDb: canonical,
    severidadLiteral,
    precioMx: base,
    isInstantService: true,
  });

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
    '¡Hola! Con gusto te comparto la cotización según nuestro catálogo vigente:',
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
    `*Total: ${formatAutoFixMoney(r.total)} ${r.currency}*`,
    '',
    'Si quieres, te ayudo a agendar una visita al taller.',
  );
  return blocks.join('\n');
}
