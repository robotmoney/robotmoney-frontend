// Unit specification for scripts/lib/smoke-env-policy.ts — the `RM_ENV` policy
// value (§4.1), the full policy × identity matrix (§4.3), and the
// `--allow-insecure` refusal (§4.4) of docs/technical/smoke-production-spec.md,
// and how a `--local` data path reaches the matrix (§3, §5).
//
// TDD RED PHASE (issue #1026, W1 step 2). Every function under test currently
// throws `NOT IMPLEMENTED`, so every test here fails today BY DESIGN. Each one
// is written as the requirement it pins, against the behaviour the module must
// have once W1.1 lands — never against the stub.
//
// WHY THE MATRIX IS TESTED ROW BY ROW. §4.3 is thirteen rows and the dangerous
// ones are the refusals. A matrix implemented as "allow the good cases, fall
// through otherwise" passes a spot check and fails the one row nobody wrote. So
// every cell of (prod | stage | unset | other) × (remote | local-blank |
// local-dump | local-volume) × (production | rehearsal | absent | unreadable)
// that the spec names is asserted here, including the two rows whose reasoning
// the spec states in prose and which therefore must survive into the refusal
// text an operator reads.
//
// Acceptance gates served (spec §10, W1):
//   - "Unset `RM_ENV` against a remote target refuses."
//   - "Overlay-free stage boots with the real scheduler" (the §4.4 half: the
//     weakening flags exist and are refused under `prod`).
import { describe, expect, test } from "bun:test";
import {
  describePolicyVerdict,
  refuseWeakeningFlagsOnProd,
  resolveDeploymentPolicy,
  resolveRmEnv,
  type PolicyInput,
  type PolicyVerdict,
  type TargetConnection,
} from "../../lib/smoke-env-policy.ts";
import type { DeploymentIdentityKind } from "../../lib/smoke-identity.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDataPath, targetConnection } from "../../smoke.ts";
import { dropShellMigrationCredential, smokePassthroughEnv } from "../../lib/smoke-compose-env.ts";
import { buildSpawnEnv, DEFAULT_STACK_DATABASE, type StackConfig } from "../../stack/index.ts";

/** Every identity value the matrix distinguishes, including the two non-kinds. */
type Identity = DeploymentIdentityKind | null | "unreadable";

const LOCAL_MODES: readonly TargetConnection[] = ["local-blank", "local-dump", "local-volume"];
const ALL_IDENTITIES: readonly Identity[] = ["production", "rehearsal", null, "unreadable"];

function input(rmEnv: string | undefined, connection: TargetConnection, identity: Identity): PolicyInput {
  return { rmEnv, connection, identity };
}

/** Narrow to the refuse arm, failing the test with the allow arm's contents if it is not one. */
function refusal(verdict: PolicyVerdict): string {
  expect(verdict.allow).toBe(false);
  if (verdict.allow) throw new Error("expected a refusal");
  return verdict.reason;
}

