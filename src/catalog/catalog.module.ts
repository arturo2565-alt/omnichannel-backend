import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PriceMatrix } from './entities/price-matrix.entity';
import { CatalogPricingRulesEntity } from './entities/catalog-pricing-rules.entity';
import { RefaccionCatalog } from './entities/refaccion-catalog.entity';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { RefaccionesController } from './refacciones.controller';
import { RefaccionesService } from './refacciones.service';
import { TallerModule } from '../taller/taller.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PriceMatrix,
      CatalogPricingRulesEntity,
      RefaccionCatalog,
    ]),
    TallerModule,
    AuthModule,
  ],
  controllers: [CatalogController, RefaccionesController],
  providers: [CatalogService, RefaccionesService],
  exports: [CatalogService, RefaccionesService],
})
export class CatalogModule {}
