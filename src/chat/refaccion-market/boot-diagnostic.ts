import { isMarketTraceEnabled, isMarketTraceVerboseEnabled } from './market-search-trace';
import { isSerperConfigured } from './serper-config';

export const PEG_BOOT_DIAGNOSTIC_PREFIX = '[PEG_BOOT_DIAGNOSTIC]';
export const SERPER_SHOPPING_DIAG_BUILD_MARKER = 'SERPER_SHOPPING_DIAG_V1';

export type PegBootDiagnostic = {
  app: 'omnichannel-backend';
  serperConfigured: boolean;
  marketTrace: boolean;
  marketTraceVerbose: boolean;
  nodeEnv: string | null;
  railwayEnvironment?: string;
  railwayService?: string;
  gitCommitSha?: string;
  buildMarker: typeof SERPER_SHOPPING_DIAG_BUILD_MARKER;
};

export function readRailwayEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    String(env.RAILWAY_ENVIRONMENT_NAME ?? env.RAILWAY_ENVIRONMENT ?? '').trim() ||
    undefined
  );
}

export function readRailwayService(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return String(env.RAILWAY_SERVICE_NAME ?? '').trim() || undefined;
}

export function readGitCommitSha(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    String(
      env.RAILWAY_GIT_COMMIT_SHA ??
        env.RAILWAY_GIT_COMMIT ??
        env.SOURCE_COMMIT ??
        env.GIT_COMMIT ??
        '',
    ).trim() || undefined
  );
}

export function buildPegBootDiagnostic(
  env: NodeJS.ProcessEnv = process.env,
): PegBootDiagnostic {
  return {
    app: 'omnichannel-backend',
    serperConfigured: isSerperConfigured(env),
    marketTrace: isMarketTraceEnabled(),
    marketTraceVerbose: isMarketTraceVerboseEnabled(),
    nodeEnv: env.NODE_ENV ?? null,
    railwayEnvironment: readRailwayEnvironment(env),
    railwayService: readRailwayService(env),
    gitCommitSha: readGitCommitSha(env),
    buildMarker: SERPER_SHOPPING_DIAG_BUILD_MARKER,
  };
}

export function emitPegBootDiagnostic(
  env: NodeJS.ProcessEnv = process.env,
): PegBootDiagnostic {
  const payload = buildPegBootDiagnostic(env);
  console.log(`${PEG_BOOT_DIAGNOSTIC_PREFIX} ${JSON.stringify(payload)}`);
  return payload;
}
