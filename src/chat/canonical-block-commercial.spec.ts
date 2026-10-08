jest.mock('../messaging-queue/incoming-message.producer', () => ({
  IncomingMessageProducer: class IncomingMessageProducer {},
}));
jest.mock('../messaging-queue/outgoing-message.producer', () => ({
  OutgoingMessageProducer: class OutgoingMessageProducer {},
}));

import { QuoteCartService } from './quote-cart.service';
import { ChatService } from './chat.service';
import { canonicalQuoteFromInstantResolution } from './canonical-commercial-quote';
import {
  CANONICAL_BLOCKED_MARKER,
  isCanonicalBlockedState,
} from './canonical-quote-engine';
import { sanitizeToolResultForLlm } from './llm-tool-result-sanitize';
import { canonicalPhysicalPanelKey } from './piece-treatment';
import { peritajeFromLegacyAnalysis } from '../domain/peritaje-v1';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import type { DraftQuote } from './autofix-config';

jest.setTimeout(20000);

const CONV = '11111111-1111-4111-8111-111111111111';

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where ?? {}).every(([key, value]) => {
    if (value && typeof value === 'object' && (value as { _type?: string })._type === 'isNull') {
      return row[key] == null;
    }
    return row[key] === value;
  });
}

function memoryRepo() {
  const rows: any[] = [];
  return {
    rows,
    findOne: jest.fn(async (opts?: { where?: Record<string, unknown> }) => {
      const where = opts?.where ?? {};
      return rows.find((row) => matchesWhere(row, where)) ?? null;
    }),
    find: jest.fn(async () => [...rows]),
    create: jest.fn((row: any) => ({ items: [], ...row })),
    save: jest.fn(async (row: any) => {
      if (!row.id) row.id = `row-${rows.length + 1}`;
      const idx = rows.findIndex((stored) => stored.id === row.id);
      if (idx >= 0) rows[idx] = row;
      else rows.push(row);
      return row;
    }),
    insert: jest.fn(async () => undefined),
    update: jest.fn(async () => ({ affected: 1 })),
    delete: jest.fn(async () => ({ affected: 1 })),
    createQueryBuilder: jest.fn(() => {
      const qb: any = {
        where: () => qb,
        andWhere: () => qb,
        orderBy: () => qb,
        getOne: async () => null,
      };
      return qb;
    }),
  };
}

function pricingSnap(): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: () => 4500,
    getAmount: () => 4500,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DL', 'DM'],
    serviciosOrderedLongestFirst: ['Fascia'],
  } as MatrixPricingSnapshot;
}

function damageItem(
  pieza: string,
): DetectedDamageItem {
  return {
    pieza,
    severidad: 'DM',
    descripcionTecnica: 'golpe',
    urls_origen: ['https://cdn.example/a.jpg'],
    tratamiento: 'REPARAR',
    treatmentSource: 'vision',
    vehiculoDetectado: 'Mazda 3 2020',
  };
}

function peritajeFor(items: DetectedDamageItem[]) {
  return peritajeFromLegacyAnalysis({
    conversationId: CONV,
    tallerId: 't1',
    peritajeId: 'per-block',
    now: '2026-10-07T00:00:00.000Z',
    canonicalizePanel: canonicalPhysicalPanelKey,
    analysis: {
      vehiculoDetectado: 'Mazda 3 2020',
      inventory: items,
    },
  });
}

function payload(overrides: Partial<DraftQuote> = {}): DraftQuote {
  return {
    status: 'PENDING_APPROVAL',
    currency: 'MXN',
    reference: 'COT-BLOCK',
    generatedAt: '2026-10-07T00:00:00.000Z',
    lines: [
      {
        description: 'Fascia',
        quantity: 1,
        unitPrice: 4500,
        subtotal: 4500,
      } as DraftQuote['lines'][number],
    ],
    subtotal: 4500,
    total: 4500,
    formalNarrative: 'Total histórico $4500',
    clientMessage: 'Total histórico $4500',
    generatedMessage: 'Total histórico $4500',
    quoteFlowMode: 'CANONICAL',
    analysisBasis: {
      pieza: 'Fascia',
      severidad: 'DM',
      partesAfectadas: ['Fascia'],
      severidadDelDano: 'DM',
      descripcionTecnica: 'golpe',
      justificacion: 'histórico',
    },
    ...overrides,
  };
}

