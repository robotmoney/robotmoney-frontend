// D55 (10), issue #1086 (proofs weaker than their criterion): every stage tool
// that reads a remote target with no `deployment_identity` table refuses and
// names the pre-identity twin runbook, and a stage tool added without going
// through the policy is caught.
//
//   1. BEHAVIOUR. Each stage tool whose gate is an exported function (preflight
//      check 5, the migrate gates, `--seed`) is run over a stub database that has
//      no `deployment_identity` table, reached as a remote target under
//      RM_ENV=stage, and must refuse naming PRE_IDENTITY_TWIN_RUNBOOK.
//   2. SOURCE. `bun run prune` and `bun smoke` run their gate inside a script
//      that needs a lock and a server, so their source must route the remote
//      identity through the policy function and pass `null` for a missing row.
//   3. COVERAGE. Every non-test source file that touches `deployment_identity`
//      is either a registered stage tool or on a named exemption list. A new file
//      that reads the table and is on neither list fails here by name.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PRE_IDENTITY_TWIN_RUNBOOK } from "../../../backend/src/deploy-policy.ts";
import type { PreflightContext, PreflightDb } from "../../../backend/src/db/preflight.ts";

// The stage tools load backend config, which insists on a DATABASE_URL. The
// stub database below is the only one ever used: nothing connects to this URL.
process.env.DATABASE_URL ??= "postgres://stub:stub@127.0.0.1:1/stub";
const { checkEnvIdentity } = await import("../../../backend/src/db/preflight.ts");
const { assertSeedable } = await import("../../../backend/src/db/seed.ts");
const { checkMigrateGates } = await import("../../../backend/scripts/migrate-run.ts");

const REPO = join(import.meta.dir, "..", "..", "..");

/** A stub Postgres client over a database with no `deployment_identity` table. */
function dbWithoutIdentityTable(): unknown {
  const answer = (text: string): unknown[] => (text.includes("to_regclass") ? [{ present: false }] : []);
  const tag = (strings: TemplateStringsArray): Promise<unknown[]> => Promise.resolve(answer(strings.join("?")));
  return Object.assign(tag, { unsafe: (text: string) => Promise.resolve(answer(text)) });
}

describe("each stage tool refuses a remote target with no identity table, naming the runbook", () => {
  test("preflight check 5 (env_identity)", async () => {
    const context = { env: "stage", connection: "remote" } as unknown as PreflightContext;
    const result = await checkEnvIdentity(dbWithoutIdentityTable() as PreflightDb, context);
    const refusals = result.findings.filter((f) => f.severity === "refuse");
    expect(refusals.length).toBe(1);
    expect(refusals[0]?.message).toContain(PRE_IDENTITY_TWIN_RUNBOOK);
  });

  test("migrate-run gates, for the operator and for `--migrate`", async () => {
    for (const caller of ["operator", "smoke_flag"] as const) {
      const options = { caller, env: "stage", connection: "remote" } as unknown as Parameters<typeof checkMigrateGates>[1];
      const refusals = await checkMigrateGates(dbWithoutIdentityTable() as Parameters<typeof checkMigrateGates>[0], options);
      expect(refusals.length).toBeGreaterThan(0);
      expect(refusals.map((r) => r.message).join(" ")).toContain(PRE_IDENTITY_TWIN_RUNBOOK);
    }
  });

  test("`--seed` (assertSeedable), reached as a remote target", async () => {
    const request = { rmEnv: "stage", explicitlyRequested: true, connection: "remote" } as Parameters<typeof assertSeedable>[1];
    const error = await assertSeedable(dbWithoutIdentityTable() as Parameters<typeof assertSeedable>[0], request).then(
      () => null,
      (e: Error) => e,
    );
    expect(error).not.toBeNull();
    expect(error?.message).toContain(PRE_IDENTITY_TWIN_RUNBOOK);
  });
});

/** The source of a stage tool whose gate runs behind a lock or a server. */
const read = (file: string): string => readFileSync(join(REPO, file), "utf8");

