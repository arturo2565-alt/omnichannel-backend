/**
 * Una sola ruta autenticada. Permanece oculta fuera del sandbox de staging.
 * No escribe hasta que el dueño del taller sintético envía la confirmación fija.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import {
  CATALOG_IMPORT_CONFIRM,
  CATALOG_RESTORE_CONFIRM,
  CatalogImportRejected,
  restoreStagingCatalog,
  runStagingCatalogImport,
  stagingCatalogAccess,
} from './staging-catalog-import';
import { PgCatalogDb } from './staging-catalog-import.pg';

@Controller('catalog')
@UseGuards(JwtAuthGuard)
export class StagingCatalogImportController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @Post('staging-catalog-import')
  @HttpCode(HttpStatus.OK)
  async importCatalog(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body?: { confirm?: unknown; manifestText?: unknown },
  ) {
    const access = stagingCatalogAccess(process.env, user);
    if (access === 'hidden') throw new NotFoundException();
    if (access === 'forbidden') throw new ForbiddenException();
    const confirm = String(body?.confirm ?? '');
    const manifestText = body?.manifestText;
    if (confirm !== CATALOG_RESTORE_CONFIRM && (confirm !== CATALOG_IMPORT_CONFIRM || typeof manifestText !== 'string')) {
      throw new BadRequestException('la confirmación no coincide');
    }
    const db = new PgCatalogDb(this.dataSource);
    try {
      return await db.exclusive((locked) =>
        confirm === CATALOG_RESTORE_CONFIRM
          ? restoreStagingCatalog(locked, confirm)
          : runStagingCatalogImport(locked, { confirm, manifestText: manifestText as string }),
      );
    } catch (err) {
      if (err instanceof CatalogImportRejected && err.message === 'operación en curso') {
        throw new ConflictException(err.message);
      }
      if (err instanceof CatalogImportRejected) throw new BadRequestException(err.message);
      throw new InternalServerErrorException('la importación no se aplicó');
    }
  }
}
