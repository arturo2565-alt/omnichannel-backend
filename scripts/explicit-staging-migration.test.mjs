import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertExplicitStagingMigration } from './apply-explicit-staging-migrations.mjs';

const ready = {
  CRM_MIGRATE_TARGET: 'staging',
  CRM_STAGING_MIGRATE: 'yes',
  DB_SYNCHRONIZE: 'false',
  STAGING_DB_HOST: 'db.example.test',
};
const url = 'postgres://user:secret@db.example.test:5432/app';

test('acepta el host fijado de staging', () => {
  assert.doesNotThrow(() => assertExplicitStagingMigration(ready, url));
});

test('rechaza producción, synchronize y un host distinto sin revelarlos', () => {
  assert.throws(
    () =>
      assertExplicitStagingMigration(
        { ...ready, STAGING_DB_HOST: 'db.production.internal' },
        'postgres://user:secret@db.production.internal:5432/app',
      ),
    /producción/,
  );
  assert.throws(
    () => assertExplicitStagingMigration({ ...ready, DB_SYNCHRONIZE: 'true' }, url),
    /DB_SYNCHRONIZE/,
  );
  assert.throws(
    () => assertExplicitStagingMigration({ ...ready, CRM_PRODUCTION_MIGRATE: 'yes' }, url),
    /producción/,
  );
  assert.throws(
    () => assertExplicitStagingMigration({ ...ready, CRM_MIGRATE_TARGET: 'production' }, url),
    /staging/,
  );
  assert.throws(
    () => assertExplicitStagingMigration(ready, url.replace('db.example.test', 'otro.example.test')),
    (err) => {
      assert.match(err.message, /no coincide/);
      assert.equal(err.message.includes('secret'), false);
      assert.equal(err.message.includes('otro.example.test'), false);
      assert.equal(err.message.includes('db.example.test'), false);
      return true;
    },
  );
});
