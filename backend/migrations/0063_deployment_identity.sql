-- `deployment_identity` — the one-row target enrollment of
-- docs/technical/smoke-production-spec.md §4.2 (issue #1026).
--
-- It marks what THIS database is enrolled for, independently of whatever the
-- operator typed into RM_ENV. Every other signal ("which database is this?")
-- travels with the operator and can be wrong in the same way at the same time;
-- a row inside the target is the only signal that travels with the target.
--
-- ONE ROW, ENFORCED BY THE KEY. `id boolean PRIMARY KEY CHECK (id)` admits
-- exactly one value, so a second row is a constraint violation rather than an
-- arbitrary answer for the next reader. Writers use
-- `INSERT ... ON CONFLICT (id) DO UPDATE`, a single statement that can only
-- leave the table with exactly one row.
--
-- WRITABLE ONLY BY rm_owner (§4.2). That restriction is this table's whole
-- value: a compromised or merely buggy application process must not be able to
-- re-label the database it runs against in order to unlock `--seed`. The
-- runtime roles get SELECT only — preflight check 5 (§7) reads the row under
-- the credential a container will actually use, so it must be readable by all
-- of them. Enforcement is the grant, never a TypeScript check on top of it.
--
-- NO ROW IS WRITTEN HERE. A database that has never been enrolled must read as
-- absent, which the §4.3 matrix refuses; seeding a default here would enroll
-- every database the migration touches, which is the exact inverse of the
-- safeguard. `rehearsal` is written by `--local blank`/`--local dump` and the
-- remote-twin restore procedure (§5); `production` once, by production
-- initialization (§9.1).
CREATE TABLE deployment_identity (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  kind text NOT NULL CHECK (kind IN ('production', 'rehearsal')),
  written_at timestamptz NOT NULL DEFAULT now(),
  written_by text NOT NULL DEFAULT current_user,
  note text
);

REVOKE ALL ON deployment_identity FROM PUBLIC, rm_app, rm_worker, rm_readonly;
GRANT SELECT ON deployment_identity TO rm_app, rm_worker, rm_readonly;

COMMENT ON TABLE deployment_identity IS 'One-row target enrollment: what this database is enrolled for (spec §4.2). Writable only by rm_owner.';
