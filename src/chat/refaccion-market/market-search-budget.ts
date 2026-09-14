export type MarketSearchBudget = {
  maxProvidersPerLookup: number;
  maxQueriesPerProvider: number;
  maxRawResults: number;
  maxLookupDurationMs: number;
};

export const DEFAULT_MARKET_SEARCH_BUDGET: MarketSearchBudget = {
  maxProvidersPerLookup: 6,
  maxQueriesPerProvider: 2,
  maxRawResults: 60,
  maxLookupDurationMs: 20_000,
};

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function resolveMarketSearchBudget(
  overrides?: Partial<MarketSearchBudget>,
): MarketSearchBudget {
  return {
    maxProvidersPerLookup: envInt(
      'PEG_MARKET_MAX_PROVIDERS',
      overrides?.maxProvidersPerLookup ??
        DEFAULT_MARKET_SEARCH_BUDGET.maxProvidersPerLookup,
    ),
    maxQueriesPerProvider: envInt(
      'PEG_MARKET_MAX_QUERIES_PER_PROVIDER',
      overrides?.maxQueriesPerProvider ??
        DEFAULT_MARKET_SEARCH_BUDGET.maxQueriesPerProvider,
    ),
    maxRawResults: envInt(
      'PEG_MARKET_MAX_RAW_RESULTS',
      overrides?.maxRawResults ?? DEFAULT_MARKET_SEARCH_BUDGET.maxRawResults,
    ),
    maxLookupDurationMs: envInt(
      'PEG_MARKET_MAX_LOOKUP_MS',
      overrides?.maxLookupDurationMs ??
        DEFAULT_MARKET_SEARCH_BUDGET.maxLookupDurationMs,
    ),
  };
}

export type BudgetSkipReason =
  | 'BUDGET'
  | 'THRESHOLD'
  | 'NOT_NEEDED'
  | 'NO_CREDENTIALS';

export type CoverageBudgetState = {
  startedAt: number;
  providersRun: number;
  rawResults: number;
  budget: MarketSearchBudget;
};

export function createCoverageBudgetState(
  budget?: Partial<MarketSearchBudget>,
): CoverageBudgetState {
  return {
    startedAt: Date.now(),
    providersRun: 0,
    rawResults: 0,
    budget: resolveMarketSearchBudget(budget),
  };
}

export function coverageBudgetExhausted(
  state: CoverageBudgetState,
): BudgetSkipReason | undefined {
  if (state.providersRun >= state.budget.maxProvidersPerLookup) return 'BUDGET';
  if (state.rawResults >= state.budget.maxRawResults) return 'BUDGET';
  if (Date.now() - state.startedAt >= state.budget.maxLookupDurationMs) {
    return 'BUDGET';
  }
  return undefined;
}
