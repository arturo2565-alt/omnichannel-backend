import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { DraftQuoteEntity } from './entities/draft-quote.entity';
import { DraftQuoteItem } from './entities/draft-quote-item.entity';
import { Conversation } from './entities/conversation.entity';
import { CatalogService } from '../catalog/catalog.service';
import {
  AUTO_FIX_CURRENCY,
  coerceDamageLevelCode,
  DraftQuote,
  DraftQuoteLine,
  normalizeTextForMatch,
  type DamageLevel,
} from './autofix-config';
import {
  buildDraftQuoteLineFromQuoteRow,
  sumQuoteRowsSubtotal,
  type QuoteRowInput,
} from './draft-quote-inventory-pricing';
import {
  findPanelPiezaOption,
  normalizePanelPiezaCode,
  resolveMatrixServicioRaw,
} from '../catalog/panel-pieza-catalog';
import type { DetectedDamageItem, VehicleDamageAnalysis } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import { normalizeDraftQuoteForClient } from './draft-quote-client-payload';
import { DRAFT_QUOTE_STATUS_AWAITING_VEHICLE } from './banio-vehicle-gate';
import {
  buildCotizacionToolEnvelope,
  type CotizacionDesgloseLine,
} from './cotizacion-tool-envelope';
import type { ObtenerCotizacionExpressResult } from './autopilot-cotizacion-express';

const LIGHT_DAMAGE_SEVERITY: DamageLevel = 'DL';

/** Estados editables de cotización progresiva (borrador activo). */
const ACTIVE_QUOTE_STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED',
  DRAFT_QUOTE_STATUS_AWAITING_VEHICLE,
] as const;

export type QuoteToolResult = Record<string, unknown>;

@Injectable()
export class DraftQuoteService {
  constructor(
    @InjectRepository(DraftQuoteEntity)
    private readonly draftQuoteRepository: Repository<DraftQuoteEntity>,

    @InjectRepository(DraftQuoteItem)
    private readonly draftQuoteItemRepository: Repository<DraftQuoteItem>,

    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,

    private readonly catalogService: CatalogService,
  ) {}

  /** Busca borrador activo o crea uno vacío para la conversación. */
  async getOrCreateActiveQuote(
    conversationId: string,
  ): Promise<DraftQuoteEntity> {
    const existing = await this.draftQuoteRepository.findOne({
      where: ACTIVE_QUOTE_STATUSES.map((status) => ({
        conversationId,
        status,
      })),
      order: { createdAt: 'DESC' },
      relations: { items: true },
    });
    if (existing) {
      existing.items?.sort((a, b) => a.sortOrder - b.sortOrder);
      return existing;
    }

    const conv = await this.conversationRepository.findOne({
      where: { id: conversationId },
      select: ['id', 'tallerId'],
    });

    const emptyAnalysis: VehicleDamageAnalysis = {
      pieza: 'Sin piezas',
      severidad: 'DL',
      severidadDelDano: 'DL',
      descripcionTecnica: 'Cotización progresiva iniciada por conversación.',
      justificacion: 'Borrador vacío creado por herramienta de autopilot.',
      partesAfectadas: [],
      inventory: [],
    };

    const row = this.draftQuoteRepository.create({
      conversationId,
      tallerId: conv?.tallerId ?? null,
      messageId: null,
      imageUrl: '',
      damageAnalysis: emptyAnalysis,
      estimateAmount: 0,
      quotePayload: this.buildEmptyQuotePayload(emptyAnalysis),
      status: 'PENDING_APPROVAL',
    });
    return this.draftQuoteRepository.save(row);
  }

  /** Estado + desglose actual (crea borrador vacío si no existe). */
  async getCurrentQuoteState(conversationId: string): Promise<QuoteToolResult> {
    return this.safe(async () => {
      const quote = await this.getOrCreateActiveQuote(conversationId);
      const saved = await this.recalculateTotal(quote);
      return this.toToolResponse(saved, { creadaConsulta: true });
    });
  }

