import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { Message } from './entities/chat.entity';
import { ChatGateway } from './chat.gateway';
import { Conversation } from './entities/conversation.entity';
import { DraftQuoteEntity } from './entities/draft-quote.entity';
import { DraftQuoteItem } from './entities/draft-quote-item.entity';
import { AppointmentEntity } from './entities/appointment.entity';
import { AiConfigEntity } from './entities/ai-config.entity';
import { AiConfigService } from './ai-config.service';
import { CatalogModule } from '../catalog/catalog.module';

@Module({
  imports: [
    CatalogModule,
    TypeOrmModule.forFeature([
      Message,
      Conversation,
      DraftQuoteEntity,
      DraftQuoteItem,
      AppointmentEntity,
      AiConfigEntity,
    ]),
  ],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway, AiConfigService],
  exports: [ChatService, AiConfigService],
})

export class ChatModule {}