// A shipped release's database, rebuilt from its own migration bytes, and the
// operator's terminal in front of `bun run migrate` — shared by the two test
// files that start from a release: upgrade-from-release.test.ts (spec §8.4's
// "an upgrade from a populated database of each supported release passes its
// data assertions") and first-production-migrate.test.ts (§9.1's first
// production migrate, D55 (5)).
//
// WHERE A RELEASE'S SCHEMA COMES FROM. Each release directory here holds a
// release.json recording a sha256 per migration file, taken from the tag. A
// file whose bytes on this branch still match is read from backend/migrations/;
// a file edited after the tag is kept verbatim under <tag>/migrations/ —
// v0.5.0's 0053_database_role_taxonomy.sql is one (it said NOLOGIN for
// rm_owner, the branch says LOGIN). upgrade-from-release.test.ts fails when a
// file drifts from its recorded hash without a verbatim copy. No git is
// needed: CI's checkout is shallow and carries no tags.
//
// A BASELINE (`loadBaseline`) is a release plus files its target applied out
// of band — production's observed ledger (backend/src/db/supported-releases.ts).
// Its directory holds baseline.json and the out-of-band files' archived bytes.
//
// HOW IT IS BUILT. The way the release built itself: v0.5.0's runner
// (backend/src/db/migrate.ts at the tag) applies each file in its own
// transaction and switches to `SET LOCAL ROLE rm_owner` from 0054 on.
//
// HOW IT IS MIGRATED. Through the operator's command, as a PROCESS under a
// pseudo-terminal (`script`), so `process.stdin.isTTY` is true and the real
// masked rm_owner prompt and the real `y/n` run: `migrateAtTerminal`. Nothing
// here reaches past the command into the run.
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

export const BACKEND_DIR = join(import.meta.dir, "..", "..", "..");
export const MIGRATIONS_DIR = join(BACKEND_DIR, "migrations");
export const RELEASES_DIR = import.meta.dir;
/** Every migration file on this branch, in filename (apply) order. */
export const HEAD_FILES = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

export interface ReleaseFixture {
  readonly tag: string;
  readonly commit: string;
  /** What the release itself seeded and could queue — read from the tag, not
   *  from the migrations under test (see release.json's `source`). */
  readonly swarm: {
    readonly source: string;
    readonly scheduleKinds: readonly string[];
    readonly jobKinds: readonly string[];
  };
  readonly migrations: readonly { readonly file: string; readonly sha256: string }[];
  /** Where a file's verbatim bytes are looked for, in order, before the
   *  branch's own. Absent: the tag's own `<tag>/migrations/`. */
  readonly verbatimDirs?: readonly string[];
}

export function loadRelease(tag: string): ReleaseFixture {
  return JSON.parse(readFileSync(join(RELEASES_DIR, tag, "release.json"), "utf8")) as ReleaseFixture;
}

/** The release's own bytes for one file: the verbatim copy when the branch
 *  edited it after the tag, otherwise the branch's file. */
export function releaseBytes(tag: string, file: string): Buffer {
  return fixtureBytes({ verbatimDirs: [join(RELEASES_DIR, tag, "migrations")] }, file);
}

/** A fixture's own bytes for one file: the first verbatim copy found, else the branch's file. */
export function fixtureBytes(fixture: Pick<ReleaseFixture, "verbatimDirs">, file: string): Buffer {
  for (const dir of fixture.verbatimDirs ?? []) {
    const pinned = join(dir, file);
    if (existsSync(pinned)) return readFileSync(pinned);
  }
  return readFileSync(join(MIGRATIONS_DIR, file));
}

/**
 * A SUPPORTED_RELEASES baseline as the target's ledger records it: a release
 * tag, plus files applied to that target out of band (spec §9.1, D55 (5)).
 * Its fixture directory holds baseline.json — the observed ledger, and each
 * out-of-band file's sha256 and provenance — and each out-of-band file's
 * verbatim bytes under migrations/.
 */
