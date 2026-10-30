import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertRailwayProjectToken,
  assertStagingBackupUrl,
  assertStagingDeployTarget,
} from './staging-deploy-target';

const project = '11111111-1111-4111-8111-111111111111';
const environmentId = '33333333-3333-4333-8333-333333333333';
const serviceId = '44444444-4444-4444-8444-444444444444';

const ready = {
  RAILWAY_ENVIRONMENT: 'staging',
  RAILWAY_PROJECT_ID: project,
  PRODUCTION_RAILWAY_PROJECT_ID: project,
  RAILWAY_STAGING_ENVIRONMENT_ID: environmentId,
  RAILWAY_STAGING_SERVICE_ID: serviceId,
  RAILWAY_SERVICE: 'pegazuz-backend-staging',
  PRODUCTION_RAILWAY_SERVICE: 'omnichannel-backend',
  STAGING_DB_HOST: 'postgres.railway.internal',
  STAGING_PUBLIC_HOST: 'api.staging.example.test',
  STAGING_SMOKE_URL: 'https://api.staging.example.test/api/health',
  STAGING_NATIVE_DEPLOY: 'off',
  DB_SYNCHRONIZE: 'false',
  PEGAZUZ_ENV: 'staging',
};

describe('assertStagingDeployTarget', () => {
  it('acepta el mismo proyecto cuando el entorno y el servicio son los de staging', () => {
    expect(() => assertStagingDeployTarget(ready)).not.toThrow();
    expect(() =>
      assertStagingDeployTarget({
        ...ready,
        PRODUCTION_RAILWAY_PROJECT_ID: '22222222-2222-4222-8222-222222222222',
      }),
    ).not.toThrow();
  });

  it('rechaza producción, el mismo servicio y el autodeploy nativo', () => {
    expect(() =>
      assertStagingDeployTarget({ ...ready, RAILWAY_ENVIRONMENT: 'production' }),
    ).toThrow(/staging/);
    expect(() =>
      assertStagingDeployTarget({ ...ready, RAILWAY_SERVICE: 'omnichannel-backend' }),
    ).toThrow(/producción/);
    expect(() =>
      assertStagingDeployTarget({ ...ready, RAILWAY_SERVICE: 'otro-staging' }),
    ).toThrow(/pegazuz-backend-staging/);
    expect(() =>
      assertStagingDeployTarget({
        ...ready,
        PRODUCTION_RAILWAY_SERVICE: ready.RAILWAY_SERVICE,
      }),
    ).toThrow(/separado/);
    expect(() =>
      assertStagingDeployTarget({ ...ready, RAILWAY_STAGING_ENVIRONMENT_ID: serviceId }),
    ).toThrow(/UUID/);
    expect(() =>
      assertStagingDeployTarget({ ...ready, RAILWAY_STAGING_SERVICE_ID: '' }),
    ).toThrow(/RAILWAY_STAGING_SERVICE_ID/);
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
      assertStagingDeployTarget({ ...ready, RAILWAY_PROJECT_ID: 'pegazuz-staging' }),
    ).toThrow(/UUID del proyecto/);
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

describe('assertRailwayProjectToken', () => {
  const scope = {
    RAILWAY_PROJECT_ID: project,
    RAILWAY_STAGING_ENVIRONMENT_ID: environmentId,
  };
  const payload = {
    data: { projectToken: { projectId: project, environmentId } },
  };

  it('acepta el project token del entorno staging del mismo proyecto', () => {
    expect(() => assertRailwayProjectToken(payload, scope)).not.toThrow();
  });

  it('rechaza un token de cuenta, el entorno production y otro proyecto', () => {
    expect(() => assertRailwayProjectToken({ data: {} }, scope)).toThrow(/project token/);
    expect(() => assertRailwayProjectToken({ errors: [{ message: 'Unauthorized' }] }, scope)).toThrow(
      /project token/,
    );
    let thrown = false;
    try {
      assertRailwayProjectToken(
        {
          data: {
            projectToken: {
              projectId: project,
              environmentId: '55555555-5555-4555-8555-555555555555',
            },
          },
        },
        scope,
      );
    } catch (err) {
      thrown = true;
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/entorno staging fijado/);
      expect(message).not.toContain(project);
      expect(message).not.toContain(environmentId);
    }
    expect(thrown).toBe(true);
    expect(() =>
      assertRailwayProjectToken(
        {
          data: {
            projectToken: {
              projectId: '22222222-2222-4222-8222-222222222222',
              environmentId,
            },
          },
        },
        scope,
      ),
    ).toThrow(/entorno staging fijado/);
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
    expect(staging).toContain('--service "$RAILWAY_STAGING_SERVICE_ID"');
    expect(staging).toContain('--environment "$RAILWAY_STAGING_ENVIRONMENT_ID"');
    expect(staging).toContain('pegazuz-backend-staging');
    expect(staging).toContain('omnichannel-backend');
    expect(staging).toContain('Project-Access-Token');
    expect(staging).toContain('projectToken');
    expect(staging).toContain('check:railway-token');
    expect(staging).toContain('await-staging-deployment.mjs target');
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
    expect(migrate).toContain('--service "$RAILWAY_STAGING_SERVICE_ID"');
    expect(migrate).toContain('--environment "$RAILWAY_STAGING_ENVIRONMENT_ID"');
    expect(migrate).toContain('EXPECTED_RAILWAY_SERVICE_ID');
    expect(migrate).toContain('pegazuz-backend-staging');
    expect(migrate).toContain('omnichannel-backend');
    expect(migrate).toContain('check:railway-token');
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
    expect(production).toContain('tiene que ser production');
    expect(production).toContain('coincide con staging');
    expect(production).not.toContain('migrate:');
    expect(production).not.toContain('RAILWAY_STAGING_SERVICE_ID');
    expect(production).toContain('actions/checkout@v4');
    expect(production).not.toContain('actions/checkout@v5');
    expect(verify).not.toContain('railway up');
    expect(verify).not.toContain('vercel deploy');
  });
});
