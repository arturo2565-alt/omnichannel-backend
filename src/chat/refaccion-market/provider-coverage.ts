import { classifyRawHit } from './normalize-market-sample';
import {
  hasSufficientIndependentSamples,
  uniqueIndependentSamples,
} from './sample-independence';
import {
  coverageBudgetExhausted,
  createCoverageBudgetState,
  type BudgetSkipReason,
  type MarketSearchBudget,
} from './market-search-budget';
import { GoogleWebSearchProvider } from './google-web-search.provider';
import { MercadoLibreProvider } from './mercado-libre.provider';
import { INDEXED_ML_SITE } from './site-scoped-queries';
import type {
  MarketProviderId,
  RawProviderHit,
  RefaccionMarketPolicy,
  RefaccionPriceProvider,
  VehiclePartIdentity,
} from './refaccion-market.types';
import { DEFAULT_REFACCION_MARKET_POLICY } from './refaccion-market.types';

export type ProviderContributionRow = {
  raw: number;
  unique: number;
  error?: string;
  skipped?: boolean;
  skipReason?: BudgetSkipReason;
};

export type ProviderContribution = Record<string, ProviderContributionRow>;

export type CoverageRunResult = {
  rawHits: RawProviderHit[];
  providersUsed: MarketProviderId[];
  providerContribution: ProviderContribution;
  uniqueSamplesAfterCrossProviderDedupe: number;
  stagesRun: string[];
  stagesSkipped: string[];
};

export function defaultCoverageProviders(): RefaccionPriceProvider[] {
  return [
    new GoogleWebSearchProvider('serper'),
    new GoogleWebSearchProvider('tavily'),
    new MercadoLibreProvider(),
    new GoogleWebSearchProvider('serper', INDEXED_ML_SITE),
    new GoogleWebSearchProvider('tavily', INDEXED_ML_SITE),
    new GoogleWebSearchProvider('openai'),
  ];
}

function stageIdOf(provider: RefaccionPriceProvider): string {
  return provider.coverageStageId ?? provider.id;
}

function uniqueCount(hits: readonly RawProviderHit[], identity: VehiclePartIdentity): number {
  const samples = [];
  for (const hit of hits) {
    const classified = classifyRawHit(hit, identity);
    if (classified.ok) samples.push(classified.sample);
  }
  return uniqueIndependentSamples(samples).length;
}

function enoughForPricing(
  hits: readonly RawProviderHit[],
  identity: VehiclePartIdentity,
  policy: RefaccionMarketPolicy,
): boolean {
  const samples = [];
  for (const hit of hits) {
    const classified = classifyRawHit(hit, identity);
    if (classified.ok) samples.push(classified.sample);
  }
  return hasSufficientIndependentSamples(samples, policy);
}

/**
 * Ejecuta providers en orden. Para si un preferredPartType ya tiene
 * minValidSamples independientes, o si se agota el budget.
 * Un error de provider no aborta el lookup.
 */
export async function runCoverageLookup(input: {
  identity: VehiclePartIdentity;
  providers: readonly RefaccionPriceProvider[];
  policy?: RefaccionMarketPolicy;
  budget?: Partial<MarketSearchBudget>;
  seedHits?: readonly RawProviderHit[];
}): Promise<CoverageRunResult> {
  const policy = input.policy ?? DEFAULT_REFACCION_MARKET_POLICY;
  const state = createCoverageBudgetState(input.budget);
  const rawHits: RawProviderHit[] = [...(input.seedHits ?? [])];
  const providerContribution: ProviderContribution = {};
  const providersUsed: MarketProviderId[] = [];
  const stagesRun: string[] = [];
  const stagesSkipped: string[] = [];

  for (const provider of input.providers) {
    const stageId = stageIdOf(provider);
    if (enoughForPricing(rawHits, input.identity, policy)) {
      providerContribution[stageId] = {
        raw: 0,
        unique: 0,
        skipped: true,
        skipReason: 'THRESHOLD',
      };
      stagesSkipped.push(stageId);
      continue;
    }
    if (provider.isConfigured && !provider.isConfigured()) {
      providerContribution[stageId] = {
        raw: 0,
        unique: 0,
        skipped: true,
        skipReason: 'NO_CREDENTIALS',
      };
      stagesSkipped.push(stageId);
      continue;
    }
    const exhausted = coverageBudgetExhausted(state);
    if (exhausted) {
      providerContribution[stageId] = {
        raw: 0,
        unique: 0,
        skipped: true,
        skipReason: exhausted,
      };
      stagesSkipped.push(stageId);
      continue;
    }

    const uniqueBefore = uniqueCount(rawHits, input.identity);
    let hits: RawProviderHit[] = [];
    try {
      hits = await provider.search(input.identity);
    } catch {
      hits = [];
    }
    rawHits.push(...hits);
    state.providersRun += 1;
    state.rawResults += hits.length;
    const uniqueAfter = uniqueCount(rawHits, input.identity);
    const error = provider.lastError;
    providerContribution[stageId] = {
      raw: hits.length,
      unique: Math.max(0, uniqueAfter - uniqueBefore),
      ...(error ? { error } : {}),
    };
    stagesRun.push(stageId);
    if (hits.length) providersUsed.push(provider.id);
  }

  return {
    rawHits,
    providersUsed: [...new Set(providersUsed)],
    providerContribution,
    uniqueSamplesAfterCrossProviderDedupe: uniqueCount(rawHits, input.identity),
    stagesRun,
    stagesSkipped,
  };
}
