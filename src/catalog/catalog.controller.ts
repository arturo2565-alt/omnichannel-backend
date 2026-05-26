import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { CatalogService } from './catalog.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

@Controller('catalog')
@UseGuards(JwtAuthGuard)
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  private mapRows(rows: Awaited<ReturnType<CatalogService['findAllPriceMatrixRows']>>) {
    return rows.map((r) => ({
      id: r.id,
      servicio: r.servicio,
      severidad: r.severidad,
      precio: r.precio,
      diasEntrega: r.diasEntrega,
      isInstantService: r.isInstantService,
    }));
  }

  @Get('price-matrix')
  async listPriceMatrix(@CurrentUser() user: AuthenticatedUser) {
    const rows = await this.catalogService.findAllPriceMatrixRows(user.tallerId);
    return { count: rows.length, rows: this.mapRows(rows) };
  }

  @Get('test')
  async testPriceMatrix(@CurrentUser() user: AuthenticatedUser) {
    const rows = await this.catalogService.findAllPriceMatrixRows(user.tallerId);
    return {
      count: rows.length,
      rows: this.mapRows(rows),
    };
  }

  @Patch('price-matrix')
  @HttpCode(HttpStatus.OK)
  async patchPriceMatrix(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      updates?: Array<{
        id?: string;
        precio?: unknown;
        diasEntrega?: unknown;
        isInstantService?: unknown;
      }>;
    },
  ) {
    const updates = body?.updates;
    if (!Array.isArray(updates) || updates.length === 0) {
      throw new BadRequestException(
        'Envía updates: [{ id, precio, diasEntrega, isInstantService? }, …]',
      );
    }
    const normalized = updates.map((u, i) => {
      const id = String(u?.id ?? '').trim();
      const precio = Number(u?.precio);
      const diasEntrega = Number(u?.diasEntrega);
      if (!id) {
        throw new BadRequestException(`updates[${i}]: id obligatorio`);
      }
      if (!Number.isFinite(precio) || precio < 0 || !Number.isInteger(precio)) {
        throw new BadRequestException(`updates[${i}]: precio entero >= 0`);
      }
      if (!Number.isFinite(diasEntrega) || diasEntrega < 0 || !Number.isInteger(diasEntrega)) {
        throw new BadRequestException(`updates[${i}]: diasEntrega entero >= 0`);
      }
      const rawI = u?.isInstantService;
      let isInstantService: boolean | undefined;
      if (rawI !== undefined && rawI !== null && String(rawI) !== '') {
        if (
          rawI === true ||
          rawI === 'true' ||
          rawI === 1 ||
          rawI === '1'
        ) {
          isInstantService = true;
        } else if (
          rawI === false ||
          rawI === 'false' ||
          rawI === 0 ||
          rawI === '0'
        ) {
          isInstantService = false;
        } else {
          throw new BadRequestException(
            `updates[${i}]: isInstantService debe ser booleano si se envía`,
          );
        }
      }
      return { id, precio, diasEntrega, isInstantService };
    });
    const rows = await this.catalogService.bulkUpdatePrecioDias(
      user.tallerId,
      normalized,
    );
    return { ok: true, count: rows.length, rows: this.mapRows(rows) };
  }

  @Post('price-matrix')
  @HttpCode(HttpStatus.CREATED)
  async createPriceMatrixRow(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      servicio?: unknown;
      pieza?: unknown;
      severidad?: unknown;
      precio?: unknown;
      diasEntrega?: unknown;
      isInstantService?: unknown;
    },
  ) {
    const servicio = String(body?.servicio ?? body?.pieza ?? '').trim();
    const severidad = String(body?.severidad ?? '').trim();
    const precio = Number(body?.precio);
    const diasEntrega = Number(body?.diasEntrega);
    const rawInstant = body?.isInstantService;
    const isInstantService =
      rawInstant === true ||
      rawInstant === 'true' ||
      rawInstant === 1 ||
      rawInstant === '1';
    if (!servicio) throw new BadRequestException('servicio obligatorio');
    if (!severidad) throw new BadRequestException('severidad obligatoria');
    if (!Number.isFinite(precio) || precio < 0 || !Number.isInteger(precio)) {
      throw new BadRequestException('precio entero >= 0');
    }
    if (!Number.isFinite(diasEntrega) || diasEntrega < 0 || !Number.isInteger(diasEntrega)) {
      throw new BadRequestException('diasEntrega entero >= 0');
    }
    try {
      const row = await this.catalogService.createRow(user.tallerId, {
        servicio,
        severidad,
        precio,
        diasEntrega,
        isInstantService,
      });
      return {
        ok: true,
        row: this.mapRows([row])[0],
      };
    } catch (e: unknown) {
      if (e instanceof QueryFailedError) {
        const pg = e.driverError as { code?: string } | undefined;
        if (pg?.code === '23505') {
          throw new ConflictException(
            'Ya existe una fila con ese servicio y severidad en tu taller.',
          );
        }
      }
      throw e;
    }
  }

  @Post('import-legacy-js')
  @HttpCode(HttpStatus.OK)
  async importLegacyJs(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body?: {
      diasEntrega?: unknown;
    },
  ) {
    const raw = body?.diasEntrega;
    const dias =
      raw !== undefined && raw !== null && String(raw).trim() !== ''
        ? Number(raw)
        : 3;
    if (!Number.isFinite(dias) || dias < 0 || !Number.isInteger(dias)) {
      throw new BadRequestException('diasEntrega debe ser entero >= 0');
    }
    const result = await this.catalogService.importFromLegacyFrontendMirror(
      user.tallerId,
      dias,
    );
    const rows = await this.catalogService.findAllPriceMatrixRows(user.tallerId);
    return {
      ok: true,
      message:
        'Importación aplicada (upsert). Origen: réplica de autofix-pricing.js en el backend. Banderas InstantQuote sincronizadas.',
      diasEntregaUsado: dias,
      upserted: result.upserted,
      totalInDb: result.totalInDb,
      rows: this.mapRows(rows),
    };
  }

  @Post('seed-instant-quote-matrix')
  @HttpCode(HttpStatus.OK)
  async seedInstantQuoteMatrix(@CurrentUser() user: AuthenticatedUser) {
    const result = await this.catalogService.seedInstantQuoteMatrixRows(
      user.tallerId,
    );
    const rows = await this.catalogService.findAllPriceMatrixRows(user.tallerId);
    return {
      ok: true,
      message:
        'Filas InstantQuote aplicadas (upsert). Cerámico / Baños / Estética marcados según reglas.',
      upserted: result.upserted,
      totalInDb: result.totalInDb,
      rows: this.mapRows(rows),
    };
  }
}
