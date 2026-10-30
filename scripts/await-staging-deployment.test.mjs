import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentIdFromUp, verdictForDeployment } from './await-staging-deployment.mjs';

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

test('FAILED, la ausencia del id y una subida vacía no son SUCCESS', () => {
  assert.equal(verdictForDeployment([{ id: current, status: 'FAILED' }], current), 'fail');
  assert.equal(verdictForDeployment([{ id: current, status: 'CRASHED' }], current), 'fail');
  assert.equal(verdictForDeployment([], current), 'wait');
  assert.throws(() => deploymentIdFromUp('queued without id'), /esta ejecución/);
});
