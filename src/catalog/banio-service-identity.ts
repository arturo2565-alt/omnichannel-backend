import type { MatrixPricingSnapshot } from './matrix-pricing-snapshot';
import { createMatrixPricingSnapshot } from './matrix-pricing-snapshot';
import { resolveIntegralBaseFromSnap } from './vehicle-integral-pricing';
import {
  PANEL_PIEZA_BPE_CODE,
  PANEL_PIEZA_BPEI_CODE,
  PANEL_PIEZA_BPCC_CODE,
  PANEL_PIEZA_BPC_CODE,
} from './panel-pieza-catalog';

export const BANIO_CODES = ['BPE', 'BPEI', 'BPCC'] as const;
export type BanioProductCode = (typeof BANIO_CODES)[number];

export type BanioServiceIdentity = {
  code: BanioProductCode;
  catalogName: string;
  fullName: string;
  officialBaseMx: number;
  commercialDefinition: string;
};

/** Bases oficiales del esquema de Servicios Integrales (× tamaño × premium). */
export const BANIO_OFFICIAL_BASE_MXN: Record<BanioProductCode, number> = {
  BPE: 28000,
  BPEI: 32000,
  BPCC: 39000,
};

export const BANIO_COMMERCIAL_DEFINITIONS: Record<BanioProductCode, string> = {
  BPE: 'Baño de pintura exterior. No incluye cambio de color ni interiores de marcos.',
  BPEI:
    'Baño de pintura exterior + interiores/marcos correspondientes. Mantiene el mismo color del vehículo.',
  BPCC:
    'Cambio de color. Incluye exterior + interiores/marcos necesarios para que el cambio de color sea coherente y el desmontaje adicional propio del proceso.',
};

export const BANIO_SERVICE_IDENTITIES: readonly BanioServiceIdentity[] = [
  {
    code: 'BPE',
    catalogName: 'Baño de Pintura Exterior',
    fullName: 'Baño de Pintura Exterior',
    officialBaseMx: BANIO_OFFICIAL_BASE_MXN.BPE,
    commercialDefinition: BANIO_COMMERCIAL_DEFINITIONS.BPE,
  },
  {
    code: 'BPEI',
    catalogName: 'Baño de Pintura Exterior e Interiores',
    fullName: 'Baño de Pintura Exterior e Interiores',
    officialBaseMx: BANIO_OFFICIAL_BASE_MXN.BPEI,
    commercialDefinition: BANIO_COMMERCIAL_DEFINITIONS.BPEI,
  },
  {
    code: 'BPCC',
    catalogName: 'Baño de Pintura con Cambio de Color',
    fullName: 'Baño de Pintura con Cambio de Color',
    officialBaseMx: BANIO_OFFICIAL_BASE_MXN.BPCC,
    commercialDefinition: BANIO_COMMERCIAL_DEFINITIONS.BPCC,
  },
] as const;

export type BanioConfigStatus = 'READY' | 'UNCONFIGURED';

export type BanioServiceReadiness = {
  code: BanioProductCode;
  catalogName: string;
  status: BanioConfigStatus;
  basePrice: number;
};

