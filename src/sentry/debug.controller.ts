import {
  Controller,
  Get,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { runWithLlmAuditContext } from '../chat/llm-audit-context';
import { isSentryEnabled } from './sentry.init';

@Controller('debug')
export class DebugController {
  /**
   * Prueba de captura Sentry + tags ALS (`tallerId`).
   * Disponible si hay DSN y (no-prod o ENABLE_SENTRY_TEST=true).
   */
  @Get('sentry-test')
  @UseGuards(JwtAuthGuard)
  sentryTest(@CurrentUser() user: AuthenticatedUser): never {
    const allow =
      isSentryEnabled() &&
      (String(process.env.NODE_ENV ?? '').trim() !== 'production' ||
        String(process.env.ENABLE_SENTRY_TEST ?? '').trim() === 'true');

    if (!allow) {
      throw new ServiceUnavailableException(
        'Sentry test deshabilitado (falta SENTRY_DSN o ENABLE_SENTRY_TEST en producción).',
      );
    }

    return runWithLlmAuditContext(
      {
        tallerId: user.tallerId,
        conversationId: null,
        purpose: 'sentry_test',
      },
      () => {
        Sentry.setTag('tallerId', user.tallerId);
        Sentry.setTag('source', 'debug_sentry_test');
        throw new Error('Sentry test with ALS context');
      },
    );
  }
}
