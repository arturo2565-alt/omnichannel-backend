SELECT 'taller|' || id::text || '|' || nombre
FROM talleres
WHERE id = '01000000-0000-4000-8000-000000000010'
UNION ALL
SELECT 'price|' || id::text
FROM price_matrix
WHERE id IN (
  '01000000-0000-4000-8000-000000000011',
  '01000000-0000-4000-8000-000000000012',
  '01000000-0000-4000-8000-000000000013'
)
UNION ALL
SELECT 'table|' || table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'talleres',
    'price_matrix',
    'appointments',
    'appointment_service_lines'
  )
UNION ALL
SELECT 'column|' || column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'appointment_service_lines'
  AND column_name = 'catalogPieceCode';
