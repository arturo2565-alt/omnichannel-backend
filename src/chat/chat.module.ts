import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessagingQueueModule } from '../messaging-queue/messaging-queue.module';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { Message } from './entities/chat.entity';
import { ChatGateway } from './chat.gateway';
import { Conversation } from './entities/conversation.entity';
import { Contact } from './entities/contact.entity';
import { DraftQuoteEntity } from './entities/draft-quote.entity';
import { DraftQuoteItem } from './entities/draft-quote-item.entity';
import { AppointmentEntity } from './entities/appointment.entity';
import { AiConfigEntity } from './entities/ai-config.entity';
import { LlmCall } from './entities/llm-call.entity';
import { AiConfigService } from './ai-config.service';
import { QuoteCartService } from './quote-cart.service';
import { TwilioService } from './twilio.service';
import { ArrivalAlarmController } from './arrival-alarm.controller';
import { LlmMetricsController } from './llm-metrics.controller';
import { LlmCallTrackerService } from './llm-call-tracker.service';
import { CatalogModule } from '../catalog/catalog.module';
import { TallerModule } from '../taller/taller.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    CatalogModule,
    TallerModule,
    AuthModule,
    forwardRef(() => MessagingQueueModule),
    TypeOrmModule.forFeature([
      Message,
      Contact,
      Conversation,
      DraftQuoteEntity,
      DraftQuoteItem,
      AppointmentEntity,
      AiConfigEntity,
      LlmCall,
    ]),
  ],
  controllers: [ChatController, ArrivalAlarmController, LlmMetricsController],
  providers: [
    ChatService,
    ChatGateway,
    AiConfigService,
    TwilioService,
    QuoteCartService,
    LlmCallTrackerService,
  ],
  exports: [
    ChatService,
    AiConfigService,
    TwilioService,
    QuoteCartService,
    LlmCallTrackerService,
  ],
})
export class ChatModule {}
