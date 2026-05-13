/**
 * Puebla la tabla `price_matrix` con los mismos valores que antes estaban en código
 * ({@link LEGACY_SEED_PIEZA_DANO_PRICE_MATRIX} en `autofix-config.ts`).
 *
 * Uso (desde `omnichannel-backend/`):
 *   DATABASE_URL="postgres://..." npx ts-node --transpile-only -r tsconfig-paths/register scripts/seed-price-matrix.ts
 *
 * Requiere que la entidad esté sincronizada (p. ej. `synchronize: true` en Nest) o que la tabla exista.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { PriceMatrixEntity } from '../src/chat/entities/price-matrix.entity';
import {
  DAMAGE_LEVEL_KEYS,
  LEGACY_SEED_PIEZA_DANO_PRICE_MATRIX,
} from '../src/chat/autofix-config';

const DEFAULT_DIAS_ENTREGA = 4;

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('Define DATABASE_URL en el entorno para conectar a Postgres.');
  }

  const ds = new DataSource({
    type: 'postgres',
    url,
    entities: [PriceMatrixEntity],
    synchronize: true,
  });
  await ds.initialize();
  const repo = ds.getRepository(PriceMatrixEntity);

  const batch: Array<{
    pieza: string;
    severidad: string;
    precio: number;
    diasEntrega: number;
  }> = [];

  for (const pr of LEGACY_SEED_PIEZA_DANO_PRICE_MATRIX) {
    for (const lvl of DAMAGE_LEVEL_KEYS) {
      const precio = pr[lvl];
      if (typeof precio !== 'number' || !Number.isFinite(precio) || precio <= 0) {
        continue;
      }
      batch.push({
        pieza: pr.pieza,
        severidad: lvl,
        precio: Math.round(precio),
        diasEntrega: DEFAULT_DIAS_ENTREGA,
      });
    }
  }

  await repo.upsert(batch, { conflictPaths: ['pieza', 'severidad'] });
  // eslint-disable-next-line no-console
  console.log(
    `[seed-price-matrix] Upsert OK: ${batch.length} celdas (pieza × severidad), diasEntrega por defecto = ${DEFAULT_DIAS_ENTREGA}.`,
  );
  await ds.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