  /** Agrega servicio de daño leve (DL) con precio de catálogo. */
  async addLightService(
    conversationId: string,
    pieza: string,
  ): Promise<QuoteToolResult> {
    return this.safe(async () => {
      const piezaTrim = String(pieza ?? '').trim();
      if (!piezaTrim) {
        return { success: false, error: 'Falta el parámetro pieza.' };
      }

      const tallerId = await this.resolveTallerId(conversationId);
      const snap = await this.catalogService.getMatrixPricingSnapshot(
        tallerId ?? undefined,
      );
      const resolved = this.resolvePiezaInCatalog(piezaTrim, snap);
      if (!resolved.ok) {
        return {
          success: false,
          error: resolved.error,
          piezasDisponiblesEjemplo: resolved.ejemplos,
        };
      }

      const quote = await this.getOrCreateActiveQuote(conversationId);
      const inventory = this.itemsToInventory(quote);
      const key = this.piezaMatchKey(resolved.displayPieza);
      if (inventory.some((it) => this.piezaMatchKey(it.pieza) === key)) {
        const saved = await this.recalculateTotal(quote);
        return this.toToolResponse(saved, { success: true, yaExistia: true });
      }

      const precioMx = snap.getAmount(resolved.canonical, LIGHT_DAMAGE_SEVERITY);
      if (precioMx <= 0) {
        return {
          success: false,
          error: `No hay precio de catálogo para ${resolved.canonical} (${LIGHT_DAMAGE_SEVERITY}).`,
        };
      }

      inventory.push({
        pieza: resolved.displayPieza,
        severidad: LIGHT_DAMAGE_SEVERITY,
        descripcionTecnica: `Daño leve (${LIGHT_DAMAGE_SEVERITY}): rayón, raspón o retoque de pintura.`,
        urls_origen: [],
      });

      const saved = await this.persistInventory(quote, inventory, tallerId);
      return this.toToolResponse(saved, { success: true, accion: 'agregar' });
    });
  }

