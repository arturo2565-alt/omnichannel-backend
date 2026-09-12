/**
 * LEVEL 2 — evaluación con modelo real.
 * npm run eval:autonomy:live
 *
 * Misma cadena de parsers/engines que producción.
 * Prohibido: WhatsApp, Messenger, Twilio, citas, BD/catálogo productivos.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createVisionDamageAnalysisCompletion } from '../../chat/openai-vision-completion';
import { parseVisionModelJsonResponse } from '../../chat/vision-json-parse';
import { extractVisionViability } from '../../chat/vision-viability';
import { extractVisionDetectedVehicle } from '../../chat/vision-bpc-inventory';
import { parseVisionDamageItems } from '../../chat/vision-item-normalize';
import { canonicalizePanelCode } from '../../catalog/panel-pieza-catalog';
import { collapseVisionItemsToBpcIfNeeded } from '../../chat/vision-bpc-inventory';
import {
  peritajeFromLegacyAnalysis,
  parseStructuredTreatment,
} from '../../domain/peritaje-v1';
import { canonicalPhysicalPanelKey } from '../../chat/piece-treatment';
import { buildCanonicalQuoteV1 } from '../../chat/canonical-quote-engine';
import { composeModernClientQuoteMessage } from '../../chat/canonical-quote-narrative';
import { runWithLlmAuditContextAsync } from '../../chat/llm-audit-context';
import { hashPromptText } from '../../chat/catalog-prompt-append';
import { lookupBanioCatalogBase } from '../../catalog/banio-service-identity';
import type { BanioProductCode } from '../../catalog/banio-service-identity';
import { autonomyMockSnap } from './pricing-snap';
import type { MatrixPricingSnapshot } from '../../catalog/matrix-pricing-snapshot';
import { createAutonomySideEffectMocks } from './side-effects';
import { validateVisionContract } from './vision-contract';
import {
  classifyTreatmentSafety,
  treatmentSafetyRates,
} from './treatment-safety';
import { compareAutonomyCase } from './compare';
import { runDeterministicAutonomyCase } from './pipeline';
import type { AutonomyCertificationCase, CaseCompareResult } from './types';
import type { DetectedDamageItem } from '../../chat/entities/chat.entity';
import { resolveOpenAiModel } from '../../chat/openai-model-config';

export const LIVE_EVAL_USES_PRODUCTION_PARSER = true;
export const LIVE_EVAL_PRODUCTION_PARSER = parseVisionModelJsonResponse;
export const LIVE_EVAL_PRODUCTION_ENGINE = buildCanonicalQuoteV1;

export type LiveCaseMeta = {
  caseId: string;
  description?: string;
  images: string[];
  banioCode?: BanioProductCode;
  expected?: AutonomyCertificationCase['expected'];
  vehicleContext?: string;
};

export type LiveCaseResult = {
  caseId: string;
  model: string;
  visionPromptVersion: string;
  contractViolations: string[];
  productDecision?: string;
  treatments: string[];
  total: number;
  isPartial: boolean;
  warnings: string[];
  safety: ReturnType<typeof classifyTreatmentSafety>[];
  compare?: CaseCompareResult;
  rawJsonPath?: string;
};

export type LiveEvalReport = {
  level: 'LIVE_VISION';
  model: string;
  visionPromptVersion: string;
  casesTotal: number;
  casesPassed: number;
  casesFailed: number;
  configurationRequired: number;
  contractFailures: number;
  exactTreatmentRate: number;
  safeTreatmentRate: number;
  unsafeTreatmentRate: number;
  results: LiveCaseResult[];
};

export type VisionCompletionFn = typeof createVisionDamageAnalysisCompletion;

function liveRoot(): string {
  return join(process.cwd(), 'test/fixtures/autonomy/live');
}

export function loadLiveCases(dir = liveRoot()): LiveCaseMeta[] {
  if (!existsSync(dir)) return [];
  const cases: LiveCaseMeta[] = [];
  const index = join(dir, 'cases.json');
  if (existsSync(index)) {
    const parsed = JSON.parse(readFileSync(index, 'utf8')) as {
      cases?: LiveCaseMeta[];
    };
    for (const c of parsed.cases ?? []) {
      cases.push({
        ...c,
        images: (c.images ?? []).map((p) =>
          p.startsWith('/') ? p : join(dir, p),
        ),
      });
    }
    return cases;
  }

  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const folder = join(dir, name.name);
    const metaPath = join(folder, 'case.json');
    const photos = readdirSync(folder).filter((f) =>
      /\.(jpe?g|png|webp)$/i.test(f),
    );
    if (!photos.length) continue;
    const meta = existsSync(metaPath)
      ? (JSON.parse(readFileSync(metaPath, 'utf8')) as Partial<LiveCaseMeta>)
      : {};
    cases.push({
      caseId: String(meta.caseId ?? name.name),
      description: meta.description,
      images: photos.map((f) => join(folder, f)),
      banioCode: meta.banioCode,
      expected: meta.expected,
      vehicleContext: meta.vehicleContext,
    });
  }
  return cases;
}

function fileToDataUrl(path: string): string {
  const buf = readFileSync(path);
  const ext = path.toLowerCase().endsWith('.png')
    ? 'png'
    : path.toLowerCase().endsWith('.webp')
      ? 'webp'
      : 'jpeg';
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}

export async function runLiveVisionCase(input: {
  meta: LiveCaseMeta;
  openai: OpenAI;
  systemPrompt: string;
  userSchemaHint: string;
  visionCompletion?: VisionCompletionFn;
  sideEffects: ReturnType<typeof createAutonomySideEffectMocks>;
  pricingSnap?: MatrixPricingSnapshot;
}): Promise<LiveCaseResult> {
  if (input.sideEffects.calls.length) {
    throw new Error(
      `Autonomy harness blocked: side effects already invoked (${input.sideEffects.calls.join(',')})`,
    );
  }

  if (input.meta.banioCode && input.meta.banioCode !== 'BPE') {
    const snap = input.pricingSnap ?? autonomyMockSnap();
    const lookup = lookupBanioCatalogBase(snap, input.meta.banioCode);
    if (lookup.status === 'UNCONFIGURED') {
      return {
        caseId: input.meta.caseId,
        model: resolveOpenAiModel('vision'),
        visionPromptVersion: hashPromptText(
          `${input.systemPrompt}\n${input.userSchemaHint}`,
        ),
        contractViolations: [],
        productDecision: 'PRODUCT_CONFIGURATION_REQUIRED',
        treatments: [],
        total: 0,
        isPartial: true,
        warnings: [],
        safety: [],
      };
    }
  }

  const urls = input.meta.images.map(fileToDataUrl);
  const visionPromptVersion = hashPromptText(
    `${input.systemPrompt}\n${input.userSchemaHint}`,
  );
  const complete = input.visionCompletion ?? createVisionDamageAnalysisCompletion;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: input.systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: input.userSchemaHint },
        ...urls.map((url) => ({
          type: 'image_url' as const,
          image_url: { url, detail: 'high' as const },
        })),
      ],
    },
  ];

  const meta = await runWithLlmAuditContextAsync(
    {
      purpose: 'vision_peritaje',
      caseId: input.meta.caseId,
      visionPromptVersion,
      promptLabel: 'vision-live-eval',
    },
    () => complete(input.openai, messages),
  );

  const artifactsDir = join(process.cwd(), 'test/fixtures/autonomy/live-artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  const rawJsonPath = join(artifactsDir, `${input.meta.caseId}.vision.json`);
  writeFileSync(rawJsonPath, meta.content || '', 'utf8');

  let parsed: unknown;
  let parseError = false;
  try {
    parsed = parseVisionModelJsonResponse(meta.content, 'live-eval');
  } catch {
    parseError = true;
    parsed = {};
  }

  const viability = extractVisionViability(parsed);
  const vehicle = extractVisionDetectedVehicle(parsed);
  const rawItems = parseVisionDamageItems(parsed);
  const items: DetectedDamageItem[] = rawItems.map((it) => ({
    ...it,
    pieza: canonicalizePanelCode(it.pieza) || it.pieza,
    ...(vehicle && !it.vehiculoDetectado ? { vehiculoDetectado: vehicle } : {}),
  }));
  const collapsed =
    viability.peritajeViable && items.length
      ? collapseVisionItemsToBpcIfNeeded(items, input.meta.vehicleContext ?? '', parsed)
      : [];

  const contractViolations = validateVisionContract({
    parseError,
    items: collapsed,
    inputUrls: urls,
  });

  const peritaje = peritajeFromLegacyAnalysis({
    analysis: {
      inventory: collapsed,
      vehiculoDetectado: vehicle || input.meta.vehicleContext,
    },
    conversationId: `live-${input.meta.caseId}`,
    canonicalizePanel: (raw) => canonicalPhysicalPanelKey(raw) || raw,
    viability: {
      peritajeViable: viability.peritajeViable,
      motivoInviable: viability.motivoInviable,
      mensajeClienteAclaracion: viability.mensajeClienteAclaracion,
    },
  });

  const built = buildCanonicalQuoteV1({
    peritaje,
    pricedInventory: collapsed,
    snap: input.pricingSnap ?? autonomyMockSnap(),
    quoteId: `quo_live_${input.meta.caseId}`,
  });
  const quote = built.ok ? built.quote : null;
  if (quote) {
    await composeModernClientQuoteMessage({
      canonicalQuote: quote,
      contactName: 'Eval',
      hasActiveAppointment: true,
    });
  }

  const treatments = peritaje.damages
    .map((d) => d.treatment)
    .filter(Boolean);
  const expectedTreatments = input.meta.expected?.treatments ?? [];
  const safety = expectedTreatments.map((exp, i) =>
    classifyTreatmentSafety(exp, treatments[i] as typeof exp),
  );

  let compare: CaseCompareResult | undefined;
  if (input.meta.expected && !parseError) {
    const certCase: AutonomyCertificationCase = {
      caseId: input.meta.caseId,
      description: input.meta.description ?? 'live',
      category: 'LIVE',
      kind: 'vision',
      input: {
        visionItems: collapsed,
        vehicleContext: vehicle || input.meta.vehicleContext,
      },
      expected: input.meta.expected,
    };
    const actual = await runDeterministicAutonomyCase(certCase);
    compare = compareAutonomyCase(certCase, actual);
  }

  return {
    caseId: input.meta.caseId,
    model: meta.model || resolveOpenAiModel('vision'),
    visionPromptVersion,
    contractViolations,
    treatments,
    total: quote?.total ?? 0,
    isPartial: quote?.isPartial === true,
    warnings: quote?.warnings ?? [],
    safety,
    compare,
    rawJsonPath,
  };
}

export function formatLiveEvalReport(report: LiveEvalReport): string {
  return [
    'LIVE VISION',
    `${report.casesPassed} / ${report.casesTotal}`,
    `model: ${report.model}`,
    `visionPromptVersion: ${report.visionPromptVersion}`,
    `configuration required: ${report.configurationRequired}`,
    `contract failures: ${report.contractFailures}`,
    `exact treatment: ${report.exactTreatmentRate}%`,
    `safe treatment: ${report.safeTreatmentRate}%`,
    `unsafe treatment: ${report.unsafeTreatmentRate}%`,
  ].join('\n');
}

export async function runLiveAutonomyEvaluation(opts?: {
  openai?: OpenAI;
  visionCompletion?: VisionCompletionFn;
  systemPrompt?: string;
  userSchemaHint?: string;
  cases?: LiveCaseMeta[];
  pricingSnap?: MatrixPricingSnapshot;
}): Promise<LiveEvalReport> {
  const side = createAutonomySideEffectMocks();
  const cases = opts?.cases ?? loadLiveCases();
  const systemPrompt = opts?.systemPrompt ?? 'Eres perito. Responde JSON.';
  const userSchemaHint =
    opts?.userSchemaHint ?? 'Responde únicamente JSON con items[].';
  const visionPromptVersion = hashPromptText(`${systemPrompt}\n${userSchemaHint}`);
  const openai = opts?.openai ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const results: LiveCaseResult[] = [];
  for (const meta of cases) {
    results.push(
      await runLiveVisionCase({
        meta,
        openai,
        systemPrompt,
        userSchemaHint,
        visionCompletion: opts?.visionCompletion,
        sideEffects: side,
        pricingSnap: opts?.pricingSnap,
      }),
    );
    if (side.calls.length) {
      throw new Error(
        `Autonomy harness blocked side effect: ${side.calls.join(',')}`,
      );
    }
  }

  const safetyRows = results.flatMap((r, idx) => {
    const expected = cases[idx]?.expected?.treatments ?? [];
    return expected.map((exp, i) => ({
      expected: exp,
      predicted: parseStructuredTreatment(r.treatments[i]),
    }));
  });
  const rates = treatmentSafetyRates(safetyRows);
  const scored = results.filter((r) => !r.productDecision);
  const passed = scored.filter(
    (r) =>
      !r.contractViolations.length &&
      (r.compare ? r.compare.passed : true),
  ).length;

  return {
    level: 'LIVE_VISION',
    model: results[0]?.model || resolveOpenAiModel('vision'),
    visionPromptVersion,
    casesTotal: results.length,
    casesPassed: passed,
    casesFailed: scored.length - passed,
    configurationRequired: results.filter((r) => r.productDecision).length,
    contractFailures: results.filter((r) => r.contractViolations.length).length,
    exactTreatmentRate: rates.exactRate,
    safeTreatmentRate: rates.safeTreatmentRate,
    unsafeTreatmentRate: rates.unsafeTreatmentRate,
    results,
  };
}

async function main(): Promise<void> {
  const key = String(process.env.OPENAI_API_KEY ?? '').trim();
  const cases = loadLiveCases();
  if (!key) {
    console.log('eval:autonomy:live SKIP — no OPENAI_API_KEY. Level 2 is optional.');
    process.exit(0);
  }
  if (!cases.length) {
    console.log(
      'eval:autonomy:live SKIP — no hay casos en test/fixtures/autonomy/live.',
    );
    process.exit(0);
  }

  const report = await runLiveAutonomyEvaluation({ cases });
  const text = [
    'LEVEL 2 is separate from LEVEL 1 deterministic.',
    formatLiveEvalReport(report),
    '',
    'No side effects were executed (WhatsApp/Twilio/appointments/production DB blocked).',
  ].join('\n');
  console.log(text);
  writeFileSync(
    join(process.cwd(), 'test/fixtures/autonomy/live-report.txt'),
    text,
    'utf8',
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
