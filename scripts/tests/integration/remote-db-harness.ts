// A "remote" database for tests that drive a real `bun smoke` against one —
// shared by scripts/tests/integration/smoke-external-migrate.test.ts and
// scripts/tests/integration/smoke-stage-vs-production-identity.test.ts.
//
// A Postgres container of the test's own, published on the Docker BRIDGE
// address: a host address that is not loopback, exactly as a managed server is
// to the stack (the boot refuses a loopback remote, and its host-side reads —
// the target lock, the identity read — reach the bridge address from the
// host). Provisioned the way spec §9.1 leaves production: the four roles with
// known passwords, `rm_owner` LOGIN without CREATEROLE, the database owned by
// `rm_owner`, the provider's extension, and the schema bootstrapped from the
// snapshot BY `rm_owner` through the real `bootstrapBlankDatabase`. The
// enrollment is whatever a case sets (`setIdentity`), through the container's
// superuser — the stand-in for `doadmin`.
//
// Each boot gets a `$HOME` of its own whose `.env` holds exactly the §3 keys.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { POSTGRES_IMAGE } from "../../lib/postgres-image.ts";
import { instancePaths, SERVICE_TOKEN_HOLDERS } from "../../lib/smoke-state.ts";

export const repoRoot = join(import.meta.dir, "..", "..", "..");
const BACKEND = join(repoRoot, "backend");
const DB = "robotmoney";

