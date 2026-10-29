import { isStagingRuntime, STAGING_OUTBOUND_BLOCKED } from './staging-guard';

describe('isStagingRuntime', () => {
  it('solo reconoce PEGAZUZ_ENV=staging', () => {
    expect(isStagingRuntime({})).toBe(false);
    expect(isStagingRuntime({ PEGAZUZ_ENV: 'production' })).toBe(false);
    expect(isStagingRuntime({ NODE_ENV: 'staging' })).toBe(false);
    expect(isStagingRuntime({ PEGAZUZ_ENV: 'staging' })).toBe(true);
  });

  it('el aviso de bloqueo no incluye tokens', () => {
    expect(STAGING_OUTBOUND_BLOCKED).not.toMatch(/token|secret|postgres/i);
  });
});