function normalizeBanioKey(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function isBanioProductCode(raw: string): raw is BanioProductCode {
  const c = normalizeBanioKey(raw);
  return c === 'BPE' || c === 'BPEI' || c === 'BPCC';
}

/** BPC legacy → BPE. No colapsa BPEI/BPCC a BPE. */
export function normalizeBanioProductCode(raw: string): BanioProductCode | null {
  const c = normalizeBanioKey(raw);
  if (c === 'BPC' || c === PANEL_PIEZA_BPC_CODE) return 'BPE';
  if (c === 'BPE' || c === PANEL_PIEZA_BPE_CODE) return 'BPE';
  if (c === 'BPEI' || c === PANEL_PIEZA_BPEI_CODE) return 'BPEI';
  if (c === 'BPCC' || c === PANEL_PIEZA_BPCC_CODE) return 'BPCC';
  return null;
}

export function banioIdentityForCode(
  code: BanioProductCode,
): BanioServiceIdentity {
  return BANIO_SERVICE_IDENTITIES.find((i) => i.code === code)!;
}

export function banioCatalogNameForCode(code: BanioProductCode): string {
  return banioIdentityForCode(code).catalogName;
}

export function resolveBanioCodeFromServicioText(raw: string): BanioProductCode {
  const n = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (/\bbpcc\b/.test(n) || /\bcambio( de)? color\b/.test(n)) return 'BPCC';
  if (
    /\bbpei\b/.test(n) ||
    /\binteriores?\b/.test(n) ||
    /exterior e interiores/.test(n)
  ) {
    return 'BPEI';
  }
  if (/\bbpe\b/.test(n) || /\bbpc\b/.test(n)) return 'BPE';
  return 'BPE';
}

export function isBanioServiceConfigured(
  snap: MatrixPricingSnapshot,
  code: BanioProductCode,
): boolean {
  const name = banioCatalogNameForCode(code);
  const base = resolveIntegralBaseFromSnap(snap, name);
  return Boolean(base && base.basePrice > 0);
}

export function assessBanioServiceReadiness(
  snap: MatrixPricingSnapshot,
): BanioServiceReadiness[] {
  return BANIO_CODES.map((code) => {
    const catalogName = banioCatalogNameForCode(code);
    const base = resolveIntegralBaseFromSnap(snap, catalogName);
    const basePrice = base && base.basePrice > 0 ? base.basePrice : 0;
    return {
      code,
      catalogName,
      status: basePrice > 0 ? 'READY' : 'UNCONFIGURED',
      basePrice,
    };
  });
}

/**
 * Precio de un baño = catálogo de ESE código. Sin +15% ni addon de color.
 * Sin fila propia → UNCONFIGURED (no se reescribe como BPE).
 */
export function lookupBanioCatalogBase(
  snap: MatrixPricingSnapshot,
  code: BanioProductCode,
): { status: BanioConfigStatus; catalogName: string; basePrice: number } {
  const catalogName = banioCatalogNameForCode(code);
  const base = resolveIntegralBaseFromSnap(snap, catalogName);
  if (!base || base.basePrice <= 0) {
    return { status: 'UNCONFIGURED', catalogName, basePrice: 0 };
  }
  return { status: 'READY', catalogName, basePrice: base.basePrice };
}

export const PRODUCT_CONFIGURATION_REQUIRED = 'PRODUCT_CONFIGURATION_REQUIRED';

/** Snapshot de catálogo oficial (tests / preflight). No sustituye price_matrix de BD. */
export function officialBanioCatalogSnap(): MatrixPricingSnapshot {
  return createMatrixPricingSnapshot(
    BANIO_SERVICE_IDENTITIES.map((id, i) => ({
      id: `banio-official-${id.code}-${i}`,
      servicio: id.catalogName,
      severidad: 'BASE',
      precio: id.officialBaseMx,
      diasEntrega: 5,
      isInstantService: true,
    })) as never,
  );
}

export type IntegralBaseSlot = {
  servicio: string;
  basePrice: number;
  diasEntrega: number;
  matrixRowId: string | null;
  legacyRowId?: string | null;
  banioCode?: BanioProductCode;
  configStatus: BanioConfigStatus;
  commercialDefinition?: string;
};

/** Garantiza filas BPE/BPEI/BPCC en el panel aunque no tengan precio. */
export function ensureBanioIntegralSlots(
  rows: readonly IntegralBaseSlot[],
): IntegralBaseSlot[] {
  const byName = new Map(
    rows.map((r) => [String(r.servicio ?? '').trim().toLowerCase(), r]),
  );
  const out = [...rows];
  for (const id of BANIO_SERVICE_IDENTITIES) {
    const key = id.catalogName.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      existing.banioCode = id.code;
      existing.commercialDefinition = id.commercialDefinition;
      existing.configStatus =
        existing.basePrice > 0 ? 'READY' : 'UNCONFIGURED';
      continue;
    }
    out.push({
      servicio: id.catalogName,
      basePrice: 0,
      diasEntrega: 5,
      matrixRowId: null,
      legacyRowId: null,
      banioCode: id.code,
      commercialDefinition: id.commercialDefinition,
      configStatus: 'UNCONFIGURED',
    });
  }
  return out.sort((a, b) => a.servicio.localeCompare(b.servicio, 'es'));
}
