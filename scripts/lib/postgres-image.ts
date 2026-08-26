// THE one place a PostgreSQL container image is pinned for an EPHEMERAL
// database in this repo. Two kinds of consumer, and they must agree:
//
//   1. The test harness — backend/tests/preload.ts (the shared suite database)
//      and the four migration tests that provision a server of their own
//      because they need a genuine pre-migration baseline
//      (admin-surface-migration, swarm-briefs-session-key-migration,
//      swarm-member-handle-migration, swarm-member-handle-namespace-migration).
//   2. The rollout tooling's digital smoke-twin — scripts/lib/restore-container.ts,
//      which restores a real production dump for restore-check.ts and
//      stage-rehearsal.ts.
//
// NOT the smoke/single-box compose stack (docker-compose.yml's `postgres`
// service). That one carries a persistent `pgdata` volume and a documented
// `--pg-data` resume contract, so its major cannot be changed by editing a
// string — a running data directory is not readable by a different major. It
// is pinned separately and says so at its own pin.
//
// WHY THIS FILE EXISTS (issue #691). The pin was in two places and they
// drifted. The harness sat on postgres:17-alpine while restore-container.ts
// had already moved to postgres:18 to match production, so every migration in
// backend/migrations/ was validated against a major it would never run on —
// and nothing reported it, which is why it took an audit to notice rather than
// a red test. One constant makes that drift unrepresentable; the version
// assertion in backend/tests/postgres-version-parity.test.ts makes a
// reintroduction loud.
//
// WHAT PRODUCTION IS. DigitalOcean Managed Postgres, 18.6 as of 2026-08-17
// (Gate B's `server-version` check —
// backend/scripts/upgrades/0.2.1-to-0.2.2/preflight.ts). Only the MAJOR is
// pinned here: the minor a given image happens to carry is not something this
// repo controls, and the migration behaviour at stake is major-scoped.
export const POSTGRES_MAJOR = 18;

/**
 * The image tag itself. The absence of an `-alpine` suffix is a DECISION, not
 * an omission (issue #691's fourth acceptance criterion).
 *
 * FOR alpine: it is ~300MB smaller on disk. That is the entire case, and it is
 * a one-time-per-machine cost — the image is pulled once and cached, so it
 * buys nothing per test run.
 *
 * AGAINST, and decisive: the alpine variants link musl; the default (Debian)
 * variants, DigitalOcean Managed Postgres, and therefore every database these
 * containers stand in for link glibc. Postgres delegates text collation to the
 * C library, so the libc is not a packaging detail — it decides `ORDER BY` on
 * text, the order a btree index materialises, and which comparisons a unique
 * index or a pattern index can actually serve. A harness that validates the
 * schema and its migrations under musl collation is validating behaviour the
 * deployed database does not have; restore-container.ts's smoke-twin, which loads an
 * actual production dump, would be comparing against a differently-ordered
 * server. Matching the deployment target beats saving cached bytes.
 *
 * If this is ever flipped back to alpine it flips for the smoke-twin at the same
 * time, which is the point of it being one constant.
 */
export const POSTGRES_IMAGE = `postgres:${POSTGRES_MAJOR}`;