function analysis() {
  return {
    pieza: 'Fascia',
    severidad: 'DM',
    descripcionTecnica: 'golpe',
    justificacion: 'histórico',
    partesAfectadas: ['Fascia'],
    severidadDelDano: 'DM',
    inventory: [] as DetectedDamageItem[],
  };
}

describe('bloqueo canónico en servicios reales', () => {
  const gateway = {
    emitDraftQuoteReady: jest.fn(),
    emitNewMessage: jest.fn(),
    server: { emit: jest.fn() },
  };
  const leadLog = jest.fn();
  const draftRepo = memoryRepo();
  const itemRepo = memoryRepo();
  const conversationRepo = memoryRepo();
  const messageRepo = memoryRepo();
  const catalog = {
    getMatrixPricingSnapshot: jest.fn(async () => pricingSnap()),
    getPricingRules: jest.fn(async () => null),
  };
  const quoteCart = new QuoteCartService(
    draftRepo as any,
    itemRepo as any,
    catalog as any,
    gateway as any,
  );
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  const chat = new ChatService(
    messageRepo as any,
    conversationRepo as any,
    {} as any,
    draftRepo as any,
    itemRepo as any,
    {} as any,
    gateway as any,
    {} as any,
    catalog as any,
    {} as any,
    { findDefaultTallerId: async () => 't1' } as any,
    {} as any,
    quoteCart,
    {} as any,
    { enqueueOutboundMessage: async () => undefined } as any,
    { logTransition: leadLog } as any,
  );
  process.env.OPENAI_API_KEY = previousKey;

  const historical = canonicalQuoteFromInstantResolution(
    { lines: [{ label: 'Fascia', amount: 4500 }] },
    { conversationId: CONV, vehicleLabel: 'Mazda 3 2020' },
  );

  function seedConversation() {
    const conversation = {
      id: CONV,
      tallerId: 't1',
      platform: 'test',
      status: 'nuevo',
      externalId: 'ext-1',
      contactName: 'Ana',
      isAutoPilotActive: true,
    };
    conversationRepo.rows.splice(0, conversationRepo.rows.length, conversation);
    return conversation;
  }

  function seedBlockedCart() {
    const cart = {
      id: 'draft-1',
      conversationId: CONV,
      tallerId: 't1',
      status: 'PENDING_APPROVAL',
      messageId: 'msg-1',
      imageUrl: '[]',
      estimateAmount: 4500,
      canonicalQuoteV1: historical,
      canonicalPeritajeV1: null,
      damageAnalysis: analysis(),
      items: [],
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      quotePayload: payload({
        canonicalReconstruction: 'blocked',
        shownWarnings: [CANONICAL_BLOCKED_MARKER],
        sendCount: 2,
      }),
    };
    draftRepo.rows.splice(0, draftRepo.rows.length, cart);
    return cart;
  }

  beforeEach(() => {
    gateway.emitDraftQuoteReady.mockClear();
    gateway.emitNewMessage.mockClear();
    leadLog.mockClear();
    draftRepo.findOne.mockClear();
    draftRepo.save.mockClear();
    messageRepo.rows.splice(0, messageRepo.rows.length);
  });

  it('no autoriza snapshot ni cotizado con historial bloqueado, y sí sin carrito o legacy', async () => {
    const cart = seedBlockedCart();
    const conversation = seedConversation();
    await chat.saveMessage({
      direction: 'outbound',
      conversationId: CONV,
      message: 'Sigo con tu solicitud.',
      conversationLeadStatus: 'cotizado',
      tallerId: 't1',
      platform: 'test',
      user: 'Asistente IA',
    });
    expect(conversation.status).toBe('nuevo');
    expect(leadLog).not.toHaveBeenCalled();
    expect(cart.quotePayload.sendCount).toBe(2);
    expect(cart.quotePayload.lastSendSnapshot).toBeUndefined();
    expect(cart.canonicalQuoteV1).toBe(historical);

    draftRepo.rows.splice(0, draftRepo.rows.length);
    conversation.status = 'nuevo';
    await chat.saveMessage({
      direction: 'outbound',
      conversationId: CONV,
      message: 'Seguimos en contacto.',
      conversationLeadStatus: 'cotizado',
      tallerId: 't1',
      platform: 'test',
      user: 'Asistente IA',
    });
    expect(conversation.status).toBe('cotizado');
    expect(leadLog).toHaveBeenCalledWith(CONV, 'cotizado', { total: 0 });

    const legacy = seedBlockedCart();
    legacy.quotePayload = payload({
      quoteFlowMode: 'LEGACY',
      sendCount: 0,
      formalNarrative: 'Total legacy $1800',
      clientMessage: 'Total legacy $1800',
    });
    legacy.canonicalQuoteV1 = null;
    legacy.estimateAmount = 1800;
    conversation.status = 'nuevo';
    leadLog.mockClear();
    await chat.saveMessage({
      direction: 'outbound',
      conversationId: CONV,
      message: 'Total legacy $1800',
      conversationLeadStatus: 'cotizado',
      tallerId: 't1',
      platform: 'test',
      user: 'Asistente IA',
    });
    expect(conversation.status).toBe('cotizado');
    expect(legacy.quotePayload.sendCount).toBe(1);
    expect(legacy.quotePayload.lastSendSnapshot?.total).toBe(1800);
    expect(leadLog).toHaveBeenCalledWith(CONV, 'cotizado', { total: 1800 });
  });

  it('un error de lectura no autoriza la operación comercial', async () => {
    const cart = seedBlockedCart();
    const conversation = seedConversation();
    draftRepo.findOne.mockRejectedValueOnce(new Error('read failed'));
    await expect(
      quoteCart.readCommercialAuthorization(CONV, 't1'),
    ).resolves.toBe('unreadable');
    draftRepo.findOne.mockRejectedValueOnce(new Error('read failed'));
    await quoteCart.recordQuoteSendSnapshot(CONV, 't1');
    expect(cart.quotePayload.sendCount).toBe(2);

    draftRepo.findOne.mockRejectedValueOnce(new Error('read failed'));
    await chat.saveMessage({
      direction: 'outbound',
      conversationId: CONV,
      message: 'No pude verificar la cotización.',
      conversationLeadStatus: 'cotizado',
      tallerId: 't1',
      platform: 'test',
      user: 'Asistente IA',
    });
    expect(conversation.status).toBe('nuevo');
    expect(leadLog).not.toHaveBeenCalled();
    expect(cart.quotePayload.sendCount).toBe(2);
  });

  it('el autopilot no pasa a cotizado mientras el carrito sigue bloqueado', async () => {
    const cart = seedBlockedCart();
    const conversation = seedConversation();
    jest.spyOn(chat as any, 'composeAutopilotReplyWithTools').mockResolvedValue({
      text: 'La cotización histórica sigue en 4500',
      markQuoted: true,
    });
    await (chat as any).autoPilotSendTextReply(
      { content: '¿ya quedó?', channelType: 'test', tallerId: 't1' },
      conversation,
    );
    expect(conversation.status).toBe('nuevo');
    expect(leadLog).not.toHaveBeenCalled();
    expect(cart.quotePayload.sendCount).toBe(2);
    expect(cart.quotePayload.lastSendSnapshot).toBeUndefined();
    expect(cart.canonicalQuoteV1).toBe(historical);
  });

  it('confirmVehicleIdentity no reutiliza la cotización histórica bloqueada', async () => {
    const cart = seedBlockedCart();
    const conversation = seedConversation();
    const result = await (chat as any).executeConfirmVehicleIdentityTool(
      JSON.stringify({ make: 'Mazda', model: '3', year: '2020' }),
      conversation,
    );
    expect(result.quoteUpdated).toBe(false);
    expect(result.resumed).toBeUndefined();
    expect(result.canonicalBlocked).toBe(true);
    expect(cart.canonicalQuoteV1).toBe(historical);
    expect(cart.quotePayload.sendCount).toBe(2);
    expect(conversation.status).toBe('nuevo');
    expect(leadLog).not.toHaveBeenCalled();
  });

  it('carrito y preview no presentan el historial como cotización vigente', async () => {
    const cart = seedBlockedCart();
    const detail = await quoteCart.getConversationCartDetail(CONV, 't1');
    expect(detail.financeCommunication).toBe('blocked');
    expect(detail.totalGlobal).toBeNull();
    expect(detail.approvedEstimateAmount).toBeNull();
    expect(detail.authorizedQuote).toBeNull();
    expect(detail.desglose).toEqual([]);
    const active = detail.activeDraft as {
      canonicalQuoteV1: unknown;
      estimateAmount: unknown;
      quotePayload: DraftQuote;
    };
    expect(active.canonicalQuoteV1).toBeNull();
    expect(active.estimateAmount).toBeNull();
    expect(active.quotePayload.clientMessage).toBe('');
    expect(active.quotePayload.formalNarrative).toBe('');
    const history = detail.history as {
      canonicalQuoteV1: { quoteId: string };
      clientMessage: string;
      estimateAmount: number;
    };
    expect(history.canonicalQuoteV1.quoteId).toBe(historical.quoteId);
    expect(history.clientMessage).toContain('4500');
    expect(history.estimateAmount).toBe(4500);
    expect(detail.damageAnalysis ?? active).toBeTruthy();
    expect(cart.quotePayload.clientMessage).toContain('4500');

    const envelope = await quoteCart.getCartSummaryEnvelope(CONV, 't1');
    expect(envelope.success).toBe(false);
    expect(envelope.canonicalBlocked).toBe(true);
    expect(envelope.requiresCanonicalComposition).toBe(false);
    expect(envelope.totalGlobal).toBeUndefined();
    const exposed = sanitizeToolResultForLlm(envelope, {
      toolName: 'obtenerCarritoActual',
    });
    expect(exposed.success).toBe(false);
    expect(exposed.canonicalQuoteV1).toBeUndefined();
    expect(JSON.stringify(exposed)).not.toMatch(/4500/);

    const preview = await chat.previewDraftQuoteClientNarrative(
      { conversationId: CONV, pieces: [] },
      't1',
    );
    expect(preview).toContain('todavía no tiene una cotización confirmada');
    expect(preview).not.toMatch(/4500|\$/);
  });

  it('una reconstrucción fallida conserva el historial y una posterior válida lo libera', async () => {
    const cart = seedBlockedCart();
    cart.canonicalPeritajeV1 = peritajeFor([damageItem('REFACCION')]);
    await (quoteCart as any).rebuildAndPersist(
      cart,
      [damageItem('REFACCION')],
      't1',
    );
    expect(isCanonicalBlockedState(cart.quotePayload)).toBe(true);
    expect(cart.canonicalQuoteV1).toBe(historical);
    expect(cart.estimateAmount).toBe(4500);
    expect(gateway.emitDraftQuoteReady).not.toHaveBeenCalled();

    cart.canonicalPeritajeV1 = peritajeFor([damageItem('FD')]);
    const recovered = await (quoteCart as any).rebuildAndPersist(
      cart,
      [damageItem('FD')],
      't1',
    );
    expect(isCanonicalBlockedState(recovered.quotePayload)).toBe(false);
    expect(recovered.canonicalQuoteV1?.total).toBeGreaterThan(0);
    expect(recovered.canonicalQuoteV1).not.toBe(historical);
    expect(gateway.emitDraftQuoteReady).toHaveBeenCalledTimes(1);
    expect(historical.total).toBe(4500);

    await quoteCart.recordQuoteSendSnapshot(CONV, 't1', {
      formalNarrative: 'Cotización recuperada',
    });
    expect(recovered.quotePayload.sendCount).toBe(3);
    expect(recovered.quotePayload.lastSendSnapshot?.total).toBe(
      recovered.canonicalQuoteV1.total,
    );
  });

  it('no elimina el bloqueo si la persistencia de la cotización válida falla', async () => {
    const cart = seedBlockedCart();
    draftRepo.save.mockRejectedValueOnce(new Error('persist failed'));
    await expect(
      quoteCart.persistVisionQuote({
        conversationId: CONV,
        tallerId: 't1',
        messageId: 'msg-2',
        analysis: analysis(),
        draftQuoteDoc: cart.quotePayload,
        estimateAmount: historical.total,
        allImageUrls: [],
        existingCart: cart as any,
        canonicalQuoteV1: historical,
      }),
    ).rejects.toThrow('persist failed');
    expect(cart.quotePayload.canonicalReconstruction).toBe('blocked');
    expect(cart.canonicalQuoteV1).toBe(historical);
    expect(cart.estimateAmount).toBe(4500);
    expect(cart.quotePayload.clientMessage).toContain('4500');
    expect(gateway.emitDraftQuoteReady).not.toHaveBeenCalled();
    expect(cart.quotePayload.sendCount).toBe(2);

    draftRepo.save.mockReset();
    draftRepo.save.mockImplementation(async (row: any) => {
      if (!row.id) row.id = `row-${draftRepo.rows.length + 1}`;
      const idx = draftRepo.rows.findIndex((stored) => stored.id === row.id);
      if (idx >= 0) draftRepo.rows[idx] = row;
      else draftRepo.rows.push(row);
      return row;
    });
    const invalid = { ...historical, total: 1, subtotal: 50 };
    await expect(
      quoteCart.persistVisionQuote({
        conversationId: CONV,
        tallerId: 't1',
        messageId: 'msg-4',
        analysis: analysis(),
        draftQuoteDoc: cart.quotePayload,
        estimateAmount: 1,
        allImageUrls: [],
        existingCart: cart as any,
        canonicalQuoteV1: invalid,
      }),
    ).rejects.toThrow('CANONICAL_RECONSTRUCTION_NOT_ELIGIBLE');
    expect(cart.canonicalQuoteV1).toBe(historical);
    expect(cart.quotePayload.canonicalReconstruction).toBe('blocked');
    expect(cart.estimateAmount).toBe(4500);
    expect(gateway.emitDraftQuoteReady).not.toHaveBeenCalled();
  });

  it('una cotización parcial o legacy no se trata como bloqueo', async () => {
    const partial = seedBlockedCart();
    partial.quotePayload = payload({
      quoteFlowMode: 'CANONICAL',
      pricingIncomplete: true,
      total: 3200,
      subtotal: 3200,
    });
    partial.estimateAmount = 3200;
    partial.canonicalQuoteV1 = {
      ...historical,
      isPartial: true,
      total: 3200,
      subtotal: 3200,
    };
    const envelope = await quoteCart.getCartSummaryEnvelope(CONV, 't1');
    expect(envelope.canonicalBlocked).toBeUndefined();
    expect(envelope.totalGlobal).toBe(3200);
    const detail = await quoteCart.getConversationCartDetail(CONV, 't1');
    expect(detail.financeCommunication).toBe('authorized');
    expect(
      (detail.activeDraft as { canonicalQuoteV1: { total: number } }).canonicalQuoteV1
        .total,
    ).toBe(3200);

    partial.quotePayload = payload({ quoteFlowMode: 'LEGACY', total: 1800 });
    partial.canonicalQuoteV1 = null;
    partial.estimateAmount = 1800;
    const legacyDetail = await quoteCart.getConversationCartDetail(CONV, 't1');
    expect(legacyDetail.financeCommunication).toBe('legacy');
    expect(legacyDetail.totalGlobal).toBe(1800);
  });

  it('persistir evidencia bloqueada no emite ni sustituye la cotización histórica', async () => {
    const cart = seedBlockedCart();
    await quoteCart.persistCanonicalBlockedVision({
      conversationId: CONV,
      tallerId: 't1',
      messageId: 'msg-3',
      analysis: analysis(),
      allImageUrls: ['https://cdn.example/nueva.jpg'],
      existingCart: cart as any,
      blockedDraft: payload({ canonicalReconstruction: 'blocked' }),
    });
    expect(cart.canonicalQuoteV1).toBe(historical);
    expect(cart.estimateAmount).toBe(4500);
    expect(isCanonicalBlockedState(cart.quotePayload)).toBe(true);
    expect(gateway.emitDraftQuoteReady).not.toHaveBeenCalled();
  });
});
