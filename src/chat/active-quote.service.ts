import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { In, Repository } from 'typeorm';
import {
  AUTO_FIX_CURRENCY,
  coerceDamageLevelCode,
  damageLevelRank,
  DraftQuote,
  DraftQuoteLine,
  type DamageLevel,
} from './autofix-config';
import { DraftQuoteEntity } from './entities/draft-quote.entity';
import { DraftQuoteItem } from './entities/draft-quote-item.entity';
import {
  DetectedDamageItem,
  Message,
  VehicleDamageAnalysis,
} from './entities/chat.entity';
import { CatalogService } from '../catalog/catalog.service';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import {
  findPanelPiezaOption,
  isSpecialPanelPieza,
  normalizePanelPiezaCode,
  resolveMatrixServicioRaw,
} from '../catalog/panel-pieza-catalog';
import {
  buildDraftQuoteLineFromQuoteRow,
  sumQuoteRowsSubtotal,
  type QuoteRowInput,
} from './draft-quote-inventory-pricing';
import { normalizeDraftQuoteForClient } from './draft-quote-client-payload';
import { ChatGateway } from './chat.gateway';
import {
  DRAFT_QUOTE_STATUS_ACTIVE,
  PROGRESSIVE_QUOTE_STATUSES,
} from './active-quote.constants';
import {
  buildActiveQuoteSummaryLines,
  formatActiveQuoteSummaryForPrompt,
} from './active-quote-summary';
import {
  normalizeCategoriaTamanoExpress,
  resolveCategoriaTamanoToBañoSeveridad,
  servicioSolicitudLooksLikeBano,
} from './autopilot-cotizacion-express';
import {
  isBañoDePinturaServicio,
  materializeInstantQuoteResolution,
  resolveBañoCanonicalFromSnap,
} from './instant-quote-from-text';

export type AddItemToQuoteResult = {
  success: boolean;
  error?: string;
  piezaAgregada?: string;
  precioPieza?: number;
  nuevoTotalGlobal?: number;
  resumen?: string;
  yaExistia?: boolean;
  draftQuoteId?: string;
};

export type ActiveQuoteSummaryResult = {
  vacia: boolean;
  resumen: string;
  total?: number;
  itemCount?: number;
  draftQuoteId?: string;
};

function pickVehicleFromAnalysis(analysis: VehicleDamageAnalysis): string | null {
  const v = String(analysis.vehiculoDetectado ?? '').trim();
  return v || null;
}

function buildMinimalAnalysisFromInventory(
  items: DetectedDamageItem[],
  vehicleLabel?: string | null,
): VehicleDamageAnalysis {
  const partes = [...new Set(items.map((i) => i.pieza).filter(Boolean))];
  const worst = items.reduce<DamageLevel>((acc, it) => {
    const c = coerceDamageLevelCode(it.severidad);
    return damageLevelRank(c) > damageLevelRank(acc) ? c : acc;
  }, 'DL' as DamageLevel);
  const piezaLabel =
    partes.length === 1
      ? partes[0]!
      : partes.length > 1
        ? `${partes.slice(0, 2).join(' + ')}${partes.length > 2 ? ` (+${partes.length - 2} más)` : ''}`
        : 'Estética exterior';
  const desc = items
    .map(
      (it) =>
        `• ${it.pieza} (${coerceDamageLevelCode(it.severidad)}): ${it.descripcionTecnica}`,
    )
    .join('\n');

  return {
    pieza: piezaLabel,
    severidad: worst,
    severidadDelDano: worst,
    descripcionTecnica: desc || 'Cotización progresiva en chat.',
    justificacion: `Cotización progresiva (${items.length} servicio(s)).`,
    partesAfectadas: partes.length ? partes : ['Estética exterior'],
    inventory: items.map((it) => ({
      pieza: it.pieza,
      severidad: it.severidad,
      descripcionTecnica: it.descripcionTecnica,
      urls_origen: [...(it.urls_origen ?? [])],
    })),
    ...(vehicleLabel?.trim()
      ? { vehiculoDetectado: vehicleLabel.trim() }
      : {}),
  };
}

