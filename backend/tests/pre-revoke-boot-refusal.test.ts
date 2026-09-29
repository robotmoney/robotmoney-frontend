// Code built before the breaking revoke refuses to boot after it — issue #1026
// criterion 171, decision D55 (6), smoke-production-spec.md §8.4.
//
// D55 (6), the second constraint on the delete redesign: "No release may ship
// code that writes a revocation or consumption tombstone unless the same
// release carries the `compat: breaking` migration that revokes runtime
// `DELETE`. Gate: code built before that migration refuses to boot after it."
// Why: "Code built before the tombstone does not read it, so a rollback to that
// code would serve a revoked key again. The breaking label closes that
// rollback." §8.4: "Code built for snapshot N boots against a database at M > N
// only if every ledger row outside its own filename list carries `compat =
// additive` ... `breaking` refuses."
//
// THE DATABASE is built the way a real one reaches this release: snapshot N
// (the pinned fixture, tests/fixtures/snapshots/) bootstrapped by rm_owner,
// then the REAL migrate run with this checkout's migrations, which applies
// 0088 (the WebAuthn slots), 0089 (the revoke), 0090 and 0091 and records each one's
// declared compat in the ledger.
//
// THE CODE is the real api entrypoint (`bun run src/api/index.ts`), logged in
// as rm_app, twice:
//   * as built here — it serves: the database is healthy and this code's
//     filename list holds every ledger row;
//   * as built before this wave — its schema snapshot's filename list ends at
//     `0087_member_key_spoof_generation.sql`, the last file of the tree before
//     0088 (f59bbac7). That list is the only input check 3b takes from the
//     image (runStartupPreflight: `codeFilenames`), so the image is modelled by
//     exactly that list, handed in through `bun --preload` the way
//     tests/support/automation-auth.ts's red controls rewrite one line of a
//     real process. It must refuse by check 3b, naming 0088 and 0089 as
//     breaking — and not 0090 or 0091, whose `additive` it may run beside.
import { restoreRoleBaselineAfterAll } from "./support/cluster.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import { loadSnapshot } from "../src/db/schema-snapshot.ts";
import { restoreRoles, saveRoles, type SavedRole } from "./fixtures/releases/release-fixture.ts";
import { writeRedControlPreload } from "./support/automation-auth.ts";
import { ScratchDatabases } from "./support/snapshot-fixture.ts";
import { BACKEND_DIR, connectAdmin, databaseUrl, freePort, portIsBound } from "./support/startup-preflight.ts";

const APP = { name: "rm_app", password: `rm_app_prerevoke_${randomBytes(6).toString("hex")}` };
/** The last migration of the tree before this wave's (f59bbac7). */
const LAST_BEFORE_REVOKE = "0087_member_key_spoof_generation.sql";
const REVOKE = "0089_revoke_runtime_delete.sql";
const SLOTS = "0088_webauthn_challenge_slots.sql";
const COMMENT = "0090_stream_events_retention_comment.sql";
const WORKER_EVIDENCE = "0091_rm_worker_wallet_evidence_insert.sql";

const dbs = new ScratchDatabases();
const suffix = crypto.randomUUID().slice(0, 8);
const NAME = `rm_prerevoke_${suffix}`;
let db: postgres.Sql<{}>;
let savedRoles: SavedRole[] = [];

interface Boot {
  readonly outcome: "served" | "exited";
  readonly code: number | null;
  readonly port: number;
  readonly lines: string[];
  /** The served /health body; null when the process exited instead. */
  readonly health: Record<string, unknown> | null;
}

/** Boot the real api as rm_app on the scratch database, optionally with a preload. */
async function bootApi(preload?: string): Promise<Boot> {
  const port = await freePort();
  const proc = Bun.spawn(["bun", "run", ...(preload ? ["--preload", preload] : []), "src/api/index.ts"], {
    cwd: BACKEND_DIR,
    env: { ...process.env, RM_ENV: "stage", DATABASE_URL: databaseUrl(NAME, APP), API_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out: string[] = [];
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) out.push(decoder.decode(chunk, { stream: true }));
  };
  const drained = Promise.all([drain(proc.stdout as ReadableStream<Uint8Array>), drain(proc.stderr as ReadableStream<Uint8Array>)]);
  const lines = () =>
    out
      .join("")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("startup_preflight:"));
  const deadline = Date.now() + 90_000;
  try {
    for (;;) {
      if (proc.exitCode !== null) {
        await drained;
        return { outcome: "exited", code: proc.exitCode, port, lines: lines(), health: null };
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return { outcome: "served", code: null, port, lines: lines(), health: (await res.json()) as Record<string, unknown> };
      } catch {
        /* not listening yet */
      }
      if (Date.now() > deadline) throw new Error(`api neither served nor exited on :${port}\n${out.join("")}`);
      await Bun.sleep(150);
    }
  } finally {
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  }
}

