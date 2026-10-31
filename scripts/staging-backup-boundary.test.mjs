import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OBJECT_ARN, auditBoundary, evaluateBoundary } from './staging-backup-boundary.mjs';

const OTHER = 'arn:aws:s3:::otro-bucket/objeto';
const good = {
  'aws:SecureTransport': 'true',
  's3:ObjectCreationOperation': 'true',
  's3:if-none-match': '*',
};

test('la boundary no sustituye a la política de una sentencia', () => {
  assert.deepEqual(auditBoundary(), []);
});

test('el Allow solo no aísla una concesión directa al ARN del usuario', () => {
  const request = {
    action: 'secretsmanager:GetSecretValue',
    resource: 'arn:aws:secretsmanager:us-east-1:461253922612:secret:ejemplo',
    context: {},
    identity: 'none',
    directUserGrant: true,
    principalKind: 'iam-user',
  };
  const open = evaluateBoundary({ ...request, boundary: 'allow-only' });
  const closed = evaluateBoundary({ ...request, boundary: 'with-denies' });
  assert.equal(open.decision, 'allow');
  assert.equal(closed.decision, 'explicit-deny');
  assert.deepEqual(closed.denies, ['DenyExceptPut']);
});

test('una política administrativa queda recortada por los Deny', () => {
  const rows = [
    ['s3:GetObject', OBJECT_ARN, good, 'explicit-deny'],
    ['s3:DeleteObject', OBJECT_ARN, good, 'explicit-deny'],
    ['s3:ListBucket', 'arn:aws:s3:::pegazuz-staging-postgres', good, 'explicit-deny'],
    ['s3:PutBucketPolicy', 'arn:aws:s3:::pegazuz-staging-postgres', good, 'explicit-deny'],
    ['s3:BypassGovernanceRetention', OBJECT_ARN, good, 'explicit-deny'],
    ['iam:CreateAccessKey', 'arn:aws:iam::461253922612:user/pegazuz-staging-backup-writer', {}, 'explicit-deny'],
    ['iam:DeleteUserPermissionsBoundary', 'arn:aws:iam::461253922612:user/pegazuz-staging-backup-writer', {}, 'explicit-deny'],
    ['s3:PutObject', OTHER, good, 'explicit-deny'],
    ['s3:PutObject', OBJECT_ARN, { ...good, 's3:ObjectCreationOperation': 'false' }, 'explicit-deny'],
    ['s3:PutObject', OBJECT_ARN, { 'aws:SecureTransport': 'true', 's3:ObjectCreationOperation': 'true' }, 'explicit-deny'],
    ['s3:PutObject', OBJECT_ARN, { ...good, 'aws:SecureTransport': 'false' }, 'explicit-deny'],
    ['s3:PutObject', OBJECT_ARN, good, 'allow'],
  ];
  for (const [action, resource, context, decision] of rows) {
    const result = evaluateBoundary({
      action,
      resource,
      context,
      identity: 'admin',
      boundary: 'with-denies',
      directUserGrant: false,
      principalKind: 'iam-user',
    });
    assert.equal(result.decision, decision, action);
  }
});

test('la boundary no concede permiso por sí misma', () => {
  const result = evaluateBoundary({
    action: 's3:PutObject',
    resource: OBJECT_ARN,
    context: {
      'aws:SecureTransport': 'true',
      's3:ObjectCreationOperation': 'true',
      's3:if-none-match': '*',
    },
    identity: 'none',
    boundary: 'with-denies',
    directUserGrant: false,
    principalKind: 'iam-user',
  });
  assert.equal(result.decision, 'implicit-deny');
});

test('un rol queda limitado por la falta de Allow y una sesión STS no', () => {
  const request = {
    action: 's3:GetObject',
    resource: OTHER,
    context: {},
    identity: 'none',
    boundary: 'allow-only',
    directUserGrant: true,
  };
  assert.equal(evaluateBoundary({ ...request, principalKind: 'role' }).decision, 'implicit-deny');
  assert.equal(evaluateBoundary({ ...request, principalKind: 'role-session' }).decision, 'allow');
  assert.equal(
    evaluateBoundary({ ...request, principalKind: 'role-session', boundary: 'with-denies' }).decision,
    'explicit-deny',
  );
});
