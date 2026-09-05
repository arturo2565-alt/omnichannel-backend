import {
  buildBullMqRedisConnection,
  getRedisUrl,
  parseRedisUrl,
  validateEnv,
} from './env';

describe('env / REDIS_URL', () => {
  it('exige REDIS_URL', () => {
    expect(() => getRedisUrl({})).toThrow(/REDIS_URL es requerida/);
  });

  it('parsea redis local y rediss', () => {
    expect(parseRedisUrl('redis://127.0.0.1:6379').hostname).toBe('127.0.0.1');
    const conn = buildBullMqRedisConnection(
      'rediss://default:s3cret@redis.example.com:6380/2',
    );
    expect(conn).toMatchObject({
      host: 'redis.example.com',
      port: 6380,
      username: 'default',
      password: 's3cret',
      db: 2,
      maxRetriesPerRequest: null,
    });
    expect(conn.tls).toEqual({});
  });

  it('validateEnv rechaza URL inválida', () => {
    expect(() => validateEnv({ REDIS_URL: 'not-a-url' })).toThrow(
      /no es una URL válida/,
    );
  });
});
