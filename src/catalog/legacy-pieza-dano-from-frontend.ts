import type { StandardDamageLevel } from '../chat/autofix-config';

/**
 * Réplica de `omnichannel-frontend/src/autofix-pricing.js` → `PIEZA_DANO_PRICE_MATRIX`.
 * El backend no puede importar ese archivo en producción (Railway); mantén ambos alineados al editar precios.
 */
export type WideLegacyPriceRow = { pieza: string } & Record<StandardDamageLevel, number>;

export const LEGACY_PIEZA_DANO_PRICE_MATRIX: readonly WideLegacyPriceRow[] = [
  { pieza: 'Fascia', DL: 2900, DML: 3300, DM: 3600, DMF: 3500, DF: 3500, DMFuerte: 4900 },
  { pieza: 'Salpicadera', DL: 2900, DML: 2900, DM: 3350, DMF: 3900, DF: 4400, DMFuerte: 6150 },
  { pieza: 'Puerta', DL: 3100, DML: 2800, DM: 3250, DMF: 4200, DF: 5150, DMFuerte: 7200 },
  {
    pieza: 'Salpicadera trasera',
    DL: 2900,
    DML: 3200,
    DM: 3700,
    DMF: 4700,
    DF: 5700,
    DMFuerte: 8000,
  },
  { pieza: 'Cofre', DL: 4000, DML: 4500, DM: 5000, DMF: 5500, DF: 6700, DMFuerte: 7650 },
  {
    pieza: 'Tapa Cajuela',
    DL: 3500,
    DML: 3900,
    DM: 4900,
    DMF: 5800,
    DF: 6900,
    DMFuerte: 7650,
  },
  { pieza: 'Toldo', DL: 4500, DML: 5400, DM: 6500, DMF: 7500, DF: 8000, DMFuerte: 9800 },
  { pieza: 'Espejo', DL: 900, DML: 1050, DM: 1225, DMF: 1450, DF: 1650, DMFuerte: 2300 },
  { pieza: 'Estribo', DL: 2500, DML: 3200, DM: 3400, DMF: 3900, DF: 4500, DMFuerte: 5500 },
  {
    pieza: 'Estetica Exterior',
    DL: 3500,
    DML: 3500,
    DM: 3500,
    DMF: 3500,
    DF: 3500,
    DMFuerte: 3500,
  },
  { pieza: 'BiCO', DL: 2400, DML: 2400, DM: 2688, DMF: 3120, DF: 3120, DMFuerte: 3720 },
  { pieza: 'Parilla', DL: 2400, DML: 2400, DM: 2688, DMF: 3120, DF: 3120, DMFuerte: 3720 },
] as const;
