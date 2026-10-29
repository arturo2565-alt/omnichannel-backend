-- Datos sintéticos de staging. No hay clientes, teléfonos ni mensajes.
-- Reaplicable: no inserta la fila si ya existe.

INSERT INTO talleres (id, nombre, "metaPageId", "createdAt")
SELECT
  '01000000-0000-4000-8000-000000000010',
  'Taller de ensayo',
  NULL,
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM talleres WHERE id = '01000000-0000-4000-8000-000000000010'
);

INSERT INTO price_matrix (id, "tallerId", pieza, severidad, precio, dias_entrega, is_instant_service)
SELECT
  '01000000-0000-4000-8000-000000000011',
  '01000000-0000-4000-8000-000000000010',
  'Salpicadera',
  'LEVE',
  4500,
  3,
  false
WHERE NOT EXISTS (
  SELECT 1 FROM price_matrix
  WHERE "tallerId" = '01000000-0000-4000-8000-000000000010'
    AND pieza = 'Salpicadera'
    AND severidad = 'LEVE'
);

INSERT INTO price_matrix (id, "tallerId", pieza, severidad, precio, dias_entrega, is_instant_service)
SELECT
  '01000000-0000-4000-8000-000000000012',
  '01000000-0000-4000-8000-000000000010',
  'Fascia delantera',
  'MONTAJE',
  1800,
  1,
  false
WHERE NOT EXISTS (
  SELECT 1 FROM price_matrix
  WHERE "tallerId" = '01000000-0000-4000-8000-000000000010'
    AND pieza = 'Fascia delantera'
    AND severidad = 'MONTAJE'
);

INSERT INTO price_matrix (id, "tallerId", pieza, severidad, precio, dias_entrega, is_instant_service)
SELECT
  '01000000-0000-4000-8000-000000000013',
  '01000000-0000-4000-8000-000000000010',
  'Fascia delantera',
  'MONTAJE_PINTURA',
  3200,
  2,
  false
WHERE NOT EXISTS (
  SELECT 1 FROM price_matrix
  WHERE "tallerId" = '01000000-0000-4000-8000-000000000010'
    AND pieza = 'Fascia delantera'
    AND severidad = 'MONTAJE_PINTURA'
);