export interface BaselineFixture extends ReleaseFixture {
  /** The release tag the baseline starts from. */
  readonly release: string;
  readonly outOfBand: readonly {
    readonly file: string;
    readonly sha256: string;
    readonly source: string;
    readonly appliedAt: string;
  }[];
  /** The ledger as it was read from the target, in filename order. */
  readonly ledger: readonly { readonly file: string; readonly appliedAt: string }[];
}

/** The fixture of the baseline named `name` (a SUPPORTED_RELEASES `name`). As
 *  a ReleaseFixture its `tag` is that name, its `migrations` the release's
 *  plus the out-of-band files, and its swarm record the release's own. */
export function loadBaseline(name: string): BaselineFixture {
  for (const entry of readdirSync(RELEASES_DIR, { withFileTypes: true })) {
    const path = join(RELEASES_DIR, entry.name, "baseline.json");
    if (!entry.isDirectory() || !existsSync(path)) continue;
    const baseline = JSON.parse(readFileSync(path, "utf8")) as Omit<BaselineFixture, "tag" | "commit" | "swarm" | "migrations"> & {
      readonly name: string;
    };
    if (baseline.name !== name) continue;
    const release = loadRelease(baseline.release);
    return {
      ...baseline,
      tag: name,
      commit: release.commit,
      swarm: release.swarm,
      migrations: [...release.migrations, ...baseline.outOfBand.map(({ file, sha256 }) => ({ file, sha256 }))].sort(
        (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
      ),
      verbatimDirs: [join(RELEASES_DIR, entry.name, "migrations"), join(RELEASES_DIR, release.tag, "migrations")],
    };
  }
  throw new Error(`no fixture under ${RELEASES_DIR} has a baseline.json named ${JSON.stringify(name)}`);
}

/** One file as the release runner applies it: `file` is the name the ledger
 *  records, `ddl` the bytes it runs. */
export interface RunnerStep {
  readonly file: string;
  readonly ddl: string;
}

/** The release's steps, its own bytes under its own names. */
export function releaseSteps(release: ReleaseFixture): RunnerStep[] {
  return release.migrations.map(({ file }) => ({
    file,
    ddl: (release.verbatimDirs ? fixtureBytes(release, file) : releaseBytes(release.tag, file)).toString("utf8"),
  }));
}

/** v0.5.0's runner loop (backend/src/db/migrate.ts at the tag): one
 *  transaction per file, `SET LOCAL ROLE rm_owner` from 0054 on, a ledger row
 *  per file. */
export async function applyAsReleaseRunner(db: postgres.Sql<{}>, steps: readonly RunnerStep[]): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const { file, ddl } of steps) {
    await db.begin(async (tx) => {
      if (file >= "0054_rm_worker_allowlist.sql") await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(ddl);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
  }
}

/**
 * The runtime roles' cluster-wide login attribute AND password, as they were.
 *
 * Role attributes are CLUSTER-wide. v0.5.0's 0053 says `ALTER ROLE rm_owner
 * NOLOGIN`, and a test driving `bun run migrate` sets passwords on rm_owner and
 * rm_readonly; later files in this suite log in as those roles or read their
 * LOGIN attribute as evidence of what the branch's 0053 did. So both are
 * recorded first and put back exactly — the password as the stored verifier
 * `pg_authid` holds, which `ALTER ROLE … PASSWORD` accepts as already hashed.
 */
export interface SavedRole {
  readonly rolname: string;
  readonly rolcanlogin: boolean;
  readonly rolpassword: string | null;
}

export async function saveRoles(db: postgres.Sql<{}>): Promise<SavedRole[]> {
  return (await db`
    SELECT rolname, rolcanlogin, rolpassword FROM pg_authid
    WHERE rolname IN ('rm_owner', 'rm_app', 'rm_worker', 'rm_readonly') ORDER BY rolname`) as unknown as SavedRole[];
}

/** Put back the login attributes only — what a release's 0053 changed. */
export async function restoreLogins(db: postgres.Sql<{}>, saved: readonly SavedRole[]): Promise<void> {
  for (const role of saved) await db.unsafe(`ALTER ROLE ${role.rolname} ${role.rolcanlogin ? "LOGIN" : "NOLOGIN"}`);
}

/** Put back the login attributes and the stored passwords. */
export async function restoreRoles(db: postgres.Sql<{}>, saved: readonly SavedRole[]): Promise<void> {
  await restoreLogins(db, saved);
  for (const role of saved) {
    await db.unsafe(`ALTER ROLE ${role.rolname} PASSWORD ${role.rolpassword === null ? "NULL" : `'${role.rolpassword}'`}`);
  }
}

/**
 * The harness login stands in for the provider's admin. Migration 0016 sets
 * default privileges FOR the login that runs it; in production that login is
 * doadmin, which the snapshot's provider exclusion list covers. This harness
 * builds as its own superuser, so those two default ACLs are removed — the
 * production shape — before a first manifest's §9.1 step 2 baseline, which
 * then passes for the reason production's would. Nothing else is adjusted.
 */
export async function revokeLoginDefaults(db: postgres.Sql<{}>, login: string): Promise<void> {
  await db.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE "${login}" IN SCHEMA public REVOKE ALL ON TABLES FROM rm_worker`);
  await db.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE "${login}" IN SCHEMA public REVOKE ALL ON SEQUENCES FROM rm_worker`);
}

