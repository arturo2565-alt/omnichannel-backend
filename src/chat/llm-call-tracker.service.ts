import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LlmCall } from './entities/llm-call.entity';
import { estimateLlmCostUsd } from './llm-cost-calculator';
import {
  registerLlmUsageReporter,
  type LlmUsageReportInput,
} from './llm-audit-context';

export type LlmSummaryBucket = {
  key: string;
  calls: number;
  totalTokens: number;
  costUsd: number;
};

export type LlmCallsSummary = {
  totalCalls: number;
  totalTokens: number;
  totalCostUsd: number;
  averageLatencyMs: number;
  costByModel: LlmSummaryBucket[];
  costByPurpose: LlmSummaryBucket[];
  startDate: string;
  endDate: string;
  tallerId: string | null;
};

@Injectable()
export class LlmCallTrackerService implements OnModuleInit, OnModuleDestroy {
  constructor(
    @InjectRepository(LlmCall)
    private readonly llmCallRepository: Repository<LlmCall>,
  ) {}

  onModuleInit(): void {
    registerLlmUsageReporter((input) => this.recordFireAndForget(input));
  }

  onModuleDestroy(): void {
    registerLlmUsageReporter(null);
  }

  /** Persistencia asíncrona: no await en el hot path del LLM. */
  recordFireAndForget(input: LlmUsageReportInput): void {
    void this.persist(input).catch((err) =>
      console.warn('[LlmCallTracker] persist failed:', err),
    );
  }

  async persist(input: LlmUsageReportInput): Promise<LlmCall | null> {
    const promptTokens = Math.max(0, Math.floor(Number(input.promptTokens) || 0));
    const completionTokens = Math.max(
      0,
      Math.floor(Number(input.completionTokens) || 0),
    );
    const cachedTokens = Math.max(0, Math.floor(Number(input.cachedTokens) || 0));
    const totalTokens = Math.max(
      0,
      Math.floor(
        Number(input.totalTokens) || promptTokens + completionTokens,
      ),
    );
    const model = String(input.model ?? '').trim() || 'unknown';
    const purpose = String(input.purpose ?? '').trim() || 'unknown';
    const cost = estimateLlmCostUsd({
      model,
      promptTokens,
      completionTokens,
      cachedTokens,
    });

    const row = this.llmCallRepository.create({
      tallerId: input.tallerId ? String(input.tallerId).trim() : null,
      conversationId: input.conversationId
        ? String(input.conversationId).trim()
        : null,
      provider: String(input.provider ?? 'openai').trim() || 'openai',
      model,
      purpose,
      promptTokens,
      completionTokens,
      totalTokens,
      cachedTokens,
      estimatedCostUsd: cost.toFixed(6),
      durationMs: Math.max(0, Math.floor(Number(input.durationMs) || 0)),
    });
    return this.llmCallRepository.save(row);
  }

  async getSummary(input: {
    tallerId?: string | null;
    startDate: Date;
    endDate: Date;
  }): Promise<LlmCallsSummary> {
    const start = input.startDate;
    const end = input.endDate;
    const tallerId = input.tallerId ? String(input.tallerId).trim() : null;

    const qb = this.llmCallRepository
      .createQueryBuilder('c')
      .where('c.createdAt >= :start', { start })
      .andWhere('c.createdAt <= :end', { end });
    if (tallerId) {
      qb.andWhere('c.tallerId = :tallerId', { tallerId });
    }

    const totalsRaw = await qb
      .clone()
      .select('COUNT(*)', 'totalCalls')
      .addSelect('COALESCE(SUM(c.totalTokens), 0)', 'totalTokens')
      .addSelect('COALESCE(SUM(c.estimatedCostUsd), 0)', 'totalCostUsd')
      .addSelect('COALESCE(AVG(c.durationMs), 0)', 'averageLatencyMs')
      .getRawOne<{
        totalCalls: string;
        totalTokens: string;
        totalCostUsd: string;
        averageLatencyMs: string;
      }>();

    const byModel = await qb
      .clone()
      .select('c.model', 'key')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(c.totalTokens), 0)', 'totalTokens')
      .addSelect('COALESCE(SUM(c.estimatedCostUsd), 0)', 'costUsd')
      .groupBy('c.model')
      .orderBy('costUsd', 'DESC')
      .getRawMany<{
        key: string;
        calls: string;
        totalTokens: string;
        costUsd: string;
      }>();

    const byPurpose = await qb
      .clone()
      .select('c.purpose', 'key')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(c.totalTokens), 0)', 'totalTokens')
      .addSelect('COALESCE(SUM(c.estimatedCostUsd), 0)', 'costUsd')
      .groupBy('c.purpose')
      .orderBy('costUsd', 'DESC')
      .getRawMany<{
        key: string;
        calls: string;
        totalTokens: string;
        costUsd: string;
      }>();

    const mapBucket = (rows: typeof byModel): LlmSummaryBucket[] =>
      rows.map((r) => ({
        key: String(r.key ?? ''),
        calls: Number(r.calls) || 0,
        totalTokens: Number(r.totalTokens) || 0,
        costUsd: Math.round((Number(r.costUsd) || 0) * 1_000_000) / 1_000_000,
      }));

    return {
      totalCalls: Number(totalsRaw?.totalCalls) || 0,
      totalTokens: Number(totalsRaw?.totalTokens) || 0,
      totalCostUsd:
        Math.round((Number(totalsRaw?.totalCostUsd) || 0) * 1_000_000) /
        1_000_000,
      averageLatencyMs: Math.round(Number(totalsRaw?.averageLatencyMs) || 0),
      costByModel: mapBucket(byModel),
      costByPurpose: mapBucket(byPurpose),
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      tallerId,
    };
  }
}
