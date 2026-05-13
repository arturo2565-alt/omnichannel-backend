import {
  DAMAGE_LEVEL_KEYS,
  PIEZA_DANO_PRICE_MATRIX,
  type DamageLevel,
  type PiezaPriceRow,
} from '../chat/autofix-config';

export type PriceMatrixSeedRow = {
  pieza: string;
  severidad: string;
  precio: number;
  diasEntrega: number;
};

/**
 * Convierte la matriz ancha (una fila por pieza) en filas normalizadas para `price_matrix`.
 * `diasEntrega` no venía del código legacy; se usa el mismo valor por celda hasta que lo editen en BD.
 */
export function buildPriceMatrixSeedRows(
  diasEntregaDefault = 4,
): PriceMatrixSeedRow[] {
  const rows: PriceMatrixSeedRow[] = [];
  for (const row of PIEZA_DANO_PRICE_MATRIX as readonly PiezaPriceRow[]) {
    for (const sev of DAMAGE_LEVEL_KEYS) {
      const precio = row[sev as DamageLevel];
      if (typeof precio !== 'number' || Number.isNaN(precio)) continue;
      rows.push({
        pieza: row.pieza,
        severidad: sev,
        precio,
        diasEntrega: diasEntregaDefault,
      });
    }
  }
  return rows;
}
