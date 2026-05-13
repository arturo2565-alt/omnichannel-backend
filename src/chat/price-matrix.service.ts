import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PriceMatrixEntity } from './entities/price-matrix.entity';
import {
  coerceDamageLevelCode,
  damageLevelRank,
  DAMAGE_LEVEL_KEYS,
  type DamageLevel,
  LEGACY_SEED_PIEZA_DANO_PRICE_MATRIX,
  normalizeMatrixText,
  type PiezaPriceRow,
  resolveDamageLevelFromText,
} from './autofix-config';

/** MXN cuando la pieza detectada no está en catálogo (flujo no se detiene). */
export const GENERIC_FALLBACK_PRICE_MXN = 3500;
export const GENERIC_FALLBACK_DIAS_ENTREGA = 4;

type MatrixCache = {
  piezaRows: PiezaPriceRow[];
  rowByPiezaNorm: Map<string, PiezaPriceRow>;
  rowsByPiezaLengthDesc: PiezaPriceRow[];
  /** `${normalizeMatrixText(pieza)}|${DamageLevel}` → días entrega */
  diasByPiezaLevel: Map<string, number>;
};

export type MatrixInventoryLine = {
  canonical: string;
  unitPrice: number;
  damageLevel: DamageLevel;
  diasEntrega: number;
  usedUnknownPiezaFallback: boolean;
};

@Injectable()
export class PriceMatrixService implements OnModuleInit {
  private readonly logger = new Logger(PriceMatrixService.name);
  private cache: MatrixCache | null = null;

  constructor(
    @InjectRepository(PriceMatrixEntity)
    private readonly repo: Repository<PriceMatrixEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refreshCache();
  }

  /**
   * Recarga la matriz en memoria (tras seed o cambios en panel).
   */
  async refreshCache(): Promise<void> {
    const entities = await this.repo.find({
      order: { pieza: 'ASC', severidad: 'ASC' },
    });
    if (!entities.length) {
      this.logger.warn(
        'Tabla price_matrix vacía: usando LEGACY_SEED en memoria. Ejecuta `npm run seed:price-matrix` para persistir el catálogo.',
      );
      this.setCacheFromLegacySeed();
      return;
    }
    this.setCacheFromEntities(entities);
  }

  private setCacheFromLegacySeed(): void {
    const rows = LEGACY_SEED_PIEZA_DANO_PRICE_MATRIX.map((r) => ({ ...r }));
    const diasByPiezaLevel = new Map<string, number>();
    for (const row of rows) {
      const pn = normalizeMatrixText(row.pieza);
      for (const lvl of DAMAGE_LEVEL_KEYS) {
        const v = row[lvl];
        if (typeof v === 'number' && v > 0) {
          diasByPiezaLevel.set(`${pn}|${lvl}`, GENERIC_FALLBACK_DIAS_ENTREGA);
        }
      }
    }
    this.rebuildLookupMaps(rows, diasByPiezaLevel);
  }

  private setCacheFromEntities(entities: PriceMatrixEntity[]): void {
    const byPieza = new Map<
      string,
      Partial<Record<DamageLevel, number>> & { pieza: string }
    >();
    const diasByPiezaLevel = new Map<string, number>();

    for (const e of entities) {
      const pieza = String(e.pieza ?? '').trim();
      if (!pieza) continue;
      const level = coerceDamageLevelCode(String(e.severidad ?? 'DM'));
      const precio = Math.round(Number(e.precio));
      if (!Number.isFinite(precio) || precio < 0) continue;

      if (!byPieza.has(pieza)) {
        byPieza.set(pieza, { pieza });
      }
      const row = byPieza.get(pieza)!;
      row[level] = precio;

      const d = Math.round(Number(e.diasEntrega));
      const dias = Number.isFinite(d) && d >= 0 ? Math.min(365, d) : GENERIC_FALLBACK_DIAS_ENTREGA;
      diasByPiezaLevel.set(`${normalizeMatrixText(pieza)}|${level}`, dias);
    }

    const piezaRows: PiezaPriceRow[] = [];
    for (const partial of byPieza.values()) {
      const full = { pieza: partial.pieza } as PiezaPriceRow;
      for (const lvl of DAMAGE_LEVEL_KEYS) {
        const v = partial[lvl];
        (full as Record<string, number>)[lvl] =
          typeof v === 'number' && Number.isFinite(v) ? v : 0;
      }
      piezaRows.push(full);
    }

    this.rebuildLookupMaps(piezaRows, diasByPiezaLevel);
  }

