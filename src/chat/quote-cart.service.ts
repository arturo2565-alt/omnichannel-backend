import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { DraftQuote } from './autofix-config';
import { coerceDamageLevelCode } from './autofix-config';
import {
  buildCotizacionToolEnvelope,
} from './cotizacion-tool-envelope';
import {
  inventoryItemsToVehicleAnalysis,
  mapPanelInventoryLinesToItems,
  mergeCartInventoryItem,
  mergeVisionIntoPriorInventory,
  parseDraftImageUrls,
  persistDraftImageUrlField,
  piezaMatchesQuery,
  extractPriorInventoryFromDraft,
  type VisionInventoryMergeResult,
} from './quote-cart-analysis';
import type { PatchCartInventoryLineDto } from './quote-cart.types';
import type { DetectedDamageItem, VehicleDamageAnalysis } from './entities/chat.entity';
import { DraftQuoteEntity } from './entities/draft-quote.entity';
import { DraftQuoteItem } from './entities/draft-quote-item.entity';
import { CatalogService } from '../catalog/catalog.service';
import {
  findPanelPiezaOption,
  isSpecialPanelPieza,
  normalizePanelPiezaCode,
  resolveCatalogPiezaForMatrixLookup,
} from '../catalog/panel-pieza-catalog';
import {
  buildDraftQuoteLineFromQuoteRow,
  sumQuoteRowsSubtotal,
  type QuoteRowInput,
} from './draft-quote-inventory-pricing';
import type { ObtenerCotizacionExpressResult } from './autopilot-cotizacion-express';
import { ChatGateway } from './chat.gateway';
import { buildAggregatedCartViewFromEntities } from './quote-cart-aggregate';

const ACTIVE_CART_STATUS = 'PENDING_APPROVAL';
const APPROVED_CART_STATUS = 'APPROVED';

function emptyPayloadFallback(): DraftQuote {
  return {
    status: 'PENDING_APPROVAL',
    currency: 'MXN',
    reference: '',
    generatedAt: new Date().toISOString(),
    lines: [],
    subtotal: 0,
    total: 0,
    formalNarrative: '',
    analysisBasis: {
      pieza: 'Sin piezas',
      severidad: 'DL',
      partesAfectadas: [],
      severidadDelDano: 'DL',
      descripcionTecnica: '',
      justificacion: '',
    },
  };
}

@Injectable()
export class QuoteCartService {
  private readonly logger = new Logger(QuoteCartService.name);

  constructor(
    @InjectRepository(DraftQuoteEntity)
    private readonly draftQuoteRepository: Repository<DraftQuoteEntity>,
    @InjectRepository(DraftQuoteItem)
    private readonly draftQuoteItemRepository: Repository<DraftQuoteItem>,
    private readonly catalogService: CatalogService,
    private readonly chatGateway: ChatGateway,
  ) {}

  async getActiveCart(
    conversationId: string,
    tallerId?: string | null,
  ): Promise<DraftQuoteEntity | null> {
    return this.draftQuoteRepository.findOne({
      where: {
        conversationId,
        status: ACTIVE_CART_STATUS,
        tallerId: tallerId ?? IsNull(),
      },
      order: { createdAt: 'DESC' },
      relations: { items: true },
    });
  }

  async getOrCreateActiveCart(
    conversationId: string,
    tallerId?: string | null,
  ): Promise<DraftQuoteEntity> {
    const existing = await this.getActiveCart(conversationId, tallerId);
    if (existing) {
      existing.items?.sort((a, b) => a.sortOrder - b.sortOrder);
      return existing;
    }

    const emptyAnalysis = inventoryItemsToVehicleAnalysis([], []);
    emptyAnalysis.quoteCartMeta = { cartRole: 'primary' };
    const emptyPayload = emptyPayloadFallback();
    const row = this.draftQuoteRepository.create({
      conversationId,
      tallerId: tallerId ?? null,
      messageId: null,
      imageUrl: '[]',
      damageAnalysis: emptyAnalysis,
      estimateAmount: 0,
      quotePayload: emptyPayload,
      status: ACTIVE_CART_STATUS,
    });
    return this.draftQuoteRepository.save(row);
  }

