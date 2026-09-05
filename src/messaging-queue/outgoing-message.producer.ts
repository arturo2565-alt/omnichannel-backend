import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  OUTGOING_MESSAGE_ATTEMPTS,
  OUTGOING_MESSAGE_BACKOFF_DELAY_MS,
  OUTGOING_MESSAGES_QUEUE,
  type OutgoingMessageChannel,
  type OutgoingMessageJobData,
} from './outgoing-message.constants';

@Injectable()
export class OutgoingMessageProducer {
  private readonly logger = new Logger(OutgoingMessageProducer.name);

  constructor(
    @InjectQueue(OUTGOING_MESSAGES_QUEUE)
    private readonly outgoingQueue: Queue<OutgoingMessageJobData>,
  ) {}

  /**
   * Encola el payload de Graph para envío asíncrono + reintentos.
   * No hace HTTP: eso vive en `OutgoingMessageWorker`.
   */
  async enqueueOutboundMessage(
    tallerId: string,
    conversationId: string,
    channel: OutgoingMessageChannel,
    metaPayload: Record<string, unknown>,
  ) {
    const cid = String(conversationId ?? '').trim();
    const tid = String(tallerId ?? '').trim();
    const ch = String(channel ?? '').trim() || 'unknown';
    if (!cid) {
      throw new Error('enqueueOutboundMessage: conversationId vacío');
    }
    if (!metaPayload || typeof metaPayload !== 'object') {
      throw new Error('enqueueOutboundMessage: metaPayload inválido');
    }

    const data: OutgoingMessageJobData = {
      tallerId: tid,
      conversationId: cid,
      channel: ch,
      metaPayload,
    };

    const job = await this.outgoingQueue.add('outbound', data, {
      attempts: OUTGOING_MESSAGE_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: OUTGOING_MESSAGE_BACKOFF_DELAY_MS,
      },
      removeOnComplete: true,
      removeOnFail: false,
    });

    this.logger.log(
      `enqueued job=${job.id} channel=${ch} taller=${tid} conversation=${cid}`,
    );
    return job;
  }
}
