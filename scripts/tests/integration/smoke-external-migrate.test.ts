// `bun smoke --migrate` against a REMOTE rehearsal, at the smoke entry point —
// criterion 53 (smoke-production-spec.md §4.3, §8.5), the password half of
// criterion 14, and decision D61.
//
//   §8.5: "`--migrate` ... refuses on `RM_ENV=prod` or `deployment_identity ≠
//          rehearsal`. In local modes it uses the owner password smoke
//          generated."
//   D61:  the remote owner password is `~/.env`'s `rm_owner` line, and the
//         `y` is `--confirm-target <host:port/database>`, which must name
//         exactly the target `~/.env` resolves to. Nothing prompts.
//
// Every case runs the real `bun --no-env-file scripts/smoke.ts` process — the
// command the release runbook runs — against a "remote" database provisioned
// the way §9.1 leaves production (./remote-db-harness.ts), with a `~/.env`
// holding the §3 keys and, per case, the `rm_owner` and `doadmin` lines.
//
// It lives in the INTEGRATION tier: every case needs Docker (the remote
// database is a container of its own) and the success case runs a boot up to
// image assembly. The unit tier removes the docker binary before any test step
// (.github/workflows/unit.yml), so nothing here may sit under tests/unit.
//
// What each case proves, and where the refusal lands:
//   - RM_ENV=prod refuses before anything connects;
//   - no `rm_owner` line, no `--confirm-target`, and a wrong one each refuse
//     before anything connects, naming what is missing (the wrong target is
//     printed beside the resolved one);
//   - a production enrollment, and an absent one, refuse under the target
//     lock, on the matrix's locked read (spec §7, criterion 34);
//   - with no terminal at all, a wrong `rm_owner` line reaches the migrate
//     step and refuses there by name: nothing in the path waits on a person;
//   - the exact flag and the right line proceed: the migrate run commits, and
//     the boot is then stopped at its next boundary by a Ctrl-C (the
//     pseudo-terminal exists only to deliver that Ctrl-C);
//   - neither the rm_owner nor the doadmin password is in the plan the boot
//     printed, its journal, its migrate receipt or any other file under the
//     instance's state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { instancePaths } from "../../lib/smoke-state.ts";
import { readJournal } from "../../lib/smoke-journal.ts";
import { holdTokenFiles, onTerminal, repoRoot, startRemoteDb, type Operator, type RemoteDb } from "./remote-db-harness.ts";

let db: RemoteDb;

beforeAll(async () => {
  db = await startRemoteDb("ext_migrate");
}, 180_000);

afterAll(() => db?.close());

const instanceOf = (name: string) => `rm_it_remote_${name}`;
const DOADMIN = "doadmin-value-that-no-step-may-use";

/** The target `~/.env` resolves to, as the harness writes it. */
const target = (): string => `${db.host}:${db.port}/${db.database}`;

interface Authority {
  /** The rm_owner line's value; `null` for no line. Default: the real password. */
  readonly owner?: string | null;
  /** `--confirm-target`; `null` for no flag. Default: the exact target. */
  readonly confirm?: string | null;
}

function operatorFor(name: string, authority: Authority): Operator {
  const owner = authority.owner === undefined ? db.passwords.rm_owner : authority.owner;
  return db.operator(name, [...(owner === null ? [] : [`rm_owner = ${owner}`]), `doadmin = ${DOADMIN}`]);
}

function bootArgv(op: Operator, name: string, authority: Authority, flag = "--migrate"): string[] {
  holdTokenFiles(op, instanceOf(name));
  const confirm = authority.confirm === undefined ? target() : authority.confirm;
  const argv = ["bun", "--no-env-file", "scripts/smoke.ts", flag, "--instance", instanceOf(name), "--credentials", op.roster, "--lock-timeout", "10"];
  return confirm === null ? argv : [...argv, "--confirm-target", confirm];
}

