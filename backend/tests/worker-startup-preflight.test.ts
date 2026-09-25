// The pipeline worker runs preflight checks 1-3 at startup as rm_worker and
// claims no job on failure (smoke-production-spec.md §7.2; #1026 criterion
// 120, and the startup signal criterion 41's readiness reads).
//
// WHAT RUNS. The real entrypoint — `bun run src/worker/index.ts`, the compose
// worker command — as a real process, logged in as rm_worker over a real
// password, against its own copy of a database bootstrapped from
// backend/schema/ by rm_owner (tests/support/startup-preflight.ts). Every copy
// holds one pending `noop` job the worker's lane may claim, and nothing else
// claimable (the bootstrap's schedule rows are disabled on the copy, so the
// scheduler tick enqueues nothing that would reach the network).
//
// GRADED ON THE DATABASE AND THE DISK, not on a log alone: after a refusal the
// job is still `pending` with zero attempts and no owner, no `job_runs` row
// exists, and no heartbeat file was written — a refused worker never reports
// itself alive. The control boots the same entrypoint against an untouched copy
// and sees it log `startup_preflight: passed`, write its heartbeat and run the
// job, so "zero claimed" below is owed to the refusal and not to a worker that
// could not have claimed anything anyway.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import {
  connectAdmin,
  copyDatabase,
  createSnapshotTemplate,
  databaseUrl,
  dropDatabases,
  spawnEntrypoint,
  startupLines,
  type Spawned,
} from "./support/startup-preflight.ts";

const WORKER = { name: "rm_worker", password: `rm_worker_startup_${crypto.randomUUID().slice(0, 8)}` };

let template = "";
const created: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), "rm-worker-startup-"));

beforeAll(async () => {
  await sql.unsafe(`ALTER ROLE rm_worker WITH LOGIN PASSWORD '${WORKER.password}'`);
  template = await createSnapshotTemplate("wsp");
}, 120_000);

afterAll(async () => {
  await dropDatabases([...created, template].filter(Boolean));
  rmSync(scratch, { recursive: true, force: true });
});

interface Fixture {
  readonly name: string;
  readonly jobId: string;
}

/** A copy of the snapshot database with its schedules disabled and exactly one
 *  pending `noop` job, after `plant` has had its say (as the superuser). */
