import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertStagingBackupUrl,
  assertStagingDeployTarget,
} from './staging-deploy-target';

const ready = {
  RAILWAY_ENVIRONMENT: 'staging',
  RAILWAY_PROJECT_ID: '11111111-1111-4111-8111-111111111111',
  PRODUCTION_RAILWAY_PROJECT_ID: '22222222-2222-4222-8222-222222222222',
  RAILWAY_SERVICE: 'pegazuz-backend-staging',
  PRODUCTION_RAILWAY_SERVICE: 'omnichannel-backend-production',
  STAGING_DB_HOST: 'postgres.railway.internal',
  STAGING_PUBLIC_HOST: 'api.staging.example.test',
  STAGING_SMOKE_URL: 'https://api.staging.example.test/api/health',
  STAGING_NATIVE_DEPLOY: 'off',
  DB_SYNCHRONIZE: 'false',
  PEGAZUZ_ENV: 'staging',
};

describe('assertStagingDeployTarget', () => {
  it('acepta el servicio de staging separado de producción', () => {
    expect(() => assertStagingDeployTarget(ready)).not.toThrow();
  });

  it('rechaza producción, el mismo servicio y el autodeploy nativo', () => {
    expect(() =>
      assertStagingDeployTarget({ ...ready, RAILWAY_ENVIRONMENT: 'production' }),
    ).toThrow(/staging/);
    expect(() =>
      assertStagingDeployTarget({
        ...ready,
        RAILWAY_SERVICE: 'omnichannel-backend-production',
        PRODUCTION_RAILWAY_SERVICE: 'otro-servicio',
      }),
    ).toThrow(/servicio/);
    expect(() =>
      assertStagingDeployTarget({
        ...ready,
        PRODUCTION_RAILWAY_SERVICE: ready.RAILWAY_SERVICE,
      }),
    ).toThrow(/separado/);
    expect(() =>
      assertStagingDeployTarget({ ...ready, STAGING_NATIVE_DEPLOY: 'on' }),
    ).toThrow(/autodeploy nativo/);
    expect(() =>
      assertStagingDeployTarget({ ...ready, STAGING_NATIVE_DEPLOY: 'OFF' }),
    ).toThrow(/autodeploy nativo/);
    expect(() =>
      assertStagingDeployTarget({ ...ready, STAGING_NATIVE_DEPLOY: 'off ' }),
    ).toThrow(/autodeploy nativo/);
    expect(() =>
      assertStagingDeployTarget({
        ...ready,
        RAILWAY_PROJECT_ID: ready.PRODUCTION_RAILWAY_PROJECT_ID,
      }),
    ).toThrow(/proyecto de Railway/);
    expect(() =>
      assertStagingDeployTarget({ ...ready, RAILWAY_PROJECT_ID: 'pegazuz-staging' }),
    ).toThrow(/proyecto de Railway/);
    expect(() =>
      assertStagingDeployTarget({ ...ready, DB_SYNCHRONIZE: 'true' }),
    ).toThrow(/DB_SYNCHRONIZE/);
    expect(() =>
      assertStagingDeployTarget({ ...ready, CRM_PRODUCTION_MIGRATE: 'yes' }),
    ).toThrow(/producción/);
    expect(() =>
      assertStagingDeployTarget({ ...ready, CRM_MIGRATE_TARGET: 'staging' }),
    ).toThrow(/no migra/);
  });

  it('el humo tiene que ser el health del host fijado, sin revelarlo', () => {
    expect(() =>
      assertStagingDeployTarget({
        ...ready,
        STAGING_SMOKE_URL: 'https://api.production.example.test/api/health',
      }),
    ).toThrow(/host público/);
    try {
      assertStagingDeployTarget({
        ...ready,
        STAGING_SMOKE_URL: 'https://otro.example.test/api/health',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/no coincide/);
      expect(message).not.toContain('otro.example.test');
      expect(message).not.toContain('api.staging.example.test');
    }
    expect(() =>
      assertStagingDeployTarget({
        ...ready,
        STAGING_SMOKE_URL: 'https://api.staging.example.test/',
      }),
    ).toThrow(/\/api\/health/);
  });
});

describe('assertStagingBackupUrl', () => {
  const flags = {
    CRM_MIGRATE_TARGET: 'staging',
    CRM_STAGING_MIGRATE: 'yes',
    STAGING_DB_HOST: 'db.example.test',
  };

  it('rechaza la red privada y un host de producción', () => {
    expect(() =>
      assertStagingBackupUrl(
        'postgres://user:secret@postgres.railway.internal:5432/app',
        {
          ...flags,
          STAGING_DB_HOST: 'postgres.railway.internal',
        },
      ),
    ).toThrow(/red privada/);
    expect(() =>
      assertStagingBackupUrl(
        'postgres://user:secret@db.production.internal:5432/app',
        {
          ...flags,
          STAGING_DB_HOST: 'db.production.internal',
        },
      ),
    ).toThrow(/producción/);
  });

  it('un proxy público de staging pasa el candado y el error no revela la clave', () => {
    expect(() =>
      assertStagingBackupUrl('postgres://user:secret@db.example.test:5432/app', flags),
    ).not.toThrow();
    try {
      assertStagingBackupUrl('postgres://user:secret@otro.example.test:5432/app', flags);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('secret');
      expect(message).not.toContain('otro.example.test');
    }
  });
});

describe('workflows de staging', () => {
  const root = join(__dirname, '..', '..', '.github', 'workflows');
  const staging = readFileSync(join(root, 'staging.yml'), 'utf8');
  const migrate = readFileSync(join(root, 'staging-migrate.yml'), 'utf8');
  const production = readFileSync(join(root, 'production.yml'), 'utf8');
  const verify = readFileSync(join(root, 'crm-verify.yml'), 'utf8');

  it('el push a staging publica una sola vez y no migra', () => {
    expect(staging).toContain('genesis/staging');
    expect(staging.match(/@railway\/cli up/g)).toHaveLength(1);
    expect(staging).toContain("vars.STAGING_NATIVE_DEPLOY == 'off'");
    expect(staging).toContain("vars.STAGING_DEPLOY_ENABLED == 'true'");
    expect(staging).toContain('await-staging-deployment.mjs');
    expect(staging).toContain('deployment list --json');
    expect(staging).toContain('--project "$RAILWAY_PROJECT_ID"');
    expect(staging.indexOf('await-staging-deployment.mjs')).toBeLessThan(
      staging.indexOf('smoke:staging'),
    );
    expect(staging).toContain('smoke:staging');
    expect(staging).not.toContain('migrate:crm');
    expect(staging).not.toContain('seed:staging');
    expect(staging).not.toContain('DATABASE_URL');
    expect(staging).not.toContain('railway run');
    expect(staging).not.toContain("DB_SYNCHRONIZE: 'true'");
    expect(staging).not.toContain('DB_SYNCHRONIZE=true');
  });

  it('la migración es manual, dentro del servicio, y no corre en un push', () => {
    expect(migrate).toContain('workflow_dispatch');
    expect(migrate).not.toContain('push:');
    expect(migrate).toContain('migrate-staging');
    expect(migrate).toContain('STAGING_MIGRATE_ENABLED');
    expect(migrate).toContain('railway ssh');
    expect(migrate).toContain('--project "$RAILWAY_PROJECT_ID"');
    expect(migrate).toContain('check:staging-deploy');
    expect(migrate).toContain('apply-explicit-staging-migrations.mjs');
    expect(migrate).not.toContain('railway run');
    expect(migrate).not.toContain('seed:staging');
    expect(migrate).not.toContain('DATABASE_URL');
  });

  it('producción no sale de genesis/staging ni migra', () => {
    expect(production).toContain('workflow_dispatch');
    expect(production).not.toContain('push:');
    expect(production).toContain("refs/heads/main");
    expect(production).not.toContain('migrate:');
    expect(verify).not.toContain('railway up');
    expect(verify).not.toContain('vercel deploy');
  });
});
