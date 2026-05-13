/**
 * Rellena `price_matrix` desde la misma fuente que el front (`legacy-pieza-dano-from-frontend.ts` / réplica de autofix-pricing.js).
 *
 * Uso (desde omnichannel-backend/):
 *   DATABASE_URL=postgres://... npm run seed:price-matrix
 *
 * Opcional:
 *   PRICE_MATRIX_DIAS_ENTREGA=4   (por defecto 4)
 *   DATABASE_SSL=true             (p. ej. Supabase; rejectUnauthorized: false)
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { PriceMatrix } from '../src/catalog/entities/price-matrix.entity';
import { buildPriceMatrixSeedRows } from '../src/catalog/price-matrix-seed.data';

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('Define DATABASE_URL antes de ejecutar el seed.');
  }

  const diasRaw = process.env.PRICE_MATRIX_DIAS_ENTREGA;
  const diasEntrega = diasRaw != null && diasRaw !== '' ? Number(diasRaw) : 4;
  if (!Number.isFinite(diasEntrega) || diasEntrega < 0) {
    throw new Error('PRICE_MATRIX_DIAS_ENTREGA debe ser un número >= 0');
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
    const seed = buildPriceMatrixSeedRows(diasEntrega);
    await repo.upsert(seed, {
      conflictPaths: ['servicio', 'severidad'],
      skipUpdateIfNoValuesChanged: false,
    });
    const count = await repo.count();
    console.log(`OK: ${seed.length} filas upsert (servicio×severidad). Total en tabla: ${count}.`);
  } finally {
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
