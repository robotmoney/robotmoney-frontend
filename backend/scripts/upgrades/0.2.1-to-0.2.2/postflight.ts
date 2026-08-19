// Post-cutover verification for v0.2.1 -> v0.2.2 (docs/runbooks/*.md §8).
// Automates the SQL- and HTTP-shaped checks from that section's table.
// Checks 1 (boot exit code) and 10 (the admin-claim action) are NOT run here
// — 1 depends on §7.3's own command-line-captured $BOOT_STATUS, which no
// later process can recover, and 10 is a deliberate WRITE (the one-time
// admin claim, §12.1 Procedure A), which this script does not perform.
// Both remain manual operator steps; this script prints a reminder for each.
//
// Usage (after §2.0/§8's DATABASE_URL export + identity assertion):
//   bun scripts/upgrades/0.2.1-to-0.2.2/postflight.ts [--base-url=http://127.0.0.1:<port>]
//
// Optional baselines (read but never required — omitting either just
// downgrades that one comparison to a WARN telling you to compare by hand
// against docs/runbooks/*.md §5.3/§5.4's captured values):
//   POSTFLIGHT_BASELINE_SWARM_RECOMMENDATIONS=<pre-upgrade count>   (check 8)
//   POSTFLIGHT_ADMIN_CREDENTIAL_ROWS=<§2's pre-cutover count>       (check 9, defaults to 0)
//
// Exit codes: 0 = clean, 1 = a check failed, 2 = could not run.

