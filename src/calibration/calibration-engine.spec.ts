import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CalibrationValidationError } from './calibration-case';
import { confirmArchiveChecksum, CalibrationEngine } from './calibration-engine';
import {
  CalibrationConflictError,
  CalibrationGithubWriter,
} from './calibration-github-writer';
import { validateCalibrationImage } from './calibration-image-archive.service';

function response(status: number, value: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => value } as Response;
}

function memoryGithub(options?: { failIndexWrites?: number; failAll?: boolean }) {
  const files = new Map<string, { sha: string; text: string }>();
  let seq = 0;
  let indexFailures = options?.failIndexWrites ?? 0;
  files.set(
    'data/index.json',
    {
      sha: 'index-0',
      text: JSON.stringify({
        schema_version: '1.0.0',
        cases: { 'AF-000001': 'data/cases/AF-000001.json' },
        source_keys: { 'seed-case-000001': 'AF-000001' },
      }),
    },
  );
  const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (options?.failAll) throw new Error('github unavailable');
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, '');
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      const file = files.get(path);
      if (!file) return response(404, { message: 'Not Found' });
      return response(200, {
        sha: file.sha,
        content: Buffer.from(file.text).toString('base64'),
      });
    }
    const body = JSON.parse(String(init?.body)) as { content: string; sha?: string };
    const text = Buffer.from(body.content, 'base64').toString('utf8');
    const current = files.get(path);
    if (!body.sha && current) return response(422, { message: 'sha required' });
    if (body.sha && (!current || current.sha !== body.sha)) return response(409, { message: 'Conflict' });
    if (path === 'data/index.json' && indexFailures > 0) {
      indexFailures -= 1;
      return response(409, { message: 'Conflict' });
    }
    seq += 1;
    files.set(path, { sha: `sha-${seq}`, text });
    return response(201, { commit: { sha: `sha-${seq}` } });
  };
  return { transport: transport as typeof fetch, files };
}

function quote(key = 'case-test-000010', price = 1250) {
  return {
    source: { kind: 'autofix_human_quote', source_case_key: key, quoted_at: null },
    vehicle: {
      make: 'Mazda',
      make_evidence: 'visual_inference',
      model: null,
      model_evidence: 'unknown',
      year: null,
      year_evidence: 'unknown',
      variant: null,
    },
    line_items: [
      {
        line_id: 'L1',
        part: 'salpicadera delantera derecha',
        treatment: 'repair_paint',
        price_mxn: price,
        damage_severity: 'unknown',
        validation: 'human_confirmed',
      },
    ],
    visual_observations: ['Deformación visible en el arco de la salpicadera.'],
    status: 'human_verified',
  };
}

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x11, 0x22]);

function verifiedStore() {
  const calls: Buffer[] = [];
  return {
    calls,
    store: async ({ bytes }: { caseId: string; bytes: Buffer }) => {
      calls.push(bytes);
      const sha256 = validateCalibrationImage(bytes).sha256;
      return { sha256, verified: confirmArchiveChecksum(sha256, sha256) };
    },
  };
}

function engineFor(github = memoryGithub(), photos?: ReturnType<typeof verifiedStore>) {
  return {
    github,
    photos,
    engine: new CalibrationEngine(
      new CalibrationGithubWriter('test-token', github.transport),
      photos ?? null,
    ),
  };
}

function storedCase(github: ReturnType<typeof memoryGithub>, caseId: string) {
  const file = github.files.get(`data/cases/${caseId}.json`);
  if (!file) throw new Error(`missing ${caseId}`);
  return JSON.parse(file.text) as Record<string, unknown>;
}

