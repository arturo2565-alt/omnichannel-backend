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
    const { row, created } = await this.getOrCreateActiveDraft(
      conversationId,
      tallerId,
    );
    const cotizacion = this.buildStateDto(row, created);
    return { success: true, cotizacion };
  }

  /** Agrega daño leve (DL) a la cotización activa. Idempotente si la pieza ya está. */
  async agregarServicioLeve(
    conversationId: string,
    tallerId: string | null,
    pieza: string,
    descripcionTecnica?: string,
  ): Promise<DraftQuoteToolResult> {
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
      return {
        success: true,
        yaExistia: true,
        cotizacion: this.buildStateDto(saved ?? row),
      };
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
    return {
      success: true,
      accion: 'agregar',
      cotizacion: this.buildStateDto(saved),
    };
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

    const snap = await this.catalogService.getMatrixPricingSnapshot(
      tallerId ?? undefined,
    );
    const resolved = this.resolvePiezaInCatalog(piezaTrim, snap);
    if (!resolved.ok && accionNorm !== 'quitar') {
      return {
        success: false,
        error: resolved.error,
        piezaNoEnCatalogo: true,
        piezasDisponiblesEjemplo: resolved.ejemplos,
      };
    }

    const { row } = await this.getOrCreateActiveDraft(conversationId, tallerId);
    let inventory = this.extractInventory(row);

    if (accionNorm === 'quitar') {
      const { inventory: next, removed } = this.removePiezaFromInventory(
        inventory,
        piezaTrim,
        snap,
      );
      if (!removed) {
        return {
          success: true,
          accion: 'quitar',
          noEncontrada: true,
          cotizacion: this.buildStateDto(row),
        };
      }
      inventory = next;
    } else if (accionNorm === 'agregar') {
      const canonical = resolved.ok ? resolved.canonical : piezaTrim;
      const displayPieza = resolved.ok ? resolved.displayPieza : piezaTrim;
      const existingIdx = this.findInventoryIndexByCanonical(
        inventory,
        canonical,
        snap,
      );
      if (existingIdx >= 0) {
        return {
          success: true,
          yaExistia: true,
          accion: 'agregar',
          cotizacion: this.buildStateDto(row),
        };
      }

      const sev = coerceDamageLevelCode(
        opts?.severidad ?? LIGHT_DAMAGE_SEVERITY,
      );
      const precioMx =
        opts?.precio != null && Number.isFinite(opts.precio) && opts.precio >= 0
          ? Math.round(opts.precio)
          : snap.getAmount(canonical, sev);

      if (precioMx <= 0) {
        return {
          success: false,
          error: `No hay precio de catálogo para ${canonical} (${sev}). Indica precio manual o revisa la pieza.`,
        };
      }

      inventory.push({
        pieza: displayPieza,
        severidad: sev,
        descripcionTecnica:
          String(opts?.descripcionTecnica ?? '').trim() ||
          `Servicio ${sev} en ${displayPieza}.`,
        urls_origen: [],
      });
    } else {
      const idx = this.findInventoryIndexByCanonical(
        inventory,
        resolved.ok ? resolved.canonical : piezaTrim,
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
      const canonical =
        snap.matchServicio(resolveMatrixServicioRaw(current.pieza)) ??
        current.pieza;
      const precioMx =
        opts?.precio != null && Number.isFinite(opts.precio) && opts.precio >= 0
          ? Math.round(opts.precio)
          : snap.getAmount(canonical, sev);

      if (precioMx <= 0) {
        return {
          success: false,
          error: `No hay precio válido para actualizar ${canonical} (${sev}).`,
        };
      }

      inventory[idx] = {
        ...current,
        severidad: sev,
        descripcionTecnica:
          String(opts?.descripcionTecnica ?? '').trim() ||
          current.descripcionTecnica,
      };
    }

    const saved = await this.persistInventoryChanges(row, inventory, tallerId);
    return {
      success: true,
      accion: accionNorm,
      cotizacion: this.buildStateDto(saved),
    };
  }

  /** Elimina una pieza de la cotización. Idempotente si no existe. */
  async eliminarServicioDeCotizacion(
    conversationId: string,
    tallerId: string | null,
    pieza: string,
  ): Promise<DraftQuoteToolResult> {
    const piezaTrim = String(pieza ?? '').trim();
    if (!piezaTrim) {
      return { success: false, error: 'Falta el parámetro pieza.' };
    }

    const snap = await this.catalogService.getMatrixPricingSnapshot(
      tallerId ?? undefined,
    );
    const { row } = await this.getOrCreateActiveDraft(conversationId, tallerId);
    const inventory = this.extractInventory(row);
    const { inventory: next, removed } = this.removePiezaFromInventory(
      inventory,
      piezaTrim,
      snap,
    );

    if (!removed) {
      return {
        success: true,
        noEncontrada: true,
        accion: 'quitar',
        cotizacion: this.buildStateDto(row),
      };
    }

    const saved = await this.persistInventoryChanges(row, next, tallerId);
    return {
      success: true,
      accion: 'quitar',
      cotizacion: this.buildStateDto(saved),
    };
  }

  /** Texto formateado listo para mostrar al cliente. */
  async obtenerResumenCotizacion(
    conversationId: string,
    tallerId: string | null,
    contactName?: string,
  ): Promise<DraftQuoteToolResult> {
    const { row } = await this.getOrCreateActiveDraft(conversationId, tallerId);
    const cotizacion = this.buildStateDto(row);
    const resumen = this.buildClienteResumen(cotizacion, contactName);
    return {
      success: true,
      cotizacion,
      resumenCliente: resumen.texto,
      resumenLineas: resumen.lineas,
    };
  }

  // --- Internos ---

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
  ): Promise<DraftQuoteEntity> {
    const snap = await this.catalogService.getMatrixPricingSnapshot(
      tallerId ?? undefined,
    );
    const analysis = this.inventoryToAnalysis(inventory, row.damageAnalysis);

    const quoteRows: QuoteRowInput[] = inventory.map((it) => {
      const canonical =
        snap.matchServicio(resolveMatrixServicioRaw(it.pieza)) ?? it.pieza;
      const sev = coerceDamageLevelCode(it.severidad);
      const precioMx = snap.getAmount(canonical, sev);
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
    const lineRows = draftQuoteLinesToClientePiezaRows(payload?.lines ?? []);
    const itemsFromDb = row.items ?? [];

    const items: DraftQuoteItemDto[] =
      itemsFromDb.length > 0
        ? itemsFromDb.map((it) => ({
            pieza: it.pieza,
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
      subtotalMx: payload?.subtotal ?? 0,
      totalMx: payload?.total ?? 0,
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
