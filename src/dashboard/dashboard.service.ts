import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from '../chat/entities/conversation.entity';
import { LeadEventEntity } from '../chat/entities/lead-event.entity';

export type DashboardKpis = {
  leadsAtendidos: number;
  cotizaciones: number;
  citas: number;
  llegaron: number;
  trabajosVendidos: number;
  ventasGeneradas: number;
  roiPegazuz: number;
};

/** Costo mensual estándar Pegazuz (MXN) si no hay `PEGAZUZ_BASE_COST`. */
const DEFAULT_PEGAZUZ_BASE_COST = 4990;

export type HotLeadRow = {
  conversationId: string;
  contactName: string;
  lastEventAt: string;
  total: number;
};

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(LeadEventEntity)
    private readonly leadEventRepository: Repository<LeadEventEntity>,
  ) {}

  async getKpis(tallerId: string): Promise<DashboardKpis> {
    const tid = String(tallerId ?? '').trim();
    if (!tid) {
      return {
        leadsAtendidos: 0,
        cotizaciones: 0,
        citas: 0,
        llegaron: 0,
        trabajosVendidos: 0,
        ventasGeneradas: 0,
        roiPegazuz: 0,
      };
    }

    const [
      leadsAtendidos,
      cotizaciones,
      citas,
      llegaron,
      trabajosVendidos,
      ventasCompletado,
      ventasEnTaller,
    ] = await Promise.all([
      this.conversationRepository.count({ where: { tallerId: tid } }),
      this.countLeadEventsByStatus(tid, ['cotizado']),
      this.countLeadEventsByStatus(tid, ['agendado']),
      this.countLeadEventsByStatus(tid, ['atendido']),
      this.countLeadEventsByStatus(tid, ['en_taller', 'completado']),
      this.sumLeadEventTotals(tid, ['completado']),
      this.sumLeadEventTotals(tid, ['en_taller']),
    ]);

    const ventasGeneradas =
      ventasCompletado > 0 ? ventasCompletado : ventasEnTaller;
    const costoBase = this.resolvePegazuzBaseCost();
    const roiPegazuz =
      costoBase > 0
        ? Math.round((ventasGeneradas / costoBase) * 10) / 10
        : 0;

    return {
      leadsAtendidos,
      cotizaciones,
      citas,
      llegaron,
      trabajosVendidos,
      ventasGeneradas,
      roiPegazuz,
    };
  }

  async getHotLeads(tallerId: string, limit = 10): Promise<HotLeadRow[]> {
    const tid = String(tallerId ?? '').trim();
    const take = Math.min(100, Math.max(1, Math.floor(Number(limit) || 10)));

    const latestCotizado = this.latestCotizadoSubquery(tid, 'cotizado');

    const rows = await this.leadEventRepository.manager
      .createQueryBuilder()
      .select('latest."conversationId"', 'conversationId')
      .addSelect('latest."contactName"', 'contactName')
      .addSelect('latest."lastEventAt"', 'lastEventAt')
      .addSelect('latest."total"', 'total')
      .from(`(${latestCotizado.getQuery()})`, 'latest')
      .setParameters(latestCotizado.getParameters())
      .orderBy('latest."total"', 'DESC', 'NULLS LAST')
      .addOrderBy('latest."lastEventAt"', 'DESC')
      .limit(take)
      .getRawMany<{
        conversationId: string;
        contactName: string;
        lastEventAt: Date | string;
        total: string | number | null;
      }>();

    return rows.map((row) => ({
      conversationId: String(row.conversationId),
      contactName: String(row.contactName ?? ''),
      lastEventAt:
        row.lastEventAt instanceof Date
          ? row.lastEventAt.toISOString()
          : new Date(row.lastEventAt).toISOString(),
      total: this.toMoney(row.total),
    }));
  }

  /**
   * Último evento `cotizado` por conversación (DISTINCT ON), con
   * CAST(metadata->>'total' AS NUMERIC).
   */
  private latestCotizadoSubquery(tallerId: string, conversationStatus: string) {
    return this.leadEventRepository
      .createQueryBuilder('event')
      .innerJoin('event.conversation', 'conv')
      .select('event.conversationId', 'conversationId')
      .addSelect('conv.contactName', 'contactName')
      .addSelect('event.createdAt', 'lastEventAt')
      .addSelect(
        `CAST(NULLIF(TRIM(event.metadata->>'total'), '') AS NUMERIC)`,
        'total',
      )
      .distinctOn(['event.conversationId'])
      .where('event.status = :eventStatus', { eventStatus: 'cotizado' })
      .andWhere('conv.status = :conversationStatus', { conversationStatus })
      .andWhere('conv.tallerId = :tallerId', { tallerId })
      .orderBy('event.conversationId', 'ASC')
      .addOrderBy('event.createdAt', 'DESC');
  }

  private async countLeadEventsByStatus(
    tallerId: string,
    statuses: string[],
  ): Promise<number> {
    if (!tallerId || statuses.length === 0) return 0;
    return this.leadEventRepository
      .createQueryBuilder('event')
      .innerJoin('event.conversation', 'conv')
      .where('conv.tallerId = :tallerId', { tallerId })
      .andWhere('event.status IN (:...statuses)', { statuses })
      .getCount();
  }

  private async sumLeadEventTotals(
    tallerId: string,
    statuses: string[],
  ): Promise<number> {
    if (!tallerId || statuses.length === 0) return 0;
    const row = await this.leadEventRepository
      .createQueryBuilder('event')
      .innerJoin('event.conversation', 'conv')
      .select(
        `COALESCE(SUM(CAST(NULLIF(TRIM(event.metadata->>'total'), '') AS NUMERIC)), 0)`,
        'sum',
      )
      .where('conv.tallerId = :tallerId', { tallerId })
      .andWhere('event.status IN (:...statuses)', { statuses })
      .getRawOne<{ sum: string | number | null }>();
    return this.toMoney(row?.sum);
  }

  private resolvePegazuzBaseCost(): number {
    const raw = Number(String(process.env.PEGAZUZ_BASE_COST ?? '').trim());
    if (Number.isFinite(raw) && raw > 0) return raw;
    return DEFAULT_PEGAZUZ_BASE_COST;
  }

  private toMoney(value: string | number | null | undefined): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n);
  }
}
