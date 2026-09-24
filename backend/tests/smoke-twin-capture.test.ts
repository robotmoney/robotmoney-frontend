// Tests for backend/scripts/smoke-twin-capture.ts (`bun smoke:capture`).
//
// Two halves. The first pins the pure decisions that decide WHETHER to dump:
//   - writing a copy of production plus its passphrase into the git checkout;
//   - starting a long dump with a client too old to finish it.
// The second runs main() for real (issue #1026, criterion 37 [smoke-capture]):
// capture connects as rm_readonly to a node that serves reads, performs no
// write, and refuses a primary or a non-readonly credential. There is no
// override (D53 decision 5), so every refusal below is an exit 2.
//
//   - against the suite's ephemeral Postgres, which is a PRIMARY: a clean
//     rm_readonly is refused as a primary, and each kind of write capability is
//     refused as a non-readonly credential before the node is even considered;
//   - a planted write fails inside the read-only session the capture opens, and
//     inside a libpq session carrying the PGOPTIONS the dump runs with;
//   - against a real hot standby (a second container restarted with
//     standby.signal, so pg_is_in_recovery() is true and it serves reads): the
//     capture completes, and pg_dump and pg_dumpall both ran read-only.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { POSTGRES_IMAGE } from "../../scripts/lib/postgres-image.ts";
import { dockerLabelFlags, resolveStackEnvironment, stackLabels, stackProjectName } from "../../scripts/stack/naming.ts";
import { connectReadOnly } from "../scripts/lib/preflight-utils.ts";
import {
  assertOutsideRepo,
  clientVersionComplaint,
  main,
  majorOf,
  parseArgs,
  probeCaptureTarget,
  READ_ONLY_PGOPTIONS,
} from "../scripts/smoke-twin-capture.ts";

describe("parseArgs", () => {
  test("defaults to the same backup dir resolveBackupFiles() defaults to", () => {
    const a = parseArgs([]);
    expect("error" in a).toBe(false);
    if ("error" in a) return;
    expect(a.out).toMatch(/rm-backup-v022$/);
    expect(a.envFile).toMatch(/\.env$/);
    expect(a.envFile).not.toContain("readonly");
  });

  test("--out and --env-file override", () => {
    const a = parseArgs(["--out", "/srv/b", "--env-file", "/srv/e"]);
    if ("error" in a) throw new Error(a.error);
    expect(a.out).toBe("/srv/b");
    expect(a.envFile).toBe("/srv/e");
  });

  test("--allow-primary no longer exists: it is an unknown flag, never a silent switch (D53 decision 5)", () => {
    expect(parseArgs(["--allow-primary"])).toEqual({ error: 'unknown flag "--allow-primary".' });
  });

  test("a flag missing its value is an error, not a silent default", () => {
    expect(parseArgs(["--out"])).toEqual({ error: "--out requires a value." });
  });

  test("an unknown flag is rejected", () => {
    expect(parseArgs(["--dump-everything"])).toEqual({ error: 'unknown flag "--dump-everything".' });
  });

  describe("RM_BACKUP_DIR — the runbook exports it and restore-check reads it, so capture must too", () => {
    const PREV = process.env.RM_BACKUP_DIR;
    const PREV_HOME = process.env.HOME;

    afterEach(() => {
      if (PREV === undefined) delete process.env.RM_BACKUP_DIR;
      else process.env.RM_BACKUP_DIR = PREV;
      if (PREV_HOME === undefined) delete process.env.HOME;
      else process.env.HOME = PREV_HOME;
    });

    test("RM_BACKUP_DIR becomes the default output dir when --out is absent", () => {
      process.env.RM_BACKUP_DIR = "/srv/rm-backup-v042";
      const a = parseArgs([]);
      if ("error" in a) throw new Error(a.error);
      expect(a.out).toBe("/srv/rm-backup-v042");
    });

    test("--out still wins over an exported RM_BACKUP_DIR", () => {
      process.env.RM_BACKUP_DIR = "/srv/rm-backup-v042";
      const a = parseArgs(["--out", "/srv/explicit"]);
      if ("error" in a) throw new Error(a.error);
      expect(a.out).toBe("/srv/explicit");
    });

    test("an empty RM_BACKUP_DIR falls back to the home default", () => {
      process.env.RM_BACKUP_DIR = "   ";
      const a = parseArgs([]);
      if ("error" in a) throw new Error(a.error);
      expect(a.out).toMatch(/rm-backup-v022$/);
    });
  });
});

