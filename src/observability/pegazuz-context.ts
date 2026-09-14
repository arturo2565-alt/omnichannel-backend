import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'node:crypto';

export type TurnSummary = {
  mode?: string;
  vehicle?: string;
  vehicleConfirmed?: boolean;
  market?: string;
  quoteTotal?: number;
  partial?: boolean;
  outbound?: string;
  channel?: string;
  inboundType?: string;
  visionMs?: number;
  marketMs?: number;
  llmMs?: number;
  ux?: {
    mode?: string;
    delta?: number;
    greet?: boolean;
    technical?: boolean;
    warnings?: number;
    cta?: string;
  };
};

export type PegazuzContext = {
  conversationId?: string;
  turnId?: string;
  quoteId?: string;
  vehicleId?: string;
  visionRunId?: string;
  searchRunId?: string;
  draftQuoteId?: string;
  peritajeId?: string;
  caseId?: string;
  quoteFlowModeLogged?: boolean;
  visionInputLogged?: boolean;
  treatmentLogged?: boolean;
  turnSummary?: TurnSummary;
};

const als = new AsyncLocalStorage<PegazuzContext>();

const ID_KEYS = [
  'conversationId',
  'turnId',
  'quoteId',
  'vehicleId',
  'visionRunId',
  'searchRunId',
  'draftQuoteId',
  'peritajeId',
  'caseId',
] as const;

function compactIds(ids: PegazuzContext): PegazuzContext {
  const out: PegazuzContext = {};
  for (const key of ID_KEYS) {
    const value = String(ids[key] ?? '').trim();
    if (value) out[key] = value;
  }
  return out;
}

function mergeTraceContext(
  parent: PegazuzContext | undefined,
  next: PegazuzContext,
): PegazuzContext {
  const turnSummary = parent?.turnSummary ?? next.turnSummary ?? {};
  if (next.turnSummary && next.turnSummary !== turnSummary) {
    Object.assign(turnSummary, next.turnSummary);
    if (next.turnSummary.ux) {
      turnSummary.ux = { ...turnSummary.ux, ...next.turnSummary.ux };
    }
  }
  return {
    ...parent,
    ...compactIds({
      conversationId: next.conversationId ?? parent?.conversationId,
      turnId: next.turnId ?? parent?.turnId,
      quoteId: next.quoteId ?? parent?.quoteId ?? parent?.draftQuoteId,
      vehicleId: next.vehicleId ?? parent?.vehicleId,
      visionRunId: next.visionRunId ?? parent?.visionRunId,
      searchRunId: next.searchRunId ?? parent?.searchRunId,
      draftQuoteId: next.draftQuoteId ?? parent?.draftQuoteId,
      peritajeId: next.peritajeId ?? parent?.peritajeId,
      caseId: next.caseId ?? parent?.caseId,
    }),
    quoteFlowModeLogged:
      next.quoteFlowModeLogged ?? parent?.quoteFlowModeLogged,
    visionInputLogged: next.visionInputLogged ?? parent?.visionInputLogged,
    treatmentLogged: next.treatmentLogged ?? parent?.treatmentLogged,
    turnSummary,
  };
}

export function getPegazuzContext(): PegazuzContext | undefined {
  return als.getStore();
}

export function hasPegazuzContext(): boolean {
  return als.getStore() != null;
}

export function runWithPegazuzContext<T>(
  ctx: PegazuzContext,
  fn: () => T,
): T {
  const parent = als.getStore();
  return als.run(mergeTraceContext(parent, ctx), fn);
}

export function mergePegazuzContext(patch: PegazuzContext): void {
  const store = als.getStore();
  if (!store) return;
  Object.assign(store, mergeTraceContext(store, patch));
}

export function patchTurnSummary(patch: TurnSummary): void {
  const store = als.getStore();
  if (!store) return;
  if (!store.turnSummary) store.turnSummary = {};
  const ux = patch.ux
    ? { ...store.turnSummary.ux, ...patch.ux }
    : store.turnSummary.ux;
  Object.assign(store.turnSummary, patch);
  if (ux) store.turnSummary.ux = ux;
}

export function createTurnId(): string {
  return `turn_${randomBytes(3).toString('hex')}`;
}

export function shortTurnId(turnId?: string | null): string | undefined {
  const raw = String(turnId ?? '').trim();
  if (!raw) return undefined;
  return raw.replace(/^turn_/, '');
}

export function shortConvId(id?: string | null): string | undefined {
  const raw = String(id ?? '').replace(/-/g, '').trim();
  if (!raw) return undefined;
  return raw.slice(0, 8);
}
