import type { PriceMatrix } from './entities/price-matrix.entity';
import {
  type DamageLevel,
  damageLevelRank,
  matchServicioFromCatalog,
  resolveDamageLevelFromText,
} from '../chat/autofix-config';

export type ServicioSeveridadInput = { servicio: string; severidad: string };

export type MatrixPricingSnapshot = {
  readonly serviciosOrderedLongestFirst: readonly string[];
  /** @deprecated usar {@link MatrixPricingSnapshot.serviciosOrderedLongestFirst} */
  readonly piezasOrderedLongestFirst: readonly string[];
  matchServicio(parteLibre: string): string | null;
  /** @deprecated usar {@link MatrixPricingSnapshot.matchServicio} */
  matchPieza(parteLibre: string): string | null;
  getAmount(
    servicioRaw: string,
    severidadRaw: string,
    descripcionTecnica?: string,
  ): number;
  matrixInventoryMaxLines(
    items: ReadonlyArray<ServicioSeveridadInput>,
  ): { canonical: string; unitPrice: number; damageLevel: DamageLevel }[];
  inventoryMaxTotal(items: ReadonlyArray<ServicioSeveridadInput>): number;
};

/**
 * Vista en memoria de `price_matrix` para cotizar sin N consultas por ítem.
 */
export function createMatrixPricingSnapshot(
  rows: readonly PriceMatrix[],
): MatrixPricingSnapshot {
  const servicios = [...new Set(rows.map((r) => r.servicio))];
  servicios.sort((a, b) => b.length - a.length);

  const priceByKey = new Map<string, number>();
  for (const r of rows) {
    priceByKey.set(`${r.servicio}|${r.severidad}`, r.precio);
  }

  const matchServicio = (parte: string) =>
    matchServicioFromCatalog(parte, servicios);

  const getAmount = (
    servicioRaw: string,
    severidadRaw: string,
    descripcionTecnica?: string,
  ): number => {
    const level = resolveDamageLevelFromText(severidadRaw, descripcionTecnica);
    if (!level) return 0;

    const read = (svc: string, sev: string): number | null => {
      const x = priceByKey.get(`${svc}|${sev}`);
      return typeof x === 'number' && !Number.isNaN(x) ? x : null;
    };

    let v = read(servicioRaw, level);
    if (v != null && v > 0) return v;
    const canonical = matchServicio(servicioRaw);
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
    items: ReadonlyArray<ServicioSeveridadInput>,
  ): { canonical: string; unitPrice: number; damageLevel: DamageLevel }[] => {
    type Best = { price: number; level: DamageLevel };
    const byCanonical = new Map<string, Best>();

    for (const it of items) {
      const canonical = matchServicio(it.servicio);
      const level = resolveDamageLevelFromText(it.severidad);
      if (!canonical || !level) continue;

      let amount = priceByKey.get(`${canonical}|${level}`) ?? null;
      if ((amount == null || amount <= 0) && level !== 'N/A') {
        amount = priceByKey.get(`${canonical}|N/A`) ?? null;
      }
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

  const inventoryMaxTotal = (items: ReadonlyArray<ServicioSeveridadInput>) =>
    matrixInventoryMaxLines(items).reduce((acc, l) => acc + l.unitPrice, 0);

  return {
    serviciosOrderedLongestFirst: servicios,
    piezasOrderedLongestFirst: servicios,
    matchServicio,
    matchPieza: matchServicio,
    getAmount,
    matrixInventoryMaxLines,
    inventoryMaxTotal,
  };
}
