// The PRODUCTION boot path refuses a restored handle/id namespace violation
// (issue #602).
//
// WHAT MAKES THIS THE PRODUCTION PATH. docker-compose.yml's api service runs
// `command: ["bun", "run", "src/api/index.ts"]`, and that is the whole bring-up
// documented at docs/runbooks/deployment.md — no migrate step, no
// scripts/db-preflight.ts. So this file spawns THAT file, as a real process,
// against a real database, and grades the process: a violating database must
// produce a non-zero exit with both members named and NO port bound, and every
// other database shape must still boot and serve.
//
// Booting is graded as strictly as refusing. A fail-closed guard on the
// entrypoint is an availability risk if it is wrong, and the three shapes below
// — empty, pre-0030 (a swarm_members with no `handle` column), and migrated but
// clean — are the ones an ordinary first boot actually meets.
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

function spawnApi(dbUrl: string, port: number, capture: boolean): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bun", "run", "src/api/index.ts"], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: dbUrl, API_PORT: String(port) },
    stdout: capture ? "pipe" : "ignore",
    stderr: "pipe",
  });
}

/** Boot the api and wait until /health answers — the proof it reached serving
 *  traffic. Fails loudly (never silently passes) if the process exits first. */
async function bootAndServe(dbUrl: string): Promise<Booted> {
  const port = await freePort();
  const proc = spawnApi(dbUrl, port, false);
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
      // Refused BEFORE Bun.serve: nothing was ever bound, so no request was
      // ever answered from this database.
      expect(await portIsBound(port)).toBe(false);

      // Positive control on the SAME database: once the operator moves one of
      // the two public names, the very same command serves. Without this the
      // test above is also satisfied by a guard that refuses everything.
      await db`UPDATE swarm_members SET handle = ${`${holder}-h`} WHERE id = ${holder}`;
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
