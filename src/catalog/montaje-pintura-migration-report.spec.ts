import {
  buildMontajePinturaMigrationReport,
} from './montaje-pintura-migration-report';
import { MONTAJE_PINTURA_CATALOG_SERVICIOS } from './montaje-pintura-catalog';

describe('reporte MONTAJE_PINTURA (sin guardar tarifas)', () => {
  it('cubre las 12 categorías con source observable', () => {
    const rows = buildMontajePinturaMigrationReport();
    expect(rows).toHaveLength(MONTAJE_PINTURA_CATALOG_SERVICIOS.length);
    expect(rows.map((r) => r.categoria)).toEqual([
      ...MONTAJE_PINTURA_CATALOG_SERVICIOS,
    ]);
    for (const row of rows) {
      expect([
        'DEDICATED_TARIFF',
        'LEGACY_REPAIR_MATRIX_FALLBACK',
        'UNCONFIGURED',
      ]).toContain(row.source);
      if (row.source === 'LEGACY_REPAIR_MATRIX_FALLBACK') {
        expect(row.dedicatedActual).toBe(0);
        expect(row.fallbackDl).toBeGreaterThan(0);
        expect(row.effective).toBe(row.fallbackDl);
        expect(row.migrationNeutralDedicated).toBe(row.effective);
      }
      if (row.source === 'UNCONFIGURED') {
        expect(row.effective).toBe(0);
        expect(row.migrationNeutralDedicated).toBe(0);
      }
    }
  });
});
