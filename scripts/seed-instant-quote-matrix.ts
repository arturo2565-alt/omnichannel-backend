/**
 * Solo filas InstantQuote (baños de pintura, estética) + sincronización de banderas.
 *
 *   DATABASE_URL=postgres://... npm run seed:instant-quote-matrix
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { PriceMatrix } from '../src/catalog/entities/price-matrix.entity';
import {
  syncInstantServiceFlags,
  upsertInstantQuoteMatrixRows,
} from '../src/catalog/instant-quote-matrix-sync';

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('Define DATABASE_URL antes de ejecutar el seed.');
  }

  const useSsl = process.env.DATABASE_SSL === 'true' || /sslmode=require/i.test(url);

  const ds = new DataSource({
    type: 'postgres',
    url,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    entities: [PriceMatrix],
    synchronize: true,
  });

  await ds.initialize();
  try {
    const repo = ds.getRepository(PriceMatrix);
    const n = await upsertInstantQuoteMatrixRows(repo);
    await syncInstantServiceFlags(ds.manager);
    const count = await repo.count();
    console.log(`OK: ${n} filas InstantQuote upsert. Banderas sincronizadas. Total filas en tabla: ${count}.`);
  } finally {
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
