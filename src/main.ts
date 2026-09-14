import { HttpAdapterHost } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';

import { json, urlencoded } from 'express';

import { initSentry } from './sentry/sentry.init';
import { SentryExceptionFilter } from './sentry/sentry-exception.filter';
import { AppModule } from './app.module';

initSentry();

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  });

  const startupLogger = new Logger('StartupConfig');

  startupLogger.log(
    JSON.stringify({
      serperConfigured: Boolean(process.env.SERPER_API_KEY?.trim()),
      marketTrace: process.env.PEG_MARKET_TRACE === 'true',
      marketTraceVerbose:
        process.env.PEG_MARKET_TRACE_VERBOSE === 'true',
      nodeEnv: process.env.NODE_ENV ?? null,
    }),
  );

  app.use(json({ limit: '50mb' }));

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