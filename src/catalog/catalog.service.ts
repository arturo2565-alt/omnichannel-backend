import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PriceMatrix } from './entities/price-matrix.entity';
import {
  createMatrixPricingSnapshot,
  type MatrixPricingSnapshot,
} from './matrix-pricing-snapshot';
import { buildFlatRowsFromLegacyFrontendMatrix } from './legacy-price-matrix-import';
import {
  syncInstantServiceFlags,
  upsertInstantQuoteMatrixRows,
} from './instant-quote-matrix-sync';

@Injectable()
export class CatalogService {
  constructor(
    @InjectRepository(PriceMatrix)
    private readonly priceMatrixRepository: Repository<PriceMatrix>,
  ) {}

  async findAllPriceMatrixRows(): Promise<PriceMatrix[]> {
    return this.priceMatrixRepository.find({
      order: { servicio: 'ASC', severidad: 'ASC' },
    });
  }

  /** Nombres únicos de servicio/pieza (orden alfabético) para inyectar en prompts de texto. */
  async getDistinctServicioNamesForPrompt(): Promise<string[]> {
    const raw = await this.priceMatrixRepository
      .createQueryBuilder('p')
      .select('p.servicio', 'servicio')
      .distinct(true)
      .orderBy('p.servicio', 'ASC')
      .getRawMany<{ servicio: string }>();
    return raw.map((r) => String(r.servicio ?? '').trim()).filter(Boolean);
  }

  /** @deprecated usar {@link CatalogService.getDistinctServicioNamesForPrompt} */
  async getDistinctPiezaNamesForPrompt(): Promise<string[]> {
    return this.getDistinctServicioNamesForPrompt();
  }

  /** Lectura única de `price_matrix` para armar líneas de cotización (sin N queries por celda). */
  async getMatrixPricingSnapshot(): Promise<MatrixPricingSnapshot> {
    const rows = await this.priceMatrixRepository.find({
      order: { servicio: 'ASC', severidad: 'ASC' },
    });
    return createMatrixPricingSnapshot(rows);
  }

  async bulkUpdatePrecioDias(
    updates: Array<{
      id: string;
      precio: number;
      diasEntrega: number;
      isInstantService?: boolean;
    }>,
  ): Promise<PriceMatrix[]> {
    const ids = updates.map((u) => u.id);
    const existing = await this.priceMatrixRepository.find({
      where: { id: In(ids) },
    });
    const idSet = new Set(existing.map((r) => r.id));
    for (const u of updates) {
      if (!idSet.has(u.id)) {
        throw new BadRequestException(`Fila no encontrada: ${u.id}`);
      }
    }
    await this.priceMatrixRepository.manager.transaction(async (em) => {
      for (const u of updates) {
        const patch: Partial<PriceMatrix> = {
          precio: u.precio,
          diasEntrega: u.diasEntrega,
        };
        if (typeof u.isInstantService === 'boolean') {
          patch.isInstantService = u.isInstantService;
        }
        await em.update(PriceMatrix, { id: u.id }, patch);
      }
    });
    return this.findAllPriceMatrixRows();
  }

  async createRow(dto: {
    servicio: string;
    severidad: string;
    precio: number;
    diasEntrega: number;
    isInstantService?: boolean;
  }): Promise<PriceMatrix> {
    const row = this.priceMatrixRepository.create({
      servicio: dto.servicio.slice(0, 120),
      severidad: dto.severidad.slice(0, 32),
      precio: dto.precio,
      diasEntrega: dto.diasEntrega,
      isInstantService: dto.isInstantService ?? false,
    });
    const saved = await this.priceMatrixRepository.save(row);
    await syncInstantServiceFlags(this.priceMatrixRepository.manager);
    return saved;
  }

  /**
   * Carga / actualiza filas InstantQuote y re-calcula banderas en toda la tabla.
   */
  async seedInstantQuoteMatrixRows(): Promise<{ upserted: number; totalInDb: number }> {
    const upserted = await upsertInstantQuoteMatrixRows(this.priceMatrixRepository);
    await syncInstantServiceFlags(this.priceMatrixRepository.manager);
    const totalInDb = await this.priceMatrixRepository.count();
    return { upserted, totalInDb };
  }

  /**
   * Importa la matriz ancha réplica de `autofix-pricing.js` (servicio × severidad).
   * Upsert por (servicio, severidad): no duplica; actualiza precio y días si ya existía.
   */
  async importFromLegacyFrontendMirror(
    diasEntregaDefault = 3,
  ): Promise<{ upserted: number; totalInDb: number }> {
    const flat = buildFlatRowsFromLegacyFrontendMatrix(diasEntregaDefault);
    if (flat.length === 0) {
      return { upserted: 0, totalInDb: await this.priceMatrixRepository.count() };
    }
    await this.priceMatrixRepository.upsert(
      flat.map((r) => ({
        servicio: r.servicio.slice(0, 120),
        severidad: r.severidad.slice(0, 32),
        precio: r.precio,
        diasEntrega: r.diasEntrega,
        isInstantService: false,
      })),
      {
        conflictPaths: ['servicio', 'severidad'],
        skipUpdateIfNoValuesChanged: false,
      },
    );
    const totalInDb = await this.priceMatrixRepository.count();
    await syncInstantServiceFlags(this.priceMatrixRepository.manager);
    return { upserted: flat.length, totalInDb };
  }
}