describe('CAL-006 calibration engine', () => {
  it('records a valid human quote without inventing unknown identity', async () => {
    const { engine, github } = engineFor();
    const result = await engine.record(quote());
    expect(result.status).toBe('created');
    expect(result.caseId).toBe('AF-000002');
    expect(result.photoArchiveStatus).toBe('not_provided');
    const saved = storedCase(github, 'AF-000002');
    expect(saved.vehicle).toMatchObject({
      make: 'Mazda',
      make_evidence: 'visual_inference',
      model: null,
      model_evidence: 'unknown',
      year: null,
      year_evidence: 'unknown',
    });
    expect(saved).not.toHaveProperty('customerName');
  });

  it('rejects an incomplete quote before writing', async () => {
    const { engine, github } = engineFor();
    await expect(engine.record({ status: 'human_verified' })).rejects.toMatchObject({
      code: 'incomplete',
    } satisfies Partial<CalibrationValidationError>);
    expect(github.files.has('data/cases/AF-000002.json')).toBe(false);
  });

  it('rejects a missing, zero, or unconfirmed price', async () => {
    const { engine } = engineFor();
    const missing = quote();
    missing.line_items[0]!.price_mxn = null as unknown as number;
    await expect(engine.record(missing)).rejects.toMatchObject({ code: 'unauthorized_price' });
    const zero = quote();
    zero.line_items[0]!.price_mxn = 0;
    await expect(engine.record(zero)).rejects.toMatchObject({ code: 'unauthorized_price' });
    const pending = quote();
    pending.line_items[0]!.validation = 'pending_review' as 'human_confirmed';
    await expect(engine.record(pending)).rejects.toMatchObject({ code: 'unauthorized_price' });
  });

  it('keeps a visual identification with unknown model and year', async () => {
    const { engine, github } = engineFor();
    await engine.record(quote('case-test-visual-01'));
    const saved = storedCase(github, 'AF-000002');
    expect(saved.vehicle).toMatchObject({
      make_evidence: 'visual_inference',
      model: null,
      year: null,
    });
  });

  it('does not create a second case for the same source key', async () => {
    const { engine, github } = engineFor();
    const first = await engine.record(quote('case-test-dup-01'));
    const second = await engine.record(quote('case-test-dup-01'));
    expect(first.caseId).toBe('AF-000002');
    expect(second).toMatchObject({ status: 'already_exists', caseId: 'AF-000002' });
    expect([...github.files.keys()].filter((path) => path.startsWith('data/cases/'))).toEqual([
      'data/cases/AF-000002.json',
    ]);
    await expect(engine.record(quote('case-test-dup-01', 9999))).rejects.toBeInstanceOf(
      CalibrationConflictError,
    );
  });

  it('allocates distinct ids for two concurrent quotes', async () => {
    const { engine } = engineFor();
    const [left, right] = await Promise.all([
      engine.record(quote('case-test-concurrent-a')),
      engine.record(quote('case-test-concurrent-b', 800)),
    ]);
    expect(new Set([left.caseId, right.caseId])).toEqual(new Set(['AF-000002', 'AF-000003']));
    expect(left.status).toBe('created');
    expect(right.status).toBe('created');
  });

  it('does not persist when GitHub fails', async () => {
    const photos = verifiedStore();
    const { engine } = engineFor(memoryGithub({ failAll: true }), photos);
    await expect(engine.record(quote(), [jpeg])).rejects.toThrow('github unavailable');
    expect(photos.calls).toHaveLength(0);
  });

  it('keeps the quote pending when Cloudinary fails', async () => {
    const github = memoryGithub();
    const engine = new CalibrationEngine(
      new CalibrationGithubWriter('test-token', github.transport),
      { store: async () => { throw new Error('cloudinary unavailable'); } },
    );
    const result = await engine.record(quote('case-test-photo-fail'), [jpeg]);
    expect(result.photoArchiveStatus).toBe('pending_private_archive');
    expect(result.photoRefs).toEqual([]);
    expect(storedCase(github, result.caseId).photo_archive_status).toBe('pending_private_archive');
  });

  it('does not archive a photo whose checksum was not confirmed', async () => {
    const github = memoryGithub();
    const engine = new CalibrationEngine(
      new CalibrationGithubWriter('test-token', github.transport),
      {
        store: async ({ bytes }) => ({
          sha256: validateCalibrationImage(bytes).sha256,
          verified: confirmArchiveChecksum(validateCalibrationImage(bytes).sha256, null),
        }),
      },
    );
    const result = await engine.record(quote('case-test-unverified'), [jpeg]);
    expect(result.photoArchiveStatus).toBe('pending_private_archive');
    expect([...github.files.keys()].some((path) => path.includes('/photos/'))).toBe(false);
  });

  it('stores one manifest for a duplicated photograph', async () => {
    const photos = verifiedStore();
    const { engine, github } = engineFor(memoryGithub(), photos);
    const result = await engine.record(quote('case-test-same-photo'), [jpeg, Buffer.from(jpeg)]);
    expect(photos.calls).toHaveLength(1);
    expect(result.photoArchiveStatus).toBe('archived_private');
    expect(result.photoRefs).toEqual(['IMG-000001']);
    const manifest = github.files.get(`data/photos/${result.caseId}/IMG-000001.json`);
    expect(JSON.parse(manifest!.text).content_sha256).toBe(validateCalibrationImage(jpeg).sha256);
    expect(JSON.parse(manifest!.text).storage_status).toBe('verified');
  });

  it('recovers a case whose index write was partial', async () => {
    const { engine, github } = engineFor(memoryGithub({ failIndexWrites: 1 }));
    const result = await engine.record(quote('case-test-partial'));
    expect(result.status).toBe('reconciled');
    expect(result.caseId).toBe('AF-000002');
    const index = JSON.parse(github.files.get('data/index.json')!.text) as {
      source_keys: Record<string, string>;
    };
    expect(index.source_keys['case-test-partial']).toBe('AF-000002');
  });

  it('matches the pinned private case and photo contracts', () => {
    const caseSchema = JSON.parse(
      readFileSync(join(process.cwd(), 'calibration/schema.json'), 'utf8'),
    ) as { properties: Record<string, { properties?: Record<string, unknown>; enum?: string[] }> };
    const photoSchema = JSON.parse(
      readFileSync(join(process.cwd(), 'calibration/photo-v1.schema.json'), 'utf8'),
    ) as { required: string[]; properties: Record<string, { pattern?: string; enum?: string[] }> };
    expect(caseSchema.properties.vehicle?.properties).toHaveProperty('make_evidence');
    expect(caseSchema.properties.vehicle?.properties).toHaveProperty('model_evidence');
    expect(caseSchema.properties.vehicle?.properties).toHaveProperty('year_evidence');
    expect(caseSchema.properties.visual_observations).toBeDefined();
    expect(caseSchema.properties.photo_archive_status?.enum).toContain('archived_private');
    expect(photoSchema.required).toEqual(
      expect.arrayContaining(['content_sha256', 'storage_status', 'photo_id', 'case_id']),
    );
    expect(photoSchema.properties.content_sha256?.pattern).toBe('^[a-f0-9]{64}$');
    expect(photoSchema.properties.storage_status?.enum).toContain('verified');
  });
});
