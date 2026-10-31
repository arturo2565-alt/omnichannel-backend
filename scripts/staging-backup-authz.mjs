/**
 * Modelo local de las políticas aprobadas en DEVOPS-005.L.1.
 * No consulta AWS y no sustituye a SimulateCustomPolicy.
 */
import { readFileSync } from 'node:fs';
import { assertWriterPolicy } from './staging-private-backup.mjs';

export const WRITER_ARN = 'arn:aws:iam::461253922612:user/pegazuz-staging-backup-writer';
export const ADMIN_ARN = 'arn:aws:iam::461253922612:root';
export const BUCKET_ARN = 'arn:aws:s3:::pegazuz-staging-postgres';
export const PREFIX_ARN = `${BUCKET_ARN}/staging/postgres/*`;
export const OBJECT_ARN = `${BUCKET_ARN}/staging/postgres/20261031T160000Z.dump.enc`;

const POLICY_DIR = new URL('./policies/', import.meta.url);

export function loadApprovedPolicies() {
  const iam = JSON.parse(readFileSync(new URL('pegazuz-staging-backup-put-only.json', POLICY_DIR), 'utf8'));
  const bucket = JSON.parse(readFileSync(new URL('pegazuz-staging-postgres-bucket.json', POLICY_DIR), 'utf8'));
  return { iam, bucket };
}

function asList(value) {
  return Array.isArray(value) ? value : [value];
}

function patternMatches(pattern, value) {
  const source = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(value);
}

function anyPattern(patterns, value) {
  return asList(patterns).some((pattern) => patternMatches(pattern, value));
}

function principalMatches(statement, principal) {
  const spec = statement.Principal;
  if (spec === '*') return true;
  return asList(spec?.AWS).includes(principal);
}

function actionMatches(statement, action) {
  if (statement.Action != null && statement.NotAction != null) {
    throw new Error('backup ERROR: una sentencia no puede mezclar Action y NotAction.');
  }
  if (statement.NotAction != null) return !anyPattern(statement.NotAction, action);
  return anyPattern(statement.Action, action);
}

function resourceMatches(statement, resource) {
  if (statement.Resource != null && statement.NotResource != null) {
    throw new Error('backup ERROR: una sentencia no puede mezclar Resource y NotResource.');
  }
  if (statement.NotResource != null) return !anyPattern(statement.NotResource, resource);
  return anyPattern(statement.Resource, resource);
}

function conditionsMatch(condition, context) {
  if (condition == null) return true;
  for (const [operator, keys] of Object.entries(condition)) {
    for (const [key, expected] of Object.entries(keys)) {
      const present = Object.prototype.hasOwnProperty.call(context, key);
      if (operator === 'Bool') {
        if (!present || String(context[key]) !== String(expected)) return false;
      } else if (operator === 'Null') {
        const wantAbsent = String(expected) === 'true';
        if (wantAbsent === present) return false;
      } else {
        throw new Error(`backup ERROR: el operador ${operator} no está modelado.`);
      }
    }
  }
  return true;
}

function statementMatches(statement, request) {
  return (
    principalMatches(statement, request.principal) &&
    actionMatches(statement, request.action) &&
    resourceMatches(statement, request.resource) &&
    conditionsMatch(statement.Condition, request.context ?? {})
  );
}

function inThisBucket(resource) {
  return resource === BUCKET_ARN || resource.startsWith(`${BUCKET_ARN}/`);
}

export function evaluateAuthz(request, documents = loadApprovedPolicies()) {
  const matched = [];
  if (request.iamAttached && request.principal === WRITER_ARN) {
    for (const statement of documents.iam.Statement) {
      if (statementMatches({ ...statement, Principal: '*' }, request)) matched.push(statement);
    }
  }
  if (request.resourcePolicy !== false && inThisBucket(request.resource)) {
    for (const statement of documents.bucket.Statement) {
      if (statementMatches(statement, request)) matched.push(statement);
    }
  }
  const denies = matched.filter((statement) => statement.Effect === 'Deny').map((statement) => statement.Sid);
  const allows = matched.filter((statement) => statement.Effect === 'Allow').map((statement) => statement.Sid);
  if (denies.length > 0) return { decision: 'explicit-deny', denies, allows };
  if (allows.length > 0) return { decision: 'allow', denies, allows };
  return { decision: 'implicit-deny', denies, allows };
}

export function auditApprovedPolicies(documents = loadApprovedPolicies()) {
  const errors = [];
  try {
    assertWriterPolicy(documents.iam);
  } catch (err) {
    errors.push(err.message);
  }
  const iam = documents.iam.Statement[0];
  if (iam?.Resource !== PREFIX_ARN) errors.push('el Allow de IAM no apunta al prefijo de este bucket');
  if (iam?.Condition?.Bool?.['aws:SecureTransport'] !== 'true') errors.push('IAM no exige TLS');
  if (iam?.Condition?.Null?.['s3:if-none-match'] !== 'false') errors.push('IAM no exige If-None-Match');
  const statements = documents.bucket.Statement ?? [];
  const sids = statements.map((statement) => statement.Sid);
  const expected = [
    'DenyInsecureTransport',
    'DenyWriterExceptPut',
    'DenyWriterPutOutsidePrefix',
    'DenyWriterMultipartOperations',
    'DenyWriterUnconditionalWrite',
  ];
  if (sids.join() !== expected.join()) errors.push('las sentencias del bucket no están en el orden aprobado');
  if (statements.some((statement) => statement.Effect !== 'Deny')) errors.push('el bucket no puede conceder Allow');
  if (statements.some((statement) => statement.NotAction != null && statement.NotResource != null)) {
    errors.push('NotAction y NotResource comparten sentencia');
  }
  for (const statement of statements.slice(1)) {
    if (statement.Principal?.AWS !== WRITER_ARN) errors.push(`${statement.Sid} no está limitado al writer`);
  }
  const https = statements[0];
  if (https.Principal !== '*' || https.Action !== 's3:*') errors.push('DenyInsecureTransport cambió de alcance');
  if (https.Condition?.Bool?.['aws:SecureTransport'] !== 'false') errors.push('DenyInsecureTransport ya no exige HTTPS');
  return errors;
}
