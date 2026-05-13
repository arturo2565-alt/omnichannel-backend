import type { PriceMatrix } from './entities/price-matrix.entity';
import {
  type DamageLevel,
  damageLevelRank,
  matchPiezaFromCatalog,
  resolveDamageLevelFromText,
} from '../chat/autofix-config';

export type PiezaSeveridadInput = { pieza: string; severidad: string };

export type MatrixPricingSnapshot = {
  readonly piezasOrderedLongestFirst: readonly string[];
  matchPieza(parteLibre: string): string | null;
  getAmount(
    piezaRaw: string,
    severidadRaw: string,
    descripcionTecnica?: string,
  ): number;
  matrixInventoryMaxLines(
    items: ReadonlyArray<PiezaSeveridadInput>,
  ): { canonical: string; unitPrice: number; damageLevel: DamageLevel }[];
  inventoryMaxTotal(items: ReadonlyArray<PiezaSeveridadInput>): number;
};

/**
 * Vista en memoria de `price_matrix` para cotizar sin N consultas por ítem.
 */
export function createMatrixPricingSnapshot(
  rows: readonly PriceMatrix[],
): MatrixPricingSnapshot {
  const piezas = [...new Set(rows.map((r) => r.pieza))];
  piezas.sort((a, b) => b.length - a.length);

  const priceByKey = new Map<string, number>();
  for (const r of rows) {
    priceByKey.set(`${r.pieza}|${r.severidad}`, r.precio);
  }

  const matchPieza = (parte: string) => matchPiezaFromCatalog(parte, piezas);

  const getAmount = (
    piezaRaw: string,
    severidadRaw: string,
    descripcionTecnica?: string,
  ): number => {
    const level = resolveDamageLevelFromText(severidadRaw, descripcionTecnica);
    if (!level) return 0;

    const read = (pie: string, sev: string): number | null => {
      const x = priceByKey.get(`${pie}|${sev}`);
      return typeof x === 'number' && !Number.isNaN(x) ? x : null;
    };

    let v = read(piezaRaw, level);
    if (v != null && v > 0) return v;
    const canonical = matchPieza(piezaRaw);
    if (canonical) {
      v = read(canonical, level);
      if (v != null && v > 0) return v;
      if (level !== 'N/A') {
        const na = read(canonical, 'N/A');
        if (na != null && na > 0) return na;
      }
    }
    return 0;
  };

  const matrixInventoryMaxLines = (
    items: ReadonlyArray<PiezaSeveridadInput>,
  ): { canonical: string; unitPrice: number; damageLevel: DamageLevel }[] => {
    type Best = { price: number; level: DamageLevel };
    const byCanonical = new Map<string, Best>();

    for (const it of items) {
      const canonical = matchPieza(it.pieza);
      const level = resolveDamageLevelFromText(it.severidad);
      if (!canonical || !level) continue;
      const amount = priceByKey.get(`${canonical}|${level}`);
      if (amount == null || amount <= 0) continue;

      const cur = byCanonical.get(canonical);
      if (!cur || amount > cur.price) {
        byCanonical.set(canonical, { price: amount, level });
      } else if (amount === cur.price) {
        if (damageLevelRank(level) > damageLevelRank(cur.level)) {
          byCanonical.set(canonical, { price: amount, level });
        }
      }
    }

    return [...byCanonical.entries()].map(([canonical, b]) => ({
      canonical,
      unitPrice: b.price,
      damageLevel: b.level,
    }));
  };

  const inventoryMaxTotal = (items: ReadonlyArray<PiezaSeveridadInput>) =>
    matrixInventoryMaxLines(items).reduce((acc, l) => acc + l.unitPrice, 0);

  return {
    piezasOrderedLongestFirst: piezas,
    matchPieza,
    getAmount,
    matrixInventoryMaxLines,
    inventoryMaxTotal,
  };
}
