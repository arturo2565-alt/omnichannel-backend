/**
 * Aplica src/chat/migrations/003_llm_calls_prompt_versions.sql
 *
 *   DATABASE_URL=postgres://... npm run migrate:llm-calls-prompt-versions
 *
 * Si DB_SYNCHRONIZE=true, TypeORM ya crea las columnas desde LlmCall.
 * Este script es el mecanismo explícito cuando synchronize está desactivado.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { LlmCall } from '../src/chat/entities/llm-call.entity';

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.log(
      'migrate:llm-calls-prompt-versions SKIP — no DATABASE_URL. El SQL está en src/chat/migrations/003_llm_calls_prompt_versions.sql',
    );
    process.exit(0);
  }

  const useSsl =
    process.env.DATABASE_SSL === 'true' || /sslmode=require/i.test(url);
  const sql = readFileSync(
    join(__dirname, '../src/chat/migrations/003_llm_calls_prompt_versions.sql'),
    'utf8',
  );

  const ds = new DataSource({
    type: 'postgres',
    url,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    entities: [LlmCall],
    synchronize: false,
  });

  await ds.initialize();
  try {
    await ds.query(sql);
    const cols = await ds.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'llm_calls'
        AND column_name IN (
          'visionPromptVersion',
          'baseChatPromptVersion',
          'catalogAppendVersion',
          'effectiveChatPromptHash',
          'caseId',
          'promptLabel'
        )
      ORDER BY column_name
    `);
    console.log(
      `OK: migración 003 aplicada. Columnas: ${cols.map((c: { column_name: string }) => c.column_name).join(', ')}`,
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
