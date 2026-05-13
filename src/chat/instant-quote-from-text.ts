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

export type InstantQuoteFromTextOptions = {
  /**
   * Texto acumulado del hilo (p. ej. varios mensajes user del chat) para:
   * - recordar "baño de pintura" + respuesta posterior "es un March"
   * - clasificar tamaño con marca/modelo mencionados antes
   */
  fullContextForBaño?: string;
};

const BAÑO_CANON_NORM = 'bano de pintura';

/** Respuesta fija cuando hay intención de baño pero falta modelo / tamaño explícito. */
export const BAÑO_PINTURA_VEHICLE_PROMPT_REPLY =
  '¡Claro! Con gusto. Para darte el precio estimado, ¿qué auto o camioneta tienes?';

export function isBañoDePinturaServicio(canonical: string): boolean {
  return normalizeTextForMatch(canonical).includes(BAÑO_CANON_NORM);
}

type CanonicalResolve = { canonical: string; via: 'direct' | 'bano_pintura_synonym' };

export function mentionsBañoDePinturaIntent(text: string): boolean {
  return normalizeTextForMatch(text).includes(BAÑO_CANON_NORM);
}

function resolveBañoCanonicalFromSnap(snap: MatrixPricingSnapshot): string | null {
  for (const svc of snap.serviciosOrderedLongestFirst) {
    const ks = normalizeTextForMatch(svc);
    if (ks.includes(BAÑO_CANON_NORM)) return svc;
  }
  return null;
}

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

  if (!mentionsBañoDePinturaIntent(t)) return null;

  for (const svc of snap.serviciosOrderedLongestFirst) {
    const ks = normalizeTextForMatch(svc);
    if (ks.includes(BAÑO_CANON_NORM)) {
      return { canonical: svc, via: 'bano_pintura_synonym' };
    }
  }
  return null;
}

export function resolveInstantCanonicalLatestThenFull(
  latestUserText: string,
  fullContextText: string,
  snap: MatrixPricingSnapshot,
): CanonicalResolve | null {
  const latest = String(latestUserText ?? '').trim();
  const full = String(fullContextText ?? '').trim();
  return (
    resolveInstantCanonicalServicio(latest, snap) ??
    resolveInstantCanonicalServicio(full, snap)
  );
}

/** Tamaño explícito en el texto → se puede cotizar baño sin nombre de auto. */
export function hasExplicitBañoTierInContext(normalizedBlob: string): boolean {
  return /\b(chico|mediano|grande|xl)(\s+premium)?\b/.test(normalizedBlob);
}

const CAR_BRANDS_RE =
  /\b(audi|bmw|mercedes|benz|nissan|infiniti|toyota|lexus|honda|acura|ford|lincoln|chevrolet|chevy|gmc|cadillac|buick|volkswagen|vw|mazda|hyundai|kia|genesis|suzuki|mitsubishi|subaru|fiat|jeep|ram|dodge|tesla|porsche|mini|seat|skoda|peugeot|renault|citroen|dacia|chery|byd|jac|isuzu|changan|geely|baic|alfa|romeo|iveco|maserati)\b/i;

/** Modelos frecuentes sin marca (evita depender solo de "es un …"). */
const COMMON_MODELS_RE =
  /\b(march|versa|sentra|altima|maxima|micra|note|figo|fiesta|ikon|etios|attitude|gol|voyage|fox|\bup\b|uno|palio|siena|jetta|golf|passat|polo|vento|virtus|tiguan|taos|tcross|t-cross|civic|accord|fit|cr-v|hr-v|pilot|odyssey|corolla|camry|rav4|highlander|4runner|sequoia|sienna|frontier|titan|l200|hilux|ranger|f-150|f-250|f-350|silverado|sierra|traverse|explorer|escape|edge|bronco|patriot|cherokee|wrangler|compass|renegade|tracker|onix|prisma|aveo|spark|beat|mirage|outlander|asx|cx-3|cx-5|cx-9|mazda\s*2|mazda\s*3|mazda\s*6|rio|forte|optima|stinger|elantra|sonata|tucson|santa\s*fe|palisade|venue|kicks|rogue|murano|pathfinder|armada|sorento|telluride|sportage|soul|kwid|duster|sandero|argo|mobilio|city|wr-v)\b/i;

