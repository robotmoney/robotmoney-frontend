// `api` runs preflight checks 1-3 at startup against its own credential and
// refuses to serve on failure (smoke-production-spec.md §7.2; #1026 criteria 44
// and 61).
//
// WHAT RUNS. The real entrypoint — `bun run src/api/index.ts`, docker-compose's
// api command — as a real process, logged in as rm_app over a real password,
// against a real database bootstrapped from backend/schema/ by rm_owner
// (tests/support/startup-preflight.ts). Each case plants ONE failure into its
// own copy of that database and grades the process: exit 1, the named refusal
// line `startup_preflight: refused check <n>: <reason>`, and NO port bound. The
// positive control boots the same entrypoint against an untouched copy and
// sees it serve, so every refusal below is owed to the planted failure and
// nothing else.
//
// Criterion 61's case does not hand-write an in-progress state: it interrupts
// the REAL migrate run (`runMigrate`, as rm_owner, under the target lock)
// through its afterCommit seam — a throw after one migration committed, where a
// killed process would stop — and then boots the api against that database.
//
// RM_ENV is `stage` here (and `prod` in one case), the values a stack hands the
// api. `ephemeral`, the in-process harness's env, reports the same refusals
// and serves; one case pins that exception so it cannot widen unnoticed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { sql } from "../src/db/client.ts";
import { detectManifestState } from "../src/db/schema-manifest.ts";
import { runMigrate } from "../scripts/migrate-run.ts";
import { withTargetLock } from "./support/target-lock.ts";
import {
  BACKEND_DIR,
  bootApi,
  connectAdmin,
  copyDatabase,
  createSnapshotTemplate,
  databaseUrl,
  dropDatabases,
  portIsBound,
  startupLines,
  type ApiBoot,
} from "./support/startup-preflight.ts";

const APP = { name: "rm_app", password: `rm_app_startup_${crypto.randomUUID().slice(0, 8)}` };
const OWNER = { name: "rm_owner", password: `rm_owner_startup_${crypto.randomUUID().slice(0, 8)}` };

let template = "";
const created: string[] = [];
let ownerCanLogin: boolean | null = null;

beforeAll(async () => {
  await sql.unsafe(`ALTER ROLE rm_app WITH LOGIN PASSWORD '${APP.password}'`);
  // rm_owner is cluster-wide and another file reads its LOGIN attribute, so
  // record it and put back exactly that value (migrate-run.test.ts does the same).
  const [owner] = (await sql`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rm_owner'`) as unknown as {
    rolcanlogin: boolean;
  }[];
  ownerCanLogin = owner?.rolcanlogin ?? null;
  await sql.unsafe(`ALTER ROLE rm_owner PASSWORD '${OWNER.password}'`);
  template = await createSnapshotTemplate("csp");
}, 120_000);

afterAll(async () => {
  await dropDatabases([...created, template].filter(Boolean));
  await sql.unsafe(`ALTER ROLE rm_owner ${ownerCanLogin === false ? "NOLOGIN" : "LOGIN"} PASSWORD NULL`);
});

async function freshCopy(label: string): Promise<string> {
  const name = await copyDatabase(template, label);
  created.push(name);
  return name;
}

/** A refused boot: exit 1, no port bound, never listened, and `check`'s line. */
async function expectRefused(boot: ApiBoot, check: number): Promise<string[]> {
  if (boot.outcome === "served") {
    const lines = startupLines(boot.run);
    await boot.run.stop();
    throw new Error(`the api served instead of refusing check ${check}:\n${lines.join("\n")}`);
  }
  expect(boot.code).toBe(1);
  expect(await portIsBound(boot.port)).toBe(false);
  expect(boot.run.stdout()).not.toContain("api listening");
  const lines = startupLines(boot.run);
  expect(lines).not.toContain("startup_preflight: passed");
  expect(lines.some((line) => line.startsWith(`startup_preflight: refused check ${check}: `))).toBe(true);
  return lines;
}

