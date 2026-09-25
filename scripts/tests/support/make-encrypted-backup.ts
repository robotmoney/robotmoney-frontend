// Build the encrypted backup a `bun smoke --local dump=<dir>` restores, the way
// smoke-production-spec.md §5 and `bun smoke:capture` (backend/scripts/
// smoke-twin-capture.ts, the §5.1/§5.2 procedure as code) produce one — for the
// integration tests that drive the dump row of §4.3 in a real boot (issue #1026,
// criteria 13 and 76).
//
// No backup exists on a test host, and none may be committed: a real one is a
// copy of production. So the test builds its own, from a disposable Postgres of
// its own, and everything it writes lives in a temp directory removed by
// close(). The passphrase is generated per backup. Nothing secret is committed.
//
// THE SOURCE DATABASE, one of two:
//
//   v0.5.0               the schema production runs today (D55 (8):
//                        SUPPORTED_RELEASES is v0.5.0 alone), rebuilt from the
//                        release's OWN migration bytes by the release's own
//                        runner loop — the same reconstruction, from the same
//                        fixture, as backend/tests/upgrade-from-release.test.ts
//                        (one transaction per file, `SET LOCAL ROLE rm_owner`
//                        from 0054 on, a ledger row per file). It predates 0063,
//                        so it has NO deployment_identity table.
//   production-identity  the branch's schema, bootstrapped from the snapshot BY
//                        rm_owner through the real bootstrapBlankDatabase, then
//                        enrolled `production` through rm_owner — a database as
//                        §9.1 leaves production, exactly as ../integration/
//                        remote-db-harness.ts provisions its remote one.
//
// Both carry one planted `comments` row (MARKER_PAGE) so a restore can be shown
// to have carried data, not merely a schema.
//
// THE CAPTURE, as smoke:capture runs it:
//   pg_dump --format=custom --compress=9 --no-owner --no-privileges
//   pg_dumpall --globals-only --no-role-passwords -l <db>
// both as rm_readonly with PGOPTIONS=-c default_transaction_read_only=on, then
// `gpg --batch --symmetric --cipher-algo AES256 --passphrase-file`, each file
// proven to decrypt before its plaintext is removed, then `.last-stamp`. The
// two dumps run INSIDE the source container: capture refuses a client older
// than the server (its GUARD 3), and the container's client is the server's own
// major — which is also why the archive is the format that major writes, the
// format a real capture of the production server hands the restore.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POSTGRES_IMAGE } from "../../lib/postgres-image.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const BACKEND = join(REPO_ROOT, "backend");
const MIGRATIONS_DIR = join(BACKEND, "migrations");
const RELEASE_DIR = join(BACKEND, "tests", "fixtures", "releases", "v0.5.0");
const DB = "robotmoney";

/** The `comments.page` of the row every source carries, so a restore can be shown to carry data. */
export const MARKER_PAGE = "rm-dump-lifecycle-marker";

export type BackupSource = "v0.5.0" | "production-identity";

export interface EncryptedBackup {
  /** The backup directory: what `--local dump=<dir>` names. */
  readonly dir: string;
  /** Its `.last-stamp`. */
  readonly stamp: string;
  /** The source's migration ledger, as captured. */
  readonly ledger: readonly string[];
  /** The source's deployment_identity.kind, or null when it had no table. */
  readonly identity: "production" | null;
  /** The source server's major version, which wrote the archive. */
  readonly serverMajor: number;
  /** Remove the directory (and the source container, if it is still up). */
  close(): void;
}

function sh(argv: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): { code: number; out: string; stdout: string } {
  const r = Bun.spawnSync(argv, {
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.env ? { env: opts.env } : {}),
  });
  const stdout = r.stdout.toString();
  return { code: r.exitCode ?? -1, out: `${stdout}${r.stderr.toString()}`, stdout };
}

function must(what: string, r: { code: number; out: string }): void {
  if (r.code !== 0) throw new Error(`make-encrypted-backup: ${what} failed (exit ${r.code}): ${r.out.slice(-2000)}`);
}

/** v0.5.0's migration list, each file's bytes as the tag had them (verbatim copy when the branch edited it). */
function releaseMigrations(): { file: string; path: string }[] {
  const release = JSON.parse(readFileSync(join(RELEASE_DIR, "release.json"), "utf8")) as { migrations: { file: string; sha256: string }[] };
  return release.migrations.map(({ file, sha256 }) => {
    const pinned = join(RELEASE_DIR, "migrations", file);
    const path = existsSync(pinned) ? pinned : join(MIGRATIONS_DIR, file);
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    // The same guard upgrade-from-release.test.ts's first test is: a release
    // schema rebuilt from bytes the release never had is not the release.
    if (actual !== sha256) throw new Error(`make-encrypted-backup: ${file} no longer matches v0.5.0's recorded sha256 and has no verbatim copy`);
    return { file, path };
  });
}

