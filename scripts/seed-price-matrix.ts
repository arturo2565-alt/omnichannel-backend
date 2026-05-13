/**
 * Semilla de `price_matrix` desde la matriz canónica en `src/chat/autofix-config.ts`
 * (mismos precios que antes estaban hardcoded).
 *
 * Uso (desde `omnichannel-backend/`):
 *   DATABASE_URL=postgres://... npm run seed:price-matrix
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { PriceMatrix } from '../src/catalog/entities/price-matrix.entity';
import { getPriceMatrixSeedRows } from '../src/chat/autofix-config';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error('Falta DATABASE_URL en el entorno.');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const repo = app.get<Repository<PriceMatrix>>(getRepositoryToken(PriceMatrix));
    const rows = getPriceMatrixSeedRows();

    await repo.manager.transaction(async (em) => {
      await em.getRepository(PriceMatrix).createQueryBuilder().delete().execute();
      await em.getRepository(PriceMatrix).insert(
        rows.map((r) => ({
          pieza: r.pieza,
          severidad: r.severidad,
          precio: r.precio,
          diasEntrega: r.diasEntrega,
        })),
      );
    });

    console.log(`Semilla OK: ${rows.length} filas en price_matrix.`);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