const YEAR_RE = /\b(19[89][0-9]|20[0-3][0-9])\b/;

/** Palabras que no deben interpretarse como nombre de modelo en un mensaje muy corto. */
const LATEST_REPLY_NON_MODEL_WORDS = new Set([
  'hola',
  'buenas',
  'gracias',
  'ok',
  'si',
  'sí',
  'vale',
  'bueno',
  'listo',
  'perfecto',
  'claro',
  'bien',
  'bano',
  'pintura',
  'servicio',
  'cita',
  'precio',
  'cuanto',
  'cotiz',
  'cotizacion',
  'exterior',
  'auto',
  'carro',
  'coche',
  'camioneta',
  'me',
  'interesa',
  'mucho',
  'quiero',
  'necesito',
  'info',
  'porfavor',
  'favor',
  'dias',
  'tardes',
  'noches',
  'tengo',
  'una',
  'un',
  'el',
  'la',
  'los',
  'las',
  'les',
  'del',
  'al',
  'por',
  'manana',
  'chico',
  'mediano',
  'grande',
  'premium',
  'xl',
  'taller',
  'horario',
  'ayer',
  'hoy',
  'ahora',
]);

function isLikelyStandaloneModelToken(w: string): boolean {
  const n = w.toLowerCase();
  if (n.length < 3 || n.length > 22) return false;
  if (LATEST_REPLY_NON_MODEL_WORDS.has(n)) return false;
  if (/^\d+$/.test(n)) return false;
  return /^[a-z][a-z0-9-]*$/i.test(n);
}

/**
 * Mensaje actual solo con modelo o marca+modelo breve (p. ej. "Figo", "Ford Figo")
 * tras haber pedido baño en turnos anteriores (el contexto completo lo valida aparte).
 */
export function userLatestMessageLooksLikeVehicleModelReply(latestUserText: string): boolean {
  const raw = String(latestUserText ?? '').trim();
  if (!raw || raw.length > 120) return false;
  const n = normalizeTextForMatch(raw);
  const words = n.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  const joined = words.join(' ');
  if (CAR_BRANDS_RE.test(joined)) return true;
  if (COMMON_MODELS_RE.test(joined)) return true;

  if (words.length <= 6) {
    const modelTokens = words.filter(isLikelyStandaloneModelToken);
    if (modelTokens.length >= 1) return true;
  }
  return false;
}

function hasVehicleModelHint(normalizedBlob: string): boolean {
  if (hasExplicitBañoTierInContext(normalizedBlob)) return true;
  if (CAR_BRANDS_RE.test(normalizedBlob)) return true;
  if (COMMON_MODELS_RE.test(normalizedBlob)) return true;
  if (YEAR_RE.test(normalizedBlob)) return true;
  if (
    /\b(es\s+un|es\s+una|tengo\s+un|tengo\s+una|es\s+el|es\s+la|seria\s+un|sería\s+un|seria\s+una|sería\s+una|manejo\s+un|manejo\s+una|dueño\s+de\s+un|dueno\s+de\s+un|mi\s+[a-z0-9][a-z0-9\s-]{1,40})\b/i.test(
      normalizedBlob,
    )
  ) {
    return true;
  }
  return false;
}

export function shouldAskVehicleBeforeBañoQuote(
  normalizedFullContext: string,
  latestUserText?: string,
): boolean {
  if (!mentionsBañoDePinturaIntent(normalizedFullContext)) return false;
  if (hasExplicitBañoTierInContext(normalizedFullContext)) return false;
  if (hasVehicleModelHint(normalizedFullContext)) return false;
  const latest = String(latestUserText ?? '').trim();
  if (latest && userLatestMessageLooksLikeVehicleModelReply(latest)) {
    return false;
  }
  return true;
}

