import { HttpAdapterHost } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';

import { json, urlencoded } from 'express';

import { initSentry } from './sentry/sentry.init';
import { SentryExceptionFilter } from './sentry/sentry-exception.filter';
import { AppModule } from './app.module';
import { pegLogger } from './observability/pegazuz-logger';
import { resolveDbSynchronize } from './config/db-synchronize';
import { readStagingSandbox, rememberRawBody } from './config/staging-sandbox';
import {
  getLogLevel,
  getPegLogFormat,
  getPegTraceMode,
  nestFactoryLoggerLevels,
} from './observability/pegazuz-log-level';

initSentry();

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: nestFactoryLoggerLevels(),
  });

  const sandbox = readStagingSandbox();
  pegLogger.info('STARTUP', {
    serperConfigured: Boolean(process.env.SERPER_API_KEY?.trim()),
    stagingSandbox: sandbox.active ? 'on' : sandbox.reason,
    logLevel: getLogLevel(),
    traceMode: getPegTraceMode(),
    logFormat: getPegLogFormat(),
    nodeEnv: process.env.NODE_ENV ?? null,
    dbSynchronize: resolveDbSynchronize(
      process.env.DB_SYNCHRONIZE,
      process.env.DATABASE_URL,
    ),
    schemaMigrations: 'manual',
  });

  app.use(json({ limit: '50mb', verify: rememberRawBody }));

  app.use(
    urlencoded({
      extended: true,
      limit: '50mb',
    }),
  );

  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  const { httpAdapter } = app.get(HttpAdapterHost);

  app.useGlobalFilters(new SentryExceptionFilter(httpAdapter));

  const port = process.env.PORT || 3000;

  await app.listen(port, '0.0.0.0');

  console.log(`🚀 Servidor en modo IPv4 listo en puerto: ${port}`);
}

bootstrap();