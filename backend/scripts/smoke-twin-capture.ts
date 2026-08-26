// `bun run smoke:smoke:capture` — produce the encrypted backup a digital smoke-twin restores.
//
// THE OTHER HALF OF `--db smoke-twin`. scripts/lib/restore-container.ts consumes four
// files from a backup directory; until now nothing PRODUCED them. The procedure
// lived only as copy-pasteable bash in a per-release runbook (v0-2-2-rollout.md
// §5.1/§5.2), which meant every future release re-derived it by hand, and the
// one artefact the restore half hard-requires — `.backup-passphrase` — was easy
// to omit by encrypting interactively, producing a backup the restore refuses.
//
// ⛔ READ-ONLY, AGAINST THE REPLICA. Every guard below exists because a dump is
// a long, heavy read, and pointing it at the PRIMARY is the mistake that is easy
// to make and expensive to discover. The role is rm_readonly; the target is the
// read-only node; both are proven, not assumed.
//
// WHAT IT WRITES, and nothing else — exactly what resolveBackupFiles() requires:
//   .last-stamp                      the stamp the restore half reads
//   rm-preupgrade-<STAMP>.dump.gpg   pg_dump --format=custom, encrypted
//   rm-globals-<STAMP>.sql.gpg       pg_dumpall --globals-only, encrypted
//   .backup-passphrase               generated; both gpg calls read it
//   manifest.json                    provenance for the rehearsal report
//
// WHY IT LIVES IN backend/. It needs `postgres` (a backend dependency) and the
// read-only connection gate in backend/scripts/lib/preflight-utils.ts, which is
// the module that already knows how to open a proven-read-only session. The root
// package.json exposes it as `smoke:capture`, the same way `bootstrap` already
// reaches across.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile, redactedTarget, urlFromDiscreteEnv } from "./lib/preflight-utils.ts";

const NAME = "smoke:capture";
const log = (m: string) => console.log(`[${NAME}] ${m}`);
const err = (m: string) => console.error(`[${NAME}] ${m}`);

const scriptDir = dirname(fileURLToPath(import.meta.url));
// backend/scripts/ -> <repo root>
const repoRoot = join(scriptDir, "..", "..");

/** The default backup directory — the SAME default resolveBackupFiles() uses, so
 *  capture and restore agree by construction rather than by runbook prose. */
const DEFAULT_OUT = join(process.env.HOME ?? "/root", "rm-backup-v022");

interface Args {
  out: string;
  envFile: string;
  allowPrimary: boolean;
}

export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    return v && !v.startsWith("--") ? v : undefined;
  };
  for (const flag of ["--out", "--env-file"]) {
    if (argv.includes(flag) && !val(flag)) return { error: `${flag} requires a value.` };
  }
  const known = new Set(["--out", "--env-file", "--allow-primary"]);
  for (const a of argv) {
    if (a.startsWith("--") && !known.has(a)) return { error: `unknown flag "${a}".` };
  }
  return {
    out: resolve(val("--out") ?? DEFAULT_OUT),
    envFile: resolve(val("--env-file") ?? join(repoRoot, ".env.readonly")),
    allowPrimary: argv.includes("--allow-primary"),
  };
}

/**
 * Refuse to write the backup inside the checkout.
 *
 * The runbook says this in a red box; here it is a check. These files are a
 * complete copy of production plus the passphrase that opens it, and a stray
 * `git add -A` in a repo that has never needed to ignore them is all it takes.
 */
export function assertOutsideRepo(out: string, root: string): void {
  const normalised = out.endsWith("/") ? out.slice(0, -1) : out;
  if (normalised === root || normalised.startsWith(`${root}/`)) {
    throw new Error(
      `--out ${out} is inside the checkout (${root}). This directory holds a complete copy of ` +
        `production AND the passphrase that decrypts it; it must live outside any git working tree. ` +
        `Use ${DEFAULT_OUT} or another path outside the repo.`,
    );
  }
}

/** Major version from a `psql (PostgreSQL) 18.6 (Ubuntu …)` / server string. */
export function majorOf(version: string): number | null {
  const m = version.match(/(\d+)(?:\.\d+)?/);
  return m ? Number(m[1]) : null;
}

/**
 * The client-version rule, checked BEFORE the dump rather than discovered in its
 * error output: pg_dump refuses to dump from a server NEWER than itself. Ubuntu
 * 24.04 ships client 16 by default against an 18 server, which is exactly the
 * pairing this repo runs.
 */
