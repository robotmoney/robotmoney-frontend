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
// command an operator types — against a "remote" database provisioned the way
// §9.1 leaves production (scripts/tests/integration/remote-db-harness.ts), with
// a `~/.env` holding only the §3 keys. The interactive cases run under
// `script(1)`, so the boot and the preparation it starts see a real terminal;
// nothing is piped into a prompt that a terminal would not also deliver.
//
// What each case proves, and where the refusal lands:
//   - RM_ENV=prod refuses before anything connects — no prompt at all;
//   - a production enrollment, and an absent one, refuse at the plan's read —
//     no prompt;
//   - on a rehearsal target without a terminal, the prompt refuses rather than
//     read a password from anywhere;
//   - on a terminal the prompt names rm_owner, the warning prints, and `n`, an
//     empty line and `yes` each refuse with nothing migrated;
//   - `y` proceeds: the migrate run commits (journaled), and the boot is then
//     stopped at its next boundary by a Ctrl-C typed at the terminal;
//   - the typed password is in NONE of the plan the boot printed, its journal,
//     its migrate receipt or any other file under the instance's state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { instancePaths } from "../../lib/smoke-state.ts";
import { readJournal } from "../../lib/smoke-journal.ts";
import { onTerminal, repoRoot, startRemoteDb, type Operator, type RemoteDb } from "../integration/remote-db-harness.ts";

let db: RemoteDb;

beforeAll(async () => {
  db = await startRemoteDb("ext_migrate");
}, 180_000);

afterAll(() => db?.close());

const instanceOf = (name: string) => `rm_it_remote_${name}`;

function bootArgv(op: Operator, name: string): string[] {
  return ["bun", "--no-env-file", "scripts/smoke.ts", "--migrate", "--instance", instanceOf(name), "--credentials", op.roster, "--lock-timeout", "10"];
}

/** A boot with no terminal: every refusal below must come before any prompt. */
function runPlain(name: string, rmEnv: string): { code: number; out: string } {
  const op = db.operator(name);
  const r = Bun.spawnSync(bootArgv(op, name), { cwd: repoRoot, env: { ...op.env, RM_ENV: rmEnv }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

function ledger(): string[] {
  return db.superuser("SELECT name FROM schema_migrations ORDER BY name;").split("\n").filter(Boolean);
}

describe("`bun smoke --migrate` on a remote database — refusals before any prompt (§4.3, §8.5)", () => {
  test("RM_ENV=prod refuses before anything connects, and never asks for a password", () => {
    db.setIdentity("production");
    const { code, out } = runPlain("prod", "prod");
    expect(code).not.toBe(0);
    expect(out).toContain("--migrate is refused under RM_ENV=prod");
    expect(out).not.toContain("rm_owner password");
    expect(out).not.toContain("phase:");
  }, 60_000);

  test("a PRODUCTION enrollment refuses at the plan's read, before any prompt — stage never touches production data", () => {
    db.setIdentity("production");
    const { code, out } = runPlain("production", "stage");
    expect(code).not.toBe(0);
    expect(out).toContain("RM_ENV=stage against a remote target whose deployment_identity is production");
    expect(out).not.toContain("rm_owner password");
    expect(out).not.toContain("phase:");
  }, 60_000);

  test("an ABSENT enrollment refuses the same way — absence of evidence is not evidence of rehearsal", () => {
    db.setIdentity(null);
    const { code, out } = runPlain("absent", "stage");
    expect(code).not.toBe(0);
    expect(out).toContain("deployment_identity is no identity row");
    expect(out).not.toContain("rm_owner password");
  }, 60_000);

  test("a rehearsal target with no terminal refuses at the prompt rather than read a password from anywhere", () => {
    db.setIdentity("rehearsal");
    const { code, out } = runPlain("noterm", "stage");
    expect(code).not.toBe(0);
    expect(out).toMatch(/non-interactive|stdin is not a terminal/);
    expect(out).toContain("phase: prepare (migrate)");
  }, 120_000);
});

describe("`bun smoke --migrate` on a remote REHEARSAL, on a terminal: prompt, warning, explicit y (§8.5)", () => {
  for (const answer of ["n", "", "yes"]) {
    test(`the prompt names rm_owner, the warning prints, and ${JSON.stringify(answer)} refuses with nothing migrated`, async () => {
      db.setIdentity("rehearsal");
      const before = ledger();
      const name = `answer_${answer || "empty"}`;
      const op = db.operator(name);
      const boot = onTerminal(bootArgv(op, name), { ...op.env, RM_ENV: "stage" });
      try {
        await boot.waitFor("rm_owner password (not echoed, not stored)");
        await boot.type(`${db.passwords.rm_owner}\r`);
        await boot.waitFor("type y to continue");
        expect(boot.screen()).toContain("WARNING: this will apply pending migrations to the REMOTE target");
        expect(boot.screen()).toContain(`${db.host}:${db.port}/${db.database}`);
        await boot.type(`${answer}\r`);
        const code = await boot.exited();
        expect(code).not.toBe(0);
        expect(boot.screen()).toContain("was not confirmed (an explicit y is required)");
        expect(boot.screen()).not.toContain(db.passwords.rm_owner);
      } finally {
        boot.kill();
      }
      expect(ledger()).toEqual(before);
    }, 180_000);
  }

  test("`y` proceeds: the migrate run commits, a Ctrl-C at the terminal then stops the boot at its next boundary, and the typed password is nowhere", async () => {
    db.setIdentity("rehearsal");
    const op = db.operator("yes_y");
    const boot = onTerminal(bootArgv(op, "yes_y"), { ...op.env, RM_ENV: "stage" });
    try {
      await boot.waitFor("rm_owner password (not echoed, not stored)");
      await boot.type(`${db.passwords.rm_owner}\r`);
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

    const paths = instancePaths(op.root, instanceOf("yes_y"));
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
    expect(boot.screen()).not.toContain(db.passwords.rm_owner);
    for (const file of readdirSync(paths.dir, { recursive: true }) as string[]) {
      const path = join(paths.dir, file);
      if (statSync(path).isFile()) expect({ file, leaked: readFileSync(path, "utf8").includes(db.passwords.rm_owner) }).toEqual({ file, leaked: false });
    }
  }, 600_000);
});
