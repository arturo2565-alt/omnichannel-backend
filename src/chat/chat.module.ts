import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { Message } from './entities/chat.entity';
import { ChatGateway } from './chat.gateway';
import { Conversation } from './entities/conversation.entity';
import { DraftQuoteEntity } from './entities/draft-quote.entity';
import { DraftQuoteItem } from './entities/draft-quote-item.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Message, Conversation, DraftQuoteEntity, DraftQuoteItem]),
  ],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway], // <--- AÑADE CHATGATEWAY AQUÍ
  exports: [ChatService]
})

export class ChatModule {}