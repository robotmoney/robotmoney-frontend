// The reconciliation RUNNER and the `bun run reconcile` command
// (backend/src/db/ledger-reconcile.ts, backend/scripts/reconcile.ts; D66):
// against a clean migration-built Postgres and a temp git repository that
// holds a copy of backend/migrations committed and tagged.
//
// What is proved here and nowhere else: the runner reads schema_migrations
// read-only (the statement log of its connection shows one SELECT and nothing
// else), resolves --pin-ref to a commit with git, hashes the files at that
// commit, writes the receipt, exits nonzero on every verdict but `ok`, and
// turns an unresolvable --pin-ref into `pin-ref-unresolved` with no fallback.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { LEDGER_SQL, hashMigrationsAtCommit, hashMigrationsDir, resolvePinRef, runReconcile, type ReconcileReceipt } from "../src/db/ledger-reconcile.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { sql } from "../src/db/client.ts";

useCleanDatabase(import.meta.file, { migrationBuilt: true });

const BACKEND = join(import.meta.dir, "..");
const REAL_MIGRATIONS = join(BACKEND, "migrations");
const TAG = "v0.6.1-test";

/** The temp repository: <root>/backend/migrations, committed and tagged. */
let root = "";
let migrationsDir = "";
let tagCommit = "";

function git(args: readonly string[], cwd = root): string {
  const proc = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${Buffer.from(proc.stderr).toString()}`);
  return Buffer.from(proc.stdout).toString("utf8").trim();
}

/** The clean database's URL, for the command and for a logged connection. */
async function databaseUrl(): Promise<string> {
  const [row] = (await sql`SELECT current_database() AS db`) as unknown as { db: string }[];
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${row!.db}`;
  return url.toString();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rm-reconcile-repo-"));
  migrationsDir = join(root, "backend", "migrations");
  mkdirSync(migrationsDir, { recursive: true });
  cpSync(REAL_MIGRATIONS, migrationsDir, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "the release"]);
  git(["tag", TAG]);
  tagCommit = git(["rev-parse", `${TAG}^{commit}`]);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** The driver's own startup query (the array-type catalog read) is logged too; the
 *  runner's statements are the rest. Every one must be a SELECT, and exactly one
 *  reads the ledger. */
const ledgerReads = (statements: readonly string[]): string[] => statements.filter((s) => /schema_migrations/.test(s));
const nonSelects = (statements: readonly string[]): string[] => statements.filter((s) => !/^\s*select\b/i.test(s));

/** A connection whose every statement is logged, for the read-only proof. */
function loggedConnection(url: string): { db: postgres.Sql<{}>; statements: string[] } {
  const statements: string[] = [];
  const db = postgres(url, { max: 1, onnotice: () => {}, debug: (_conn, query) => statements.push(query) });
  return { db, statements };
}

async function run(over: { pinRef?: string; dir?: string; intended?: readonly string[] } = {}): Promise<{ receipt: ReconcileReceipt; statements: string[] }> {
  const { db, statements } = loggedConnection(await databaseUrl());
  try {
    const receipt = await runReconcile({
      migrationsDir: over.dir ?? migrationsDir,
      db,
      ...(over.pinRef === undefined ? {} : { pinRef: over.pinRef }),
      ...(over.intended === undefined ? {} : { intended: over.intended }),
    });
    return { receipt, statements };
  } finally {
    await db.end({ timeout: 5 });
  }
}

async function command(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "scripts/reconcile.ts", "--migrations-dir", migrationsDir, ...args], {
    cwd: BACKEND,
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: await databaseUrl() },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

