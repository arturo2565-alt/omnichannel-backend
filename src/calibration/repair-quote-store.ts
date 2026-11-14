import {
  CalibrationConflictError,
  CalibrationWriteError,
} from './calibration-github-writer';
import {
  repairCounts,
  type RepairArchive,
  type RepairIndex,
} from './repair-quote-writer';
import {
  repairObservationFingerprint,
  validateRepairQuote,
  type StoredRepairQuote,
  type ValidatedRepairQuote,
} from './repair-quote';

/**
 * Registra una observación de reparación textual. La misma clave no se
 * sobrescribe. Una revisión autorizada es otra observación de la misma
 * oportunidad. No asigna identificadores AF ni CQ.
 */
export type RepairRecordResult = {
  status: 'created' | 'already_exists' | 'reconciled';
  quoteId: string;
  opportunityKey: string;
  revision: number;
  opportunityCount: number;
  quoteCount: number;
};

const MAX_ALLOCATION_ATTEMPTS = 5;

export function nextRepairQuoteId(used: readonly string[]): string {
  let max = 0;
  for (const id of used) {
    const match = /^RQ-(\d{6})$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  const next = max + 1;
  if (next > 999999) {
    throw new CalibrationConflictError('Repair identifier space exhausted');
  }
  return `RQ-${String(next).padStart(6, '0')}`;
}

export async function recordRepairObservation(
  archive: RepairArchive,
  input: unknown,
  clock: () => string = () => new Date().toISOString(),
): Promise<RepairRecordResult> {
  const quote = validateRepairQuote(input);
  const occupied = new Set<string>();
  let allocation = 0;
  while (allocation < MAX_ALLOCATION_ATTEMPTS) {
    const index = await archive.readIndex();
    const existingId = index.source_keys[quote.source.source_case_key];
    if (existingId) return sameObservation(archive, existingId, quote);
    assertOpportunityChain(index, quote);
    const quoteId = nextRepairQuoteId([
      ...Object.values(index.source_keys),
      ...Object.values(index.opportunities).flatMap((item) => item.quote_ids),
      ...occupied,
    ]);
    const current = index.opportunities[quote.source.opportunity_key];
    const document: StoredRepairQuote = {
      schema_version: quote.schema_version,
      quote_id: quoteId,
      revision: current ? current.quote_ids.length + 1 : 1,
      recorded_at: clock(),
      evidence: quote.evidence,
      photo_status: quote.photo_status,
      source: quote.source,
      vehicle: quote.vehicle,
      lines: quote.lines,
      quoted_total_mxn: quote.quoted_total_mxn,
      conditions: quote.conditions,
      status: quote.status,
    };
    try {
      const result = await archive.insert(document);
      if (result.status === 'partial') {
        const recovered = await archive.reconcile(result.quoteId);
        if (recovered.status === 'partial') {
          throw new CalibrationWriteError(
            'Index update requires reconciliation',
          );
        }
        return resultOf(
          recovered.status === 'already_exists'
            ? 'already_exists'
            : 'reconciled',
          result.quoteId,
          quote,
          await archive.readIndex(),
          document.revision,
        );
      }
      if (result.status === 'already_exists')
        return sameObservation(archive, result.quoteId, quote);
      return resultOf(
        'created',
        result.quoteId,
        quote,
        await archive.readIndex(),
        document.revision,
      );
    } catch (err) {
      if (
        err instanceof CalibrationConflictError &&
        (err.message === 'Quote file already exists' ||
          err.message === 'Quote ID already assigned')
      ) {
        const stored = await archive.readQuote(quoteId);
        if (
          stored &&
          repairObservationFingerprint(stored) ===
            repairObservationFingerprint(quote)
        ) {
          const recovered = await archive.reconcile(quoteId);
          if (recovered.status === 'partial') throw err;
          return resultOf(
            recovered.status === 'already_exists'
              ? 'already_exists'
              : 'reconciled',
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
  throw new CalibrationConflictError(
    'Concurrent quote allocation was not resolved',
  );
}

function assertOpportunityChain(
  index: RepairIndex,
  quote: ValidatedRepairQuote,
): void {
  const key = quote.source.opportunity_key;
  const prior = quote.source.prior_quote_id;
  const current = index.opportunities[key];
  const owner = prior ? opportunityOf(index, prior) : null;
  if (prior && !owner)
    throw new CalibrationConflictError(
      'The previous observation does not exist',
    );
  if (prior && owner !== key) {
    throw new CalibrationConflictError(
      'The previous observation belongs to another opportunity',
    );
  }
  if (!current) {
    if (prior)
      throw new CalibrationConflictError(
        'The previous observation does not exist',
      );
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

function opportunityOf(index: RepairIndex, quoteId: string): string | null {
  for (const [key, item] of Object.entries(index.opportunities)) {
    if (item.quote_ids.includes(quoteId)) return key;
  }
  return null;
}

async function sameObservation(
  archive: RepairArchive,
  quoteId: string,
  quote: ValidatedRepairQuote,
): Promise<RepairRecordResult> {
  const stored = await archive.readQuote(quoteId);
  if (
    !stored ||
    repairObservationFingerprint(stored) !== repairObservationFingerprint(quote)
  ) {
    throw new CalibrationConflictError(
      'Source key already records a different observation',
    );
  }
  const revision = typeof stored.revision === 'number' ? stored.revision : 0;
  return resultOf(
    'already_exists',
    quoteId,
    quote,
    await archive.readIndex(),
    revision,
  );
}

function resultOf(
  status: RepairRecordResult['status'],
  quoteId: string,
  quote: ValidatedRepairQuote,
  index: RepairIndex,
  revision: number,
): RepairRecordResult {
  const counts = repairCounts(index);
  return {
    status,
    quoteId,
    opportunityKey: quote.source.opportunity_key,
    revision,
    opportunityCount: counts.opportunityCount,
    quoteCount: counts.quoteCount,
  };
}
