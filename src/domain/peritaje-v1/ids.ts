import { createHash, randomUUID } from 'node:crypto';
import type {
  DamageEvidence,
  PhysicalPieceIdentity,
  QuoteServiceType,
} from './types';

export const UNKNOWN_VEHICLE_ID = 'veh_unknown';

function slug(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function fingerprint(parts: readonly string[]): string {
  const payload = parts.map((p) => slug(p)).join('|');
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/** VehicleId determinista a partir de identidad conocida. */
export function createVehicleId(input: {
  make?: string;
  model?: string;
  year?: string;
  version?: string;
  displayLabel?: string;
}): string {
  const make = slug(input.make ?? '');
  const model = slug(input.model ?? '');
  const year = slug(input.year ?? '');
  const version = slug(input.version ?? '');
  const label = slug(input.displayLabel ?? '');
  if (!make && !model && !year && !version && !label) {
    return UNKNOWN_VEHICLE_ID;
  }
  return `veh_${fingerprint([make, model, year, version, label])}`;
}

/** Identidad estable de una foto: solo la URL. messageId no entra al hash. */
export function createEvidenceId(input: {
  imageUrls?: readonly string[];
  url?: string;
  sourceMessageId?: string;
}): string {
  const single = String(input.url ?? '').trim();
  const urls = (input.imageUrls ?? [])
    .map((u) => String(u ?? '').trim())
    .filter(Boolean)
    .sort();
  const key = single || urls[0] || '';
  if (!key) {
    return `ev_${fingerprint(['empty'])}`;
  }
  return `ev_${fingerprint([key])}`;
}

export function createImageEvidence(
  url: string,
  opts?: { messageId?: string; source?: 'customer' | 'operator' | 'system' },
): DamageEvidence {
  const clean = String(url ?? '').trim();
  return {
    evidenceId: createEvidenceId({ url: clean }),
    type: 'IMAGE',
    url: clean,
    source: opts?.source ?? 'customer',
    ...(opts?.messageId ? { messageId: opts.messageId } : {}),
  };
}

/**
 * Identidad física: vehicleId + physicalPanelKey.
 * Nuevas fotos/descripciones/severidad/treatment del mismo panel
 * NO cambian el ID.
 *
 * `damageHint` queda aceptado por compatibilidad pero NO entra al hash.
 * No usarlo para desambiguar paneles identificables. Si un día un mismo
 * panel tuviera dos daños físicos que no deban colapsar, el fallback
 * correcto es un physicalPanelKey distinto (no description/hint).
 */
export function createDamageItemId(input: {
  vehicleId: string;
  physicalPanelKey: string;
  /** Ignorado. Reservado solo como firma legacy; no altera el ID. */
  damageHint?: string;
}): string {
  void input.damageHint;
  return `dmg_${fingerprint([input.vehicleId, input.physicalPanelKey])}`;
}

/**
 * Fórmula: ql_sha1(damageItemId | serviceType | discriminator).
 * El índice de array no entra. discriminator solo si un daño emite
 * dos líneas del mismo serviceType (hoy vacío).
 */
export function createQuoteLineId(input: {
  damageItemId: string;
  serviceType: QuoteServiceType;
  discriminator?: string;
}): string {
  return `ql_${fingerprint([
    input.damageItemId,
    input.serviceType,
    input.discriminator ?? '',
  ])}`;
}

export function createPeritajeId(): string {
  return `per_${randomUUID()}`;
}

export function createQuoteId(): string {
  return `quo_${randomUUID()}`;
}

/** Identidad comercial: vehicleId + serviceKey + discriminator. Prefijo cmi_. */
export function createCommercialItemId(input: {
  vehicleId: string;
  serviceKey: string;
  discriminator?: string;
}): string {
  return `cmi_${fingerprint([
    input.vehicleId,
    input.serviceKey,
    input.discriminator ?? '',
  ])}`;
}

/** Catálogo comercial (sin peritaje visual). Determinista por conversación. */
export function createCommercialCatalogId(conversationId?: string): string {
  const key = String(conversationId ?? '').trim() || randomUUID();
  return `com_${fingerprint([key])}`;
}

export function isCommercialItemId(id: string | undefined | null): boolean {
  return String(id ?? '').startsWith('cmi_');
}

/**
 * Clave de merge físico. Invariante: vehicleId + physicalPanelKey,
 * nunca solo el panel.
 */
export function physicalMergeKey(identity: PhysicalPieceIdentity): string {
  const vehicleId = String(identity.vehicleId ?? '').trim() || UNKNOWN_VEHICLE_ID;
  const panel = String(identity.physicalPanelKey ?? '').trim();
  return `${vehicleId}::${panel}`;
}

/**
 * Normalización mínima de panel (sin catálogo).
 * La canonicalización FD/Fascia vive en el catálogo legacy y se inyectará
 * al cablear el pipeline.
 */
export function normalizePhysicalPanelKey(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^refacci[oó]n\s*:\s*/i, '')
    .trim();
}
