// `bun smoke --migrate` against a REMOTE rehearsal, at the smoke entry point —
// criterion 53 (smoke-production-spec.md §4.3, §8.5) and the password half of
// criterion 14.
//
//   §8.5: "`--migrate` ... refuses on `RM_ENV=prod` or `deployment_identity ≠
//          rehearsal`. In local modes it uses the owner password smoke
//          generated. On a remote connection it prompts for `rm_owner`, warns,
//          and asks `y/n`."
//
// Every case runs the real `bun --no-env-file scripts/smoke.ts` process — the
// command an operator types — against a "remote" database: a Postgres container
// of this file's own, published on the Docker bridge address (a host address,
// not loopback, exactly as a managed server is to the stack), provisioned the
// way §9.1 leaves production — the four roles, `rm_owner` LOGIN, the schema
// bootstrapped from the snapshot by `rm_owner` — with a `~/.env` holding only
// the §3 keys. The interactive cases run under `script(1)`, so the boot and the
// preparation it starts see a real terminal; nothing is piped into a prompt
// that a terminal would not also deliver.
//
// What each case proves, and where the refusal lands:
//   - RM_ENV=prod refuses before anything connects — no prompt at all;
//   - a production enrollment, and an absent one, refuse at the plan's read —
//     no prompt;
//   - on a rehearsal target the prompt names rm_owner, the warning prints, and
//     `n`, an empty line and `yes` each refuse with nothing migrated;
//   - `y` proceeds: the migrate run commits (journaled), and the boot is then
//     stopped at its next boundary by a Ctrl-C typed at the terminal;
//   - the typed password is in NONE of the plan the boot printed, its journal,
//     its migrate receipt or any other file under the instance's state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POSTGRES_IMAGE } from "../../lib/postgres-image.ts";
import { instancePaths } from "../../lib/smoke-state.ts";
import { readJournal } from "../../lib/smoke-journal.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const BACKEND = join(repoRoot, "backend");
const DB = "robotmoney";
const PASSWORDS = {
  rm_owner: `owner-${randomBytes(9).toString("hex")}`,
  rm_app: `app-${randomBytes(9).toString("hex")}`,
  rm_worker: `worker-${randomBytes(9).toString("hex")}`,
  rm_readonly: `readonly-${randomBytes(9).toString("hex")}`,
};

let container = "";
let bridge = "";
let port = 0;
let work = "";

