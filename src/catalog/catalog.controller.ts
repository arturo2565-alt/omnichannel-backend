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
      pieza: r.pieza,
      severidad: r.severidad,
      precio: r.precio,
      diasEntrega: r.diasEntrega,
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
      pieza?: unknown;
      severidad?: unknown;
      precio?: unknown;
      diasEntrega?: unknown;
    },
  ) {
    const pieza = String(body?.pieza ?? '').trim();
    const severidad = String(body?.severidad ?? '').trim();
    const precio = Number(body?.precio);
    const diasEntrega = Number(body?.diasEntrega);
    if (!pieza) throw new BadRequestException('pieza obligatoria');
    if (!severidad) throw new BadRequestException('severidad obligatoria');
    if (!Number.isFinite(precio) || precio < 0 || !Number.isInteger(precio)) {
      throw new BadRequestException('precio entero >= 0');
    }
    if (!Number.isFinite(diasEntrega) || diasEntrega < 0 || !Number.isInteger(diasEntrega)) {
      throw new BadRequestException('diasEntrega entero >= 0');
    }
    try {
      const row = await this.catalogService.createRow({
        pieza,
        severidad,
        precio,
        diasEntrega,
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
            'Ya existe una fila con esa pieza y severidad.',
          );
        }
      }
      throw e;
    }
  }
}
