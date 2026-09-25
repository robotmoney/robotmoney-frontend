// THE REAL SCHEDULER AGAINST THE REAL API AND REAL POSTGRES (issue #1026,
// criteria 85, 89, 90, 98 and 100's runtime halves).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §2.2, §3, §3.2, §4.4,
// §4.5, §4.6 and §10.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT RUNS HERE, AND WHY NOTHING IS FAKED
// ─────────────────────────────────────────────────────────────────────────────
//
// Three real processes, wired exactly as a stack wires them, with nothing in
// between:
//
//   * Postgres — a throwaway container of the repo's pinned image, migrated
//     and seeded by the backend's own `migrate()` and `seed()`.
//   * The API — `bun run src/api/index.ts`, the backend image's own CMD, with
//     the database URL in ITS environment only.
//   * `system-scheduler` — `bun scripts/system-scheduler.ts`, the scheduler
//     image's own entrypoint, holding one credential: an automation token file.
//     Its environment carries no database URL at all (§7).
//
// The scheduler's token is provisioned BY HAND into the API's token store with
// the backend's own `provisionAutomationToken` — the same row the boot writes
// (smoke spec §3) — because the boot's provisioning path is a later wave's.
//
// Every assertion reads the database through `psql` inside the Postgres
// container, and every write the test makes goes through the API's own HTTP
// routes. The fake-API unit tests (system-scheduler-rebuild/-recovery) prove
// the client's reactions; this file proves the whole loop.
//
// DOWNTIME IS A KILLED PROCESS, not a paused object: SIGTERM, time passes on
// the real clock, a NEW process starts and rebuilds from a full read. That is
// what a container restart is.
//
// Durations are seconds long on purpose: §8 — "A test that needs a fast
// lifecycle sets short epoch and judging durations and runs the real
// scheduler; it does not bypass the scheduler."
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { canonicalizeSubmission, ROUTES } from "@robotmoney/contract";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POSTGRES_IMAGE } from "../../lib/postgres-image.ts";
import { dockerLabelFlags, resolveStackEnvironment, stackLabels, stackProjectName } from "../../stack/naming.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const BACKEND = join(REPO, "backend");
const ADMIN_TOKEN = "it-runtime-admin-token";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const environment = resolveStackEnvironment(process.env);
const pgName = `${stackProjectName("pgtest", environment)}_sched_rt`;
let pgPort = 0;
let apiPort = 0;
let healthPort = 0;
let databaseUrl = "";
let stateDir = "";
let tokenFile = "";
// A SECOND scheduler's token. D55: only `system-scheduler` turns an epoch over,
// and the operator admin token is refused on every epoch lifecycle route. So a
// turnover the running scheduler did not make is driven with this token, the
// way a second scheduler would, never with ADMIN_TOKEN.
let secondSchedulerToken = "";
let api: ReturnType<typeof Bun.spawn> | null = null;
let scheduler: ReturnType<typeof Bun.spawn> | null = null;
const logs: string[] = [];

/** The minimal environment a child needs, and NOTHING inherited — no stray DATABASE_URL. */
function baseEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };
}

