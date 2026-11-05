// `bun run prune` is the one pruning path — issue #1026 criteria 177 and 104,
// decision D55 (12), smoke-production-spec.md §2 and §3.
//
// D55 (12): "It takes a typed `rm_owner` password, runs fenced under the target
// lock (smoke spec §2), and writes a receipt ... Its retention window is a
// minimum of 7 days ... the command never removes a row younger than it. The
// command lists exactly the tables it may prune ... It never prunes a security
// tombstone or audit history."
//
// D61 moved the typed password into `~/.env`'s `rm_owner` line and the `y`
// into `--confirm-target <host:port/database>`. Nothing prompts.
//
// THE COMMAND IS RUN AS A PROCESS wherever the claim is about the command, with
// stdin closed: the window refusal, the missing `rm_owner` line, the wrong
// password, the missing and the wrong `--confirm-target`, and the whole
// successful run with its receipt and journal. The lock case drives
// `pruneCommand` in this process, because it has to hold the competing lock
// itself and watch the prune wait behind it.
//
// THE DATABASE is this file's own (useCleanDatabase), enrolled `rehearsal` by
// rm_owner and run under RM_ENV=stage, with `$HOME/.env` holding the
// connection, an rm_readonly password and (per test) an rm_owner line. The rows
// planted, by age:
//   events      8 days old (pruned), 6 days old and new (kept);
//   sessions    expired 10 days ago and never revoked (pruned); expired 10
//               days ago but REVOKED (a tombstone, kept); expired 2 days ago
//               (inside the window, kept); live (kept);
//   passkeys    revoked 30 days ago (a tombstone; not a prune target, kept);
//   audit_log   every row (history; not a prune target, kept);
//   jobs        (issue 1581) 10,001 succeeded and one cancelled 31 days old
//               (pruned, in chunks of 5,000); one succeeded 29 days old (kept);
//               dead and failed 91 days old (pruned) and 89 days old (kept);
//               an old succeeded job audit_log names, one analytics_runs names
//               and one swarm_session_events names (kept, provenance intact);
//               pending and running rows of any age (kept).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { hashKey } from "../src/lib/keys.ts";
import * as domain from "../src/swarm/domain.ts";
import {
  JOBS_PRUNE_CHUNK,
  PRUNE_TARGETS,
  PruneJournal,
  PruneRefused,
  pruneCommand,
  pruneJournalPath,
  type PruneJournalFile,
  type PruneReceipt,
} from "../scripts/prune.ts";
import { adminConnection, ROLE_PASSWORD, restoreRoleBaselineAfterAll } from "./support/cluster.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject } from "./support/epoch-fixtures.ts";
import { holdTargetLock } from "./support/target-lock.ts";

useCleanDatabase(import.meta.file);

const BACKEND = join(import.meta.dir, "..");
const OWNER_PASSWORD = ROLE_PASSWORD();
const READONLY_PASSWORD = randomBytes(12).toString("hex");

let database = "";
const dirs: string[] = [];

const tmp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `rm-prune-${label}-`));
  dirs.push(dir);
  return dir;
};

