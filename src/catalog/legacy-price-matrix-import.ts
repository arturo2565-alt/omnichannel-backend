import { DAMAGE_LEVEL_KEYS, type DamageLevel } from '../chat/autofix-config';
import { LEGACY_PIEZA_DANO_PRICE_MATRIX } from './legacy-pieza-dano-from-frontend';

export type FlatLegacyImportRow = {
  pieza: string;
  severidad: string;
  precio: number;
  diasEntrega: number;
};

/**
 * Aplana la matriz ancha (misma forma que el JS del front) a filas `price_matrix`.
 */
export function buildFlatRowsFromLegacyFrontendMatrix(
  diasEntregaDefault = 3,
): FlatLegacyImportRow[] {
  const out: FlatLegacyImportRow[] = [];
  for (const row of LEGACY_PIEZA_DANO_PRICE_MATRIX) {
    for (const sev of DAMAGE_LEVEL_KEYS) {
      const precio = row[sev as DamageLevel];
      if (typeof precio !== 'number' || Number.isNaN(precio)) continue;
      out.push({
        pieza: row.pieza,
        severidad: sev,
        precio,
        diasEntrega: diasEntregaDefault,
      });
    }
  }
  return out;
}
