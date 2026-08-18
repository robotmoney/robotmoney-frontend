// The PRODUCTION boot path refuses a restored handle/id namespace violation
// (issue #602) — and, since issue #684, a database whose append-only guard has
// been disarmed. Both guards live on the same entrypoint, run against the same
// spawned process, and are graded here to the same standard, so the file covers
// the pair rather than only the one it is named after.
//
// WHAT MAKES THIS THE PRODUCTION PATH. docker-compose.yml's api service runs
// `command: ["bun", "run", "src/api/index.ts"]`, and that is the whole bring-up
// documented at docs/runbooks/deployment.md — no migrate step, no
// scripts/db-preflight.ts. So this file spawns THAT file, as a real process,
// against a real database, and grades the process: a violating database must
// produce a non-zero exit with both members named and NO port bound, and every
// other database shape must still boot and serve.
//
// Booting is graded as strictly as refusing, and MORE of the file is about
// booting than about refusing — a fail-closed guard on the entrypoint is an
// availability risk if it is wrong, and this process serves the static frontend
// too, so a guard that hangs or refuses wrongly is a total site outage. The
// shapes that must still serve: empty, pre-0030 (a swarm_members with no
// `handle` column), unreachable, a swarm_members held under ACCESS EXCLUSIVE
// (the BLOCKING database, which is not the same failure as a rejecting one),
// and a violating database under the documented override.
//
// WHAT THIS FILE CANNOT PROVE. It spawns the entrypoint directly, so it grades
// the CODE's handling of RM_ALLOW_HANDLE_NAMESPACE_VIOLATION and
// PG_NAMESPACE_GUARD_TIMEOUT_MS and says nothing about whether either variable
// is DELIVERED to the deployed container — compose passes only what
// docker-compose.yml's api `environment:` allowlist names, and Bun.spawn
// bypasses that entirely. That half is asserted against real `docker compose
// config` output in scripts/tests/integration/demo-compose-config.test.ts.
//
// The databases are throwaways created on the suite's ephemeral Postgres
// (tests/preload.ts, which throws rather than skips when Docker is absent):
// the shared suite database can hold neither a forbidden pair nor a pre-0030
// schema. Migrations are applied file-by-file rather than through migrate() so
// nothing seeds — same pattern as swarm-member-handle-namespace-migration.test.ts.
import { afterAll, expect, test } from "bun:test";
import net from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config } from "../src/config.ts";
import {
  checkHandleNamespace,
  handleNamespaceConflicts,
  NAMESPACE_GUARD_BUDGET_MS,
  NAMESPACE_GUARD_DEFAULT_BUDGET_MS,
  NAMESPACE_GUARD_MAX_BUDGET_MS,
  parseGuardBudgetMs,
  type NamespaceDb,
} from "../src/db/handle-namespace.ts";

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = join(here, "..");
const migrationsDir = join(backendDir, "migrations");

const created: string[] = [];

function adminUrl(): string {
  return new URL(config.databaseUrl).toString();
}

function urlFor(dbName: string): string {
  const u = new URL(config.databaseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function createThrowawayDb(label: string): Promise<string> {
  const name = `tmp_apiboot_${label}_${crypto.randomUUID().slice(0, 8)}`;
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  created.push(name);
  return name;
}

async function applyAllMigrations(db: postgres.Sql<{}>): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  expect(files.length).toBeGreaterThan(0);
  await db`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const file of files) {
    const ddl = await readFile(join(migrationsDir, file), "utf8");
    await db.begin(async (tx) => {
      await tx.unsafe(ddl);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
  }
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

/** True only if something is accepting TCP connections on the port. */
function portIsBound(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (bound: boolean) => {
      s.destroy();
      res(bound);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

interface Booted {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
}

function spawnApi(
  dbUrl: string,
  port: number,
  capture: boolean,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bun", "run", "src/api/index.ts"], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: dbUrl, API_PORT: String(port), ...extraEnv },
    stdout: capture ? "pipe" : "ignore",
    stderr: "pipe",
  });
}

/** Boot the api and wait until /health answers — the proof it reached serving
 *  traffic. Fails loudly (never silently passes) if the process exits first. */
async function bootAndServe(
  dbUrl: string,
  extraEnv: Record<string, string> = {},
): Promise<Booted> {
  const port = await freePort();
  const proc = spawnApi(dbUrl, port, false, extraEnv);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) {
      const err = await new Response(proc.stderr as ReadableStream).text();
      throw new Error(`api exited with ${proc.exitCode} instead of serving:\n${err}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        expect((await res.json()).status).toBe("ok");
        return { proc, port };
      }
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`api never served /health on :${port}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

afterAll(async () => {
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    for (const name of created) {
      await admin.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}'`,
      );
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
    }
  } finally {
    await admin.end();
  }
});

