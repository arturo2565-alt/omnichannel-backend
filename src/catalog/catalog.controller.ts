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
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { CatalogService } from './catalog.service';

@Controller('catalog')
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

  /** Listado para panel admin (misma data que `test`). */
  @Get('price-matrix')
  async listPriceMatrix() {
    const rows = await this.catalogService.findAllPriceMatrixRows();
    return { count: rows.length, rows: this.mapRows(rows) };
  }

  /** Verificación: contenido actual de `price_matrix`. */
  @Get('test')
  async testPriceMatrix() {
    const rows = await this.catalogService.findAllPriceMatrixRows();
    return {
      count: rows.length,
      rows: this.mapRows(rows),
    };
  }

  @Patch('price-matrix')
  @HttpCode(HttpStatus.OK)
  async patchPriceMatrix(
    @Body()
    body: {
      updates?: Array<{ id?: string; precio?: unknown; diasEntrega?: unknown }>;
    },
  ) {
    const updates = body?.updates;
    if (!Array.isArray(updates) || updates.length === 0) {
      throw new BadRequestException('Envía updates: [{ id, precio, diasEntrega }, …]');
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
      return { id, precio, diasEntrega };
    });
    const rows = await this.catalogService.bulkUpdatePrecioDias(normalized);
    return { ok: true, count: rows.length, rows: this.mapRows(rows) };
  }

  @Post('price-matrix')
  @HttpCode(HttpStatus.CREATED)
  async createPriceMatrixRow(
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
      const row = await this.catalogService.createRow({
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
            'Ya existe una fila con ese servicio y severidad.',
          );
        }
      }
      throw e;
    }
  }

  /**
   * Importación desde la réplica de `autofix-pricing.js` (matriz ancha → `price_matrix`).
   * Upsert: no duplica pieza+severidad; actualiza precio y días de entrega.
   */
  @Post('import-legacy-js')
  @HttpCode(HttpStatus.OK)
  async importLegacyJs(
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
    const result = await this.catalogService.importFromLegacyFrontendMirror(dias);
    const rows = await this.catalogService.findAllPriceMatrixRows();
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

  /** Carga masiva Baño de pintura / Estética + sincroniza `isInstantService` en toda la tabla. */
  @Post('seed-instant-quote-matrix')
  @HttpCode(HttpStatus.OK)
  async seedInstantQuoteMatrix() {
    const result = await this.catalogService.seedInstantQuoteMatrixRows();
    const rows = await this.catalogService.findAllPriceMatrixRows();
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
