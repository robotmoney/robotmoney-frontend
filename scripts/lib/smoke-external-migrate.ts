// Interactive, fail-closed doadmin credential for an opt-in `--db external
// --migrate` boot (scripts/lib/smoke-db-mode.ts's MIGRATE_FLAG).
//
// WHY INTERACTIVE, NEVER STORED. D46/docs/plans/deploy-separation-engineering-plan.md
// treats doadmin as bootstrap-only: it must never live in an env var, a file, or
// a container. `--db external` alone never needs it — migrate() is skipped
// entirely, and the boot runs on rm_app exactly as every other external step
// already does. `--migrate` is the one deliberate exception: an operator who
// wants THIS run to catch the target database up types the doadmin password at
// the terminal for that one run. It never touches $HOME/.env or any file, is set
// as MIGRATE_DATABASE_URL on this process only (the same passthrough
// restore-container.ts's twinMigrationCredential() uses to reach the migrate
// container), and the caller clears it the moment migrate() returns.
//
// FAIL CLOSED, not fail-open. Three refusals, none of them a fallback:
//   - stdin is not a terminal: --migrate cannot be scripted or piped into.
//   - $HOME/.env is missing the connection tokens --db external already needed.
//   - the typed password does not authenticate — checked with a single fast
//     probe, not backend/src/db/migrate.ts's waitForDb(), which is built to ride
//     out postgres STARTING UP and would otherwise burn 30s on a wrong password
//     before failing.
// Every one of these throws; none of them falls back to rm_app or lets the boot
// proceed as if --migrate had not been passed.
import { loadEnvFile } from "./env-role.ts";

const DOADMIN_ROLE = "doadmin";
const MIGRATE_FLAG_LABEL = "--migrate";

/**
 * Read one line from the terminal with the input masked. smoke-main.ts owns no
 * shared readline.Interface today, and this prompt is the only one a boot ever
 * needs, so it drives process.stdin directly rather than pulling one in.
 * Mirrors scripts/gitops-credentials.ts's `hidden()`.
 */