describe("assertOutsideRepo — the backup must never land in the checkout", () => {
  test("refuses the repo root itself", () => {
    expect(() => assertOutsideRepo("/repo", "/repo")).toThrow(/inside the checkout/);
  });

  test("refuses a subdirectory of the checkout", () => {
    expect(() => assertOutsideRepo("/repo/backups", "/repo")).toThrow(/inside the checkout/);
  });

  test("refuses it with a trailing slash too", () => {
    expect(() => assertOutsideRepo("/repo/", "/repo")).toThrow(/inside the checkout/);
  });

  test("allows a sibling whose name merely starts the same way", () => {
    // /repo-backups is NOT inside /repo — a naive startsWith would say it was.
    expect(() => assertOutsideRepo("/repo-backups", "/repo")).not.toThrow();
  });

  test("allows the ordinary home-directory default", () => {
    expect(() => assertOutsideRepo("/root/rm-backup-v022", "/repo")).not.toThrow();
  });
});

describe("client/server version rule", () => {
  test("majorOf reads the major out of the strings psql and pg_dump print", () => {
    expect(majorOf("18.6 (Ubuntu 18.6-1.pgdg24.04+2)")).toBe(18);
    expect(majorOf("16.4")).toBe(16);
    expect(majorOf("nonsense")).toBeNull();
  });

  test("an OLDER client is refused — pg_dump cannot dump from a newer server", () => {
    // The real pairing: Ubuntu 24.04 ships client 16, this repo runs server 18.
    const c = clientVersionComplaint(16, 18);
    expect(c).toBeDefined();
    expect(c).toMatch(/postgresql-client-18/);
  });

  test("equal or newer client is fine", () => {
    expect(clientVersionComplaint(18, 18)).toBeUndefined();
    expect(clientVersionComplaint(19, 18)).toBeUndefined();
  });

  test("unknown versions do not block the dump — the guard refuses to guess", () => {
    expect(clientVersionComplaint(null, 18)).toBeUndefined();
    expect(clientVersionComplaint(18, null)).toBeUndefined();
  });
});

// ── main(), for real ────────────────────────────────────────────────────────

const READONLY_PASSWORD = "capture-test-pw";
const WRITER = "rm_capture_writer_test";
const WRITER_PASSWORD = "capture-writer-pw";

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

