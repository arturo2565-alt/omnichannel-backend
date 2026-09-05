import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  INCOMING_MESSAGES_QUEUE,
  type IncomingMessageChannel,
  type IncomingMessageJobData,
} from './incoming-message.constants';

@Injectable()
export class IncomingMessageProducer {
  private readonly logger = new Logger(IncomingMessageProducer.name);

  constructor(
    @InjectQueue(INCOMING_MESSAGES_QUEUE)
    private readonly incomingQueue: Queue<IncomingMessageJobData>,
  ) {}

  /**
   * Encola un inbound de cualquier canal.
   * Fase 1: el webhook de Meta aún no llama esto.
   */
  async enqueueMessage(
    tallerId: string,
    conversationId: string,
    channel: IncomingMessageChannel,
    messageData: unknown,
  ) {
    const data: IncomingMessageJobData = {
      tallerId,
      conversationId,
      channel,
      messageData,
    };
    const job = await this.incomingQueue.add('inbound', data);
    this.logger.log(
      `enqueued job=${job.id} channel=${channel} taller=${tallerId} conversation=${conversationId}`,
    );
    return job;
  }
}
