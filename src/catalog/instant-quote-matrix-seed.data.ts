import {
  BANIO_SERVICE_IDENTITIES,
} from './banio-service-identity';

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
  ...BANIO_SERVICE_IDENTITIES.map((id) => ({
    servicio: id.catalogName,
    severidad: BASE,
    precio: id.officialBaseMx,
    diasEntrega: DIAS_DEFAULT,
    isInstantService: true,
  })),
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
    precio: 7000,
    diasEntrega: DIAS_DEFAULT,
    isInstantService: true,
  },
];
