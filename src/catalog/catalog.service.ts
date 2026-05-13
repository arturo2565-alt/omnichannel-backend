import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PriceMatrix } from './entities/price-matrix.entity';
import {
  createMatrixPricingSnapshot,
  type MatrixPricingSnapshot,
} from './matrix-pricing-snapshot';
import { buildFlatRowsFromLegacyFrontendMatrix } from './legacy-price-matrix-import';

@Injectable()
export class CatalogService {
  constructor(
    @InjectRepository(PriceMatrix)
    private readonly priceMatrixRepository: Repository<PriceMatrix>,
  ) {}

  async findAllPriceMatrixRows(): Promise<PriceMatrix[]> {
    return this.priceMatrixRepository.find({
      order: { pieza: 'ASC', severidad: 'ASC' },
    });
  }

  /** Nombres únicos de pieza/servicio (orden alfabético) para inyectar en prompts de texto. */
  async getDistinctPiezaNamesForPrompt(): Promise<string[]> {
    const raw = await this.priceMatrixRepository
      .createQueryBuilder('p')
      .select('p.pieza', 'pieza')
      .distinct(true)
      .orderBy('p.pieza', 'ASC')
      .getRawMany<{ pieza: string }>();
    return raw.map((r) => String(r.pieza ?? '').trim()).filter(Boolean);
  }

  /** Lectura única de `price_matrix` para armar líneas de cotización (sin N queries por celda). */
  async getMatrixPricingSnapshot(): Promise<MatrixPricingSnapshot> {
    const rows = await this.priceMatrixRepository.find({
      order: { pieza: 'ASC', severidad: 'ASC' },
    });
    return createMatrixPricingSnapshot(rows);
  }

  async bulkUpdatePrecioDias(
    updates: Array<{ id: string; precio: number; diasEntrega: number }>,
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
        await em.update(
          PriceMatrix,
          { id: u.id },
          { precio: u.precio, diasEntrega: u.diasEntrega },
        );
      }
    });
    return this.findAllPriceMatrixRows();
  }

  async createRow(dto: {
    pieza: string;
    severidad: string;
    precio: number;
    diasEntrega: number;
  }): Promise<PriceMatrix> {
    const row = this.priceMatrixRepository.create({
      pieza: dto.pieza.slice(0, 120),
      severidad: dto.severidad.slice(0, 32),
      precio: dto.precio,
      diasEntrega: dto.diasEntrega,
    });
    return this.priceMatrixRepository.save(row);
  }

  /**
   * Importa la matriz ancha réplica de `autofix-pricing.js` (pieza × severidad).
   * Upsert por (pieza, severidad): no duplica; actualiza precio y días si ya existía.
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
        pieza: r.pieza.slice(0, 120),
        severidad: r.severidad.slice(0, 32),
        precio: r.precio,
        diasEntrega: r.diasEntrega,
      })),
      {
        conflictPaths: ['pieza', 'severidad'],
        skipUpdateIfNoValuesChanged: false,
      },
    );
    const totalInDb = await this.priceMatrixRepository.count();
    return { upserted: flat.length, totalInDb };
  }
}
