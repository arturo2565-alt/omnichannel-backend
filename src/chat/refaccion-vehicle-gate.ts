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
      /\b(es|un|una|el|la|de|del|mi|tu|auto|carro|camioneta|unidad|modelo|año|anio)\b/gi,
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

/** Modelo comercial (Jetta, 2, March). No exige versión/equipamiento. */
export function isValidRefaccionModelo(
  modelo: string | null | undefined,
  marca?: string | null,
): boolean {
  const m = String(modelo ?? '').trim();
  if (!m) return false;
  if (/^\d{1,2}[a-z]?$/i.test(m)) return Boolean(String(marca ?? '').trim());
  if (isPlaceholderBañoVehicleLabel(m)) return false;
  return m.length >= 2;
}

export function extractVehicleModelo(text: string): string {
  const cleaned = stripYearAndNoise(text);
  if (!cleaned || isPlaceholderBañoVehicleLabel(cleaned)) return '';
  const marca = extractVehicleMarca(cleaned);
  let rest = cleaned;
  if (marca) {
    rest = rest
      .replace(new RegExp(`\\b${marca}\\b`, 'ig'), ' ')
      .replace(/\bvw\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const tokens = rest.split(/\s+/).filter(Boolean).slice(0, 3);
  const modelo = tokens.join(' ');
  if (!isValidRefaccionModelo(modelo, marca)) return '';
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
    confirmed: hasConfirmedMarcaModeloAnio(marca, modelo, anio),
  };
}

/** Marca + modelo + año. "Mazda 2 2018" basta; no se pide versión. */
export function hasConfirmedMarcaModeloAnio(
  marca: string | null | undefined,
  modelo: string | null | undefined,
  anio: string | null | undefined,
): boolean {
  const y = String(anio ?? '').replace(/\D/g, '').slice(0, 4);
  if (!y || y.length !== 4) return false;
  if (!isValidRefaccionModelo(modelo, marca)) return false;
  const m = String(modelo ?? '').trim();
  if (/^\d{1,2}[a-z]?$/i.test(m) && !String(marca ?? '').trim()) return false;
  return true;
}

/** @deprecated usar {@link hasConfirmedMarcaModeloAnio}. */
export function hasConfirmedYearAndModel(
  anio: string | null | undefined,
  modelo: string | null | undefined,
  marca?: string | null,
): boolean {
  return hasConfirmedMarcaModeloAnio(marca, modelo, anio);
}

export function buildRefaccionYearAskNote(piezaLabel: string): string {
  return buildConsolidatedRefaccionAskNote([piezaLabel]);
}

export function buildConsolidatedRefaccionAskNote(labels: string[]): string {
  const pieces = labels
    .map((l) => String(l ?? '').trim())
    .filter(Boolean);
  if (!pieces.length) {
    return '🔍 *Nota de Refacción:* Hay una pieza con rotura que requiere cambio. Para cotizarla, ¿me confirmas *marca, modelo y año* de tu unidad? (ej. Mazda 2 2018)';
  }
  if (pieces.length === 1) {
    return `🔍 *Nota de Refacción:* Notamos que tu *${pieces[0]}* presenta rotura y requiere cambio. Para darte el costo de la pieza nueva o reemplazo, ¿me confirmas *marca, modelo y año* de tu unidad? (ej. Mazda 2 2018)`;
  }
  const bullets = pieces.map((p) => `• ${p}`).join('\n');
  return `🔍 *Nota de Refacción:* Notamos rotura y se requiere cambio en:\n${bullets}\nPara cotizar las piezas nuevas, ¿me confirmas *marca, modelo y año* de tu unidad? (ej. Mazda 2 2018)`;
}

export function buildRefaccionManualConfirmNote(piezaLabel: string): string {
  const label = String(piezaLabel ?? '').trim() || 'la pieza';
  return `🔍 *Nota de Refacción:* ${label} requiere reemplazo. Usaremos un estimado comercial por gama y lo confirmamos en la revisión física.`;
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
    const label = findPanelPiezaOption(pieza)?.fullName || pieza;
    out.push({ pieza, label });
  }
  return out;
}
