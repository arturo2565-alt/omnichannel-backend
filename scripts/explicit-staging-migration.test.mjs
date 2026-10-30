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

test('dentro del contenedor exige el servicio staging del proyecto compartido', () => {
  const container = {
    ...ready,
    EXPECTED_RAILWAY_PROJECT_ID: '11111111-1111-4111-8111-111111111111',
    EXPECTED_RAILWAY_ENVIRONMENT_ID: '33333333-3333-4333-8333-333333333333',
    EXPECTED_RAILWAY_SERVICE_ID: '44444444-4444-4444-8444-444444444444',
    RAILWAY_PROJECT_ID: '11111111-1111-4111-8111-111111111111',
    RAILWAY_ENVIRONMENT_ID: '33333333-3333-4333-8333-333333333333',
    RAILWAY_ENVIRONMENT_NAME: 'staging',
    RAILWAY_SERVICE_ID: '44444444-4444-4444-8444-444444444444',
    RAILWAY_SERVICE_NAME: 'pegazuz-backend-staging',
  };
  assert.doesNotThrow(() => assertExplicitStagingMigration(container, url));
  assert.throws(
    () =>
      assertExplicitStagingMigration(
        { ...container, RAILWAY_SERVICE_NAME: 'omnichannel-backend' },
        url,
      ),
    /producción/,
  );
  assert.throws(
    () =>
      assertExplicitStagingMigration(
        { ...container, RAILWAY_ENVIRONMENT_NAME: 'production' },
        url,
      ),
    /producción/,
  );
  assert.throws(
    () =>
      assertExplicitStagingMigration(
        {
          ...container,
          RAILWAY_SERVICE_ID: '55555555-5555-4555-8555-555555555555',
        },
        url,
      ),
    (err) => {
      assert.match(err.message, /base de staging/);
      assert.equal(err.message.includes('55555555'), false);
      return true;
    },
  );
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
