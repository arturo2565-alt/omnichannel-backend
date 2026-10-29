import { assertSmokeTarget } from './smoke-target';

describe('assertSmokeTarget', () => {
  const staging = 'https://api.staging.example.test/api/health';

  it('acepta el host fijado', () => {
    expect(() =>
      assertSmokeTarget(staging, { STAGING_PUBLIC_HOST: 'api.staging.example.test' }),
    ).not.toThrow();
  });

  it('rechaza producción y no revela el host', () => {
    expect(() =>
      assertSmokeTarget('https://api.production.example.test/api/health', {
        STAGING_PUBLIC_HOST: 'api.production.example.test',
      }),
    ).toThrow(/producción/);
    try {
      assertSmokeTarget('https://otro.example.test/api/health', {
        STAGING_PUBLIC_HOST: 'api.staging.example.test',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/no coincide/);
      expect(message).not.toContain('otro.example.test');
      expect(message).not.toContain('api.staging.example.test');
    }
  });
});