// ── AC1: the production boot path refuses a violating database ──────────────

test(
  "a migrated database holding a restored violation: `bun run src/api/index.ts` exits non-zero, names both members, and binds no port",
  async () => {
    const dbName = await createThrowawayDb("violating");
    const db = postgres(urlFor(dbName), { max: 2, onnotice: () => {} });
    const holder = "boot-holder";
    const shadowed = "boot-shadowed";
    try {
      await applyAllMigrations(db);
      // The restore shape, forced: 0031's trigger is ENABLE ALWAYS, so even
      // `session_replication_role = replica` cannot place the pair — a real
      // pg_restore gets in only because its COPY precedes CREATE TRIGGER. This
      // is a throwaway database, but the trigger is still restored with
      // ENABLE ALWAYS (never a plain ENABLE, which downgrades 'A' to 'O').
      await db`ALTER TABLE swarm_members DISABLE TRIGGER swarm_members_handle_namespace_trigger`;
      await db`INSERT INTO swarm_members (id, status, name, handle)
               VALUES (${shadowed}, 'active', 'Shadowed', ${`${shadowed}-h`})`;
      await db`INSERT INTO swarm_members (id, status, name, handle)
               VALUES (${holder}, 'active', 'Holder', ${shadowed})`;
      await db`ALTER TABLE swarm_members ENABLE ALWAYS TRIGGER swarm_members_handle_namespace_trigger`;

      const port = await freePort();
      const proc = spawnApi(urlFor(dbName), port, true);
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr as ReadableStream).text();

      expect(exitCode).not.toBe(0);
      // The operator's two questions: which rows, and is it serving.
      expect(stderr).toContain("REFUSING the boot");
      expect(stderr).toContain(holder);
      expect(stderr).toContain(shadowed);
      expect(stderr).toContain("addresses two members");
      expect(stderr).toContain("will NOT start");
      // The repair handed to the operator is a STATEMENT, and it names the
      // HOLDER — the member printed first. See the negative control below for
      // why naming either row would be wrong.
      expect(stderr).toContain(`WHERE id = '${holder}';`);
      expect(stderr).not.toContain(`WHERE id = '${shadowed}';`);
      // Refused BEFORE Bun.serve: nothing was ever bound, so no request was
      // ever answered from this database.
      expect(await portIsBound(port)).toBe(false);

      // NEGATIVE control for that instruction. The runbook used to say the
      // repair was `UPDATE swarm_members SET handle = …` "on one of the two
      // rows". It is not: updating the SHADOWED member's handle succeeds
      // (UPDATE 1, no trigger refusal) and leaves the violation exactly where
      // it was. An operator who followed that would restart into the identical
      // refusal, mid-outage, having repointed a live URL for nothing.
      await db`UPDATE swarm_members SET handle = ${`${shadowed}-h2`} WHERE id = ${shadowed}`;
      expect(await handleNamespaceConflicts(db)).toHaveLength(1);

      // Positive control on the SAME database: moving the HOLDER's handle — the
      // statement the refusal printed — clears it, and the very same command
      // serves. Without this the test above is also satisfied by a guard that
      // refuses everything.
      await db`UPDATE swarm_members SET handle = ${`${holder}-h`} WHERE id = ${holder}`;
      expect(await handleNamespaceConflicts(db)).toHaveLength(0);
      const ok = await bootAndServe(urlFor(dbName));
      ok.proc.kill();
      await ok.proc.exited;
    } finally {
      await db.end();
    }
  },
  180_000,
);

// ── The shapes that must still boot (a wrong fail-closed guard is an outage) ─

test(
  "an EMPTY database — no tables at all — still boots and serves",
  async () => {
    const dbName = await createThrowawayDb("empty");
    const booted = await bootAndServe(urlFor(dbName));
    booted.proc.kill();
    await booted.proc.exited;
  },
  120_000,
);

