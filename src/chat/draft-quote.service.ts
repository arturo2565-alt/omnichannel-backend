import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { DraftQuoteEntity } from './entities/draft-quote.entity';
import { DraftQuoteItem } from './entities/draft-quote-item.entity';
import { CatalogService } from '../catalog/catalog.service';
import {
  AUTO_FIX_CURRENCY,
  coerceDamageLevelCode,
  damageLevelRank,
  DraftQuote,
  DraftQuoteLine,
  formatAutoFixMoney,
  type DamageLevel,
} from './autofix-config';
import {
  buildDraftQuoteLineFromQuoteRow,
  sumQuoteRowsSubtotal,
  type QuoteRowInput,
} from './draft-quote-inventory-pricing';
import {
  normalizePanelPiezaCode,
  resolveMatrixServicioRaw,
  findPanelPiezaOption,
} from '../catalog/panel-pieza-catalog';
import type {
  DetectedDamageItem,
  VehicleDamageAnalysis,
} from './entities/chat.entity';
import {
  draftQuoteLinesToClientePiezaRows,
  formatDraftQuoteLineToolEmoji,
} from './draft-quote-resume';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import { normalizeDraftQuoteForClient } from './draft-quote-client-payload';
import { DRAFT_QUOTE_STATUS_AWAITING_VEHICLE } from './banio-vehicle-gate';
import {
  buildCotizacionToolEnvelope,
  sumDesglosePrecios,
  type CotizacionDesgloseLine,
} from './cotizacion-tool-envelope';
import { normalizeTextForMatch } from './autofix-config';

const LIGHT_DAMAGE_SEVERITY: DamageLevel = 'DL';

export type DraftQuoteItemDto = {
  pieza: string;
  piezaCanonical: string;
  severidad: string;
  precioMx: number;
  descripcionTecnica: string;
};

export type DraftQuoteStateDto = {
  draftQuoteId: string;
  reference: string;
  status: string;
  moneda: typeof AUTO_FIX_CURRENCY;
  itemCount: number;
  items: DraftQuoteItemDto[];
  subtotalMx: number;
  totalMx: number;
  creadaEnEstaLlamada?: boolean;
};

export type DraftQuoteToolResult = {
  success: boolean;
  error?: string;
  piezaNoEnCatalogo?: boolean;
  piezasDisponiblesEjemplo?: string[];
  yaExistia?: boolean;
  noEncontrada?: boolean;
  accion?: string;
  cotizacion?: DraftQuoteStateDto;
  resumenCliente?: string;
  resumenLineas?: string[];
  desglose?: CotizacionDesgloseLine[];
  totalGlobal?: number;
  instruccionParaModelo?: string;
};

type CotizacionAccion = 'agregar' | 'quitar' | 'actualizar';

@Injectable()
export class DraftQuoteService {
  constructor(
    @InjectRepository(DraftQuoteEntity)
    private readonly draftQuoteRepository: Repository<DraftQuoteEntity>,

    @InjectRepository(DraftQuoteItem)
    private readonly draftQuoteItemRepository: Repository<DraftQuoteItem>,

    private readonly catalogService: CatalogService,
  ) {}

  /** Estado actual de la cotización activa; crea borrador vacío si no existe. */
  async obtenerCotizacionActual(
    conversationId: string,
    tallerId: string | null,
  ): Promise<DraftQuoteToolResult> {
    return this.safeTool(async () => {
      const { row, created } = await this.getOrCreateActiveDraft(
        conversationId,
        tallerId,
      );
      return this.wrapToolResult({ success: true }, row, created);
    });
  }

  /** Persiste cotización express en borrador activo (para poder quitar piezas después). */
  async persistExpressCotizacion(
    conversationId: string,
    tallerId: string | null,
    desglose: readonly CotizacionDesgloseLine[],
  ): Promise<void> {
    if (!desglose.length) return;

    const { row } = await this.getOrCreateActiveDraft(conversationId, tallerId);
    const snap = await this.catalogService.getMatrixPricingSnapshot(
      tallerId ?? undefined,
    );

    const priceOverrides = new Map<string, number>();
    const inventory: DetectedDamageItem[] = desglose.map((line) => {
      const piezaRaw = String(line.pieza ?? '').trim();
      const panelOpt = findPanelPiezaOption(piezaRaw);
      const displayPieza = panelOpt?.code ?? piezaRaw;
      const canonical = snap.matchServicio(piezaRaw) ?? piezaRaw;
      const precio = Math.round(Number(line.precio) || 0);
      priceOverrides.set(this.piezaMatchKey(displayPieza), precio);
      return {
        pieza: displayPieza,
        severidad: LIGHT_DAMAGE_SEVERITY,
        descripcionTecnica: `Cotización express — ${canonical} (DL).`,
        urls_origen: [],
      };
    });

    await this.persistInventoryChanges(
      row,
      inventory,
      tallerId,
      priceOverrides,
    );
  }