  private rebuildLookupMaps(
    piezaRows: PiezaPriceRow[],
    diasByPiezaLevel: Map<string, number>,
  ): void {
    const rowByPiezaNorm = new Map<string, PiezaPriceRow>();
    for (const row of piezaRows) {
      rowByPiezaNorm.set(normalizeMatrixText(row.pieza), row);
    }
    const rowsByPiezaLengthDesc = [...piezaRows].sort(
      (a, b) => b.pieza.length - a.pieza.length,
    );
    this.cache = {
      piezaRows,
      rowByPiezaNorm,
      rowsByPiezaLengthDesc,
      diasByPiezaLevel,
    };
  }

  private requireCache(): MatrixCache {
    if (!this.cache) {
      this.setCacheFromLegacySeed();
    }
    return this.cache!;
  }

  matchPiezaFromAnalysis(parteLibre: string): string | null {
    const c = this.requireCache();
    const n = normalizeMatrixText(parteLibre);
    if (!n) return null;
    if (c.rowByPiezaNorm.has(n)) return c.rowByPiezaNorm.get(n)!.pieza;
    for (const row of c.rowsByPiezaLengthDesc) {
      const key = normalizeMatrixText(row.pieza);
      if (!key) continue;
      if (n.includes(key) || (key.length >= 4 && key.includes(n))) {
        return row.pieza;
      }
    }
    return null;
  }

  findPiezaRow(pieza: string): PiezaPriceRow | null {
    const c = this.requireCache();
    const n = normalizeMatrixText(pieza);
    if (c.rowByPiezaNorm.has(n)) return c.rowByPiezaNorm.get(n)!;
    const matched = this.matchPiezaFromAnalysis(pieza);
    if (!matched) return null;
    return c.rowByPiezaNorm.get(normalizeMatrixText(matched)) ?? null;
  }

  private getDiasForCell(canonicalPieza: string, level: DamageLevel): number {
    const c = this.requireCache();
    const k = `${normalizeMatrixText(canonicalPieza)}|${level}`;
    return c.diasByPiezaLevel.get(k) ?? GENERIC_FALLBACK_DIAS_ENTREGA;
  }

  /**
   * Precio y metadatos para una pieza (texto libre o canónica) y severidad.
   */
  matrixAmountForPair(
    pieza: string,
    severidad: string,
    descripcionTecnica?: string,
  ): {
    amount: number;
    level: DamageLevel;
    row: PiezaPriceRow | null;
    canonical: string | null;
    diasEntrega: number;
    usedUnknownPiezaFallback: boolean;
  } {
    const row = this.findPiezaRow(pieza);
    const level =
      resolveDamageLevelFromText(severidad, descripcionTecnica) ??
      coerceDamageLevelCode(severidad);

    if (row) {
      const amount = row[level];
      if (typeof amount === 'number' && !Number.isNaN(amount) && amount > 0) {
        const dias = this.getDiasForCell(row.pieza, level);
        return {
          amount,
          level,
          row,
          canonical: row.pieza,
          diasEntrega: dias,
          usedUnknownPiezaFallback: false,
        };
      }
    }

    this.logger.warn(
      `[PriceMatrix] Pieza o celda sin precio en catálogo — pieza="${pieza}" severidad="${severidad}". Se usa referencia genérica ${GENERIC_FALLBACK_PRICE_MXN} MXN.`,
    );
    return {
      amount: GENERIC_FALLBACK_PRICE_MXN,
      level,
      row: null,
      canonical: null,
      diasEntrega: GENERIC_FALLBACK_DIAS_ENTREGA,
      usedUnknownPiezaFallback: true,
    };
  }