/** Run main() and keep everything it printed to stderr. */
async function runCapture(argv: string[]): Promise<{ code: number; stderr: string }> {
  const lines: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.log = () => {};
  try {
    const code = await main(argv);
    return { code, stderr: lines.join("\n") };
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
}

function writeEnv(dir: string, host: string, port: string, database: string): string {
  const path = join(dir, "capture.env");
  writeFileSync(
    path,
    [`host=${host}`, `port=${port}`, `database=${database}`, "sslmode=disable", `rm_readonly=${READONLY_PASSWORD}`].join(
      "\n",
    ),
  );
  return path;
}

// main() sets umask 077 for its own artifacts; the suite shares one process,
// so the next file must get the umask it started with back.
const savedUmask = process.umask(0o022);
process.umask(savedUmask);

describe("smoke:capture against the suite's PRIMARY — every non-readonly credential and the primary itself refuse", () => {
  const base = new URL(process.env.DATABASE_URL as string);
  const database = `smoke_capture_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let admin: postgres.Sql;
  let adminDb: postgres.Sql;
  let dir: string;
  let envPath: string;

  beforeAll(async () => {
    admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    // rm_readonly is cluster-wide (migration 0053 creates it with no password);
    // give it one for the length of this file, and a writer beside it.
    await admin.unsafe(`ALTER ROLE rm_readonly PASSWORD '${READONLY_PASSWORD}'`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${WRITER}`);
    await admin.unsafe(`CREATE ROLE ${WRITER} LOGIN PASSWORD '${WRITER_PASSWORD}'`);
    const u = new URL(base.toString());
    u.pathname = `/${database}`;
    adminDb = postgres(u.toString(), { max: 1, onnotice: () => {} });
    await adminDb.unsafe("CREATE TABLE public.planted (id int PRIMARY KEY, note text)");
    await adminDb.unsafe("INSERT INTO public.planted VALUES (1, 'before')");
    await adminDb.unsafe("GRANT SELECT ON public.planted TO rm_readonly");
    await adminDb.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.planted TO ${WRITER}`);
    dir = mkdtempSync(join(tmpdir(), "rm-capture-primary-"));
    envPath = writeEnv(dir, base.hostname, base.port, database);
  });

  afterEach(() => process.umask(savedUmask));

  afterAll(async () => {
    await adminDb.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${WRITER}`);
    await admin.unsafe("ALTER ROLE rm_readonly PASSWORD NULL");
    await admin.end({ timeout: 5 });
    rmSync(dir, { recursive: true, force: true });
  });

  /** Each case gets its own --out, so "wrote nothing" is checkable. */
  function freshOut(): string {
    return join(dir, `out-${crypto.randomUUID()}`);
  }

  test("a clean rm_readonly on a primary exits 2, and nothing is written", async () => {
    const out = freshOut();
    const r = await runCapture(["--out", out, "--env-file", envPath]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("pg_is_in_recovery() is FALSE");
    expect(r.stderr).toContain("There is no override");
    // Refused before the directory, the passphrase or a dump existed.
    expect(existsSync(out)).toBe(false);
  });

  test("rm_readonly holding INSERT on a table exits 2 as a non-readonly credential", async () => {
    await adminDb.unsafe("GRANT INSERT ON public.planted TO rm_readonly");
    try {
      const out = freshOut();
      const r = await runCapture(["--out", out, "--env-file", envPath]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("not a read-only credential");
      expect(r.stderr).toContain("table public.planted: INSERT");
      expect(existsSync(out)).toBe(false);
    } finally {
      await adminDb.unsafe("REVOKE INSERT ON public.planted FROM rm_readonly");
    }
  });

  test("rm_readonly holding CREATE on a schema exits 2", async () => {
    await adminDb.unsafe("GRANT CREATE ON SCHEMA public TO rm_readonly");
    try {
      const r = await runCapture(["--out", freshOut(), "--env-file", envPath]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("schema public: CREATE");
    } finally {
      await adminDb.unsafe("REVOKE CREATE ON SCHEMA public FROM rm_readonly");
    }
  });

  test("rm_readonly holding CREATE on the database exits 2", async () => {
    await admin.unsafe(`GRANT CREATE ON DATABASE ${database} TO rm_readonly`);
    try {
      const r = await runCapture(["--out", freshOut(), "--env-file", envPath]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`database ${database}: CREATE`);
    } finally {
      await admin.unsafe(`REVOKE CREATE ON DATABASE ${database} FROM rm_readonly`);
    }
  });

  test("rm_readonly as a (NOINHERIT) member of a writer role exits 2", async () => {
    await admin.unsafe(`GRANT ${WRITER} TO rm_readonly`);
    try {
      const r = await runCapture(["--out", freshOut(), "--env-file", envPath]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`member of ${WRITER}`);
    } finally {
      await admin.unsafe(`REVOKE ${WRITER} FROM rm_readonly`);
    }
  });

  test("rm_readonly carrying a role attribute exits 2", async () => {
    await admin.unsafe("ALTER ROLE rm_readonly CREATEDB");
    try {
      const r = await runCapture(["--out", freshOut(), "--env-file", envPath]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("carries CREATEDB");
    } finally {
      await admin.unsafe("ALTER ROLE rm_readonly NOCREATEDB");
    }
  });

  test("a login that lands as another role (current_user is not rm_readonly) exits 2", async () => {
    // `ALTER ROLE … SET role` makes every rm_readonly login run as the writer:
    // the credential's NAME is right and the session it opens is not.
    await admin.unsafe(`GRANT ${WRITER} TO rm_readonly`);
    await admin.unsafe(`ALTER ROLE rm_readonly IN DATABASE ${database} SET role = ${WRITER}`);
    try {
      const r = await runCapture(["--out", freshOut(), "--env-file", envPath]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`current_user '${WRITER}', not 'rm_readonly'`);
    } finally {
      await admin.unsafe(`ALTER ROLE rm_readonly IN DATABASE ${database} RESET role`);
      await admin.unsafe(`REVOKE ${WRITER} FROM rm_readonly`);
    }
  });

  test("a planted write fails inside the capture's read-only session, even for a role that holds the grant", async () => {
    const u = new URL(base.toString());
    u.pathname = `/${database}`;
    u.username = WRITER;
    u.password = WRITER_PASSWORD;
    const { db } = await connectReadOnly(u.toString(), "smoke-twin-capture");
    try {
      const probe = await probeCaptureTarget(db);
      expect(probe.transactionReadOnly).toBe("on");
      expect(probe.writeCapabilities).toContain("table public.planted: INSERT, UPDATE, DELETE");
      let code: string | undefined;
      try {
        await db.unsafe("INSERT INTO public.planted VALUES (2, 'planted')");
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      // 25006 read_only_sql_transaction: the SERVER refused it, not a grant.
      expect(code).toBe("25006");
    } finally {
      await db.end({ timeout: 5 });
    }
    const rows = await adminDb.unsafe("SELECT id FROM public.planted ORDER BY id");
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  test("a planted write fails inside a libpq session carrying the dump's PGOPTIONS", () => {
    const container = process.env.RM_TEST_PG_CONTAINER;
    if (!container) throw new Error("RM_TEST_PG_CONTAINER is not set — tests/preload.ts must publish it");
    const p = Bun.spawnSync([
      "docker", "exec", "-e", `PGOPTIONS=${READ_ONLY_PGOPTIONS}`, container,
      "psql", "-v", "ON_ERROR_STOP=1", "-U", WRITER, "-d", database,
      "-c", "INSERT INTO public.planted VALUES (3, 'planted')",
    ]);
    expect(p.exitCode).not.toBe(0);
    expect(p.stderr.toString()).toContain("cannot execute INSERT in a read-only transaction");
  });
});

describe("smoke:capture against a real hot standby — the node that serves reads", () => {
  const environment = resolveStackEnvironment(process.env);
  const name = `${stackProjectName("pgtest", environment)}_capture_standby`;
  let dir: string;
  const savedPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = savedPath;
    process.umask(savedUmask);
  });

  afterAll(() => {
    Bun.spawnSync(["docker", "rm", "-f", "-v", name]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function waitReady(url: string): Promise<postgres.Sql> {
    let last: unknown;
    for (let i = 0; i < 120; i++) {
      const sql = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} });
      try {
        await sql`SELECT 1`;
        return sql;
      } catch (e) {
        last = e;
        await sql.end({ timeout: 1 }).catch(() => {});
        await Bun.sleep(500);
      }
    }
    throw new Error(`standby container never accepted connections: ${last}`);
  }

  test(
    "rm_readonly on a standby captures a decryptable backup, and pg_dump + pg_dumpall ran read-only",
    async () => {
      dir = mkdtempSync(join(tmpdir(), "rm-capture-standby-"));
      const port = await freePort();
      const up = Bun.spawnSync([
        "docker", "run", "-d", "--name", name,
        ...dockerLabelFlags(stackLabels(environment, name)),
        "-e", "POSTGRES_PASSWORD=robotmoney", "-e", "POSTGRES_USER=robotmoney", "-e", "POSTGRES_DB=capturedb",
        "-p", `${port}:5432`, POSTGRES_IMAGE,
      ]);
      if (up.exitCode !== 0) throw new Error(`standby container failed to start: ${up.stderr.toString()}`);

      const adminUrl = `postgres://robotmoney:robotmoney@localhost:${port}/capturedb`;
      let admin = await waitReady(adminUrl);
      await admin.unsafe(`CREATE ROLE rm_readonly LOGIN NOINHERIT PASSWORD '${READONLY_PASSWORD}'`);
      await admin.unsafe("CREATE TABLE public.planted (id int PRIMARY KEY, note text)");
      await admin.unsafe("INSERT INTO public.planted VALUES (1, 'served by the standby')");
      await admin.unsafe("GRANT SELECT ON public.planted TO rm_readonly");
      await admin.unsafe("CHECKPOINT");
      await admin.end({ timeout: 5 });

      // standby.signal + restart: the server comes back in recovery with no
      // primary to follow. hot_standby is on by default, so it serves reads and
      // refuses every write — exactly the node the capture is meant for.
      const signal = Bun.spawnSync(["docker", "exec", name, "sh", "-c", 'touch "$PGDATA/standby.signal"']);
      if (signal.exitCode !== 0) throw new Error(`could not write standby.signal: ${signal.stderr.toString()}`);
      const restart = Bun.spawnSync(["docker", "restart", name]);
      if (restart.exitCode !== 0) throw new Error(`standby restart failed: ${restart.stderr.toString()}`);
      admin = await waitReady(adminUrl);
      const [rec] = await admin`SELECT pg_is_in_recovery() AS rec`;
      expect(rec?.rec).toBe(true);
      await admin.end({ timeout: 5 });

      // The host's pg_dump may be an older major than the pinned server (Ubuntu
      // 24.04 ships 16), and the capture rightly refuses that pairing. So the
      // PATH seen by main() holds pg_dump/pg_dumpall shims that run the REAL
      // binaries from the pinned image, on the host network, writing into the
      // same --out path. Each shim also records the PGOPTIONS it was handed.
      const out = join(dir, "out");
      mkdirSync(out, { mode: 0o700 });
      const shims = join(dir, "bin");
      mkdirSync(shims);
      const log = join(dir, "pgoptions.log");
      const uid = process.getuid?.() ?? 0;
      const gid = process.getgid?.() ?? 0;
      for (const tool of ["pg_dump", "pg_dumpall"]) {
        const shim = join(shims, tool);
        writeFileSync(
          shim,
          [
            "#!/bin/sh",
            `printf '%s\\t%s\\t%s\\n' '${tool}' "$1" "$PGOPTIONS" >> '${log}'`,
            `exec docker run --rm --network host --user ${uid}:${gid} -e HOME=/tmp -e PGOPTIONS ` +
              `-v '${out}:${out}' ${POSTGRES_IMAGE} ${tool} "$@"`,
            "",
          ].join("\n"),
        );
        chmodSync(shim, 0o755);
      }
      process.env.PATH = `${shims}:${savedPath}`;

      const envPath = writeEnv(dir, "localhost", String(port), "capturedb");
      const r = await runCapture(["--out", out, "--env-file", envPath]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);

      const stamp = readFileSync(join(out, ".last-stamp"), "utf8").trim();
      expect(readdirSync(out).sort()).toEqual(
        [".backup-passphrase", ".last-stamp", "manifest.json", `rm-globals-${stamp}.sql.gpg`, `rm-preupgrade-${stamp}.dump.gpg`].sort(),
      );
      const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
      expect(manifest.role).toBe("rm_readonly");
      expect(manifest.pgIsInRecovery).toBe(true);
      expect(manifest.transactionReadOnly).toBe("on");
      expect(manifest).not.toHaveProperty("allowPrimaryOverride");

      // Every dumping invocation (not the `--version` probe) carried the belt.
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => l.split("\t"));
      const dumping = calls.filter(([, first]) => first !== "--version");
      expect(dumping.map(([tool]) => tool).sort()).toEqual(["pg_dump", "pg_dumpall"]);
      for (const [, , pgoptions] of dumping) expect(pgoptions).toBe(READ_ONLY_PGOPTIONS);

      // The encrypted dump opens with the passphrase and holds what the
      // standby served.
      const plain = join(dir, "check.dump");
      const dec = Bun.spawnSync([
        "gpg", "--batch", "--quiet", "--passphrase-file", join(out, ".backup-passphrase"),
        "--output", plain, "--decrypt", join(out, `rm-preupgrade-${stamp}.dump.gpg`),
      ]);
      expect(dec.exitCode).toBe(0);
      const list = Bun.spawnSync([
        "docker", "run", "--rm", "--user", `${uid}:${gid}`, "-v", `${dir}:${dir}`, POSTGRES_IMAGE, "pg_restore", "--list", plain,
      ]);
      expect(list.exitCode).toBe(0);
      expect(list.stdout.toString()).toMatch(/TABLE DATA public planted/);
    },
    240_000,
  );
});
