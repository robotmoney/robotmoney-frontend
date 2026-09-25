// The first production migrate — smoke-production-spec.md §10 W2, verbatim:
//
//   "First production migrate: with no `deployment_identity` row and a ledger
//   exactly equal to v0.5.0's, `RM_ENV=prod`, a typed `rm_owner` and `y`
//   migrate once and receipt the pre-identity state. A ledger with one file
//   more or less, `RM_ENV=stage`, a missing owner password, or any answer but
//   `y` refuses and changes nothing. A second run with no row still refuses."
//
// Governed by §4.3's one exception and §9.1 ("The first production migrate
// runs before the identity row exists"), D55 (5) and (8); implemented by
// backend/scripts/migrate-run.ts (`readPreIdentityState`, the gates, and
// `runMigrate`'s hold on the confirmed state) with the ledger match in
// backend/src/db/supported-releases.ts.
//
// EVERY CASE IS THE OPERATOR'S COMMAND, AS A PROCESS. `bun run migrate` runs
// under a pseudo-terminal (tests/fixtures/releases/release-fixture.ts
// `migrateAtTerminal`), reading its target from a `$HOME/.env` that holds an
// `rm_readonly` line and nothing that can migrate, prompting for rm_owner with
// the real masked prompt and asking the real `y/n`. A refusal is judged by what
// the terminal showed, the journal the command left beside its receipt, and a
// database compared before and after — never by a module call.
//
// THE DATABASES. v0.5.0 predates 0063, so its database has no
// `deployment_identity` table at all, which is the case production is in. It
// is built from v0.5.0's own migration bytes by v0.5.0's runner loop, once,
// without its last file; the ledger variants are copies of that one:
//   exact    — plus the last file: the ledger IS v0.5.0's list;
//   less     — as built: one file missing;
//   renamed  — plus the last file's DDL recorded under another name;
//   more     — exact plus the first branch file v0.5.0 lacks, applied.
// §9.1 step 1 (`rm_owner LOGIN PASSWORD …` through the provisioning login) is
// performed on the cluster first, as it must be before any migrate run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { config } from "../src/config.ts";
import { runMigrate } from "../scripts/migrate-run.ts";
import type { MigrateJournalFile } from "../scripts/migrate-journal.ts";
import { SUPPORTED_RELEASES } from "../src/db/supported-releases.ts";
import {
  HEAD_FILES,
  MIGRATIONS_DIR,
  applyAsReleaseRunner,
  loadRelease,
  migrateAtTerminal,
  releaseSteps,
  restoreLogins,
  restoreRoles,
  revokeLoginDefaults,
  saveRoles,
  type SavedRole,
  type TerminalRun,
  type TerminalStep,
} from "./fixtures/releases/release-fixture.ts";
import { withTargetLock } from "./support/target-lock.ts";

const TAG = "v0.5.0";
const release = loadRelease(TAG);
const RELEASE_FILES = release.migrations.map((m) => m.file);
const LAST = RELEASE_FILES.at(-1)!;
/** The first branch file v0.5.0 lacks, in apply order — the "one file more". */
const FIRST_UNSHIPPED = HEAD_FILES.find((file) => !RELEASE_FILES.includes(file))!;
const RENAMED = LAST.replace(/\.sql$/, "_renamed.sql");

const LOGIN = new URL(config.databaseUrl).username;
const OWNER_PASSWORD = randomBytes(18).toString("base64url");
const READONLY_PASSWORD = randomBytes(12).toString("hex");

const suffix = randomBytes(4).toString("hex");
const DB = {
  base: `rm_fpm_base_${suffix}`,
  exact: `rm_fpm_exact_${suffix}`,
  less: `rm_fpm_less_${suffix}`,
  renamed: `rm_fpm_renamed_${suffix}`,
  more: `rm_fpm_more_${suffix}`,
} as const;

