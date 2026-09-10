import { Inject, Logger, forwardRef } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ChatService } from '../chat/chat.service';
import { IncomingMessageProducer } from './incoming-message.producer';
import {
  INCOMING_MESSAGES_QUEUE,
  type IncomingMessageJobData,
} from './incoming-message.constants';

@Processor(INCOMING_MESSAGES_QUEUE)
export class IncomingMessageWorker extends WorkerHost {
  private readonly logger = new Logger(IncomingMessageWorker.name);

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

    this.logger.log(
      `process start job=${job.id} channel=${channel} conversation=${conversationId}`,
    );

    const items = await this.producer.drainBuffer(conversationId);
    console.log('[IncomingMessageWorker] buffer drenado', {
      id: job.id,
      conversationId,
      count: items.length,
      kinds: items.map((i) => i.kind),
    });

    if (items.length === 0) {
      this.logger.log(`process skip (buffer vacío) job=${job.id}`);
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
      this.logger.error(
        `processQueuedInboundBurst falló job=${job.id} conversation=${conversationId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }

    try {
      await this.producer.rescheduleIfBufferPending(
        tallerId,
        conversationId,
        channel,
      );
    } catch (err) {
      this.logger.warn(
        `rescheduleIfBufferPending falló conversation=${conversationId}: ${String(err)}`,
      );
    }
  }
}