  matrixInventoryMaxLines(
    items: ReadonlyArray<{
      pieza: string;
      severidad: string;
      descripcionTecnica?: string;
    }>,
  ): MatrixInventoryLine[] {
    type Best = {
      price: number;
      level: DamageLevel;
      dias: number;
      usedFb: boolean;
      display: string;
    };
    const byKey = new Map<string, Best>();

    for (const it of items) {
      const r = this.matrixAmountForPair(
        it.pieza,
        it.severidad,
        it.descripcionTecnica,
      );
      if (r.amount <= 0) continue;

      const mapKey = r.canonical
        ? `cat:${normalizeMatrixText(r.canonical)}`
        : `raw:${normalizeMatrixText(it.pieza)}`;
      const display = r.canonical ?? (it.pieza.trim() || 'Pieza sin nombre');

      const cur = byKey.get(mapKey);
      if (!cur || r.amount > cur.price) {
        byKey.set(mapKey, {
          price: r.amount,
          level: r.level,
          dias: r.diasEntrega,
          usedFb: r.usedUnknownPiezaFallback,
          display,
        });
      } else if (r.amount === cur.price) {
        if (damageLevelRank(r.level) > damageLevelRank(cur.level)) {
          byKey.set(mapKey, {
            price: r.amount,
            level: r.level,
            dias: r.diasEntrega,
            usedFb: r.usedUnknownPiezaFallback,
            display,
          });
        }
      }
    }

    return [...byKey.values()].map((b) => ({
      canonical: b.display,
      unitPrice: b.price,
      damageLevel: b.level,
      diasEntrega: b.dias,
      usedUnknownPiezaFallback: b.usedFb,
    }));
  }

  calculateEstimate(
    pieza: string,
    severidad: string,
    descripcionTecnica?: string,
  ): number {
    return this.matrixAmountForPair(pieza, severidad, descripcionTecnica).amount;
  }

  calculateEstimateForItems(
    items: ReadonlyArray<{
      pieza: string;
      severidad: string;
      descripcionTecnica?: string;
    }>,
  ): number {
    return this.matrixInventoryMaxLines(items).reduce(
      (acc, l) => acc + l.unitPrice,
      0,
    );
  }

  async findAllOrdered(): Promise<PriceMatrixEntity[]> {
    return this.repo.find({
      order: { pieza: 'ASC', severidad: 'ASC' },
    });
  }

  async updateById(
    id: string,
    body: { precio?: number; diasEntrega?: number },
  ): Promise<PriceMatrixEntity> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Celda de matriz no encontrada: ${id}`);
    }
    if (body.precio !== undefined) {
      const p = Math.round(Number(body.precio));
      if (!Number.isFinite(p) || p < 0) {
        throw new BadRequestException('precio debe ser un número >= 0');
      }
      row.precio = p;
    }
    if (body.diasEntrega !== undefined) {
      const d = Math.round(Number(body.diasEntrega));
      if (!Number.isFinite(d) || d < 0 || d > 365) {
        throw new BadRequestException('diasEntrega debe ser un entero entre 0 y 365');
      }
      row.diasEntrega = d;
    }
    const saved = await this.repo.save(row);
    await this.refreshCache();
    return saved;
  }

  async create(body: {
    pieza: string;
    severidad: string;
    precio: number;
    diasEntrega?: number;
  }): Promise<PriceMatrixEntity> {
    const pieza = String(body.pieza ?? '').trim();
    if (!pieza) throw new BadRequestException('pieza es obligatoria');
    const severidad = coerceDamageLevelCode(String(body.severidad ?? 'DM'));
    const precio = Math.round(Number(body.precio));
    if (!Number.isFinite(precio) || precio < 0) {
      throw new BadRequestException('precio debe ser un número >= 0');
    }
    const diasRaw =
      body.diasEntrega !== undefined
        ? Math.round(Number(body.diasEntrega))
        : GENERIC_FALLBACK_DIAS_ENTREGA;
    if (!Number.isFinite(diasRaw) || diasRaw < 0 || diasRaw > 365) {
      throw new BadRequestException('diasEntrega debe ser un entero entre 0 y 365');
    }

    const row = this.repo.create({
      pieza,
      severidad,
      precio,
      diasEntrega: diasRaw,
    });
    try {
      const saved = await this.repo.save(row);
      await this.refreshCache();
      return saved;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/unique|duplicate/i.test(msg)) {
        throw new BadRequestException(
          'Ya existe una fila para esa combinación pieza + severidad',
        );
      }
      throw e;
    }
  }
}