/** One SQL statement through the container's own psql; unaligned, tuples only. */
function psql(query: string): string {
  const r = Bun.spawnSync(
    ["docker", "exec", pgName, "psql", "-U", "robotmoney", "-d", "robotmoney", "-At", "-F", "|", "-c", query],
  );
  if (r.exitCode !== 0) throw new Error(`psql failed: ${r.stderr.toString()}\n${query}`);
  return r.stdout.toString().trim();
}
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function waitFor<T>(what: string, probe: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}\n--- process logs ---\n${logs.slice(-60).join("\n")}`);
    }
    await Bun.sleep(150);
  }
}

function pipe(proc: ReturnType<typeof Bun.spawn>, tag: string): void {
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream || typeof stream === "number") continue;
    void (async () => {
      const dec = new TextDecoder();
      for await (const chunk of stream as ReadableStream<Uint8Array>) {
        for (const line of dec.decode(chunk).split("\n")) if (line.trim()) logs.push(`[${tag}] ${line}`);
      }
    })();
  }
}

async function runBackend(code: string): Promise<string> {
  const proc = Bun.spawn(["bun", "-e", code], {
    cwd: BACKEND,
    env: { ...baseEnv(), DATABASE_URL: databaseUrl, RM_ENV: "ephemeral" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code_] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text(), await proc.exited];
  if (code_ !== 0) throw new Error(`backend script failed (${code_}): ${err}\n${out}`);
  return out.trim();
}

async function startScheduler(): Promise<void> {
  scheduler = Bun.spawn(["bun", "scripts/system-scheduler.ts"], {
    cwd: REPO,
    // §7: an API URL and a token FILE. No database credential of any kind.
    env: {
      ...baseEnv(),
      SCHEDULER_API_URL: `http://127.0.0.1:${apiPort}`,
      SCHEDULER_TOKEN_FILE: tokenFile,
      SCHEDULER_HEALTH_PORT: String(healthPort),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  pipe(scheduler, "scheduler");
  await waitFor("the scheduler to report healthy", () => {
    const r = Bun.spawnSync(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${healthPort}/health`]);
    return r.stdout.toString() === "200";
  });
}

async function stopScheduler(): Promise<void> {
  if (!scheduler) return;
  scheduler.kill("SIGTERM");
  await scheduler.exited;
  scheduler = null;
}

async function secondSchedulerPost(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Automation-Token": secondSchedulerToken },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function adminPost(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function createSubject(id: string, epochDuration: number, extra: Record<string, unknown> = {}) {
  const r = await adminPost("/api/swarm/admin/subjects", {
    id, name: id, recommendationType: "position_actions", epochDuration, ...extra,
  });
  if (r.status !== 201) throw new Error(`create ${id}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.subject as { version: number };
}

interface SessionFacts {
  id: string;
  state: string;
  closes: string;
}
function sessionsOf(subjectId: string): SessionFacts[] {
  const out = psql(`SELECT id, state, window_closes_at::text FROM swarm_sessions
                     WHERE subject_id = ${lit(subjectId)} ORDER BY convened_at, id`);
  return out ? out.split("\n").map((l) => { const [id, state, closes] = l.split("|"); return { id: id!, state: state!, closes: closes! }; }) : [];
}
const collectingOf = (subjectId: string) => sessionsOf(subjectId).filter((s) => s.state === "collecting");
/** True in SQL: the close is anchor + k × duration for an integer k. */
const onGrid = (sessionId: string) => psql(`
  SELECT mod(extract(epoch FROM (s.window_closes_at - t.epoch_anchor)), t.epoch_duration_seconds) = 0
    FROM swarm_sessions s JOIN swarm_subjects t ON t.id = s.subject_id WHERE s.id = ${lit(sessionId)}`) === "t";
const dbNow = () => psql("SELECT clock_timestamp()::text");

const b64 = (buf: ArrayBuffer) => Buffer.from(new Uint8Array(buf)).toString("base64");

/** A member registered through the API's privileged register route, with its own Ed25519 key. */
async function registeredMember(): Promise<{ id: string; token: string; key: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const id = `rt_member_${crypto.randomUUID().slice(0, 6)}`;
  const r = await adminPost(ROUTES.swarm.register, {
    memberId: id, name: id, publicKey: b64(await crypto.subtle.exportKey("raw", kp.publicKey)),
  });
  if (r.status !== 201 || !r.body?.token) throw new Error(`register ${id}: ${r.status} ${JSON.stringify(r.body)}`);
  return { id, token: r.body.token, key: kp.privateKey };
}

/** A signed take, submitted exactly as a participant submits one. */
async function signedTake(m: { id: string; token: string; key: CryptoKey }, date: string, subjectId: string) {
  const sub = {
    memberId: m.id, date, subjectId, nonce: crypto.randomUUID(), stance: "neutral", confidence: 0.5, body: "a take",
  };
  const signature = b64(await crypto.subtle.sign("Ed25519", m.key, new TextEncoder().encode(canonicalizeSubmission(sub))));
  const r = await fetch(`http://127.0.0.1:${apiPort}${ROUTES.swarm.submit}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${m.token}` },
    body: JSON.stringify({ ...sub, signature }),
  });
  const body = (await r.json()) as { error?: string };
  return { status: r.status, error: body.error };
}