/** A boot with no terminal at all: stdin closed (D61 rule 1). */
function runPlain(name: string, rmEnv: string, authority: Authority = {}, flag = "--migrate"): { code: number; out: string; op: Operator } {
  const op = operatorFor(name, authority);
  const argv = bootArgv(op, name, authority, flag);
  for (const secret of [db.passwords.rm_owner, DOADMIN]) expect(argv.join(" ")).not.toContain(secret);
  const r = Bun.spawnSync(argv, { cwd: repoRoot, env: { ...op.env, RM_ENV: rmEnv }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}`, op };
}

/** The matrix refused under the target lock: `lock` failed, nothing after it began. */
function expectRefusedAtTheLock(op: Operator, name: string, out: string): void {
  const last = readJournal(instancePaths(op.root, instanceOf(name)))!.phases.at(-1)!;
  expect([last.phase, last.step, last.status]).toEqual(["prepare", "lock", "failed"]);
  expect(out).not.toContain("phase: prepare (migrate)");
}

function ledger(): string[] {
  return db.superuser("SELECT name FROM schema_migrations ORDER BY name;").split("\n").filter(Boolean);
}

describe("`bun smoke --migrate` on a remote database — refusals before anything connects (§4.3, §8.5, D61)", () => {
  test("RM_ENV=prod refuses before anything connects", () => {
    db.setIdentity("production");
    const { code, out } = runPlain("prod", "prod");
    expect(code).not.toBe(0);
    expect(out).toContain("--migrate is refused under RM_ENV=prod");
    expect(out).not.toContain("phase:");
  }, 60_000);

  test("`--seed` refuses on RM_ENV=prod the same way — before anything connects (§4.3: rehearsal-only preparation)", () => {
    db.setIdentity("production");
    const { code, out } = runPlain("prod_seed", "prod", {}, "--seed");
    expect(code).not.toBe(0);
    expect(out).toContain("--seed is refused under RM_ENV=prod");
    expect(out).not.toContain("phase:");
  }, 60_000);

  test("D61: no rm_owner line refuses before anything connects, naming the key and the file", () => {
    db.setIdentity("rehearsal");
    const { code, out, op } = runPlain("noowner", "stage", { owner: null });
    expect(code).not.toBe(0);
    expect(out).toContain(`${join(op.home, ".env")} has no rm_owner line`);
    expect(out).not.toContain("phase:");
  }, 60_000);

  test("D61: no --confirm-target refuses before anything connects, naming the target to confirm", () => {
    db.setIdentity("rehearsal");
    const { code, out } = runPlain("noconfirm", "stage", { confirm: null });
    expect(code).not.toBe(0);
    expect(out).toContain(`no --confirm-target was given. Pass --confirm-target ${target()}`);
    expect(out).not.toContain("phase:");
  }, 60_000);

  test("D61: a wrong --confirm-target refuses before anything connects, printing both", () => {
    db.setIdentity("rehearsal");
    const wrong = `${db.host}:${db.port}/${db.database}_other`;
    const { code, out } = runPlain("wrongconfirm", "stage", { confirm: wrong });
    expect(code).not.toBe(0);
    expect(out).toContain(JSON.stringify(wrong));
    expect(out).toContain(JSON.stringify(target()));
    expect(out).not.toContain("phase:");
  }, 60_000);

  test("D61: `--seed` takes the same --confirm-target: a wrong one refuses before anything connects", () => {
    db.setIdentity("rehearsal");
    const { code, out } = runPlain("wrongconfirm_seed", "stage", { confirm: "elsewhere:5432/x" }, "--seed");
    expect(code).not.toBe(0);
    expect(out).toContain(JSON.stringify("elsewhere:5432/x"));
    expect(out).not.toContain("phase:");
  }, 60_000);
});

describe("`bun smoke --migrate` on a remote database — refusals under the target lock (§4.3, §7)", () => {
  test("a PRODUCTION enrollment refuses under the target lock — stage never touches production data", () => {
    db.setIdentity("production");
    const { code, out, op } = runPlain("production", "stage");
    expect(code).not.toBe(0);
    expect(out).toContain("RM_ENV=stage against a remote target whose deployment_identity is production");
    expectRefusedAtTheLock(op, "production", out);
  }, 120_000);

  test("an ABSENT enrollment refuses the same way — absence of evidence is not evidence of rehearsal", () => {
    db.setIdentity(null);
    const { code, out, op } = runPlain("absent", "stage");
    expect(code).not.toBe(0);
    expect(out).toContain("deployment_identity is no identity row");
    expectRefusedAtTheLock(op, "absent", out);
  }, 120_000);

  test("with no terminal, a wrong rm_owner line reaches the migrate step and refuses there by name, with nothing migrated", () => {
    db.setIdentity("rehearsal");
    const before = ledger();
    const wrong = "not-the-owner-password";
    const { code, out } = runPlain("wrongowner", "stage", { owner: wrong });
    expect(code).not.toBe(0);
    expect(out).toContain("phase: prepare (migrate)");
    expect(out).toContain("the rm_owner credential was not accepted");
    expect(out).not.toContain(wrong);
    expect(ledger()).toEqual(before);
  }, 120_000);
});

describe("`bun smoke --migrate` on a remote REHEARSAL with ~/.env's rm_owner and the exact --confirm-target (D61)", () => {
  test("proceeds: the migrate run commits, a Ctrl-C then stops the boot at its next boundary, and neither privileged password is anywhere", async () => {
    db.setIdentity("rehearsal");
    const op = operatorFor("yes_flag", {});
    const boot = onTerminal(bootArgv(op, "yes_flag", {}), { ...op.env, RM_ENV: "stage" });
    try {
      // The migrate run has committed once the boot moves on to placing the
      // site. (The site is ASSEMBLED before the lock — smoke spec §13.3 — and
      // placed after the database half.)
      await boot.waitFor("phase: prepare (site)", 180_000);
      expect(boot.screen()).toContain(`WARNING: this writes the REMOTE target ${target()}`);
      // Ctrl-C AT THE TERMINAL: the kernel signals the whole foreground
      // process group. The boot honours it at its next boundary, after the
      // step in flight commits. (The pseudo-terminal is here for this
      // keystroke only; nothing before it read the terminal.)
      await boot.type("\x03");
      const code = await boot.exited();
      expect(code).toBe(130);
    } finally {
      boot.kill();
    }

    const paths = instancePaths(op.root, instanceOf("yes_flag"));
    const journal = readJournal(paths)!;
    const records = journal.phases.map((r) => [r.phase, r.step, r.status]);
    expect(records).toContainEqual(["prepare", "migrate", "committed"]);
    expect(records).toContainEqual(["prepare", "assemble", "committed"]);
    expect(journal.phases.at(-1)?.status).toBe("interrupted");
    expect(records.slice(0, -1).filter(([, , status]) => status !== "committed")).toEqual([]);

    // The run's migrate receipt is in the instance's state, and names the lock.
    const receipts = readdirSync(paths.dir).filter((f) => f.startsWith("migrate-receipt-"));
    expect(receipts.length).toBe(1);
    expect(JSON.parse(readFileSync(join(paths.dir, receipts[0]!), "utf8")).targetLock).toContain("smoke");

    // Criterion 14 and D61: neither privileged password is in anything this
    // run printed or wrote — the plan, the journal, the receipt, any file
    // under the instance's state.
    for (const secret of [db.passwords.rm_owner, DOADMIN]) {
      expect(boot.screen()).not.toContain(secret);
      for (const file of readdirSync(paths.dir, { recursive: true }) as string[]) {
        const path = join(paths.dir, file);
        if (statSync(path).isFile()) expect({ file, leaked: readFileSync(path, "utf8").includes(secret) }).toEqual({ file, leaked: false });
      }
    }
  }, 600_000);
});

// Criterion 52 in a real process, and the seed step's "gates before the
// owner": `--seed` refuses a POPULATED database, and on a remote target it
// refuses before it ever logs in as rm_owner. Last in the file: the case
// populates the shared remote database, and nothing after it needs it blank.
describe("`bun smoke --seed` on a remote rehearsal: the populated-database gate runs before the owner login (§5, criterion 52)", () => {
  // A wrong rm_owner line: a seed that gets past its gate stops at the owner
  // login, by name, so neither case below ever seeds the shared database.
  const WRONG_OWNER = "seed-wrong-owner-password";

  test("red control: on the still-BLANK rehearsal the gate passes, and the step gets as far as the owner login", () => {
    db.setIdentity("rehearsal");
    const { code, out } = runPlain("seed_blank", "stage", { owner: WRONG_OWNER }, "--seed");
    expect(code).not.toBe(0);
    expect(out).toContain("phase: prepare (seed)");
    expect(out).not.toContain("the database is populated");
    expect(out).toContain("the rm_owner credential was not accepted");
  }, 120_000);

  test("on a POPULATED rehearsal `--seed` refuses by name, before the owner login, with the seed step journaled failed", () => {
    db.setIdentity("rehearsal");
    // A row no blank bootstrap writes, put there the way live use would.
    db.superuser("INSERT INTO jobs (kind, payload) VALUES ('wallet.sample_balances', '{}'::jsonb);");
    const { code, out, op } = runPlain("seed_populated", "stage", { owner: WRONG_OWNER }, "--seed");
    expect(code).not.toBe(0);
    expect(out).toContain("Refusing --seed: the database is populated");
    expect(out).toContain("jobs (");
    expect(out).not.toContain("the rm_owner credential was not accepted");
    const last = readJournal(instancePaths(op.root, instanceOf("seed_populated")))!.phases.at(-1)!;
    expect([last.phase, last.step, last.status]).toEqual(["prepare", "seed", "failed"]);
  }, 120_000);
});
