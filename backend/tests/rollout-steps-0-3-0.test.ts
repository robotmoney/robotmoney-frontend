// Holds the v0.3.0 rollout manifest (steps.ts) and the runbook prose
// (docs/runbooks/v0-3-0-rollout.md) in agreement mechanically.
//
// Same test as the v0.2.2 one beside it, pointed at this release. The pair is
// deliberate: each release's manifest is checked against ITS OWN runbook, so
// archiving a shipped release's runbook cannot quietly stop testing the live
// one — which is exactly the failure that would otherwise hide here.
//
// WHY. Every bug this test exists to catch has already happened at least once
// in this release:
//   - v0.2.2's §5.6 asked for "all Gate A–D results" after §2 abolished Gate A;
//   - preflight.ts said this release ships four migrations while postflight.ts
//     said six (27ec374 fixed one copy and not the other);
//   - §5.3b was headed "Optional but recommended" while §5.5 called the same
//     step a blocking gate.
// All three are one bug: a fact with two homes. The manifest gives each fact
// one home, and this test fails the moment a second one appears.
//
// It is deliberately filesystem-only — no database, no docker, no network — so
// it runs in any CI job and cannot be skipped for being slow.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { STEPS, THIS_RELEASE_MIGRATIONS } from "../scripts/upgrades/0.2.2-to-0.3.0/steps.ts";
import {
  AUM_GUARD_TRIGGERS,
  APPEND_ONLY_MIGRATION,
  APPEND_ONLY_TABLES,
  BACKFILL_JOB_KIND,
  BACKFILL_PROVENANCE,
  BACKFILL_WINDOW_JOB_KIND,
  COLLAPSE_PER_BUCKET_KINDS,
  MIGRATION_TOUCHED_TABLES,
  PRIOR_RELEASE_MIGRATIONS,
  NEW_SCHEDULE_CRON,
  NEW_SCHEDULE_KIND,
  NEW_COLUMNS,
  NEW_TABLES,
} from "../scripts/upgrades/0.2.2-to-0.3.0/release.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");
const runbookPath = join(repoRoot, "docs", "runbooks", "v0-3-0-rollout.md");
const runbook = readFileSync(runbookPath, "utf8");

/** Minimal parser for the runbook's ```yaml step blocks. Not a YAML library on
 *  purpose: the blocks are a fixed, flat shape (scalars and `- ` sequences),
 *  and a dependency here would be a dependency in a doc-consistency test. */
