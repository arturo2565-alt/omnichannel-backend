export const MARKET_PROVIDER_IDS = [
  'MERCADO_LIBRE',
  'GOOGLE_WEB',
  'TAVILY',
  'OPENAI_WEB',
] as const;

export type MarketProviderId = (typeof MARKET_PROVIDER_IDS)[number];

export const PART_TYPES = [
  'OEM_NEW',
  'AFTERMARKET_NEW',
  'OEM_USED',
  'UNKNOWN',
] as const;

export type PartType = (typeof PART_TYPES)[number];

export const SAMPLE_CONDITIONS = ['NEW', 'USED', 'UNKNOWN'] as const;
export type SampleCondition = (typeof SAMPLE_CONDITIONS)[number];

export type CompatibilityConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type EstimateConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type PricingType = 'RANGE' | 'NONE';
export type PricingStatus = 'OK' | 'INSUFFICIENT_MARKET_SAMPLE';

export type VehiclePartIdentity = {
  marca: string;
  modelo: string;
  anio: string | null;
  version?: string | null;
  pieza: string;
  piezaLabel: string;
  confirmed: boolean;
};

export type RawProviderHit = {
  provider: MarketProviderId;
  title: string;
  price?: number;
  url?: string;
  condition?: SampleCondition;
  snippet?: string;
  externalId?: string;
  query: string;
  retrievedAt: string;
};

export type MarketSample = {
  source: MarketProviderId;
  domain: string;
  title: string;
  price: number;
  currency: 'MXN';
  condition: SampleCondition;
  partType: PartType;
  url: string;
  compatibilityConfidence: CompatibilityConfidence;
  query: string;
  retrievedAt: string;
  externalId?: string;
};

export type PriceRange = {
  precioMinEstimado: number;
  precioMaxEstimado: number;
  precioCentral: number;
};

export type RefaccionMarketPolicy = {
  /** Orden de preferencia; no se mezclan grupos. */
  preferredPartTypes: readonly PartType[];
  marginFactor: number;
  minValidSamples: number;
  roundToMx: number;
};

export const DEFAULT_REFACCION_MARKET_POLICY: RefaccionMarketPolicy = {
  preferredPartTypes: ['AFTERMARKET_NEW', 'UNKNOWN', 'OEM_NEW', 'OEM_USED'],
  marginFactor: 1.3,
  minValidSamples: 4,
  roundToMx: 50,
};

export type RefaccionMarketEstimate = {
  pricingType: PricingType;
  pricingStatus: PricingStatus;
  marketPriceRange?: PriceRange;
  customerPriceRange?: PriceRange;
  cantidadMuestras: number;
  cantidadDominios: number;
  providersUsed: MarketProviderId[];
  priceSource: 'WEB_MARKET_ESTIMATE' | 'INSUFFICIENT_MARKET_SAMPLE';
  confidence: EstimateConfidence;
  partTypeGroup: PartType | null;
  samples: MarketSample[];
  identity: VehiclePartIdentity;
  query: string;
};

export interface RefaccionPriceProvider {
  id: MarketProviderId;
  search(identity: VehiclePartIdentity): Promise<RawProviderHit[]>;
}