function sh(argv: string[], stdin?: string): { code: number; out: string } {
  const r = Bun.spawnSync(argv, { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

/** SQL as the container's superuser — the stand-in for doadmin (§9.1). */
function superuser(sql: string): string {
  const r = sh(["docker", "exec", "-i", container, "psql", "-X", "-q", "-At", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-f", "-"], sql);
  if (r.code !== 0) throw new Error(`superuser SQL failed: ${r.out}`);
  return r.out.trim();
}

function ownerUrl(): string {
  return `postgres://rm_owner:${PASSWORDS.rm_owner}@${bridge}:${port}/${DB}?sslmode=disable`;
}

async function setIdentity(kind: "production" | "rehearsal" | null): Promise<void> {
  superuser(
    kind === null
      ? "DELETE FROM deployment_identity;"
      : `DELETE FROM deployment_identity; INSERT INTO deployment_identity (kind) VALUES ('${kind}');`,
  );
}

beforeAll(async () => {
  bridge = sh(["docker", "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"]).out.trim();
  container = `rm_it_remote_${randomBytes(4).toString("hex")}`;
  const run = sh([
    "docker", "run", "-d", "--rm", "--name", container, "--label", "robotmoney.test=smoke-external-migrate",
    "-e", "POSTGRES_PASSWORD=unused-superuser", "-e", `POSTGRES_DB=${DB}`, "-p", `${bridge}::5432`, POSTGRES_IMAGE,
  ]);
  if (run.code !== 0) throw new Error(`docker run failed: ${run.out}`);
  port = Number(sh(["docker", "inspect", "-f", '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container]).out.trim());
  // The entrypoint's temporary init server answers before the real one: wait
  // for a real query from the HOST side, over the address the boot will use.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const probe = sh(["docker", "exec", container, "psql", "-U", "postgres", "-h", "127.0.0.1", "-d", DB, "-Atc", "SELECT 1"]);
    if (probe.code === 0 && probe.out.trim() === "1") break;
    if (Date.now() > deadline) throw new Error(`the remote database never became ready: ${probe.out}`);
    await Bun.sleep(500);
  }
  await Bun.sleep(1000);
  // §9.1 shape: the four roles, rm_owner LOGIN without CREATEROLE, the database
  // owned by rm_owner, the provider's extension.
  superuser(
    Object.entries(PASSWORDS)
      .map(([role, pw]) => `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEROLE PASSWORD '${pw}';`)
      .join("\n") + `\nALTER DATABASE ${DB} OWNER TO rm_owner;\nCREATE EXTENSION IF NOT EXISTS pgcrypto;\n`,
  );
  // The schema, bootstrapped from the snapshot by rm_owner (the real function).
  const bootstrap = Bun.spawnSync(
    ["bun", "-e", 'import postgres from "postgres"; import { bootstrapBlankDatabase, loadSnapshot } from "./src/db/schema-snapshot.ts"; const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} }); await bootstrapBlankDatabase(db, await loadSnapshot()); await db.end(); process.exit(0);'],
    { cwd: BACKEND, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: ownerUrl(), RM_ENV: "stage" }, stdout: "pipe", stderr: "pipe" },
  );
  if (bootstrap.exitCode !== 0) throw new Error(`bootstrap failed: ${bootstrap.stderr.toString()}`);
  work = mkdtempSync(join(tmpdir(), "rm-remote-migrate-"));
}, 180_000);

afterAll(() => {
  if (container) sh(["docker", "rm", "-f", "-v", container]);
  if (work) rmSync(work, { recursive: true, force: true });
});

/** A fresh HOME holding exactly the §3 keys, and a state root, for one boot. */
function operator(name: string): { env: Record<string, string>; root: string; instance: string } {
  const home = join(work, `home-${name}`);
  const root = join(work, `state-${name}`);
  Bun.spawnSync(["mkdir", "-p", home, root]);
  writeFileSync(
    join(home, ".env"),
    [
      `host = ${bridge}`,
      `port = ${port}`,
      `database = ${DB}`,
      "sslmode = disable",
      `rm_app = ${PASSWORDS.rm_app}`,
      `rm_worker = ${PASSWORDS.rm_worker}`,
      `rm_readonly = ${PASSWORDS.rm_readonly}`,
      "",
    ].join("\n"),
  );
  const roster = join(work, `roster-${name}.json`);
  writeFileSync(roster, JSON.stringify({ agents: {}, judges: {} }));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, RM_SMOKE_STATE_ROOT: root, TERM: "dumb", AGENT_MODEL: "free", RM_CREDENTIALS_FILE: roster };
  for (const key of ["DOCKER_HOST", "DOCKER_CONFIG", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { env, root, instance: `rm_it_remote_${name}` };
}

function bootArgv(op: ReturnType<typeof operator>): string[] {
  return ["bun", "--no-env-file", "scripts/smoke.ts", "--migrate", "--instance", op.instance, "--credentials", op.env.RM_CREDENTIALS_FILE!, "--lock-timeout", "10"];
}

/** A boot with no terminal: every refusal below must come before any prompt. */
function runPlain(op: ReturnType<typeof operator>, rmEnv: string): { code: number; out: string } {
  const r = Bun.spawnSync(bootArgv(op), { cwd: repoRoot, env: { ...op.env, RM_ENV: rmEnv }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

/** A boot on a pseudo-terminal, driven by what appears on it. */
function onTerminal(op: ReturnType<typeof operator>, rmEnv: string) {
  const command = bootArgv(op).map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const child = Bun.spawn(["script", "-qefc", command, "/dev/null"], {
    cwd: repoRoot,
    env: { ...op.env, RM_ENV: rmEnv },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
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

function ledger(): string[] {
  return superuser("SELECT name FROM schema_migrations ORDER BY name;").split("\n").filter(Boolean);
}

describe("`bun smoke --migrate` on a remote database — refusals before any prompt (§4.3, §8.5)", () => {
  test("RM_ENV=prod refuses before anything connects, and never asks for a password", async () => {
    await setIdentity("production");
    const op = operator("prod");
    const { code, out } = runPlain(op, "prod");
    expect(code).not.toBe(0);
    expect(out).toContain("--migrate is refused under RM_ENV=prod");
    expect(out).not.toContain("rm_owner password");
    expect(out).not.toContain("phase:");
  }, 60_000);

  test("a PRODUCTION enrollment refuses at the plan's read, before any prompt — stage never touches production data", async () => {
    await setIdentity("production");
    const op = operator("production");
    const { code, out } = runPlain(op, "stage");
    expect(code).not.toBe(0);
    expect(out).toContain("RM_ENV=stage against a remote target whose deployment_identity is production");
    expect(out).not.toContain("rm_owner password");
    expect(out).not.toContain("phase:");
  }, 60_000);

  test("an ABSENT enrollment refuses the same way — absence of evidence is not evidence of rehearsal", async () => {
    await setIdentity(null);
    const op = operator("absent");
    const { code, out } = runPlain(op, "stage");
    expect(code).not.toBe(0);
    expect(out).toContain("deployment_identity is no identity row");
    expect(out).not.toContain("rm_owner password");
  }, 60_000);

  test("a rehearsal target with no terminal refuses at the prompt rather than read a password from anywhere", async () => {
    await setIdentity("rehearsal");
    const op = operator("noterm");
    const { code, out } = runPlain(op, "stage");
    expect(code).not.toBe(0);
    expect(out).toMatch(/non-interactive|stdin is not a terminal/);
    expect(out).toContain("phase: prepare (migrate)");
  }, 120_000);
});

describe("`bun smoke --migrate` on a remote REHEARSAL, on a terminal: prompt, warning, explicit y (§8.5)", () => {
  for (const answer of ["n", "", "yes"]) {
    test(`the prompt names rm_owner, the warning prints, and ${JSON.stringify(answer)} refuses with nothing migrated`, async () => {
      await setIdentity("rehearsal");
      const before = ledger();
      const op = operator(`answer_${answer || "empty"}`);
      const boot = onTerminal(op, "stage");
      try {
        await boot.waitFor("rm_owner password (not echoed, not stored)");
        await boot.type(`${PASSWORDS.rm_owner}\r`);
        await boot.waitFor("type y to continue");
        expect(boot.screen()).toContain("WARNING: this will apply pending migrations to the REMOTE target");
        expect(boot.screen()).toContain(`${bridge}:${port}/${DB}`);
        await boot.type(`${answer}\r`);
        const code = await boot.exited();
        expect(code).not.toBe(0);
        expect(boot.screen()).toContain("was not confirmed (an explicit y is required)");
        expect(boot.screen()).not.toContain(PASSWORDS.rm_owner);
      } finally {
        boot.kill();
      }
      expect(ledger()).toEqual(before);
    }, 180_000);
  }

  test("`y` proceeds: the migrate run commits, a Ctrl-C at the terminal then stops the boot at its next boundary, and the typed password is nowhere", async () => {
    await setIdentity("rehearsal");
    const op = operator("yes_y");
    const boot = onTerminal(op, "stage");
    try {
      await boot.waitFor("rm_owner password (not echoed, not stored)");
      await boot.type(`${PASSWORDS.rm_owner}\r`);
      await boot.waitFor("type y to continue");
      await boot.type("y\r");
      await boot.waitFor("phase: prepare (assemble)", 180_000);
      // Ctrl-C AT THE TERMINAL: the kernel signals the whole foreground
      // process group. The assembly child runs in its own group and finishes;
      // the boot stops at the next boundary.
      await boot.type("\x03");
      const code = await boot.exited();
      expect(code).toBe(130);
    } finally {
      boot.kill();
    }

    const paths = instancePaths(op.root, op.instance);
    const journal = readJournal(paths)!;
    const records = journal.phases.map((r) => [r.phase, r.step, r.status]);
    expect(records).toContainEqual(["prepare", "migrate", "committed"]);
    // The step running when Ctrl-C arrived was not killed by it: it committed,
    // and the stop was journaled at the boundary after it.
    expect(records).toContainEqual(["prepare", "assemble", "committed"]);
    expect(journal.phases.at(-1)?.status).toBe("interrupted");

    // The run's migrate receipt is in the instance's state, and names the lock.
    const receipts = readdirSync(paths.dir).filter((f) => f.startsWith("migrate-receipt-"));
    expect(receipts.length).toBe(1);
    expect(JSON.parse(readFileSync(join(paths.dir, receipts[0]!), "utf8")).targetLock).toContain("smoke");

    // Criterion 14, the typed half: the owner password is in nothing this run
    // printed or wrote — the plan on the terminal, the journal, the receipt,
    // any file under the instance's state.
    expect(boot.screen()).not.toContain(PASSWORDS.rm_owner);
    for (const file of readdirSync(paths.dir, { recursive: true }) as string[]) {
      const path = join(paths.dir, file);
      if (statSync(path).isFile()) expect({ file, leaked: readFileSync(path, "utf8").includes(PASSWORDS.rm_owner) }).toEqual({ file, leaked: false });
    }
  }, 600_000);
});