function urlFor(database: string, role?: { name: string; password: string }): URL {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.name;
    url.password = encodeURIComponent(role.password);
  }
  return url;
}

function connect(database: string): postgres.Sql<{}> {
  return postgres(urlFor(database).toString(), { max: 1, onnotice: () => {} });
}

let admin: postgres.Sql<{}>;
let saved: SavedRole[] = [];
const homes: string[] = [];

async function withDb<T>(database: string, body: (db: postgres.Sql<{}>) => Promise<T>): Promise<T> {
  const db = connect(database);
  try {
    return await body(db);
  } finally {
    await db.end({ timeout: 5 });
  }
}

/** Everything a refused run must leave exactly as it was. */
async function fingerprint(database: string): Promise<{ ledger: string[]; relations: string[] }> {
  return withDb(database, async (db) => ({
    ledger: ((await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[]).map((r) => r.name),
    relations: (
      (await db`
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' ORDER BY c.relname`) as unknown as { relname: string }[]
    ).map((r) => r.relname),
  }));
}

async function operator(database: string, rmEnv: string, steps: readonly TerminalStep[]): Promise<TerminalRun> {
  const run = await migrateAtTerminal({ databaseUrl: urlFor(database), readonlyPassword: READONLY_PASSWORD, rmEnv, steps });
  homes.push(run.home);
  return run;
}

const PASSWORD_PROMPT = "rm_owner password (not echoed";
const CONFIRM_PROMPT = "type y to continue";
const typed = (answer: string): TerminalStep[] => [
  { await: PASSWORD_PROMPT, send: OWNER_PASSWORD },
  { await: CONFIRM_PROMPT, send: answer },
];

function journalOf(run: TerminalRun): MigrateJournalFile {
  const names = readdirSync(run.receiptDir).filter((name) => name.startsWith("migrate-journal-"));
  expect(names.length).toBe(1);
  return JSON.parse(readFileSync(join(run.receiptDir, names[0]!), "utf8")) as MigrateJournalFile;
}

/** A refusal, judged the three ways the header names. */
async function expectRefusedAndUnchanged(
  database: string,
  run: TerminalRun,
  before: Awaited<ReturnType<typeof fingerprint>>,
  phase: string,
): Promise<void> {
  expect(run.code).not.toBe(0);
  expect(existsSync(run.receiptPath)).toBe(false);
  const journal = journalOf(run);
  expect({ outcome: journal.outcome, phase: journal.phases.at(-1)?.phase }).toEqual({ outcome: "refused", phase });
  expect(await fingerprint(database)).toEqual(before);
  expect(run.screen).not.toContain(OWNER_PASSWORD);
}

beforeAll(async () => {
  admin = connect("postgres");
  saved = await saveRoles(admin);
  const steps = releaseSteps(release);
  const lastStep = steps.at(-1)!;

  await admin.unsafe(`CREATE DATABASE ${DB.base}`);
  try {
    await withDb(DB.base, (db) => applyAsReleaseRunner(db, steps.slice(0, -1)));
  } finally {
    // v0.5.0's 0053 re-attributed the cluster's roles (NOLOGIN for rm_owner);
    // put them back before anything else in this process can observe them.
    await restoreLogins(admin, saved);
  }
  for (const name of [DB.exact, DB.less, DB.renamed]) {
    await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${DB.base}`);
  }
  await withDb(DB.exact, (db) => applyAsReleaseRunner(db, [lastStep]));
  await withDb(DB.renamed, (db) => applyAsReleaseRunner(db, [{ file: RENAMED, ddl: lastStep.ddl }]));
  await admin.unsafe(`CREATE DATABASE ${DB.more} TEMPLATE ${DB.exact}`);
  await withDb(DB.more, (db) =>
    applyAsReleaseRunner(db, [{ file: FIRST_UNSHIPPED, ddl: readFileSync(join(MIGRATIONS_DIR, FIRST_UNSHIPPED), "utf8") }]),
  );
  await withDb(DB.exact, (db) => revokeLoginDefaults(db, LOGIN));

  // §9.1 step 1, through the provisioning login: rm_owner LOGIN with a password
  // the operator will type. And the rm_readonly line the host's ~/.env holds.
  await admin.unsafe(`ALTER ROLE rm_owner LOGIN PASSWORD '${OWNER_PASSWORD}'`);
  await admin.unsafe(`ALTER ROLE rm_readonly LOGIN PASSWORD '${READONLY_PASSWORD}'`);
}, 180_000);

afterAll(async () => {
  try {
    await restoreRoles(admin, saved);
    for (const name of Object.values(DB)) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
});

describe("the fixtures are the §10 gate's cases", () => {
  test("SUPPORTED_RELEASES is v0.5.0 alone (D55 (8)), and `exact` records exactly its list with no identity table", async () => {
    expect(SUPPORTED_RELEASES.map((r) => r.tag)).toEqual([TAG]);
    const exact = await fingerprint(DB.exact);
    expect(exact.ledger).toEqual([...SUPPORTED_RELEASES[0]!.migrations]);
    expect(exact.relations).not.toContain("deployment_identity");
    expect(exact.relations).not.toContain("schema_manifest");
  });

  test("each variant differs from v0.5.0's list by exactly one file", async () => {
    const list = SUPPORTED_RELEASES[0]!.migrations;
    expect((await fingerprint(DB.less)).ledger).toEqual(list.filter((file) => file !== LAST));
    expect((await fingerprint(DB.more)).ledger).toEqual([...list, FIRST_UNSHIPPED].sort());
    expect((await fingerprint(DB.renamed)).ledger).toEqual([...list.filter((file) => file !== LAST), RENAMED].sort());
  });
});

describe("§10 W2 — First production migrate", () => {
  test("RM_ENV=stage refuses at the gates, before any password is asked for, and changes nothing", async () => {
    const before = await fingerprint(DB.exact);
    const run = await operator(DB.exact, "stage", typed("y"));
    expect(run.screen).toContain("no deployment_identity row");
    expect(run.screen).toContain("needs RM_ENV=prod, and this run is RM_ENV=stage");
    expect(run.screen).not.toContain(PASSWORD_PROMPT);
    await expectRefusedAndUnchanged(DB.exact, run, before, "gates");
  });

  test("a ledger with one file MORE refuses at the gates, naming the extra file, and changes nothing", async () => {
    const before = await fingerprint(DB.more);
    const run = await operator(DB.more, "prod", typed("y"));
    expect(run.screen).toContain(`1 extra (${FIRST_UNSHIPPED})`);
    expect(run.screen).not.toContain(PASSWORD_PROMPT);
    await expectRefusedAndUnchanged(DB.more, run, before, "gates");
  });

  test("a ledger with one file LESS refuses at the gates, naming the missing file, and changes nothing", async () => {
    const before = await fingerprint(DB.less);
    const run = await operator(DB.less, "prod", typed("y"));
    expect(run.screen).toContain(`1 missing (${LAST})`);
    expect(run.screen).not.toContain(PASSWORD_PROMPT);
    await expectRefusedAndUnchanged(DB.less, run, before, "gates");
  });

  test("a ledger with one file RENAMED refuses at the gates, naming both names, and changes nothing", async () => {
    const before = await fingerprint(DB.renamed);
    const run = await operator(DB.renamed, "prod", typed("y"));
    expect(run.screen).toContain(`1 missing (${LAST})`);
    expect(run.screen).toContain(`1 extra (${RENAMED})`);
    await expectRefusedAndUnchanged(DB.renamed, run, before, "gates");
  });

  test("a missing owner password refuses and changes nothing", async () => {
    const before = await fingerprint(DB.exact);
    const run = await operator(DB.exact, "prod", [{ await: PASSWORD_PROMPT, send: "" }]);
    expect(run.screen).toContain("no rm_owner password entered");
    expect(run.screen).not.toContain(CONFIRM_PROMPT);
    await expectRefusedAndUnchanged(DB.exact, run, before, "owner");
  });

  for (const answer of ["n", "yes", "Y", ""]) {
    test(`the answer ${JSON.stringify(answer)} — anything but y — refuses and changes nothing`, async () => {
      const before = await fingerprint(DB.exact);
      const run = await operator(DB.exact, "prod", typed(answer));
      // The question named what the y would have confirmed.
      expect(run.screen).toContain("FIRST PRODUCTION MIGRATE");
      expect(run.screen).toContain(`equals ${TAG}'s ${RELEASE_FILES.length} files`);
      expect(run.screen).toContain("an explicit y is required");
      await expectRefusedAndUnchanged(DB.exact, run, before, "confirm");
    });
  }

  test("red control: the run itself, reached around the command with no typed y, refuses on a qualifying database", async () => {
    // `runMigrate` is exported; a caller that skipped `migrateCommand`'s prompt
    // and `y` would otherwise get the exception from the gates alone.
    const before = await fingerprint(DB.exact);
    const owner = postgres(urlFor(DB.exact, { name: "rm_owner", password: OWNER_PASSWORD }).toString(), {
      max: 1,
      onnotice: () => {},
    });
    try {
      await expect(
        withTargetLock(urlFor(DB.exact).toString(), (lock) =>
          runMigrate(owner, { caller: "operator", env: "prod", connection: "remote", nonInteractive: false, lock }),
        ),
      ).rejects.toThrow("no operator confirmed it");
    } finally {
      await owner.end({ timeout: 5 });
    }
    expect(await fingerprint(DB.exact)).toEqual(before);
  });

  test("no row, v0.5.0's exact ledger, RM_ENV=prod, a typed rm_owner and y: migrates once and receipts the pre-identity state", async () => {
    const run = await operator(DB.exact, "prod", typed("y"));
    expect({ code: run.code, tail: run.code === 0 ? "" : run.screen.slice(-3000) }).toEqual({ code: 0, tail: "" });
    expect(run.screen).not.toContain(OWNER_PASSWORD);

    const receipt = JSON.parse(readFileSync(run.receiptPath, "utf8")) as {
      applied: string[];
      baselined: boolean;
      preIdentity: { identity: string; release: string; ledger: string[] } | null;
      manifest: { filenames: string[] };
    };
    // §9.1: "no identity row existed, the supported release the ledger
    // matched, and that ledger's filename list".
    expect(receipt.preIdentity).toEqual({ identity: "no table", release: TAG, ledger: RELEASE_FILES });
    expect(receipt.applied).toEqual(HEAD_FILES.filter((file) => !RELEASE_FILES.includes(file)));
    expect(receipt.baselined).toBe(true);
    expect(receipt.manifest.filenames).toEqual(HEAD_FILES);
    expect(journalOf(run).outcome).toBe("succeeded");

    const after = await fingerprint(DB.exact);
    expect(after.ledger).toEqual(HEAD_FILES);
    // 0063 created the table; step 4 of §9.1 — writing `production` — is the
    // operator's next command, not this one's.
    await withDb(DB.exact, async (db) => {
      expect((await db`SELECT kind FROM deployment_identity`).length).toBe(0);
    });
  }, 180_000);

  test("a second run with no row still refuses: its ledger no longer equals v0.5.0's", async () => {
    const before = await fingerprint(DB.exact);
    const run = await operator(DB.exact, "prod", typed("y"));
    expect(run.screen).toContain("no deployment_identity row");
    expect(run.screen).toContain("matches none");
    expect(run.screen).not.toContain(PASSWORD_PROMPT);
    await expectRefusedAndUnchanged(DB.exact, run, before, "gates");
  });
});
