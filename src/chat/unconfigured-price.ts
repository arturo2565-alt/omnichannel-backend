/**
 * amount === 0 no significa "gratis" cuando el origen es UNCONFIGURED.
 */

export const UNCONFIGURED_PRICE_SOURCE = 'UNCONFIGURED' as const;

export function isUnconfiguredPriceSource(source: string | undefined | null): boolean {
  const s = String(source ?? '').trim().toUpperCase();
  return s === 'UNCONFIGURED' || s === 'MISSING_PRICE';
}

export function isPresentedAsFreeWhenUnconfigured(
  amount: number,
  source: string | undefined | null,
  billable?: boolean,
): boolean {
  if (!isUnconfiguredPriceSource(source)) return false;
  return billable === true && Math.round(Number(amount) || 0) === 0;
}

export function commercialAmountMeaning(
  amount: number,
  source: string | undefined | null,
): 'configured' | 'unconfigured' | 'zero_chargeable' {
  const amt = Math.round(Number(amount) || 0);
  if (isUnconfiguredPriceSource(source)) return 'unconfigured';
  if (amt === 0) return 'zero_chargeable';
  return 'configured';
}