function sh(argv: string[], stdin?: string): { code: number; out: string } {
  const r = Bun.spawnSync(argv, { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

export interface RemoteDb {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly passwords: Readonly<Record<"rm_owner" | "rm_app" | "rm_worker" | "rm_readonly", string>>;
  /** SQL as the container's superuser (doadmin's stand-in); returns its unaligned output. */
  superuser(sql: string): string;
  setIdentity(kind: "production" | "rehearsal" | null): void;
  /** A fresh operator: a HOME whose .env holds exactly the §3 keys, a state root, a roster file. */
  operator(name: string, extraEnvLines?: readonly string[]): Operator;
  close(): void;
}

export interface Operator {
  readonly env: Record<string, string>;
  readonly home: string;
  readonly root: string;
  readonly roster: string;
}

/** Start and provision the remote database. Throws, naming the step, on any failure. */
export async function startRemoteDb(label: string): Promise<RemoteDb> {
  const passwords = {
    rm_owner: `owner-${randomBytes(9).toString("hex")}`,
    rm_app: `app-${randomBytes(9).toString("hex")}`,
    rm_worker: `worker-${randomBytes(9).toString("hex")}`,
    rm_readonly: `readonly-${randomBytes(9).toString("hex")}`,
  };
  const host = sh(["docker", "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"]).out.trim();
  const container = `rm_it_remote_${label}_${randomBytes(4).toString("hex")}`;
  const run = sh([
    "docker", "run", "-d", "--rm", "--name", container, "--label", `robotmoney.test=${label}`,
    "-e", "POSTGRES_PASSWORD=unused-superuser", "-e", `POSTGRES_DB=${DB}`, "-p", `${host}::5432`, POSTGRES_IMAGE,
  ]);
  if (run.code !== 0) throw new Error(`docker run failed: ${run.out}`);
  const port = Number(sh(["docker", "inspect", "-f", '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container]).out.trim());
  const work = mkdtempSync(join(tmpdir(), `rm-remote-${label}-`));

  const superuser = (sql: string): string => {
    const r = sh(["docker", "exec", "-i", container, "psql", "-X", "-q", "-At", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-f", "-"], sql);
    if (r.code !== 0) throw new Error(`superuser SQL failed: ${r.out}`);
    return r.out.trim();
  };

  // The entrypoint's temporary init server answers before the real one: wait
  // for a real query over TCP, twice, a second apart.
  const deadline = Date.now() + 60_000;
  let ok = 0;
  while (ok < 2) {
    const probe = sh(["docker", "exec", container, "psql", "-U", "postgres", "-h", "127.0.0.1", "-d", DB, "-Atc", "SELECT 1"]);
    ok = probe.code === 0 && probe.out.trim() === "1" ? ok + 1 : 0;
    if (Date.now() > deadline) throw new Error(`the remote database never became ready: ${probe.out}`);
    await Bun.sleep(1000);
  }
  superuser(
    Object.entries(passwords)
      .map(([role, pw]) => `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEROLE PASSWORD '${pw}';`)
      .join("\n") + `\nALTER DATABASE ${DB} OWNER TO rm_owner;\nCREATE EXTENSION IF NOT EXISTS pgcrypto;\n`,
  );
  const ownerUrl = `postgres://rm_owner:${passwords.rm_owner}@${host}:${port}/${DB}?sslmode=disable`;
  const bootstrap = Bun.spawnSync(
    ["bun", "-e", 'import postgres from "postgres"; import { bootstrapBlankDatabase, loadSnapshot } from "./src/db/schema-snapshot.ts"; const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} }); await bootstrapBlankDatabase(db, await loadSnapshot()); await db.end(); process.exit(0);'],
    { cwd: BACKEND, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: ownerUrl, RM_ENV: "stage" }, stdout: "pipe", stderr: "pipe" },
  );
  if (bootstrap.exitCode !== 0) throw new Error(`bootstrap failed: ${bootstrap.stderr.toString()}`);

  let operators = 0;
  return {
    host,
    port,
    database: DB,
    passwords,
    superuser,
    setIdentity(kind) {
      superuser(
        kind === null
          ? "DELETE FROM deployment_identity;"
          : `DELETE FROM deployment_identity; INSERT INTO deployment_identity (kind) VALUES ('${kind}');`,
      );
    },
    operator(name, extraEnvLines = []) {
      const home = join(work, `home-${name}-${++operators}`);
      const root = join(work, `state-${name}-${operators}`);
      mkdirSync(home, { recursive: true });
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(home, ".env"),
        [
          `host = ${host}`,
          `port = ${port}`,
          `database = ${DB}`,
          "sslmode = disable",
          `rm_app = ${passwords.rm_app}`,
          `rm_worker = ${passwords.rm_worker}`,
          `rm_readonly = ${passwords.rm_readonly}`,
          ...extraEnvLines,
          "",
        ].join("\n"),
      );
      const roster = join(work, `roster-${name}-${operators}.json`);
      writeFileSync(roster, JSON.stringify({ agents: {}, judges: {} }));
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, RM_SMOKE_STATE_ROOT: root, TERM: "dumb", AGENT_MODEL: "free" };
      for (const key of ["DOCKER_HOST", "DOCKER_CONFIG", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR"]) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      return { env, home, root, roster };
    },
    close() {
      sh(["docker", "rm", "-f", "-v", container]);
      rmSync(work, { recursive: true, force: true });
    },
  };
}

/**
 * The instance's three token files, as `bun scripts/prod-init.ts
 * provision-tokens` leaves them (smoke spec §5). A remote boot refuses without
 * them before its target read (criterion 43,
 * scripts/tests/integration/smoke-remote-tokens.test.ts, which drives that
 * refusal itself). The boots here are about the §4.3 matrix and the migrate
 * run, and none of them runs far enough to present a token, so placeholders
 * stand in for the provisioned files.
 */
export function holdTokenFiles(op: Operator, instance: string): void {
  const paths = instancePaths(op.root, instance);
  for (const holder of SERVICE_TOKEN_HOLDERS) {
    mkdirSync(dirname(paths.tokenFiles[holder]), { recursive: true, mode: 0o700 });
    writeFileSync(paths.tokenFiles[holder], `rmat_placeholder_${holder}\n`, { mode: 0o600 });
  }
}

/** A boot on a pseudo-terminal, driven by what appears on it. */
export function onTerminal(argv: readonly string[], env: Record<string, string>) {
  const command = argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const child = Bun.spawn(["script", "-qefc", command, "/dev/null"], { cwd: repoRoot, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let screen = "";
  const decoder = new TextDecoder();
  const pump = (async () => {
    for await (const chunk of child.stdout) screen += decoder.decode(chunk);
  })();
  return {
    screen: () => screen,
    async waitFor(text: string, timeoutMs = 120_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!screen.includes(text)) {
        if (child.exitCode !== null) throw new Error(`the boot exited ${child.exitCode} before "${text}":\n${screen.slice(-3000)}`);
        if (Date.now() > deadline) throw new Error(`timed out waiting for "${text}":\n${screen.slice(-3000)}`);
        await Bun.sleep(25);
      }
    },
    async type(text: string): Promise<void> {
      child.stdin.write(text);
      await child.stdin.flush();
    },
    async exited(): Promise<number> {
      const code = await child.exited;
      await pump;
      try {
        child.stdin.end();
      } catch {
        // closed with the process
      }
      return code;
    },
    kill: () => child.kill("SIGKILL"),
  };
}
