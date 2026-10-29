import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAGING_TALLER_ID } from './staging-synthetic';

describe('staging-synthetic.sql', () => {
  const sql = readFileSync(
    join(process.cwd(), 'scripts/staging-synthetic.sql'),
    'utf8',
  );

  it('solo inserta el taller de ensayo y no toca datos previos', () => {
    expect(sql).toContain(STAGING_TALLER_ID);
    expect(sql).toContain('Taller de ensayo');
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i);
    expect(sql).not.toMatch(/appointments|messages|conversations|contacts|users/i);
    expect(sql).not.toMatch(/\+\d{8,}|whatsapp|telefono/i);
  });
});
