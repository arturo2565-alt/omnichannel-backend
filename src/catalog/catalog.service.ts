import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PriceMatrix } from './entities/price-matrix.entity';
import {
  createMatrixPricingSnapshot,
  type MatrixPricingSnapshot,
} from './matrix-pricing-snapshot';
import { buildFlatRowsFromLegacyFrontendMatrix } from './legacy-price-matrix-import';
import {
  syncInstantServiceFlags,
  upsertInstantQuoteMatrixRows,
} from './instant-quote-matrix-sync';
import { TallerService } from '../taller/taller.service';
import {
  aggregatePieceBaseRows,
  mergeCatalogPricingRules,
  PIECE_BASE_SEVERITY,
  type CatalogPricingRules,
} from './catalog-pricing-rules';
import { CatalogPricingRulesEntity } from './entities/catalog-pricing-rules.entity';

@Injectable()
export class CatalogService {
  constructor(
    @InjectRepository(PriceMatrix)
    private readonly priceMatrixRepository: Repository<PriceMatrix>,
    @InjectRepository(CatalogPricingRulesEntity)
    private readonly pricingRulesRepository: Repository<CatalogPricingRulesEntity>,
    private readonly tallerService: TallerService,
  ) {}

  private async resolveTallerId(tallerId?: string | null): Promise<string> {
    if (tallerId?.trim()) return tallerId.trim();
    return this.tallerService.findDefaultTallerId();
  }

  async findAllPriceMatrixRows(tallerId?: string | null): Promise<PriceMatrix[]> {
    const tid = await this.resolveTallerId(tallerId);
    return this.priceMatrixRepository.find({
      where: { tallerId: tid },
      order: { servicio: 'ASC', severidad: 'ASC' },
    });
  }

  async getDistinctServicioNamesForPrompt(
    tallerId?: string | null,
  ): Promise<string[]> {
    const tid = await this.resolveTallerId(tallerId);
    const raw = await this.priceMatrixRepository
      .createQueryBuilder('p')
      .select('p.servicio', 'servicio')
      .where('p.tallerId = :tallerId', { tallerId: tid })
      .distinct(true)
      .orderBy('p.servicio', 'ASC')
      .getRawMany<{ servicio: string }>();
    return raw.map((r) => String(r.servicio ?? '').trim()).filter(Boolean);
  }

  async getDistinctPiezaNamesForPrompt(
    tallerId?: string | null,
  ): Promise<string[]> {
    return this.getDistinctServicioNamesForPrompt(tallerId);
  }

  async getMatrixPricingSnapshot(
    tallerId?: string | null,
  ): Promise<MatrixPricingSnapshot> {
    const rows = await this.findAllPriceMatrixRows(tallerId);
    return createMatrixPricingSnapshot(rows);
  }

  async getPricingRules(tallerId?: string | null): Promise<CatalogPricingRules> {
    const tid = await this.resolveTallerId(tallerId);
    const row = await this.pricingRulesRepository.findOne({
      where: { tallerId: tid },
    });
    if (!row?.rulesJson?.trim()) {
      return mergeCatalogPricingRules(null);
    }
    try {
      const parsed = JSON.parse(row.rulesJson) as Partial<CatalogPricingRules>;
      return mergeCatalogPricingRules(parsed);
    } catch {
      return mergeCatalogPricingRules(null);
    }
  }

  async savePricingRules(
    tallerId: string,
    rules: Partial<CatalogPricingRules>,
  ): Promise<CatalogPricingRules> {
    const tid = await this.resolveTallerId(tallerId);
    const merged = mergeCatalogPricingRules(rules);
    const existing = await this.pricingRulesRepository.findOne({
      where: { tallerId: tid },
    });
    const payload = JSON.stringify(merged);
    if (existing) {
      existing.rulesJson = payload;
      await this.pricingRulesRepository.save(existing);
    } else {
      await this.pricingRulesRepository.save(
        this.pricingRulesRepository.create({
          tallerId: tid,
          rulesJson: payload,
        }),
      );
    }
    return merged;
  }

  async getPieceBaseCatalog(tallerId?: string | null) {
    const tid = await this.resolveTallerId(tallerId);
    const rows = await this.findAllPriceMatrixRows(tid);
    const rules = await this.getPricingRules(tid);
    const pieceBases = aggregatePieceBaseRows(rows);
    const baseIds = new Set(
      pieceBases
        .flatMap((p) => [p.matrixRowId, p.legacyRowId])
        .filter((id): id is string => !!id),
    );
    const instantRows = rows
      .filter((r) => !baseIds.has(r.id))
      .map((r) => ({
        id: r.id,
        servicio: r.servicio,
        severidad: r.severidad,
        precio: r.precio,
        diasEntrega: r.diasEntrega,
        isInstantService: r.isInstantService,
      }));
    return { rules, pieceBases, instantRows };
  }

