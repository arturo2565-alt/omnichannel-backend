import { CalibrationConflictError, CalibrationWriteError } from './calibration-github-writer';
import {
  commercialCounts,
  type CommercialArchive,
  type CommercialIndex,
} from './commercial-quote-writer';
import {
  commercialObservationFingerprint,
  validateCommercialQuote,
  type StoredCommercialQuote,
  type ValidatedCommercialQuote,
} from './commercial-quote';

/**
 * Registra una observación comercial. La misma clave no se sobrescribe.
 * Una revisión autorizada es otra observación de la misma oportunidad.
 */
export type CommercialRecordResult = {
  status: 'created' | 'already_exists' | 'reconciled';
  quoteId: string;
  opportunityKey: string;
  revision: number;
  opportunityCount: number;
  quoteCount: number;
};

const MAX_ALLOCATION_ATTEMPTS = 5;

export function nextCommercialQuoteId(used: readonly string[]): string {
  let max = 0;
  for (const id of used) {
    const match = /^CQ-(\d{6})$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  const next = max + 1;
  if (next > 999999) {
    throw new CalibrationConflictError('Commercial identifier space exhausted');
  }
  return `CQ-${String(next).padStart(6, '0')}`;
}

export async function recordCommercialObservation(
  archive: CommercialArchive,
  input: unknown,
  clock: () => string = () => new Date().toISOString(),
): Promise<CommercialRecordResult> {
  const quote = validateCommercialQuote(input);
  const occupied = new Set<string>();
  let allocation = 0;
  while (allocation < MAX_ALLOCATION_ATTEMPTS) {
    const index = await archive.readIndex();
    const existingId = index.source_keys[quote.source.source_case_key];
    if (existingId) return sameObservation(archive, existingId, quote);
    assertOpportunityChain(index, quote);
    const quoteId = nextCommercialQuoteId([
      ...Object.values(index.source_keys),
      ...Object.values(index.opportunities).flatMap((item) => item.quote_ids),
      ...occupied,
    ]);
    const current = index.opportunities[quote.source.opportunity_key];
    const document: StoredCommercialQuote = {
      schema_version: quote.schema_version,
      quote_id: quoteId,
      revision: current ? current.quote_ids.length + 1 : 1,
      recorded_at: clock(),
      source: quote.source,
      vehicle: quote.vehicle,
      service: quote.service,
      colors: quote.colors,
      work_scope: quote.work_scope,
      prices: quote.prices,
      status: quote.status,
    };
    try {
      const result = await archive.insert(document);
      if (result.status === 'partial') {
        const recovered = await archive.reconcile(result.quoteId);
        if (recovered.status === 'partial') {
          throw new CalibrationWriteError('Index update requires reconciliation');
        }
        return resultOf(
          recovered.status === 'already_exists' ? 'already_exists' : 'reconciled',
          result.quoteId,
          quote,
          await archive.readIndex(),
          document.revision,
        );
      }
      if (result.status === 'already_exists') return sameObservation(archive, result.quoteId, quote);
      return resultOf('created', result.quoteId, quote, await archive.readIndex(), document.revision);
    } catch (err) {
      if (err instanceof CalibrationConflictError && (
        err.message === 'Quote file already exists' || err.message === 'Quote ID already assigned'
      )) {
        const stored = await archive.readQuote(quoteId);
        if (stored && commercialObservationFingerprint(stored) === commercialObservationFingerprint(quote)) {
          const recovered = await archive.reconcile(quoteId);
          if (recovered.status === 'partial') throw err;
          return resultOf(
            recovered.status === 'already_exists' ? 'already_exists' : 'reconciled',
            quoteId,
            quote,
            await archive.readIndex(),
            document.revision,
          );
        }
        occupied.add(quoteId);
        allocation += 1;
        continue;
      }
      throw err;
    }
  }
  throw new CalibrationConflictError('Concurrent quote allocation was not resolved');
}

function assertOpportunityChain(index: CommercialIndex, quote: ValidatedCommercialQuote): void {
  const key = quote.source.opportunity_key;
  const prior = quote.source.prior_quote_id;
  const current = index.opportunities[key];
  const owner = prior ? opportunityOf(index, prior) : null;
  if (prior && !owner) throw new CalibrationConflictError('The previous observation does not exist');
  if (prior && owner !== key) {
    throw new CalibrationConflictError('The previous observation belongs to another opportunity');
  }
  if (!current) {
    if (prior) throw new CalibrationConflictError('The previous observation does not exist');
    return;
  }
  if (prior !== current.head_quote_id) {
    throw new CalibrationConflictError(
      prior
        ? 'A revision must extend the latest observation'
        : 'An opportunity revision must name its previous observation',
    );
  }
}

function opportunityOf(index: CommercialIndex, quoteId: string): string | null {
  for (const [key, item] of Object.entries(index.opportunities)) {
    if (item.quote_ids.includes(quoteId)) return key;
  }
  return null;
}

async function sameObservation(
  archive: CommercialArchive,
  quoteId: string,
  quote: ValidatedCommercialQuote,
): Promise<CommercialRecordResult> {
  const stored = await archive.readQuote(quoteId);
  if (!stored || commercialObservationFingerprint(stored) !== commercialObservationFingerprint(quote)) {
    throw new CalibrationConflictError('Source key already records a different observation');
  }
  const revision = typeof stored.revision === 'number' ? stored.revision : 0;
  return resultOf('already_exists', quoteId, quote, await archive.readIndex(), revision);
}

function resultOf(
  status: CommercialRecordResult['status'],
  quoteId: string,
  quote: ValidatedCommercialQuote,
  index: CommercialIndex,
  revision: number,
): CommercialRecordResult {
  const counts = commercialCounts(index);
  return {
    status,
    quoteId,
    opportunityKey: quote.source.opportunity_key,
    revision,
    opportunityCount: counts.opportunityCount,
    quoteCount: counts.quoteCount,
  };
}