async function hiddenPrompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `${MIGRATE_FLAG_LABEL}: stdin is not a terminal. An operator must type the ${DOADMIN_ROLE} password ` +
        `interactively — it is never read from an environment variable, a file, or a pipe.`,
    );
  }
  process.stdout.write(`${question}: `);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode?.(true);
  stdin.resume();
  try {
    return await new Promise<string>((resolvePrompt) => {
      let input = "";
      const onData = (data: Buffer) => {
        const char = data.toString();
        if (char === "\r" || char === "\n") {
          stdin.setRawMode?.(wasRaw);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolvePrompt(input);
        } else if (char === "\x03") {
          // Ctrl-C: restore the terminal before this process dies, or the
          // operator's shell is left with raw mode still on and echo off.
          stdin.setRawMode?.(wasRaw);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          process.exit(130);
        } else if (char === "\x7f" || char === "\b") {
          if (input.length > 0) input = input.slice(0, -1);
        } else if (char.length === 1 && char >= " ") {
          input += char;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.pause();
  }
}

/**
 * Verify a connection URL actually authenticates, fast. A single `SELECT 1`
 * through psql, not backend/src/db/migrate.ts's waitForDb() — that loop exists
 * to ride out postgres's temp-server startup phase, not to fail fast on a wrong
 * password, and would otherwise cost this refusal 30 seconds. Never logs the
 * URL itself: only the redacted detail below and psql's own stderr, which
 * postgres never echoes the password into.
 *
 * The connection travels to psql as PG* environment variables, never as the
 * URL positional argument — an argv password sits in `ps`/`/proc/<pid>/cmdline`
 * and in execve-level audit logs for as long as the process runs, which is
 * exactly the exposure this whole interactive-prompt design exists to avoid.
 */
function verifyAuthenticates(url: string): void {
  const parsed = new URL(url);
  const probe = Bun.spawnSync(["psql", "-X", "-Atc", "SELECT 1"], {
    env: {
      ...process.env,
      PGHOST: parsed.hostname,
      PGPORT: parsed.port || "5432",
      PGUSER: decodeURIComponent(parsed.username),
      PGPASSWORD: decodeURIComponent(parsed.password),
      PGDATABASE: parsed.pathname.replace(/^\//, ""),
      PGSSLMODE: parsed.searchParams.get("sslmode") ?? "require",
    },
    stderr: "pipe",
  });
  if (probe.exitCode !== 0) {
    const detail = new TextDecoder().decode(probe.stderr).trim();
    throw new Error(`${MIGRATE_FLAG_LABEL}: ${DOADMIN_ROLE} did not authenticate: ${detail || `psql exited ${probe.exitCode}`}`);
  }
}

/**
 * Decide and act on this boot's `--migrate` opt-in — called from smoke-main.ts
 * while process.env is still mutable, ahead of the extraComposeEnv snapshot
 * buildComposeEnv() takes (scripts/stack/config.ts). Absent, up() already
 * skips migrate() for external by default; this only has to say so. Present,
 * a refusal here must stop the boot outright — never fall back to rm_app.
 */
export async function resolveExternalMigrationOptIn(
  migrateRequested: boolean,
  envFilePath: string,
  log: (m: string) => void = (m) => console.log(`[smoke] ${m}`),
): Promise<void> {
  if (!migrateRequested) {
    console.warn(
      `[smoke] --db external without ${MIGRATE_FLAG_LABEL}: this boot will NOT run migrations and runs on ` +
        `rm_app only. Pass ${MIGRATE_FLAG_LABEL} to catch the schema up (you will be asked for the doadmin password).`,
    );
    return;
  }
  try {
    await externalMigrationCredential(envFilePath, log);
  } catch (err) {
    console.error(`[smoke] FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Prompt for the doadmin password and assemble the one-shot migration URL from
 * it plus `$HOME/.env`'s discrete connection tokens (host/port/database/
 * sslmode — the same tokens --db external already reads; never a password —
 * see scripts/lib/env-role.ts). Verifies it authenticates, then sets
 * MIGRATE_DATABASE_URL on this process so it reaches the migrate container
 * exactly the way restore-container.ts's twinMigrationCredential() does.
 *
 * The caller MUST clear process.env.MIGRATE_DATABASE_URL once migrate()
 * returns — this function only sets it, since the boot continues running
 * (serving traffic) long after the one migration this credential is for.
 *
 * Throws — never falls back to rm_app or a skipped migration — on a missing
 * `.env`, a non-interactive terminal, or a password that does not
 * authenticate.
 */
export async function externalMigrationCredential(
  envFilePath: string,
  log: (m: string) => void,
): Promise<void> {
  const env = loadEnvFile(envFilePath);
  if (!env?.host || !env?.database) {
    throw new Error(
      `${MIGRATE_FLAG_LABEL}: ${envFilePath} is missing the host/database connection tokens ` +
        `${"--db external"} already needed to boot.`,
    );
  }
  const password = await hiddenPrompt(`${DOADMIN_ROLE} password`);
  if (!password) throw new Error(`${MIGRATE_FLAG_LABEL}: no password entered.`);
  const port = env.port ?? "5432";
  const sslmode = env.sslmode ?? "require";
  const u = new URL(`postgres://${env.host}`);
  u.port = port;
  u.username = encodeURIComponent(DOADMIN_ROLE);
  u.password = encodeURIComponent(password);
  u.pathname = `/${env.database}`;
  u.searchParams.set("sslmode", sslmode);
  const url = u.toString();

  log(`verifying ${DOADMIN_ROLE}@${env.host}:${port}/${env.database} authenticates…`);
  verifyAuthenticates(url);
  log(`${DOADMIN_ROLE} authenticated — this run's migration will use it, never rm_app`);
  process.env.MIGRATE_DATABASE_URL = url;
}
