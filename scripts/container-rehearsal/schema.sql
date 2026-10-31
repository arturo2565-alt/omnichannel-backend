CREATE TABLE talleres (
  id uuid PRIMARY KEY,
  nombre text NOT NULL,
  "metaPageId" text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE price_matrix (
  id uuid PRIMARY KEY,
  "tallerId" uuid NOT NULL,
  pieza text NOT NULL,
  severidad text NOT NULL,
  precio integer NOT NULL,
  dias_entrega integer NOT NULL,
  is_instant_service boolean NOT NULL
);
CREATE TABLE appointments (id uuid PRIMARY KEY);
CREATE TABLE appointment_service_lines (
  id uuid PRIMARY KEY,
  "catalogPieceCode" character varying(32)
);