  async upsertPieceBase(
    tallerId: string,
    dto: {
      servicio: string;
      basePrice: number;
      diasEntrega: number;
      matrixRowId?: string | null;
    },
  ): Promise<PriceMatrix> {
    const tid = await this.resolveTallerId(tallerId);
    const servicio = String(dto.servicio ?? '').trim().slice(0, 120);
    if (!servicio) throw new BadRequestException('servicio obligatorio');
    const precio = Math.max(0, Math.round(Number(dto.basePrice) || 0));
    const diasEntrega = Math.max(
      0,
      Math.round(Number(dto.diasEntrega) || 0),
    );

    const rowId = String(dto.matrixRowId ?? '').trim();
    if (rowId) {
      const existing = await this.priceMatrixRepository.findOne({
        where: { id: rowId, tallerId: tid },
      });
      if (existing) {
        existing.precio = precio;
        existing.diasEntrega = diasEntrega;
        existing.severidad = PIECE_BASE_SEVERITY.slice(0, 32);
        return this.priceMatrixRepository.save(existing);
      }
    }

    const byLeve = await this.priceMatrixRepository.findOne({
      where: { tallerId: tid, servicio, severidad: PIECE_BASE_SEVERITY },
    });
    if (byLeve) {
      byLeve.precio = precio;
      byLeve.diasEntrega = diasEntrega;
      return this.priceMatrixRepository.save(byLeve);
    }

    const byDl = await this.priceMatrixRepository.findOne({
      where: { tallerId: tid, servicio, severidad: 'DL' },
    });
    if (byDl) {
      byDl.precio = precio;
      byDl.diasEntrega = diasEntrega;
      byDl.severidad = PIECE_BASE_SEVERITY;
      return this.priceMatrixRepository.save(byDl);
    }

    return this.createRow(tid, {
      servicio,
      severidad: PIECE_BASE_SEVERITY,
      precio,
      diasEntrega,
      isInstantService: false,
    });
  }

  async bulkUpdatePrecioDias(
    tallerId: string,
    updates: Array<{
      id: string;
      precio: number;
      diasEntrega: number;
      isInstantService?: boolean;
    }>,
  ): Promise<PriceMatrix[]> {
    const tid = await this.resolveTallerId(tallerId);
    const ids = updates.map((u) => u.id);
    const existing = await this.priceMatrixRepository.find({
      where: { id: In(ids), tallerId: tid },
    });
    const idSet = new Set(existing.map((r) => r.id));
    for (const u of updates) {
      if (!idSet.has(u.id)) {
        throw new BadRequestException(`Fila no encontrada: ${u.id}`);
      }
    }
    await this.priceMatrixRepository.manager.transaction(async (em) => {
      for (const u of updates) {
        const patch: Partial<PriceMatrix> = {
          precio: u.precio,
          diasEntrega: u.diasEntrega,
        };
        if (typeof u.isInstantService === 'boolean') {
          patch.isInstantService = u.isInstantService;
        }
        await em.update(PriceMatrix, { id: u.id, tallerId: tid }, patch);
      }
    });
    return this.findAllPriceMatrixRows(tid);
  }

  async createRow(
    tallerId: string,
    dto: {
      servicio: string;
      severidad: string;
      precio: number;
      diasEntrega: number;
      isInstantService?: boolean;
    },
  ): Promise<PriceMatrix> {
    const tid = await this.resolveTallerId(tallerId);
    const row = this.priceMatrixRepository.create({
      tallerId: tid,
      servicio: dto.servicio.slice(0, 120),
      severidad: dto.severidad.slice(0, 32),
      precio: dto.precio,
      diasEntrega: dto.diasEntrega,
      isInstantService: dto.isInstantService ?? false,
    });
    const saved = await this.priceMatrixRepository.save(row);
    await syncInstantServiceFlags(this.priceMatrixRepository.manager, tid);
    return saved;
  }

  async seedInstantQuoteMatrixRows(
    tallerId?: string | null,
  ): Promise<{ upserted: number; totalInDb: number }> {
    const tid = await this.resolveTallerId(tallerId);
    const upserted = await upsertInstantQuoteMatrixRows(
      this.priceMatrixRepository,
      tid,
    );
    await syncInstantServiceFlags(this.priceMatrixRepository.manager, tid);
    const totalInDb = await this.priceMatrixRepository.count({
      where: { tallerId: tid },
    });
    return { upserted, totalInDb };
  }

  async importFromLegacyFrontendMirror(
    tallerId: string | null | undefined,
    diasEntregaDefault = 3,
  ): Promise<{ upserted: number; totalInDb: number }> {
    const tid = await this.resolveTallerId(tallerId);
    const flat = buildFlatRowsFromLegacyFrontendMatrix(diasEntregaDefault);
    if (flat.length === 0) {
      return {
        upserted: 0,
        totalInDb: await this.priceMatrixRepository.count({
          where: { tallerId: tid },
        }),
      };
    }
    await this.priceMatrixRepository.upsert(
      flat.map((r) => ({
        tallerId: tid,
        servicio: r.servicio.slice(0, 120),
        severidad: r.severidad.slice(0, 32),
        precio: r.precio,
        diasEntrega: r.diasEntrega,
        isInstantService: false,
      })),
      {
        conflictPaths: ['tallerId', 'servicio', 'severidad'],
        skipUpdateIfNoValuesChanged: false,
      },
    );
    const totalInDb = await this.priceMatrixRepository.count({
      where: { tallerId: tid },
    });
    await syncInstantServiceFlags(this.priceMatrixRepository.manager, tid);
    return { upserted: flat.length, totalInDb };
  }
}
