/** Identidad de vehículo para cotizar refacción (año + modelo reales). */

const PLACEHOLDER_MODEL_RE =
  /^(tu\s+)?(veh[ií]culo|unidad|auto|coche|cliente|desconocido|unknown|n\/?a|sin\s+dato)s?$/i;

const YEAR_RE = /\b((?:19|20)\d{2})\b/;

export function extractVehicleYear(raw: unknown): string | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/\bno\s+s[eé]\b.*\ba[nñ]o\b/i.test(text)) return null;
  const m = text.match(YEAR_RE);
  return m?.[1] ?? null;
}

export function hasConfirmedYearAndModel(
  anio: string | null | undefined,
  modelo: string | null | undefined,
): boolean {
  const year = String(anio ?? '').replace(/\D/g, '').slice(0, 4);
  const model = String(modelo ?? '').trim();
  if (!/^(19|20)\d{2}$/.test(year)) return false;
  if (!model || PLACEHOLDER_MODEL_RE.test(model)) return false;
  return true;
}

export function parseVehicleYearAndModel(
  visionOrStored: unknown,
  clientText: unknown,
): { anio: string | null; modelo: string; confirmed: boolean } {
  const vision = String(visionOrStored ?? '').trim();
  const client = String(clientText ?? '').trim();
  const anio = extractVehicleYear(client) ?? extractVehicleYear(vision);
  const modeloFromVision = vision.replace(YEAR_RE, '').replace(/\s+/g, ' ').trim();
  const modelo = modeloFromVision || client.replace(YEAR_RE, '').replace(/\s+/g, ' ').trim();
  return {
    anio,
    modelo,
    confirmed: hasConfirmedYearAndModel(anio, modelo),
  };
}

export function buildRefaccionYearAskNote(piezaLabel: string): string {
  const label = String(piezaLabel ?? '').trim() || 'la pieza';
  return `Para cotizar el reemplazo de ${label} necesito el año y versión de tu unidad (no inventamos el precio de la refacción).`;
}

const REFACCION_NOTE_HEAD_RE =
  /Nota\s+(?:de|sobre)\s+Refacci[oó]n/i;

const COVERS_REFACCION_RE =
  /\b(refacci[oó]n|reemplazo|pieza\s+nueva|rota|roto|rotura|quiebre|quebrada)\b/i;

const COVERS_PHYSICAL_REVIEW_RE =
  /\b(ingresar|en\s+(el\s+)?taller|revisi[oó]n\s+f[ií]sica|confirma(r|mos)?\s+al\s+ingresar|en\s+f[ií]sico|al\s+ingreso)\b/i;

const ASKS_VEHICLE_RE =
  /\b(marca|modelo|a[nñ]o|versi[oó]n)\b/i;

/** El cuerpo ya explicó la pieza rota y/o la revisión en taller. */
export function clientNarrativeAlreadyCoversRefaccion(text: unknown): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return COVERS_REFACCION_RE.test(t) && COVERS_PHYSICAL_REVIEW_RE.test(t);
}

export function shouldAppendRefaccionNote(
  clientMessage: unknown,
  opts: { vehicleConfirmed: boolean },
): boolean {
  if (!opts.vehicleConfirmed) return false;
  if (clientNarrativeAlreadyCoversRefaccion(clientMessage)) return false;
  return true;
}

/** Quita el pie "Nota de Refacción" que pide marca/modelo/año. */
export function stripRedundantRefaccionAskFooter(text: unknown): string {
  const raw = String(text ?? '').trim();
  if (!raw || !REFACCION_NOTE_HEAD_RE.test(raw)) return raw;
  const blocks = raw.split(/\n{2,}/);
  const kept = blocks.filter((block) => {
    const t = block.trim();
    if (!REFACCION_NOTE_HEAD_RE.test(t)) return true;
    return !(ASKS_VEHICLE_RE.test(t) || COVERS_REFACCION_RE.test(t));
  });
  const out = kept.join('\n\n').trim();
  if (!out) return raw;
  return out;
}