describe("api startup preflight — checks 1-3 as rm_app, refuse to serve on failure (§7.2)", () => {
  test("CONTROL: an untouched snapshot database passes checks 1-3 and the api serves", async () => {
    const name = await freshCopy("csp_ok");
    const boot = await bootApi(databaseUrl(name, APP));
    try {
      if (boot.outcome !== "served") throw new Error(`api exited ${boot.code}:\n${boot.run.stderr()}`);
      expect(startupLines(boot.run)).toEqual(["startup_preflight: passed"]);
      const health = await fetch(`http://127.0.0.1:${boot.port}/health`);
      expect((await health.json()).db).toBe("up");
    } finally {
      await boot.run.stop();
    }
  }, 120_000);

  test("check 1: a wrong password refuses by check 1 in the real process, binds no port, and never prints the password", async () => {
    const name = await freshCopy("csp_pw");
    const wrong = "definitely-not-rm-apps-password";
    const boot = await bootApi(databaseUrl(name, { name: "rm_app", password: wrong }));
    const lines = await expectRefused(boot, 1);
    expect(lines.join("\n")).toContain("28P01");
    expect(`${boot.run.stdout()}${boot.run.stderr()}`).not.toContain(wrong);
  }, 120_000);

  test("check 1: another role's credential is refused by name — the api never runs on a fallback login", async () => {
    // The harness superuser's own URL: it authenticates, and it is exactly the
    // "some other credential" §7.2 ends. The refusal names who it logged in as.
    const name = await freshCopy("csp_user");
    const boot = await bootApi(databaseUrl(name));
    const lines = await expectRefused(boot, 1);
    const user = new URL(databaseUrl(name)).username;
    expect(lines).toContain(
      `startup_preflight: refused check 1: this process logs in as "${user}", not rm_app: a container runs on ` +
        "its own role's credential and never falls back to another (§7.2)",
    );
  }, 120_000);

  test("check 1: an unreachable database is refused, not served", async () => {
    const boot = await bootApi(`postgres://rm_app:${APP.password}@127.0.0.1:1/unused`, {
      PG_NAMESPACE_GUARD_TIMEOUT_MS: "1000",
    });
    const lines = await expectRefused(boot, 1);
    expect(lines.join("\n")).toContain("the database cannot be queried as rm_app");
  }, 120_000);

  // The counter row's name is held in a constant: the repo-wide grant-only
  // scanner (append-only-no-new-deletes.test.ts) reads the refusal TEXT
  // "DELETE/TRUNCATE on <table>" as a removal statement. Nothing here removes a row.
  const COUNTER_ROW = "swarm_stream_head";

  test("check 2: a runtime DELETE grant on the stream counter row refuses by check 2, naming the table", async () => {
    const name = await freshCopy("csp_grant");
    const admin = connectAdmin(name);
    try {
      await admin.unsafe(`GRANT DELETE ON ${COUNTER_ROW} TO rm_app`);
    } finally {
      await admin.end({ timeout: 5 });
    }
    const lines = await expectRefused(await bootApi(databaseUrl(name, APP)), 2);
    expect(lines.filter((line) => line.startsWith("startup_preflight: refused check 2: "))).toEqual([
      `startup_preflight: refused check 2: rm_app holds DELETE/TRUNCATE on ${COUNTER_ROW}, which D53 (2) keeps ` +
        "revoked from the runtime roles: it is swarm_stream_events' counter row, and a runtime role that removed it " +
        "would stop every transition that writes an event",
    ]);
  }, 120_000);

  test("check 3: a dropped declared column refuses by check 3, naming the column", async () => {
    const name = await freshCopy("csp_drift");
    const admin = connectAdmin(name);
    try {
      await admin.unsafe("ALTER TABLE job_schedules DROP COLUMN last_enqueued_at");
    } finally {
      await admin.end({ timeout: 5 });
    }
    const lines = await expectRefused(await bootApi(databaseUrl(name, APP)), 3);
    expect(lines).toContain(
      "startup_preflight: refused check 3: column public.job_schedules.last_enqueued_at is declared by the " +
        "installed manifest but absent from the live catalog",
    );
  }, 120_000);

  test("RM_ENV=prod refuses exactly as stage does", async () => {
    const name = await freshCopy("csp_prod");
    const boot = await bootApi(databaseUrl(name, { name: "rm_app", password: "wrong-under-prod" }), { RM_ENV: "prod" });
    await expectRefused(boot, 1);
  }, 120_000);

  test("PINNED EXCEPTION: RM_ENV=ephemeral (the in-process harness's env) logs the same refusal and serves", async () => {
    // The only env that serves past a refusal, because the harness spawns this
    // entrypoint against superuser-built databases for tests about other
    // things. The line still says what refused, and says why it served.
    const name = await freshCopy("csp_eph");
    const boot = await bootApi(databaseUrl(name, { name: "rm_app", password: "wrong-under-ephemeral" }), {
      RM_ENV: "ephemeral",
    });
    try {
      if (boot.outcome !== "served") throw new Error(`api exited ${boot.code}:\n${boot.run.stderr()}`);
      const lines = startupLines(boot.run);
      expect(lines.some((line) => line.startsWith("startup_preflight: refused check 1: "))).toBe(true);
      expect(lines).toContain(
        "startup_preflight: serving anyway: RM_ENV=ephemeral is the test harness's env, never a stack's",
      );
    } finally {
      await boot.run.stop();
    }
  }, 120_000);
});

