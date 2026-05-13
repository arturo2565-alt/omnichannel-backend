import { Controller, Get } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  /**
   * Verificación: lista filas de `price_matrix` (semilla desde matriz en código).
   */
  @Get('test')
  async testPriceMatrix() {
    const rows = await this.catalogService.findAllPriceMatrixRows();
    return {
      count: rows.length,
      items: rows.map((r) => ({
        id: r.id,
        pieza: r.pieza,
        severidad: r.severidad,
        precio: r.precio,
        diasEntrega: r.diasEntrega,
      })),
    };
  }
}