  /** Elimina item por nombre de pieza (match flexible). */
  async removeQuoteItem(
    conversationId: string,
    pieza: string,
  ): Promise<QuoteToolResult> {
    return this.safe(async () => {
      const piezaTrim = String(pieza ?? '').trim();
      if (!piezaTrim) {
        return { success: false, error: 'Falta el parámetro pieza.' };
      }

      const quote = await this.findActiveQuote(conversationId);
      if (!quote) {
        return {
          success: false,
          error:
            'No hay cotización activa. Usa obtenerCotizacionActual o cotiza primero con obtenerCotizacionExpress.',
        };
      }

      const tallerId = await this.resolveTallerId(conversationId);
      const snap = await this.catalogService.getMatrixPricingSnapshot(
        tallerId ?? undefined,
      );

      let items = [...(quote.items ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder,
      );
      if (!items.length) {
        items = this.inventoryToItemRows(
          this.itemsToInventory(quote),
          quote.id,
        );
      }

      const idx = this.findItemIndexByPieza(items, piezaTrim, snap);
      if (idx < 0) {
        const current = await this.recalculateTotal(quote);
        return this.toToolResponse(current, {
          success: true,
          noEncontrada: true,
          error: `No encontré "${piezaTrim}" en la cotización actual.`,
        });
      }

      const removed = items[idx]!;
      if (removed.id) {
        await this.draftQuoteItemRepository.delete({ id: removed.id });
      }
      items.splice(idx, 1);

      const inventory = items.map((it) => ({
        pieza: it.pieza,
        severidad: it.severidad,
        descripcionTecnica: it.descripcionTecnica ?? '',
        urls_origen: [...(it.urlsOrigen ?? [])],
      }));

      const saved = await this.persistInventory(quote, inventory, tallerId);
      return this.toToolResponse(saved, {
        success: true,
        accion: 'quitar',
        piezaEliminada: this.displayPiezaLabel(removed.pieza),
      });
    });
  }

  /** Recalcula total desde items y persiste quotePayload + estimateAmount. */
  async recalculateTotal(quote: DraftQuoteEntity): Promise<DraftQuoteEntity> {
    const tallerId = quote.tallerId;
    const snap = await this.catalogService.getMatrixPricingSnapshot(
      tallerId ?? undefined,
    );

    const withItems = await this.draftQuoteRepository.findOne({
      where: { id: quote.id },
      relations: { items: true },
    });
    const row = withItems ?? quote;
    row.items?.sort((a, b) => a.sortOrder - b.sortOrder);

    const inventory = this.itemsToInventory(row);
    return this.persistInventory(row, inventory, tallerId, snap);
  }

  // --- Internos ---

  private async findActiveQuote(
    conversationId: string,
  ): Promise<DraftQuoteEntity | null> {
    return this.draftQuoteRepository.findOne({
      where: ACTIVE_QUOTE_STATUSES.map((status) => ({
        conversationId,
        status,
      })),
      order: { createdAt: 'DESC' },
      relations: { items: true },
    });
  }

  private async resolveTallerId(conversationId: string): Promise<string | null> {
    const conv = await this.conversationRepository.findOne({
      where: { id: conversationId },
      select: ['id', 'tallerId'],
    });
    return conv?.tallerId ?? null;
  }

  private buildEmptyQuotePayload(analysis: VehicleDamageAnalysis): DraftQuote {
    return {
      reference: `DRAFT-${randomUUID().slice(0, 8).toUpperCase()}`,
      generatedAt: new Date().toISOString(),
      currency: AUTO_FIX_CURRENCY,
      status: 'PENDING_APPROVAL',
      lines: [],
      subtotal: 0,
      total: 0,
      formalNarrative: '',
      generatedMessage: '',
      clientMessage: '',
      analysisBasis: {
        pieza: analysis.pieza,
        severidad: analysis.severidad,
        partesAfectadas: [...(analysis.partesAfectadas ?? [])],
        severidadDelDano: analysis.severidadDelDano,
        descripcionTecnica: analysis.descripcionTecnica,
        justificacion: analysis.justificacion,
        inventory: analysis.inventory ?? [],
      },
    };
  }

  private itemsToInventory(row: DraftQuoteEntity): DetectedDamageItem[] {
    if (row.items?.length) {
      return row.items.map((it) => ({
        pieza: it.pieza,
        severidad: it.severidad,
        descripcionTecnica: it.descripcionTecnica ?? '',
        urls_origen: [...(it.urlsOrigen ?? [])],
      }));
    }
    const fromAnalysis = row.damageAnalysis?.inventory;
    if (Array.isArray(fromAnalysis) && fromAnalysis.length) {
      return fromAnalysis.map((it) => ({
        pieza: it.pieza,
        severidad: it.severidad,
        descripcionTecnica: it.descripcionTecnica,
        urls_origen: [...(it.urls_origen ?? [])],
      }));
    }
    return [];
  }

  private inventoryToItemRows(
    inventory: DetectedDamageItem[],
    draftQuoteId: string,
  ): DraftQuoteItem[] {
    return inventory.map((it, idx) =>
      this.draftQuoteItemRepository.create({
        draftQuoteId,
        sortOrder: idx,
        pieza: normalizePanelPiezaCode(it.pieza) || it.pieza,
        severidad: coerceDamageLevelCode(it.severidad),
        precioMx: 0,
        descripcionTecnica: it.descripcionTecnica ?? null,
        urlsOrigen: it.urls_origen?.length ? [...it.urls_origen] : null,
      }),
    );
  }

  private async persistInventory(
    row: DraftQuoteEntity,
    inventory: DetectedDamageItem[],
    tallerId: string | null,
    snapIn?: MatrixPricingSnapshot,
  ): Promise<DraftQuoteEntity> {
    const snap =
      snapIn ??
      (await this.catalogService.getMatrixPricingSnapshot(tallerId ?? undefined));

    const existingPrices = new Map<string, number>();
    for (const it of row.items ?? []) {
      existingPrices.set(this.piezaMatchKey(it.pieza), it.precioMx);
    }

    const quoteRows: QuoteRowInput[] = inventory.map((it) => {
      const canonical =
        snap.matchServicio(resolveMatrixServicioRaw(it.pieza)) ?? it.pieza;
      const sev = coerceDamageLevelCode(it.severidad);
      const key = this.piezaMatchKey(it.pieza);
      const stored = existingPrices.get(key);
      const precioMx =
        stored != null && stored > 0
          ? stored
          : snap.getAmount(canonical, sev);
      return {
        pieza: it.pieza,
        severidad: sev,
        precioMx,
        descripcionTecnica: it.descripcionTecnica,
      };
    });

    const total = sumQuoteRowsSubtotal(quoteRows);
    const lines: DraftQuoteLine[] = quoteRows.map((qr, idx) =>
      buildDraftQuoteLineFromQuoteRow(qr, idx, snap),
    );

    const analysis: VehicleDamageAnalysis = {
      ...(row.damageAnalysis ?? {
        pieza: 'Sin piezas',
        severidad: 'DL',
        severidadDelDano: 'DL',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: [],
      }),
      pieza:
        inventory.length === 1
          ? inventory[0]!.pieza
          : inventory.length > 1
            ? `${inventory.length} piezas`
            : 'Sin piezas',
      partesAfectadas: inventory.map((i) => i.pieza),
      inventory: inventory.map((it) => ({
        pieza: it.pieza,
        severidad: coerceDamageLevelCode(it.severidad),
        descripcionTecnica: it.descripcionTecnica,
        urls_origen: [...(it.urls_origen ?? [])],
      })),
    };

    const quotePayload: DraftQuote = {
      ...(row.quotePayload ?? this.buildEmptyQuotePayload(analysis)),
      lines,
      subtotal: total,
      total,
      analysisBasis: {
        ...(row.quotePayload?.analysisBasis ?? {
          pieza: analysis.pieza,
          severidad: analysis.severidad,
          partesAfectadas: analysis.partesAfectadas,
          severidadDelDano: analysis.severidadDelDano,
          descripcionTecnica: analysis.descripcionTecnica,
          justificacion: analysis.justificacion,
        }),
        inventory: analysis.inventory,
        pieza: analysis.pieza,
        partesAfectadas: analysis.partesAfectadas,
      },
    };

    const quotePayloadForClient =
      normalizeDraftQuoteForClient(quotePayload) ?? quotePayload;

    row.damageAnalysis = analysis;
    row.estimateAmount = total;
    row.quotePayload = quotePayloadForClient;
    row.tallerId = tallerId ?? row.tallerId;

    const saved = await this.draftQuoteRepository.save(row);

    await this.draftQuoteItemRepository.delete({ draftQuoteId: saved.id });
    if (inventory.length) {
      const itemRows = inventory.map((it, idx) => ({
        draftQuoteId: saved.id,
        sortOrder: idx,
        pieza: normalizePanelPiezaCode(it.pieza) || it.pieza,
        severidad: coerceDamageLevelCode(it.severidad),
        precioMx: Math.round(
          Number(
            lines[idx]?.subtotal ?? lines[idx]?.unitPrice ?? quoteRows[idx]?.precioMx ?? 0,
          ),
        ),
        descripcionTecnica: it.descripcionTecnica ?? null,
        urlsOrigen: it.urls_origen?.length ? [...it.urls_origen] : null,
      }));
      await this.draftQuoteItemRepository.insert(itemRows);
    }

    const reloaded = await this.draftQuoteRepository.findOne({
      where: { id: saved.id },
      relations: { items: true },
    });
    return reloaded ?? saved;
  }

  /**
   * Persiste líneas de obtenerCotizacionExpress en el borrador activo
   * para que agregar/quitar piezas funcione después de una cotización express.
   */
  async importFromExpressResult(
    conversationId: string,
    express: ObtenerCotizacionExpressResult,
    tallerId: string | null,
  ): Promise<DraftQuoteEntity | null> {
    if (!express.success || !express.lines?.length) return null;

    const inventory: DetectedDamageItem[] = express.lines.map((line) => ({
      pieza: line.servicio,
      severidad: coerceDamageLevelCode(line.severidad),
      descripcionTecnica:
        line.tipo === 'bano_pintura'
          ? `Baño de pintura (${line.severidad})`
          : `Daño leve (${line.severidad}): cotización express.`,
      urls_origen: [],
    }));

    const quote = await this.getOrCreateActiveQuote(conversationId);
    return this.persistInventory(quote, inventory, tallerId);
  }

  /** Resumen estructurado { desglose, totalGlobal }. */
  async getQuoteSummary(conversationId: string): Promise<QuoteToolResult> {
    return this.getCurrentQuoteState(conversationId);
  }

  private toDesglose(row: DraftQuoteEntity): CotizacionDesgloseLine[] {
    const items = [...(row.items ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    if (items.length) {
      return items.map((it) => ({
        pieza: this.displayPiezaLabel(it.pieza),
        precio: Math.round(Number(it.precioMx) || 0),
      }));
    }
    return (row.quotePayload?.lines ?? []).map((line) => ({
      pieza: String(line.description ?? '').split('—')[0]?.trim() || 'Servicio',
      precio: Math.round(Number(line.subtotal ?? line.unitPrice ?? 0)),
    }));
  }

  private toToolResponse(
    row: DraftQuoteEntity,
    extra: Record<string, unknown>,
  ): QuoteToolResult {
    const desglose = this.toDesglose(row);
    return buildCotizacionToolEnvelope(desglose, {
      ...extra,
      draftQuoteId: row.id,
      status: row.status,
      itemCount: desglose.length,
    }) as QuoteToolResult;
  }

  private resolvePiezaInCatalog(
    piezaRaw: string,
    snap: MatrixPricingSnapshot,
  ):
    | { ok: true; canonical: string; displayPieza: string }
    | { ok: false; error: string; ejemplos: string[] } {
    const fromPanel = findPanelPiezaOption(piezaRaw);
    const matrixRaw = resolveMatrixServicioRaw(
      fromPanel?.catalogPieza || piezaRaw,
    );
    const canonical = snap.matchServicio(matrixRaw);
    if (!canonical) {
      return {
        ok: false,
        error: `La pieza "${piezaRaw}" no coincide con el catálogo del taller.`,
        ejemplos: snap.serviciosOrderedLongestFirst.slice(0, 8),
      };
    }
    const displayPieza =
      fromPanel?.code ?? normalizePanelPiezaCode(piezaRaw) ?? piezaRaw;
    return { ok: true, canonical, displayPieza };
  }

  private displayPiezaLabel(piezaCode: string): string {
    const opt = findPanelPiezaOption(piezaCode);
    return opt?.fullName ?? (String(piezaCode ?? '').trim() || 'Servicio');
  }

  private piezaMatchKey(raw: string): string {
    const opt = findPanelPiezaOption(raw);
    const code = opt?.code ?? normalizePanelPiezaCode(raw);
    return normalizeTextForMatch(code || raw);
  }

  private findItemIndexByPieza(
    items: readonly DraftQuoteItem[],
    piezaSearch: string,
    snap: MatrixPricingSnapshot,
  ): number {
    const searchKey = this.piezaMatchKey(piezaSearch);
    const searchNorm = normalizeTextForMatch(piezaSearch);
    const searchCanonical =
      snap.matchServicio(resolveMatrixServicioRaw(piezaSearch)) ?? '';

    return items.findIndex((it) => {
      const storedKey = this.piezaMatchKey(it.pieza);
      if (storedKey === searchKey) return true;
      const label = normalizeTextForMatch(this.displayPiezaLabel(it.pieza));
      if (label === searchNorm) return true;
      if (searchCanonical) {
        const storedCanon =
          snap.matchServicio(resolveMatrixServicioRaw(it.pieza)) ?? '';
        if (
          storedCanon &&
          normalizeTextForMatch(storedCanon) ===
            normalizeTextForMatch(searchCanonical)
        ) {
          const searchOpt = findPanelPiezaOption(piezaSearch);
          const storedOpt = findPanelPiezaOption(it.pieza);
          if (!searchOpt || !storedOpt || searchOpt.code === storedOpt.code) {
            return true;
          }
        }
      }
      return (
        label.includes(searchNorm) ||
        (searchNorm.length >= 4 && searchNorm.includes(label))
      );
    });
  }

  private async safe(fn: () => Promise<QuoteToolResult>): Promise<QuoteToolResult> {
    try {
      return await fn();
    } catch (err) {
      console.error('[DraftQuoteService]', err);
      return {
        success: false,
        error:
          'Error interno al procesar la cotización. Informa al cliente amablemente y pide reintentar.',
        instruccionParaModelo:
          'Hubo un error técnico. Responde al cliente sin quedarte en silencio.',
      };
    }
  }
}
