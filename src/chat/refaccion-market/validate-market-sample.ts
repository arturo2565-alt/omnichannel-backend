import type { VehiclePartIdentity } from './refaccion-market.types';

function norm(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PIEZA_ALIASES: Record<string, string[]> = {
  cofre: ['cofre', 'hood', 'capo', 'bonnet'],
  fascia: ['fascia', 'defensa', 'bumper', 'fascia delantera', 'fascia trasera'],
  puerta: ['puerta', 'door'],
  salpicadera: ['salpicadera', 'guardafango', 'fender'],
  'tapa cajuela': ['tapa cajuela', 'tapa de cajuela', 'cajuela', 'baul', 'porton'],
  toldo: ['toldo', 'techo'],
  estribo: ['estribo', 'side step'],
  espejo: ['espejo', 'mirror'],
  poste: ['poste', 'pilar'],
};

const ACCESSORY_RE =
  /\b(bisagra|cubre\s*cofre|cubre\s*fascia|protector|bra\b|emblema|cerradura|varilla|soporte|tope de cofre|aislante|moldura de|guia de|clips?|tornillos?|empaque|hule|reten)\b/i;

export function piezaTokensForLabel(piezaLabel: string): string[] {
  const n = norm(piezaLabel);
  if (PIEZA_ALIASES[n]) return PIEZA_ALIASES[n]!;
  for (const [key, aliases] of Object.entries(PIEZA_ALIASES)) {
    if (n.includes(key) || aliases.some((a) => n.includes(a))) return aliases;
  }
  return n ? [n] : [];
}

export function listingLooksLikeAccessory(title: string, snippet?: string): boolean {
  return ACCESSORY_RE.test(`${title} ${snippet ?? ''}`);
}

export function listingMentionsPieza(
  title: string,
  snippet: string | undefined,
  piezaLabel: string,
): boolean {
  const blob = norm(`${title} ${snippet ?? ''}`);
  return piezaTokensForLabel(piezaLabel).some((t) => blob.includes(norm(t)));
}

export function listingMentionsVehicle(
  title: string,
  snippet: string | undefined,
  identity: VehiclePartIdentity,
): boolean {
  const blob = norm(`${title} ${snippet ?? ''}`);
  const marca = norm(identity.marca);
  const modelo = norm(identity.modelo);
  if (!marca || !blob.includes(marca)) return false;
  if (!modelo) return true;
  const compactModelo = modelo.replace(/\s+/g, '');
  const compactBlob = blob.replace(/\s+/g, '');
  if (blob.includes(modelo) || compactBlob.includes(`${marca}${compactModelo}`)) {
    return true;
  }
  return compactBlob.includes(compactModelo) && compactModelo.length >= 1;
}

/**
 * Año compatible solo si el listado trae el año exacto o un rango explícito
 * que lo contiene. Un año vecino suelto (2019 vs 2020) NO basta.
 */
export function listingYearCompatible(
  title: string,
  snippet: string | undefined,
  anio: string | null,
): boolean {
  if (!anio || !/^(19|20)\d{2}$/.test(anio)) return false;
  const year = Number(anio);
  const blob = `${title} ${snippet ?? ''}`;
  const ranges = [
    ...blob.matchAll(
      /((?:19|20)\d{2})\s*(?:[-–]|a|al|\/)\s*((?:19|20)\d{2})/gi,
    ),
  ];
  for (const m of ranges) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (year >= lo && year <= hi) return true;
  }
  const short = [
    ...blob.matchAll(/\b((?:19|20)?\d{2})\s*[-–]\s*((?:19|20)?\d{2})\b/g),
  ];
  for (const m of short) {
    const lo = expandYearToken(m[1]!, year);
    const hi = expandYearToken(m[2]!, year);
    if (lo != null && hi != null && year >= Math.min(lo, hi) && year <= Math.max(lo, hi)) {
      return true;
    }
  }
  const exact = new RegExp(`\\b${anio}\\b`);
  return exact.test(blob);
}

function expandYearToken(raw: string, vehicleYear: number): number | null {
  const t = String(raw ?? '').replace(/\D/g, '');
  if (t.length === 4 && /^(19|20)\d{2}$/.test(t)) return Number(t);
  if (t.length === 2) {
    const century = Math.floor(vehicleYear / 100) * 100;
    return century + Number(t);
  }
  return null;
}

export function validateListingAgainstIdentity(
  title: string,
  snippet: string | undefined,
  identity: VehiclePartIdentity,
): { ok: boolean; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; reason?: string } {
  if (listingLooksLikeAccessory(title, snippet)) {
    return { ok: false, confidence: 'LOW', reason: 'accessory' };
  }
  if (!listingMentionsPieza(title, snippet, identity.piezaLabel)) {
    return { ok: false, confidence: 'LOW', reason: 'pieza' };
  }
  if (!listingMentionsVehicle(title, snippet, identity)) {
    return { ok: false, confidence: 'LOW', reason: 'vehicle' };
  }
  if (!listingYearCompatible(title, snippet, identity.anio)) {
    return { ok: false, confidence: 'LOW', reason: 'year' };
  }
  const blob = `${title} ${snippet ?? ''}`;
  const hasRange = /((?:19|20)\d{2})\s*(?:[-–]|a|al|\/)\s*((?:19|20)\d{2})/i.test(
    blob,
  );
  return { ok: true, confidence: hasRange ? 'MEDIUM' : 'HIGH' };
}
