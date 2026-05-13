/**
 * Filas de cotización inmediata (InstantQuote): baños de pintura por tamaño, estética.
 * `severidad` almacena el tamaño/tipo (hasta 32 caracteres en BD).
 */
export type InstantQuoteMatrixSeedRow = {
  servicio: string;
  severidad: string;
  precio: number;
  diasEntrega: number;
  isInstantService: boolean;
};

const DIAS_DEFAULT = 5;

export const INSTANT_QUOTE_MATRIX_SEED_ROWS: InstantQuoteMatrixSeedRow[] = [
  {
    servicio: 'Baño de Pintura Exterior',
    severidad: 'Chico',
    precio: 28000,
    diasEntrega: DIAS_DEFAULT,
    isInstantService: true,
  },
  {
    servicio: 'Baño de Pintura Exterior',
    severidad: 'Chico Premium',
    precio: 30000,
    diasEntrega: DIAS_DEFAULT,
    isInstantService: true,
  },
  {
    servicio: 'Baño de Pintura Exterior',
    severidad: 'Mediano',
    precio: 29000,
    diasEntrega: DIAS_DEFAULT,
    isInstantService: true,
  },
  {
    servicio: 'Baño de Pintura Exterior',
    severidad: 'Mediano Premium',
    precio: 32000,
    diasEntrega: DIAS_DEFAULT,
    isInstantService: true,
  },
  {
    servicio: 'Baño de Pintura Exterior',
    severidad: 'Grande',
    precio: 33000,
    diasEntrega: DIAS_DEFAULT,
    isInstantService: true,
  },
  {
    servicio: 'Baño de Pintura Exterior',
    severidad: 'Grande Premium',
    precio: 36000,
    diasEntrega: DIAS_DEFAULT,
    isInstantService: true,
  },
  {
    servicio: 'Baño de Pintura Exterior',
    severidad: 'XL',
    precio: 36000,
    diasEntrega: DIAS_DEFAULT,
    isInstantService: true,
  },
  {
    servicio: 'Baño de Pintura Exterior',
    severidad: 'XL Premium',
    precio: 39000,
    diasEntrega: DIAS_DEFAULT,
    isInstantService: true,
  },
  {
    servicio: 'Estética Automotriz',
    severidad: 'N/A',
    precio: 3500,
    diasEntrega: DIAS_DEFAULT,
    isInstantService: true,
  },
];