/**
 * The source database's construction, run as a `bun` child in backend/ (the
 * `postgres` client and the snapshot loader are backend dependencies; scripts/
 * cannot import them). The superuser URL arrives in the child's environment and
 * nowhere else — it is the throwaway container's, never an operator's.
 */
const BUILD_SOURCE = String.raw`
import postgres from "postgres";
import { readFileSync } from "node:fs";
const spec = JSON.parse(process.env.RM_BACKUP_SPEC);
const su = postgres(process.env.RM_BACKUP_SUPERUSER_URL, { max: 1, onnotice: () => {} });
try {
  if (spec.source === "v0.5.0") {
    // v0.5.0's runner loop (backend/src/db/migrate.ts at the tag), exactly as
    // upgrade-from-release.test.ts's applyAsReleaseRunner models it.
    await su.unsafe("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const { file, path } of spec.migrations) {
      const ddl = readFileSync(path, "utf8");
      await su.begin(async (tx) => {
        if (file >= "0054_rm_worker_allowlist.sql") await tx.unsafe("SET LOCAL ROLE rm_owner");
        await tx.unsafe(ddl);
        await tx.unsafe("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      });
    }
  } else {
    // §9.1's shape: the four roles, the database owned by rm_owner, the
    // provider's extension, the snapshot bootstrapped BY rm_owner, then the
    // one-time production enrollment through rm_owner.
    for (const [role, pw] of Object.entries(spec.passwords)) {
      await su.unsafe("CREATE ROLE " + role + " LOGIN NOSUPERUSER NOCREATEROLE PASSWORD '" + pw + "'");
    }
    await su.unsafe("ALTER DATABASE " + spec.database + " OWNER TO rm_owner");
    await su.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    const owner = postgres(spec.ownerUrl, { max: 1, onnotice: () => {} });
    try {
      const { bootstrapBlankDatabase, loadSnapshot } = await import("./src/db/schema-snapshot.ts");
      await bootstrapBlankDatabase(owner, await loadSnapshot());
      await owner.unsafe("UPDATE deployment_identity SET kind = 'production', note = 'make-encrypted-backup: section 9.1 enrollment'");
    } finally {
      await owner.end({ timeout: 5 });
    }
  }
  await su.unsafe("INSERT INTO comments (page, author, content) VALUES ($1, 'make-encrypted-backup', 'planted before the capture')", [spec.marker]);
} finally {
  await su.end({ timeout: 5 });
}
process.exit(0);
`;

/**
 * Build a disposable source database, capture it as §5.1/§5.2 do, and return
 * the backup directory. Throws, naming the step, on any failure; the source
 * container is always removed before this returns or throws.
 */