// ───────────────────────────────────────────────────────────────────────────
// Criterion 61: a REAL interruption between two commits, then a real boot
// ───────────────────────────────────────────────────────────────────────────

const ADDITIVE = "-- compat: additive\n-- metadata_version: 1\n--\n";

/** The real migrations plus the planted ones, so the REAL apply loop meets them. */
function migrationsWith(planted: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-csp-migrations-"));
  const real = join(BACKEND_DIR, "migrations");
  for (const file of readdirSync(real)) {
    if (file.endsWith(".sql")) symlinkSync(join(real, file), join(dir, file));
  }
  for (const [file, text] of Object.entries(planted)) writeFileSync(join(dir, file), text, "utf8");
  return dir;
}

describe("criterion 61 — a failure between two commits, injected as a real interruption, and the api refuses the in-progress state", () => {
  test("runMigrate killed after one commit leaves the ledger ahead of the manifest; the real api then refuses check 3 and serves nothing", async () => {
    const name = await freshCopy("csp_interrupted");
    const dir = migrationsWith({
      "0998_csp_interrupt_a.sql": `${ADDITIVE}CREATE TABLE rm_csp_interrupt_a (id integer);\n`,
      "0999_csp_interrupt_b.sql": `${ADDITIVE}CREATE TABLE rm_csp_interrupt_b (id integer);\n`,
    });
    const owner = postgres(databaseUrl(name, OWNER), { max: 1, onnotice: () => {} });
    const admin = connectAdmin(name);
    try {
      // The interruption: the REAL run, as rm_owner, under the real target
      // lock, stopped by a throw after 0998 COMMITTED and before 0999 began —
      // where a killed process stops. Nothing below writes a state by hand.
      const killed = new Error("injected: the migrate process died after 0998 committed");
      await expect(
        withTargetLock(databaseUrl(name), (lock) =>
          runMigrate(
            owner,
            { caller: "smoke_flag", env: "stage", connection: "local", nonInteractive: true, lock },
            {
              migrationsDir: dir,
              afterCommit: (file) => {
                if (file === "0998_csp_interrupt_a.sql") throw killed;
              },
            },
          ),
        ),
      ).rejects.toThrow(killed.message);
      const state = await detectManifestState(admin);
      expect(state.kind).toBe("in_progress");
      if (state.kind === "in_progress") expect(state.ahead).toEqual(["0998_csp_interrupt_a.sql"]);
    } finally {
      await owner.end({ timeout: 5 });
      await admin.end({ timeout: 5 });
      rmSync(dir, { recursive: true, force: true });
    }

    // The boot: the real api, as rm_app, against that same database.
    const lines = await expectRefused(await bootApi(databaseUrl(name, APP)), 3);
    const inProgress = lines.filter((line) => line.includes("the database is in progress"));
    expect(inProgress).toEqual([
      "startup_preflight: refused check 3: the database is in progress — the ledger records 1 migration(s) the " +
        "manifest does not embody (0998_csp_interrupt_a.sql); nothing has verified where the schema got to",
    ]);
  }, 180_000);
});
