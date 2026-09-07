import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from '../chat/entities/conversation.entity';
import { LeadEventEntity } from '../chat/entities/lead-event.entity';

export type DashboardKpis = {
  pipelineActivo: number;
  leadsNuevos: number;
  tasaConversion: number;
  valorEnPatio: number;
};

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
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [pipelineActivo, leadsNuevos, valorEnPatio, conversion] =
      await Promise.all([
        this.sumLatestCotizadoTotal(tid, 'cotizado'),
        this.countConversationsByStatus(tid, 'nuevo'),
        this.sumLatestCotizadoTotal(tid, 'en_taller'),
        this.conversionRateLast30Days(tid, since),
      ]);

    return {
      pipelineActivo,
      leadsNuevos,
      tasaConversion: conversion,
      valorEnPatio,
    };
  }

  async getHotLeads(tallerId: string, limit = 10): Promise<HotLeadRow[]> {
    const tid = String(tallerId ?? '').trim();
    const take = Math.min(100, Math.max(1, Math.floor(Number(limit) || 10)));

    const latestCotizado = this.latestCotizadoSubquery(tid, 'cotizado');

    const rows = await this.leadEventRepository.manager
      .createQueryBuilder()
      .select('latest.conversationId', 'conversationId')
      .addSelect('latest.contactName', 'contactName')
      .addSelect('latest.lastEventAt', 'lastEventAt')
      .addSelect('latest.total', 'total')
      .from(`(${latestCotizado.getQuery()})`, 'latest')
      .setParameters(latestCotizado.getParameters())
      .orderBy('latest.total', 'DESC', 'NULLS LAST')
      .addOrderBy('latest.lastEventAt', 'DESC')
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

  private async sumLatestCotizadoTotal(
    tallerId: string,
    conversationStatus: string,
  ): Promise<number> {
    if (!tallerId) return 0;
    const latest = this.latestCotizadoSubquery(tallerId, conversationStatus);
    const row = await this.leadEventRepository.manager
      .createQueryBuilder()
      .select('COALESCE(SUM(latest.total), 0)', 'sum')
      .from(`(${latest.getQuery()})`, 'latest')
      .setParameters(latest.getParameters())
      .getRawOne<{ sum: string | number | null }>();
    return this.toMoney(row?.sum);
  }

  private async countConversationsByStatus(
    tallerId: string,
    status: string,
  ): Promise<number> {
    if (!tallerId) return 0;
    return this.conversationRepository.count({
      where: { tallerId, status },
    });
  }

  /**
   * % de conversaciones con evento `nuevo` en los últimos 30 días
   * que también tienen al menos un evento `agendado`.
   * (Conversation no tiene createdAt; el alta se registra en lead_events.)
   */
  private async conversionRateLast30Days(
    tallerId: string,
    since: Date,
  ): Promise<number> {
    if (!tallerId) return 0;

    const created = this.conversationRepository
      .createQueryBuilder('conv')
      .innerJoin(
        LeadEventEntity,
        'nuevo',
        `nuevo.conversationId = conv.id AND nuevo.status = :nuevoStatus`,
      )
      .where('conv.tallerId = :tallerId', { tallerId })
      .andWhere('nuevo.createdAt >= :since', { since })
      .setParameter('nuevoStatus', 'nuevo');

    const createdRow = await created
      .clone()
      .select('COUNT(DISTINCT conv.id)', 'cnt')
      .getRawOne<{ cnt: string | number }>();

    const convertedRow = await created
      .clone()
      .innerJoin(
        LeadEventEntity,
        'agendado',
        `agendado.conversationId = conv.id AND agendado.status = :agendadoStatus`,
      )
      .setParameter('agendadoStatus', 'agendado')
      .select('COUNT(DISTINCT conv.id)', 'cnt')
      .getRawOne<{ cnt: string | number }>();

    const createdCount = Number(createdRow?.cnt ?? 0) || 0;
    const convertedCount = Number(convertedRow?.cnt ?? 0) || 0;
    if (createdCount <= 0) return 0;
    return Math.round((convertedCount / createdCount) * 1000) / 10;
  }

  private toMoney(value: string | number | null | undefined): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n);
  }
}
