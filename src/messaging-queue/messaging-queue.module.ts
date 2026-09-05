import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import Redis from 'ioredis';
import { ChatModule } from '../chat/chat.module';
import { getRedisUrl } from '../config/env';
import {
  INCOMING_MESSAGES_QUEUE,
  MESSAGING_REDIS,
} from './incoming-message.constants';
import { IncomingMessageProducer } from './incoming-message.producer';
import { IncomingMessageWorker } from './incoming-message.worker';

@Module({
  imports: [
    forwardRef(() => ChatModule),
    BullModule.registerQueue({
      name: INCOMING_MESSAGES_QUEUE,
    }),
  ],
  providers: [
    {
      provide: MESSAGING_REDIS,
      useFactory: () =>
        new Redis(getRedisUrl(), {
          maxRetriesPerRequest: null,
          lazyConnect: false,
        }),
    },
    IncomingMessageProducer,
    IncomingMessageWorker,
  ],
  exports: [IncomingMessageProducer],
})
export class MessagingQueueModule {}