import { columnExists, tableExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { type Db, fetchCheck, runPostflightMain } from "../../lib/postflight-utils.ts";

const THIS_RELEASE_MIGRATIONS = [
  "0029_admin_auth_recovery.sql",
  "0029_admin_passkey.sql",
  "0030_swarm_member_handle.sql",
  "0031_swarm_member_handle_namespace.sql",
  "0032_append_only_history.sql",
  "0033_swarm_member_uuid_ids.sql",
] as const;

const baseUrlArg = process.argv.find((a) => a.startsWith("--base-url="))?.slice("--base-url=".length);

// check 2 — all six migrations recorded
async function checkMigrationsRecorded(db: Db, { record }: Checker): Promise<void> {
  const rows = (await db`
    SELECT name FROM schema_migrations WHERE name = ANY(${THIS_RELEASE_MIGRATIONS})
  `) as unknown as { name: string }[];
  const present = new Set(rows.map((r) => r.name));
  const missing = THIS_RELEASE_MIGRATIONS.filter((m) => !present.has(m));
  if (missing.length > 0) {
    record(
      "migrations-recorded",
      "FAIL",
      [`${missing.length} of ${THIS_RELEASE_MIGRATIONS.length} expected migration(s) not recorded:`, ...missing.map((m) => `  ${m}`)],
      "The boot did not fully migrate. Check the api container's logs before doing anything else.",
    );
    return;
  }
  record("migrations-recorded", "PASS", `all ${THIS_RELEASE_MIGRATIONS.length} migrations recorded`);
}

// check 4 — no handle/id namespace violation in the data
// check 6 — every member has a handle
// check 7 — handles are saveable
async function checkHandleInvariants(db: Db, { record }: Checker): Promise<void> {
  if (!(await columnExists(db, "swarm_members", "handle"))) {
    record("handle-invariants", "FAIL", "swarm_members.handle does not exist — migration 0030 did not apply");
    return;
  }
  const [violation] = (await db`
    SELECT a.id AS holder, a.handle, b.id AS shadowed
    FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id
  `) as unknown as { holder: string; handle: string; shadowed: string }[];
  if (violation) {
    record(
      "handle-invariants",
      "FAIL",
      `namespace violation: member '${violation.holder}' has handle '${violation.handle}', which is member '${violation.shadowed}'s id`,
    );
    return;
  }
  const [{ null_count }] = (await db`
    SELECT count(*)::int AS null_count FROM swarm_members WHERE handle IS NULL
  `) as unknown as { null_count: number }[];
  if (null_count > 0) {
    record("handle-invariants", "FAIL", `${null_count} member(s) have a NULL handle — SET NOT NULL should have prevented this`);
    return;
  }
  const unsaveable = (await db`
    SELECT id FROM swarm_members WHERE handle !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(handle) > 80
  `) as unknown as { id: string }[];
  if (unsaveable.length > 0) {
    record(
      "handle-invariants",
      "WARN",
      [`${unsaveable.length} member(s) have an unsaveable handle:`, ...unsaveable.slice(0, 10).map((r) => `  ${r.id}`)],
      "UPDATE swarm_members SET handle = '<kebab-case>' WHERE id = '<id>'; — never move the id.",
    );
    return;
  }
  record("handle-invariants", "PASS", "no violation, no NULLs, all handles saveable");
}

// check 5 — namespace trigger is ENABLE ALWAYS
async function checkNamespaceTrigger(db: Db, { record }: Checker): Promise<void> {
  const [row] = (await db`
    SELECT tgenabled FROM pg_trigger WHERE tgname = 'swarm_members_handle_namespace_trigger'
  `) as unknown as { tgenabled: string }[];
  if (!row) {
    record("namespace-trigger", "FAIL", "trigger swarm_members_handle_namespace_trigger does not exist — migration 0031 did not apply");
    return;
  }
  if (row.tgenabled !== "A") {
    record(
      "namespace-trigger",
      "FAIL",
      `tgenabled = '${row.tgenabled}', expected 'A' (ENABLE ALWAYS) — a DISABLE/ENABLE cycle downgraded it`,
      "The replica-role bypass 0031 closes is open again. Re-run: ALTER TABLE swarm_members ENABLE ALWAYS TRIGGER swarm_members_handle_namespace_trigger;",
    );
    return;
  }
  record("namespace-trigger", "PASS", "ENABLE ALWAYS");
}

// check 8 — archive data was adopted, not overwritten
async function checkArchiveAdopted(db: Db, { record }: Checker): Promise<void> {
  const [{ count }] = (await db`SELECT count(*)::int AS count FROM swarm_recommendations`) as unknown as { count: number }[];
  const baselineRaw = process.env.POSTFLIGHT_BASELINE_SWARM_RECOMMENDATIONS;
  if (!baselineRaw) {
    record(
      "archive-adopted",
      "WARN",
      `swarm_recommendations: ${count} rows — no baseline given`,
      "Set POSTFLIGHT_BASELINE_SWARM_RECOMMENDATIONS to the pre-upgrade count captured in §5.3, or compare by hand.",
    );
    return;
  }
  const baseline = Number(baselineRaw);
  if (count < baseline) {
    record(
      "archive-adopted",
      "FAIL",
      `swarm_recommendations: ${count} rows, below the pre-upgrade baseline of ${baseline} — data appears LOST, not adopted`,
    );
    return;
  }
  record("archive-adopted", "PASS", `swarm_recommendations: ${count} rows (>= pre-upgrade baseline ${baseline})`);
}

// check 9 — admin_credential untouched by the boot
async function checkAdminCredentialUntouched(db: Db, { record }: Checker): Promise<void> {
  if (!(await tableExists(db, "admin_credential"))) {
    record("admin-credential-untouched", "FAIL", "admin_credential does not exist — migration 0028 (pre-existing) or the boot itself is broken");
    return;
  }
  // ONE row, always. The obvious form here was
  //   SELECT count(*), (recovery_hash IS NULL) FROM admin_credential GROUP BY 2
  // which on the EXPECTED state — unclaimed, zero rows — has no group to emit
  // and returns nothing at all. That happened to survive here only because
  // [].every() is vacuously true and reduce() had a seed; it is one refactor
  // away from reporting a pass it never computed, and the same shape printed
  // "(0 rows)" in the runbook where an operator was told to expect 0. An
  // aggregate with FILTER always returns a row, so "expected 0" is a value you
  // can actually compare. Same form preflight.ts already uses.
  const rows = (await db`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE recovery_hash IS NOT NULL)::int AS with_recovery
    FROM admin_credential
  `) as unknown as { total: number; with_recovery: number }[];
  const { total, with_recovery } = rows[0]!;
  // Unclaimed is the ONLY state this upgrade can start from: v0.2.1 ships no
  // claim UX, so nothing can have written this table (docs/runbooks/*.md §2,
  // "Admin credential — confirm unclaimed before cutover"). Default the
  // expectation to 0 rather than demanding a baseline nobody can vary.
  const expectedRows = Number(process.env.POSTFLIGHT_ADMIN_CREDENTIAL_ROWS ?? "0");
  if (with_recovery > 0) {
    record(
      "admin-credential-untouched",
      "FAIL",
      `admin_credential has ${with_recovery} row(s) with a non-NULL recovery_hash — 0029 adds that column and backfills nothing, and no seed path ever writes this table`,
    );
    return;
  }
  if (total !== expectedRows) {
    record(
      "admin-credential-untouched",
      "FAIL",
      `${total} row(s), expected ${expectedRows} — the boot changed admin_credential's row count`,
      total > expectedRows
        ? "If the admin claim (§12.1) was completed BEFORE this check ran, that is the expected 1 row: re-run with POSTFLIGHT_ADMIN_CREDENTIAL_ROWS=1."
        : undefined,
    );
    return;
  }
  record("admin-credential-untouched", "PASS", `${total} row(s) as expected, none carrying a recovery_hash — the boot did not touch this table`);
}

// check 12 — swarm schedules state (compare against §5.4's captured file by hand)
async function checkSwarmSchedules(db: Db, { record }: Checker): Promise<void> {
  const rows = (await db`
    SELECT kind, enabled FROM job_schedules WHERE kind LIKE 'swarm.%' ORDER BY 1
  `) as unknown as { kind: string; enabled: boolean }[];
  if (rows.length !== 5) {
    record("swarm-schedules", "WARN", `${rows.length} swarm.* row(s), expected 5`);
    return;
  }
  const allDisabled = rows.every((r) => !r.enabled);
  record(
    "swarm-schedules",
    allDisabled ? "WARN" : "PASS",
    [
      `${rows.length} rows: ${rows.map((r) => `${r.kind}=${r.enabled ? "on" : "off"}`).join(", ")}`,
      allDisabled ? "all disabled, as every bun smoke boot forces (§6.5) — compare against §5.4's captured file; drive sessions manually." : "",
    ].filter(Boolean),
  );
}

// check 3 — namespace guard ran and was clean (HTTP)
async function checkHealthEndpoint(_db: Db, { record }: Checker): Promise<void> {
  if (!baseUrlArg) {
    record("health-endpoint", "WARN", "no --base-url given — pass --base-url=http://127.0.0.1:<api port>");
    return;
  }
  const res = await fetchCheck(`${baseUrlArg}/health`);
  if (!res.ok) {
    record("health-endpoint", "FAIL", `GET /health: ${res.error ?? `HTTP ${res.status}`}`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body ?? "");
  } catch {
    record("health-endpoint", "FAIL", "GET /health did not return valid JSON");
    return;
  }
  const handleNamespace = (parsed as Record<string, unknown>)?.handle_namespace;
  if (handleNamespace === "clean") {
    record("health-endpoint", "PASS", "handle_namespace: clean");
  } else if (handleNamespace === "unchecked") {
    record("health-endpoint", "FAIL", "handle_namespace: unchecked — the guard could not run, this boot proves nothing");
  } else if (handleNamespace === "overridden") {
    record("health-endpoint", "FAIL", "handle_namespace: overridden — serving a namespace violation");
  } else {
    record("health-endpoint", "WARN", `handle_namespace: ${String(handleNamespace)} (unrecognized value)`);
  }
}

// check 11 — site serves prerendered HTML
async function checkPrerenderedRoute(_db: Db, { record }: Checker): Promise<void> {
  if (!baseUrlArg) {
    record("prerendered-route", "WARN", "no --base-url given — pass --base-url=http://127.0.0.1:<api port>");
    return;
  }
  const res = await fetchCheck(`${baseUrlArg}/swarm/`);
  if (!res.ok) {
    record("prerendered-route", "FAIL", `GET /swarm/: ${res.error ?? `HTTP ${res.status}`}`);
    return;
  }
  const title = res.body?.match(/<title>([^<]*)<\/title>/)?.[1];
  if (!title || /^Robot Money$|^Home$/i.test(title)) {
    record(
      "prerendered-route",
      "FAIL",
      `/swarm/ served the home page's title ("${title ?? "none"}"), not its own — see the runbook's "Diagnosing check 11"`,
    );
    return;
  }
  record("prerendered-route", "PASS", `<title>${title}</title>`);
}

async function runChecks(db: Db, checker: Checker): Promise<void> {
  console.log(`[postflight-0.2.2] reminder: check 1 (boot exit code) and check 10 (admin claim) are manual — see §8.`);
  console.log("");
  await checkMigrationsRecorded(db, checker);
  await checkHealthEndpoint(db, checker);
  await checkHandleInvariants(db, checker);
  await checkNamespaceTrigger(db, checker);
  await checkArchiveAdopted(db, checker);
  await checkAdminCredentialUntouched(db, checker);
  await checkPrerenderedRoute(db, checker);
  await checkSwarmSchedules(db, checker);
}

export async function main(): Promise<number> {
  return runPostflightMain({ name: "postflight-0.2.2", runChecks });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[postflight-0.2.2] fatal: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 2;
    });
}
