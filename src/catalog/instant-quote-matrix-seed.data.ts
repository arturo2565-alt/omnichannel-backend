/**
 * Filas base de servicios integrales (baño, estética, cerámico).
 * El precio final = base × tamaño × premium (sin severidad de daño).
 */
export type InstantQuoteMatrixSeedRow = {
  servicio: string;
  severidad: string;
  precio: number;
  diasEntrega: number;
  isInstantService: boolean;
};

const DIAS_DEFAULT = 5;
const BASE = 'BASE';

export const INSTANT_QUOTE_MATRIX_SEED_ROWS: InstantQuoteMatrixSeedRow[] = [
  {
    servicio: 'Baño de Pintura Exterior',
    severidad: BASE,
    precio: 28000,
    diasEntrega: DIAS_DEFAULT,
    isInstantService: true,
  },
  {
    servicio: 'Estética Automotriz',
    severidad: BASE,
    precio: 3500,
    diasEntrega: DIAS_DEFAULT,
    isInstantService: true,
  },
  {
    servicio: 'Cerámico Automotriz',
    severidad: BASE,
    precio: 4500,
    diasEntrega: DIAS_DEFAULT,
    isInstantService: true,
  },
];
