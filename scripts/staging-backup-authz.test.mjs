import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADMIN_ARN,
  BUCKET_ARN,
  OBJECT_ARN,
  WRITER_ARN,
  auditApprovedPolicies,
  evaluateAuthz,
} from './staging-backup-authz.mjs';

const OTHER_OBJECT = 'arn:aws:s3:::pegazuz-staging-postgres/staging/other/file';
const OTHER_BUCKET = 'arn:aws:s3:::pegazuz-staging-postgres-evil/staging/postgres/file';

function request(partial) {
  return {
    principal: WRITER_ARN,
    iamAttached: false,
    resourcePolicy: true,
    context: { 'aws:SecureTransport': 'true' },
    ...partial,
    context: { 'aws:SecureTransport': 'true', ...(partial.context ?? {}) },
  };
}

const cases = [
  ['ListBucket sin identidad, con política de bucket', request({
    action: 's3:ListBucket',
    resource: BUCKET_ARN,
  }), 'explicit-deny', ['DenyWriterExceptPut']],
  ['GetObject sobre un objeto del prefijo', request({
    action: 's3:GetObject',
    resource: OBJECT_ARN,
  }), 'explicit-deny', ['DenyWriterExceptPut']],
  ['DeleteObject sobre un objeto del prefijo', request({
    action: 's3:DeleteObject',
    resource: OBJECT_ARN,
  }), 'explicit-deny', ['DenyWriterExceptPut']],
  ['PutObjectRetention', request({
    action: 's3:PutObjectRetention',
    resource: OBJECT_ARN,
  }), 'explicit-deny', ['DenyWriterExceptPut']],
  ['AbortMultipartUpload', request({
    action: 's3:AbortMultipartUpload',
    resource: OBJECT_ARN,
  }), 'explicit-deny', ['DenyWriterExceptPut']],
  ['PutObject válido todavía sin IAM asociada', request({
    action: 's3:PutObject',
    resource: OBJECT_ARN,
    context: { 's3:ObjectCreationOperation': 'true', 's3:if-none-match': '*' },
  }), 'implicit-deny', []],
  ['PutObject válido con la IAM asociada', request({
    action: 's3:PutObject',
    resource: OBJECT_ARN,
    iamAttached: true,
    context: { 's3:ObjectCreationOperation': 'true', 's3:if-none-match': '*' },
  }), 'allow', []],
  ['PutObject fuera del prefijo', request({
    action: 's3:PutObject',
    resource: OTHER_OBJECT,
    iamAttached: true,
    context: { 's3:ObjectCreationOperation': 'true', 's3:if-none-match': '*' },
  }), 'explicit-deny', ['DenyWriterPutOutsidePrefix']],
  ['PutObject sin If-None-Match', request({
    action: 's3:PutObject',
    resource: OBJECT_ARN,
    iamAttached: true,
    context: { 's3:ObjectCreationOperation': 'true' },
  }), 'explicit-deny', ['DenyWriterUnconditionalWrite']],
  ['PutObject sin TLS', request({
    action: 's3:PutObject',
    resource: OBJECT_ARN,
    iamAttached: true,
    context: {
      'aws:SecureTransport': 'false',
      's3:ObjectCreationOperation': 'true',
      's3:if-none-match': '*',
    },
  }), 'explicit-deny', ['DenyInsecureTransport']],
  ['CreateMultipartUpload', request({
    action: 's3:PutObject',
    resource: OBJECT_ARN,
    iamAttached: true,
    context: { 's3:ObjectCreationOperation': 'false' },
  }), 'explicit-deny', ['DenyWriterMultipartOperations']],
  ['UploadPart', request({
    action: 's3:PutObject',
    resource: OBJECT_ARN,
    iamAttached: true,
    context: { 's3:ObjectCreationOperation': 'false' },
  }), 'explicit-deny', ['DenyWriterMultipartOperations']],
  ['CompleteMultipartUpload con If-None-Match', request({
    action: 's3:PutObject',
    resource: OBJECT_ARN,
    iamAttached: true,
    context: { 's3:ObjectCreationOperation': 'true', 's3:if-none-match': '*' },
  }), 'allow', []],
  ['CompleteMultipartUpload sin If-None-Match', request({
    action: 's3:PutObject',
    resource: OBJECT_ARN,
    iamAttached: true,
    context: { 's3:ObjectCreationOperation': 'true' },
  }), 'explicit-deny', ['DenyWriterUnconditionalWrite']],
  ['administrador por HTTPS', request({
    principal: ADMIN_ARN,
    action: 's3:PutObject',
    resource: OBJECT_ARN,
    iamAttached: true,
    context: { 's3:ObjectCreationOperation': 'true', 's3:if-none-match': '*' },
  }), 'implicit-deny', []],
  ['administrador por HTTP', request({
    principal: ADMIN_ARN,
    action: 's3:GetObject',
    resource: OBJECT_ARN,
    context: { 'aws:SecureTransport': 'false' },
  }), 'explicit-deny', ['DenyInsecureTransport']],
  ['PutObject sin la clave ObjectCreationOperation', request({
    action: 's3:PutObject',
    resource: OBJECT_ARN,
    iamAttached: true,
    context: {},
  }), 'implicit-deny', []],
  ['PutObject en otro bucket', request({
    action: 's3:PutObject',
    resource: OTHER_BUCKET,
    iamAttached: true,
    context: { 's3:ObjectCreationOperation': 'true', 's3:if-none-match': '*' },
  }), 'implicit-deny', []],
  ['GetObject como en la consola, sin política de recurso', request({
    action: 's3:GetObject',
    resource: OBJECT_ARN,
    resourcePolicy: false,
  }), 'implicit-deny', []],
];

test('las copias locales cumplen el contrato aprobado', () => {
  assert.deepEqual(auditApprovedPolicies(), []);
});

test('el modelo local separa denegación explícita, permiso e implícita', () => {
  for (const [name, spec, decision, denies] of cases) {
    const result = evaluateAuthz(spec);
    assert.deepEqual(result.decision, decision, name);
    assert.deepEqual(result.denies, denies, name);
  }
});
