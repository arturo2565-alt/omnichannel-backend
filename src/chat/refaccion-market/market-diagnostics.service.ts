import { Injectable, OnModuleInit } from '@nestjs/common';
import { isMarketTraceEnabled, isMarketTraceVerboseEnabled } from './market-search-trace';
import { SerperShoppingProvider } from './serper-shopping.provider';
import { isSerperConfigured } from './serper-config';
import { MARKET_STRATEGY_VERSION } from './parse-vehicle-part-identity';
import { pegLogger } from '../../observability/pegazuz-logger';

export const PEG_MARKET_DIAGNOSTIC_PREFIX = '[PEG_MARKET_DIAGNOSTIC]';

@Injectable()
export class MarketDiagnosticsService implements OnModuleInit {
  constructor(private readonly serperShopping: SerperShoppingProvider) {}

  snapshot() {
    return {
      serperConfigured: isSerperConfigured(),
      marketTrace: isMarketTraceEnabled(),
      marketTraceVerbose: isMarketTraceVerboseEnabled(),
      serperShoppingProviderRegistered: Boolean(this.serperShopping),
      strategyVersion: MARKET_STRATEGY_VERSION,
    };
  }

  onModuleInit(): void {
    pegLogger.debug('MARKET', {
      event: 'MARKET_MODULE_INITIALIZED',
      ...this.snapshot(),
    });
  }
}
