import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { INCOMING_MESSAGES_QUEUE } from './incoming-message.constants';
import { IncomingMessageProducer } from './incoming-message.producer';
import { IncomingMessageWorker } from './incoming-message.worker';

@Module({
  imports: [
    BullModule.registerQueue({
      name: INCOMING_MESSAGES_QUEUE,
    }),
  ],
  providers: [IncomingMessageProducer, IncomingMessageWorker],
  exports: [IncomingMessageProducer],
})
export class MessagingQueueModule {}
