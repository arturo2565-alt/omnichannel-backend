import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PriceMatrix } from './entities/price-matrix.entity';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Module({
  imports: [TypeOrmModule.forFeature([PriceMatrix])],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [TypeOrmModule],
})
export class CatalogModule {}