/**
 * Si el hilo pide baño de pintura y aún no hay modelo/tamaño suficiente, devuelve la respuesta fija (sin precio).
 * No aplica a cerámico / estética u otros instant.
 */
export function tryBañoPinturaVehicleGateReply(
  latestUserText: string,
  fullContextForBaño: string,
  snap: MatrixPricingSnapshot,
): string | null {
  const latest = String(latestUserText ?? '').trim();
  const full = String(fullContextForBaño ?? '').trim();
  const fullNorm = normalizeTextForMatch(full);
  if (!mentionsBañoDePinturaIntent(fullNorm)) return null;

  const resolved = resolveInstantCanonicalLatestThenFull(latest, full, snap);
  if (!resolved || !isBañoDePinturaServicio(resolved.canonical)) return null;

  if (!shouldAskVehicleBeforeBañoQuote(fullNorm, latest)) return null;

  console.log(
    `[DEBUG] Re-preguntando porque no detecté modelo en: ${latest.slice(0, 400)}`,
  );
  return BAÑO_PINTURA_VEHICLE_PROMPT_REPLY;
}

/** Severidad en BD para filas de Baño de Pintura Exterior (tamaño / variante). Fallback si falla la IA. */
export function inferBañoTierSeveridad(contextText: string): string {
  const n = normalizeTextForMatch(contextText);

  const explicitTierRules: { re: RegExp; sev: string }[] = [
    { re: /\bxl\s*premium\b/, sev: 'XL Premium' },
    { re: /\bgrande\s*premium\b/, sev: 'Grande Premium' },
    { re: /\bmediano\s*premium\b/, sev: 'Mediano Premium' },
    { re: /\bchico\s*premium\b/, sev: 'Chico Premium' },
    { re: /\bxl\b/, sev: 'XL' },
    { re: /\bgrande\b/, sev: 'Grande' },
    { re: /\bmediano\b/, sev: 'Mediano' },
    { re: /\bchico\b/, sev: 'Chico' },
  ];
  for (const { re, sev } of explicitTierRules) {
    if (re.test(n)) return sev;
  }

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

  if (
    /\baud?i\s*q[357]\b/.test(n) ||
    /\bbmw\s*x[13567]\b/.test(n) ||
    /\bmercedes[\s-]*(benz\s*)?gl[bcen]\b/.test(n) ||
    /\bporsche\s*macan\b/.test(n) ||
    /\b(volvo\s*xc\d+|land\s*rover|range\s*rover|defender)\b/.test(n)
  ) {
    return 'Grande Premium';
  }

  if (
    /\bmarch\b|\bversa\b|\bnote\b|\bmicra\b|\bspark\b|\bbeat\b|\bmirage\b|\bfigo\b|\bfiesta\b|\bikon\b|\betios\b|\batitude\b|\bi10\b|\bi20\b|\bagile\b|\bkwid\b|\bmazda\s*2\b|\byaris\b|\bfit\b|\brio\b|\baveo\b/.test(
      n,
    )
  ) {
    return 'Chico';
  }

  if (
    /\b(yukon|suburban|tahoe|expedition|sequoia|land\s*cruiser|patrol|armada|qx80|escalade|navigator|transit|sprinter|f-250|f-350|ram\s*2500|silverado\s*2500)\b/.test(
      n,
    )
  ) {
    return 'XL';
  }

  if (
    /\b(traverse|explorer|pilot|pathfinder|highlander|4runner|durango|grand\s*cherokee|touareg|atlas|tiguan|edge|bronco|sport|telluride|palisade)\b/.test(
      n,
    )
  ) {
    return 'Grande';
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

type CanonicalVia = 'direct' | 'bano_pintura_synonym';

/** Construye la resolución instantánea si la celda existe en catálogo (precio + instant). */
export function materializeInstantQuoteResolution(
  snap: MatrixPricingSnapshot,
  params: {
    canonical: string;
    severidadLiteral: string;
    tierSourceForCambioColor: string;
    resolveVia: CanonicalVia;
    latestPreview: string;
    fullCtxPreview: string;
  },
): InstantQuoteResolution | null {
  const {
    canonical,
    severidadLiteral,
    tierSourceForCambioColor,
    resolveVia,
    latestPreview,
    fullCtxPreview,
  } = params;

  const base = snap.getPriceForCanonical(canonical, severidadLiteral);
  const isInstant = snap.isInstantForCanonical(canonical, severidadLiteral);

  if (base <= 0 || !isInstant) {
    logInstantResolution({
      matched: false,
      reason: base <= 0 ? 'price_zero' : 'not_instant_service_cell',
      inputPreview: latestPreview.slice(0, 400),
      contextPreview: fullCtxPreview.slice(0, 400),
      resolveVia,
      canonicalServicioDb: canonical,
      severidadLiteral,
      precioMx: base,
      isInstantService: isInstant,
    });
    return null;
  }

  logInstantResolution({
    matched: true,
    inputPreview: latestPreview.slice(0, 400),
    contextPreview: fullCtxPreview.slice(0, 400),
    resolveVia,
    canonicalServicioDb: canonical,
    severidadLiteral,
    precioMx: base,
    isInstantService: true,
  });

  const lines: InstantQuoteLine[] = [
    { label: `${canonical} (${severidadLiteral})`, amount: base },
  ];
  const extras: InstantQuoteLine[] = [];
  let add = 0;
  if (isBañoDePinturaServicio(canonical) && mentionsCambioDeColor(tierSourceForCambioColor)) {
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

/**
 * Si el texto encaja con un servicio InstantQuote en catálogo, devuelve líneas y total.
 * No usa borrador ni visión.
 */
export function tryResolveInstantQuoteFromUserText(
  userText: string,
  snap: MatrixPricingSnapshot,
  opts?: InstantQuoteFromTextOptions,
): InstantQuoteResolution | null {
  const latest = String(userText ?? '').trim();
  const fullCtxRaw = String(opts?.fullContextForBaño ?? latest).trim();
  const tierSource = fullCtxRaw || latest;
  const tierNorm = normalizeTextForMatch(tierSource);

  if (!latest && !fullCtxRaw) return null;

  const resolved = resolveInstantCanonicalLatestThenFull(latest, fullCtxRaw, snap);
  if (!resolved) {
    logInstantResolution({
      matched: false,
      reason: 'no_canonical',
      inputPreview: latest.slice(0, 400),
      contextPreview: fullCtxRaw.slice(0, 400),
    });
    return null;
  }
  const { canonical, via } = resolved;

  let severidadLiteral: string;
  if (canonical === 'Estética Automotriz') {
    severidadLiteral = 'N/A';
  } else if (isBañoDePinturaServicio(canonical)) {
    if (shouldAskVehicleBeforeBañoQuote(tierNorm, latest)) {
      logInstantResolution({
        matched: false,
        reason: 'bano_requires_vehicle_model',
        inputPreview: latest.slice(0, 400),
        contextPreview: fullCtxRaw.slice(0, 400),
        canonicalServicioDb: canonical,
      });
      return null;
    }
    severidadLiteral = inferBañoTierSeveridad(tierSource);
  } else {
    severidadLiteral = 'N/A';
  }

  return materializeInstantQuoteResolution(snap, {
    canonical,
    severidadLiteral,
    tierSourceForCambioColor: tierSource,
    resolveVia: via,
    latestPreview: latest,
    fullCtxPreview: fullCtxRaw,
  });
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