/** What the operator types, in order: wait for `await` on the screen, then
 *  type `send` and Enter. */
export interface TerminalStep {
  readonly await: string;
  readonly send: string;
}

export interface TerminalRun {
  readonly code: number;
  /** Everything the terminal showed, prompts included. */
  readonly screen: string;
  /** The operator's `$HOME`, holding the `.env`; the caller removes it. */
  readonly home: string;
  /** The directory the receipt (and the journal beside it) go to. */
  readonly receiptDir: string;
  readonly receiptPath: string;
}

/**
 * `bun run migrate` (backend/scripts/migrate.ts) as an operator runs it: a
 * `$HOME/.env` holding the connection values and an `rm_readonly` line, RM_ENV
 * in the environment, a real terminal. Each step waits for its prompt and types
 * its answer; a process that exits before a prompt it would have shown simply
 * leaves the remaining steps untyped — which is how a refusal at the gates
 * looks from the terminal.
 */
export async function migrateAtTerminal(options: {
  readonly databaseUrl: URL;
  readonly readonlyPassword: string;
  readonly rmEnv: string;
  readonly steps: readonly TerminalStep[];
  readonly timeoutMs?: number;
}): Promise<TerminalRun> {
  const home = mkdtempSync(join(tmpdir(), "rm-operator-"));
  const url = options.databaseUrl;
  writeFileSync(
    join(home, ".env"),
    [
      `host = ${url.hostname}`,
      `port = ${url.port || "5432"}`,
      `database = ${url.pathname.slice(1)}`,
      "sslmode = disable",
      `rm_readonly = ${options.readonlyPassword}`,
      "",
    ].join("\n"),
    "utf8",
  );
  const receiptDir = join(home, "receipts");
  const receiptPath = join(receiptDir, "migrate-receipt.json");
  const child = Bun.spawn(["script", "-qefc", `bun scripts/migrate.ts --receipt ${receiptPath}`, "/dev/null"], {
    cwd: BACKEND_DIR,
    env: { PATH: process.env.PATH ?? "", HOME: home, RM_ENV: options.rmEnv, TERM: "dumb" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let screen = "";
  const decoder = new TextDecoder();
  const pump = (async () => {
    for await (const chunk of child.stdout) screen += decoder.decode(chunk);
  })();
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  try {
    let from = 0;
    for (const step of options.steps) {
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`bun run migrate did not exit in time; terminal so far:\n${screen}`)),
        Math.max(0, deadline - Date.now()),
      );
    });
    let code: number;
    try {
      code = await Promise.race([child.exited, late]);
    } finally {
      clearTimeout(timer);
    }
    await pump;
    return { code, screen, home, receiptDir, receiptPath };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    try {
      child.stdin.end();
    } catch {
      // already closed with the process
    }
  }
}