  /** Agrega daño leve (DL) a la cotización activa. Idempotente si la pieza ya está. */
  async agregarServicioLeve(
    conversationId: string,
    tallerId: string | null,
    pieza: string,
    descripcionTecnica?: string,
  ): Promise<DraftQuoteToolResult> {
    return this.safeTool(async () => {
      const piezaTrim = String(pieza ?? '').trim();
      if (!piezaTrim) {
        return { success: false, error: 'Falta el parámetro pieza.' };
      }

      const snap = await this.catalogService.getMatrixPricingSnapshot(
        tallerId ?? undefined,
      );
      const resolved = this.resolvePiezaInCatalog(piezaTrim, snap);
      if (!resolved.ok) {
        return {
          success: false,
          error: resolved.error,
          piezaNoEnCatalogo: true,
          piezasDisponiblesEjemplo: resolved.ejemplos,
        };
      }

      const { row } = await this.getOrCreateActiveDraft(conversationId, tallerId);
      const inventory = this.extractInventory(row);
      const existingIdx = this.findInventoryIndexByCanonical(
        inventory,
        resolved.canonical,
        snap,
      );

      if (existingIdx >= 0) {
        const saved = await this.draftQuoteRepository.findOne({
          where: { id: row.id },
          relations: { items: true },
        });
        return this.wrapToolResult(
          { success: true, yaExistia: true },
          saved ?? row,
        );
      }

      const precioMx = snap.getAmount(resolved.canonical, LIGHT_DAMAGE_SEVERITY);
      if (precioMx <= 0) {
        return {
          success: false,
          error: `No hay precio de catálogo para ${resolved.canonical} con severidad ${LIGHT_DAMAGE_SEVERITY}.`,
          piezaNoEnCatalogo: true,
        };
      }

      const desc =
        String(descripcionTecnica ?? '').trim() ||
        `Daño leve (${LIGHT_DAMAGE_SEVERITY}): rayón, raspón o retoque de pintura.`;

      inventory.push({
        pieza: resolved.displayPieza,
        severidad: LIGHT_DAMAGE_SEVERITY,
        descripcionTecnica: desc,
        urls_origen: [],
      });

      const saved = await this.persistInventoryChanges(row, inventory, tallerId);
      return this.wrapToolResult({ success: true, accion: 'agregar' }, saved);
    });
  }

