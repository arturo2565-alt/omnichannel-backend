import type { MatrixPricingSnapshot } from '../../catalog/matrix-pricing-snapshot';

/** Snapshot reutilizado de tests existentes. No inventa catálogo productivo. */
export function autonomyMockSnap(
  prices: Record<string, number> = {},
): MatrixPricingSnapshot {
  const defaults: Record<string, number> = {
    'Puerta|DL': 3800,
    'Puerta|DM': 4200,
    'Fascia|DL': 2900,
    'Fascia|MONTAJE_PINTURA': 3400,
    'FD|MONTAJE_PINTURA': 3400,
    'Cofre|MONTAJE_PINTURA': 6900,
    'Cofre|DL': 4000,
    'Baño de Pintura Exterior|BASE': 28000,
    'Baño de Pintura Exterior|Mediano': 28000,
    'Baño de Pintura Exterior|Compacto': 28000,
    'Baño de Pintura Exterior e Interiores|BASE': 32000,
    'Baño de Pintura Exterior e Interiores|Mediano': 32000,
    'Baño de Pintura con Cambio de Color|BASE': 39000,
    'Baño de Pintura con Cambio de Color|Mediano': 39000,
    ...prices,
  };
  return {
    matchServicio: (s: string) => {
      const n = String(s ?? '').toLowerCase();
      if (/bpcc|cambio de color/.test(n)) {
        return 'Baño de Pintura con Cambio de Color';
      }
      if (/bpei|interiores/.test(n)) {
        return 'Baño de Pintura Exterior e Interiores';
      }
      if (/bañ|bano|\bbpe\b|transformaci/.test(n)) {
        return 'Baño de Pintura Exterior';
      }
      if (/fascia|^fd$|^ft$/.test(n)) return 'Fascia';
      if (/puerta|^pd/.test(n)) return 'Puerta';
      if (/cofre/.test(n)) return 'Cofre';
      return s;
    },
    getPriceForCanonical: (canonical: string, level: string) => {
      const exact = defaults[`${canonical}|${level}`] ?? defaults[canonical];
      if (exact != null) return exact;
      return 4000;
    },
    getAmount: (pieza: string, level: string) => {
      const exact = defaults[`${pieza}|${level}`] ?? defaults[pieza];
      if (exact != null) return exact;
      return 4000;
    },
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => [
      'DL',
      'DM',
      'MONTAJE_PINTURA',
      'BASE',
      'Mediano',
      'Compacto',
    ],
    serviciosOrderedLongestFirst: [
      'Baño de Pintura con Cambio de Color',
      'Baño de Pintura Exterior e Interiores',
      'Baño de Pintura Exterior',
      'Fascia',
      'Puerta',
      'Cofre',
    ],
  } as unknown as MatrixPricingSnapshot;
}