test(
  "a database the api cannot reach AT ALL still boots — loudly UNCHECKED, never refused",
  async () => {
    // The honest limit of this guard, asserted rather than described: an
    // unreachable database is not a namespace violation, and turning a slow or
    // down Postgres into an api crash-loop would be a worse outage than the one
    // being guarded against. The api has always started in this state and
    // answered /health with db:"down". What it must NOT do is stay silent about
    // having skipped the check.
    const booted = await bootAndServe("postgres://unused:unused@127.0.0.1:1/unused");
    const res = await fetch(`http://127.0.0.1:${booted.port}/health`);
    expect((await res.json()).db).toBe("down");
    booted.proc.kill();
    await booted.proc.exited;
    const stderr = await new Response(booted.proc.stderr as ReadableStream).text();
    expect(stderr).toContain("handle/id namespace guard could NOT run");
    expect(stderr).toContain("UNCHECKED");
    expect(stderr).not.toContain("REFUSING");
  },
  120_000,
);

test(
  "a MALFORMED PG_NAMESPACE_GUARD_TIMEOUT_MS ('8s') does not disable the bound: the api still boots, and says it ignored the value",
  async () => {
    // The knob that bounds the guard must not be the way to unbound it. With
    // `Number("8s")` → NaN, every deadline comparison in checkHandleNamespace is
    // a comparison against NaN — all false — so the retry loop never returns,
    // Bun.serve is never reached, no port is bound and NOTHING is logged. That
    // is the same total silent outage the guard exists to prevent, reached
    // through the guard's own configuration, and "8s" is exactly the shape an
    // operator writes. Measured against this database url on the unvalidated
    // version: no port bound after 30s and not one [api] line.
    //
    // "8s" over a random string on purpose: a duration suffix is the plausible
    // typo, not a nonsense word.
    const booted = await bootAndServe("postgres://unused:unused@127.0.0.1:1/unused", {
      PG_NAMESPACE_GUARD_TIMEOUT_MS: "8s",
    });
    const health = await fetch(`http://127.0.0.1:${booted.port}/health`);
    expect(health.status).toBe(200);
    // The guard still ran and still concluded — on the fallback budget, not on
    // a nonexistent one.
    expect((await health.json()).handle_namespace).toBe("unchecked");

    booted.proc.kill();
    await booted.proc.exited;
    const stderr = await new Response(booted.proc.stderr as ReadableStream).text();
    // Degrading to the default is only safe if it is LOUD: an operator who set
    // a budget and silently did not get it is worse off than one who is told.
    expect(stderr).toContain("PG_NAMESPACE_GUARD_TIMEOUT_MS");
    expect(stderr).toContain("IGNORING");
    expect(stderr).toContain(`${NAMESPACE_GUARD_DEFAULT_BUDGET_MS}ms`);
    // …and the check itself still reported its own outcome, so the fallback did
    // not quietly swallow the boot guard along with the bad value.
    expect(stderr).toContain("handle/id namespace guard could NOT run");
  },
  120_000,
);

