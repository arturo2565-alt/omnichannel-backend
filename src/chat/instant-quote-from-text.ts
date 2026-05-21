import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import {
  AUTO_FIX_CURRENCY,
  formatAutoFixMoney,
  matchServicioFromCatalog,
  normalizeTextForMatch,
} from './autofix-config';

export type InstantQuoteLine = { label: string; amount: number };

export type InstantQuoteResolution = {
  lines: InstantQuoteLine[];
  extras: InstantQuoteLine[];
  subtotal: number;
  total: number;
  /** Precio base de la celda en catálogo (MXN), sin suplementos. */
  precioMx: number;
  /** Días hábiles de entrega según catálogo. */
  diasEntrega: number;
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

/** Raíces de pintura / hojalatería (repintado, pintar, baño, etc.). */
const PAINT_BODY_INTENT_RE =
  /\b(repintad\w*|repintar|pintar\w*|pintura|pintor\w*|bano\s+de\s+pintura|bano\s+pintura|hojalater\w*|lijad\w*|lijar|barniz\w*|esmalte)\b/;

/**
 * Tokens de marketing del catálogo cerámico que NO deben disparar match
 * sin "cerámico" / "tratamiento" explícito en el mensaje del usuario.
 */
const CERAMIC_MARKETING_ONLY_TOKENS = [
  'maxima',
  'maximo',
  'brillo',
  'proteccion',
  'protecciones',
] as const;

const CAR_BRANDS_RE =
  /\b(audi|bmw|mercedes|benz|nissan|infiniti|toyota|lexus|honda|acura|ford|lincoln|chevrolet|chevy|gmc|cadillac|buick|volkswagen|vw|mazda|hyundai|kia|genesis|suzuki|mitsubishi|subaru|fiat|jeep|ram|dodge|tesla|porsche|mini|seat|skoda|peugeot|renault|citroen|dacia|chery|byd|jac|isuzu|changan|geely|baic|alfa|romeo|iveco|maserati)\b/i;

/** Modelos frecuentes sin marca (evita depender solo de "es un …"). */
const COMMON_MODELS_RE =
  /\b(march|versa|sentra|altima|maxima|micra|note|figo|fiesta|ikon|etios|attitude|gol|voyage|fox|\bup\b|uno|palio|siena|jetta|golf|passat|polo|vento|virtus|tiguan|taos|tcross|t-cross|civic|accord|fit|cr-v|hr-v|pilot|odyssey|corolla|camry|rav4|highlander|4runner|sequoia|sienna|frontier|titan|l200|hilux|ranger|f-150|f-250|f-350|silverado|sierra|traverse|explorer|escape|edge|bronco|patriot|cherokee|wrangler|compass|renegade|tracker|onix|prisma|aveo|spark|beat|mirage|outlander|asx|cx-3|cx-5|cx-9|mazda\s*2|mazda\s*3|mazda\s*6|rio|forte|optima|stinger|elantra|sonata|tucson|santa\s*fe|palisade|venue|kicks|rogue|murano|pathfinder|armada|sorento|telluride|sportage|soul|kwid|duster|sandero|argo|mobilio|city|wr-v)\b/i;

const YEAR_RE = /\b(19[89][0-9]|20[0-3][0-9])\b/;

export function mentionsPaintBodyIntent(text: string): boolean {
  const n = normalizeTextForMatch(text);
  return PAINT_BODY_INTENT_RE.test(n) || mentionsBañoDePinturaIntent(n);
}

export function threadHasBañoOrPaintIntent(text: string): boolean {
  return mentionsBañoDePinturaIntent(text) || mentionsPaintBodyIntent(text);
}

function isCeramicoCanonical(canonical: string): boolean {
  return normalizeTextForMatch(canonical).includes('ceramico');
}

function isEsteticaAutomotrizCanonical(canonical: string): boolean {
  const k = normalizeTextForMatch(canonical);
  return k.includes('estetica') && k.includes('automotriz');
}

/** Cerámico / estética solo si el usuario lo pide explícitamente (no por "máxima" sola). */
export function userExplicitlyRequestsCeramicOrEstetica(text: string): boolean {
  const n = normalizeTextForMatch(text);
  if (/\b(ceramico|ceramica|nanoceramic|cera\s+ceramic)\b/.test(n)) return true;
  if (/\b(estetica\s+automotriz|estetica\s+exterior)\b/.test(n)) return true;
  if (/\bestetica\b/.test(n) && !mentionsPaintBodyIntent(n)) return true;
  if (/\btratamiento\b/.test(n) && /\b(ceramic\w*|ceramico)\b/.test(n)) {
    return true;
  }
  const hasMarketing = CERAMIC_MARKETING_ONLY_TOKENS.some((tok) =>
    normalizedHaystackHasWholeToken(n, tok),
  );
  if (hasMarketing) {
    return (
      /\b(ceramico|ceramica|tratamiento)\b/.test(n) &&
      (/\btratamiento\b/.test(n) || /\bceramic/.test(n))
    );
  }
  return false;
}

function normalizedHaystackHasWholeToken(haystackNorm: string, token: string): boolean {
  const t = String(token ?? '').trim();
  if (!t) return false;
  const re = new RegExp(`(?:^|[^a-z0-9]+)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]+|$)`, 'i');
  return re.test(haystackNorm);
}

/**
 * "máxima" como Nissan Maxima (carro + modelo), no como "máxima protección" cerámica.
 */
export function maximaUsedAsVehicleModel(text: string): boolean {
  const n = normalizeTextForMatch(text);
  if (!normalizedHaystackHasWholeToken(n, 'maxima')) return false;
  if (/\bcarro\s+maxima\b/.test(n)) return true;
  if (/\b(auto|coche|camioneta|vehiculo)\s+\w*\s*maxima\b/.test(n)) return true;
  if (/\b(un|una|el|la|mi|tengo|es|seria)\s+\w*\s*maxima\b/.test(n)) return true;
  if (YEAR_RE.test(n) && /\bmaxima\b/.test(n)) return true;
  if (/\bnissan\b/.test(n) && /\bmaxima\b/.test(n)) return true;
  if (COMMON_MODELS_RE.test(n)) return true;
  return false;
}

function canonicalReliesOnMarketingTokenOnly(
  userNorm: string,
  canonical: string,
): boolean {
  const canon = normalizeTextForMatch(canonical);
  if (!isCeramicoCanonical(canonical) && !isEsteticaAutomotrizCanonical(canonical)) {
    return false;
  }
  if (userExplicitlyRequestsCeramicOrEstetica(userNorm)) return false;
  return CERAMIC_MARKETING_ONLY_TOKENS.some(
    (tok) =>
      canon.includes(tok) &&
      normalizedHaystackHasWholeToken(userNorm, tok),
  );
}

function servicioMatchBlockedForInstant(userNorm: string, canonical: string): boolean {
  if (maximaUsedAsVehicleModel(userNorm)) {
    const canon = normalizeTextForMatch(canonical);
    if (
      isCeramicoCanonical(canonical) ||
      canon.includes('maxima') ||
      canon.includes('maximo')
    ) {
      return true;
    }
  }
  if (mentionsPaintBodyIntent(userNorm)) {
    if (isCeramicoCanonical(canonical) || isEsteticaAutomotrizCanonical(canonical)) {
      return true;
    }
  }
  if (canonicalReliesOnMarketingTokenOnly(userNorm, canonical)) {
    return true;
  }
  if (
    (isCeramicoCanonical(canonical) || isEsteticaAutomotrizCanonical(canonical)) &&
    !userExplicitlyRequestsCeramicOrEstetica(userNorm)
  ) {
    return true;
  }
  return false;
}

function listServiciosForInstantUserMatch(
  snap: MatrixPricingSnapshot,
  userNorm: string,
): readonly string[] {
  const all = snap.serviciosOrderedLongestFirst;
  if (mentionsPaintBodyIntent(userNorm) && !userExplicitlyRequestsCeramicOrEstetica(userNorm)) {
    return all.filter(
      (s) => !isCeramicoCanonical(s) && !isEsteticaAutomotrizCanonical(s),
    );
  }
  return all;
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

  const userNorm = normalizeTextForMatch(t);

  if (
    threadHasBañoOrPaintIntent(t) &&
    !userExplicitlyRequestsCeramicOrEstetica(t)
  ) {
    const banoEarly = resolveBañoCanonicalFromSnap(snap);
    if (banoEarly) {
      return { canonical: banoEarly, via: 'bano_pintura_synonym' };
    }
  }

  const candidates = listServiciosForInstantUserMatch(snap, userNorm);
  const direct = matchServicioFromCatalog(t, candidates);
  if (direct && !servicioMatchBlockedForInstant(userNorm, direct)) {
    return { canonical: direct, via: 'direct' };
  }

  if (threadHasBañoOrPaintIntent(t)) {
    const bano = resolveBañoCanonicalFromSnap(snap);
    if (bano) return { canonical: bano, via: 'bano_pintura_synonym' };
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
  'informacion',
  'información',
  'dato',
  'datos',
  'acerca',
  'sobre',
  'duda',
  'pregunta',
  'ayuda',
  'tema',
  'busco',
  'solicito',
  'solicitud',
]);

/** Palabras del hilo que no perfilan vehículo (evita "información" → modelo). */
const BAÑO_NON_VEHICLE_TOKENS = new Set([
  ...LATEST_REPLY_NON_MODEL_WORDS,
  'informacion',
  'exterior',
  'tratamiento',
  'ceramico',
  'estetica',
]);

function isLikelyStandaloneModelToken(w: string): boolean {
  const n = w.toLowerCase();
  if (BAÑO_NON_VEHICLE_TOKENS.has(n)) return false;
  if (/^\d+$/.test(n)) return false;
  if (/^[a-z]{1,3}\d{1,2}$/i.test(n)) return true;
  if (n.length < 3 || n.length > 22) return false;
  return /^[a-z][a-z0-9-]*$/i.test(n);
}

/** Quita muletillas del turno actual para dejar marca/modelo (p. ej. "Sería para un Figo" → "Figo"). */
export function purifyVehicleModelUserReply(latestUserText: string): string {
  let s = String(latestUserText ?? '').trim();
  if (!s) return '';
  const stripLeading = [
    /^(?:ser[ií]a|es|son|tengo|manejo)\s+(?:para\s+)?(?:un|una|el|la)\s+/i,
    /^(?:due[nñ]o\s+de\s+)?(?:un|una|el|la)\s+/i,
    /^(?:para\s+)?(?:un|una|el|la)\s+/i,
    /^(?:es|son)\s+(?:un|una)\s+/i,
    /^(?:mi|el|la)\s+/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of stripLeading) {
      const next = s.replace(re, '').trim();
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
  }
  const out = s.trim();
  return out.length > 0 ? out : String(latestUserText ?? '').trim();
}

/**
 * Mensaje actual solo con modelo o marca+modelo breve (p. ej. "Figo", "Ford Figo")
 * tras haber pedido baño en turnos anteriores (el contexto completo lo valida aparte).
 */
export function userLatestMessageLooksLikeVehicleModelReply(latestUserText: string): boolean {
  const raw = String(latestUserText ?? '').trim();
  if (!raw || raw.length > 120) return false;
  const purified = purifyVehicleModelUserReply(raw);
  const n = normalizeTextForMatch(purified);
  const words = n.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  const joined = words.join(' ');
  if (CAR_BRANDS_RE.test(joined)) return true;
  if (COMMON_MODELS_RE.test(joined)) return true;

  const modelTokens = words.filter(isLikelyStandaloneModelToken);
  if (modelTokens.length === 0) return false;
  if (words.length <= 4 && modelTokens.length === words.length) return true;
  if (words.length <= 3 && modelTokens.length >= 1) return true;
  return false;
}

/** Etiquetas de LLM/plantilla que NO cuentan como vehículo perfilado. */
export function isPlaceholderBañoVehicleLabel(label: string): boolean {
  const n = normalizeTextForMatch(String(label ?? '').trim());
  if (!n || n.length < 2) return true;
  if (/\bdesconocid/.test(n)) return true;
  if (
    /^(tu\s+vehiculo|vehiculo|auto|carro|camioneta|cliente|generico|sin\s+marca|no\s+identificado|no\s+especificado|sin\s+identificar|sin\s+datos|n\s*a|na|unknown)$/.test(
      n,
    )
  ) {
    return true;
  }
  return false;
}

function contextHasIdentifiedVehicle(normalizedBlob: string): boolean {
  if (CAR_BRANDS_RE.test(normalizedBlob)) return true;
  if (COMMON_MODELS_RE.test(normalizedBlob)) return true;
  if (YEAR_RE.test(normalizedBlob)) return true;

  const ownerPatterns = [
    /\b(es\s+un|es\s+una|tengo\s+un|tengo\s+una|seria\s+un|seria\s+una|manejo\s+un|manejo\s+una|dueño\s+de\s+un|dueno\s+de\s+un)\s+([a-z0-9][a-z0-9\s-]{1,36})/i,
    /\bmi\s+([a-z][a-z0-9\s-]{2,36})\b/i,
  ];
  for (const re of ownerPatterns) {
    const m = normalizedBlob.match(re);
    if (!m) continue;
    const tail = normalizeTextForMatch(m[2] ?? m[1] ?? '');
    if (!tail) continue;
    const head = tail.split(/\s+/)[0] ?? '';
    if (BAÑO_NON_VEHICLE_TOKENS.has(head)) continue;
    if (CAR_BRANDS_RE.test(tail) || COMMON_MODELS_RE.test(tail)) return true;
    if (isLikelyStandaloneModelToken(head) && !mentionsPaintBodyIntent(tail)) return true;
  }
  return false;
}

/**
 * Vehículo perfilado: marca/modelo/año, tamaño explícito, o respuesta breve válida al gate.
 * Sin esto no se debe cotizar ni llamar al clasificador de severidad.
 */
export function isBañoVehicleProfiledForQuote(
  normalizedContext: string,
  latestUserText?: string,
): boolean {
  const ctx = normalizeTextForMatch(normalizedContext);
  if (hasExplicitBañoTierInContext(ctx)) return true;
  if (contextHasIdentifiedVehicle(ctx)) return true;
  const latest = String(latestUserText ?? '').trim();
  if (latest && userLatestMessageLooksLikeVehicleModelReply(latest)) return true;
  return false;
}

/** El asistente ya envió la pregunta fija de vehículo para baño de pintura. */
export function assistantMessageIsBañoVehiclePrompt(text: string): boolean {
  const n = normalizeTextForMatch(String(text ?? '').trim());
  if (!n) return false;
  if (n.includes(normalizeTextForMatch(BAÑO_PINTURA_VEHICLE_PROMPT_REPLY))) return true;
  return (
    /\bque\s+auto\b/.test(n) &&
    (/\bcamioneta\b/.test(n) || /\bcoche\b/.test(n) || /\bvehiculo\b/.test(n))
  );
}

export function shouldAskVehicleBeforeBañoQuote(
  normalizedFullContext: string,
  latestUserText?: string,
): boolean {
  if (!threadHasBañoOrPaintIntent(normalizedFullContext)) return false;
  if (isBañoVehicleProfiledForQuote(normalizedFullContext, latestUserText)) {
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
  const latestRaw = String(latestUserText ?? '').trim();
  const latest = purifyVehicleModelUserReply(latestRaw) || latestRaw;
  const full = String(fullContextForBaño ?? '').trim();
  const fullNorm = normalizeTextForMatch(full);
  if (!threadHasBañoOrPaintIntent(fullNorm)) return null;

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
    /\bmarch\b|\bversa\b|\bnote\b|\bmicra\b|\bspark\b|\bbeat\b|\bmirage\b|\bfigo\b|\bfiesta\b|\bikon\b|\betios\b|\batitude\b|\bmaxima\b|\bi10\b|\bi20\b|\bagile\b|\bkwid\b|\bmazda\s*2\b|\byaris\b|\bfit\b|\brio\b|\baveo\b/.test(
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
  const diasEntrega = snap.getDiasEntregaForCanonical(canonical, severidadLiteral);
  return {
    lines,
    extras,
    subtotal,
    total,
    precioMx: base,
    diasEntrega: diasEntrega > 0 ? diasEntrega : 3,
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