  /** Carrito editable: PENDING activo, o complemento nuevo si ya hay cotización aprobada. */
  async resolveMutableCart(
    conversationId: string,
    tallerId?: string | null,
  ): Promise<DraftQuoteEntity> {
    const pending = await this.getActiveCart(conversationId, tallerId);
    if (pending) {
      pending.items?.sort((a, b) => a.sortOrder - b.sortOrder);
      return pending;
    }

    const approvedParent = await this.getLatestApprovedCart(
      conversationId,
      tallerId,
    );
    if (approvedParent) {
      return this.createComplementCart(conversationId, tallerId, approvedParent);
    }

    return this.getOrCreateActiveCart(conversationId, tallerId);
  }

  async getLatestApprovedCart(
    conversationId: string,
    tallerId?: string | null,
  ): Promise<DraftQuoteEntity | null> {
    return this.draftQuoteRepository.findOne({
      where: {
        conversationId,
        status: APPROVED_CART_STATUS,
        tallerId: tallerId ?? IsNull(),
      },
      order: { createdAt: 'DESC' },
      relations: { items: true },
    });
  }

  private async loadApprovedCarts(
    conversationId: string,
    tallerId?: string | null,
  ): Promise<DraftQuoteEntity[]> {
    const rows = await this.draftQuoteRepository.find({
      where: {
        conversationId,
        status: APPROVED_CART_STATUS,
        tallerId: tallerId ?? IsNull(),
      },
      order: { createdAt: 'ASC' },
      relations: { items: true },
    });
    for (const r of rows) {
      r.items?.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return rows;
  }

  private async createComplementCart(
    conversationId: string,
    tallerId: string | null | undefined,
    approvedParent: DraftQuoteEntity,
  ): Promise<DraftQuoteEntity> {
    const parentUrls = parseDraftImageUrls(approvedParent.imageUrl ?? '');
    const analysis = inventoryItemsToVehicleAnalysis([], parentUrls);
    analysis.quoteCartMeta = {
      cartRole: 'complement',
      complementOfDraftId: approvedParent.id,
    };
    const vehiculo =
      approvedParent.damageAnalysis?.vehiculoDetectado ??
      approvedParent.quotePayload?.analysisBasis?.pieza;
    if (vehiculo?.trim()) {
      analysis.vehiculoDetectado = vehiculo.trim();
    }

    const row = this.draftQuoteRepository.create({
      conversationId,
      tallerId: tallerId ?? null,
      messageId: approvedParent.messageId,
      imageUrl: approvedParent.imageUrl || '[]',
      damageAnalysis: analysis,
      estimateAmount: 0,
      quotePayload: {
        ...emptyPayloadFallback(),
        reference: approvedParent.quotePayload?.reference ?? '',
      },
      status: ACTIVE_CART_STATUS,
    });
    const saved = await this.draftQuoteRepository.save(row);
    this.logger.log(
      `[CARRITO] complemento creado conversation=${conversationId} parent=${approvedParent.id}`,
    );
    return saved;
  }

  async getConversationCartDetail(
    conversationId: string,
    tallerId: string,
  ): Promise<Record<string, unknown>> {
    const pending = await this.getActiveCart(conversationId, tallerId);
    const approved = await this.loadApprovedCarts(conversationId, tallerId);
    const aggregated = this.buildAggregatedCartView(pending, approved);
    return {
      ...aggregated,
      conversationId,
      pendingDraft: pending
        ? {
            id: pending.id,
            status: pending.status,
            estimateAmount: pending.estimateAmount,
            quotePayload: pending.quotePayload,
            damageAnalysis: pending.damageAnalysis,
            items: pending.items ?? [],
            messageId: pending.messageId,
            createdAt: pending.createdAt,
          }
        : null,
      approvedDrafts: approved.map((r) => ({
        id: r.id,
        status: r.status,
        estimateAmount: r.estimateAmount,
        quotePayload: r.quotePayload,
        items: r.items ?? [],
        createdAt: r.createdAt,
      })),
    };
  }

  async getCartSummaryEnvelope(
    conversationId: string,
    tallerId?: string | null,
  ): Promise<Record<string, unknown>> {
    const pending = await this.getActiveCart(conversationId, tallerId);
    const approved = await this.loadApprovedCarts(conversationId, tallerId);
    return this.buildAggregatedCartView(pending, approved);
  }

  async getCartEnvelope(
    conversationId: string,
    tallerId?: string | null,
  ): Promise<Record<string, unknown>> {
    return this.getCartSummaryEnvelope(conversationId, tallerId);
  }

  /**
   * Fase 1.5: acumula fotos nuevas sobre el carrito activo (visión + chat/express previos).
   */
  async mergeVisionInventory(
    conversationId: string,
    tallerId: string | null | undefined,
    newInventory: readonly DetectedDamageItem[],
    burstImageUrls: readonly string[],
  ): Promise<
    VisionInventoryMergeResult & {
      allImageUrls: string[];
      existingCart: DraftQuoteEntity | null;
    }
  > {
    const existingCart = await this.getActiveCart(conversationId, tallerId);
    const priorInventory = extractPriorInventoryFromDraft(existingCart);
    const priorUrls = existingCart
      ? parseDraftImageUrls(existingCart.imageUrl ?? '')
      : [];
    const allImageUrls = [
      ...new Set([
        ...priorUrls,
        ...burstImageUrls.map((u) => String(u).trim()).filter(Boolean),
      ]),
    ];

    const { mergedInventory, complementMeta } = mergeVisionIntoPriorInventory(
      priorInventory,
      newInventory,
    );

    this.logger.log(
      `[CARRITO] mergeVision conversation=${conversationId} prior=${priorInventory.length} new=${newInventory.length} merged=${mergedInventory.length}`,
    );

    return {
      mergedInventory,
      complementMeta,
      allImageUrls,
      existingCart,
    };
  }

  /** Persiste cotización de visión en el carrito activo (create o update). */
  async persistVisionQuote(input: {
    conversationId: string;
    tallerId: string | null;
    messageId: string;
    analysis: VehicleDamageAnalysis;
    draftQuoteDoc: DraftQuote;
    estimateAmount: number;
    allImageUrls: readonly string[];
    existingCart: DraftQuoteEntity | null;
  }): Promise<{ savedDraft: DraftQuoteEntity; priorMessageId: string | null }> {
    const persistedImageUrl = persistDraftImageUrlField(input.allImageUrls);
    const draftQuoteForClient = input.draftQuoteDoc;

    if (input.existingCart) {
      const priorMessageId = input.existingCart.messageId;
      input.existingCart.messageId = input.messageId;
      input.existingCart.imageUrl = persistedImageUrl;
      input.existingCart.damageAnalysis = input.analysis;
      input.existingCart.estimateAmount = input.estimateAmount;
      input.existingCart.quotePayload = draftQuoteForClient;
      input.existingCart.tallerId = input.tallerId;
      input.existingCart.status = ACTIVE_CART_STATUS;
      const savedDraft = await this.draftQuoteRepository.save(input.existingCart);

      this.chatGateway.emitDraftQuoteReady({
        draftQuoteId: savedDraft.id,
        conversationId: input.conversationId,
        messageId: input.messageId,
        damageAnalysis: input.analysis,
        draftQuote: draftQuoteForClient,
        estimateAmount: input.estimateAmount,
        isAutoPilotActive: false,
      });

      return { savedDraft, priorMessageId: priorMessageId ?? null };
    }

    const row = this.draftQuoteRepository.create({
      conversationId: input.conversationId,
      tallerId: input.tallerId,
      messageId: input.messageId,
      imageUrl: persistedImageUrl,
      damageAnalysis: input.analysis,
      estimateAmount: input.estimateAmount,
      quotePayload: draftQuoteForClient,
      status: ACTIVE_CART_STATUS,
    });
    const savedDraft = await this.draftQuoteRepository.save(row);

    this.chatGateway.emitDraftQuoteReady({
      draftQuoteId: savedDraft.id,
      conversationId: input.conversationId,
      messageId: input.messageId,
      damageAnalysis: input.analysis,
      draftQuote: draftQuoteForClient,
      estimateAmount: input.estimateAmount,
      isAutoPilotActive: false,
    });

    return { savedDraft, priorMessageId: null };
  }

  async addTextItem(
    conversationId: string,
    tallerId: string | null | undefined,
    pieza: string,
    severidad?: string,
    descripcion?: string,
  ): Promise<Record<string, unknown>> {
    const label = String(pieza ?? '').trim();
    if (!label) {
      return buildCotizacionToolEnvelope({
        success: false,
        desglose: [],
        totalGlobal: 0,
        error: 'Indica la pieza a agregar.',
      });
    }

    const panelOpt = findPanelPiezaOption(label);
    const storedPieza = panelOpt?.code ?? label;
    const sev = coerceDamageLevelCode(severidad || 'DL');
    const item: DetectedDamageItem = {
      pieza: storedPieza,
      severidad: sev,
      descripcionTecnica:
        String(descripcion ?? '').trim() ||
        `Agregado por chat (${panelOpt?.fullName ?? label}).`,
      urls_origen: [],
    };

    const cart = await this.resolveMutableCart(conversationId, tallerId);
    const inventory = cart.damageAnalysis?.inventory ?? [];
    const merged = mergeCartInventoryItem(inventory, item);
    const saved = await this.rebuildAndPersist(cart, merged, tallerId);
    return this.getCartSummaryEnvelope(conversationId, tallerId);
  }

  async updateItem(
    conversationId: string,
    tallerId: string | null | undefined,
    piezaQuery: string,
    updates: {
      piezaNueva?: string;
      severidad?: string;
      descripcion?: string;
    },
  ): Promise<Record<string, unknown>> {
    const query = String(piezaQuery ?? '').trim();
    if (!query) {
      return buildCotizacionToolEnvelope({
        success: false,
        desglose: [],
        totalGlobal: 0,
        error: 'Indica qué pieza del carrito quieres actualizar.',
      });
    }

    const cart = await this.resolveMutableCart(conversationId, tallerId);
    const inventory = [...(cart.damageAnalysis?.inventory ?? [])];
    const idx = inventory.findIndex((it) => piezaMatchesQuery(it.pieza, query));
    if (idx < 0) {
      const approved = await this.loadApprovedCarts(conversationId, tallerId);
      const aggregated = this.buildAggregatedCartView(cart, approved);
      return {
        ...aggregated,
        success: false,
        error: `No encontré "${query}" en el carrito editable. Las líneas ya aprobadas no se modifican; agrega un complemento.`,
      };
    }

    const existing = inventory[idx]!;
    const piezaNueva = String(updates.piezaNueva ?? '').trim();
    const panelOpt = piezaNueva ? findPanelPiezaOption(piezaNueva) : null;

    inventory[idx] = {
      ...existing,
      pieza: panelOpt?.code ?? (piezaNueva || existing.pieza),
      severidad: updates.severidad
        ? coerceDamageLevelCode(updates.severidad)
        : existing.severidad,
      descripcionTecnica:
        String(updates.descripcion ?? '').trim() || existing.descripcionTecnica,
      urls_origen: [...(existing.urls_origen ?? [])],
    };

    await this.rebuildAndPersist(cart, inventory, tallerId);
    return this.getCartSummaryEnvelope(conversationId, tallerId);
  }

  async patchInventoryLines(
    conversationId: string,
    tallerId: string,
    linesDto: PatchCartInventoryLineDto[],
  ): Promise<DraftQuoteEntity> {
    if (!linesDto.length) {
      throw new BadRequestException('inventoryLines no puede estar vacío');
    }

    for (let i = 0; i < linesDto.length; i++) {
      const L = linesDto[i]!;
      if (!L.pieza?.trim()) {
        throw new BadRequestException(
          `inventoryLines[${i}]: pieza es obligatoria`,
        );
      }
      if (!String(L.severidad ?? '').trim()) {
        throw new BadRequestException(
          `inventoryLines[${i}]: severidad es obligatoria`,
        );
      }
      const pm = Number(L.precioMx);
      if (!Number.isFinite(pm) || pm < 0) {
        throw new BadRequestException(
          `inventoryLines[${i}]: precioMx debe ser >= 0`,
        );
      }
    }

    const cart = await this.resolveMutableCart(conversationId, tallerId);
    const prevInv = cart.damageAnalysis?.inventory ?? [];
    const items = mapPanelInventoryLinesToItems(linesDto, prevInv);
    return this.persistPanelInventoryOnDraft(cart, items, linesDto, tallerId);
  }

  /** PATCH /quote/:id con inventoryLines — mismo carrito, precios manuales del panel. */
  async patchDraftInventoryById(
    draftId: string,
    tallerId: string,
    linesDto: PatchCartInventoryLineDto[],
  ): Promise<DraftQuoteEntity> {
    if (!linesDto.length) {
      throw new BadRequestException('inventoryLines no puede estar vacío');
    }

    const row = await this.draftQuoteRepository.findOne({
      where: { id: draftId, tallerId },
      relations: { items: true },
    });
    if (!row) {
      throw new NotFoundException(`DraftQuote no encontrada: ${draftId}`);
    }
    if (row.status !== ACTIVE_CART_STATUS) {
      throw new BadRequestException(
        'Solo se puede editar el carrito en estado PENDING_APPROVAL.',
      );
    }

    for (let i = 0; i < linesDto.length; i++) {
      const L = linesDto[i]!;
      if (!L.pieza?.trim()) {
        throw new BadRequestException(
          `inventoryLines[${i}]: pieza es obligatoria`,
        );
      }
      if (!String(L.severidad ?? '').trim()) {
        throw new BadRequestException(
          `inventoryLines[${i}]: severidad es obligatoria`,
        );
      }
      const pm = Number(L.precioMx);
      if (!Number.isFinite(pm) || pm < 0) {
        throw new BadRequestException(
          `inventoryLines[${i}]: precioMx debe ser >= 0`,
        );
      }
    }

    const prevInv = row.damageAnalysis?.inventory ?? [];
    const items = mapPanelInventoryLinesToItems(linesDto, prevInv);
    return this.persistPanelInventoryOnDraft(row, items, linesDto, tallerId);
  }

  private async persistPanelInventoryOnDraft(
    cart: DraftQuoteEntity,
    items: DetectedDamageItem[],
    linesDto: PatchCartInventoryLineDto[],
    tallerId: string | null,
  ): Promise<DraftQuoteEntity> {
    const saved = await this.rebuildFromPanelInventoryLines(
      cart,
      items,
      linesDto,
      tallerId,
    );

    this.chatGateway.emitDraftQuoteReady({
      draftQuoteId: saved.id,
      conversationId: saved.conversationId,
      messageId: saved.messageId ?? '',
      damageAnalysis: saved.damageAnalysis,
      draftQuote: saved.quotePayload,
      estimateAmount: saved.estimateAmount,
      isAutoPilotActive: false,
    });

    return saved;
  }

  async removeItem(
    conversationId: string,
    tallerId: string | null | undefined,
    piezaQuery: string,
  ): Promise<Record<string, unknown>> {
    const query = String(piezaQuery ?? '').trim();
    if (!query) {
      return buildCotizacionToolEnvelope({
        success: false,
        desglose: [],
        totalGlobal: 0,
        error: 'Indica qué pieza quitar del carrito.',
      });
    }

    const cart = await this.resolveMutableCart(conversationId, tallerId);
    const inventory = cart.damageAnalysis?.inventory ?? [];
    const idx = inventory.findIndex((it) => piezaMatchesQuery(it.pieza, query));
    if (idx < 0) {
      const approved = await this.loadApprovedCarts(conversationId, tallerId);
      const aggregated = this.buildAggregatedCartView(cart, approved);
      return {
        ...aggregated,
        success: false,
        error: `No encontré "${query}" en el carrito editable.`,
      };
    }

    const removed = inventory[idx]!.pieza;
    const nextInventory = inventory.filter((_, i) => i !== idx);
    this.logger.log(
      `[CARRITO] quitarDelCarrito conversation=${conversationId} pieza=${removed}`,
    );
    await this.rebuildAndPersist(cart, nextInventory, tallerId);
    return this.getCartSummaryEnvelope(conversationId, tallerId);
  }

  async persistExpressQuote(
    conversationId: string,
    tallerId: string | null | undefined,
    express: ObtenerCotizacionExpressResult,
  ): Promise<Record<string, unknown>> {
    if (!express.success) {
      return buildCotizacionToolEnvelope({
        success: false,
        desglose: [],
        totalGlobal: 0,
        error: express.error ?? 'Cotización express fallida.',
      });
    }

    const cart = await this.resolveMutableCart(conversationId, tallerId);
    let inventory = [...(cart.damageAnalysis?.inventory ?? [])];

    for (const line of express.lines ?? []) {
      const panelOpt = findPanelPiezaOption(line.servicio);
      const storedPieza = panelOpt?.code ?? line.servicio;
      const item: DetectedDamageItem = {
        pieza: storedPieza,
        severidad: coerceDamageLevelCode(line.severidad),
        descripcionTecnica: `Cotización express — ${line.servicio}.`,
        urls_origen: [],
      };
      inventory = mergeCartInventoryItem(inventory, item);
    }

    await this.rebuildAndPersist(
      cart,
      inventory,
      tallerId,
      express.extras,
    );
    return {
      ...(await this.getCartSummaryEnvelope(conversationId, tallerId)),
      expressSubtotalMx: express.subtotalMx,
      expressTotalMx: express.totalMx,
      diasEntrega: express.diasEntrega,
      vehicleDisplayLabel: express.vehicleDisplayLabel,
    };
  }

  private async rebuildAndPersist(
    row: DraftQuoteEntity,
    inventory: DetectedDamageItem[],
    tallerId?: string | null,
    extras?: ReadonlyArray<{ label: string; amount: number }>,
  ): Promise<DraftQuoteEntity> {
    const snap = await this.catalogService.getMatrixPricingSnapshot(
      tallerId ?? undefined,
    );
    const imageUrls = parseDraftImageUrls(row.imageUrl ?? '');
    const analysis = inventoryItemsToVehicleAnalysis(inventory, imageUrls);
    if (row.damageAnalysis?.quoteCartMeta) {
      analysis.quoteCartMeta = { ...row.damageAnalysis.quoteCartMeta };
    } else if (!analysis.quoteCartMeta) {
      analysis.quoteCartMeta = { cartRole: 'primary' };
    }

    const quoteRows: QuoteRowInput[] = [];
    for (const it of inventory) {
      const panelCode = normalizePanelPiezaCode(it.pieza) || it.pieza;
      const sev = coerceDamageLevelCode(it.severidad);
      let precio = 0;
      if (!isSpecialPanelPieza(panelCode)) {
        const catalogPieza =
          resolveCatalogPiezaForMatrixLookup(panelCode) ??
          snap.matchServicio(it.pieza) ??
          it.pieza;
        precio = snap.getPriceForCanonical(catalogPieza, sev);
        if (precio <= 0) {
          precio = snap.getAmount(it.pieza, sev);
        }
      }
      quoteRows.push({
        pieza: panelCode,
        severidad: sev,
        precioMx: Math.max(0, Math.round(precio)),
      });
    }

    let lines = quoteRows.map((r, i) =>
      buildDraftQuoteLineFromQuoteRow(r, i, snap),
    );
    let subtotal = sumQuoteRowsSubtotal(quoteRows);

    for (const ex of extras ?? []) {
      const amt = Math.max(0, Math.round(Number(ex.amount) || 0));
      if (amt <= 0) continue;
      lines = [
        ...lines,
        {
          priceItemId: `extra:${lines.length}:${ex.label}`,
          description: ex.label,
          quantity: 1,
          unitPrice: amt,
          subtotal: amt,
        },
      ];
      subtotal += amt;
    }

    const priorPayload = row.quotePayload ?? emptyPayloadFallback();
    const doc: DraftQuote = {
      ...priorPayload,
      lines,
      subtotal,
      total: subtotal,
      analysisBasis: {
        pieza: analysis.pieza,
        severidad: analysis.severidad,
        partesAfectadas: analysis.partesAfectadas ?? [],
        severidadDelDano: analysis.severidadDelDano ?? analysis.severidad,
        descripcionTecnica: analysis.descripcionTecnica,
        justificacion: analysis.justificacion,
      },
    };

    row.damageAnalysis = analysis;
    row.estimateAmount = subtotal;
    row.quotePayload = doc;
    const saved = await this.draftQuoteRepository.save(row);
    await this.syncLineItems(saved.id, inventory, quoteRows, imageUrls);

    const reloaded = await this.draftQuoteRepository.findOne({
      where: { id: saved.id },
      relations: { items: true },
    });
    const finalRow = reloaded ?? saved;
    finalRow.items?.sort((a, b) => a.sortOrder - b.sortOrder);

    this.chatGateway.emitDraftQuoteReady({
      draftQuoteId: finalRow.id,
      conversationId: finalRow.conversationId,
      messageId: finalRow.messageId ?? '',
      damageAnalysis: finalRow.damageAnalysis,
      draftQuote: finalRow.quotePayload,
      estimateAmount: finalRow.estimateAmount,
      isAutoPilotActive: true,
    });

    return finalRow;
  }

  /** Persiste inventario del panel respetando precios manuales por línea. */
  private async rebuildFromPanelInventoryLines(
    row: DraftQuoteEntity,
    inventory: DetectedDamageItem[],
    linesDto: PatchCartInventoryLineDto[],
    tallerId: string | null,
  ): Promise<DraftQuoteEntity> {
    const snap = await this.catalogService.getMatrixPricingSnapshot(
      tallerId ?? undefined,
    );
    const fallbackUrls = parseDraftImageUrls(row.imageUrl ?? '');
    const flatUrls = inventory.flatMap((it) => it.urls_origen ?? []);
    const sourceUrls = flatUrls.length > 0 ? flatUrls : fallbackUrls;

    const analysis = inventoryItemsToVehicleAnalysis(
      inventory,
      sourceUrls.length ? sourceUrls : fallbackUrls,
    );
    if (row.damageAnalysis?.quoteCartMeta) {
      analysis.quoteCartMeta = { ...row.damageAnalysis.quoteCartMeta };
    }

    const manualLines = linesDto.map((L, idx) =>
      buildDraftQuoteLineFromQuoteRow(L, idx, snap),
    );
    const total = sumQuoteRowsSubtotal(linesDto);
    const priorPayload = row.quotePayload ?? emptyPayloadFallback();
    const doc: DraftQuote = {
      ...priorPayload,
      lines: manualLines,
      subtotal: total,
      total,
      analysisBasis: {
        pieza: analysis.pieza,
        severidad: analysis.severidad,
        partesAfectadas: analysis.partesAfectadas ?? [],
        severidadDelDano: analysis.severidadDelDano ?? analysis.severidad,
        descripcionTecnica: analysis.descripcionTecnica,
        justificacion: analysis.justificacion,
        inventory,
      },
    };

    row.damageAnalysis = analysis;
    row.estimateAmount = total;
    row.quotePayload = doc;
    const saved = await this.draftQuoteRepository.save(row);
    await this.syncLineItems(saved.id, inventory, linesDto, sourceUrls);

    const reloaded = await this.draftQuoteRepository.findOne({
      where: { id: saved.id },
      relations: { items: true },
    });
    const finalRow = reloaded ?? saved;
    finalRow.items?.sort((a, b) => a.sortOrder - b.sortOrder);
    return finalRow;
  }

  private buildAggregatedCartView(
    pending: DraftQuoteEntity | null,
    approved: readonly DraftQuoteEntity[],
  ): Record<string, unknown> {
    return buildAggregatedCartViewFromEntities(pending, approved);
  }

  private async syncLineItems(
    draftQuoteId: string,
    inventory: DetectedDamageItem[],
    quoteRows: QuoteRowInput[],
    fallbackUrls: string[],
  ): Promise<void> {
    await this.draftQuoteItemRepository.delete({ draftQuoteId });
    if (!quoteRows.length) return;

    const rows: Omit<DraftQuoteItem, 'id' | 'draftQuote' | 'draftQuoteId'>[] =
      quoteRows.map((row, idx) => {
        const inv = inventory[idx];
        const urls =
          inv && Array.isArray(inv.urls_origen) && inv.urls_origen.length > 0
            ? [...inv.urls_origen]
            : fallbackUrls.length > 0
              ? [...fallbackUrls]
              : null;
        return {
          sortOrder: idx,
          pieza: row.pieza,
          severidad: row.severidad,
          precioMx: Math.round(Number(row.precioMx) || 0),
          descripcionTecnica: inv?.descripcionTecnica ?? null,
          urlsOrigen: urls,
        };
      });

    await this.draftQuoteItemRepository.insert(
      rows.map((r) => ({ ...r, draftQuoteId })),
    );
  }
}