test(
  "an OVER-CEILING PG_NAMESPACE_GUARD_TIMEOUT_MS ('3000000000') does not disable the bound either: the api boots on the default and says why",
  async () => {
    // The second way this knob can un-bound the guard, and the one that does NOT
    // look like a typo: 3000000000 IS a positive finite number of milliseconds,
    // so validation that only checks `Number.isFinite(x) && x > 0` accepts it —
    // and then setTimeout, which takes a 32-bit signed delay, clamps it to 1ms.
    // Every attempt expires instantly, the loop retries on its 1s backoff and
    // prints a TimeoutOverflowWarning stack each time, and the documented
    // "could NOT run" line is never reached. Measured on the real entrypoint
    // against an unreachable database before the ceiling existed: NO port bound
    // after 35s and not one [api] line — the identical never-binds, never-logs
    // outage as the "8s" case above.
    const startedAt = Date.now();
    const booted = await bootAndServe("postgres://unused:unused@127.0.0.1:1/unused", {
      PG_NAMESPACE_GUARD_TIMEOUT_MS: "3000000000",
    });
    const elapsed = Date.now() - startedAt;
    const health = await fetch(`http://127.0.0.1:${booted.port}/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).handle_namespace).toBe("unchecked");
    // Bounded by THE DEFAULT, not merely by bootAndServe's own 60s deadline: the
    // rejected value must fall back to 8000ms, not to some other large budget.
    // The allowance is process spawn + bun startup + the poll interval.
    expect(elapsed).toBeLessThan(NAMESPACE_GUARD_DEFAULT_BUDGET_MS + 7_000);

    booted.proc.kill();
    await booted.proc.exited;
    const stderr = await new Response(booted.proc.stderr as ReadableStream).text();
    expect(stderr).toContain("PG_NAMESPACE_GUARD_TIMEOUT_MS");
    expect(stderr).toContain("IGNORING");
    expect(stderr).toContain(`${NAMESPACE_GUARD_MAX_BUDGET_MS}ms a timer can hold`);
    expect(stderr).toContain(`${NAMESPACE_GUARD_DEFAULT_BUDGET_MS}ms`);
    expect(stderr).toContain("handle/id namespace guard could NOT run");
    // The specific symptom of the unbounded version, asserted absent rather than
    // inferred from the port having been bound.
    expect(stderr).not.toContain("TimeoutOverflowWarning");
  },
  120_000,
);

test("parseGuardBudgetMs takes every budget a timer can hold and refuses the rest, loudly", () => {
  // The table the boot test cannot enumerate one process at a time.
  const lines: string[] = [];
  const parse = (raw: string | undefined) => parseGuardBudgetMs(raw, (l) => lines.push(l));

  // Honoured.
  expect(parse("15000")).toBe(15_000);
  expect(parse(" 15000 ")).toBe(15_000);
  expect(parse("2.5e4")).toBe(25_000);
  // Absent means default, and is NOT an operator error — no line.
  expect(parse(undefined)).toBe(NAMESPACE_GUARD_DEFAULT_BUDGET_MS);
  expect(parse("")).toBe(NAMESPACE_GUARD_DEFAULT_BUDGET_MS);
  expect(lines).toHaveLength(0);

  // The ceiling itself is a legitimate budget and stays silent — the rejection
  // below has to be about the values a timer genuinely cannot hold, not about
  // "large".
  expect(parse(String(NAMESPACE_GUARD_MAX_BUDGET_MS))).toBe(NAMESPACE_GUARD_MAX_BUDGET_MS);
  expect(lines).toHaveLength(0);

  // Refused — each falls back to the default rather than to NaN, and each says so.
  for (const bad of ["8s", "eight", "0", "-1", "NaN", "Infinity", "8 000"]) {
    expect(parse(bad)).toBe(NAMESPACE_GUARD_DEFAULT_BUDGET_MS);
  }
  // …including a value ABOVE what a timer can hold, which is not a long budget
  // but a 1ms one: setTimeout takes a 32-bit signed delay, and above it the
  // runtime clamps to 1ms, so every attempt would expire instantly and the loop
  // would retry once a second in front of Bun.serve — the same never-binds,
  // never-logs outage as the NaN case, reached through a value that IS a
  // positive finite number of milliseconds.
  for (const tooBig of ["2147483648", "3000000000", "1e300"]) {
    expect(parse(tooBig)).toBe(NAMESPACE_GUARD_DEFAULT_BUDGET_MS);
  }
  expect(lines).toHaveLength(10);
  for (const line of lines) {
    expect(line).toContain("[api]");
    expect(line).toContain("PG_NAMESPACE_GUARD_TIMEOUT_MS");
    expect(line).toContain("IGNORING");
    expect(line).toContain(`${NAMESPACE_GUARD_DEFAULT_BUDGET_MS}ms`);
  }
  // The rejected value is named, so the operator can find it in their env.
  expect(lines[0]).toContain('"8s"');
  // …and an over-ceiling value is rejected for its own stated reason, with the
  // ceiling quoted, rather than being called "not a positive number".
  expect(lines[7]).toContain('"2147483648"');
  expect(lines[7]).toContain(`larger than the maximum ${NAMESPACE_GUARD_MAX_BUDGET_MS}ms`);
  expect(lines[7]).not.toContain("is not a positive number");
});

test("checkHandleNamespace cannot spin on a non-positive or NaN budget", async () => {
  // The structural half of the fix: even if a budget of NaN reached this
  // function from somewhere parseGuardBudgetMs does not sit in front of, the
  // loop returns rather than retrying forever. `sql` is never touched, because
  // the first guard fires before any query — asserted by passing a client that
  // would throw if it were used.
  const explode = new Proxy(
    {},
    {
      get() {
        throw new Error("checkHandleNamespace queried the database on an expired budget");
      },
    },
  ) as unknown as NamespaceDb;
  for (const budget of [Number.NaN, 0, -5]) {
    const result = await checkHandleNamespace(explode, budget);
    expect(result.status).toBe("unavailable");
    expect(result.conflicts).toEqual([]);
    // WHICH guard answered, not merely that something did. There are two
    // negated-positive comparisons in that loop (the pre-attempt one and the
    // post-catch one), and asserting only "unavailable" is satisfied by either:
    // with the pre-attempt guard reverted, the Proxy above IS reached, its throw
    // is swallowed by the catch, and the post-catch guard returns an identically
    // shaped result — so the comment above ("sql is never touched") would be
    // false while the test stayed green. This detail can only come from the
    // pre-attempt guard, so each site is now independently protected.
    expect(result.detail).toContain("budget exhausted before the check could answer");
  }
});

// ── The guard must be BOUNDED, not merely retried (OPS-610-001) ─────────────

test(
  "a database whose swarm_members is held under ACCESS EXCLUSIVE: the api still serves, loudly UNCHECKED, within the guard's budget",
  async () => {
    // The failure this exists to prevent is the worst one this PR could cause.
    // A blocking database is NOT a rejecting database: the guard's readiness
    // probe reads only catalogs and returns immediately under an ACCESS
    // EXCLUSIVE lock, while the detection SELECT blocks — so a retry loop that
    // consults its deadline only after a rejection is bounded by nothing here.
    // `await assertHandleNamespaceClean()` would then never resolve, Bun.serve
    // would never be reached, no port would be bound and NOTHING would be
    // logged; `restart: unless-stopped` does not restart a process that hangs
    // instead of exiting, and this process serves the static frontend too. The
    // lock below is an ordinary deploy-window event (a migration replay, a
    // REINDEX, a VACUUM FULL, an ALTER queued behind an idle transaction).
    const dbName = await createThrowawayDb("locked");
    const db = postgres(urlFor(dbName), { max: 2, onnotice: () => {} });
    const locker = postgres(urlFor(dbName), { max: 1, onnotice: () => {} });
    let releaseLock!: () => void;
    const released = new Promise<void>((r) => (releaseLock = r));
    let lockHeld = false;
    let lockSettled = false;
    let lockTxn: Promise<unknown> | undefined;
    try {
      await applyAllMigrations(db);

      let lockTaken!: () => void;
      const taken = new Promise<void>((r) => (lockTaken = r));
      lockTxn = locker.begin(async (tx) => {
        await tx`LOCK TABLE swarm_members IN ACCESS EXCLUSIVE MODE`;
        lockHeld = true;
        lockTaken();
        await released; // held for the whole boot, released in `finally`
      });
      lockTxn.then(
        () => (lockSettled = true),
        () => (lockSettled = true),
      );
      await taken;

      const startedAt = Date.now();
      const booted = await bootAndServe(urlFor(dbName));
      const elapsed = Date.now() - startedAt;

      // The lock was taken AND was still held when /health answered — without
      // the second assertion this test would also pass on a lock that quietly
      // went away, which is the one way it could be green for the wrong reason.
      expect(lockHeld).toBe(true);
      expect(lockSettled).toBe(false);
      // Bounded — and bounded by THE BUDGET, not by a round number that happens
      // to be larger. A hard-coded 30s here catches only the unbounded
      // regression; a silent loosening of the budget to 25s would stay green
      // while every claim about "8s" quietly stopped being true. Asserting
      // against the constant makes the assertion track the claim. The allowance
      // is process spawn + bun startup + the poll interval, not slack in the
      // bound itself.
      const allowance = NAMESPACE_GUARD_BUDGET_MS + 7_000;
      expect(NAMESPACE_GUARD_BUDGET_MS).toBe(8_000); // the documented default
      expect(elapsed).toBeLessThan(allowance);

      // …and the outcome is DETECTABLE, not merely logged: /health still
      // answers 200 (failing it on a slow database would trade this outage for
      // a restart loop) but says which of the two boots this was.
      const health = await fetch(`http://127.0.0.1:${booted.port}/health`);
      expect(health.status).toBe(200);
      const body = await health.json();
      expect(body.handle_namespace).toBe("unchecked");
      // The SECOND boot guard (issue #684) sits behind this one against the
      // same locked table, and it must reach the same conclusion for the same
      // reason. It nearly did not: its probe is a `DELETE ... WHERE false`,
      // which blocks on an ACCESS EXCLUSIVE lock and comes back as
      // `57014 canceling statement due to statement timeout` — and a first
      // version treated any error as evidence, classified that as "the guard is
      // gone" and REFUSED THE BOOT. A lock on one table would have taken the
      // whole site down. Silence is "unchecked", never "disarmed".
      expect(body.append_only_guard).toBe("unchecked");

      booted.proc.kill();
      await booted.proc.exited;
      const stderr = await new Response(booted.proc.stderr as ReadableStream).text();
      expect(stderr).toContain("handle/id namespace guard could NOT run");
      expect(stderr).toContain("append-only guard check could NOT run");
      expect(stderr).toContain("UNCHECKED");
      expect(stderr).not.toContain("REFUSING");
    } finally {
      releaseLock();
      await lockTxn?.catch(() => {});
      await locker.end();
      await db.end();
    }
  },
  180_000,
);

