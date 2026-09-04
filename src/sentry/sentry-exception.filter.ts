import {
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';
import { applySentryAlsTags } from './sentry-als';
import { isSentryEnabled } from './sentry.init';

/**
 * Filter global: captura en Sentry con tags ALS y delega la respuesta HTTP
 * al comportamiento Nest habitual (BaseExceptionFilter).
 */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (isSentryEnabled()) {
      const status =
        exception instanceof HttpException
          ? exception.getStatus()
          : HttpStatus.INTERNAL_SERVER_ERROR;

      // No saturar Sentry con 4xx esperados del cliente.
      if (status >= 500) {
        applySentryAlsTags({ source: 'http_exception_filter' });
        Sentry.captureException(exception);
      }
    }

    super.catch(exception, host);
  }
}