  /** Actualiza la cotización: agregar, quitar o modificar una pieza. */
  async actualizarCotizacion(
    conversationId: string,
    tallerId: string | null,
    accion: CotizacionAccion,
    pieza: string,
    opts?: {
      precio?: number;
      severidad?: string;
      descripcionTecnica?: string;
    },
  ): Promise<DraftQuoteToolResult> {
    return this.safeTool(async () => {
      const piezaTrim = String(pieza ?? '').trim();
      const accionNorm = String(accion ?? '')
        .trim()
        .toLowerCase() as CotizacionAccion;

      if (!piezaTrim) {
        return { success: false, error: 'Falta el parámetro pieza.' };
      }
      if (!['agregar', 'quitar', 'actualizar'].includes(accionNorm)) {
        return {
          success: false,
          error: 'accion debe ser "agregar", "quitar" o "actualizar".',
        };
      }

      if (accionNorm === 'quitar') {
        return this.eliminarServicioDeCotizacion(
          conversationId,
          tallerId,
          piezaTrim,
        );
      }

      const snap = await this.catalogService.getMatrixPricingSnapshot(
        tallerId ?? undefined,
      );
      const resolved = this.resolvePiezaInCatalog(piezaTrim, snap);
      if (!resolved.ok) {
        return {
          success: false,
          error: resolved.error,
          piezaNoEnCatalogo: true,
          piezasDisponiblesEjemplo: resolved.ejemplos,
        };
      }

      const { row } = await this.getOrCreateActiveDraft(conversationId, tallerId);
      let inventory = this.extractInventory(row);

      if (accionNorm === 'agregar') {
        const existingIdx = this.findInventoryIndexByCanonical(
          inventory,
          resolved.canonical,
          snap,
        );
        if (existingIdx >= 0) {
          return this.wrapToolResult(
            { success: true, yaExistia: true, accion: 'agregar' },
            row,
          );
        }

        const sev = coerceDamageLevelCode(
          opts?.severidad ?? LIGHT_DAMAGE_SEVERITY,
        );
        const precioMx =
          opts?.precio != null && Number.isFinite(opts.precio) && opts.precio >= 0
            ? Math.round(opts.precio)
            : snap.getAmount(resolved.canonical, sev);

        if (precioMx <= 0) {
          return {
            success: false,
            error: `No hay precio de catálogo para ${resolved.canonical} (${sev}).`,
          };
        }

        inventory.push({
          pieza: resolved.displayPieza,
          severidad: sev,
          descripcionTecnica:
            String(opts?.descripcionTecnica ?? '').trim() ||
            `Servicio ${sev} en ${resolved.displayPieza}.`,
          urls_origen: [],
        });
      } else {
        const idx = this.findInventoryIndexByCanonical(
          inventory,
          resolved.canonical,
          snap,
        );
        if (idx < 0) {
          return {
            success: false,
            error: `La pieza "${piezaTrim}" no está en la cotización actual. Usa accion "agregar" primero.`,
          };
        }

        const current = inventory[idx]!;
        const sev = opts?.severidad
          ? coerceDamageLevelCode(opts.severidad)
          : coerceDamageLevelCode(current.severidad);

        inventory[idx] = {
          ...current,
          severidad: sev,
          descripcionTecnica:
            String(opts?.descripcionTecnica ?? '').trim() ||
            current.descripcionTecnica,
        };
      }

      const priceOverrides = new Map<string, number>();
      if (opts?.precio != null && Number.isFinite(opts.precio) && opts.precio >= 0) {
        priceOverrides.set(
          this.piezaMatchKey(resolved.displayPieza),
          Math.round(opts.precio),
        );
      }

      const saved = await this.persistInventoryChanges(
        row,
        inventory,
        tallerId,
        priceOverrides.size > 0 ? priceOverrides : undefined,
      );
      return this.wrapToolResult(
        { success: true, accion: accionNorm },
        saved,
      );
    });
  }

