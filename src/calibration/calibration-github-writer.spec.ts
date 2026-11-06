import { CalibrationGithubWriter, CalibrationConflictError } from './calibration-github-writer';

function response(status: number, value: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => value } as Response;
}
describe('CAL-005 server-side GitHub writer', () => {
  const input = { case_id: 'AF-000003', source: { kind: 'autofix_human_quote', source_case_key: 'case-test-000003' } };
  it('treats a repeated source key as no-op', async () => {
    const index = { schema_version: '1.0.0', cases: { 'AF-000003': 'data/cases/AF-000003.json' }, source_keys: { 'case-test-000003': 'AF-000003' } };
    const transport = jest.fn().mockResolvedValue(response(200, { sha: 'index-sha', content: Buffer.from(JSON.stringify(index)).toString('base64') }));
    const writer = new CalibrationGithubWriter('test-token', transport as unknown as typeof fetch);
    expect(await writer.insert(input)).toEqual({ status: 'already_exists', caseId: 'AF-000003' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1].method).toBe('GET');
  });
  it('rejects identifier reuse with a different source key', async () => {
    const index = { schema_version: '1.0.0', cases: { 'AF-000003': 'data/cases/AF-000003.json' }, source_keys: {} };
    const transport = jest.fn().mockResolvedValue(response(200, { sha: 'index-sha', content: Buffer.from(JSON.stringify(index)).toString('base64') }));
    const writer = new CalibrationGithubWriter('test-token', transport as unknown as typeof fetch);
    await expect(writer.insert(input)).rejects.toThrow(CalibrationConflictError);
  });
  it('inserts a case and updates the index with its latest SHA', async () => {
    const index = { schema_version: '1.0.0', cases: {}, source_keys: {} };
    const transport = jest.fn()
      .mockResolvedValueOnce(response(200, { sha: 'index-sha', content: Buffer.from(JSON.stringify(index)).toString('base64') }))
      .mockResolvedValueOnce(response(404, { message: 'Not Found' }))
      .mockResolvedValueOnce(response(201, { commit: { sha: 'case-commit' } }))
      .mockResolvedValueOnce(response(200, { commit: { sha: 'index-commit' } }));
    const writer = new CalibrationGithubWriter('test-token', transport as unknown as typeof fetch);
    expect(await writer.insert(input)).toEqual({
      status: 'created', caseId: 'AF-000003', caseCommit: 'case-commit', indexCommit: 'index-commit',
    });
    const caseWrite = JSON.parse(transport.mock.calls[2][1].body as string);
    const indexWrite = JSON.parse(transport.mock.calls[3][1].body as string);
    expect(caseWrite.sha).toBeUndefined();
    expect(indexWrite.sha).toBe('index-sha');
    expect(JSON.parse(Buffer.from(indexWrite.content, 'base64').toString()).source_keys['case-test-000003'])
      .toBe('AF-000003');
  });

  it('returns partial when the case is written but index update fails', async () => {
    const index = { schema_version: '1.0.0', cases: {}, source_keys: {} };
    const transport = jest.fn()
      .mockResolvedValueOnce(response(200, { sha: 'index-sha', content: Buffer.from(JSON.stringify(index)).toString('base64') }))
      .mockResolvedValueOnce(response(404, { message: 'Not Found' }))
      .mockResolvedValueOnce(response(201, { commit: { sha: 'case-commit' } }))
      .mockResolvedValueOnce(response(409, { message: 'Conflict' }));
    const writer = new CalibrationGithubWriter('test-token', transport as unknown as typeof fetch);
    expect(await writer.insert(input)).toEqual({
      status: 'partial', caseId: 'AF-000003', caseCommit: 'case-commit',
      reason: 'Index update requires reconciliation',
    });
  });

  it('reconciles an orphan case without rewriting the case file', async () => {
    const index = { schema_version: '1.0.0', cases: {}, source_keys: {} };
    const transport = jest.fn()
      .mockResolvedValueOnce(response(200, { sha: 'index-sha', content: Buffer.from(JSON.stringify(index)).toString('base64') }))
      .mockResolvedValueOnce(response(200, { sha: 'case-sha', content: Buffer.from(JSON.stringify(input)).toString('base64') }))
      .mockResolvedValueOnce(response(200, { commit: { sha: 'index-commit' } }));
    const writer = new CalibrationGithubWriter('test-token', transport as unknown as typeof fetch);
    expect(await writer.insert(input)).toEqual({
      status: 'created', caseId: 'AF-000003', caseCommit: 'pre-existing', indexCommit: 'index-commit',
    });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(String(transport.mock.calls[2][0])).toContain('data/index.json');
  });

});
