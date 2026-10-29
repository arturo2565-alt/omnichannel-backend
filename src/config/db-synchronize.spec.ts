import { resolveDbSynchronize } from './db-synchronize';

describe('resolveDbSynchronize', () => {
  const remote = 'postgresql://user:secret@db.example.railway.app:5432/railway';

  it('solo sincroniza una base remota si se pide en true', () => {
    expect(resolveDbSynchronize(undefined, remote)).toBe(false);
    expect(resolveDbSynchronize('', remote)).toBe(false);
    expect(resolveDbSynchronize('FALSE', remote)).toBe(false);
    expect(resolveDbSynchronize('false', remote)).toBe(false);
    expect(resolveDbSynchronize('true', remote)).toBe(true);
  });

  it('mantiene el sincronizado local cuando no hay bandera', () => {
    expect(resolveDbSynchronize(undefined, undefined)).toBe(true);
    expect(
      resolveDbSynchronize(undefined, 'postgres://u:p@127.0.0.1:5432/pegazuz'),
    ).toBe(true);
    expect(
      resolveDbSynchronize('false', 'postgres://u:p@localhost:5432/pegazuz'),
    ).toBe(false);
  });

  it('no sincroniza una URL que no se puede interpretar', () => {
    expect(resolveDbSynchronize(undefined, 'not a url')).toBe(false);
  });
});
