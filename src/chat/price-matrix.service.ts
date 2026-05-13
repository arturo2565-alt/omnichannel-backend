import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  buildPiezaPriceRowsFromFlatEntries,
  calculateEstimateWithMatrix,
  coerceDamageLevelCode,
  DAMAGE_LEVEL_KEYS,
  type PiezaPriceRow,
} from './autofix-config';
import { PriceMatrixEntity } from './entities/price-matrix.entity';
import { buildFlatSeedRows } from './price-matrix.seed-data';

const GENERIC_FALLBACK_MXN = 3500;

@Injectable()
export class PriceMatrixService implements OnModuleInit {
  private readonly logger = new Logger(PriceMatrixService.name);

  private matrixRows: PiezaPriceRow[] = [];

  constructor(
    @InjectRepository(PriceMatrixEntity)
    private readonly repo: Repository<PriceMatrixEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refreshCacheFromDb();
  }

  /** Matriz agregada pieza × niveles (solo lectura; no mutar). */
  getMatrixRows(): readonly PiezaPriceRow[] {
    return this.matrixRows;
  }

  /** Precio único cuando la pieza no está en catálogo (no detiene el flujo). */
  getGenericFallbackUnitPrice(): number {
    const m = this.matrixRows;
    if (!m.length) return GENERIC_FALLBACK_MXN;
    const row = m.find((r) => normalizePiezaKey(r.pieza) === 'estetica exterior');
    if (row) {
      const vals = DAMAGE_LEVEL_KEYS.map((k) => row[k]).filter(
        (n) => typeof n === 'number' && n > 0,
      );
      if (vals.length) return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }
    let sum = 0;
    let c = 0;
    for (const r of m) {
      for (const k of DAMAGE_LEVEL_KEYS) {
        const v = r[k];
        if (typeof v === 'number' && v > 0) {
          sum += v;
          c += 1;
        }
      }
    }
    if (c === 0) return GENERIC_FALLBACK_MXN;
    return Math.round(sum / c);
  }

  async refreshCacheFromDb(): Promise<void> {
    const rows = await this.repo.find({
      order: { pieza: 'ASC', severidad: 'ASC' },
    });
    if (!rows.length) {
      this.logger.warn(
        'price_matrix vacía: usando matriz de respaldo hasta ejecutar npm run db:seed:price-matrix',
      );
      const legacyFlat = buildFlatSeedRows();
      this.matrixRows = buildPiezaPriceRowsFromFlatEntries(legacyFlat);
      return;
    }
    this.matrixRows = buildPiezaPriceRowsFromFlatEntries(
      rows.map((r) => ({
        pieza: r.pieza,
        severidad: r.severidad,
        precio: r.precio,
      })),
    );
  }

  async listAll(): Promise<PriceMatrixEntity[]> {
    return this.repo.find({ order: { pieza: 'ASC', severidad: 'ASC' } });
  }

  async createRow(body: {
    pieza: string;
    severidad: string;
    precio: number;
    diasEntrega?: number;
  }): Promise<PriceMatrixEntity> {
    const pieza = String(body.pieza ?? '').trim();
    const severidad = coerceDamageLevelCode(String(body.severidad ?? ''));
    const precio = Number(body.precio);
    const diasEntrega =
      body.diasEntrega != null && Number.isFinite(Number(body.diasEntrega))
        ? Math.max(0, Math.round(Number(body.diasEntrega)))
        : 4;
    if (!pieza) throw new BadRequestException('pieza requerida');
    if (!Number.isFinite(precio) || precio < 0) {
      throw new BadRequestException('precio inválido');
    }
    const row = this.repo.create({
      pieza,
      severidad,
      precio,
      diasEntrega,
    });
    const saved = await this.repo.save(row);
    await this.refreshCacheFromDb();
    return saved;
  }

  async updateRow(
    id: string,
    body: { precio?: number; diasEntrega?: number },
  ): Promise<PriceMatrixEntity> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Fila no encontrada: ${id}`);
    if (body.precio !== undefined) {
      const p = Number(body.precio);
      if (!Number.isFinite(p) || p < 0) throw new BadRequestException('precio inválido');
      row.precio = p;
    }
    if (body.diasEntrega !== undefined) {
      const d = Math.round(Number(body.diasEntrega));
      if (!Number.isFinite(d) || d < 0)
        throw new BadRequestException('diasEntrega inválido');
      row.diasEntrega = d;
    }
    const saved = await this.repo.save(row);
    await this.refreshCacheFromDb();
    return saved;
  }

  async deleteRow(id: string): Promise<void> {
    const r = await this.repo.delete({ id });
    if (!r.affected) throw new NotFoundException(`Fila no encontrada: ${id}`);
    await this.refreshCacheFromDb();
  }

  /**
   * Inserta filas iniciales si la tabla está vacía (misma data que antes en código).
   */
  async seedFromLegacyIfEmpty(): Promise<{ inserted: number }> {
    const n = await this.repo.count();
    if (n > 0) return { inserted: 0 };
    const flat = buildFlatSeedRows();
    await this.repo.save(
      flat.map((f) =>
        this.repo.create({
          pieza: f.pieza,
          severidad: f.severidad,
          precio: f.precio,
          diasEntrega: f.diasEntrega,
        }),
      ),
    );
    await this.refreshCacheFromDb();
    this.logger.log(`price_matrix sembrada: ${flat.length} filas`);
    return { inserted: flat.length };
  }

  /** Suma matriz para análisis (inventario o pieza única). */
  estimateForAnalysis(
    inventory: ReadonlyArray<{ pieza: string; severidad: string }> | undefined,
    singlePieza: string,
    singleSeveridad: string,
  ): number {
    const matrix = this.matrixRows;
    if (inventory?.length) {
      const sum = calculateEstimateWithMatrix(matrix, inventory);
      if (sum > 0) return sum;
    }
    const level = coerceDamageLevelCode(singleSeveridad);
    const direct = calculateEstimateWithMatrix(matrix, singlePieza, level);
    if (direct > 0) return direct;
    return this.getGenericFallbackUnitPrice();
  }

  logUnknownCatalogPieza(rawPieza: string): void {
    this.logger.warn(
      `[PriceMatrix] Pieza no catalogada; se usa precio referencia: "${rawPieza}"`,
    );
  }
}

function normalizePiezaKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
