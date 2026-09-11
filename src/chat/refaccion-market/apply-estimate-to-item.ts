import type { DetectedDamageItem } from '../entities/chat.entity';
import type { RefaccionMarketEstimate } from './refaccion-market.types';

export function applyMarketEstimateToItem(
  item: DetectedDamageItem,
  estimate: RefaccionMarketEstimate,
): DetectedDamageItem {
  const customer = estimate.customerPriceRange;
  const market = estimate.marketPriceRange;
  const hasRange =
    estimate.pricingStatus === 'OK' &&
    customer &&
    customer.precioCentral > 0;
  return {
    ...item,
    precioMx: hasRange ? customer.precioCentral : 0,
    priceSource: estimate.priceSource,
    pricingStatus: estimate.pricingStatus,
    pricingType: estimate.pricingType,
    precioMinEstimado: customer?.precioMinEstimado,
    precioMaxEstimado: customer?.precioMaxEstimado,
    precioCentral: customer?.precioCentral,
    marketPrecioMin: market?.precioMinEstimado,
    marketPrecioMax: market?.precioMaxEstimado,
    marketPrecioCentral: market?.precioCentral,
    cantidadMuestras: estimate.cantidadMuestras,
    cantidadDominios: estimate.cantidadDominios,
    providersUsed: estimate.providersUsed,
    partTypeGroup: estimate.partTypeGroup ?? undefined,
  };
}
