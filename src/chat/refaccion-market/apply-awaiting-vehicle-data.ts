import type { DetectedDamageItem } from '../entities/chat.entity';

export function applyAwaitingVehicleDataToItem(
  item: DetectedDamageItem,
  missingFields: readonly string[],
): DetectedDamageItem {
  void missingFields;
  return {
    ...item,
    tratamiento: 'SUSTITUIR',
    precioMx: 0,
    pricingStatus: 'AWAITING_VEHICLE_DATA',
    priceSource: 'AWAITING_VEHICLE_DATA',
    pricingType: 'NONE',
    marketIdentityKey: undefined,
  };
}

export function invalidateMarketPricingOnItem(
  item: DetectedDamageItem,
): DetectedDamageItem {
  return {
    ...item,
    precioMx: 0,
    pricingStatus: undefined,
    priceSource: undefined,
    pricingType: undefined,
    precioMinEstimado: undefined,
    precioMaxEstimado: undefined,
    precioCentral: undefined,
    marketPrecioMin: undefined,
    marketPrecioMax: undefined,
    marketPrecioCentral: undefined,
    cantidadMuestras: undefined,
    cantidadDominios: undefined,
    marketIdentityKey: undefined,
  };
}
