// The provisioning script must not rotate passwords unless asked.
//
// WHY THIS IS PINNED BY A TEST. The script ended with three unconditional
// `\password` prompts, so every run rotated rm_app, rm_worker and rm_readonly.
// Nothing propagated the new values -- the script's closing message asked the
// operator to hand-copy them into each host's $HOME/.env. On 2026-09-21 a
// provisioning run at 01:55Z rotated rm_readonly while a host .env written 100
// minutes earlier kept the old value, and `smoke:capture` failed with
// "password authentication failed" on two staging hosts.
//
// The trap is that this script MUST be re-run for reasons unrelated to
// passwords: 0053 has to be applied out-of-band before any migration can
// `SET LOCAL ROLE rm_owner`. So a routine, correct re-provision broke every
// host's backup, and the only symptom appeared at the NEXT release's first
// gate. A comment saying "don't rotate" would not have survived that; a test
// does.
//
// Read as TEXT, because the subject is what the script DOES when run with one
// argument, and running it for real needs a production primary.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "ops", "provision-db-role-taxonomy.sh");
const sh = readFileSync(SCRIPT, "utf8");

/** Lines that invoke psql's `\password`, ignoring comments. */
function passwordLines(): string[] {
  return sh
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .filter((l) => /\\password/.test(l));
}