// ── The documented escape hatch (OPS-610-004) ───────────────────────────────

test(
  "RM_ALLOW_HANDLE_NAMESPACE_VIOLATION=1: the same violating database serves, loudly, and says so at /health",
  async () => {
    // A fail-closed gate on DATA — repairable only through an interactive SQL
    // session against production — needs a documented way out, or the guard
    // itself becomes the outage when it is the thing standing between an
    // operator and a running site. It must never be quiet about it.
    const dbName = await createThrowawayDb("override");
    const db = postgres(urlFor(dbName), { max: 2, onnotice: () => {} });
    const holder = "ovr-holder";
    const shadowed = "ovr-shadowed";
    try {
      await applyAllMigrations(db);
      await db`ALTER TABLE swarm_members DISABLE TRIGGER swarm_members_handle_namespace_trigger`;
      await db`INSERT INTO swarm_members (id, status, name, handle)
               VALUES (${shadowed}, 'active', 'Shadowed', ${`${shadowed}-h`})`;
      await db`INSERT INTO swarm_members (id, status, name, handle)
               VALUES (${holder}, 'active', 'Holder', ${shadowed})`;
      await db`ALTER TABLE swarm_members ENABLE ALWAYS TRIGGER swarm_members_handle_namespace_trigger`;

      const port = await freePort();
      const proc = Bun.spawn(["bun", "run", "src/api/index.ts"], {
        cwd: backendDir,
        env: {
          ...process.env,
          DATABASE_URL: urlFor(dbName),
          API_PORT: String(port),
          RM_ALLOW_HANDLE_NAMESPACE_VIOLATION: "1",
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      const deadline = Date.now() + 60_000;
      for (;;) {
        if (proc.exitCode !== null) {
          const err = await new Response(proc.stderr as ReadableStream).text();
          throw new Error(`the override did not let the api serve (exit ${proc.exitCode}):\n${err}`);
        }
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          if (res.ok) {
            // Machine-readable for the whole life of the process — an override
            // left on by accident must not look like a healthy boot.
            expect((await res.json()).handle_namespace).toBe("overridden");
            break;
          }
        } catch {
          /* not listening yet */
        }
        if (Date.now() > deadline) throw new Error(`api never served /health on :${port}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      proc.kill();
      await proc.exited;
      const stderr = await new Response(proc.stderr as ReadableStream).text();
      expect(stderr).toContain("OVERRIDE");
      expect(stderr).toContain("RM_ALLOW_HANDLE_NAMESPACE_VIOLATION");
      // The pair is still named: under an override this log is the only record
      // of what is being served wrong.
      expect(stderr).toContain(holder);
      expect(stderr).toContain(shadowed);
      // …and the guard did NOT also claim to be disarmed: on a violating
      // database the override is being USED, which is a different state from
      // the one the next test covers.
      expect(stderr).not.toContain("DISARMED");
    } finally {
      await db.end();
    }
  },
  180_000,
);

test(
  "an override left ON over a CLEAN database announces that the guard is DISARMED (OPS-610-007)",
  async () => {
    // The end of the documented procedure — set the override, restore service,
    // repair the rows, restart — leaves the variable set in the deploy
    // environment while the data is now clean. Without this line that state is
    // invisible: /health says `clean` (correctly — nothing is being served
    // wrong right now) and nothing anywhere says the guard will not stop the
    // NEXT bad restore. An operator must be able to tell a safe system from a
    // disarmed one.
    const dbName = await createThrowawayDb("armedclean");
    const db = postgres(urlFor(dbName), { max: 2, onnotice: () => {} });
    try {
      await applyAllMigrations(db);
      await db`INSERT INTO swarm_members (id, status, name, handle)
               VALUES ('armed-a', 'active', 'A', 'armed-a-h')`;
    } finally {
      await db.end();
    }

    const booted = await bootAndServe(urlFor(dbName), {
      RM_ALLOW_HANDLE_NAMESPACE_VIOLATION: "1",
    });
    const health = await fetch(`http://127.0.0.1:${booted.port}/health`);
    // The outcome stays honest: `overridden` means "a violation IS being
    // served", and this database holds none. The armed state is reported
    // separately, not by corrupting this field.
    expect((await health.json()).handle_namespace).toBe("clean");
    booted.proc.kill();
    await booted.proc.exited;
    const stderr = await new Response(booted.proc.stderr as ReadableStream).text();
    expect(stderr).toContain("RM_ALLOW_HANDLE_NAMESPACE_VIOLATION=1 is set");
    expect(stderr).toContain("DISARMED");
    // It is not an override event — no violation was found, and claiming one
    // would send an operator hunting for rows that do not exist.
    expect(stderr).not.toContain("OVERRIDE:");
    expect(stderr).not.toContain("REFUSING");
  },
  180_000,
);

test(
  "a CLEAN database with the override UNSET says nothing about it — the disarmed line is not boot noise",
  async () => {
    // The control for the case above: if that line printed on every boot it
    // would be ignored on the one boot it matters. Same database shape, one
    // variable different.
    const dbName = await createThrowawayDb("unarmedclean");
    const db = postgres(urlFor(dbName), { max: 2, onnotice: () => {} });
    try {
      await applyAllMigrations(db);
      await db`INSERT INTO swarm_members (id, status, name, handle)
               VALUES ('unarmed-a', 'active', 'A', 'unarmed-a-h')`;
    } finally {
      await db.end();
    }

    // Explicitly blank rather than merely absent: spawnApi inherits the
    // caller's environment, and a developer who exported the override in their
    // shell must not silently turn this control into a copy of the case above.
    const booted = await bootAndServe(urlFor(dbName), {
      RM_ALLOW_HANDLE_NAMESPACE_VIOLATION: "",
    });
    const health = await fetch(`http://127.0.0.1:${booted.port}/health`);
    expect((await health.json()).handle_namespace).toBe("clean");
    booted.proc.kill();
    await booted.proc.exited;
    const stderr = await new Response(booted.proc.stderr as ReadableStream).text();
    expect(stderr).not.toContain("DISARMED");
    expect(stderr).not.toContain("RM_ALLOW_HANDLE_NAMESPACE_VIOLATION");
  },
  180_000,
);

test(
  "a PRE-0030 database — swarm_members exists but has no `handle` column — still boots and serves",
  async () => {
    const dbName = await createThrowawayDb("pre0030");
    const db = postgres(urlFor(dbName), { max: 1, onnotice: () => {} });
    try {
      // The exact intermediate the guard's to_regclass + column probe exists
      // for: the table is there, the column the predicate reads is not. This is
      // a database mid-way through its migrations, which is a migration's
      // business and not an integrity violation.
      await db`CREATE TABLE swarm_members (id text PRIMARY KEY, status text NOT NULL, name text NOT NULL)`;
      await db`INSERT INTO swarm_members (id, status, name) VALUES ('pre0030', 'active', 'Pre 0030')`;
    } finally {
      await db.end();
    }
    const booted = await bootAndServe(urlFor(dbName));
    booted.proc.kill();
    await booted.proc.exited;
  },
  120_000,
);

// ── The SECOND boot guard: the append-only guard must be armed (issue #684) ──
//
// Same entrypoint, same production path, and it is graded the same way: a
// database that records migration 0032 as applied and no longer honours it must
// not be served, and everything else must still boot.
//
// The disarmed database is built the way an owner would actually build it — one
// `CREATE OR REPLACE FUNCTION` — precisely because that is the state a trigger
// inventory cannot see. Every trigger still exists here, on every table, all
// reporting tgenabled='A'.

const DISARM_GUARD = `
CREATE OR REPLACE FUNCTION rm_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN IF TG_LEVEL = 'ROW' THEN RETURN OLD; END IF; RETURN NULL; END $$;`;

test(
  "a database whose append-only guard has been disarmed: the api exits non-zero and binds no port",
  async () => {
    const dbName = await createThrowawayDb("disarmed");
    const db = postgres(urlFor(dbName), { max: 2, onnotice: () => {} });
    try {
      await applyAllMigrations(db);

      // Control FIRST: the same database, untouched, boots and serves and says
      // so at /health. Without this, the refusal below is also satisfied by an
      // api that refuses every database.
      const armed = await bootAndServe(urlFor(dbName));
      const armedHealth = await (await fetch(`http://127.0.0.1:${armed.port}/health`)).json();
      expect(armedHealth.append_only_guard).toBe("armed");
      armed.proc.kill();
      await armed.proc.exited;

      await db.unsafe(DISARM_GUARD);
      // The catalog is untouched — this is the whole point of the fixture.
      const [{ n }] = (await db`
        SELECT count(*)::int AS n FROM pg_trigger
        WHERE NOT tgisinternal AND tgname LIKE '%\_append\_only%' AND tgenabled = 'A'
      `) as unknown as { n: number }[];
      expect(n, "every trigger is still installed and still ENABLE ALWAYS").toBeGreaterThan(0);

      const port = await freePort();
      const proc = spawnApi(urlFor(dbName), port, true);
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr as ReadableStream).text();

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("REFUSING the boot: the append-only guard");
      expect(stderr).toContain("a DELETE was ACCEPTED");
      expect(stderr).toContain("will NOT start");
      expect(await portIsBound(port)).toBe(false);

      // The documented escape hatch serves anyway, loudly, and says so at
      // /health for the whole life of the process — an override left set must
      // not be indistinguishable from a healthy boot.
      const overridden = await bootAndServe(urlFor(dbName), { RM_ALLOW_UNARMED_APPEND_ONLY_GUARD: "1" });
      const health = await (await fetch(`http://127.0.0.1:${overridden.port}/health`)).json();
      expect(health.status).toBe("ok");
      expect(health.append_only_guard).toBe("disarmed");
      overridden.proc.kill();
      await overridden.proc.exited;
      expect(await new Response(overridden.proc.stderr as ReadableStream).text()).toContain("OVERRIDE");
    } finally {
      await db.end();
    }
  },
  120_000,
);

test(
  "a database that predates migration 0032 boots normally — 'not applied' is not 'disarmed'",
  async () => {
    // An ordinary first boot, and the distinction that lets the guard above
    // afford to fail closed. `docker compose up -d` starts this process against
    // whatever database exists; refusing one that simply has not been migrated
    // yet would make the guard an outage on every fresh deployment.
    const dbName = await createThrowawayDb("pre0032");
    const db = postgres(urlFor(dbName), { max: 2, onnotice: () => {} });
    try {
      await applyAllMigrations(db);
      // Roll the ledger back to before 0032 and remove what it installed — the
      // shape of a database whose migrate() has not run yet.
      await db.unsafe(`ALTER TABLE schema_migrations DISABLE TRIGGER USER`);
      await db`DELETE FROM schema_migrations WHERE name = '0032_append_only_history.sql'`;
      await db.unsafe(`DROP FUNCTION rm_append_only_guard() CASCADE`);

      const booted = await bootAndServe(urlFor(dbName));
      const health = await (await fetch(`http://127.0.0.1:${booted.port}/health`)).json();
      expect(health.append_only_guard).toBe("not_applied");
      booted.proc.kill();
      await booted.proc.exited;
    } finally {
      await db.end();
    }
  },
  120_000,
);
