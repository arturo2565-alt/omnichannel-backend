import type { MatrixPricingSnapshot } from './matrix-pricing-snapshot';
import { MONTAJE_PINTURA_CATALOG_SERVICIOS } from './montaje-pintura-catalog';
import {
  resolveMontajePinturaPrice,
  type MountPaintPriceSource,
} from '../chat/draft-quote-inventory-pricing';

export type MontajePinturaAuditRow = {
  servicio: string;
  mountPaintPriceSource: MountPaintPriceSource;
  precio: number;
};

export function auditMontajePinturaCategories(
  snap: MatrixPricingSnapshot,
): {
  rows: MontajePinturaAuditRow[];
  dedicatedTariffs: number;
  fallback: number;
  unconfigured: number;
} {
  const rows = MONTAJE_PINTURA_CATALOG_SERVICIOS.map((servicio) => {
    const resolved = resolveMontajePinturaPrice(snap, servicio);
    return {
      servicio,
      mountPaintPriceSource: resolved.mountPaintPriceSource,
      precio: resolved.precio,
    };
  });
  return {
    rows,
    dedicatedTariffs: rows.filter(
      (r) => r.mountPaintPriceSource === 'DEDICATED_TARIFF',
    ).length,
    fallback: rows.filter(
      (r) => r.mountPaintPriceSource === 'LEGACY_REPAIR_MATRIX_FALLBACK',
    ).length,
    unconfigured: rows.filter(
      (r) => r.mountPaintPriceSource === 'UNCONFIGURED',
    ).length,
  };
}
