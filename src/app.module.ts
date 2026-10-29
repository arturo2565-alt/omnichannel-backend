import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatModule } from './chat/chat.module';
import { CatalogModule } from './catalog/catalog.module';
import { AuthModule } from './auth/auth.module';
import { TallerModule } from './taller/taller.module';
import { MessagingQueueModule } from './messaging-queue/messaging-queue.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DebugController } from './sentry/debug.controller';
import {
  assertRemoteSynchronizeAllowed,
  resolveDbSynchronize,
} from './config/db-synchronize';
import {
  buildBullMqRedisConnection,
  validateEnv,
} from './config/env';
import { Taller } from './taller/entities/taller.entity';
import { User } from './auth/entities/user.entity';
import { Message } from './chat/entities/chat.entity';
import { Conversation } from './chat/entities/conversation.entity';
import { Contact } from './chat/entities/contact.entity';
import { DraftQuoteEntity } from './chat/entities/draft-quote.entity';
import { DraftQuoteItem } from './chat/entities/draft-quote-item.entity';
import { AppointmentEntity } from './chat/entities/appointment.entity';
import { ContractedWork } from './chat/entities/contracted-work.entity';
import { AppointmentServiceLine } from './chat/entities/appointment-service-line.entity';
import { AiConfigEntity } from './chat/entities/ai-config.entity';
import { LlmCall } from './chat/entities/llm-call.entity';
import { LeadEventEntity } from './chat/entities/lead-event.entity';
import { PriceMatrix } from './catalog/entities/price-matrix.entity';

const databaseUrl = process.env.DATABASE_URL?.trim();
const isCloudDatabase = Boolean(databaseUrl);

/**
 * Una base remota no se altera al arrancar.
 * DB_SYNCHRONIZE=true lo vuelve a encender. Las migraciones CRM son los
 * scripts migrate:crm-001a y migrate:crm-008, no este proceso.
 */
const dbSynchronize = resolveDbSynchronize(
  process.env.DB_SYNCHRONIZE,
  databaseUrl,
);
assertRemoteSynchronizeAllowed(
  process.env.DB_SYNCHRONIZE,
  databaseUrl,
  process.env,
);

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: buildBullMqRedisConnection(
          config.getOrThrow<string>('REDIS_URL'),
        ),
      }),
    }),
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
        AppointmentServiceLine,
        ContractedWork,
        AiConfigEntity,
        LlmCall,
        LeadEventEntity,
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
    MessagingQueueModule,
    DashboardModule,
  ],
  controllers: [DebugController],
})
export class AppModule {}
