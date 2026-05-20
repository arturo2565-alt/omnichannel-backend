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
  /** Precio exacto por clave catálogo `servicio|severidad` (p. ej. tamaño de baño de pintura). */
  getPriceExact(parteLibre: string, severidadLiteral: string): number;
  /** Celda marcada como InstantQuote en BD. */
  isInstantExact(parteLibre: string, severidadLiteral: string): boolean;
  /** Precio usando el nombre canónico exacto de BD (sin re-ejecutar match sobre texto libre). */
  getPriceForCanonical(canonicalServicio: string, severidadLiteral: string): number;
  /** Días hábiles de entrega para celda canónica (catálogo). */
  getDiasEntregaForCanonical(canonicalServicio: string, severidadLiteral: string): number;
  /** InstantQuote usando nombre canónico exacto de BD. */
  isInstantForCanonical(canonicalServicio: string, severidadLiteral: string): boolean;
  /** Severidades definidas en catálogo para un servicio canónico (p. ej. tamaños de baño de pintura). */
  listSeveridadesForCanonical(canonicalServicio: string): string[];
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
  const diasByKey = new Map<string, number>();
  const instantByKey = new Map<string, boolean>();
  for (const r of rows) {
    const k = `${r.servicio}|${r.severidad}`;
    priceByKey.set(k, r.precio);
    const dias = Number(r.diasEntrega);
    diasByKey.set(k, Number.isFinite(dias) && dias >= 0 ? Math.floor(dias) : 0);
    instantByKey.set(k, r.isInstantService === true);
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

  const getPriceExact = (parteLibre: string, severidadLiteral: string): number => {
    const c = matchServicio(parteLibre);
    if (!c) return 0;
    const sev = String(severidadLiteral ?? '').trim();
    if (!sev) return 0;
    const v = priceByKey.get(`${c}|${sev}`);
    return typeof v === 'number' && !Number.isNaN(v) && v > 0 ? v : 0;
  };

  const isInstantExact = (parteLibre: string, severidadLiteral: string): boolean => {
    const c = matchServicio(parteLibre);
    if (!c) return false;
    const sev = String(severidadLiteral ?? '').trim();
    if (!sev) return false;
    return instantByKey.get(`${c}|${sev}`) === true;
  };

  const getPriceForCanonical = (
    canonicalServicio: string,
    severidadLiteral: string,
  ): number => {
    const c = String(canonicalServicio ?? '').trim();
    const sev = String(severidadLiteral ?? '').trim();
    if (!c || !sev) return 0;
    const v = priceByKey.get(`${c}|${sev}`);
    return typeof v === 'number' && !Number.isNaN(v) && v > 0 ? v : 0;
  };

  const getDiasEntregaForCanonical = (
    canonicalServicio: string,
    severidadLiteral: string,
  ): number => {
    const c = String(canonicalServicio ?? '').trim();
    const sev = String(severidadLiteral ?? '').trim();
    if (!c || !sev) return 0;
    const v = diasByKey.get(`${c}|${sev}`);
    return typeof v === 'number' && !Number.isNaN(v) && v >= 0 ? v : 0;
  };

  const isInstantForCanonical = (
    canonicalServicio: string,
    severidadLiteral: string,
  ): boolean => {
    const c = String(canonicalServicio ?? '').trim();
    const sev = String(severidadLiteral ?? '').trim();
    if (!c || !sev) return false;
    return instantByKey.get(`${c}|${sev}`) === true;
  };

  const listSeveridadesForCanonical = (canonicalServicio: string): string[] => {
    const c = String(canonicalServicio ?? '').trim();
    if (!c) return [];
    const prefix = `${c}|`;
    const out: string[] = [];
    for (const k of priceByKey.keys()) {
      if (k.startsWith(prefix)) {
        const sev = k.slice(prefix.length);
        if (sev) out.push(sev);
      }
    }
    out.sort((a, b) => a.localeCompare(b, 'es'));
    return out;
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
    getPriceExact,
    isInstantExact,
    getPriceForCanonical,
    getDiasEntregaForCanonical,
    isInstantForCanonical,
    listSeveridadesForCanonical,
    matrixInventoryMaxLines,
    inventoryMaxTotal,
  };
}
