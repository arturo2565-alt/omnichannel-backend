import { resolvePiezaDisplayLabel } from '../draft-quote-resume';
import {
  extractVehicleYear,
  hasConfirmedYearAndModel,
} from '../refaccion-vehicle-gate';
import type { VehiclePartIdentity } from './refaccion-market.types';

function piezaLabel(raw: string): string {
  const label = resolvePiezaDisplayLabel(String(raw ?? '').trim());
  return label && label !== 'Servicio' ? label : String(raw ?? '').trim() || 'pieza';
}

const BRANDS = [
  'mercedes-benz',
  'mercedes',
  'volkswagen',
  'chevrolet',
  'mitsubishi',
  'land rover',
  'mazda',
  'nissan',
  'toyota',
  'honda',
  'ford',
  'kia',
  'hyundai',
  'bmw',
  'audi',
  'seat',
  'renault',
  'peugeot',
  'dodge',
  'jeep',
  'ram',
  'gmc',
  'subaru',
  'suzuki',
  'volvo',
  'lexus',
  'infiniti',
  'acura',
  'mini',
  'porsche',
  'tesla',
  'vw',
];

function normalize(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitBrandModel(text: string): { marca: string; modelo: string } {
  const n = normalize(text);
  if (!n) return { marca: '', modelo: '' };
  const compact = n.replace(/\s+/g, '');
  for (const brand of BRANDS) {
    const b = brand.replace(/\s+/g, '');
    if (compact.toLowerCase().startsWith(b) && compact.length > b.length) {
      const rest = n.slice(brand.length).trim() || compact.slice(b.length);
      const marca = brand === 'vw' ? 'Volkswagen' : capitalizeWords(brand);
      return { marca, modelo: rest.replace(/^[\s-]+/, '').trim() };
    }
  }
  const lower = n.toLowerCase();
  for (const brand of BRANDS) {
    if (lower === brand || lower.startsWith(`${brand} `)) {
      const rest = n.slice(brand.length).trim();
      const marca = brand === 'vw' ? 'Volkswagen' : capitalizeWords(brand);
      return { marca, modelo: rest };
    }
  }
  const parts = n.split(' ');
  return {
    marca: parts[0] ?? '',
    modelo: parts.slice(1).join(' '),
  };
}

function capitalizeWords(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function parseVehiclePartIdentity(input: {
  vehiculoText?: string | null;
  anio?: string | null;
  version?: string | null;
  pieza: string;
}): VehiclePartIdentity {
  const raw = String(input.vehiculoText ?? '').trim();
  const anioFromField = String(input.anio ?? '').replace(/\D/g, '').slice(0, 4);
  const anio =
    (/^(19|20)\d{2}$/.test(anioFromField) ? anioFromField : null) ??
    extractVehicleYear(raw);
  const withoutYear = raw.replace(/\b((?:19|20)\d{2})\b/g, ' ').replace(/\s+/g, ' ').trim();
  const { marca, modelo } = splitBrandModel(withoutYear);
  const modeloOrLabel = modelo || withoutYear;
  const confirmed = hasConfirmedYearAndModel(anio, modeloOrLabel || marca);
  return {
    marca,
    modelo: modeloOrLabel,
    anio,
    version: String(input.version ?? '').trim() || null,
    pieza: String(input.pieza ?? '').trim(),
    piezaLabel: piezaLabel(input.pieza),
    confirmed,
  };
}

export function marketCacheKey(identity: VehiclePartIdentity): string {
  return [
    identity.marca,
    identity.modelo,
    identity.anio ?? '',
    identity.piezaLabel,
    identity.version ?? '',
  ]
    .map((s) => String(s).toLowerCase().replace(/\s+/g, ''))
    .join('|');
}
