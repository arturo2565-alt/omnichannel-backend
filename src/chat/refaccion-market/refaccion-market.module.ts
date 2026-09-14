import { Module } from '@nestjs/common';
import { MarketDiagnosticsService } from './market-diagnostics.service';
import { RefaccionMarketService } from './refaccion-market.orchestrator';
import { SerperShoppingProvider } from './serper-shopping.provider';

@Module({
  providers: [
    RefaccionMarketService,
    SerperShoppingProvider,
    MarketDiagnosticsService,
  ],
  exports: [RefaccionMarketService, SerperShoppingProvider],
})
export class RefaccionMarketModule {}
