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
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DebugController } from './sentry/debug.controller';
import {
  assertRemoteSynchronizeAllowed,
  resolveDbSynchronize,
} from './config/db-synchronize';
import {
  buildBullMqRedisConnection,
  validateEnv,
} from './config/env';
import { TYPEORM_ENTITIES } from './config/typeorm-entities';

const databaseUrl = process.env.DATABASE_URL?.trim();
const isCloudDatabase = Boolean(databaseUrl);

/**
 * Una base remota no se altera al arrancar.
 * El esquema vacío de staging lo crea `npm run bootstrap:staging`, una sola vez.
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
      entities: TYPEORM_ENTITIES,
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
  controllers: [AppController, DebugController],
  providers: [AppService],
})
export class AppModule {}
