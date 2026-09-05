import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import {
  INCOMING_MESSAGE_DEBOUNCE_MS,
  INCOMING_MESSAGES_QUEUE,
  MESSAGING_REDIS,
  incomingBufferKey,
  type IncomingBufferItem,
  type IncomingMessageChannel,
  type IncomingMessageJobData,
} from './incoming-message.constants';

@Injectable()
export class IncomingMessageProducer {
  private readonly logger = new Logger(IncomingMessageProducer.name);

  constructor(
    @InjectQueue(INCOMING_MESSAGES_QUEUE)
    private readonly incomingQueue: Queue<IncomingMessageJobData>,
    @Inject(MESSAGING_REDIS)
    private readonly redis: Redis,
  ) {}

  /**
   * Persiste el inbound en Redis y programa (o reinicia) el job de debounce.
   * Mismo `jobId` = conversationId → una sola ráfaga por conversación.
   */
  async enqueueMessage(
    tallerId: string,
    conversationId: string,
    channel: IncomingMessageChannel,
    messageData: unknown,
  ) {
    const cid = String(conversationId ?? '').trim();
    const tid = String(tallerId ?? '').trim();
    if (!cid) {
      throw new Error('enqueueMessage: conversationId vacío');
    }

    const item = this.normalizeBufferItem(tid, channel, messageData);
    const key = incomingBufferKey(cid);
    await this.redis.rpush(key, JSON.stringify(item));
    await this.redis.expire(key, 30 * 60);

    const job = await this.scheduleDebouncedJob(tid, cid, channel);
    this.logger.log(
      `buffered+scheduled job=${job?.id ?? cid} channel=${channel} kind=${item.kind} taller=${tid} conversation=${cid}`,
    );
    return job;
  }

  async drainBuffer(conversationId: string): Promise<IncomingBufferItem[]> {
    const key = incomingBufferKey(conversationId);
    const exec = await this.redis.multi().lrange(key, 0, -1).del(key).exec();
    const rawList = (exec?.[0]?.[1] as string[] | undefined) ?? [];
    const items: IncomingBufferItem[] = [];
    for (const raw of rawList) {
      try {
        const parsed = JSON.parse(raw) as IncomingBufferItem;
        if (parsed?.content) items.push(parsed);
      } catch {
        this.logger.warn(`buffer item inválido en ${key}`);
      }
    }
    return items;
  }

  async bufferLength(conversationId: string): Promise<number> {
    return this.redis.llen(incomingBufferKey(conversationId));
  }

  async hasBufferedImages(conversationId: string): Promise<boolean> {
    const raw = await this.redis.lrange(incomingBufferKey(conversationId), 0, -1);
    return raw.some((row) => {
      try {
        return (JSON.parse(row) as IncomingBufferItem).kind === 'image';
      } catch {
        return false;
      }
    });
  }

  /**
   * Quita el job delayed si no hay fotos en el buffer (auto-reply de botón).
   * No borra el buffer: un inbound posterior reprograma.
   */
  async cancelDebounceIfNoImages(conversationId: string): Promise<void> {
    const cid = String(conversationId ?? '').trim();
    if (!cid) return;
    if (await this.hasBufferedImages(cid)) return;
    const job = await this.incomingQueue.getJob(cid);
    if (!job) return;
    try {
      const state = await job.getState();
      if (state === 'delayed' || state === 'waiting') {
        await job.remove();
        this.logger.log(`debounce cancelado (sin fotos) conversation=${cid}`);
      }
    } catch (err) {
      this.logger.warn(
        `cancelDebounceIfNoImages conversation=${cid}: ${String(err)}`,
      );
    }
  }

  /** Cancela job delayed + buffer (borrado de conversación). */
  async discardConversation(conversationId: string): Promise<void> {
    const cid = String(conversationId ?? '').trim();
    if (!cid) return;
    await this.redis.del(incomingBufferKey(cid));
    const job = await this.incomingQueue.getJob(cid);
    if (!job) return;
    try {
      const state = await job.getState();
      if (state === 'delayed' || state === 'waiting') {
        await job.remove();
      }
    } catch (err) {
      this.logger.warn(
        `no se pudo quitar job debounce conversation=${cid}: ${String(err)}`,
      );
    }
  }

  /** Reprograma debounce si el worker drenó y llegaron más mensajes. */
  async rescheduleIfBufferPending(
    tallerId: string,
    conversationId: string,
    channel: IncomingMessageChannel,
  ): Promise<void> {
    const len = await this.bufferLength(conversationId);
    if (len <= 0) return;
    await this.scheduleDebouncedJob(tallerId, conversationId, channel);
  }

  private normalizeBufferItem(
    tallerId: string,
    channel: IncomingMessageChannel,
    messageData: unknown,
  ): IncomingBufferItem {
    if (messageData && typeof messageData === 'object') {
      const o = messageData as Partial<IncomingBufferItem>;
      const content = String(o.content ?? '').trim();
      const kind: IncomingBufferItem['kind'] =
        o.kind === 'image' || o.kind === 'text'
          ? o.kind
          : 'text';
      return {
        kind,
        content,
        messageId: String(o.messageId ?? '').trim(),
        channel,
        tallerId,
        receivedAt: o.receivedAt || new Date().toISOString(),
      };
    }
    return {
      kind: 'text',
      content: String(messageData ?? '').trim(),
      messageId: '',
      channel,
      tallerId,
      receivedAt: new Date().toISOString(),
    };
  }

  private async scheduleDebouncedJob(
    tallerId: string,
    conversationId: string,
    channel: IncomingMessageChannel,
  ) {
    const data: IncomingMessageJobData = {
      tallerId,
      conversationId,
      channel,
    };
    const opts = {
      delay: INCOMING_MESSAGE_DEBOUNCE_MS,
      jobId: conversationId,
      removeOnComplete: true,
      removeOnFail: true,
    } as const;

    const existing = await this.incomingQueue.getJob(conversationId);
    if (existing) {
      try {
        const state = await existing.getState();
        if (state === 'delayed' || state === 'waiting') {
          await existing.changeDelay(INCOMING_MESSAGE_DEBOUNCE_MS);
          await existing.updateData(data);
          this.logger.log(
            `debounce reset job=${conversationId} delay=${INCOMING_MESSAGE_DEBOUNCE_MS}ms`,
          );
          return existing;
        }
        if (state === 'active') {
          return existing;
        }
        await existing.remove();
      } catch (err) {
        this.logger.warn(
          `scheduleDebouncedJob existing job=${conversationId}: ${String(err)}`,
        );
      }
    }

    try {
      return await this.incomingQueue.add('inbound', data, opts);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!/exist/i.test(msg)) throw err;
      const raced = await this.incomingQueue.getJob(conversationId);
      if (raced) {
        try {
          const state = await raced.getState();
          if (state === 'delayed' || state === 'waiting') {
            await raced.changeDelay(INCOMING_MESSAGE_DEBOUNCE_MS);
          }
        } catch (inner) {
          this.logger.warn(
            `changeDelay race job=${conversationId}: ${String(inner)}`,
          );
        }
      }
      return raced ?? undefined;
    }
  }
}
