import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  INCOMING_MESSAGES_QUEUE,
  type IncomingMessageJobData,
} from './incoming-message.constants';

@Processor(INCOMING_MESSAGES_QUEUE)
export class IncomingMessageWorker extends WorkerHost {
  private readonly logger = new Logger(IncomingMessageWorker.name);

  async process(job: Job<IncomingMessageJobData>): Promise<void> {
    console.log('[IncomingMessageWorker] job recibido', {
      id: job.id,
      name: job.name,
      channel: job.data?.channel,
      tallerId: job.data?.tallerId,
      conversationId: job.data?.conversationId,
    });
    this.logger.log(
      `processed job=${job.id} channel=${job.data?.channel} taller=${job.data?.tallerId} conversation=${job.data?.conversationId}`,
    );
  }
}