describe("the runner against a migration-built database and a tagged checkout", () => {
  test("reads the ledger read-only: the statement log shows one SELECT and nothing else", async () => {
    const { receipt, statements } = await run({ pinRef: TAG });
    expect(ledgerReads(statements)).toEqual([LEDGER_SQL]);
    expect(nonSelects(statements)).toEqual([]);
    expect(receipt.verdict).toBe("ok");
  });

  test("resolves --pin-ref to the tag's commit, hashes every applied file at it, and every one matches", async () => {
    const { receipt } = await run({ pinRef: TAG });
    expect(receipt.pinRef).toBe(TAG);
    expect(receipt.pinCommit).toBe(tagCommit);
    const ledger = (await sql`SELECT name FROM schema_migrations ORDER BY name`).map((r) => (r as { name: string }).name);
    expect(receipt.ledgerSize).toBe(ledger.length);
    expect(receipt.repoSize).toBe(readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).length);
    expect(receipt.pending).toEqual([]);
    expect(receipt.missingFromRepo).toEqual([]);
    expect(receipt.perFile.map((f) => f.name)).toEqual(ledger);
    expect(receipt.perFile.every((f) => f.verdict === "match" && f.pinSha256 === f.sha256)).toBe(true);
    expect(receipt.migrationsDir).toBe(migrationsDir);
    expect(Date.parse(receipt.readAt)).toBeGreaterThan(Date.now() - 60_000);
    // The commit resolves the same way directly, and a short SHA resolves too.
    expect(resolvePinRef(migrationsDir, TAG)).toBe(tagCommit);
    expect(resolvePinRef(migrationsDir, tagCommit.slice(0, 10))).toBe(tagCommit);
    expect(hashMigrationsAtCommit(migrationsDir, tagCommit)).toEqual(hashMigrationsDir(migrationsDir));
  });

  test("an unresolvable --pin-ref yields pin-ref-unresolved, no commit, no perFile: no fallback to HEAD or the checkout", async () => {
    const { receipt } = await run({ pinRef: "v9.9.9" });
    expect(receipt.verdict).toBe("pin-ref-unresolved");
    expect({ pinRef: receipt.pinRef, pinCommit: receipt.pinCommit, perFile: receipt.perFile }).toEqual({ pinRef: "v9.9.9", pinCommit: null, perFile: [] });
    expect(resolvePinRef(migrationsDir, "v9.9.9")).toBeNull();
    // A ref spelled as an option is never handed to git.
    expect(resolvePinRef(migrationsDir, "--output=/tmp/x")).toBeNull();
  });

  test("no --pin-ref: checks 1 and 2 only; the receipt claims nothing about bytes", async () => {
    const { receipt, statements } = await run();
    expect(ledgerReads(statements)).toEqual([LEDGER_SQL]);
    expect(nonSelects(statements)).toEqual([]);
    expect(receipt.verdict).toBe("ok");
    expect({ pinRef: receipt.pinRef, pinCommit: receipt.pinCommit, perFile: receipt.perFile }).toEqual({ pinRef: null, pinCommit: null, perFile: [] });
  });

  test("an applied file edited after the tag: bytes-differ with the checkout's and the tag's sha256", async () => {
    const edited = "0001_backends.sql";
    const before = hashMigrationsDir(migrationsDir).get(edited)!;
    appendFileSync(join(migrationsDir, edited), "\n-- edited after it ran\n");
    try {
      const { receipt } = await run({ pinRef: TAG });
      expect(receipt.verdict).toBe("bytes-differ");
      const file = receipt.perFile.find((f) => f.name === edited)!;
      expect(file.verdict).toBe("bytes-differ");
      expect(file.pinSha256).toBe(before);
      expect(file.sha256).not.toBe(before);
      expect(receipt.perFile.filter((f) => f.verdict !== "match")).toEqual([file]);
    } finally {
      git(["checkout", "--", join("backend", "migrations", edited)]);
    }
    expect((await run({ pinRef: TAG })).receipt.verdict).toBe("ok");
  });

  test("a ledger name the checkout lacks: ledger-not-subset naming it, and the pending set still reported", async () => {
    const removed = "0121_subject_closes_six_hours_apart.sql";
    unlinkSync(join(migrationsDir, removed));
    writeFileSync(join(migrationsDir, "0122_new_pending.sql"), "-- compat: additive\n-- metadata_version: 1\nSELECT 1;\n");
    try {
      const { receipt } = await run({ pinRef: TAG });
      expect(receipt.verdict).toBe("ledger-not-subset");
      expect(receipt.missingFromRepo).toEqual([removed]);
      expect(receipt.pending).toEqual(["0122_new_pending.sql"]);
    } finally {
      git(["checkout", "--", join("backend", "migrations", removed)]);
      unlinkSync(join(migrationsDir, "0122_new_pending.sql"));
    }
  });

  test("an intended list that differs from the pending set: unexpected-pending naming the difference", async () => {
    writeFileSync(join(migrationsDir, "0122_new_pending.sql"), "SELECT 1;\n");
    try {
      const { receipt } = await run({ pinRef: TAG, intended: ["0123_something_else.sql"] });
      expect(receipt.verdict).toBe("unexpected-pending");
      expect(receipt.unexpectedPending).toEqual(["0122_new_pending.sql", "0123_something_else.sql"]);
      expect((await run({ pinRef: TAG, intended: ["0122_new_pending.sql"] })).receipt.verdict).toBe("ok");
    } finally {
      unlinkSync(join(migrationsDir, "0122_new_pending.sql"));
    }
  });
});

describe("`bun run reconcile --pin-ref <ref> --json` (backend/scripts/reconcile.ts)", () => {
  test("prints the receipt as JSON and exits 0 on ok", async () => {
    const { code, stdout } = await command(["--pin-ref", TAG, "--json"]);
    expect(code).toBe(0);
    const receipt = JSON.parse(stdout) as ReconcileReceipt;
    expect(receipt.verdict).toBe("ok");
    expect(receipt.pinCommit).toBe(tagCommit);
    expect(receipt.perFile.length).toBeGreaterThan(100);
  }, 30_000);

  test("exits 1 on pin-ref-unresolved, with the receipt still printed", async () => {
    const { code, stdout } = await command(["--pin-ref", "v9.9.9", "--json"]);
    expect(code).toBe(1);
    expect((JSON.parse(stdout) as ReconcileReceipt).verdict).toBe("pin-ref-unresolved");
  }, 30_000);

  test("exits 1 on bytes-differ, and the one-line form names the file and both hashes", async () => {
    appendFileSync(join(migrationsDir, "0002_dashboards.sql"), "\n-- edited\n");
    try {
      const { code, stdout } = await command(["--pin-ref", TAG]);
      expect(code).toBe(1);
      expect(stdout).toContain("bytes-differ");
      expect(stdout).toContain("0002_dashboards.sql (checkout ");
    } finally {
      git(["checkout", "--", join("backend", "migrations", "0002_dashboards.sql")]);
    }
  }, 30_000);

  test("refuses with exit 2 when --pin-ref has no value or DATABASE_URL is unset", async () => {
    expect((await command(["--pin-ref"])).code).toBe(2);
    const child = Bun.spawn(["bun", "scripts/reconcile.ts"], { cwd: BACKEND, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(2);
  }, 30_000);
});