async function fixture(label: string, plant: (admin: ReturnType<typeof connectAdmin>) => Promise<void> = async () => {}): Promise<Fixture> {
  const name = await copyDatabase(template, label);
  created.push(name);
  const admin = connectAdmin(name);
  try {
    await admin`UPDATE job_schedules SET enabled = false`;
    expect(((await admin`SELECT count(*)::int AS n FROM jobs`) as unknown as { n: number }[])[0]!.n).toBe(0);
    const [job] = (await admin`
      INSERT INTO jobs (kind, payload, run_after) VALUES ('noop', '{"probe": "worker-startup"}', now() - interval '1 minute')
      RETURNING id::text AS id`) as unknown as { id: string }[];
    await plant(admin);
    return { name, jobId: job!.id };
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** The job's queue state and the run rows it has, read as the superuser. */
async function jobState(fx: Fixture): Promise<{ status: string; attempts: number; lockedBy: string | null; runs: number }> {
  const admin = connectAdmin(fx.name);
  try {
    const [row] = (await admin`
      SELECT status, attempts, locked_by AS "lockedBy",
             (SELECT count(*)::int FROM job_runs WHERE job_id = ${fx.jobId}) AS runs
      FROM jobs WHERE id = ${fx.jobId}`) as unknown as { status: string; attempts: number; lockedBy: string | null; runs: number }[];
    return row!;
  } finally {
    await admin.end({ timeout: 5 });
  }
}

function spawnWorker(label: string, url: string | undefined, extra: Record<string, string> = {}): { run: Spawned; heartbeat: string } {
  const heartbeat = join(scratch, `${label}.heartbeat`);
  const env: Record<string, string | undefined> = {
    ...process.env,
    RM_ENV: "stage",
    WORKER_LANE: "generic",
    WORKER_ID: `startup-${label}`,
    WORKER_IDLE_POLL_MS: "200",
    WORKER_SHUTDOWN_TIMEOUT_MS: "5000",
    HEARTBEAT_FILE: heartbeat,
    SCHEDULER_HEARTBEAT_FILE: `${heartbeat}.scheduler`,
    // The compose worker env hands BOTH pools the worker credential
    // (docker-compose.yml x-worker-env); config.ts requires DATABASE_URL.
    DATABASE_URL: url ?? databaseUrl("postgres"),
    WORKER_DATABASE_URL: url,
    ...extra,
  };
  if (url === undefined) delete env.WORKER_DATABASE_URL;
  return { run: spawnEntrypoint("src/worker/index.ts", env), heartbeat };
}

/** Wait for the process to exit, bounded, and return its code. */
async function exitCode(run: Spawned, timeoutMs = 60_000): Promise<number> {
  const code = await Promise.race([run.proc.exited, Bun.sleep(timeoutMs).then(() => null)]);
  await run.stop();
  if (code === null) throw new Error(`worker did not exit within ${timeoutMs}ms:\n${run.stdout()}\n${run.stderr()}`);
  return code;
}

/** A refused start: exit 1, `check`'s line, no heartbeat, and the job untouched. */
async function expectRefusedAndUnclaimed(fx: Fixture, spawned: { run: Spawned; heartbeat: string }, check: number): Promise<string[]> {
  expect(await exitCode(spawned.run)).toBe(1);
  const lines = startupLines(spawned.run);
  expect(lines).not.toContain("startup_preflight: passed");
  expect(lines.some((line) => line.startsWith(`startup_preflight: refused check ${check}: `))).toBe(true);
  expect(spawned.run.stdout()).not.toContain("starting (lane=");
  expect(existsSync(spawned.heartbeat)).toBe(false);
  expect(existsSync(`${spawned.heartbeat}.scheduler`)).toBe(false);
  expect(await jobState(fx)).toEqual({ status: "pending", attempts: 0, lockedBy: null, runs: 0 });
  return lines;
}

describe("pipeline worker startup preflight — checks 1-3 as rm_worker, no claim on failure (§7.2)", () => {
  test("CONTROL: an untouched snapshot database passes, the worker logs `startup_preflight: passed`, beats, and runs the job", async () => {
    const fx = await fixture("wsp_ok");
    const spawned = spawnWorker("ok", databaseUrl(fx.name, WORKER));
    try {
      const deadline = Date.now() + 60_000;
      let state = await jobState(fx);
      while (state.status !== "succeeded") {
        if (spawned.run.proc.exitCode !== null) {
          throw new Error(`worker exited ${spawned.run.proc.exitCode}:\n${spawned.run.stdout()}\n${spawned.run.stderr()}`);
        }
        if (Date.now() > deadline) throw new Error(`job never ran: ${JSON.stringify(state)}\n${spawned.run.stderr()}`);
        await Bun.sleep(200);
        state = await jobState(fx);
      }
      expect(state.lockedBy === null || state.lockedBy === "startup-ok").toBe(true);
      expect(state.runs).toBe(1);
      expect(startupLines(spawned.run)).toEqual(["startup_preflight: passed"]);
      expect(existsSync(spawned.heartbeat)).toBe(true);
    } finally {
      await spawned.run.stop();
    }
  }, 120_000);

  test("check 1: a wrong password refuses by check 1, claims nothing, writes no heartbeat", async () => {
    const fx = await fixture("wsp_pw");
    const spawned = spawnWorker("pw", databaseUrl(fx.name, { name: "rm_worker", password: "not-rm-workers-password" }));
    const lines = await expectRefusedAndUnclaimed(fx, spawned, 1);
    expect(lines.join("\n")).toContain("28P01");
    expect(`${spawned.run.stdout()}${spawned.run.stderr()}`).not.toContain("not-rm-workers-password");
  }, 120_000);

  test("check 1: the api's rm_app credential is refused by name — the worker never runs on another role's login", async () => {
    const fx = await fixture("wsp_user");
    const appPassword = `rm_app_wsp_${crypto.randomUUID().slice(0, 8)}`;
    await sql.unsafe(`ALTER ROLE rm_app WITH LOGIN PASSWORD '${appPassword}'`);
    const spawned = spawnWorker("user", databaseUrl(fx.name, { name: "rm_app", password: appPassword }));
    const lines = await expectRefusedAndUnclaimed(fx, spawned, 1);
    expect(lines).toContain(
      'startup_preflight: refused check 1: this process logs in as "rm_app", not rm_worker: a container runs on ' +
        "its own role's credential and never falls back to another (§7.2)",
    );
  }, 120_000);

  // The counter row's name is held in a constant: the repo-wide grant-only
  // scanner (append-only-no-new-deletes.test.ts) reads the refusal TEXT
  // "DELETE/TRUNCATE on <table>" as a removal statement. Nothing here removes a row.
  const COUNTER_ROW = "swarm_stream_head";

  test("check 2: a TRUNCATE privilege on the stream counter row refuses by check 2, claims nothing", async () => {
    const fx = await fixture("wsp_grant", (admin) => admin.unsafe(`GRANT TRUNCATE ON ${COUNTER_ROW} TO rm_worker`).then(() => {}));
    const lines = await expectRefusedAndUnclaimed(fx, spawnWorker("grant", databaseUrl(fx.name, WORKER)), 2);
    expect(lines.filter((line) => line.startsWith("startup_preflight: refused check 2: "))).toEqual([
      `startup_preflight: refused check 2: rm_worker holds DELETE/TRUNCATE on ${COUNTER_ROW}, which D53 (2) ` +
        "keeps revoked from the runtime roles: it is swarm_stream_events' counter row, and a runtime role that " +
        "removed it would stop every transition that writes an event",
    ]);
  }, 120_000);

  test("check 3: a dropped declared column refuses by check 3, claims nothing", async () => {
    const fx = await fixture("wsp_drift", (admin) => admin.unsafe("ALTER TABLE job_schedules DROP COLUMN last_enqueued_at").then(() => {}));
    const lines = await expectRefusedAndUnclaimed(fx, spawnWorker("drift", databaseUrl(fx.name, WORKER)), 3);
    expect(lines).toContain(
      "startup_preflight: refused check 3: column public.job_schedules.last_enqueued_at is declared by the " +
        "installed manifest but absent from the live catalog",
    );
  }, 120_000);

  test("no WORKER_DATABASE_URL: the worker refuses by check 1 with the readiness signal and never falls back to DATABASE_URL", async () => {
    // DATABASE_URL here is a WORKING login to the fixture — the harness
    // superuser's. The old fallback would have claimed the job on it.
    const fx = await fixture("wsp_nourl");
    const spawned = spawnWorker("nourl", undefined, { DATABASE_URL: databaseUrl(fx.name) });
    const code = await exitCode(spawned.run);
    expect(code).toBe(1);
    // The exact signal readiness reads (criterion 41), not merely a non-zero
    // exit: an uncaught import-time throw also exits non-zero, with no line.
    expect(spawned.run.stderr().split("\n").filter((line) => line.startsWith("startup_preflight: "))).toEqual([
      "startup_preflight: refused check 1: this process was started with no rm_worker connection string: it holds " +
        "no credential of its own, and a container never falls back to another role's (§7.2)",
    ]);
    expect(existsSync(spawned.heartbeat)).toBe(false);
    expect(await jobState(fx)).toEqual({ status: "pending", attempts: 0, lockedBy: null, runs: 0 });
  }, 120_000);
});
