// `bun run prune` is the one pruning path — issue #1026 criteria 177 and 104,
// decision D55 (12), smoke-production-spec.md §2 and §3.
//
// D55 (12): "It takes a typed `rm_owner` password, runs fenced under the target
// lock (smoke spec §2), and writes a receipt ... Its retention window is a
// minimum of 7 days ... the command never removes a row younger than it. The
// command lists exactly the tables it may prune ... It never prunes a security
// tombstone or audit history."
//
// THE COMMAND IS RUN AS A PROCESS wherever the claim is about the command: the
// window refusal, the refusal without a terminal, and — under a real
// pseudo-terminal (`script`), so `process.stdin.isTTY` is true and the real
// masked prompt runs — the wrong password, the missing `y` and the whole
// successful run with its receipt and journal. The lock case drives
// `pruneCommand` in this process, because it has to hold the competing lock
// itself and watch the prune wait behind it.
//
// THE DATABASE is this file's own (useCleanDatabase), enrolled `rehearsal` by
// rm_owner and run under RM_ENV=stage, with `$HOME/.env` holding only the
// connection and an rm_readonly password, as §3 says a host's does. The rows
// planted, by age:
//   events      8 days old (pruned), 6 days old and new (kept);
//   sessions    expired 10 days ago and never revoked (pruned); expired 10
//               days ago but REVOKED (a tombstone, kept); expired 2 days ago
//               (inside the window, kept); live (kept);
//   passkeys    revoked 30 days ago (a tombstone; not a prune target, kept);
//   audit_log   every row (history; not a prune target, kept).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { hashKey } from "../src/lib/keys.ts";
import * as domain from "../src/swarm/domain.ts";
import {
  PRUNE_TARGETS,
  PruneJournal,
  PruneRefused,
  pruneCommand,
  pruneJournalPath,
  type PruneJournalFile,
  type PruneReceipt,
} from "../scripts/prune.ts";
import { adminConnection, ROLE_PASSWORD } from "./support/cluster.ts";
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

/** `$HOME` for one operator run: a `.env` with the connection and rm_readonly only. */
function operatorHome(): string {
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
      "",
    ].join("\n"),
    "utf8",
  );
  return home;
}