function emptyActiveQuotePayload(reference: string): DraftQuote {
  const generatedAt = new Date().toISOString();
  return {
    status: DRAFT_QUOTE_STATUS_ACTIVE,
    currency: AUTO_FIX_CURRENCY,
    reference,
    generatedAt,
    lines: [],
    subtotal: 0,
    total: 0,
    formalNarrative: '',
    analysisBasis: {
      pieza: 'Estética exterior',
      severidad: 'DL',
      partesAfectadas: [],
      severidadDelDano: 'DL',
      descripcionTecnica: '',
      justificacion: 'Cotización progresiva iniciada en chat.',
      inventory: [],
    },
  };
}

@Injectable()
export class ActiveQuoteService {
  constructor(
    @InjectRepository(DraftQuoteEntity)
    private readonly draftQuoteRepository: Repository<DraftQuoteEntity>,
    @InjectRepository(DraftQuoteItem)
    private readonly draftQuoteItemRepository: Repository<DraftQuoteItem>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    private readonly catalogService: CatalogService,
    private readonly chatGateway: ChatGateway,
  ) {}

  /** Cotización más reciente editable en esta conversación. */
  async getActiveQuote(
    conversationId: string,
  ): Promise<DraftQuoteEntity | null> {
    const row = await this.draftQuoteRepository.findOne({
      where: {
        conversationId,
        status: In([...PROGRESSIVE_QUOTE_STATUSES]),
      },
      order: { createdAt: 'DESC' },
      relations: { items: true },
    });
    if (!row) return null;
    row.items?.sort((a, b) => a.sortOrder - b.sortOrder);
    return row;
  }

  /** Resumen textual para tools / prompt. */
  async getQuoteSummary(
    conversationId: string,
  ): Promise<ActiveQuoteSummaryResult> {
    const quote = await this.getActiveQuote(conversationId);
    if (!quote?.items?.length) {
      return {
        vacia: true,
        resumen: formatActiveQuoteSummaryForPrompt({
          lines: [],
          totalMx: 0,
        }),
      };
    }
    const lines = buildActiveQuoteSummaryLines(quote.items);
    const total = Math.round(
      Number(quote.quotePayload?.total ?? quote.estimateAmount ?? 0),
    );
    return {
      vacia: false,
      resumen: formatActiveQuoteSummaryForPrompt({
        lines,
        totalMx: total,
        vehicleLabel: pickVehicleFromAnalysis(quote.damageAnalysis),
        reference: quote.quotePayload?.reference ?? null,
      }),
      total,
      itemCount: lines.length,
      draftQuoteId: quote.id,
    };
  }

