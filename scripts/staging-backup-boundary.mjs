/**
 * Modelo local de la permissions boundary propuesta.
 * Una concesión directa al ARN del usuario no queda limitada por la ausencia de Allow.
 * Un Deny explícito de la boundary sí la corta. No consulta AWS.
 */
import { readFileSync } from 'node:fs';
import { assertWriterPolicy } from './staging-private-backup.mjs';
import { OBJECT_ARN, PREFIX_ARN, WRITER_ARN, loadApprovedPolicies } from './staging-backup-authz.mjs';

const BOUNDARY_URL = new URL('./policies/pegazuz-staging-backup-boundary.json', import.meta.url);

export function loadBoundary() {
  return JSON.parse(readFileSync(BOUNDARY_URL, 'utf8'));
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

function actionMatches(statement, action) {
  if (statement.NotAction != null) return !anyPattern(statement.NotAction, action);
  return anyPattern(statement.Action, action);
}

function resourceMatches(statement, resource) {
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
        if ((String(expected) === 'true') === present) return false;
      } else {
        throw new Error(`backup ERROR: el operador ${operator} no está modelado.`);
      }
    }
  }
  return true;
}

function matches(statement, request) {
  return (
    actionMatches(statement, request.action) &&
    resourceMatches(statement, request.resource) &&
    conditionsMatch(statement.Condition, request.context ?? {})
  );
}

function identityDocument(kind) {
  if (kind === 'put-only') return loadApprovedPolicies().iam;
  if (kind === 's3-full') {
    return { Statement: [{ Sid: 'S3Full', Effect: 'Allow', Action: 's3:*', Resource: '*' }] };
  }
  if (kind === 'admin') {
    return { Statement: [{ Sid: 'Admin', Effect: 'Allow', Action: '*', Resource: '*' }] };
  }
  return { Statement: [] };
}

export function auditBoundary() {
  const boundary = loadBoundary();
  const errors = [];
  const allow = boundary.Statement.filter((statement) => statement.Effect === 'Allow');
  if (allow.length !== 1 || allow[0].Action !== 's3:PutObject' || allow[0].Resource !== PREFIX_ARN) {
    errors.push('la boundary debe tener un solo Allow de PutObject sobre el prefijo');
  }
  if (allow[0]?.Condition?.Bool?.['s3:ObjectCreationOperation'] !== 'true') {
    errors.push('el Allow no exige la operación que crea el objeto');
  }
  if (!boundary.Statement.some((statement) => statement.Effect === 'Deny' && statement.NotAction === 's3:PutObject')) {
    errors.push('falta el Deny explícito del resto de acciones');
  }
  try {
    assertWriterPolicy(boundary);
    errors.push('assertWriterPolicy no debe aceptar la boundary');
  } catch {
    // La política de identidad sigue siendo la de una sola sentencia.
  }
  try {
    assertWriterPolicy(loadApprovedPolicies().iam);
  } catch (err) {
    errors.push(err.message);
  }
  return errors;
}

export function evaluateBoundary(request) {
  const boundary = loadBoundary();
  const activeBoundary = request.boundary === 'allow-only'
    ? { Statement: boundary.Statement.filter((statement) => statement.Effect === 'Allow') }
    : boundary;
  const denies = [];
  if (request.boundary) {
    for (const statement of activeBoundary.Statement) {
      if (statement.Effect === 'Deny' && matches(statement, request)) denies.push(statement.Sid);
    }
  }
  if (denies.length > 0) return { decision: 'explicit-deny', denies };
  const identityAllow = identityDocument(request.identity).Statement.some(
    (statement) => statement.Effect === 'Allow' && matches(statement, request),
  );
  const boundaryAllow = request.boundary
    ? activeBoundary.Statement.some((statement) => statement.Effect === 'Allow' && matches(statement, request))
    : true;
  const identityPath = identityAllow && boundaryAllow;
  const userArnBypass = request.directUserGrant === true && request.principalKind !== 'role';
  const roleGrantLimited = request.directUserGrant === true && request.principalKind === 'role' && boundaryAllow;
  if (identityPath || userArnBypass || roleGrantLimited) return { decision: 'allow', denies };
  return { decision: 'implicit-deny', denies };
}

export { OBJECT_ARN, WRITER_ARN };
