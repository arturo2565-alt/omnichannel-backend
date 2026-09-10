import { findPanelPiezaOption } from '../catalog/panel-pieza-catalog';
import { isPlaceholderBañoVehicleLabel } from './instant-quote-from-text';

const YEAR_RE = /\b((?:19|20)\d{2})\b/;

const BRAND_RE =
  /\b(audi|bmw|mercedes|benz|nissan|infiniti|toyota|lexus|honda|acura|ford|lincoln|chevrolet|chevy|gmc|cadillac|buick|volkswagen|vw|mazda|hyundai|kia|genesis|suzuki|mitsubishi|subaru|fiat|jeep|ram|dodge|tesla|porsche|mini|seat|skoda|peugeot|renault|citroen|chery|byd|jac|changan|geely|alfa|romeo)\b/i;

export type RefaccionPendiente = {
  pieza: string;
  label: string;
};

export type RefaccionGateState = {
  solicitarAnioModelo: boolean;
  piezasPendientes: RefaccionPendiente[];
  guardadoEn: string;
};

export type VehicleYearModel = {
  marca: string;
  modelo: string;
  anio: string | null;
  label: string;
  confirmed: boolean;
};

export function extractVehicleYear(text: string): string | null {
  const m = String(text ?? '').match(YEAR_RE);
  const y = m?.[1] ?? '';
  const n = Number(y);
  if (!Number.isFinite(n) || n < 1980 || n > 2039) return null;
  return y;
}

function stripYearAndNoise(raw: string): string {
  return String(raw ?? '')
    .replace(YEAR_RE, ' ')
    .replace(
      /\b(es|un|una|el|la|de|del|mi|tu|auto|carro|camioneta|unidad|version|versión|modelo|año|anio)\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractVehicleMarca(text: string): string {
  const m = String(text ?? '').match(BRAND_RE);
  if (!m?.[1]) return '';
  const raw = m[1];
  if (/^vw$/i.test(raw)) return 'Volkswagen';
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

export function extractVehicleModelo(text: string): string {
  const cleaned = stripYearAndNoise(text);
  if (!cleaned || isPlaceholderBañoVehicleLabel(cleaned)) return '';
  const marca = extractVehicleMarca(cleaned);
  let rest = cleaned;
  if (marca) {
    rest = rest
      .replace(new RegExp(`\\b${marca}\\b`, 'ig'), ' ')
      .replace(/\bvw\b/ig, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const modelo = rest.split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  if (!modelo || isPlaceholderBañoVehicleLabel(modelo)) return '';
  if (modelo.length < 2) return '';
  return modelo;
}

export function parseVehicleYearAndModel(
  ...blobs: Array<string | null | undefined>
): VehicleYearModel {
  const joined = blobs
    .map((b) => String(b ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const anio = extractVehicleYear(joined);
  const marca = extractVehicleMarca(joined);
  const modelo = extractVehicleModelo(joined);
  const label = [marca, modelo, anio].filter(Boolean).join(' ').trim();
  return {
    marca,
    modelo,
    anio,
    label,
    confirmed: hasConfirmedYearAndModel(anio, modelo),
  };
}

export function hasConfirmedYearAndModel(
  anio: string | null | undefined,
  modelo: string | null | undefined,
): boolean {
  const y = String(anio ?? '').replace(/\D/g, '').slice(0, 4);
  const m = String(modelo ?? '').trim();
  if (!y || y.length !== 4) return false;
  if (!m || isPlaceholderBañoVehicleLabel(m)) return false;
  return true;
}

export function buildRefaccionYearAskNote(piezaLabel: string): string {
  const label = String(piezaLabel ?? '').trim() || 'la pieza';
  return `🔍 *Nota de Refacción:* Notamos que tu *${label}* presenta rotura y requiere cambio. Para darte el costo exacto de la pieza nueva o reemplazo, ¿podrías confirmarme el *año y versión* de tu unidad?`;
}

export function buildRefaccionManualConfirmNote(piezaLabel: string): string {
  const label = String(piezaLabel ?? '').trim() || 'la pieza';
  return `🔍 *Nota de Refacción:* ${label} requiere reemplazo, pero no encontramos un precio de mercado confiable en este momento. Lo confirmamos en físico con el número de parte — no incluimos un costo estimado inventado.`;
}

export function pendientesFromPieces(
  pieces: ReadonlyArray<{ pieza: string }>,
): RefaccionPendiente[] {
  const seen = new Set<string>();
  const out: RefaccionPendiente[] = [];
  for (const it of pieces) {
    const pieza = String(it.pieza ?? '').trim();
    if (!pieza || seen.has(pieza)) continue;
    seen.add(pieza);
    const label =
      findPanelPiezaOption(pieza)?.fullName || pieza;
    out.push({ pieza, label });
  }
  return out;
}