  /**
   * Añade (o actualiza precio de) una pieza/servicio en la cotización activa.
   * Si no existe borrador, crea uno con status ACTIVE.
   */
  async addItemToQuote(params: {
    conversationId: string;
    tallerId?: string | null;
    pieza: string;
    precio?: number;
    categoria?: string;
    vehicleModel?: string;
  }): Promise<AddItemToQuoteResult> {
    const piezaInput = String(params.pieza ?? '').trim();
    if (!piezaInput) {
      return { success: false, error: 'Falta el parámetro pieza.' };
    }

    const isBano = servicioSolicitudLooksLikeBano(piezaInput);
    if (!isBano && isSpecialPanelPieza(piezaInput)) {
      return {
        success: false,
        error:
          'Solo piezas estéticas del catálogo o baño de pintura. Refacciones y daños internos van por otro flujo.',
      };
    }

    const panelOpt = isBano ? null : findPanelPiezaOption(piezaInput);
    if (!isBano && !panelOpt) {
      return {
        success: false,
        error: `No reconozco la pieza "${piezaInput}". Pide al cliente que la nombre como en el taller.`,
      };
    }

    const snap = await this.catalogService.getMatrixPricingSnapshot(
      params.tallerId ?? undefined,
    );

    const priced = this.resolveItemPricing(
      snap,
      piezaInput,
      params.precio,
      params.categoria,
    );
    if (!priced.ok) {
      return { success: false, error: priced.error };
    }

    let row = await this.getActiveQuote(params.conversationId);
    if (!row) {
      row = await this.createActiveQuoteShell(
        params.conversationId,
        params.tallerId ?? null,
        params.vehicleModel ?? null,
      );
    }

    const panelCode = isBano ? 'BPC' : normalizePanelPiezaCode(piezaInput);
    const displayName = isBano
      ? 'Baño de Pintura Exterior'
      : panelOpt!.fullName;

    const existingItems = [...(row.items ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    const dupIdx = existingItems.findIndex(
      (it) =>
        normalizePanelPiezaCode(it.pieza) === panelCode &&
        String(it.severidad) === priced.severidad,
    );
    if (dupIdx >= 0) {
      const dup = existingItems[dupIdx]!;
      return {
        success: true,
        yaExistia: true,
        piezaAgregada: displayName,
        precioPieza: dup.precioMx,
        nuevoTotalGlobal: Math.round(
          Number(row.quotePayload?.total ?? row.estimateAmount ?? 0),
        ),
        resumen: (
          await this.getQuoteSummary(params.conversationId)
        ).resumen,
        draftQuoteId: row.id,
      };
    }

    const nextSortOrder =
      existingItems.length > 0
        ? Math.max(...existingItems.map((i) => i.sortOrder)) + 1
        : 0;

    const newInvItem: DetectedDamageItem = {
      pieza: displayName,
      severidad: priced.severidad,
      descripcionTecnica: isBano
        ? `Baño de pintura (${priced.severidad}) — cotización progresiva.`
        : 'Repintado express — daño leve (cotización progresiva).',
      urls_origen: [],
    };

    const prevInv = row.damageAnalysis?.inventory ?? [];
    const mergedInventory = [...prevInv, newInvItem];
    const vehicleLabel =
      params.vehicleModel?.trim() ||
      pickVehicleFromAnalysis(row.damageAnalysis) ||
      null;
    const analysisMerged = buildMinimalAnalysisFromInventory(
      mergedInventory,
      vehicleLabel,
    );

    await this.draftQuoteItemRepository.insert({
      draftQuoteId: row.id,
      sortOrder: nextSortOrder,
      pieza: panelCode,
      severidad: priced.severidad,
      precioMx: priced.precio,
      descripcionTecnica: newInvItem.descripcionTecnica,
      urlsOrigen: null,
    });

    const allItems = [
      ...existingItems,
      {
        pieza: panelCode,
        severidad: priced.severidad,
        precioMx: priced.precio,
      } as DraftQuoteItem,
    ];

    const linesDto: QuoteRowInput[] = allItems.map((it) => ({
      pieza: it.pieza,
      severidad: it.severidad,
      precioMx: it.precioMx,
    }));
    const manualLines: DraftQuoteLine[] = linesDto.map((L, idx) =>
      buildDraftQuoteLineFromQuoteRow(L, idx, snap),
    );
    const nuevoTotalGlobal = sumQuoteRowsSubtotal(linesDto);

    const quotePayload: DraftQuote = {
      ...row.quotePayload,
      status:
        row.status === 'APPROVED'
          ? 'APPROVED'
          : row.status === 'PENDING_APPROVAL'
            ? 'PENDING_APPROVAL'
            : DRAFT_QUOTE_STATUS_ACTIVE,
      lines: manualLines,
      subtotal: nuevoTotalGlobal,
      total: nuevoTotalGlobal,
      analysisBasis: {
        ...row.quotePayload.analysisBasis,
        inventory: mergedInventory.map((it) => ({
          pieza: it.pieza,
          severidad: it.severidad,
          descripcionTecnica: it.descripcionTecnica,
          urls_origen: it.urls_origen ?? [],
        })),
      },
    };
    const quotePayloadForClient =
      normalizeDraftQuoteForClient(quotePayload) ?? quotePayload;

    row.damageAnalysis = analysisMerged;
    row.estimateAmount = nuevoTotalGlobal;
    row.quotePayload = quotePayloadForClient;
    if (row.status !== 'APPROVED' && row.status !== 'PENDING_APPROVAL') {
      row.status = DRAFT_QUOTE_STATUS_ACTIVE;
    }
    const saved = await this.draftQuoteRepository.save(row);

    if (saved.messageId) {
      await this.messageRepository.update(
        { id: saved.messageId },
        {
          damageAnalysis: analysisMerged,
          draftQuote: quotePayloadForClient,
        },
      );
    }

    const summary = formatActiveQuoteSummaryForPrompt({
      lines: buildActiveQuoteSummaryLines(allItems),
      totalMx: nuevoTotalGlobal,
      vehicleLabel,
      reference: quotePayloadForClient.reference,
    });

    this.chatGateway.emitActiveQuoteUpdated({
      draftQuoteId: saved.id,
      conversationId: params.conversationId,
      messageId: saved.messageId,
      draftQuote: quotePayloadForClient,
      damageAnalysis: analysisMerged,
      estimateAmount: nuevoTotalGlobal,
      piezaAgregada: displayName,
      precioPieza: priced.precio,
      nuevoTotalGlobal,
      resumen: summary,
    });

    return {
      success: true,
      piezaAgregada: displayName,
      precioPieza: priced.precio,
      nuevoTotalGlobal,
      resumen: summary,
      draftQuoteId: saved.id,
    };
  }

  private async createActiveQuoteShell(
    conversationId: string,
    tallerId: string | null,
    vehicleModel: string | null,
  ): Promise<DraftQuoteEntity> {
    const reference = `COT-AF-${randomUUID().slice(0, 8).toUpperCase()}`;
    const payload = emptyActiveQuotePayload(reference);
    const analysis = buildMinimalAnalysisFromInventory([], vehicleModel);
    const row = this.draftQuoteRepository.create({
      conversationId,
      tallerId,
      messageId: null,
      imageUrl: '',
      damageAnalysis: analysis,
      estimateAmount: 0,
      quotePayload: payload,
      status: DRAFT_QUOTE_STATUS_ACTIVE,
    });
    return this.draftQuoteRepository.save(row);
  }

  private resolveItemPricing(
    snap: MatrixPricingSnapshot,
    piezaInput: string,
    precioOverride?: number,
    categoriaRaw?: string,
  ):
    | { ok: true; precio: number; severidad: string }
    | { ok: false; error: string } {
    const override = Number(precioOverride);
    if (Number.isFinite(override) && override > 0) {
      return {
        ok: true,
        precio: Math.round(override),
        severidad: servicioSolicitudLooksLikeBano(piezaInput)
          ? normalizeCategoriaTamanoExpress(categoriaRaw ?? '') ?? 'Mediano'
          : 'DL',
      };
    }

    if (servicioSolicitudLooksLikeBano(piezaInput)) {
      const categoria = normalizeCategoriaTamanoExpress(categoriaRaw ?? '');
      if (!categoria) {
        return {
          ok: false,
          error:
            'Para baño de pintura indica categoria (Chico, Mediano, Grande o Premium) o un precio explícito.',
        };
      }
      const banoCanonical = resolveBañoCanonicalFromSnap(snap);
      if (!banoCanonical) {
        return { ok: false, error: 'Baño de pintura no disponible en catálogo.' };
      }
      const allowed = snap.listSeveridadesForCanonical(banoCanonical);
      const sevFinal =
        resolveCategoriaTamanoToBañoSeveridad(categoria, allowed) ??
        allowed[0];
      if (!sevFinal) {
        return { ok: false, error: 'Sin severidad de catálogo para baño.' };
      }
      const resolution = materializeInstantQuoteResolution(snap, {
        canonical: banoCanonical,
        severidadLiteral: sevFinal,
        tierSourceForCambioColor: piezaInput,
        resolveVia: 'bano_pintura_synonym',
      });
      if (!resolution?.lines.length) {
        return {
          ok: false,
          error: 'No se pudo calcular precio de baño de pintura.',
        };
      }
      const total = resolution.lines.reduce((s, l) => s + l.amount, 0);
      return {
        ok: true,
        precio: Math.round(total),
        severidad: sevFinal,
      };
    }

    const matrixRaw = resolveMatrixServicioRaw(piezaInput);
    const canonical = snap.matchServicio(matrixRaw) ?? matrixRaw;
    if (isBañoDePinturaServicio(canonical)) {
      return {
        ok: false,
        error: 'Usa "baño de pintura" con categoria para pintura completa.',
      };
    }
    const precio = Math.round(snap.getAmount(canonical, 'DL'));
    if (!Number.isFinite(precio) || precio <= 0) {
      return {
        ok: false,
        error: `No hay precio DL en catálogo para "${piezaInput}".`,
      };
    }
    return { ok: true, precio, severidad: 'DL' };
  }
}
