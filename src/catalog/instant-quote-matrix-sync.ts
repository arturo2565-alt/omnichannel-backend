import type { EntityManager, Repository } from 'typeorm';
import { PriceMatrix } from './entities/price-matrix.entity';
import { INSTANT_QUOTE_MATRIX_SEED_ROWS } from './instant-quote-matrix-seed.data';

const SEV_MAX = 32;

/**
 * Upsert de filas InstantQuote (baños de pintura, estética, etc.).
 */
export async function upsertInstantQuoteMatrixRows(
  repo: Repository<PriceMatrix>,
): Promise<number> {
  const rows = INSTANT_QUOTE_MATRIX_SEED_ROWS.map((r) => ({
    servicio: r.servicio.slice(0, 120),
    severidad: r.severidad.slice(0, SEV_MAX),
    precio: r.precio,
    diasEntrega: r.diasEntrega,
    isInstantService: r.isInstantService,
  }));
  if (rows.length === 0) return 0;
  await repo.upsert(rows, {
    conflictPaths: ['servicio', 'severidad'],
    skipUpdateIfNoValuesChanged: false,
  });
  return rows.length;
}

/**
 * `true` solo para Baño de Pintura*, Cerámico*, Estética Automotriz; el resto `false` (hojalatería).
 * Usa la columna física `pieza` (propiedad TypeORM `servicio`).
 */
export async function syncInstantServiceFlags(em: EntityManager): Promise<void> {
  await em.query(`UPDATE price_matrix SET is_instant_service = false`);
  await em.query(`
    UPDATE price_matrix SET is_instant_service = true
    WHERE LOWER(pieza) LIKE 'baño de pintura%'
       OR LOWER(pieza) LIKE '%cerámico%'
       OR LOWER(pieza) LIKE '%ceramico%'
       OR pieza = 'Estética Automotriz'
  `);
}
