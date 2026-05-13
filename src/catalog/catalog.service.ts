import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PriceMatrix } from './entities/price-matrix.entity';
import {
  createMatrixPricingSnapshot,
  type MatrixPricingSnapshot,
} from './matrix-pricing-snapshot';

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
}
