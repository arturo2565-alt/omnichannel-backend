/**
 * Pobla `price_matrix` con los valores legados (misma matriz que antes en código).
 * Uso: desde omnichannel-backend, con DATABASE_URL en el entorno:
 *   npx ts-node -r tsconfig-paths/register scripts/seed-price-matrix.ts
 *
 * No inserta nada si la tabla ya tiene filas (idempotente).
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { PriceMatrixEntity } from '../src/chat/entities/price-matrix.entity';
import { buildFlatSeedRows } from '../src/chat/price-matrix.seed-data';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !String(url).trim()) {
    console.error('DATABASE_URL no está definida en el entorno.');
    process.exit(1);
  }

  const ds = new DataSource({
    type: 'postgres',
    url: String(url).trim(),
    entities: [PriceMatrixEntity],
    synchronize: false,
    ssl:
      process.env.DATABASE_SSL === 'true' ||
      String(url).includes('supabase') ||
      String(url).includes('neon.tech')
        ? { rejectUnauthorized: false }
        : false,
  });

  await ds.initialize();
  const repo = ds.getRepository(PriceMatrixEntity);
  const n = await repo.count();
  if (n > 0) {
    console.log(`price_matrix ya contiene ${n} filas; no se modifica.`);
    await ds.destroy();
    return;
  }

  const flat = buildFlatSeedRows();
  await repo.save(
    flat.map((f) =>
      repo.create({
        pieza: f.pieza,
        severidad: f.severidad,
        precio: f.precio,
        diasEntrega: f.diasEntrega,
      }),
    ),
  );
  console.log(`Insertadas ${flat.length} filas en price_matrix.`);
  await ds.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