function readerUrl(): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${database}`;
  url.username = "rm_readonly";
  url.password = READONLY_PASSWORD;
  return url.toString();
}

/** The `host:port/database` the command resolves from {@link operatorHome}'s file. */
function target(): string {
  const url = new URL(process.env.DATABASE_URL!);
  return `${url.hostname}:${url.port || "5432"}/${database}`;
}

/** `$HOME` for one operator run: a `.env` with the connection, rm_readonly and, unless `null`, an rm_owner line. */
function operatorHome(ownerLine: string | null): string {
  const home = tmp("home");
  const url = new URL(process.env.DATABASE_URL!);
  writeFileSync(
    join(home, ".env"),
    [
      `host = ${url.hostname}`,
      `port = ${url.port || "5432"}`,
      `database = ${database}`,
      "sslmode = disable",
      `rm_readonly = ${READONLY_PASSWORD}`,
      ...(ownerLine === null ? [] : [`rm_owner = ${ownerLine}`]),
      "",
    ].join("\n"),
    "utf8",
  );
  return home;
}

/** The command with no terminal: stdin ignored. `owner` is the rm_owner line's value, or `null` for no line. */
async function runCommand(
  args: readonly string[],
  owner: string | null = OWNER_PASSWORD,
): Promise<{ code: number; out: string; home: string }> {
  const home = operatorHome(owner);
  // The password is never an argument (D61).
  if (owner !== null && args.join(" ").includes(owner)) throw new Error("a password reached argv");
  const child = Bun.spawn(["bun", "scripts/prune.ts", ...args], {
    cwd: BACKEND,
    env: { PATH: process.env.PATH ?? "", HOME: home, RM_ENV: "stage" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out: stdout + stderr, home };
}

// ── the planted rows ────────────────────────────────────────────────────────

const SESSIONS = {
  oldUnrevoked: `prune-old-unrevoked-${randomBytes(4).toString("hex")}`,
  oldRevoked: `prune-old-revoked-${randomBytes(4).toString("hex")}`,
  recentExpired: `prune-recent-expired-${randomBytes(4).toString("hex")}`,
  live: `prune-live-${randomBytes(4).toString("hex")}`,
};
const REVOKED_PASSKEY = `prune-revoked-passkey-${randomBytes(4).toString("hex")}`;
let events = { old: [] as number[], recent: 0, fresh: 0 };

interface State {
  readonly eventSeqs: number[];
  readonly sessions: string[];
  readonly passkeys: string[];
  readonly auditRows: number;
  readonly jobs: string[];
}

async function state(): Promise<State> {
  const eventSeqs = ((await sql`SELECT seq::int AS seq FROM swarm_stream_events ORDER BY seq`) as unknown as { seq: number }[]).map(
    (r) => r.seq,
  );
  const sessions = ((await sql`SELECT token FROM admin_session ORDER BY token`) as unknown as { token: string }[]).map((r) => r.token);
  const passkeys = ((await sql`SELECT id FROM admin_passkey ORDER BY id`) as unknown as { id: string }[]).map((r) => r.id);
  const [{ n }] = (await sql`SELECT count(*)::int AS n FROM audit_log`) as unknown as { n: number }[];
  // The planted jobs by label; the bulk rows by count (they are 10,001 of one label).
  const jobs = ((await sql`
    SELECT payload->>'plant' AS label, count(*)::int AS n FROM jobs WHERE payload ? 'plant' GROUP BY 1 ORDER BY 1`) as unknown as {
    label: string;
    n: number;
  }[]).map((r) => `${r.label}:${r.n}`).sort();
  return { eventSeqs, sessions, passkeys, auditRows: n, jobs };
}

beforeAll(async () => {
  [{ database }] = (await sql`SELECT current_database() AS database`) as unknown as { database: string }[];
  // rm_readonly's password is this file's own, so the assertion that the OWNER's
  // typed password reached no file can tell it from the read-only line the
  // host's ~/.env carries. rm_readonly is no pool's login, so changing it is
  // safe; it is put back below. (The cluster admin: a role's password is
  // cluster state.)
  const cluster = adminConnection();
  try {
    await cluster.unsafe(`ALTER ROLE rm_readonly LOGIN PASSWORD '${READONLY_PASSWORD}'`);
  } finally {
    await cluster.end({ timeout: 5 });
  }
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx.unsafe("INSERT INTO deployment_identity (kind) VALUES ('rehearsal')");
  });

  // Events: real transitions, then aged by rm_owner.
  const subjectId = await activeSubject("prune_cmd", 600);
  const opened = await domain.openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  let open = opened.sessionId;
  for (let i = 0; i < 3; i++) {
    const t = await domain.turnOverEpoch(subjectId, open);
    if (!t.ok) throw new Error("turnOverEpoch failed");
    // The epoch stream's turnover opens no successor on a subject that stops
    // (openedSessionId null); this active subject must open one every time.
    if (t.openedSessionId === null) throw new Error("turnOverEpoch opened no successor");
    open = t.openedSessionId;
  }
  const head = await domain.streamHeadSequence();
  const all = ((await sql`SELECT seq::int AS seq FROM swarm_stream_events ORDER BY seq`) as unknown as { seq: number }[]).map((r) => r.seq);
  events = { old: all.filter((s) => s <= head - 2), recent: head - 1, fresh: head };
  expect(events.old.length).toBeGreaterThan(0);
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx`UPDATE swarm_stream_events SET committed_at = now() - interval '8 days' WHERE seq <= ${head - 2}`;
    await tx`UPDATE swarm_stream_events SET committed_at = now() - interval '6 days' WHERE seq = ${head - 1}`;
  });

  // Sessions and a revoked passkey, as the admin routes leave them.
  await sql`
    INSERT INTO admin_session (token, created_at, expires_at, revoked_at) VALUES
      (${hashKey(SESSIONS.oldUnrevoked)},  now() - interval '11 days', now() - interval '10 days', NULL),
      (${hashKey(SESSIONS.oldRevoked)},    now() - interval '11 days', now() - interval '10 days', now() - interval '10 days'),
      (${hashKey(SESSIONS.recentExpired)}, now() - interval '3 days',  now() - interval '2 days',  NULL),
      (${hashKey(SESSIONS.live)},          now(),                      now() + interval '1 day',   NULL)`;
  await sql`
    INSERT INTO admin_passkey (id, public_key, counter, transports, revoked_at)
    VALUES (${REVOKED_PASSKEY}, ${Buffer.from([1])}, 0, '{}', now() - interval '30 days')`;
  await sql`INSERT INTO audit_log (actor, action, scope) VALUES ('admin', 'prune_test_marker', ${sql.json({})})`;

  // Jobs (issue 1581), aged by updated_at, the time a job last changed state.
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    const plant = (label: string, status: string, days: number, count = 1) => tx`
      INSERT INTO jobs (kind, payload, status, locked_at, locked_by, created_at, updated_at)
      SELECT 'prune.test', jsonb_build_object('plant', ${label}::text), ${status},
             CASE WHEN ${status} = 'running' THEN now() END, CASE WHEN ${status} = 'running' THEN 'w-prune' END,
             now() - make_interval(days => ${days}), now() - make_interval(days => ${days})
        FROM generate_series(1, ${count})`;
    await plant("old-succeeded", "succeeded", 31, 2 * JOBS_PRUNE_CHUNK + 1);
    await plant("old-cancelled", "cancelled", 31);
    await plant("recent-succeeded", "succeeded", 29);
    await plant("old-dead", "dead", 91);
    await plant("old-failed", "failed", 91);
    await plant("recent-dead", "dead", 89);
    await plant("recent-failed", "failed", 89);
    await plant("old-pending", "pending", 400);
    await plant("old-running", "running", 400);
    for (const label of ["audited", "analysed", "evented"]) await plant(label, "succeeded", 400);
    await tx`INSERT INTO audit_log (actor, action, scope, job_id)
             SELECT 'admin', 'prune_test_job', '{}'::jsonb, id FROM jobs WHERE payload->>'plant' = 'audited'`;
    await tx`INSERT INTO analytics_runs (job_id, job_kind, attempt, asof, source_mode, created_by)
             SELECT id, 'prune.test', 1, CURRENT_DATE, 'hermetic', 'prune-test' FROM jobs WHERE payload->>'plant' = 'analysed'`;
    await tx`INSERT INTO swarm_session_events (to_state, action, actor, job_id)
             SELECT 'collecting', 'prune_test', 'system', id FROM jobs WHERE payload->>'plant' = 'evented'`;
  });
}, 120_000);

afterAll(async () => {
  const cluster = adminConnection();
  try {
    await cluster.unsafe(`ALTER ROLE rm_readonly LOGIN PASSWORD '${ROLE_PASSWORD()}'`);
  } finally {
    await cluster.end({ timeout: 5 });
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the closed list (D55 (12))", () => {
  test("prunes exactly the event log, expired never-revoked sessions and old finished jobs — nothing else", () => {
    expect(PRUNE_TARGETS.map((t) => [t.table, t.predicate, t.minDays ?? null])).toEqual([
      ["swarm_stream_events", "committed_at < <cutoff>", null],
      ["admin_session", "revoked_at IS NULL AND expires_at < <cutoff>", null],
      [
        "jobs",
        "status IN ('succeeded', 'cancelled') AND updated_at < <cutoff> AND no audit_log, analytics_runs or swarm_session_events row names it",
        30,
      ],
      ["jobs", "status IN ('dead', 'failed') AND updated_at < <cutoff> AND no audit_log, analytics_runs or swarm_session_events row names it", 90],
    ]);
    expect(JOBS_PRUNE_CHUNK).toBe(5000);
  });
});

describe("refusals: nothing is deleted", () => {
  test("a window below 7 days refuses before anything connects; so does a window that is not a whole number", async () => {
    const before = await state();
    for (const [days, text] of [
      ["6", "below the 7-day minimum"],
      ["0", "below the 7-day minimum"],
      ["7.5", "must be a whole number of days"],
      ["seven", "must be a whole number of days"],
    ] as const) {
      const { code, out, home } = await runCommand(["--retention-days", days, "--instance", "rm_prune_test"]);
      expect({ days, code, refused: out.includes(text) }).toEqual({ days, code: 1, refused: true });
      // Refused before the receipt's directory was even chosen: no journal.
      expect(readdirSync(home, { recursive: true }).filter((f) => String(f).includes("prune-journal"))).toEqual([]);
    }
    expect(await state()).toEqual(before);
  });

  test("D61: with no rm_owner line in ~/.env it refuses naming the key and the file, and journals the owner phase", async () => {
    const before = await state();
    const receiptDir = tmp("receipt");
    const { code, out, home } = await runCommand(["--receipt", join(receiptDir, "receipt.json"), "--confirm-target", target()], null);
    expect(code).toBe(1);
    expect(out).toContain(`${join(home, ".env")} has no rm_owner line`);
    expect(await state()).toEqual(before);
    const journals = readdirSync(receiptDir).filter((f) => f.startsWith("prune-journal-"));
    expect(journals.length).toBe(1);
    const journal = JSON.parse(readFileSync(join(receiptDir, journals[0]!), "utf8")) as PruneJournalFile;
    expect({ outcome: journal.outcome, last: journal.phases.at(-1)?.phase, receipt: journal.receipt }).toEqual({
      outcome: "refused",
      last: "owner",
      receipt: null,
    });
    expect(readdirSync(receiptDir).filter((f) => f.startsWith("receipt"))).toEqual([]);
  }, 60_000);

  test("a wrong rm_owner line refuses before the confirmation, and the refusal does not hold it", async () => {
    const before = await state();
    const receiptDir = tmp("receipt");
    const wrong = `not-the-owner-${randomBytes(4).toString("hex")}`;
    const { code, out } = await runCommand(["--receipt", join(receiptDir, "receipt.json"), "--confirm-target", target()], wrong);
    expect(code).toBe(1);
    expect(out).toContain("the rm_owner credential was not accepted");
    expect(out).not.toContain(wrong);
    expect(await state()).toEqual(before);
  }, 60_000);

  test("D61: no --confirm-target refuses, naming the target to confirm, and deletes nothing", async () => {
    const before = await state();
    const receiptDir = tmp("receipt");
    const { code, out } = await runCommand(["--receipt", join(receiptDir, "receipt.json")]);
    expect(code).toBe(1);
    expect(out).toContain(`no --confirm-target was given. Pass --confirm-target ${target()}`);
    expect(await state()).toEqual(before);
    expect(readdirSync(receiptDir).filter((f) => f.startsWith("receipt"))).toEqual([]);
  }, 60_000);

  test("D61: a wrong --confirm-target refuses, prints both, deletes nothing and writes no receipt", async () => {
    const before = await state();
    const receiptDir = tmp("receipt");
    const wrong = target().replace(/\/[^/]*$/, "/robotmoney");
    const { code, out } = await runCommand(["--receipt", join(receiptDir, "receipt.json"), "--confirm-target", wrong]);
    expect(code).toBe(1);
    expect(out).toContain(JSON.stringify(wrong));
    expect(out).toContain(JSON.stringify(target()));
    expect(out).not.toContain(OWNER_PASSWORD);
    expect(await state()).toEqual(before);
    expect(readdirSync(receiptDir).filter((f) => f.startsWith("receipt"))).toEqual([]);
    const [journalName] = readdirSync(receiptDir).filter((f) => f.startsWith("prune-journal-"));
    const journal = JSON.parse(readFileSync(join(receiptDir, journalName!), "utf8")) as PruneJournalFile;
    expect(journal.phases.at(-1)).toMatchObject({ phase: "confirm", status: "refused" });
  }, 60_000);
});

describe("the fence: a competing lock holder blocks the prune", () => {
  test("the prune waits behind another tool's target lock, deletes nothing while it waits, and refuses naming the holder when it times out", async () => {
    const before = await state();
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${database}`;
    const competitor = await holdTargetLock(url.toString(), "competitor");
    try {
      const dir = tmp("lock");
      const startedAt = new Date();
      const journal = PruneJournal.open(pruneJournalPath(dir, startedAt), "stage", startedAt);
      const pending = pruneCommand({
        env: "stage",
        readerUrl: readerUrl(),
        windowDays: 7,
        holder: { tool: "prune", planId: null, instance: null, host: "test-host", pid: process.pid },
        lockTimeoutMs: 3_000,
        receiptPath: join(dir, "receipt.json"),
        journal,
        authority: { ownerPassword: OWNER_PASSWORD, envFile: "/fixture/.env", confirmTarget: "t:1/d", resolvedTarget: "t:1/d" },
        log: () => {},
      });
      // It is queued behind the competitor on its own lock connection.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [row] = (await sql`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name LIKE 'rm-tl:prune|%'`) as unknown as {
          n: number;
        }[];
        if (row!.n > 0) break;
        if (Date.now() > deadline) throw new Error("the prune never queued behind the competitor");
        await Bun.sleep(50);
      }
      expect(await state()).toEqual(before);
      await expect(pending).rejects.toBeInstanceOf(PruneRefused);
      await expect(pending).rejects.toThrow("competitor");
      expect(await state()).toEqual(before);
    } finally {
      await competitor.release();
    }
  }, 60_000);

  test("released, the same prune proceeds: it blocked on the lock, not on anything else", async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${database}`;
    const competitor = await holdTargetLock(url.toString(), "competitor");
    const dir = tmp("lock");
    const startedAt = new Date();
    const journal = PruneJournal.open(pruneJournalPath(dir, startedAt), "stage", startedAt);
    // A window so wide nothing qualifies: this case is about the wait, and the
    // rows are the last case's to prune.
    const pending = pruneCommand({
      env: "stage",
      readerUrl: readerUrl(),
      windowDays: 3650,
      holder: { tool: "prune", planId: null, instance: null, host: "test-host", pid: process.pid },
      lockTimeoutMs: 30_000,
      receiptPath: join(dir, "receipt.json"),
      journal,
      authority: { ownerPassword: OWNER_PASSWORD, envFile: "/fixture/.env", confirmTarget: "t:1/d", resolvedTarget: "t:1/d" },
      log: () => {},
    });
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Bun.sleep(1_000);
    expect(settled).toBe(false);
    await competitor.release();
    const { tables } = await pending;
    expect(tables.map((t) => [t.table, t.rows])).toEqual([
      ["swarm_stream_events", 0],
      ["admin_session", 0],
      ["jobs", 0],
      ["jobs", 0],
    ]);
  }, 60_000);
});

describe("the run: ~/.env's rm_owner, --confirm-target, fenced prune, receipt (D61)", () => {
  test("prunes only rows older than the window, never a tombstone or audit history, and writes the receipt and journal", async () => {
    const before = await state();
    const receiptDir = tmp("receipt");
    const receiptPath = join(receiptDir, "receipt.json");
    const { code, out, home } = await runCommand(["--receipt", receiptPath, "--confirm-target", target()]);
    const run = { code, screen: out, home };
    expect({ code: run.code, tail: run.code === 0 ? "" : run.screen.slice(-2000) }).toEqual({ code: 0, tail: "" });
    expect(run.screen).toContain("swarm_stream_events: committed_at < <cutoff>");
    expect(run.screen).toContain("no security tombstone, no audit history");

    const after = await state();
    // Events: the 8-day-old ones went; the 6-day-old one and the new one stayed.
    expect(after.eventSeqs).toEqual([events.recent, events.fresh]);
    expect(before.eventSeqs).toEqual([...events.old, events.recent, events.fresh]);
    // Sessions: only the expired, never-revoked, older-than-window one went.
    expect(after.sessions).toEqual(
      [hashKey(SESSIONS.oldRevoked), hashKey(SESSIONS.recentExpired), hashKey(SESSIONS.live)].sort(),
    );
    // Tombstones and history, untouched.
    expect(after.passkeys).toEqual(before.passkeys);
    expect(after.passkeys).toContain(REVOKED_PASSKEY);
    expect(after.auditRows).toBe(before.auditRows);
    // The counter row is never pruned.
    expect(await domain.streamHeadSequence()).toBe(events.fresh);
    // Jobs (issue 1581): only finished rows past their floor, and none that
    // history names; every pending and running row stays, whatever its age.
    expect(before.jobs).toEqual([
      "analysed:1", "audited:1", "evented:1", "old-cancelled:1", "old-dead:1", "old-failed:1", "old-pending:1", "old-running:1",
      `old-succeeded:${2 * JOBS_PRUNE_CHUNK + 1}`, "recent-dead:1", "recent-failed:1", "recent-succeeded:1",
    ]);
    expect(after.jobs).toEqual(["analysed:1", "audited:1", "evented:1", "old-pending:1", "old-running:1", "recent-dead:1", "recent-failed:1", "recent-succeeded:1"]);
    // The provenance on the history rows is intact: each still names its job.
    const [links] = (await sql`
      SELECT (SELECT count(*)::int FROM audit_log a JOIN jobs j ON j.id = a.job_id WHERE j.payload->>'plant' = 'audited') AS audit,
             (SELECT count(*)::int FROM analytics_runs r JOIN jobs j ON j.id = r.job_id WHERE j.payload->>'plant' = 'analysed') AS runs,
             (SELECT count(*)::int FROM swarm_session_events e JOIN jobs j ON j.id = e.job_id WHERE j.payload->>'plant' = 'evented') AS events`) as unknown as {
      audit: number; runs: number; events: number;
    }[];
    expect(links).toEqual({ audit: 1, runs: 1, events: 1 });

    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as PruneReceipt;
    expect({ kind: receipt.kind, env: receipt.env, windowDays: receipt.windowDays }).toEqual({
      kind: "prune-receipt",
      env: "stage",
      windowDays: 7,
    });
    expect(receipt.targetLock).toContain("prune");
    expect(receipt.tables.map((t) => ({ table: t.table, windowDays: t.windowDays, rows: t.rows, chunks: t.chunks ?? null }))).toEqual([
      { table: "swarm_stream_events", windowDays: 7, rows: events.old.length, chunks: null },
      { table: "admin_session", windowDays: 7, rows: 1, chunks: null },
      // Bounded chunks: 10,002 rows went as three DELETE statements, none over the chunk size.
      { table: "jobs", windowDays: 30, rows: 2 * JOBS_PRUNE_CHUNK + 2, chunks: [JOBS_PRUNE_CHUNK, JOBS_PRUNE_CHUNK, 2] },
      { table: "jobs", windowDays: 90, rows: 2, chunks: [2] },
    ]);
    expect(receipt.tables.map((t) => t.predicate)).toEqual(PRUNE_TARGETS.map((t) => t.predicate));
    for (const t of receipt.tables) for (const c of t.chunks ?? []) expect(c).toBeLessThanOrEqual(JOBS_PRUNE_CHUNK);
    // The cutoff is the database's now() minus each entry's window.
    receipt.tables.forEach((t) => {
      expect(Math.abs(Date.now() - t.windowDays * 86_400_000 - Date.parse(t.cutoff)), t.table).toBeLessThan(120_000);
    });
    expect(receipt.tables[1]!.cutoff).toBe(receipt.tables[0]!.cutoff);

    // The journal beside it: every phase committed, the receipt named.
    const [journalName] = readdirSync(receiptDir).filter((f) => f.startsWith("prune-journal-"));
    const journal = JSON.parse(readFileSync(join(receiptDir, journalName!), "utf8")) as PruneJournalFile;
    expect({ outcome: journal.outcome, receipt: journal.receipt }).toEqual({ outcome: "succeeded", receipt: receiptPath });
    expect(journal.phases.map((p) => p.phase)).toEqual(["config", "plan", "lock", "gates", "owner", "confirm", "prune", "receipt"]);
    expect(journal.phases.every((p) => p.status === "committed")).toBe(true);

    // The password reached no file and no screen.
    expect(run.screen).not.toContain(OWNER_PASSWORD);
    for (const file of readdirSync(run.home, { recursive: true }) as string[]) {
      const path = join(run.home, file);
      // The ~/.env fixture is the one place the password lives (D61).
      if (path === join(run.home, ".env")) continue;
      try {
        expect(readFileSync(path, "utf8")).not.toContain(OWNER_PASSWORD);
      } catch (error) {
        if ((error as { code?: string }).code !== "EISDIR") throw error;
      }
    }
    expect(readFileSync(receiptPath, "utf8")).not.toContain(OWNER_PASSWORD);
  }, 90_000);
});

// A role's password is cluster state that outlives this file; put the baseline back (tests/support/cluster.ts).
restoreRoleBaselineAfterAll();
