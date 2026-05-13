import { Controller, Get } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  /** Verificación: contenido actual de `price_matrix`. */
  @Get('test')
  async testPriceMatrix() {
    const rows = await this.catalogService.findAllPriceMatrixRows();
    return {
      count: rows.length,
      rows: rows.map((r) => ({
        id: r.id,
        pieza: r.pieza,
        severidad: r.severidad,
        precio: r.precio,
        diasEntrega: r.diasEntrega,
      })),
    };
  }
}
