-- The Karmax app's own PostgreSQL login. It owns the database it runs in and
-- nothing else, so a compromised app cannot read Temporal's histories, create
-- roles or run programs as the server (COPY ... PROGRAM), as it could while it
-- connected as the bootstrap superuser. The superuser applies this on every
-- start (karmax-role.sh), which also hands over whatever an older release or
-- a restored dump created as the superuser. Settings carry the parameters:
-- karmax.app_role, karmax.app_password, and karmax.private_databases (comma-
-- separated databases that PUBLIC, and so this role, may not connect to).
DO $$
DECLARE
  app text := current_setting('karmax.app_role');
  item record;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('CREATE ROLE %I', app);
  END IF;
  EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
    app, current_setting('karmax.app_password'));
  EXECUTE format('ALTER DATABASE %I OWNER TO %I', current_database(), app);
  FOR item IN SELECT nspname FROM pg_namespace
      WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema' AND nspowner <> app::regrole LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', item.nspname, app);
  END LOOP;
  -- A table takes its indexes and its serial sequences along, and those
  -- sequences refuse a separate owner change.
  FOR item IN SELECT c.oid::regclass AS name, c.relkind FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S') AND c.relowner <> app::regrole
        AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
        AND NOT (c.relkind = 'S' AND EXISTS (SELECT FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i'))) LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I',
      CASE item.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
      item.name, app);
  END LOOP;
  FOR item IN SELECT datname FROM pg_database
      WHERE datname = ANY (string_to_array(current_setting('karmax.private_databases', true), ',')) LOOP
    EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', item.datname);
  END LOOP;
END $$;