export async function makeEncryptedBackup(source: BackupSource): Promise<EncryptedBackup> {
  const dir = mkdtempSync(join(tmpdir(), `rm-backup-${source.replace(/[^a-z0-9]/g, "")}-`));
  const container = `rm_it_backup_src_${randomBytes(4).toString("hex")}`;
  const superPassword = `su_${randomBytes(12).toString("hex")}`;
  const cleanupContainer = () => sh(["docker", "rm", "-f", "-v", container]);
  try {
    must(
      "docker run (source database)",
      sh([
        "docker", "run", "-d", "--name", container, "--label", "robotmoney.test=make-encrypted-backup",
        "-e", `POSTGRES_PASSWORD=${superPassword}`, "-e", `POSTGRES_DB=${DB}`, "-p", "127.0.0.1::5432", POSTGRES_IMAGE,
      ]),
    );
    const port = Number(sh(["docker", "inspect", "-f", '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container]).stdout.trim());
    // The entrypoint's temporary init server answers before the real one:
    // wait for a real query over TCP, twice, a second apart.
    const deadline = Date.now() + 90_000;
    for (let ok = 0; ok < 2; ) {
      const probe = sh(["docker", "exec", container, "psql", "-U", "postgres", "-h", "127.0.0.1", "-d", DB, "-Atc", "SELECT 1"]);
      ok = probe.code === 0 && probe.stdout.trim() === "1" ? ok + 1 : 0;
      if (Date.now() > deadline) throw new Error(`make-encrypted-backup: the source database never became ready: ${probe.out}`);
      await Bun.sleep(1000);
    }
    const serverMajor = Number(sh(["docker", "exec", container, "psql", "-U", "postgres", "-d", DB, "-Atc", "SHOW server_version_num"]).stdout.trim().slice(0, 2));

    const passwords = Object.fromEntries(
      ["rm_owner", "rm_app", "rm_worker", "rm_readonly"].map((role) => [role, `${role.slice(3)}_${randomBytes(9).toString("hex")}`]),
    );
    const superUrl = `postgres://postgres:${superPassword}@127.0.0.1:${port}/${DB}?sslmode=disable`;
    const ownerUrl = `postgres://rm_owner:${passwords.rm_owner}@127.0.0.1:${port}/${DB}?sslmode=disable`;
    const spec = {
      source,
      database: DB,
      marker: MARKER_PAGE,
      passwords,
      ownerUrl,
      migrations: source === "v0.5.0" ? releaseMigrations() : [],
    };
    const built = Bun.spawnSync(["bun", "-e", BUILD_SOURCE], {
      cwd: BACKEND,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        // backend/src/config.ts validates at import; the snapshot loader is
        // reached through it. The throwaway superuser, never an operator's URL.
        DATABASE_URL: superUrl,
        RM_ENV: "stage",
        RM_BACKUP_SUPERUSER_URL: superUrl,
        RM_BACKUP_SPEC: JSON.stringify(spec),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    must("building the source database", { code: built.exitCode ?? -1, out: `${built.stdout.toString()}${built.stderr.toString()}` });

    // What the source holds, read before the capture, for the tests to hold the restore to.
    const q = (sql: string) => sh(["docker", "exec", container, "psql", "-X", "-U", "postgres", "-d", DB, "-Atc", sql]);
    const ledger = q("SELECT name FROM schema_migrations ORDER BY name").stdout.trim().split("\n").filter(Boolean);
    const identityRead = q("SELECT CASE WHEN to_regclass('public.deployment_identity') IS NULL THEN '' ELSE (SELECT kind FROM deployment_identity) END").stdout.trim();
    const identity = identityRead === "production" ? "production" : null;
    if (source === "production-identity" && identity !== "production") throw new Error(`make-encrypted-backup: the source reads identity ${identityRead || "(none)"}, not production`);
    if (source === "v0.5.0" && identityRead !== "") throw new Error("make-encrypted-backup: a v0.5.0 source must predate 0063's deployment_identity");

    // THE CAPTURE — smoke:capture's two commands, read-only, as rm_readonly
    // (the container's local socket trusts it, which is all a dump inside it
    // needs). EXCEPT for v0.5.0: its rm_readonly cannot read the twelve
    // sequences 0056-0060 revoked from it (issue #699, the defect
    // 0062_rm_readonly_sequence_select.sql fixes after the tag), so pg_dump as
    // rm_readonly fails on a v0.5.0 database. That source is dumped as its
    // superuser (doadmin's stand-in); with --no-owner --no-privileges the
    // dumping role leaves no trace in the archive.
    const dumpRole = source === "v0.5.0" ? "postgres" : "rm_readonly";
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const dumpPlain = join(dir, `rm-preupgrade-${stamp}.dump`);
    const globalsPlain = join(dir, `rm-globals-${stamp}.sql`);
    const readOnly = ["-e", "PGOPTIONS=-c default_transaction_read_only=on"];
    try {
      must(
        `pg_dump (as ${dumpRole}, read-only)`,
        sh(["docker", "exec", ...readOnly, container, "pg_dump", "-U", dumpRole, "-d", DB, "--format=custom", "--compress=9", "--no-owner", "--no-privileges", "--file=/tmp/rm.dump"]),
      );
      must("copying the dump out", sh(["docker", "cp", `${container}:/tmp/rm.dump`, dumpPlain]));
      must(
        `pg_dumpall --globals-only (as ${dumpRole}, read-only)`,
        sh(["docker", "exec", ...readOnly, container, "pg_dumpall", "-U", dumpRole, "-l", DB, "--globals-only", "--no-role-passwords", "--file=/tmp/rm-globals.sql"]),
      );
      must("copying the globals out", sh(["docker", "cp", `${container}:/tmp/rm-globals.sql`, globalsPlain]));

      // §5.2: a generated passphrase FILE, handed to both gpg calls — the
      // artefact the restore hard-requires (resolveBackupFiles).
      const passphraseFile = join(dir, ".backup-passphrase");
      writeFileSync(passphraseFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
      for (const plain of [dumpPlain, globalsPlain]) {
        must(
          `gpg --symmetric ${plain}`,
          sh(["gpg", "--batch", "--yes", "--symmetric", "--cipher-algo", "AES256", "--passphrase-file", passphraseFile, "--output", `${plain}.gpg`, plain]),
        );
        must(`gpg --decrypt ${plain}.gpg (proving it opens)`, sh(["gpg", "--batch", "--quiet", "--passphrase-file", passphraseFile, "--decrypt", "--output", "/dev/null", `${plain}.gpg`]));
      }
    } finally {
      // Plaintext never survives the capture, exactly as smoke:capture's finally.
      for (const plain of [dumpPlain, globalsPlain]) rmSync(plain, { force: true });
    }
    writeFileSync(join(dir, ".last-stamp"), `${stamp}\n`, { mode: 0o600 });

    return {
      dir,
      stamp,
      ledger,
      identity,
      serverMajor,
      close() {
        cleanupContainer();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    // The source is not needed once the backup is on disk; the boot restores
    // into a container of its own.
    cleanupContainer();
  }
}