beforeAll(async () => {
  pgPort = await freePort();
  apiPort = await freePort();
  healthPort = await freePort();
  if ([pgPort, apiPort, healthPort].includes(48787)) throw new Error("refusing to bind :48787");
  databaseUrl = `postgres://robotmoney:robotmoney@127.0.0.1:${pgPort}/robotmoney`;
  stateDir = mkdtempSync(join(tmpdir(), "sched-rt-"));
  tokenFile = join(stateDir, "system-scheduler.token");

  const up = Bun.spawnSync([
    "docker", "run", "-d", "--rm", "--name", pgName,
    ...dockerLabelFlags(stackLabels(environment, pgName)),
    "-e", "POSTGRES_PASSWORD=robotmoney", "-e", "POSTGRES_USER=robotmoney", "-e", "POSTGRES_DB=robotmoney",
    "-p", `127.0.0.1:${pgPort}:5432`, POSTGRES_IMAGE, "-c", "fsync=off", "-c", "synchronous_commit=off",
  ]);
  if (up.exitCode !== 0) throw new Error(`postgres container failed to start: ${up.stderr.toString()}`);

  // The backend's own migrate() retries until the server accepts connections.
  await runBackend(`
    const { migrate } = await import("./src/db/migrate.ts");
    const { seed } = await import("./src/db/seed.ts");
    await migrate(); await seed(); process.exit(0);`);
  const token = await runBackend(`
    const { provisionAutomationToken } = await import("./src/db/automation-tokens.ts");
    const r = await provisionAutomationToken("it-runtime", ["read_subjects", "read_sessions", "lifecycle_transitions"]);
    console.log(r.token); process.exit(0);`);
  writeFileSync(tokenFile, `${token.split("\n").pop()}\n`, { mode: 0o600 });
  const second = await runBackend(`
    const { provisionAutomationToken } = await import("./src/db/automation-tokens.ts");
    const r = await provisionAutomationToken("it-runtime-second", ["read_subjects", "read_sessions", "lifecycle_transitions"]);
    console.log(r.token); process.exit(0);`);
  secondSchedulerToken = second.split("\n").pop()!;

  api = Bun.spawn(["bun", "run", "src/api/index.ts"], {
    cwd: BACKEND,
    env: { ...baseEnv(), DATABASE_URL: databaseUrl, API_PORT: String(apiPort), RM_ENV: "ephemeral", ADMIN_TOKEN },
    stdout: "pipe",
    stderr: "pipe",
  });
  pipe(api, "api");
  await waitFor("the API to answer", () => {
    const r = Bun.spawnSync(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${apiPort}/api/swarm/sessions`]);
    return r.stdout.toString() === "200";
  }, 60_000);

  // Judge mode off for everything below unless a test turns it on through the
  // admin route: a session then settles to `not_judged` with nothing to wait on.
  expect((await adminPost("/api/swarm/admin/judge", { mode: "off" })).status).toBe(200);
  await startScheduler();
}, 180_000);

afterAll(async () => {
  await stopScheduler().catch(() => {});
  if (api) {
    api.kill("SIGTERM");
    await api.exited.catch(() => {});
  }
  Bun.spawnSync(["docker", "rm", "-f", "-v", pgName]);
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

describe("the real scheduler drives the real API (§3, §4)", () => {
  test("a subject created through the admin route gets its epoch opened by the scheduler, on the grid, and turned over at the instant", async () => {
    // §3: activation is a `subject.changed` event, and the scheduler opens the
    // subject's first epoch. The test never calls epochs/open.
    const id = `rt_created_${crypto.randomUUID().slice(0, 6)}`;
    await createSubject(id, 4);
    const [first] = await waitFor("the scheduler to open the first epoch", () => {
      const c = collectingOf(id);
      return c.length === 1 ? c : null;
    });
    expect(onGrid(first!.id)).toBe(true);
    // The first-epoch floor: at least half a duration from its open.
    expect(psql(`SELECT window_closes_at - convened_at >= interval '2 seconds' FROM swarm_sessions WHERE id = ${lit(first!.id)}`))
      .toBe("t");

    // The boundary fires at the instant: N is settled to `published` (judge
    // off → `not_judged`), and N+1 closes exactly one duration later.
    await waitFor("N to be published", () => psql(`SELECT state FROM swarm_sessions WHERE id = ${lit(first!.id)}`) === "published", 20_000);
    expect(psql(`SELECT judging_outcome FROM swarm_sessions WHERE id = ${lit(first!.id)}`)).toBe("not_judged");
    const next = psql(`SELECT successor_session_id FROM swarm_sessions WHERE id = ${lit(first!.id)}`);
    expect(psql(`SELECT n1.window_closes_at = n.window_closes_at + interval '4 seconds'
                   FROM swarm_sessions n JOIN swarm_sessions n1 ON n1.id = n.successor_session_id
                  WHERE n.id = ${lit(first!.id)}`)).toBe("t");
    expect(onGrid(next)).toBe(true);
    // Dispatch within a second of the instant (§10), measured by the database.
    expect(psql(`SELECT n1.convened_at - n.window_closes_at < interval '1 second'
                   FROM swarm_sessions n JOIN swarm_sessions n1 ON n1.id = n.successor_session_id
                  WHERE n.id = ${lit(first!.id)}`)).toBe("t");
    // And no queue row carried any of it (§4.4).
    expect(psql("SELECT count(*) FROM jobs WHERE kind LIKE 'swarm.%'")).toBe("0");
  }, 60_000);

  test("a deactivated subject's open epoch reaches published and no successor opens (§4.5)", async () => {
    const id = `rt_deact_${crypto.randomUUID().slice(0, 6)}`;
    const created = await createSubject(id, 30);
    const [open] = await waitFor("the first epoch", () => {
      const c = collectingOf(id);
      return c.length === 1 ? c : null;
    });
    const r = await adminPost(`/api/swarm/admin/subjects/${id}/deactivate`, { expectedVersion: created.version });
    expect(r.status).toBe(200);
    await waitFor("the closed epoch to settle to published", () =>
      psql(`SELECT state FROM swarm_sessions WHERE id = ${lit(open!.id)}`) === "published", 20_000);
    // Give a stray timer every chance to misfire: nothing may open.
    await Bun.sleep(1500);
    expect(sessionsOf(id).map((s) => s.state)).toEqual(["published"]);
    expect(psql(`SELECT successor_session_id IS NULL FROM swarm_sessions WHERE id = ${lit(open!.id)}`)).toBe("t");
  }, 60_000);

  test("DEACTIVATE THEN RE-ACTIVATE through the admin route: the running scheduler opens exactly one fresh on-grid epoch (criteria 88, 89)", async () => {
    // §2.4 / §3: "a subject deactivated and re-activated" is opened by the
    // scheduler, and "Nothing else opens a first epoch." D55 (4): activation
    // is a subject edit — the route flips the status and publishes
    // `subject.changed`; the scheduler, live on the stream, opens the epoch.
    // The test never calls epochs/open and holds no scheduler token here.
    const id = `rt_react_${crypto.randomUUID().slice(0, 6)}`;
    const created = await createSubject(id, 6);
    const [first] = await waitFor("the first epoch", () => {
      const c = collectingOf(id);
      return c.length === 1 ? c : null;
    });
    const off = await adminPost(ROUTES.swarm.admin.subjectDeactivate.replace(":id", id), { expectedVersion: created.version });
    expect(off.status).toBe(200);
    await waitFor("the closed epoch to settle", () =>
      psql(`SELECT state FROM swarm_sessions WHERE id = ${lit(first!.id)}`) === "published", 20_000);
    expect(collectingOf(id)).toEqual([]);

    const activatedAt = dbNow();
    const on = await adminPost(ROUTES.swarm.admin.subjectActivate.replace(":id", id), {
      expectedVersion: off.body.subject.version,
    });
    expect(on.status).toBe(200);
    expect(on.body.subject.status).toBe("active");
    const [fresh] = await waitFor("the scheduler to open the re-activated subject's epoch", () => {
      const c = collectingOf(id);
      return c.length === 1 ? c : null;
    });
    expect(fresh!.id).not.toBe(first!.id);
    expect(onGrid(fresh!.id)).toBe(true);
    // Fresh: opened after the activation, never backdated, with the
    // first-epoch floor of half a duration.
    expect(psql(`SELECT convened_at >= ${lit(activatedAt)}::timestamptz
                    AND window_closes_at >= convened_at + interval '3 seconds'
                   FROM swarm_sessions WHERE id = ${lit(fresh!.id)}`)).toBe("t");
    // Exactly one FIRST opening: give a duplicate open every chance to appear.
    // A session opened by a later turnover is some session's successor and is
    // not a first opening, so it is excluded by name rather than by timing.
    await Bun.sleep(1500);
    expect(psql(`SELECT count(*) FROM swarm_sessions WHERE subject_id = ${lit(id)}
                    AND convened_at >= ${lit(activatedAt)}::timestamptz
                    AND id NOT IN (SELECT successor_session_id FROM swarm_sessions
                                    WHERE subject_id = ${lit(id)} AND successor_session_id IS NOT NULL)`)).toBe("1");
    await adminPost(ROUTES.swarm.admin.subjectDeactivate.replace(":id", id), {
      expectedVersion: Number(psql(`SELECT version FROM swarm_subjects WHERE id = ${lit(id)}`)),
    });
  }, 60_000);

  test("ACTIVATION DURING DOWNTIME yields one fresh on-grid epoch on rebuild, never backdated (criterion 90)", async () => {
    await stopScheduler();
    const id = `rt_down_act_${crypto.randomUUID().slice(0, 6)}`;
    await createSubject(id, 6);
    // Nothing opens it while the clock is down: the API opens no epoch itself.
    await Bun.sleep(1000);
    expect(sessionsOf(id)).toEqual([]);

    const restartedAt = dbNow();
    await startScheduler();
    const [fresh] = await waitFor("the rebuild to open the epoch", () => {
      const c = collectingOf(id);
      return c.length === 1 ? c : null;
    });
    expect(sessionsOf(id)).toHaveLength(1);
    expect(onGrid(fresh!.id)).toBe(true);
    // Never backdated: opened after the restart, closing at least half a
    // duration after it opened.
    expect(psql(`SELECT convened_at >= ${lit(restartedAt)}::timestamptz
                    AND window_closes_at >= convened_at + interval '3 seconds'
                   FROM swarm_sessions WHERE id = ${lit(fresh!.id)}`)).toBe("t");
  }, 60_000);

  test("GRID AFTER DOWNTIME: two missed slots, one turnover on rebuild onto the first future grid instant; late takes refused throughout (85, 100)", async () => {
    const id = `rt_down_grid_${crypto.randomUUID().slice(0, 6)}`;
    const D = 3;
    await createSubject(id, D);
    const [n] = await waitFor("the first epoch", () => {
      const c = collectingOf(id);
      return c.length === 1 ? c : null;
    });
    await stopScheduler();
    // Wait out N's close plus two more whole slots, on the database clock.
    await waitFor("two slots past N's close", () =>
      psql(`SELECT clock_timestamp() > window_closes_at + interval '${2 * D} seconds' + interval '300 milliseconds'
              FROM swarm_sessions WHERE id = ${lit(n!.id)}`) === "t", 30_000);
    // Still collecting — nothing turned it over — and a real, signed take from
    // a registered member is refused by INSTANT, not by state (§4.2, §4.6:
    // "refusing submissions past the close instant throughout"). Twice, a
    // second apart, to show it is not a one-off.
    expect(psql(`SELECT state FROM swarm_sessions WHERE id = ${lit(n!.id)}`)).toBe("collecting");
    const date = psql(`SELECT date::text FROM swarm_sessions WHERE id = ${lit(n!.id)}`);
    const member = await registeredMember();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const late = await signedTake(member, date, id);
      expect(late).toEqual({ status: 409, error: "submission window closed" });
      await Bun.sleep(1000);
    }

    const restartedAt = dbNow();
    await startScheduler();
    await waitFor("the one catch-up turnover", () =>
      psql(`SELECT successor_session_id IS NOT NULL FROM swarm_sessions WHERE id = ${lit(n!.id)}`) === "t");
    const successor = psql(`SELECT successor_session_id FROM swarm_sessions WHERE id = ${lit(n!.id)}`);
    // ONE turnover: missed slots skipped, never opened. No session of this
    // subject closes on any slot between N's close and the successor's — the
    // successor may itself have turned over by now (its window is at most one
    // short duration), so the claim is about the missed range, not a count.
    expect(psql(`SELECT count(*) FROM swarm_sessions s, swarm_sessions n, swarm_sessions n1
                  WHERE n.id = ${lit(n!.id)} AND n1.id = n.successor_session_id AND s.subject_id = ${lit(id)}
                    AND s.window_closes_at > n.window_closes_at AND s.window_closes_at < n1.window_closes_at`)).toBe("0");
    expect(psql(`SELECT count(*) FROM swarm_sessions s, swarm_sessions n1
                  WHERE n1.id = ${lit(successor)} AND s.subject_id = ${lit(id)} AND s.convened_at <= n1.convened_at`)).toBe("2");
    expect(onGrid(successor)).toBe(true);
    // The first FUTURE grid instant: after the restart, within one duration of
    // it, and not N's close + one duration (a past slot).
    expect(psql(`SELECT window_closes_at > ${lit(restartedAt)}::timestamptz
                    AND window_closes_at <= ${lit(restartedAt)}::timestamptz + interval '${D} seconds' + interval '1 second'
                   FROM swarm_sessions WHERE id = ${lit(successor)}`)).toBe("t");
    expect(psql(`SELECT n1.window_closes_at > n.window_closes_at + interval '${2 * D} seconds'
                   FROM swarm_sessions n JOIN swarm_sessions n1 ON n1.id = n.successor_session_id
                  WHERE n.id = ${lit(n!.id)}`)).toBe("t");
    // No take was ever filed against N past its close.
    expect(psql(`SELECT count(*) FROM swarm_recommendations r JOIN swarm_sessions s ON s.id = r.session_id
                  WHERE s.id = ${lit(n!.id)} AND r.received_at > s.window_closes_at`)).toBe("0");
    await adminPost(`/api/swarm/admin/subjects/${id}/deactivate`, {
      expectedVersion: Number(psql(`SELECT version FROM swarm_subjects WHERE id = ${lit(id)}`)),
    });
  }, 90_000);

  test("DEADLINE RECONSTRUCTION: a restart before the judging deadline fires at the ORIGINALLY STORED instant; after it, finalize runs at once (98)", async () => {
    // Enforce, through the admin route, with no judge seated: every judging
    // request runs to its deadline and publishes `no_consensus`.
    expect((await adminPost("/api/swarm/admin/judge", { mode: "enforce", model: "deepseek-v4-flash" })).status).toBe(200);
    try {
      const judgingOf = async (id: string, judgingDurationSeconds: number) => {
        await createSubject(id, 60, { judgingDurationSeconds });
        const [n] = await waitFor("the first epoch", () => {
          const c = collectingOf(id);
          return c.length === 1 ? c : null;
        });
        // A turnover the running scheduler did not make — a second scheduler's
        // (D55: never an operator's): the running scheduler learns of it by
        // event and settles N — aggregate, then the judging request with its
        // deadline.
        const t = await secondSchedulerPost("/api/swarm/admin/epochs/turnover", { subjectId: id, expectedSessionId: n!.id });
        expect(t.status).toBe(200);
        await waitFor("N to be judging", () => psql(`SELECT state FROM swarm_sessions WHERE id = ${lit(n!.id)}`) === "judging");
        return n!.id;
      };

      // BEFORE the deadline. The judging duration is long enough, and the
      // scheduler stays down long enough, that the two answers are far apart:
      // the scheduler is restarted about 3.5 s into an 8 s judging window, so
      // the stored deadline falls about 4.5 s after the restart, while a
      // scheduler that RESTARTED its timer at rebuild would finalize a full 8 s
      // after it. The assertions below sit between the two with a margin on
      // both sides, so the red case fails however fast the restart is.
      const JUDGING = 8;
      const before = await judgingOf(`rt_deadline_before_${crypto.randomUUID().slice(0, 6)}`, JUDGING);
      const deadline = psql(`SELECT judging_deadline_at::text FROM swarm_sessions WHERE id = ${lit(before)}`);
      await stopScheduler();
      await Bun.sleep(3000);
      const restartBeganAt = dbNow();
      await startScheduler();
      // The restart really was BEFORE the deadline: the rebuild had a timer to
      // reconstruct, not a finalize to run at once.
      expect(psql(`SELECT clock_timestamp() < judging_deadline_at FROM swarm_sessions WHERE id = ${lit(before)}`)).toBe("t");
      // The stored deadline is untouched by the restart…
      expect(psql(`SELECT judging_deadline_at::text FROM swarm_sessions WHERE id = ${lit(before)}`)).toBe(deadline);
      await waitFor("finalize at the stored deadline", () =>
        psql(`SELECT state FROM swarm_sessions WHERE id = ${lit(before)}`) === "published", 20_000);
      // …and finalize ran AT it: not before (the API would have refused), and
      // well short of a fresh judging duration counted from the restart.
      expect(psql(`SELECT published_at >= judging_deadline_at
                      AND published_at < judging_deadline_at + interval '1500 milliseconds'
                      AND published_at < ${lit(restartBeganAt)}::timestamptz + interval '${JUDGING} seconds' - interval '1500 milliseconds',
                      judging_outcome
                     FROM swarm_sessions WHERE id = ${lit(before)}`)).toBe("t|no_consensus");

      // AFTER the deadline.
      const after = await judgingOf(`rt_deadline_after_${crypto.randomUUID().slice(0, 6)}`, 5);
      await stopScheduler();
      await waitFor("the deadline to pass while the scheduler is down", () =>
        psql(`SELECT clock_timestamp() > judging_deadline_at + interval '500 milliseconds'
                FROM swarm_sessions WHERE id = ${lit(after)}`) === "t", 20_000);
      expect(psql(`SELECT state FROM swarm_sessions WHERE id = ${lit(after)}`)).toBe("judging");
      const restartedAt = dbNow();
      await startScheduler();
      await waitFor("finalize at once on rebuild", () =>
        psql(`SELECT state FROM swarm_sessions WHERE id = ${lit(after)}`) === "published", 10_000);
      expect(psql(`SELECT published_at < ${lit(restartedAt)}::timestamptz + interval '3 seconds', judging_outcome
                     FROM swarm_sessions WHERE id = ${lit(after)}`)).toBe("t|no_consensus");
    } finally {
      await adminPost("/api/swarm/admin/judge", { mode: "off" });
    }
  }, 150_000);
});