describe("provision-db-role-taxonomy.sh does not rotate passwords by default", () => {
  test("RED CONTROL: the matcher still finds the \\password invocations", () => {
    // Guards every case below from passing because the regex matches nothing.
    expect(passwordLines().length).toBeGreaterThanOrEqual(3);
  });

  test("every \\password invocation is inside the --set-passwords branch", () => {
    // The branch opens with `if [[ "$set_passwords" -eq 1 ]]` and closes with
    // `else`. Anything calling \password outside it rotates unconditionally.
    const lines = sh.split("\n");
    const open = lines.findIndex((l) => /if\s*\[\[\s*"\$set_passwords"\s*-eq\s*1\s*\]\]/.test(l));
    expect(open).toBeGreaterThan(-1);
    const close = lines.findIndex((l, i) => i > open && /^else$/.test(l.trim()));
    expect(close).toBeGreaterThan(open);

    const offenders = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => !l.trim().startsWith("#") && /\\password/.test(l))
      .filter(({ i }) => i < open || i > close)
      .map(({ l, i }) => `line ${i + 1}: ${l.trim()}`);
    expect(offenders).toEqual([]);
  });

  test("the flag defaults to off", () => {
    expect(sh).toMatch(/^set_passwords=0$/m);
  });

  test("usage names the flag, so the capability is discoverable", () => {
    expect(sh).toMatch(/usage:.*--set-passwords/);
  });

  test("the script applies 0062, which is what makes it the runbook pre-step", () => {
    // 0062 carries the rm_readonly sequence grant and the rm_readonly_test
    // drop. The drop needs CREATEROLE, which rm_owner lacks, so it can only
    // happen on this path -- see 0062's own header.
    expect(sh).toMatch(/migrations\/0062_rm_readonly_sequence_select\.sql/);
    expect(sh).toMatch(/migrations\/0053_database_role_taxonomy\.sql/);
  });

  test("the script VERIFIES the end state, and fails loudly when it is wrong", () => {
    // ON_ERROR_STOP + set -e is not enough, and that gap is why this exists.
    // 0053 and 0062 both do work inside DO blocks that catch exceptions on
    // purpose — 0062's rm_readonly_test drop is skipped with only a NOTICE
    // when the session lacks CREATEROLE. psql exits 0 either way, so the
    // script used to PRINT that the cleanup had happened without checking.
    expect(sh).toMatch(/Verifying the resulting role configuration/);
    expect(sh).toMatch(/RAISE EXCEPTION/);
    // A verification that cannot fail is worse than none: it must raise, not
    // merely notice.
    const verify = sh.slice(sh.indexOf("Verifying the resulting role configuration"));
    expect(verify).toMatch(/RAISE EXCEPTION[\s\S]*role configuration is WRONG/);
  });

  test("the verification covers every property this session established", () => {
    // Each entry is here because something actually went wrong with it.
    const verify = sh.slice(sh.indexOf("Verifying the resulting role configuration"));
    const required: [string, RegExp][] = [
      // The backup gate: pg_dump reads last_value as rm_readonly.
      ["reader sequence SELECT", /has_sequence_privilege\(r\.role/],
      // The live outage: rm_worker could not write the sampler tables.
      ["sampler write grants", /asset_prices[\s\S]*chain_address_floors/],
      ["rm_worker INSERT/UPDATE", /has_table_privilege\('rm_worker'[\s\S]*INSERT/],
      // The drop that silently no-ops when it cannot run.
      ["test role removed", /rm_readonly_test still exists/],
      // The membership that lets migrations SET ROLE rm_owner at all.
      ["rm_owner membership", /no LOGIN role is a member of rm_owner/],
      // A runtime role that can assume the owner can run DDL.
      ["runtime roles excluded", /IS a member of rm_owner/],
      // What stops the whole class recurring on the next migration.
      ["default privileges", /no default SELECT on TABLES/],
      // …for SEQUENCES too. That is the half 0053 revoked and never restored,
      // and the half whose absence breaks pg_dump rather than the app -- so a
      // check that covered only TABLES would have called the configuration
      // healthy on the morning the backup refused to run.
      ["default privileges (sequences)", /no default SELECT on SEQUENCES/],
      // A table grant is worthless without USAGE on the schema holding it,
      // and has_table_privilege does not consider USAGE at all.
      ["schema usage", /no USAGE on schema public/],
      // 0053 ends with GRANT rm_owner TO current_user, so provisioning as one
      // login and migrating as another fails at 0054, at deploy time.
      ["this login holds rm_owner", /does not hold rm_owner membership/],
      // A role with no password holds every privilege and authenticates for
      // nobody -- the exact end state of a first bootstrap without
      // --set-passwords.
      ["runtime roles can authenticate", /have NO password and cannot authenticate/],
    ];
    for (const [label, re] of required) {
      expect({ label, covered: re.test(verify) }).toEqual({ label, covered: true });
    }
  });

  test("the verification cannot be aborted by the privileges of the login running it", () => {
    // Two ways the block killed itself instead of reporting, both found by
    // executing it rather than reading it:
    //
    //   * `has_sequence_privilege` THROWS on a non-sequence, and the planner
    //     is free to evaluate it before the relkind filter -- it died with
    //     `ERROR: "pg_statistic" is not a sequence` on a database it had just
    //     provisioned correctly. MATERIALIZED makes the filter a barrier.
    //   * passing a table by NAME makes the CALLER resolve it, which needs
    //     USAGE on schema public -- which 0053 revokes from everyone but the
    //     three runtime roles. A bootstrap login that did not inherit it from
    //     rm_owner got `permission denied for schema public`, losing every
    //     other finding including the one naming that as the cause.
    // Live SQL only: both hazards are named in the comments that explain them.
    const verify = sh
      .slice(sh.indexOf("Verifying the resulting role configuration"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(verify).toMatch(/AS MATERIALIZED/);
    expect(verify).not.toMatch(/has_(table|sequence)_privilege\([^)]*format\(/);
    expect(verify).not.toMatch(/to_regclass/);
  });

  test("the closing message no longer asserts outcomes it has not checked", () => {
    // It used to end with "Roles provisioned. 0062 applied: … and the
    // rm_readonly_test cleanup." — a claim about a step that can silently
    // skip. Now the claim follows the check that earns it.
    expect(sh).not.toMatch(/Roles provisioned\. 0062 applied/);
    expect(sh).toMatch(/Roles provisioned and VERIFIED/);
  });

  test("the retired inline sequence GRANT is gone — 0062 is the single source", () => {
    // Two copies of the same grant would drift, and the inline one could not
    // reach a fresh database or a restored twin.
    const live = sh.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(live).not.toMatch(/-c\s+"GRANT SELECT ON ALL SEQUENCES/);
  });
});