describe("the stage tools whose gate needs a lock route a remote target through the policy", () => {
  test("`bun run prune` asks resolveDeploymentPolicy as a remote, with a missing row as null", () => {
    const source = read("backend/scripts/prune.ts");
    const call = source.match(/resolveDeploymentPolicy\(\{[^}]*\}\)/)?.[0] ?? "";
    expect(call).toContain('connection: "remote"');
    expect(call).toMatch(/identity:\s*expected\.identity === "missing" \? null/);
    expect(source).toMatch(/if \(!verdict\.allow\) throw new PruneRefused\(`Refusing: \$\{verdict\.reason\}`\)/);
  });

  test("`bun smoke` asks resolveDeploymentPolicy once the target lock is held, with a missing row as null", () => {
    const source = read("scripts/lib/smoke-main.ts");
    expect(source).toMatch(/resolveDeploymentPolicy\(\{ rmEnv: declaredRmEnv, connection, identity: locked\.identity === "missing" \? null : locked\.identity \}\)/);
  });
});

/** Files that name `deployment_identity` in code, found by reading the tree. */
function filesNamingTheIdentityTable(roots: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "tests" || name === "migrations") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && readFileSync(path, "utf8").includes("deployment_identity")) found.push(relative(REPO, path));
    }
  };
  for (const root of roots) walk(join(REPO, root));
  return found.sort();
}

/** Stage tools: each reads a target's identity and judges it through the one policy. */
const STAGE_TOOLS = [
  "backend/scripts/migrate-run.ts",
  "backend/scripts/prune.ts",
  "backend/src/db/preflight.ts",
  "scripts/lib/smoke-main.ts",
] as const;

/** Files that name the table and are not a remote stage tool, each with the reason. */
const NOT_A_REMOTE_STAGE_TOOL: Readonly<Record<string, string>> = {
  "backend/scripts/migrate.ts": "the migrate worker; the gate is migrate-run.ts, which every entry calls first",
  "backend/scripts/set-identity.ts": "the operator's enrolment writer; it is the hand step, not a reader of a stage target",
  "backend/scripts/smoke-prepare.ts": "runs behind smoke-main's policy call and the migrate and seed gates above",
  "backend/scripts/spoof-rebind.ts": "rehearsal-only, local container",
  "backend/src/db/automation-tokens.ts": "token minting names the table in a comment or a rehearsal guard, not a target read",
  "backend/src/db/schema-snapshot.ts": "reads the row for the seed gate and the snapshot bootstrap",
  "backend/src/db/seed.ts": "the --seed gate (requireRehearsalTarget), covered by behaviour above",
  "backend/src/db/target-lock.ts": "the lock's own state read, not a policy decision",
  "backend/src/deploy-policy.ts": "the policy",
  "scripts/lib/restore-container.ts": "restores into a local container only",
  "scripts/lib/smoke-database.ts": "local container provisioning",
  "scripts/lib/smoke-env-policy.ts": "re-exports the policy",
  "scripts/lib/smoke-identity.ts": "enrolment store for the local rehearsal",
  "scripts/lib/smoke-journal.ts": "names the table in a journal record",
  "scripts/lib/swarm/spoof-keys.ts": "rehearsal-only, requireRehearsalTarget",
  "scripts/prod-init.ts": "production initialisation; refuses a non-production target by its own rule",
};

describe("a stage tool added without going through the policy is caught", () => {
  test("every registered stage tool references the policy function", () => {
    for (const file of STAGE_TOOLS) {
      expect({ file, usesPolicy: /resolveDeploymentPolicy\(/.test(read(file)) }).toEqual({ file, usesPolicy: true });
    }
  });

  test("every source file naming deployment_identity is a stage tool or has a named exemption", () => {
    const known = new Set<string>([...STAGE_TOOLS, ...Object.keys(NOT_A_REMOTE_STAGE_TOOL)]);
    const unclassified = filesNamingTheIdentityTable(["backend/scripts", "backend/src", "scripts"]).filter((f) => !known.has(f));
    expect(unclassified).toEqual([]);
  });

  test("the exemption list holds no file that is gone", () => {
    for (const file of Object.keys(NOT_A_REMOTE_STAGE_TOOL)) expect(() => read(file)).not.toThrow();
  });

  test("the detector sees a planted file", () => {
    const planted = join(REPO, "scripts", "zz-planted-stage-tool.ts");
    writeFileSync(planted, "export const q = 'SELECT kind FROM deployment_identity';\n");
    try {
      expect(filesNamingTheIdentityTable(["scripts"])).toContain("scripts/zz-planted-stage-tool.ts");
    } finally {
      rmSync(planted);
    }
  });
});
