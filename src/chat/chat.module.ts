import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import { AiConfigService } from './ai-config.service';
import { TwilioService } from './twilio.service';
import { ActiveQuoteService } from './active-quote.service';
import { ArrivalAlarmController } from './arrival-alarm.controller';
import { CatalogModule } from '../catalog/catalog.module';
import { TallerModule } from '../taller/taller.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    CatalogModule,
    TallerModule,
    AuthModule,
    TypeOrmModule.forFeature([
      Message,
      Contact,
      Conversation,
      DraftQuoteEntity,
      DraftQuoteItem,
      AppointmentEntity,
      AiConfigEntity,
    ]),
  ],
  controllers: [ChatController, ArrivalAlarmController],
  providers: [ChatService, ChatGateway, AiConfigService, TwilioService, ActiveQuoteService],
  exports: [ChatService, AiConfigService, TwilioService, ActiveQuoteService],
})

export class ChatModule {}