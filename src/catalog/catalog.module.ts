import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PriceMatrix } from './entities/price-matrix.entity';
import { CatalogPricingRulesEntity } from './entities/catalog-pricing-rules.entity';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { TallerModule } from '../taller/taller.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([PriceMatrix, CatalogPricingRulesEntity]), TallerModule, AuthModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