  /** Elimina una pieza de la cotización activa (draft_quote_items + totales). */
  async eliminarServicioDeCotizacion(
    conversationId: string,
    tallerId: string | null,
    pieza: string,
  ): Promise<DraftQuoteToolResult> {
    return this.safeTool(async () => {
      const piezaTrim = String(pieza ?? '').trim();
      if (!piezaTrim) {
        return { success: false, error: 'Falta el parámetro pieza.' };
      }

      const row = await this.findActiveDraftForMutation(conversationId);
      if (!row) {
        return {
          success: false,
          error:
            'No hay cotización activa en esta conversación. Cotiza primero con obtenerCotizacionExpress o agrega piezas.',
        };
      }

      const snap = await this.catalogService.getMatrixPricingSnapshot(
        tallerId ?? undefined,
      );

      let workingRow = row;
      let items = [...(workingRow.items ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder,
      );

      if (!items.length) {
        const inventory = this.extractInventory(workingRow);
        if (inventory.length > 0) {
          workingRow = await this.persistInventoryChanges(
            workingRow,
            inventory,
            tallerId,
          );
          items = [...(workingRow.items ?? [])].sort(
            (a, b) => a.sortOrder - b.sortOrder,
          );
        }
      }

      const removeIdx = this.findDraftItemIndexToRemove(items, piezaTrim, snap);
      if (removeIdx < 0) {
        return this.wrapToolResult(
          {
            success: true,
            noEncontrada: true,
            accion: 'quitar',
            error: `La pieza "${piezaTrim}" no está en la cotización actual.`,
          },
          workingRow,
        );
      }

      const removedItem = items[removeIdx]!;
      await this.draftQuoteItemRepository.delete({ id: removedItem.id });

      const remainingItems = items.filter((_, i) => i !== removeIdx);
      const inventory = remainingItems.map((it) => ({
        pieza: it.pieza,
        severidad: it.severidad,
        descripcionTecnica: it.descripcionTecnica ?? '',
        urls_origen: [...(it.urlsOrigen ?? [])],
      }));

      const priceByPieza = new Map(
        remainingItems.map(
          (it) => [this.piezaMatchKey(it.pieza), it.precioMx] as const,
        ),
      );

      const saved = await this.persistInventoryChanges(
        workingRow,
        inventory,
        tallerId,
        priceByPieza,
      );

      return this.wrapToolResult(
        {
          success: true,
          accion: 'quitar',
          piezaEliminada: this.displayPiezaLabel(removedItem.pieza),
        },
        saved,
      );
    });
  }

  /** Texto formateado listo para mostrar al cliente. */
  async obtenerResumenCotizacion(
    conversationId: string,
    tallerId: string | null,
    contactName?: string,
  ): Promise<DraftQuoteToolResult> {
    return this.safeTool(async () => {
      const { row } = await this.getOrCreateActiveDraft(conversationId, tallerId);
      const cotizacion = this.buildStateDto(row);
      const resumen = this.buildClienteResumen(cotizacion, contactName);
      return this.wrapToolResult(
        {
          success: true,
          resumenCliente: resumen.texto,
          resumenLineas: resumen.lineas,
        },
        row,
      );
    });
  }

  // --- Internos ---

  private async safeTool(
    fn: () => Promise<DraftQuoteToolResult>,
  ): Promise<DraftQuoteToolResult> {
    try {
      return await fn();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Error interno al procesar la cotización.';
      console.error('[DraftQuoteService] tool error:', err);
      return {
        success: false,
        error: `No se pudo completar la operación de cotización: ${message}. Informa al cliente que hubo un problema técnico y ofrece reintentar.`,
      };
    }
  }

  private wrapToolResult(
    base: Record<string, unknown>,
    row: DraftQuoteEntity,
    creadaEnEstaLlamada = false,
  ): DraftQuoteToolResult {
    const cotizacion = this.buildStateDto(row, creadaEnEstaLlamada);
    const desglose = this.desgloseFromDraftRow(row);
    const envelope = buildCotizacionToolEnvelope(desglose, {
      ...base,
      cotizacion,
    });
    return envelope as DraftQuoteToolResult;
  }

  private desgloseFromDraftRow(row: DraftQuoteEntity): CotizacionDesgloseLine[] {
    const items = [...(row.items ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    if (items.length > 0) {
      return items.map((it) => ({
        pieza: this.displayPiezaLabel(it.pieza),
        precio: Math.round(Number(it.precioMx) || 0),
      }));
    }
    const lines = row.quotePayload?.lines ?? [];
    return draftQuoteLinesToClientePiezaRows(lines).map((lr) => ({
      pieza: lr.pieza,
      precio: lr.precioMx,
    }));
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

  private async findActiveDraftForMutation(
    conversationId: string,
  ): Promise<DraftQuoteEntity | null> {
    const activeStatuses = [
      'PENDING_APPROVAL',
      DRAFT_QUOTE_STATUS_AWAITING_VEHICLE,
    ];
    const row = await this.draftQuoteRepository.findOne({
      where: activeStatuses.map((status) => ({ conversationId, status })),
      order: { createdAt: 'DESC' },
      relations: { items: true },
    });
    if (row) {
      row.items?.sort((a, b) => a.sortOrder - b.sortOrder);
      return row;
    }
    return null;
  }

  private findDraftItemIndexToRemove(
    items: readonly DraftQuoteItem[],
    piezaSearch: string,
    snap: MatrixPricingSnapshot,
  ): number {
    const searchKey = this.piezaMatchKey(piezaSearch);
    const searchCanonical =
      snap.matchServicio(resolveMatrixServicioRaw(piezaSearch)) ?? '';
    const searchNorm = normalizeTextForMatch(piezaSearch);

    return items.findIndex((it) => {
      const storedKey = this.piezaMatchKey(it.pieza);
      if (storedKey === searchKey) return true;
      if (searchCanonical) {
        const storedCanonical =
          snap.matchServicio(resolveMatrixServicioRaw(it.pieza)) ?? '';
        if (
          storedCanonical &&
          normalizeTextForMatch(storedCanonical) ===
            normalizeTextForMatch(searchCanonical)
        ) {
          const searchOpt = findPanelPiezaOption(piezaSearch);
          const storedOpt = findPanelPiezaOption(it.pieza);
          if (!searchOpt || !storedOpt || searchOpt.code === storedOpt.code) {
            return true;
          }
        }
      }
      const storedLabel = normalizeTextForMatch(this.displayPiezaLabel(it.pieza));
      if (storedLabel === searchNorm) return true;
      if (storedLabel.includes(searchNorm) || searchNorm.includes(storedLabel)) {
        return searchNorm.length >= 4 || storedLabel.length >= 4;
      }
      return false;
    });
  }

  private async getOrCreateActiveDraft(
    conversationId: string,
    tallerId: string | null,
  ): Promise<{ row: DraftQuoteEntity; created: boolean }> {
    const activeStatuses = ['PENDING_APPROVAL', DRAFT_QUOTE_STATUS_AWAITING_VEHICLE];
    const existing = await this.draftQuoteRepository.findOne({
      where: activeStatuses.map((status) => ({ conversationId, status })),
      order: { createdAt: 'DESC' },
      relations: { items: true },
    });
    if (existing) {
      existing.items?.sort((a, b) => a.sortOrder - b.sortOrder);
      return { row: existing, created: false };
    }

    const emptyAnalysis: VehicleDamageAnalysis = {
      pieza: 'Sin piezas',
      severidad: 'DL',
      severidadDelDano: 'DL',
      descripcionTecnica: 'Cotización progresiva iniciada por conversación.',
      justificacion: 'Borrador vacío creado por herramienta de autopilot.',
      partesAfectadas: [],
      inventory: [],
    };

    const emptyQuote = this.buildEmptyQuotePayload(emptyAnalysis);
    const row = this.draftQuoteRepository.create({
      conversationId,
      tallerId,
      messageId: null,
      imageUrl: '',
      damageAnalysis: emptyAnalysis,
      estimateAmount: 0,
      quotePayload: emptyQuote,
      status: 'PENDING_APPROVAL',
    });
    const saved = await this.draftQuoteRepository.save(row);
    return { row: saved, created: true };
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

  private extractInventory(row: DraftQuoteEntity): DetectedDamageItem[] {
    const fromAnalysis = row.damageAnalysis?.inventory;
    if (Array.isArray(fromAnalysis) && fromAnalysis.length > 0) {
      return fromAnalysis.map((it) => ({
        pieza: it.pieza,
        severidad: it.severidad,
        descripcionTecnica: it.descripcionTecnica,
        urls_origen: [...(it.urls_origen ?? [])],
      }));
    }
    const fromBasis = row.quotePayload?.analysisBasis?.inventory;
    if (Array.isArray(fromBasis) && fromBasis.length > 0) {
      return fromBasis.map((it) => ({
        pieza: it.pieza,
        severidad: it.severidad,
        descripcionTecnica: it.descripcionTecnica,
        urls_origen: [...(it.urls_origen ?? [])],
      }));
    }
    if (row.items?.length) {
      return row.items.map((it) => ({
        pieza: it.pieza,
        severidad: it.severidad,
        descripcionTecnica: it.descripcionTecnica ?? '',
        urls_origen: [...(it.urlsOrigen ?? [])],
      }));
    }
    return [];
  }

  private resolvePiezaInCatalog(
    piezaRaw: string,
    snap: MatrixPricingSnapshot,
  ):
    | { ok: true; canonical: string; displayPieza: string }
    | { ok: false; error: string; ejemplos: string[] } {
    const matrixRaw = resolveMatrixServicioRaw(piezaRaw);
    const canonical = snap.matchServicio(matrixRaw);
    if (!canonical) {
      const ejemplos = snap.serviciosOrderedLongestFirst.slice(0, 8);
      return {
        ok: false,
        error: `La pieza "${piezaRaw}" no coincide con el catálogo del taller. Usa un nombre canónico (ej. Puerta, Fascia, Salpicadera).`,
        ejemplos,
      };
    }
    const displayPieza = normalizePanelPiezaCode(piezaRaw) || piezaRaw;
    return { ok: true, canonical, displayPieza };
  }

  private findInventoryIndexByCanonical(
    inventory: DetectedDamageItem[],
    canonical: string,
    snap: MatrixPricingSnapshot,
  ): number {
    const target = canonical.toLowerCase();
    return inventory.findIndex((it) => {
      const c =
        snap.matchServicio(resolveMatrixServicioRaw(it.pieza)) ??
        normalizePanelPiezaCode(it.pieza) ??
        it.pieza;
      return String(c).toLowerCase() === target;
    });
  }

  private removePiezaFromInventory(
    inventory: DetectedDamageItem[],
    piezaRaw: string,
    snap: MatrixPricingSnapshot,
  ): { inventory: DetectedDamageItem[]; removed: boolean } {
    const canonical =
      snap.matchServicio(resolveMatrixServicioRaw(piezaRaw)) ??
      normalizePanelPiezaCode(piezaRaw) ??
      piezaRaw;
    const idx = this.findInventoryIndexByCanonical(inventory, canonical, snap);
    if (idx < 0) {
      return { inventory, removed: false };
    }
    const next = [...inventory];
    next.splice(idx, 1);
    return { inventory: next, removed: true };
  }

  private inventoryToAnalysis(
    inventory: DetectedDamageItem[],
    prev: VehicleDamageAnalysis,
  ): VehicleDamageAnalysis {
    const inv = inventory.map((it) => ({
      pieza: it.pieza,
      severidad: coerceDamageLevelCode(it.severidad),
      descripcionTecnica: it.descripcionTecnica,
      urls_origen: [...(it.urls_origen ?? [])],
    }));
    const partes = [...new Set(inv.map((i) => i.pieza).filter(Boolean))];
    let worst: DamageLevel = 'DL';
    for (const it of inv) {
      const sev = coerceDamageLevelCode(it.severidad);
      if (damageLevelRank(sev) > damageLevelRank(worst)) worst = sev;
    }
    const piezaLabel =
      partes.length === 1
        ? partes[0]!
        : partes.length > 1
          ? `${partes.slice(0, 2).join(' + ')}${partes.length > 2 ? ` (+${partes.length - 2} más)` : ''}`
          : 'Sin piezas';
    const desc = inv.length
      ? inv
          .map(
            (it) =>
              `• ${it.pieza} (${it.severidad}): ${it.descripcionTecnica}`,
          )
          .join('\n')
      : 'Sin servicios en la cotización.';

    return {
      ...prev,
      pieza: piezaLabel,
      severidad: worst,
      severidadDelDano: worst,
      descripcionTecnica: desc,
      partesAfectadas: partes,
      inventory: inv,
      justificacion:
        prev.justificacion ||
        `Cotización progresiva (${inv.length} servicio(s)).`,
    };
  }

  private async persistInventoryChanges(
    row: DraftQuoteEntity,
    inventory: DetectedDamageItem[],
    tallerId: string | null,
    priceOverrides?: Map<string, number>,
  ): Promise<DraftQuoteEntity> {
    const snap = await this.catalogService.getMatrixPricingSnapshot(
      tallerId ?? undefined,
    );
    const analysis = this.inventoryToAnalysis(inventory, row.damageAnalysis);

    const existingPrices = new Map<string, number>();
    for (const it of row.items ?? []) {
      existingPrices.set(this.piezaMatchKey(it.pieza), it.precioMx);
    }

    const quoteRows: QuoteRowInput[] = inventory.map((it) => {
      const canonical =
        snap.matchServicio(resolveMatrixServicioRaw(it.pieza)) ?? it.pieza;
      const sev = coerceDamageLevelCode(it.severidad);
      const key = this.piezaMatchKey(it.pieza);
      const override = priceOverrides?.get(key);
      const stored = existingPrices.get(key);
      const precioMx =
        override != null
          ? override
          : stored != null
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
        pieza: analysis.pieza,
        severidad: analysis.severidad,
        partesAfectadas: [...analysis.partesAfectadas],
        severidadDelDano: analysis.severidadDelDano,
        descripcionTecnica: analysis.descripcionTecnica,
        justificacion: analysis.justificacion,
        inventory: analysis.inventory,
      },
    };

    const quotePayloadForClient =
      normalizeDraftQuoteForClient(quotePayload) ?? quotePayload;

    row.damageAnalysis = analysis;
    row.estimateAmount = total;
    row.quotePayload = quotePayloadForClient;
    if (row.status === DRAFT_QUOTE_STATUS_AWAITING_VEHICLE && total > 0) {
      row.status = 'PENDING_APPROVAL';
    }

    const saved = await this.draftQuoteRepository.save(row);
    await this.syncDraftQuoteLineItems(
      saved.id,
      analysis,
      quotePayloadForClient,
      tallerId,
    );

    const withItems = await this.draftQuoteRepository.findOne({
      where: { id: saved.id },
      relations: { items: true },
    });
    return withItems ?? saved;
  }

  private async syncDraftQuoteLineItems(
    draftQuoteId: string,
    analysis: VehicleDamageAnalysis,
    doc: DraftQuote,
    tallerId: string | null,
  ): Promise<void> {
    await this.draftQuoteItemRepository.delete({ draftQuoteId });
    const inv = analysis.inventory ?? [];
    const lines = doc.lines ?? [];
    if (!inv.length) return;

    const rows: Partial<DraftQuoteItem>[] = inv.map((it, idx) => {
      const line = lines[idx];
      return {
        draftQuoteId,
        sortOrder: idx,
        pieza: normalizePanelPiezaCode(it.pieza) || it.pieza,
        severidad: coerceDamageLevelCode(it.severidad),
        precioMx: Math.round(
          Number(line?.subtotal ?? line?.unitPrice ?? 0),
        ),
        descripcionTecnica: it.descripcionTecnica ?? null,
        urlsOrigen:
          Array.isArray(it.urls_origen) && it.urls_origen.length > 0
            ? [...it.urls_origen]
            : null,
      };
    });

    if (rows.length) {
      await this.draftQuoteItemRepository.insert(rows);
    }
  }

  private buildStateDto(
    row: DraftQuoteEntity,
    creadaEnEstaLlamada = false,
  ): DraftQuoteStateDto {
    const payload = row.quotePayload;
    const desglose = this.desgloseFromDraftRow(row);
    const totalFromDesglose = sumDesglosePrecios(desglose);
    const lineRows = desglose.map((d) => ({
      pieza: d.pieza,
      precioMx: d.precio,
    }));
    const itemsFromDb = row.items ?? [];

    const items: DraftQuoteItemDto[] =
      itemsFromDb.length > 0
        ? itemsFromDb.map((it) => ({
            pieza: this.displayPiezaLabel(it.pieza),
            piezaCanonical: it.pieza,
            severidad: it.severidad,
            precioMx: it.precioMx,
            descripcionTecnica: it.descripcionTecnica ?? '',
          }))
        : lineRows.map((lr, idx) => {
            const inv = payload?.analysisBasis?.inventory?.[idx];
            return {
              pieza: lr.pieza,
              piezaCanonical: lr.pieza,
              severidad: inv?.severidad ?? 'DL',
              precioMx: lr.precioMx,
              descripcionTecnica: inv?.descripcionTecnica ?? '',
            };
          });

    return {
      draftQuoteId: row.id,
      reference: payload?.reference ?? '',
      status: row.status,
      moneda: AUTO_FIX_CURRENCY,
      itemCount: items.length,
      items,
      subtotalMx: totalFromDesglose,
      totalMx: totalFromDesglose,
      ...(creadaEnEstaLlamada ? { creadaEnEstaLlamada: true } : {}),
    };
  }

  private buildClienteResumen(
    cotizacion: DraftQuoteStateDto,
    contactName?: string,
  ): { texto: string; lineas: string[] } {
    const name = String(contactName ?? '').trim() || 'cliente';
    const lineas = cotizacion.items.map((it) =>
      formatDraftQuoteLineToolEmoji(it.pieza, it.precioMx),
    );

    if (cotizacion.itemCount === 0) {
      return {
        lineas: [],
        texto: `Aún no hay servicios en tu cotización, ${name}. Cuando me indiques las piezas a reparar, te voy armando el desglose.`,
      };
    }

    const totalFmt = formatAutoFixMoney(cotizacion.totalMx);
    const texto = [
      `Aquí tienes el resumen de tu cotización, ${name}:`,
      '',
      ...lineas,
      '',
      `💰 Inversión total estimada: ${totalFmt} *(sujeto a revisión física en taller)*`,
    ].join('\n');

    return { texto, lineas };
  }
}