describe("resolveRmEnv — §4.1, RM_ENV is policy only and has exactly two spellings", () => {
  test("`prod` resolves to the prod policy and reports that it was set explicitly", () => {
    expect(resolveRmEnv({ RM_ENV: "prod" })).toEqual({ ok: true, env: "prod", source: "explicit" });
  });

  test("`stage` resolves to the stage policy and reports that it was set explicitly", () => {
    expect(resolveRmEnv({ RM_ENV: "stage" })).toEqual({ ok: true, env: "stage", source: "explicit" });
  });

  test("an absent RM_ENV resolves to stage but reports source `unset`, because §4.3 treats the two differently", () => {
    expect(resolveRmEnv({})).toEqual({ ok: true, env: "stage", source: "unset" });
  });

  test("an empty RM_ENV is an absence, not an unknown value — `RM_ENV=` in a profile must not send the operator hunting a typo", () => {
    expect(resolveRmEnv({ RM_ENV: "" })).toEqual({ ok: true, env: "stage", source: "unset" });
  });

  test("a whitespace-only RM_ENV is an absence for the same reason", () => {
    expect(resolveRmEnv({ RM_ENV: "   " })).toEqual({ ok: true, env: "stage", source: "unset" });
  });

  test("the retired `smoke` value refuses and names both legal values, rather than downgrading to stage", () => {
    const result = resolveRmEnv({ RM_ENV: "smoke" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toContain("smoke");
    expect(result.reason).toContain("prod");
    expect(result.reason).toContain("stage");
  });

  test("the retired `ephemeral` value refuses — config.ts's VALID_ENVS still accepts it and this module must not", () => {
    const result = resolveRmEnv({ RM_ENV: "ephemeral" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toContain("ephemeral");
  });

  test("the comparison is case-sensitive: `PROD` is an unknown value, never the prod policy", () => {
    const result = resolveRmEnv({ RM_ENV: "PROD" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toContain("PROD");
  });

  test("a value with surrounding whitespace is not silently trimmed into a legal value", () => {
    expect(resolveRmEnv({ RM_ENV: " prod " }).ok).toBe(false);
  });
});

describe("resolveDeploymentPolicy — §4.3 row: prod × remote × production", () => {
  test("arms the production guards and emits no warning", () => {
    const verdict = resolveDeploymentPolicy(input("prod", "remote", "production"));
    expect(verdict).toEqual({ allow: true, env: "prod", posture: "production", warnings: [] });
  });
});

describe("resolveDeploymentPolicy — §4.3 row: prod × remote × anything else refuses", () => {
  for (const identity of ["rehearsal", null, "unreadable"] as const) {
    test(`refuses against identity ${String(identity)}, naming the policy, the connection and what the target says`, () => {
      const reason = refusal(resolveDeploymentPolicy(input("prod", "remote", identity)));
      expect(reason).toContain("prod");
      expect(reason).toContain("remote");
      expect(reason.toLowerCase()).toContain(identity === null ? "no identity" : String(identity));
    });
  }

  test("an unreadable identity table is not evidence of production — absence of evidence is never evidence", () => {
    const reason = refusal(resolveDeploymentPolicy(input("prod", "remote", "unreadable")));
    expect(reason.toLowerCase()).toContain("unreadable");
  });
});

describe("resolveDeploymentPolicy — §4.3 row: prod × --local × any refuses", () => {
  for (const connection of LOCAL_MODES) {
    for (const identity of ALL_IDENTITIES) {
      test(`${connection} with identity ${String(identity)} refuses: production never runs on a database smoke owns`, () => {
        const reason = refusal(resolveDeploymentPolicy(input("prod", connection, identity)));
        expect(reason).toContain("prod");
        expect(reason).toContain(connection);
      });
    }
  }
});

describe("resolveDeploymentPolicy — §4.3 row: stage × remote × rehearsal", () => {
  test("allows with the stage posture and no warning", () => {
    const verdict = resolveDeploymentPolicy(input("stage", "remote", "rehearsal"));
    expect(verdict).toEqual({ allow: true, env: "stage", posture: "stage", warnings: [] });
  });
});

describe("resolveDeploymentPolicy — §4.3 row: stage × remote × anything else refuses", () => {
  for (const identity of ["production", null, "unreadable"] as const) {
    test(`refuses against identity ${String(identity)}`, () => {
      const reason = refusal(resolveDeploymentPolicy(input("stage", "remote", identity)));
      expect(reason).toContain("stage");
      expect(reason).toContain("remote");
    });
  }

  test("the refusal carries the spec's own reasoning: stage policy never touches production data", () => {
    const reason = refusal(resolveDeploymentPolicy(input("stage", "remote", "production")));
    expect(reason.toLowerCase()).toContain("never touches production data");
  });

  test("no flag relaxes this row — `--allow-insecure` is named in the spec sentence and cannot be an escape", () => {
    const reason = refusal(resolveDeploymentPolicy(input("stage", "remote", "production")));
    expect(reason).toContain("--allow-insecure");
  });
});

describe("resolveDeploymentPolicy — §4.3 row: stage × --local blank/dump", () => {
  for (const connection of ["local-blank", "local-dump"] as const) {
    test(`${connection} allows as stage: the identity row is the one smoke is about to write as rehearsal`, () => {
      const verdict = resolveDeploymentPolicy(input("stage", connection, "rehearsal"));
      expect(verdict).toEqual({ allow: true, env: "stage", posture: "stage", warnings: [] });
    });
  }
});

describe("resolveDeploymentPolicy — §4.3 row: stage × --local volume", () => {
  test("a volume whose identity row says rehearsal allows as stage", () => {
    const verdict = resolveDeploymentPolicy(input("stage", "local-volume", "rehearsal"));
    expect(verdict).toEqual({ allow: true, env: "stage", posture: "stage", warnings: [] });
  });

  for (const identity of ["production", null, "unreadable"] as const) {
    test(`a volume whose identity is ${String(identity)} refuses`, () => {
      const reason = refusal(resolveDeploymentPolicy(input("stage", "local-volume", identity)));
      expect(reason).toContain("local-volume");
    });
  }

  test("the refusal carries the spec's reasoning: a reattached volume gets no weaker policy than a remote", () => {
    const reason = refusal(resolveDeploymentPolicy(input("stage", "local-volume", "production")));
    expect(reason.toLowerCase()).toContain("no weaker policy than a remote");
  });
});

describe("resolveDeploymentPolicy — §4.3 row: unset × remote refuses (the §10 W1 gate)", () => {
  for (const identity of ALL_IDENTITIES) {
    test(`an unset RM_ENV against a remote target refuses even when the identity says ${String(identity)}`, () => {
      const reason = refusal(resolveDeploymentPolicy(input(undefined, "remote", identity)));
      expect(reason).toContain("RM_ENV");
      expect(reason).toContain("remote");
    });
  }

  test("an empty RM_ENV against a remote target refuses the same way an absent one does", () => {
    expect(resolveDeploymentPolicy(input("", "remote", "rehearsal")).allow).toBe(false);
  });

  test("the unset-remote refusal is NOT the unknown-value refusal — it must not claim RM_ENV held a bad value", () => {
    const reason = refusal(resolveDeploymentPolicy(input(undefined, "remote", "rehearsal")));
    expect(reason.toLowerCase()).toContain("not set");
  });
});

describe("resolveDeploymentPolicy — §4.3 row: unset × --local warns and proceeds as stage", () => {
  for (const connection of LOCAL_MODES) {
    test(`${connection} allows as stage with the spec's verbatim warning`, () => {
      const verdict = resolveDeploymentPolicy(input(undefined, connection, "rehearsal"));
      expect(verdict).toEqual({
        allow: true,
        env: "stage",
        posture: "stage",
        warnings: ["RM_ENV not set, running as stage"],
      });
    });
  }

  test("unset × --local volume still requires the rehearsal row — the warning does not relax the volume row", () => {
    expect(resolveDeploymentPolicy(input(undefined, "local-volume", "production")).allow).toBe(false);
  });
});

describe("resolveDeploymentPolicy — §4.3 row: other × any × any refuses", () => {
  for (const connection of ["remote", ...LOCAL_MODES] as const) {
    test(`an unknown RM_ENV refuses on ${connection}, and is not downgraded to stage`, () => {
      const reason = refusal(resolveDeploymentPolicy(input("smoke", connection, "rehearsal")));
      expect(reason).toContain("smoke");
      expect(reason).toContain("prod");
      expect(reason).toContain("stage");
    });
  }
});

describe("refuseWeakeningFlagsOnProd — §4.4, the one surviving overlay knob is a refusal under prod", () => {
  test("`--allow-insecure` under prod refuses, naming the flag", () => {
    const result = refuseWeakeningFlagsOnProd("prod", { allowInsecure: true });
    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("expected a refusal");
    expect(result.reason).toContain("--allow-insecure");
  });

  test("the refusal states that parity with production is a tested property, not an overlay", () => {
    const result = refuseWeakeningFlagsOnProd("prod", { allowInsecure: true });
    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("expected a refusal");
    expect(result.reason.toLowerCase()).toContain("parity");
  });

  test("no flag under prod allows — a production boot is not weakened by default", () => {
    expect(refuseWeakeningFlagsOnProd("prod", { allowInsecure: false })).toEqual({ allow: true });
  });

  test("`--allow-insecure` under stage allows: stage is where the weakening is legitimate", () => {
    expect(refuseWeakeningFlagsOnProd("stage", { allowInsecure: true })).toEqual({ allow: true });
  });

  test("the check does not consult the target: the flag is refused on prod whatever the database says", () => {
    expect(refuseWeakeningFlagsOnProd("prod", { allowInsecure: true }).allow).toBe(false);
    expect(refuseWeakeningFlagsOnProd("stage", { allowInsecure: true }).allow).toBe(true);
  });

  test("there is no `--schedules-off` to guard: §4.4 says scheduling has no off state", () => {
    // The guard used to take a `schedulesOff` flag and name it in the refusal,
    // which read as evidence the flag exists. Its input type no longer has one.
    const flags: Parameters<typeof refuseWeakeningFlagsOnProd>[1] = { allowInsecure: true };
    expect(Object.keys(flags)).toEqual(["allowInsecure"]);
    const result = refuseWeakeningFlagsOnProd("prod", flags);
    if (result.allow) throw new Error("expected a refusal");
    expect(result.reason).not.toContain("schedules");
  });
});

// §3: "Args override env: any `--local` mode makes smoke ignore every remote
// connection value." Proven against the real parser, with a `$HOME/.env` that
// names a remote production-shaped host. A local mode must resolve to the local
// container, reach the matrix as a local connection, and carry no remote
// address anywhere a later step could dial.
describe("a --local mode ignores a remote host in ~/.env (criterion 32)", () => {
  const REMOTE_HOST = "db-rm-app-x.do-user-12345-0.b.db.ondigitalocean.com";
  const homeEnv = join(mkdtempSync(join(tmpdir(), "rm-policy-home-")), ".env");
  writeFileSync(homeEnv, `host = ${REMOTE_HOST}\nport = 25060\ndatabase = defaultdb\nsslmode = require\nrm_app = s3cret-remote\n`);
  const argv = (...flags: string[]) => ["bun", "scripts/smoke.ts", ...flags];

  test("red control: with no --local flag the same file DOES resolve to the remote host", () => {
    const { dataPath } = parseDataPath(argv(), { envFilePath: homeEnv });
    expect(dataPath.kind).toBe("external");
    expect(targetConnection(dataPath)).toBe("remote");
    expect(JSON.stringify(dataPath)).toContain(REMOTE_HOST);
  });

  test.each([
    [["--local", "blank"], "local-blank"],
    [["--local", "dump"], "local-dump"],
    [["--local", "volume=rm_smoke_stack_prev_pgdata"], "local-volume"],
    [["--local=volume"], "local-volume"],
  ] as const)("%j resolves to the local container as %s, with no remote address", (flags, connection) => {
    const { dataPath } = parseDataPath(argv(...flags), { envFilePath: homeEnv });
    expect(dataPath.kind).not.toBe("external");
    expect(targetConnection(dataPath)).toBe(connection);
    const serialized = JSON.stringify(dataPath);
    expect(serialized).not.toContain(REMOTE_HOST);
    expect(serialized).not.toContain("s3cret-remote");
    expect(serialized).not.toContain("25060");
  });

  test("a local mode never even reads the file: an unreadable ~/.env cannot fail it", () => {
    const missing = join(tmpdir(), "rm-policy-absent", ".env");
    expect(() => parseDataPath(argv(), { envFilePath: missing })).toThrow();
    for (const mode of ["blank", "dump", "volume"]) {
      expect(parseDataPath(argv("--local", mode), { envFilePath: missing }).dataPath.kind).not.toBe("external");
    }
  });

  test("the matrix then treats it as local: unset RM_ENV warns and proceeds as stage (§4.3 row 10)", () => {
    const { dataPath } = parseDataPath(argv("--local", "blank"), { envFilePath: homeEnv });
    const verdict = resolveDeploymentPolicy({ rmEnv: undefined, connection: targetConnection(dataPath), identity: "rehearsal" });
    expect(verdict).toEqual({ allow: true, env: "stage", posture: "stage", warnings: ["RM_ENV not set, running as stage"] });
  });
});

describe("describePolicyVerdict — §1.2, the same four facts in the plan and in the refusal", () => {
  const allowed = input("prod", "remote", "production");

  test("an allow renders the declared policy, the connection, the target's own answer and the resulting posture", () => {
    const verdict = resolveDeploymentPolicy(allowed);
    const text = describePolicyVerdict(allowed, verdict);
    expect(text).toContain("prod");
    expect(text).toContain("remote");
    expect(text).toContain("production");
  });

  test("a refusal renders the same four facts, so an operator can diff it against yesterday's plan", () => {
    const refused = input("stage", "remote", "production");
    const text = describePolicyVerdict(refused, resolveDeploymentPolicy(refused));
    expect(text).toContain("stage");
    expect(text).toContain("remote");
    expect(text).toContain("production");
  });

  test("the rendering is deterministic — the plan's line and the refusal's line are comparable only if it is", () => {
    const verdict = resolveDeploymentPolicy(allowed);
    expect(describePolicyVerdict(allowed, verdict)).toBe(describePolicyVerdict(allowed, verdict));
  });

  test("one fact per line, so a single changed fact is a single changed line", () => {
    const verdict = resolveDeploymentPolicy(allowed);
    const lines = describePolicyVerdict(allowed, verdict).split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  test("the plan is redacted: no connection string ever reaches this line", () => {
    const verdict = resolveDeploymentPolicy(allowed);
    expect(describePolicyVerdict(allowed, verdict)).not.toContain("postgres://");
  });
});

// The same claim one layer further out: what the `docker compose` child that
// runs the stack (and its one-shot migrate run, which reads MIGRATE_DATABASE_URL
// from that child's environment — scripts/stack/config.ts migrateArgs) is
// actually handed. The operator's shell names the remote database three ways;
// none of them may reach a local boot. The rendered-compose half of this proof
// is scripts/tests/integration/smoke-local-mode-no-remote.test.ts.
describe("a --local boot hands compose no remote connection (criterion 32, spawn env)", () => {
  const REMOTE_HOST = "db-rm-app-x.do-user-12345-0.b.db.ondigitalocean.com";
  const shell = (): Record<string, string | undefined> => ({
    PATH: "/usr/bin",
    HOME: "/home/op",
    DATABASE_URL: `postgres://rm_app:s3cret@${REMOTE_HOST}:25060/defaultdb`,
    WORKER_DATABASE_URL: `postgres://rm_worker:s3cret@${REMOTE_HOST}:25060/defaultdb`,
    MIGRATE_DATABASE_URL: `postgres://rm_owner:s3cret@${REMOTE_HOST}:25060/defaultdb`,
  });
  // smoke-main.ts's own shape for a blank local mode: the runtime roles'
  // URLs on the compose `postgres` service, with the instance's generated
  // passwords (StackDatabase.roleUrls).
  const LOCAL_ROLES = {
    app: "postgres://rm_app:generated-app@postgres:5432/robotmoney?sslmode=disable",
    worker: "postgres://rm_worker:generated-worker@postgres:5432/robotmoney?sslmode=disable",
  };
  const cfg = (env: Record<string, string | undefined>): StackConfig => ({
    repoRoot: "/repo",
    project: "rm_smoke_stack_c32",
    profile: "full",
    composeFiles: ["docker-compose.yml", "docker-compose.smoke.yml"],
    database: { ...DEFAULT_STACK_DATABASE, roleUrls: LOCAL_ROLES },
    credentials: { adminToken: "a", automationToken: "b", analyticsToken: "c", analyticsTokenFile: "/tmp/tok" },
    environment: { class: "local", hash: "c32c32c32c" },
    rmEnv: "stage",
    extraComposeEnv: { ...smokePassthroughEnv(env) },
  });

  test("after the boot's first step, no value in the compose env names the remote host", () => {
    const env = shell();
    const warning = dropShellMigrationCredential(env);
    expect(warning).toContain("MIGRATE_DATABASE_URL");
    const spawn = buildSpawnEnv(cfg(env), env);
    expect(spawn.DATABASE_URL).toBe(LOCAL_ROLES.app);
    expect(spawn.WORKER_DATABASE_URL).toBe(LOCAL_ROLES.worker);
    expect(spawn).not.toHaveProperty("MIGRATE_DATABASE_URL");
    expect(Object.entries(spawn).filter(([, v]) => v.includes(REMOTE_HOST))).toEqual([]);
  });

  test("even WITHOUT the drop, no shell database URL reaches compose: none is on the allowlist any more", () => {
    // Red control for the test above in its new shape: the drop is kept (so a
    // shell value cannot reach anything the boot might read), but the stack no
    // longer forwards a migration credential or a worker URL from the shell at
    // all — the migrate run is the host's, and the worker's URL the stack's.
    const env = shell();
    const spawn = buildSpawnEnv(cfg(env), env);
    expect(spawn).not.toHaveProperty("MIGRATE_DATABASE_URL");
    expect(Object.entries(spawn).filter(([, v]) => v.includes(REMOTE_HOST))).toEqual([]);
  });

  test("smoke-main.ts drops the shell's migration credential before anything reads the environment for compose", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "lib", "smoke-main.ts"), "utf8");
    const drop = src.indexOf("dropShellMigrationCredential(process.env)");
    expect(drop).toBeGreaterThan(0);
    for (const later of ["smokePassthroughEnv(process.env)", "runPrepareStep("]) {
      expect({ later, after: src.indexOf(later) > drop }).toEqual({ later, after: true });
    }
    // The retired hand-offs are gone, not merely reordered.
    for (const retired of ["twinMigrationCredential(", "resolveExternalMigrationOptIn(", "process.env.MIGRATE_DATABASE_URL ="]) {
      expect({ retired, present: src.includes(retired) }).toEqual({ retired, present: false });
    }
  });
});
