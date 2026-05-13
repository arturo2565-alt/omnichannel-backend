import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PriceMatrix } from './entities/price-matrix.entity';

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
}
