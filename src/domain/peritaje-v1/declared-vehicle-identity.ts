/**
 * Identidad que el cliente escribió. La visión no confirma estos campos.
 */
import type { VehicleIdentity } from './types';
import {
  enrichVehicleIdentity,
  type VehicleIdentityPatch,
} from './vehicle-identity-enrich';

export const DECLARED_VEHICLE_FIELDS = ['make', 'model', 'year'] as const;
export type DeclaredVehicleField = (typeof DECLARED_VEHICLE_FIELDS)[number];

export type DeclaredVehicleIdentity = {
  make?: string;
  model?: string;
  year?: string;
  declaredFields: DeclaredVehicleField[];
  correctsYear: boolean;
};

const BRANDS = new Set([
  'kia',
  'nissan',
  'toyota',
  'volkswagen',
  'vw',
  'honda',
  'mazda',
  'chevrolet',
  'ford',
  'bmw',
  'audi',
  'mercedes',
  'hyundai',
  'seat',
  'renault',
  'peugeot',
  'jeep',
  'dodge',
  'ram',
  'suzuki',
  'mitsubishi',
  'subaru',
  'fiat',
  'tesla',
  'byd',
  'changan',
  'jac',
  'geely',
]);

const STOP = new Set([
  'a',
  'al',
  'arreglar',
  'arreglo',
  'auto',
  'banio',
  'buenas',
  'buenos',
  'cambiar',
  'coche',
  'completo',
  'con',
  'confirmo',
  'cotizar',
  'cotizacion',
  'de',
  'del',
  'dia',
  'dias',
  'el',
  'en',
  'es',
  'enviar',
  'envie',
  'favor',
  'foto',
  'fotos',
  'gracias',
  'hola',
  'la',
  'las',
  'le',
  'lo',
  'los',
  'mando',
  'mi',
  'mis',
  'necesito',
  'no',
  'noches',
  'o',
  'para',
  'pintar',
  'pintura',
  'por',
  'porfa',
  'que',
  'quiero',
  'se',
  'si',
  'sino',
  'son',
  'su',
  'tardes',
  'tu',
  'un',
  'una',
  'uno',
  'vehiculo',
  'y',
]);

const PARTS = new Set([
  'cajuela',
  'calavera',
  'cofre',
  'costado',
  'defensa',
  'delantera',
  'derecho',
  'derecha',
  'facsia',
  'faro',
  'fascia',
  'golpe',
  'izquierdo',
  'izquierda',
  'lateral',
  'moldura',
  'parachoques',
  'puerta',
  'salpicadera',
  'trasera',
]);

function extractYear(raw: string): string | undefined {
  if (/\bno\s+se\b.*\bano\b/i.test(normalize(raw))) return undefined;
  return normalize(raw).match(/\b((?:19|20)\d{2})\b/)?.[1];
}

const YEAR_CORRECTION =
  /no\s+es\s+(?:el\s+)?(?:19|20)\d{2}\b[\s,;:.]*\b(?:es|sino)\s+(?:el\s+)?((?:19|20)\d{2})\b/i;

function normalize(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function labelToken(token: string): string {
  if (token === 'vw') return 'Volkswagen';
  if (/\d/.test(token) && token.length <= 4) return token.toUpperCase();
  if (token.length <= 3 && !/[aeiou]/.test(token)) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

export function extractDeclaredVehicleIdentity(
  raw: unknown,
): DeclaredVehicleIdentity | null {
  const text = String(raw ?? '').trim();
  if (!text || text.startsWith('data:')) return null;
  const correction = normalize(text).match(YEAR_CORRECTION);
  if (correction?.[1]) {
    return {
      year: correction[1],
      declaredFields: ['year'],
      correctsYear: true,
    };
  }
  const year = extractYear(text);
  const tokens = normalize(text)
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const brands: string[] = [];
  const models: string[] = [];
  for (const token of tokens) {
    if (STOP.has(token) || PARTS.has(token)) continue;
    if (BRANDS.has(token)) brands.push(token);
    else if (token.length >= 2) models.push(token);
  }
  const modelTokens = models.length <= 4 ? models : [];
  const hasCue = Boolean(year || brands.length || /\b(?:es\s+un[ao]?|mi)\b/i.test(normalize(text)));
  if (!hasCue || (!year && !brands.length && !modelTokens.length)) return null;
  if (!year && !brands.length) return null;
  const make = brands[0] ? labelToken(brands[0]) : undefined;
  const model = modelTokens.length ? modelTokens.map(labelToken).join(' ') : undefined;
  const declaredFields: DeclaredVehicleField[] = [];
  if (make) declaredFields.push('make');
  if (model) declaredFields.push('model');
  if (year) declaredFields.push('year');
  if (!declaredFields.length) return null;
  return {
    ...(make ? { make } : {}),
    ...(model ? { model } : {}),
    ...(year ? { year } : {}),
    declaredFields,
    correctsYear: false,
  };
}

export function extractLatestDeclaredVehicleIdentity(
  texts: readonly string[],
): DeclaredVehicleIdentity | null {
  let found: DeclaredVehicleIdentity | null = null;
  for (const text of texts) {
    const next = extractDeclaredVehicleIdentity(text);
    if (next) found = next;
  }
  return found;
}

export function applyDeclaredVehicleIdentity(
  vehicle: VehicleIdentity,
  declared: DeclaredVehicleIdentity,
): VehicleIdentity {
  const allDeclared = DECLARED_VEHICLE_FIELDS.every((field) =>
    declared.declaredFields.includes(field),
  );
  const patch: VehicleIdentityPatch = {
    confirmedFields: declared.declaredFields,
    ...(declared.make ? { make: declared.make } : {}),
    ...(declared.model ? { model: declared.model } : {}),
    ...(declared.year ? { year: declared.year } : {}),
    ...(allDeclared ? { source: 'user' as const } : {}),
  };
  return enrichVehicleIdentity(vehicle, patch).vehicle;
}
