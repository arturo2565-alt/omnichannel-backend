import { parseMarketSide, type MarketSide } from './market-side';
import { pickPartTypeGroup } from './compute-market-range';
import type { LampType, MarketSample, RefaccionMarketPolicy } from './refaccion-market.types';
import { DEFAULT_REFACCION_MARKET_POLICY } from './refaccion-market.types';

export type VariantCluster = {
  variantKey: string;
  side: MarketSide | 'UNKNOWN';
  lampType: LampType;
  members: MarketSample[];
};

export function inferLampType(title: string, snippet?: string): LampType {
  const blob = `${title} ${snippet ?? ''}`;
  if (/\bnon[-\s]?led\b|sin\s+led|halogen|halogena|incandescent|convencional/i.test(blob)) {
    return 'NON_LED';
  }
  if (/\bled\b|diodo/i.test(blob)) return 'LED';
  return 'UNKNOWN';
}

export function variantKeyOf(
  sample: Pick<MarketSample, 'title' | 'partNumber' | 'lampType'> & {
    snippet?: string;
    detectedSide?: MarketSide | 'UNKNOWN' | null;
  },
): string {
  const side = sample.detectedSide ?? parseMarketSide(sample.title) ?? 'UNKNOWN';
  const lamp = sample.lampType ?? inferLampType(sample.title, sample.snippet);
  const pn = String(sample.partNumber ?? '').trim().toUpperCase();
  return pn ? `${side}|${lamp}|${pn}` : `${side}|${lamp}`;
}

export function clusterSamplesByVariant(
  samples: readonly MarketSample[],
): VariantCluster[] {
  const bags = new Map<string, VariantCluster>();
  for (const sample of samples) {
    const side = parseMarketSide(sample.title) ?? 'UNKNOWN';
    const lamp = sample.lampType ?? inferLampType(sample.title);
    const clusterKey = `${side}|${lamp}`;
    const existing = bags.get(clusterKey);
    const stamped = {
      ...sample,
      lampType: lamp,
      variantKey: variantKeyOf({
        ...sample,
        lampType: lamp,
        detectedSide: side,
      }),
    };
    if (existing) {
      existing.members.push(stamped);
    } else {
      bags.set(clusterKey, {
        variantKey: clusterKey,
        side,
        lampType: lamp,
        members: [stamped],
      });
    }
  }
  return [...bags.values()].sort((a, b) => b.members.length - a.members.length);
}

export function clusterHasPricingSamples(
  cluster: VariantCluster,
  policy: RefaccionMarketPolicy = DEFAULT_REFACCION_MARKET_POLICY,
): boolean {
  const picked = pickPartTypeGroup(cluster.members, policy);
  return Boolean(picked.group && picked.members.length >= policy.minValidSamples);
}

/**
 * No mezcla LED/NON_LED. Si el daño no distingue, no inventa:
 * elige el cluster que ya alcanza umbral, o el más grande, y marca incertidumbre.
 */
export function selectVariantCluster(
  clusters: readonly VariantCluster[],
  policy: RefaccionMarketPolicy = DEFAULT_REFACCION_MARKET_POLICY,
  knownLamp?: LampType,
): {
  selected: VariantCluster | null;
  uncertainty: boolean;
  uniqueSamplesPerVariant: Record<string, number>;
} {
  const uniqueSamplesPerVariant: Record<string, number> = {};
  for (const c of clusters) {
    uniqueSamplesPerVariant[c.variantKey] = c.members.length;
  }
  if (!clusters.length) {
    return { selected: null, uncertainty: false, uniqueSamplesPerVariant };
  }
  if (knownLamp && knownLamp !== 'UNKNOWN') {
    const forced = clusters.find((c) => c.lampType === knownLamp);
    if (forced) {
      return { selected: forced, uncertainty: false, uniqueSamplesPerVariant };
    }
  }
  const priced = clusters.filter((c) => clusterHasPricingSamples(c, policy));
  if (priced.length === 1) {
    return {
      selected: priced[0]!,
      uncertainty: priced[0]!.lampType !== 'UNKNOWN' && !knownLamp,
      uniqueSamplesPerVariant,
    };
  }
  if (priced.length > 1) {
    return {
      selected: priced[0]!,
      uncertainty: true,
      uniqueSamplesPerVariant,
    };
  }
  return {
    selected: clusters[0] ?? null,
    uncertainty: clusters.length > 1,
    uniqueSamplesPerVariant,
  };
}
