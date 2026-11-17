CREATE TABLE IF NOT EXISTS ejemplo (
  id serial PRIMARY KEY,
  nombre text NOT NULL,
  creado timestamptz NOT NULL DEFAULT now()
);