export function clientVersionComplaint(clientMajor: number | null, serverMajor: number | null): string | undefined {
  if (clientMajor === null || serverMajor === null) return undefined;
  if (clientMajor >= serverMajor) return undefined;
  return (
    `pg_dump is major ${clientMajor} but the server is major ${serverMajor} — pg_dump refuses to dump from a ` +
    `newer server, and a partial dump is worse than none. Install the matching client from PGDG:\n` +
    `  sudo sh -c 'echo "deb https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'\n` +
    `  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg\n` +
    `  sudo apt-get update && sudo apt-get install -y postgresql-client-${serverMajor}`
  );
}

function run(cmd: string[], env?: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(cmd, { env: env ? { ...process.env, ...env } : process.env });
  const dec = new TextDecoder();
  return { code: p.exitCode ?? 1, stdout: dec.decode(p.stdout).trim(), stderr: dec.decode(p.stderr).trim() };
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    err(parsed.error);
    return 2;
  }
  const { out, envFile, allowPrimary } = parsed;

  // umask 077 for everything this process creates, the way §5.2's shell does.
  // pg_dump and gpg create their own output files, so per-write `mode` options
  // cannot reach them: verified on this host that a default umask leaves the
  // dump world-readable (0644) while only the files written here get 0600.
  // The artifacts are a complete copy of production; the directory is a
  // credential store.
  process.umask(0o077);

  try {
    assertOutsideRepo(out, resolve(repoRoot));
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }

  const env = loadEnvFile(envFile);
  if (!env) {
    err(`no readable ${envFile}. Copy .env.readonly.example and fill in the rm_readonly role's details.`);
    return 2;
  }
  const resolved = urlFromDiscreteEnv(env);
  if ("missing" in resolved) {
    err(`${envFile} is missing required key(s): ${resolved.missing.join(", ")}.`);
    return 2;
  }
  const url = resolved.url;
  log(`target: ${redactedTarget(url, "(unset)")}  (role and host from ${envFile})`);

  // GUARD 1 — never the application's own writer credential.
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
    err("the resolved connection equals DATABASE_URL — that is the application's WRITER credential, not the read-only role. Refusing.");
    return 2;
  }

  // GUARD 2 — this must be a REPLICA. A streaming replica answers true; the
  // primary answers false. This is the check that makes "against the replica,
  // never the primary" enforceable instead of merely written down.
  const { default: postgres } = await import("postgres");
  const db = postgres(url, { max: 1, idle_timeout: 10, connection: { application_name: "smoke-twin-capture" } });
  let inRecovery: boolean;
  let serverVersion: string;
  let roleName: string;
  try {
    const [row] = await db`select pg_is_in_recovery() as rec, version() as v, current_user as who`;
    inRecovery = Boolean(row?.rec);
    serverVersion = String(row?.v ?? "");
    roleName = String(row?.who ?? "");
  } catch (e) {
    err(`could not reach the database: ${e instanceof Error ? e.message : e}`);
    return 2;
  } finally {
    await db.end({ timeout: 5 }).catch(() => {});
  }

  const serverMajor = majorOf(serverVersion.replace(/^PostgreSQL\s+/, ""));
  log(`connected as ${roleName}; server major ${serverMajor ?? "?"}; pg_is_in_recovery()=${inRecovery}`);
  if (!inRecovery) {
    const msg =
      "pg_is_in_recovery() is FALSE — this is the PRIMARY, not the read-only replica. A dump is a long, " +
      "heavy read and the runbook's whole backup path is deliberately one read-only role against a replica.";
    if (!allowPrimary) {
      err(`${msg} Pass --allow-primary only if you genuinely mean it (it is recorded in the manifest).`);
      return 2;
    }
    log(`WARNING: ${msg} Proceeding because --allow-primary was passed; this is recorded in manifest.json.`);
  }

  // GUARD 3 — client not older than server, checked before the expensive read.
  const clientVersion = run(["pg_dump", "--version"]).stdout;
  const complaint = clientVersionComplaint(majorOf(clientVersion.replace(/^pg_dump\s+\(PostgreSQL\)\s+/, "")), serverMajor);
  if (complaint) {
    err(complaint);
    return 2;
  }

  mkdirSync(out, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dumpPlain = join(out, `rm-preupgrade-${stamp}.dump`);
  const globalsPlain = join(out, `rm-globals-${stamp}.sql`);
  const passphraseFile = join(out, ".backup-passphrase");

  // The passphrase. resolveBackupFiles() hard-fails without this file, because
  // decryption on the restore side is non-interactive by design — an interactive
  // `gpg --symmetric` leaves no passphrase and produces a backup the smoke-twin cannot
  // open.
  //
  // REUSED WHEN THE DIRECTORY ALREADY HAS ONE, never regenerated. The restore
  // contract is ONE passphrase per backup directory (a single .backup-passphrase
  // beside many stamped dumps), so writing a fresh one for a second capture
  // would silently render every EARLIER backup in that directory permanently
  // undecryptable — including the pre-upgrade backup a rollback depends on.
  // Overwriting it is not a recoverable mistake, so it is not an option.
  let passphrase: string;
  if (existsSync(passphraseFile)) {
    passphrase = readFileSync(passphraseFile, "utf8").trim();
    if (!passphrase) {
      err(`${passphraseFile} exists but is empty — refusing to guess. Move it aside or capture into a fresh --out.`);
      return 2;
    }
    log(`reusing the existing passphrase in ${passphraseFile} (earlier backups here stay decryptable)`);
  } else {
    passphrase = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    writeFileSync(passphraseFile, `${passphrase}\n`, { mode: 0o600 });
    log(`generated a new passphrase at ${passphraseFile} — archive it somewhere else too`);
  }

  // PLAINTEXT NEVER SURVIVES THIS FUNCTION. Between pg_dump and gpg there is an
  // unencrypted copy of production on disk; every failure path below must remove
  // it, not just the happy one. An aborted capture that leaves a readable dump
  // behind is worse than a capture that never ran.
  try {
    log(`dumping (this is the long step) -> ${dumpPlain}`);
    const dump = run(
      ["pg_dump", "--dbname", url, "--format=custom", "--compress=9", "--no-owner", "--no-privileges", `--file=${dumpPlain}`],
    );
    if (dump.code !== 0) {
      err(`pg_dump exited ${dump.code}: ${dump.stderr}`);
      return 1;
    }

    // Roles are NOT in the dump above; this is a separate, required artifact.
    // --no-role-passwords keeps it a pure catalog read of pg_roles (rather than
    // pg_authid, which would need superuser), which is why rm_readonly suffices.
    //
    // `-l <database>` IS REQUIRED, and its absence fails in a way that reads like
    // a permissions problem. pg_dumpall connects through `template1` by default
    // to enumerate globals, and DO Managed's pg_hba.conf rejects connections to
    // template1 from outside its own network path:
    //
    //   FATAL: pg_hba.conf rejects connection for host ..., user "rm_readonly",
    //          database "template1"
    //
    // (verified against the production replica, 2026-08-21). The flag only picks
    // the database it connects THROUGH; globals are cluster-wide either way.
    const database = new URL(url).pathname.replace(/^\//, "") || "defaultdb";
    log(`dumping globals (through ${database}, never template1) -> ${globalsPlain}`);
    const globals = run(
      ["pg_dumpall", "--dbname", url, "-l", database, "--globals-only", "--no-role-passwords", `--file=${globalsPlain}`],
    );
    if (globals.code !== 0) {
      err(`pg_dumpall exited ${globals.code}: ${globals.stderr}`);
      return 1;
    }

    for (const plain of [dumpPlain, globalsPlain]) {
      const enc = run([
        "gpg", "--batch", "--yes", "--symmetric", "--cipher-algo", "AES256",
        "--passphrase-file", passphraseFile, "--output", `${plain}.gpg`, plain,
      ]);
      if (enc.code !== 0) {
        err(`gpg failed for ${plain}: ${enc.stderr}`);
        return 1;
      }
    }

    // Prove the encrypted files actually open before the plaintext goes away —
    // otherwise a silent gpg problem produces artifacts the smoke-twin will reject at
    // the far end of the next rehearsal, hours later.
    for (const plain of [dumpPlain, globalsPlain]) {
      const probe = run(["gpg", "--batch", "--quiet", "--passphrase-file", passphraseFile, "--decrypt", `${plain}.gpg`]);
      if (probe.code !== 0) {
        err(`the encrypted ${plain}.gpg does not decrypt with the passphrase in ${passphraseFile} — refusing to continue.`);
        rmSync(`${plain}.gpg`, { force: true });
        return 1;
      }
    }
  } finally {
    for (const plain of [dumpPlain, globalsPlain]) rmSync(plain, { force: true });
  }

  writeFileSync(join(out, ".last-stamp"), `${stamp}\n`, { mode: 0o600 });

  const manifest = {
    stamp,
    capturedAt: new Date().toISOString(),
    target: redactedTarget(url, "(unset)"),
    role: roleName,
    pgIsInRecovery: inRecovery,
    allowPrimaryOverride: allowPrimary && !inRecovery,
    serverVersion,
    clientVersion,
    files: {
      dump: `rm-preupgrade-${stamp}.dump.gpg`,
      globals: `rm-globals-${stamp}.sql.gpg`,
    },
    bytes: {
      dump: statSync(`${dumpPlain}.gpg`).size,
      globals: statSync(`${globalsPlain}.gpg`).size,
    },
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  log(`captured ${stamp}: dump ${manifest.bytes.dump} bytes, globals ${manifest.bytes.globals} bytes`);
  log(`restore it with:  bun smoke -- --db smoke-twin${out === DEFAULT_OUT ? "" : ` --backup-dir ${out}`}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