/** The command with no terminal: stdin ignored. */
async function runCommand(args: readonly string[]): Promise<{ code: number; out: string; home: string }> {
  const home = operatorHome();
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

/** The command under a real pseudo-terminal, typing `steps` as their prompts appear. */
async function runAtTerminal(
  args: readonly string[],
  steps: readonly { await: string; send: string }[],
): Promise<{ code: number; screen: string; home: string }> {
  const home = operatorHome();
  const child = Bun.spawn(["script", "-qefc", ["bun", "scripts/prune.ts", ...args].join(" "), "/dev/null"], {
    cwd: BACKEND,
    env: { PATH: process.env.PATH ?? "", HOME: home, RM_ENV: "stage", TERM: "dumb" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let screen = "";
  const decoder = new TextDecoder();
  const pump = (async () => {
    for await (const chunk of child.stdout) screen += decoder.decode(chunk);
  })();
  const deadline = Date.now() + 60_000;
  try {
    let from = 0;
    for (const step of steps) {
      let at = screen.indexOf(step.await, from);
      while (at < 0 && child.exitCode === null) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for "${step.await}"; terminal so far:\n${screen}`);
        await Bun.sleep(25);
        at = screen.indexOf(step.await, from);
      }
      if (at < 0) break;
      from = at + step.await.length;
      child.stdin.write(`${step.send}\r`);
      await child.stdin.flush();
    }
    const code = await child.exited;
    await pump;
    return { code, screen, home };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    try {
      child.stdin.end();
    } catch {
      // already closed with the process
    }
  }
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
}

async function state(): Promise<State> {
  const eventSeqs = ((await sql`SELECT seq::int AS seq FROM swarm_stream_events ORDER BY seq`) as unknown as { seq: number }[]).map(
    (r) => r.seq,
  );
  const sessions = ((await sql`SELECT token FROM admin_session ORDER BY token`) as unknown as { token: string }[]).map((r) => r.token);
  const passkeys = ((await sql`SELECT id FROM admin_passkey ORDER BY id`) as unknown as { id: string }[]).map((r) => r.id);
  const [{ n }] = (await sql`SELECT count(*)::int AS n FROM audit_log`) as unknown as { n: number }[];
  return { eventSeqs, sessions, passkeys, auditRows: n };
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
  test("prunes exactly the event log and expired, never-revoked sessions — nothing else", () => {
    expect(PRUNE_TARGETS.map((t) => [t.table, t.predicate])).toEqual([
      ["swarm_stream_events", "committed_at < <cutoff>"],
      ["admin_session", "revoked_at IS NULL AND expires_at < <cutoff>"],
    ]);
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

  test("with no terminal it refuses rather than read an owner password from anywhere, and journals the owner phase", async () => {
    const before = await state();
    const receiptDir = tmp("receipt");
    const { code, out } = await runCommand(["--receipt", join(receiptDir, "receipt.json")]);
    expect(code).toBe(1);
    expect(out).toContain("non-interactive (stdin is not a terminal)");
    expect(out).not.toContain("password (not echoed");
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

  test("a mistyped rm_owner password refuses before the y is asked for", async () => {
    const before = await state();
    const receiptDir = tmp("receipt");
    const run = await runAtTerminal(
      ["--receipt", join(receiptDir, "receipt.json")],
      [{ await: "rm_owner password (not echoed", send: "not-the-owner-password" }],
    );
    expect(run.code).toBe(1);
    expect(run.screen).toContain("the rm_owner credential was not accepted");
    expect(run.screen).not.toContain("type y to continue");
    expect(await state()).toEqual(before);
  }, 60_000);

  test("anything but an explicit y refuses: `yes` is not `y`", async () => {
    const before = await state();
    const receiptDir = tmp("receipt");
    const run = await runAtTerminal(
      ["--receipt", join(receiptDir, "receipt.json")],
      [
        { await: "rm_owner password (not echoed", send: OWNER_PASSWORD },
        { await: "type y to continue", send: "yes" },
      ],
    );
    expect(run.code).toBe(1);
    expect(run.screen).toContain("was not confirmed (an explicit y is required)");
    expect(await state()).toEqual(before);
    expect(readdirSync(receiptDir).filter((f) => f.startsWith("receipt"))).toEqual([]);
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
        terminal: { interactive: true, ownerPassword: async () => OWNER_PASSWORD, answer: async () => "y" },
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
      terminal: { interactive: true, ownerPassword: async () => OWNER_PASSWORD, answer: async () => "y" },
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
    ]);
  }, 60_000);
});

describe("the run: typed rm_owner, y, fenced prune, receipt", () => {
  test("prunes only rows older than the window, never a tombstone or audit history, and writes the receipt and journal", async () => {
    const before = await state();
    const receiptDir = tmp("receipt");
    const receiptPath = join(receiptDir, "receipt.json");
    const run = await runAtTerminal(
      ["--receipt", receiptPath],
      [
        { await: "rm_owner password (not echoed", send: OWNER_PASSWORD },
        { await: "type y to continue", send: "y" },
      ],
    );
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

    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as PruneReceipt;
    expect({ kind: receipt.kind, env: receipt.env, windowDays: receipt.windowDays }).toEqual({
      kind: "prune-receipt",
      env: "stage",
      windowDays: 7,
    });
    expect(receipt.targetLock).toContain("prune");
    expect(receipt.tables.map((t) => ({ table: t.table, predicate: t.predicate, windowDays: t.windowDays, rows: t.rows }))).toEqual([
      { table: "swarm_stream_events", predicate: "committed_at < <cutoff>", windowDays: 7, rows: events.old.length },
      { table: "admin_session", predicate: "revoked_at IS NULL AND expires_at < <cutoff>", windowDays: 7, rows: 1 },
    ]);
    // The cutoff is the database's now() minus 7 days, the same for both.
    const cutoff = Date.parse(receipt.tables[0]!.cutoff);
    expect(Math.abs(Date.now() - 7 * 86_400_000 - cutoff)).toBeLessThan(120_000);
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
      try {
        expect(readFileSync(path, "utf8")).not.toContain(OWNER_PASSWORD);
      } catch (error) {
        if ((error as { code?: string }).code !== "EISDIR") throw error;
      }
    }
    expect(readFileSync(receiptPath, "utf8")).not.toContain(OWNER_PASSWORD);
  }, 90_000);
});