beforeAll(async () => {
  // cluster admin: ALTER ROLE and saving/restoring role attributes are superuser-only
  const cluster = connectAdmin();
  try {
    savedRoles = await saveRoles(cluster);
    await cluster.unsafe(`ALTER ROLE rm_app LOGIN PASSWORD '${APP.password}'`);
  } finally {
    await cluster.end({ timeout: 5 });
  }
  db = await dbs.atSnapshotN(NAME);
  const run = await dbs.migrate(db, NAME);
  expect(run.applied).toContain(REVOKE);
  await db.unsafe("RESET ROLE");
}, 180_000);

afterAll(async () => {
  await dbs.dropAll();
  const cluster = connectAdmin();
  try {
    await restoreRoles(cluster, savedRoles);
  } finally {
    await cluster.end({ timeout: 5 });
  }
});

describe("the breaking revoke closes rollback to code that ignores the tombstones (D55 (6))", () => {
  test("the real migrate run recorded 0088 and 0089 as breaking, and 0090 and 0091 as additive", async () => {
    const rows = (await db`
      SELECT name, compat FROM schema_migrations
       WHERE name IN (${SLOTS}, ${REVOKE}, ${COMMENT}, ${WORKER_EVIDENCE}) ORDER BY name`) as unknown as {
      name: string;
      compat: string;
    }[];
    expect(rows).toEqual([
      { name: SLOTS, compat: "breaking" },
      { name: REVOKE, compat: "breaking" },
      { name: COMMENT, compat: "additive" },
      { name: WORKER_EVIDENCE, compat: "additive" },
    ]);
  });

  test("the code built here serves the migrated database, with both boot guards armed as rm_app", async () => {
    const boot = await bootApi();
    expect({ outcome: boot.outcome, lines: boot.lines }).toEqual({ outcome: "served", lines: ["startup_preflight: passed"] });
    // The guards' DELETE probes get 42501 from rm_app on every table now (D55
    // (6)). That refusal is the conclusive answer, so both checks report
    // "armed", never "unchecked" (which a 42501 counted as inconclusive gave).
    expect({
      append_only_guard: boot.health?.append_only_guard,
      analytics_ledger_guard: boot.health?.analytics_ledger_guard,
    }).toEqual({ append_only_guard: "armed", analytics_ledger_guard: "armed" });
  }, 120_000);

  test("the code built before the revoke refuses to boot by check 3b, naming 0088 and 0089 as breaking and not 0090 or 0091", async () => {
    // Its filename list, as its own snapshot carried it: this tree's up to the
    // last file before this wave. Nothing else about the image changes.
    const own = (await loadSnapshot()).filenames;
    expect(own).toContain(LAST_BEFORE_REVOKE);
    const before = own.filter((file) => file <= LAST_BEFORE_REVOKE);
    expect(own.filter((file) => !before.includes(file) && file <= WORKER_EVIDENCE)).toEqual([SLOTS, REVOKE, COMMENT, WORKER_EVIDENCE]);
    const preload = writeRedControlPreload(
      "src/db/preflight.ts",
      "codeFilenames = (await loadSnapshot()).filenames;",
      `codeFilenames = (await loadSnapshot()).filenames.filter((file) => file <= ${JSON.stringify(LAST_BEFORE_REVOKE)});`,
    );

    const boot = await bootApi(preload);
    expect(boot.outcome).toBe("exited");
    expect(boot.code).toBe(1);
    expect(await portIsBound(boot.port)).toBe(false);
    // One refusal per breaking row, exactly these three: 0092 (the fault-injection
    // table's drop, D55 (3)) is also breaking and also unknown to this old code.
    expect(boot.lines).toEqual([
      `startup_preflight: refused check 3: ${SLOTS}: declared breaking — code-only rollback past it is closed, explicitly (§8.4).`,
      `startup_preflight: refused check 3: ${REVOKE}: declared breaking — code-only rollback past it is closed, explicitly (§8.4).`,
      "startup_preflight: refused check 3: 0092_drop_swarm_judge_fault_injection.sql: declared breaking — code-only rollback past it is closed, explicitly (§8.4).",
    ]);
  }, 120_000);
});

// A role's password is cluster state that outlives this file; put the baseline back (tests/support/cluster.ts).
restoreRoleBaselineAfterAll();
