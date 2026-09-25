// Shared fixtures for the tests that spawn a REAL database-holding entrypoint
// (`bun run src/api/index.ts`, `bun run src/worker/index.ts`) against a real
// database and grade what the process does at startup (spec §7.2, #1026
// criteria 44, 54, 61 and 120).
//
// WHY A SNAPSHOT BOOTSTRAP. §7.3: "CI end-to-end runs use the production roles
// and the production preflight." A database built by replaying migrations under
// the harness superuser (tests/preload.ts's template) is not what a container
// meets; one bootstrapped from backend/schema/ by rm_owner is — the same path
// `--local blank` takes, with the manifest, the ledger and the grants the boot
// publishes. So every database here starts as a copy of ONE such bootstrap,
// made once per file (`createSnapshotTemplate`), and each test mutates its own
// copy (`copyDatabase`). Never delete-to-reset: a copy per case.
//
// The processes connect as the runtime roles over real logins. Role passwords
// are CLUSTER state; each file sets the ones it uses in its beforeAll.
import net from "node:net";
import { join } from "node:path";
import postgres from "postgres";
import { config } from "../../src/config.ts";
import { bootstrapBlankDatabase, loadSnapshot } from "../../src/db/schema-snapshot.ts";

export const BACKEND_DIR = join(import.meta.dir, "..", "..");

/** A URL for `database` on the suite's server — as the harness superuser, or
 *  as `role` with `password`. */
export function databaseUrl(database: string, role?: { name: string; password: string }): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.name;
    url.password = encodeURIComponent(role.password);
  }
  return url.toString();
}

/** A superuser connection to `database` (default: the maintenance database). */
export function connectAdmin(database = "postgres"): postgres.Sql<{}> {
  return postgres(databaseUrl(database), { max: 1, onnotice: () => {} });
}

function uniqueName(label: string): string {
  return `rmt_${label}_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

/**
 * A blank database owned by rm_owner, bootstrapped from the REAL snapshot
 * (backend/schema/) as rm_owner — pgcrypto installed first as the superuser,
 * because the snapshot lists it as provider-managed. Every connection to it is
 * closed on return, so it can serve as a `CREATE DATABASE … TEMPLATE`.
 */
export async function createSnapshotTemplate(label: string): Promise<string> {
  const name = uniqueName(`${label}_tmpl`);
  const admin = connectAdmin();
  try {
    await admin.unsafe(`CREATE DATABASE ${name} OWNER rm_owner`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const db = connectAdmin(name);
  try {
    await db.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await db.unsafe("SET ROLE rm_owner");
    await bootstrapBlankDatabase(db, await loadSnapshot());
    await db.unsafe("RESET ROLE");
  } finally {
    await db.end({ timeout: 5 });
  }
  return name;
}

/** A file-level copy of `template`, owned by rm_owner. */
export async function copyDatabase(template: string, label: string): Promise<string> {
  const name = uniqueName(label);
  const admin = connectAdmin();
  try {
    await admin.unsafe(`CREATE DATABASE ${name} OWNER rm_owner TEMPLATE ${template}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  return name;
}

export async function dropDatabases(names: readonly string[]): Promise<void> {
  const admin = connectAdmin();
  try {
    for (const name of names) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** True only if something is accepting TCP connections on the port. */
export function portIsBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (bound: boolean) => {
      s.destroy();
      resolve(bound);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

/** A spawned entrypoint whose output is collected as it arrives, so a process
 *  that keeps running can still be read. */
export interface Spawned {
  readonly proc: ReturnType<typeof Bun.spawn>;
  stdout(): string;
  stderr(): string;
  /** Kill it (if still running) and wait for the exit and the last output. */
  stop(): Promise<void>;
}

export function spawnEntrypoint(entry: string, env: Record<string, string | undefined>): Spawned {
  const proc = Bun.spawn(["bun", "run", entry], {
    cwd: BACKEND_DIR,
    env: env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out: string[] = [];
  const err: string[] = [];
  const drain = async (stream: ReadableStream<Uint8Array>, sink: string[]) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) sink.push(decoder.decode(chunk, { stream: true }));
  };
  const drained = Promise.all([
    drain(proc.stdout as ReadableStream<Uint8Array>, out),
    drain(proc.stderr as ReadableStream<Uint8Array>, err),
  ]);
  return {
    proc,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    async stop() {
      if (proc.exitCode === null) proc.kill();
      await proc.exited;
      await drained;
    },
  };
}

/** How an api boot ended: it served /health, or it exited first. */
export type ApiBoot =
  | { readonly outcome: "served"; readonly port: number; readonly run: Spawned }
  | { readonly outcome: "exited"; readonly port: number; readonly code: number; readonly run: Spawned };

/**
 * Spawn `bun run src/api/index.ts` — docker-compose.yml's api command — with
 * `DATABASE_URL` and `RM_ENV` as given, and wait until it either answers
 * /health (served) or exits. Never both: an exit is final, and a served boot
 * is only reported once the port answered.
 */
export async function bootApi(dbUrl: string, env: Record<string, string> = {}): Promise<ApiBoot> {
  const port = await freePort();
  const run = spawnEntrypoint("src/api/index.ts", {
    ...process.env,
    RM_ENV: "stage",
    ...env,
    DATABASE_URL: dbUrl,
    API_PORT: String(port),
  });
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (run.proc.exitCode !== null) {
      await run.stop();
      return { outcome: "exited", port, code: run.proc.exitCode, run };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return { outcome: "served", port, run };
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      await run.stop();
      throw new Error(`api neither served nor exited on :${port}\n${run.stdout()}\n${run.stderr()}`);
    }
    await Bun.sleep(150);
  }
}

/** The `startup_preflight:` lines a process logged, in order, from both streams. */
export function startupLines(run: Spawned): string[] {
  return `${run.stdout()}\n${run.stderr()}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("startup_preflight:"));
}
