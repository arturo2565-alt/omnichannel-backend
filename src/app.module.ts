import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatModule } from './chat/chat.module';
import { CatalogModule } from './catalog/catalog.module';
import { AuthModule } from './auth/auth.module';
import { TallerModule } from './taller/taller.module';
import { Taller } from './taller/entities/taller.entity';
import { User } from './auth/entities/user.entity';
import { Message } from './chat/entities/chat.entity';
import { Conversation } from './chat/entities/conversation.entity';
import { Contact } from './chat/entities/contact.entity';
import { DraftQuoteEntity } from './chat/entities/draft-quote.entity';
import { DraftQuoteItem } from './chat/entities/draft-quote-item.entity';
import { AppointmentEntity } from './chat/entities/appointment.entity';
import { AiConfigEntity } from './chat/entities/ai-config.entity';
import { LlmCall } from './chat/entities/llm-call.entity';
import { PriceMatrix } from './catalog/entities/price-matrix.entity';

const databaseUrl = process.env.DATABASE_URL?.trim();
const isCloudDatabase = Boolean(databaseUrl);

/** Activo por defecto; en prod pon DB_SYNCHRONIZE=false cuando las tablas ya existan. */
const dbSynchronize =
  process.env.DB_SYNCHRONIZE === 'true' ||
  process.env.DB_SYNCHRONIZE !== 'false';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: databaseUrl,
      entities: [
        Taller,
        User,
        Message,
        Conversation,
        Contact,
        DraftQuoteEntity,
        DraftQuoteItem,
        AppointmentEntity,
        AiConfigEntity,
        LlmCall,
        PriceMatrix,
      ],
      autoLoadEntities: true,
      synchronize: dbSynchronize,
      ssl: isCloudDatabase ? { rejectUnauthorized: false } : false,
    }),
    AuthModule,
    TallerModule,
    ChatModule,
    CatalogModule,
  ],
})
export class AppModule {}