function parseStepBlocks(md: string): Record<string, string | string[]>[] {
  const blocks: Record<string, string | string[]>[] = [];
  const re = /```yaml step\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const out: Record<string, string | string[]> = {};
    let currentKey: string | null = null;
    for (const line of m[1]!.split("\n")) {
      if (!line.trim()) continue;
      const seq = line.match(/^\s+-\s+(.*)$/);
      if (seq && currentKey) {
        (out[currentKey] as string[]).push(seq[1]!.trim());
        continue;
      }
      const kv = line.match(/^([a-z-]+):\s*(.*)$/);
      if (!kv) throw new Error(`unparseable line in a yaml step block: ${JSON.stringify(line)}`);
      const [, key, value] = kv;
      if (value!.trim() === "") {
        currentKey = key!;
        out[key!] = [];
      } else {
        currentKey = null;
        out[key!] = value!.trim();
      }
    }
    blocks.push(out);
  }
  return blocks;
}

const blocks = parseStepBlocks(runbook);
const byId = new Map(blocks.map((b) => [b.id as string, b]));

describe("v0.3.0 rollout manifest ↔ runbook", () => {
  test("every step block in the runbook parses and names a known step", () => {
    expect(blocks.length).toBeGreaterThan(0);
    const known = new Set(STEPS.map((s) => s.id));
    for (const b of blocks) {
      expect(typeof b.id).toBe("string");
      expect(known.has(b.id as string)).toBe(true);
    }
  });

  test("every manifest step appears in the runbook exactly once", () => {
    for (const step of STEPS) {
      const hits = blocks.filter((b) => b.id === step.id);
      expect({ id: step.id, blocks: hits.length }).toEqual({ id: step.id, blocks: 1 });
    }
  });

  test("step ids are unique", () => {
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(STEPS.length);
  });

  test.each(STEPS.map((s) => [s.id, s] as const))("%s — block fields match the manifest", (_id, step) => {
    const b = byId.get(step.id)!;
    expect(b.phase).toBe(step.phase);
    expect(b.section).toBe(step.section);
    expect(b["host-role"]).toBe(step.hostRole);
    expect(b.actor).toBe(step.actor);
    expect(b.verify).toBe(step.verify);
    expect((b.requires as string[] | undefined) ?? []).toEqual(step.requires);
    expect((b["depends-on"] as string[] | undefined) ?? []).toEqual(step.dependsOn);
    expect((b.artifacts as string[] | undefined) ?? []).toEqual(step.artifacts ?? []);
    const ttl: string | null = (b.ttl as string | undefined) ?? null;
    const gate: string | null = (b.gate as string | undefined) ?? null;
    const rec: string | null = (b["expect-in-recovery"] as string | undefined) ?? null;
    expect({ rec }).toEqual({ rec: step.expectInRecovery === undefined ? null : String(step.expectInRecovery) });
    expect({ ttl }).toEqual({ ttl: step.ttlHours ? `${step.ttlHours}h` : null });
    expect({ gate }).toEqual({ gate: step.gate ?? null });
  });

  test("requires references resolve to real steps, and point backwards", () => {
    const index = new Map(STEPS.map((s, i) => [s.id, i]));
    for (const [i, step] of STEPS.entries()) {
      for (const req of step.requires) {
        expect({ step: step.id, req, known: index.has(req) }).toEqual({ step: step.id, req, known: true });
        // A prerequisite that comes LATER in manifest order would make the
        // probe's "first not-ok step is next" rule pick an unreachable step.
        expect({ step: step.id, req, before: index.get(req)! < i }).toEqual({ step: step.id, req, before: true });
      }
    }
  });

  test("a step's TTL never outlives the steps it depends on", () => {
    // A rehearsal cannot be better evidence than the dump proof it consumed.
    // P5.rehearsal-boot used to be 72h against P3.gate-c's 48h, which left a
    // 24h window where the gate read `expired` and the step built on it still
    // read `ok`. This makes the whole class impossible rather than fixing the
    // one instance.
    const byId = new Map(STEPS.map((s) => [s.id, s]));
    for (const step of STEPS) {
      if (!step.ttlHours) continue;
      for (const req of step.requires) {
        const dep = byId.get(req)!;
        if (!dep.ttlHours) continue;
        expect({ step: step.id, req, ok: step.ttlHours <= dep.ttlHours }).toEqual({ step: step.id, req, ok: true });
      }
    }
  });

  test("a step that emits its own receipt is actor:script, not attestable", () => {
    // where.ts refuses `--record` for actor:"script". That refusal guarded
    // NOTHING until this test existed: every script-backed step was
    // actor:"agent", so a rehearsal could be attested by typing --record
    // instead of being run. A step whose verify runs --emit-receipt has a
    // machine that produces its evidence; a human claiming it is not that.
    for (const step of STEPS) {
      if (!step.verify.includes("--emit-receipt")) continue;
      expect({ step: step.id, actor: step.actor }).toEqual({ step: step.id, actor: "script" });
    }
  });

  test("phases are contiguous — manifest order is display order", () => {
    const seen: string[] = [];
    for (const s of STEPS) {
      if (seen[seen.length - 1] !== s.phase) seen.push(s.phase);
    }
    expect(seen.length).toBe(new Set(seen).size);
  });

  test("a step that runs a script declares what invalidates it", () => {
    // Only steps that actually EXECUTE release code. `where.ts --record ...`
    // appears in several verify strings without being the thing being tested,
    // and a psql-only capture (§5.0, §5.4) is legitimately not code-bound.
    const RUNS_CODE = /(preflight|postflight|restore-check|stage-rehearsal)\.ts|bun smoke/;
    for (const step of STEPS) {
      if (!RUNS_CODE.test(step.verify) || step.derived) continue;
      expect({ step: step.id, deps: step.dependsOn.length > 0 }).toEqual({ step: step.id, deps: true });
    }
  });
});

describe("v0.3.0 THIS_RELEASE_MIGRATIONS is the single source", () => {
  // THIS PIN MOVES ONLY UPWARD, AND ONLY WITH A DECLARATION BESIDE IT. It is a
  // tripwire on the roster's terminal entry, so that growing the release is a
  // deliberate act somebody had to write down here as well as in release.ts —
  // NOT a lever for shrinking scope. 0042 joined via #754, 0043 via #835, 0044
  // via #761, 0045 via #760, and 0046 via #849: in each case the drift guard
  // below named the landed file as undeclared, and the fix was to DECLARE it
  // (never to raise the numeric floor).
  test("the release inventory includes the earliest-valid-block floor migration", () => {
    expect(THIS_RELEASE_MIGRATIONS).toHaveLength(15);
    expect(THIS_RELEASE_MIGRATIONS.at(-1)).toBe("0046_asset_prices.sql");
    expect(NEW_TABLES).toContain("wallet_balance_sample_evidence");
    expect(NEW_TABLES).toContain("wallet_sleeve_sample_evidence");
    expect(NEW_TABLES).toContain("wallet_aum_snapshot_runs");
    expect(NEW_COLUMNS).toContainEqual({ table: "chain_day_blocks", column: "block_hash" });
    expect(NEW_COLUMNS).toContainEqual({ table: "wallet_balance_samples", column: "snapshot_run_id" });
    expect(NEW_COLUMNS).toContainEqual({ table: "wallet_balance_sample_evidence", column: "snapshot_run_id" });
    expect(NEW_COLUMNS).toContainEqual({ table: "swarm_members", column: "role" });
    expect(NEW_COLUMNS).toContainEqual({ table: "swarm_session_judgements", column: "judged_by" });
    expect(NEW_COLUMNS).toContainEqual({ table: "swarm_session_judgements", column: "judged_by_member_id" });
    // 0044 (issue #761): the shared-leg circuit breaker's per-day counter.
    expect(NEW_COLUMNS).toContainEqual({ table: "wallet_backfill_state", column: "defer_leg" });
    expect(NEW_COLUMNS).toContainEqual({ table: "wallet_backfill_state", column: "defer_streak" });
    expect(NEW_COLUMNS).toContainEqual({ table: "wallet_backfill_state", column: "defer_leg_at" });
    expect(AUM_GUARD_TRIGGERS).toHaveLength(11);
    expect(MIGRATION_TOUCHED_TABLES).toContain("wallet_balance_samples");
    expect(MIGRATION_TOUCHED_TABLES).toContain("wallet_sleeve_samples");
    // 0039 CREATEs it, 0040 installs its append-only triggers and REVOKEs on
    // it, 0041 ALTERs it — the exact case this constant's doc-comment names
    // ("if a future edit adds a migration that DOES touch a protected table,
    // the check fails instead of the runbook quietly going stale").
    expect(MIGRATION_TOUCHED_TABLES).toContain("swarm_session_judgements");
    // 0039 swaps swarm_sessions' state CHECK constraint to admit 'judged', and
    // 0042 declares a foreign key to it.
    expect(MIGRATION_TOUCHED_TABLES).toContain("swarm_sessions");
    // 0042 CREATEs it and protects it in the same file. Empty after the
    // migration — nothing seeds a receipt — so postflight's present-and-empty
    // half applies as written, unlike `swarm_judge_config`.
    expect(NEW_TABLES).toContain("swarm_consensus_receipts");
    expect(MIGRATION_TOUCHED_TABLES).toContain("swarm_consensus_receipts");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE DRIFT GUARD. Everything else in this describe grades the roster against
  // a fact somebody wrote down; this grades it against the DIRECTORY.
  //
  // THIS_RELEASE_MIGRATIONS is hand-maintained at release-prep time, so between
  // a migration landing on main and somebody remembering to add a line here,
  // the roster is wrong — and preflight's `schema-migrations` check FAILs on a
  // pending migration it does not declare. That failure surfaces at CUTOVER,
  // against production, under time pressure. It has already happened once:
  // 0039/0040/0041 landed across #752/#757/#797 and none was declared (issue
  // #807).
  //
  // Same mechanism as the two roster cross-checks below it and as
  // APPEND_ONLY_MIGRATIONS' union pin in tests/append-only-enforcement.ts: an
  // executed test that reads BOTH sides and requires them to agree. Filesystem
  // only, so it runs wherever this file runs — and every PR that adds a
  // migration touches backend/**, which is exactly the path filter the backend
  // workflow gates on, so a migration can never land without this executing.
  // ───────────────────────────────────────────────────────────────────────────

  /** The numeric prefix a migration filename opens with. */
  const migrationNumber = (file: string): number => Number(file.slice(0, 4));

  /**
   * Where v0.3.0's own set begins. It is a FLOOR on the numeric prefix and
   * nothing more: its only job is to keep the frozen 0001–0031 archive out of
   * scope. It cannot let a NEW migration slip past, because every file that
   * lands from here on has a higher prefix than every file already on disk.
   *
   * Membership itself is decided by FILENAME, never by number — v0.2.2 shipped
   * `0032_append_only_history.sql` / `0033_swarm_member_uuid_ids.sql` and this
   * release adds a SECOND `0032_` and a SECOND `0033_` (§2.2.1), so the two
   * releases genuinely share prefixes. PRIOR_RELEASE_MIGRATIONS is what says
   * which of each pair production already has.
   */
  const RELEASE_FLOOR = 32;

  test("no migration on disk is left undeclared by the release rosters", () => {
    const onDisk = readdirSync(join(repoRoot, "backend", "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    // Vacuity guards: a check that grades an empty directory, or an empty
    // roster, passes while protecting nothing.
    expect(onDisk.length).toBeGreaterThan(RELEASE_FLOOR);
    expect(THIS_RELEASE_MIGRATIONS.length).toBeGreaterThan(0);
    // The floor may never rise above the roster's own first entry — that would
    // silently take declared migrations out of scope.
    expect(Math.min(...THIS_RELEASE_MIGRATIONS.map(migrationNumber))).toBe(RELEASE_FLOOR);

    const declared = new Set<string>([...THIS_RELEASE_MIGRATIONS, ...PRIOR_RELEASE_MIGRATIONS]);
    const undeclared = onDisk.filter((f) => migrationNumber(f) >= RELEASE_FLOOR && !declared.has(f));
    expect({
      undeclared,
      hint: "add each file to THIS_RELEASE_MIGRATIONS in backend/scripts/upgrades/0.2.2-to-0.3.0/release.ts",
    }).toEqual({
      undeclared: [],
      hint: "add each file to THIS_RELEASE_MIGRATIONS in backend/scripts/upgrades/0.2.2-to-0.3.0/release.ts",
    });
  });

  test("every named migration exists on disk", () => {
    for (const m of THIS_RELEASE_MIGRATIONS) {
      expect({ m, exists: existsSync(join(repoRoot, "backend", "migrations", m)) }).toEqual({ m, exists: true });
    }
  });

  test("release constants live in release.ts, not in the manifest", () => {
    // THIS release's manifest. Until now this line read 0.2.1-to-0.2.2 — cloned
    // with the rest of the file when #731 forked this suite — so it asserted the
    // PREVIOUS release's manifest twice and left v0.3.0's unchecked.
    const steps = readFileSync(join(repoRoot, "backend", "scripts", "upgrades", "0.2.2-to-0.3.0", "steps.ts"), "utf8");
    // steps.ts may RE-EXPORT them; declaring them would put display metadata
    // back inside every gate's depends-on, which is what the split undid.
    expect(/const THIS_RELEASE_MIGRATIONS\s*=/.test(steps)).toBe(false);
    // And no gate may depend on the manifest file itself.
    for (const step of STEPS) {
      expect({ step: step.id, dependsOnManifest: step.dependsOn.some((g) => g.endsWith("/steps.ts")) }).toEqual({
        step: step.id,
        dependsOnManifest: false,
      });
    }
  });

  test("no upgrade script declares its own copy", () => {
    for (const f of ["preflight.ts", "postflight.ts"]) {
      const src = readFileSync(join(repoRoot, "backend", "scripts", "upgrades", "0.2.2-to-0.3.0", f), "utf8");
      // Importing it is fine; re-declaring it is the drift that broke §8's
      // check 2 for three weeks.
      expect({ f, redeclares: /const THIS_RELEASE_MIGRATIONS\s*=/.test(src) }).toEqual({ f, redeclares: false });
    }
  });

  test("the runbook's migration table names every migration this release applies", () => {
    // §2.2 is where an operator reads what the cutover will do to the database.
    // A migration in the manifest but absent from that table is exactly the
    // "fact with two homes" failure — the boot would apply something the
    // runbook never told anyone about.
    const start = runbook.indexOf("### 2.2 🔴 The database delta");
    expect({ found: start >= 0 }).toEqual({ found: true });
    const section = runbook.slice(start, runbook.indexOf("## 3. Go/no-go gates"));
    for (const m of THIS_RELEASE_MIGRATIONS) {
      expect({ m, cited: section.includes(m.replace(/\.sql$/, "")) }).toEqual({ m, cited: true });
    }
  });

  test("the append-only migration constant matches src/db/append-only-guard.ts", () => {
    // release.ts keeps a byte-identical COPY rather than importing the module,
    // because append-only-guard.ts imports db/client.ts, which demands
    // DATABASE_URL at module load and builds the app's writer pool — and these
    // gate scripts must connect exactly once, read-only, from .env.readonly.
    // Nothing else holds the two in agreement, so this does.
    const guard = readFileSync(join(repoRoot, "backend", "src", "db", "append-only-guard.ts"), "utf8");
    const m = guard.match(/APPEND_ONLY_MIGRATION\s*=\s*"([^"]+)"/);
    expect({ found: m !== null }).toEqual({ found: true });
    expect({ copy: APPEND_ONLY_MIGRATION }).toEqual({ copy: m![1]! });
  });

  // ── The copies #739 proved were unguarded ─────────────────────────────────
  //
  // release.ts copies these rather than importing them, for the same reason it
  // copies the append-only pair: the modules that own them pull in db/client.ts,
  // which demands DATABASE_URL at module load and builds the app's WRITER pool —
  // unacceptable in a gate script that must connect once, read-only, from
  // .env.readonly.
  //
  // #739 (79063ab) changed the dispatcher's job kind in src/ and nothing failed.
  // The release's §7.1 observation went on grading `wallet.backfill_day`, a kind
  // nothing enqueues any more, and reported the release's headline feature as
  // not dispatching. backend.yml runs this suite on every backend/** PR, so
  // these guards would have caught it there rather than on a stage rehearsal
  // four rcs later.

  const readSrc = (...parts: string[]): string => readFileSync(join(repoRoot, "backend", "src", ...parts), "utf8");
  const constFromSrc = (src: string, name: string): string => {
    const m = src.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`));
    expect({ name, found: m !== null }).toEqual({ name, found: true });
    return m![1]!;
  };

  test("BACKFILL_WINDOW_JOB_KIND matches the kind the dispatcher enqueues", () => {
    const repair = readSrc("worker", "handlers", "repair.ts");
    expect({ copy: BACKFILL_WINDOW_JOB_KIND }).toEqual({ copy: constFromSrc(repair, "WINDOW_KIND") });
  });

  test("BACKFILL_JOB_KIND matches the legacy per-day kind still registered as a handler", () => {
    const repair = readSrc("worker", "handlers", "repair.ts");
    expect({ copy: BACKFILL_JOB_KIND }).toEqual({ copy: constFromSrc(repair, "BACKFILL_KIND") });
  });

  test("NEW_SCHEDULE_KIND and NEW_SCHEDULE_CRON match the row db/seed.ts actually seeds", () => {
    const seed = readSrc("db", "seed.ts");
    const row = seed.match(/\{\s*kind:\s*"ops\.repair_gaps",\s*cron:\s*"([^"]+)"/);
    expect({ found: row !== null }).toEqual({ found: true });
    expect({ kind: NEW_SCHEDULE_KIND }).toEqual({ kind: "ops.repair_gaps" });
    expect({ cron: NEW_SCHEDULE_CRON }).toEqual({ cron: row![1]! });
  });

  test("BACKFILL_PROVENANCE matches what the executor writes", () => {
    // ops/wallet-backfill.ts tags repaired rows with this exact string; §7.1's
    // completion observation and postflight's strategy-nav-column both filter on
    // the copy. A drift here makes a working repair look like it wrote nothing.
    // The executor writes it as a SQL literal in the VALUES list of both series'
    // upserts, so assert the literal appears at least twice — once per table.
    const backfill = readSrc("ops", "wallet-backfill.ts");
    const literals = [...backfill.matchAll(new RegExp(`'${BACKFILL_PROVENANCE}'`, "g"))].length;
    expect({ atLeastTwoWrites: literals >= 2 }).toEqual({ atLeastTwoWrites: true });
  });

  test("COLLAPSE_PER_BUCKET_KINDS matches the kinds 0034 actually UPDATEs", () => {
    // The one data write in the migration set. postflight's catchup-policy check
    // grades both directions against this copy, so a drift would grade the wrong
    // rows in silence.
    const mig = readFileSync(join(repoRoot, "backend", "migrations", "0034_job_schedules_catchup_policy.sql"), "utf8");
    const inClause = mig.match(/WHERE\s+kind\s+IN\s*\(([^)]*)\)/i);
    expect({ found: inClause !== null }).toEqual({ found: true });
    const fromMigration = [...inClause![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
    expect({ kinds: [...(COLLAPSE_PER_BUCKET_KINDS as readonly string[])].sort() }).toEqual({ kinds: fromMigration });
  });

  test("the append-only TABLE ROSTER matches src/db/append-only-guard.ts", () => {
    // Same copy-not-import trade as the constant above, and the same mitigation.
    // postflight's append-only-intact check compares the live triggers against
    // this roster; before it did, ANY non-zero trigger count PASSed, so losing
    // thirteen of fourteen tables read as green. A roster that drifts from the
    // guard would put that hole straight back.
    const guard = readFileSync(join(repoRoot, "backend", "src", "db", "append-only-guard.ts"), "utf8");
    const block = guard.match(/APPEND_ONLY_TABLES\s*=\s*\[([\s\S]*?)\]\s*as const/);
    expect({ found: block !== null }).toEqual({ found: true });
    const fromGuard = [...block![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
    expect({ tables: [...APPEND_ONLY_TABLES] as string[] }).toEqual({ tables: fromGuard });
  });

  test("§9 check 6's protected-table count matches APPEND_ONLY_TABLES.length", () => {
    // #816: the runbook restated this count in English prose ("all fourteen
    // protected tables") in two places, and #811 fixed only one of them —
    // both said "fourteen" even after APPEND_ONLY_TABLES grew to fifteen. A
    // hand-maintained number with two homes drifts silently every time a
    // table is added; this test gives it one home (APPEND_ONLY_TABLES) and
    // fails the moment the prose disagrees, the same mechanism as the
    // migration-roster tests above.
    const NUMBER_WORDS: Record<string, number> = {
      ten: 10,
      eleven: 11,
      twelve: 12,
      thirteen: 13,
      fourteen: 14,
      fifteen: 15,
      sixteen: 16,
      seventeen: 17,
      eighteen: 18,
      nineteen: 19,
      twenty: 20,
    };
    const m = runbook.match(/on all (\w+) protected tables/);
    expect({ found: m !== null }).toEqual({ found: true });
    const word = m![1]!.toLowerCase();
    expect({ word, known: word in NUMBER_WORDS }).toEqual({ word, known: true });
    expect({ runbookCount: NUMBER_WORDS[word] }).toEqual({ runbookCount: APPEND_ONLY_TABLES.length });
  });
});

describe("receipt step ids are wired to the scripts that emit them", () => {
  const wiring: [string, string][] = [
    ["preflight.ts", "P4.preflight-live"],
    ["restore-check.ts", "P3.gate-c"],
    ["stage-rehearsal.ts", "P5.rehearsal-boot"],
    ["postflight.ts", "P5.postflight-smoke-twin"],
    ["postflight.ts", "P8.postflight-prod"],
  ];
  test.each(wiring)("%s emits %s", (file, stepId) => {
    const src = readFileSync(join(repoRoot, "backend", "scripts", "upgrades", "0.2.2-to-0.3.0", file), "utf8");
    expect(src.includes(stepId)).toBe(true);
    expect(STEPS.some((s) => s.id === stepId)).toBe(true);
  });
});

describe("G8 — postflight runs inside the smoke-twin's window", () => {
  // The regression this exists to stop. stage-rehearsal.ts is now a thin
  // wrapper over the shared driver (scripts/lib/smoke-twin-rehearsal.ts), and the
  // driver tears the smoke-twin down in a `finally`. If the wrapper ever stops
  // passing `onReady`, the rehearsal still goes GREEN — it just silently grades
  // restore + boot + serve and never runs a single postflight check, while
  // P5.postflight-smoke-twin's step still claims stage-rehearsal.ts is what produces
  // it. That is the exact shape of evidence that is worse than none.
  const rehearsal = readFileSync(
    join(repoRoot, "backend", "scripts", "upgrades", "0.2.2-to-0.3.0", "stage-rehearsal.ts"),
    "utf8",
  );

  test("the rehearsal hands this release's postflight to the driver's onReady window", () => {
    expect({ hook: /onReady\s*:/.test(rehearsal) }).toEqual({ hook: true });
    expect(rehearsal).toContain("0.2.2-to-0.3.0/postflight.ts");
  });

  test("the driver refuses to pass an onReady run it could not reach the smoke-twin for", () => {
    // A hook that cannot resolve the smoke-twin's URL must FAIL the rehearsal. A
    // "checks did not run" that exits 0 is indistinguishable, in the receipt,
    // from "checks ran and found nothing wrong".
    const driver = readFileSync(join(repoRoot, "scripts", "lib", "smoke-twin-rehearsal.ts"), "utf8");
    const guard = driver.slice(driver.indexOf("if (opts.onReady)"));
    expect({ found: guard.length > 0 }).toEqual({ found: true });
    expect(guard.slice(0, guard.indexOf("hookCode"))).toContain("return 1;");
  });

  test("the step that claims the smoke-twin postflight names the rehearsal as its verify", () => {
    const step = STEPS.find((s) => s.id === "P5.postflight-smoke-twin");
    expect({ found: step !== undefined }).toEqual({ found: true });
    expect(step!.verify).toContain("stage-rehearsal.ts");
  });
});

describe("the runbook names the same checks the scripts actually run", () => {
  // The gap this closes: §6.1 and §9 are TABLES an operator reads to know what
  // a clean run looks like, and nothing held them to the scripts. A check
  // renamed in code and not in the table leaves the operator looking for a row
  // that will never appear — and, worse, not looking for one that will.
  const checkNames = (file: string): string[] => {
    const src = readFileSync(join(repoRoot, "backend", "scripts", "upgrades", "0.2.2-to-0.3.0", file), "utf8");
    return [...new Set([...src.matchAll(/record\(\s*"([a-z-]+)"/g)].map((m) => m[1]!))].sort();
  };

  test("§6.1 names every check preflight.ts records", () => {
    const section = runbook.slice(
      runbook.indexOf("### 6.1 What it checks"),
      runbook.indexOf("### 6.2"),
    );
    expect({ found: section.length > 0 }).toEqual({ found: true });
    for (const name of checkNames("preflight.ts")) {
      expect({ name, inRunbook: section.includes(`\`${name}\``) }).toEqual({ name, inRunbook: true });
    }
  });

  test("§9 names every check postflight.ts records", () => {
    const section = runbook.slice(
      runbook.indexOf("## 9. Post-cutover verification"),
      runbook.indexOf("### Only when every check is clean"),
    );
    expect({ found: section.length > 0 }).toEqual({ found: true });
    for (const name of checkNames("postflight.ts")) {
      expect({ name, inRunbook: section.includes(`\`${name}\``) }).toEqual({ name, inRunbook: true });
    }
  });
});
