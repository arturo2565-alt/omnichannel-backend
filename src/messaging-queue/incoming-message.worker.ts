import { Inject, forwardRef } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ChatService } from '../chat/chat.service';
import { IncomingMessageProducer } from './incoming-message.producer';
import {
  INCOMING_MESSAGES_QUEUE,
  type IncomingMessageJobData,
} from './incoming-message.constants';
import { pegLogger } from '../observability/pegazuz-logger';

@Processor(INCOMING_MESSAGES_QUEUE)
export class IncomingMessageWorker extends WorkerHost {
  constructor(
    private readonly producer: IncomingMessageProducer,
    @Inject(forwardRef(() => ChatService))
    private readonly chatService: ChatService,
  ) {
    super();
  }

  async process(job: Job<IncomingMessageJobData>): Promise<void> {
    const conversationId = String(job.data?.conversationId ?? job.id ?? '').trim();
    const tallerId = String(job.data?.tallerId ?? '').trim();
    const channel = job.data?.channel ?? 'unknown';

    pegLogger.debug('INBOUND', {
      status: 'process_start',
      job: job.id,
      channel,
      conversation: conversationId,
    });

    const items = await this.producer.drainBuffer(conversationId);
    pegLogger.debug('INBOUND', {
      status: 'buffer_drained',
      job: job.id,
      count: items.length,
      kinds: items.map((i) => i.kind),
    });

    if (items.length === 0) {
      pegLogger.debug('INBOUND', { status: 'skip_empty', job: job.id });
      return;
    }

    try {
      await this.chatService.processQueuedInboundBurst({
        conversationId,
        tallerId,
        channel,
        items,
      });
    } catch (err) {
      pegLogger.error('INBOUND', {
        message: `processQueuedInboundBurst falló job=${job.id}`,
        conversationId,
        err,
      });
      throw err;
    }

    try {
      await this.producer.rescheduleIfBufferPending(
        tallerId,
        conversationId,
        channel,
      );
    } catch (err) {
      pegLogger.warn('INBOUND', {
        status: 'reschedule_failed',
        conversationId,
        message: String(err),
      });
    }
  }
}
