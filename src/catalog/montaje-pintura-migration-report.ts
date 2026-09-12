import { createMatrixPricingSnapshot } from './matrix-pricing-snapshot';
import { buildPriceMatrixSeedRows } from './price-matrix-seed.data';
import { MONTAJE_PINTURA_CATALOG_SERVICIOS } from './montaje-pintura-catalog';
import {
  resolveMontajePinturaPrice,
  type MountPaintPriceSource,
} from '../chat/draft-quote-inventory-pricing';

export type MontajePinturaMigrationRow = {
  categoria: string;
  dedicatedActual: number;
  fallbackDl: number;
  effective: number;
  source: MountPaintPriceSource;
  migrationNeutralDedicated: number;
};

/** Reporte de las 12 categorías usando el seed legacy actual. No escribe tarifas. */
export function buildMontajePinturaMigrationReport(): MontajePinturaMigrationRow[] {
  const seed = buildPriceMatrixSeedRows(4);
  const snap = createMatrixPricingSnapshot(
    seed.map((r, i) => ({
      id: `seed-${i}`,
      servicio: r.servicio,
      severidad: r.severidad,
      precio: r.precio,
      diasEntrega: r.diasEntrega,
      isInstantService: false,
    })) as never,
  );

  return MONTAJE_PINTURA_CATALOG_SERVICIOS.map((categoria) => {
    const dedicatedActual =
      snap.getPriceForCanonical(categoria, 'MONTAJE_PINTURA') ||
      snap.getPriceForCanonical(categoria, 'MONTAJE') ||
      0;
    const fallbackDl =
      snap.getPriceForCanonical(categoria, 'DL') ||
      snap.getAmount(categoria, 'DL') ||
      0;
    const resolved = resolveMontajePinturaPrice(snap, categoria);
    return {
      categoria,
      dedicatedActual,
      fallbackDl,
      effective: resolved.precio,
      source: resolved.mountPaintPriceSource,
      migrationNeutralDedicated:
        resolved.mountPaintPriceSource === 'UNCONFIGURED' ? 0 : resolved.precio,
    };
  });
}

export function formatMontajePinturaMigrationReport(
  rows = buildMontajePinturaMigrationReport(),
): string {
  const header = [
    'MONTAJE_PINTURA — reporte de migración (NO se guardan tarifas)',
    'categoria | dedicated actual | fallback DL | effective | source | migration-neutral dedicated',
  ];
  const lines = rows.map(
    (r) =>
      `${r.categoria} | $${r.dedicatedActual} | $${r.fallbackDl} | $${r.effective} | ${r.source} | $${r.migrationNeutralDedicated}`,
  );
  return [...header, ...lines].join('\n');
}

if (require.main === module) {
  console.log(formatMontajePinturaMigrationReport());
}
