import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertDetachedUpload,
  deploymentIdFromUp,
  verdictForDeployment,
} from './await-staging-deployment.mjs';

const current = '11111111-1111-4111-8111-111111111111';
const newer = '22222222-2222-4222-8222-222222222222';

test('toma el id de esta subida aunque el CLI escriba otra línea', () => {
  const text = `Indexing...\n{"deploymentId":"${current}","logsUrl":"https://railway.com/logs"}\n`;
  assert.equal(deploymentIdFromUp(text), current);
});

test('un SUCCESS ajeno no acredita esta ejecución', () => {
  const list = [
    { id: newer, status: 'SUCCESS' },
    { id: current, status: 'BUILDING' },
  ];
  assert.equal(verdictForDeployment(list, current), 'wait');
  assert.equal(
    verdictForDeployment([{ id: current, status: 'SUCCESS' }, { id: newer, status: 'FAILED' }], current),
    'success',
  );
});

test('la subida tiene que ser el servicio staging del proyecto compartido', () => {
  const project = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const environment = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const service = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const text = JSON.stringify({
    deploymentId: current,
    logsUrl: `https://railway.com/project/${project}/service/${service}?environmentId=${environment}`,
  });
  assert.equal(
    assertDetachedUpload(text, { projectId: project, environmentId: environment, serviceId: service }),
    current,
  );
  assert.throws(
    () =>
      assertDetachedUpload(text, {
        projectId: project,
        environmentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        serviceId: service,
      }),
    /entorno staging/,
  );
  assert.throws(
    () =>
      assertDetachedUpload(text, {
        projectId: project,
        environmentId: environment,
        serviceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      }),
    /servicio de staging/,
  );
});

test('FAILED, la ausencia del id y una subida vacía no son SUCCESS', () => {
  assert.equal(verdictForDeployment([{ id: current, status: 'FAILED' }], current), 'fail');
  assert.equal(verdictForDeployment([{ id: current, status: 'CRASHED' }], current), 'fail');
  assert.equal(verdictForDeployment([], current), 'wait');
  assert.throws(() => deploymentIdFromUp('queued without id'), /esta ejecución/);
});
