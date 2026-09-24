// Unit specification for scripts/lib/smoke-journal.ts — the redacted plan and
// its content-hash id (§1.2, as amended by D52), the phase journal and its
// three resume rules (§1.3), phase-boundary interruption, and the readiness
// receipt (§1.4) of docs/technical/smoke-production-spec.md.
//
// THE ONE TEST THAT MATTERS MOST is "a journal's own committed migration does
// not invalidate its resume". A naive expectation check compares the world
// against what it looked like when the run started, sees the migration the run
// ITSELF applied, and refuses — turning every interrupted run into an
// unresumable one, which is the exact situation the journal exists for. It is
// pinned here alongside its mirror image: the same schema move, unaccounted for
// by any recorded outcome, must refuse.
//
// THE PLAN ID HASHES SOURCES, NOT DIGESTS (D52). Two cases below run real `git`
// against a throwaway repository, because "a changed build-context tree
// changes the id" is a claim about what Git answers for a working tree, and a
// literal tree id in a fixture would only restate the assumption.
//
// Acceptance gates served (spec §10, W1):
//   - "Ctrl-C before replace: services not replaced, committed preparation
//      journaled not undone. Ctrl-C after: journal reported, rerun resumes."
//   - "Resume after committed preparation under the same plan id succeeds;
//      changed roster/image/target does not reuse completed phases."
//   - "Receipt read by `smoke:status`."
import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPlanRedacted,
  closeOpenJournal,
  computePlanId,
  credentialShape,
  decideResume,
  expectationMismatch,
  JOURNAL_FORMAT_VERSION,
  DEPLOYMENT_PHASES,
  openJournal,
  planHashMaterial,
  projectExpectations,
  publicKeyFingerprint,
  readArchivedJournals,
  readJournal,
  readReceipt,
  RECEIPT_FORMAT_VERSION,
  renderPlan,
  summarizeProgress,
  watchForInterrupt,
  writeReceipt,
  type DeploymentPlan,
  type Journal,
  type PhaseOutcome,
  type PlanId,
  type Receipt,
  type StateExpectations,
} from "../../lib/smoke-journal.ts";
import { generateRolePasswords, instancePaths, type InstancePaths } from "../../lib/smoke-state.ts";
import { gitRunner, resolveSourceIdentities } from "../../stack/source-identity.ts";
import { readFileSync } from "node:fs";

const DIGEST_A = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_B = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const SOURCE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FP_ATHENA = publicKeyFingerprint("athena-public-key-b64");
const FP_ROBOT = publicKeyFingerprint("robot-money-public-key-b64");
const FP_THEMIS = publicKeyFingerprint("themis-public-key-b64");

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function freshPaths(instance = "alpha"): InstancePaths {
  const root = mkdtempSync(join(tmpdir(), "rm-smoke-journal-"));
  cleanup.push(root);
  return instancePaths(root, instance, { create: true });
}

function plan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    instance: "alpha",
    target: {
      kind: "remote",
      rmEnv: "stage",
      identity: "rehearsal",
      host: "db.example.invalid",
      port: 25060,
      dbname: "robotmoney",
    },
    images: { api: { source: SOURCE_A, digest: DIGEST_A }, worker: { source: SOURCE_A, digest: DIGEST_A } },
    roster: {
      agents: [
        { name: "athena", role: "member", keyFingerprint: FP_ATHENA },
        { name: "robot-money", role: "member", keyFingerprint: FP_ROBOT },
      ],
      judges: [{ name: "themis", role: "judge", keyFingerprint: FP_THEMIS }],
    },
    // Arbitrary non-secret configuration — the journal records whatever the
    // plan carries and cares only that the value round-trips.
    configuration: { SWARM_EPOCH_MINUTES: "15", JUDGE_MODEL: "Qwen2.5-Coder-32B-Instruct" },
    mutations: ["migrate"],
    ...overrides,
  };
}

function expectations(overrides: Partial<StateExpectations> = {}): StateExpectations {
  return {
    ledger: ["0053_database_role_taxonomy.sql", "0054_rm_worker_allowlist.sql"],
    manifestHash: "manifest-aaa",
    identity: "rehearsal",
    participants: ["athena"],
    services: { api: DIGEST_A, worker: DIGEST_A },
    spoofGeneration: null,
    ...overrides,
  };
}

function outcome(overrides: Partial<PhaseOutcome> = {}): PhaseOutcome {
  return {
    migrationsApplied: [],
    manifestPublished: null,
    participantsStarted: [],
    participantsStopped: [],
    servicesReplaced: {},
    spoofGenerationWritten: null,
    ...overrides,
  };
}

/**
 * A journal whose `prepare` phase committed a migration — the state every
 * interesting resume decision starts from.
 */
async function journalWithCommittedPreparation(paths: InstancePaths): Promise<Journal> {
  const p = plan();
  const id = computePlanId(p);
  const writer = openJournal(paths, { kind: "fresh-start", reason: "no journal" }, p);
  await writer.beginPhase("plan", null, expectations());
  await writer.commitPhase(outcome());
  await writer.beginPhase("prepare", "migrate", expectations());
  await writer.commitPhase(
    outcome({ migrationsApplied: ["0055_deployment_identity.sql"], manifestPublished: "manifest-bbb" }),
  );
  const journal = readJournal(paths);
  if (journal === null) throw new Error("expected a journal");
  expect(journal.planId).toBe(id);
  return journal;
}

/** State after journalWithCommittedPreparation's migration, as a rerun would observe it. */
const afterPreparation = (overrides: Partial<StateExpectations> = {}): StateExpectations =>
  expectations({
    ledger: ["0053_database_role_taxonomy.sql", "0054_rm_worker_allowlist.sql", "0055_deployment_identity.sql"],
    manifestHash: "manifest-bbb",
    ...overrides,
  });

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A repository with the repo's real build-context shape: `.` for the backend images. */
function buildRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rm-plan-source-"));
  cleanup.push(repo);
  git(repo, "init", "-q");
  mkdirSync(join(repo, "backend"));
  writeFileSync(join(repo, "backend", "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(repo, "backend", "main.ts"), "export const v = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

function planFromRepo(repo: string, digest: string): DeploymentPlan {
  const sources = resolveSourceIdentities(gitRunner(repo), { api: ".", worker: "." });
  return plan({
    images: {
      api: { source: sources.api as string, digest },
      worker: { source: sources.worker as string, digest },
    },
  });
}

describe("DEPLOYMENT_PHASES — §1.3, the ordered phase list with `replace` as the watershed", () => {
  test("is the spec's list, in the spec's order, and every phase in it is one the journal records", async () => {
    expect(DEPLOYMENT_PHASES).toEqual(["plan", "prepare", "preflight", "replace", "participants", "readiness"]);

    const paths = freshPaths();
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan());
    for (const phase of DEPLOYMENT_PHASES) {
      await writer.beginPhase(phase, null, expectations());
      await writer.commitPhase(outcome());
    }
    expect(readJournal(paths)?.phases.map((record) => record.phase)).toEqual([...DEPLOYMENT_PHASES]);
  });
});

describe("computePlanId — §1.2, the plan id is a content hash of exactly the listed fields", () => {
  test("the same intent hashes to the same id, so rule 1's `only when the plan id matches` can ever fire", () => {
    expect(computePlanId(plan())).toBe(computePlanId(plan()));
  });

  test("key insertion order does not change the id — the serialization is canonical", () => {
    const a: DeploymentPlan = plan({ configuration: { A: "1", B: "2" } });
    const b: DeploymentPlan = plan({ configuration: { B: "2", A: "1" } });
    expect(computePlanId(a)).toBe(computePlanId(b));
  });

  test("the roster and the mutations are sets: reordering either is the same intent", () => {
    const p = plan({ mutations: ["seed", "migrate"] });
    const reordered = plan({
      mutations: ["migrate", "seed"],
      roster: { ...p.roster, agents: [...p.roster.agents].reverse() },
    });
    expect(computePlanId(reordered)).toBe(computePlanId(p));
  });

  test("a changed roster changes the id — §1.3 names roster explicitly", () => {
    const changed = plan({ roster: { agents: [{ name: "athena", role: "member", keyFingerprint: FP_ATHENA }], judges: plan().roster.judges } });
    expect(computePlanId(changed)).not.toBe(computePlanId(plan()));
  });

  test("a changed judge roster changes the id", () => {
    const changed = plan({ roster: { agents: plan().roster.agents, judges: [] } });
    expect(computePlanId(changed)).not.toBe(computePlanId(plan()));
  });

  test("a rotated participant key changes the id: the roster hashes each member's key fingerprint", () => {
    const rotated = plan({
      roster: {
        agents: [
          { name: "athena", role: "member", keyFingerprint: publicKeyFingerprint("athena-rotated-public-key") },
          plan().roster.agents[1] as DeploymentPlan["roster"]["agents"][number],
        ],
        judges: plan().roster.judges,
      },
    });
    expect(computePlanId(rotated)).not.toBe(computePlanId(plan()));
  });

  test("D52: a REBUILD — same source, new digest — keeps the id", () => {
    const rebuilt = plan({
      images: { api: { source: SOURCE_A, digest: DIGEST_B }, worker: { source: SOURCE_A, digest: DIGEST_B } },
    });
    expect(computePlanId(rebuilt)).toBe(computePlanId(plan()));
    const notBuiltYet = plan({
      images: { api: { source: SOURCE_A, digest: null }, worker: { source: SOURCE_A, digest: null } },
    });
    expect(computePlanId(notBuiltYet)).toBe(computePlanId(plan()));
  });

  test("D52: a changed image source changes the id", () => {
    const changed = plan({
      images: { api: { source: SOURCE_B, digest: DIGEST_A }, worker: { source: SOURCE_A, digest: DIGEST_A } },
    });
    expect(computePlanId(changed)).not.toBe(computePlanId(plan()));
  });

  test("D52, against real git: an edited build context changes the id; a rebuild of the same tree does not", () => {
    const repo = buildRepo();
    const clean = computePlanId(planFromRepo(repo, DIGEST_A));
    expect(computePlanId(planFromRepo(repo, DIGEST_B))).toBe(clean);

    writeFileSync(join(repo, "backend", "main.ts"), "export const v = 2;\n");
    const edited = computePlanId(planFromRepo(repo, DIGEST_A));
    expect(edited).not.toBe(clean);

    writeFileSync(join(repo, "backend", "main.ts"), "export const v = 1;\n");
    expect(computePlanId(planFromRepo(repo, DIGEST_B))).toBe(clean);
  });

  test("a changed target changes the id — host, port, database name, identity kind, or local volume", () => {
    const base = computePlanId(plan());
    const remote = plan().target;
    if (remote.kind !== "remote") throw new Error("fixture is remote");
    for (const target of [
      { ...remote, host: "other.example.invalid" },
      { ...remote, port: 5432 },
      { ...remote, dbname: "robotmoney_stage" },
      { ...remote, identity: "production" as const },
    ]) {
      expect(computePlanId(plan({ target }))).not.toBe(base);
    }
    const localA = plan({ target: { kind: "local", rmEnv: "stage", identity: "rehearsal", mode: "volume", volume: "rm_alpha_pg" } });
    const localB = plan({ target: { kind: "local", rmEnv: "stage", identity: "rehearsal", mode: "volume", volume: "rm_beta_pg" } });
    expect(computePlanId(localA)).not.toBe(computePlanId(localB));
    expect(computePlanId(localA)).not.toBe(base);
  });

  test("two spellings of one host's case are one target", () => {
    const remote = plan().target;
    if (remote.kind !== "remote") throw new Error("fixture is remote");
    expect(computePlanId(plan({ target: { ...remote, host: "DB.Example.Invalid" } }))).toBe(computePlanId(plan()));
  });

  test("a changed set of intended mutations changes the id", () => {
    expect(computePlanId(plan({ mutations: ["migrate", "seed"] }))).not.toBe(computePlanId(plan()));
  });

  test("a changed configuration value changes the id", () => {
    expect(computePlanId(plan({ configuration: { SWARM_EPOCH_MINUTES: "30" } }))).not.toBe(computePlanId(plan()));
  });

  test("a changed instance changes the id", () => {
    expect(computePlanId(plan({ instance: "beta" }))).not.toBe(computePlanId(plan()));
  });

  test("the hashed material is exactly §1.2's list: no digest, no timestamp, no schema version, no secret", () => {
    const material = planHashMaterial(plan()) as Record<string, unknown>;
    expect(Object.keys(material).sort()).toEqual(["configuration", "images", "instance", "mutations", "roster", "target"]);
    expect(material.images).toEqual({ api: SOURCE_A, worker: SOURCE_A });
    expect(JSON.stringify(material)).not.toContain(DIGEST_A);
    expect(Object.keys(material.target as object).sort()).toEqual(["dbname", "host", "identity", "kind", "port", "rmEnv"]);
    expect(JSON.stringify(material)).not.toMatch(/At"|schemaHead|manifest|password/i);
  });

  test("state a journaled phase changes cannot enter the id: a plan carrying a schema version or a timestamp refuses", () => {
    const withSchema = { ...plan(), schemaHead: "0072_drop_swarm_schedules.sql" } as unknown as DeploymentPlan;
    expect(() => computePlanId(withSchema)).toThrow(/plan\.schemaHead is not one §1\.2 lists/);
    const withTime = { ...plan(), createdAt: "2026-09-24T00:00:00Z" } as unknown as DeploymentPlan;
    expect(() => computePlanId(withTime)).toThrow(/plan\.createdAt/);
  });

  test("the id is identical before and after the journal records a migration — the plan does not move with the work", async () => {
    const paths = freshPaths();
    const before = computePlanId(plan());
    await journalWithCommittedPreparation(paths);
    expect(readJournal(paths)?.planId).toBe(before);
    expect(computePlanId(plan())).toBe(before);
  });

  test("no timestamp, pid or host path leaks in: two calls a moment apart agree", async () => {
    const first = computePlanId(plan());
    await Bun.sleep(5);
    expect(computePlanId(plan())).toBe(first);
  });

  test("an image keyed by a secret-shaped service name refuses without printing it — renderPlan prints the key", () => {
    for (const key of ["user:hunter2@db", "Xk3v_9QpL2mZ7rT0bN4sW8cY1hJ6fD5g", "API"]) {
      let message = "";
      try {
        computePlanId(plan({ images: { [key]: { source: SOURCE_A, digest: DIGEST_A } } }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/plan field plan\.images\.<key> has a key that is not a compose service name/);
      expect(message).not.toContain(key);
    }
  });

  test("an image source that is not a Git tree id refuses", () => {
    expect(() => computePlanId(plan({ images: { api: { source: "main", digest: DIGEST_A } } }))).toThrow(/Git tree id/);
  });

  test("an image digest given as a tag refuses: a moved tag would describe other bytes", () => {
    expect(() =>
      computePlanId(plan({ images: { api: { source: SOURCE_A, digest: "robotmoney/api:latest" } } })),
    ).toThrow(/digest/i);
  });
});

describe("the plan is redacted by structure — §1.2, the printed plan holds no password, token or key", () => {
  /** Every refusal names the field and never echoes the value it refused. */
  function expectRefused(p: DeploymentPlan, secret: string, secrets: readonly string[] = []): void {
    let message = "";
    try {
      computePlanId(p, { secrets });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Refusing: plan field/);
    expect(message).not.toContain(secret);
    // renderPlan is the printer, and it refuses the same plan.
    expect(() => renderPlan(p, "0".repeat(64) as PlanId, { secrets })).toThrow(/Refusing/);
  }

  test("a role password is refused by its shape alone — pinned samples of the generator's output", () => {
    // Real outputs of generateRolePasswords (24 random bytes, base64url),
    // pinned so the by-shape assertion is deterministic.
    for (const password of [
      "g01CulXLs7OVrejZAMB-VYSBIusyxfjt",
      "Xk3v_9QpL2mZ7rT0bN4sW8cY1hJ6fD5g",
      "mhRjBVRuRWUwhexbQeNS8PVtIAzMy6P5",
      "94-Oo9pKQEBYIKJVbvnzuBPgktT5adfq",
    ]) {
      expect(credentialShape(password)).not.toBeNull();
      expectRefused(plan({ configuration: { SWARM_EPOCH_MINUTES: password } }), password);
    }
  });

  test("the shape rule is a net, not the guarantee: a generated password it misses is still refused by value", () => {
    // A real generator output whose cases clustered and which drew no digit.
    // About three in ten thousand random 32-character strings look like this;
    // the caller's `secrets` list is what refuses them.
    const clustered = "jbehcZSIMTwjYcojMIglixoZAn_IjwJC";
    expect(credentialShape(clustered)).toBeNull();
    expectRefused(plan({ configuration: { SWARM_EPOCH_MINUTES: clustered } }), clustered, [clustered]);
  });

  test("a role password — the generator's live output — is refused by value wherever it is planted", () => {
    const passwords = generateRolePasswords(freshPaths());
    const all = Object.values(passwords);
    for (const [role, password] of Object.entries(passwords)) {
      expectRefused(plan({ configuration: { NOTE: `role ${role} is ${password}` } }), password, all);
    }
  });

  test("the rm_owner password is refused: by its key name, and by value when the operator typed something shapeless", () => {
    const typed = "correct horse battery staple";
    expectRefused(plan({ configuration: { RM_OWNER_PASSWORD: typed } }), typed);
    expectRefused(plan({ configuration: { OWNER: typed } }), typed, [typed]);
    // A generated local owner password has a shape too.
    const generated = generateRolePasswords(freshPaths()).rm_owner;
    expectRefused(plan({ configuration: { OWNER: generated } }), generated, [generated]);
  });

  test("a hex service token is refused", () => {
    const token = randomBytes(32).toString("hex");
    expectRefused(plan({ configuration: { SCHEDULER: token } }), token);
    expectRefused(plan({ configuration: { SYSTEM_SCHEDULER_TOKEN: "x" } }), "x");
  });

  test("a base64 and a base64url service token are refused, and so is the automation-token form", () => {
    const b64 = "q7Zp3N1xK9vR0mWc4TbL8sYh2FjDgU6e+A5o/Hn1Ii=";
    const b64url = "Xk3v_9QpL2mZ7rT0bN4sW8cY1hJ6fD5gA-uE3oI7nKq";
    const automation = `rmat_${b64url}`;
    for (const token of [b64, b64url, automation]) {
      expect(credentialShape(token)).not.toBeNull();
      expectRefused(plan({ configuration: { PRODUCER: token } }), token);
    }
  });

  test("a participant key is refused: as a raw key, as a JWK, and in the fingerprint slot", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    const d = String(jwk.d);
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const raw = Buffer.from(d, "base64url").toString("hex");
    expectRefused(plan({ configuration: { ATHENA: JSON.stringify(jwk) } }), d, [d]);
    expectRefused(plan({ configuration: { ATHENA: pem } }), pem);
    expectRefused(plan({ configuration: { ATHENA: raw } }), raw);
    // The fingerprint slot takes `fp:` and 16 hex, so no key fits in it.
    const leaked = plan({
      roster: { agents: [{ name: "athena", role: "member", keyFingerprint: d }], judges: [] },
    });
    expectRefused(leaked, d);
    // What does fit is the fingerprint of the PUBLIC key, which is not the key.
    const pub = publicKey.export({ format: "jwk" }).x as string;
    const planned = plan({
      roster: { agents: [{ name: "athena", role: "member", keyFingerprint: publicKeyFingerprint(pub) }], judges: [] },
    });
    const text = renderPlan(planned, computePlanId(planned, { secrets: [d] }), { secrets: [d] });
    expect(text).not.toContain(d);
    expect(text).not.toContain(pub);
  });

  test("the target cannot carry userinfo: host is a bare hostname, never `user:pass@host`", () => {
    const remote = plan().target;
    if (remote.kind !== "remote") throw new Error("fixture is remote");
    expectRefused(plan({ target: { ...remote, host: "rm_app:hunter2@db.example.invalid" } }), "hunter2");
    expectRefused(plan({ target: { ...remote, host: "postgres://rm_app:hunter2@db.example.invalid" } }), "hunter2");
    expectRefused(plan({ target: { ...remote, dbname: "robotmoney?password=hunter2" } }), "hunter2");
  });

  test("a connection string anywhere in configuration refuses, without or with a scheme", () => {
    expectRefused(plan({ configuration: { UPSTREAM: "postgres://rm_app:hunter2@db.example.invalid/robotmoney" } }), "hunter2");
    expectRefused(plan({ configuration: { UPSTREAM: "rm_app:hunter2@db.example.invalid/robotmoney" } }), "hunter2");
    expectRefused(plan({ configuration: { DATABASE_URL: "anything" } }), "anything");
  });

  test("a field the plan does not define is refused rather than carried", () => {
    const smuggled = { ...plan(), rolePasswords: { rm_app: "x" } } as unknown as DeploymentPlan;
    expect(() => assertPlanRedacted(smuggled)).toThrow(/plan\.rolePasswords is not one §1\.2 lists/);
  });

  test("a roster role that disagrees with its namespace refuses (§6.1)", () => {
    const wrong = plan({ roster: { agents: [{ name: "athena", role: "judge", keyFingerprint: FP_ATHENA }], judges: [] } });
    expect(() => computePlanId(wrong)).toThrow(/role/);
  });

  test("ordinary configuration values pass: model ids, cron strings, URLs, paths, numbers", () => {
    for (const value of [
      "Qwen2.5-Coder-32B-Instruct",
      "claude-sonnet-4-5-20250929",
      "opencode/big-pickle",
      "0 23 * * *",
      "https://api.robotmoney.network/v1",
      "/home/stage-server/.local/state/robotmoney-smoke",
      "900",
      "true",
    ]) {
      expect(credentialShape(value)).toBeNull();
    }
  });
});

describe("renderPlan — §1.2, every field printed before any mutation", () => {
  test("prints the instance, the target line, every image's source AND digest, every member, every config entry and the mutations", () => {
    const p = plan({ mutations: ["migrate", "seed"] });
    const id = computePlanId(p);
    const lines = renderPlan(p, id).trimEnd().split("\n");
    expect(lines).toEqual([
      "instance: alpha",
      "target: remote db.example.invalid:25060/robotmoney (RM_ENV=stage, deployment_identity rehearsal)",
      `image: api source ${SOURCE_A} digest ${DIGEST_A}`,
      `image: worker source ${SOURCE_A} digest ${DIGEST_A}`,
      `agent: athena role member key ${FP_ATHENA}`,
      `agent: robot-money role member key ${FP_ROBOT}`,
      `judge: themis role judge key ${FP_THEMIS}`,
      "config: JUDGE_MODEL=Qwen2.5-Coder-32B-Instruct",
      "config: SWARM_EPOCH_MINUTES=15",
      "mutations: migrate, seed",
      `plan id: ${id}`,
    ]);
  });

  test("a local target prints its mode and volume; an unbuilt image and an empty roster say so", () => {
    const p = plan({
      target: { kind: "local", rmEnv: "stage", identity: "rehearsal", mode: "dump", volume: "rm_alpha_pg" },
      images: { api: { source: SOURCE_B, digest: null } },
      roster: { agents: [], judges: [] },
      configuration: {},
      mutations: [],
    });
    const text = renderPlan(p, computePlanId(p));
    expect(text).toContain("target: local dump on volume rm_alpha_pg (RM_ENV=stage, deployment_identity rehearsal)");
    expect(text).toContain(`image: api source ${SOURCE_B} digest not built yet`);
    expect(text).toContain("agents: none");
    expect(text).toContain("judges: none");
    expect(text).toContain("mutations: none");
  });

  test("the plan id is the last line, so an operator always knows where to look for it", () => {
    const p = plan();
    const id = computePlanId(p);
    const lines = renderPlan(p, id).trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe(`plan id: ${id}`);
  });

  test("an id that is not this plan's refuses: a printed plan and its id cannot disagree", () => {
    expect(() => renderPlan(plan(), computePlanId(plan({ instance: "beta" })))).toThrow(/content hash/);
  });

  test("the rendering is deterministic, so two runs' plans are diffable", () => {
    const p = plan();
    const id = computePlanId(p);
    expect(renderPlan(p, id)).toBe(renderPlan(p, id));
  });

  test("the rendering holds none of the run's secrets", () => {
    const passwords = Object.values(generateRolePasswords(freshPaths()));
    const token = randomBytes(32).toString("base64url");
    const p = plan();
    const text = renderPlan(p, computePlanId(p), { secrets: [...passwords, token] });
    for (const secret of [...passwords, token]) expect(text).not.toContain(secret);
    expect(text).not.toContain("postgres://");
  });
});

describe("decideResume rule 1 — §1.3, a matching plan id resumes and its own work never blocks it", () => {
  test("no journal is a fresh start", () => {
    const decision = decideResume(null, computePlanId(plan()), expectations());
    expect(decision.kind).toBe("fresh-start");
  });

  test("a committed preparation under the same plan id resumes at the next phase", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const decision = decideResume(journal, journal.planId, afterPreparation());
    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") throw new Error("expected a resume");
    expect(decision.nextPhase).toBe("preflight");
  });

  test("the journal's own applied migration is accounted for, not treated as someone else's change", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    expect(decideResume(journal, journal.planId, afterPreparation()).kind).not.toBe("refuse");
  });

  test("a rebuild from unchanged sources is the same plan: the rerun resumes rather than superseding", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const rebuilt = plan({
      images: { api: { source: SOURCE_A, digest: DIGEST_B }, worker: { source: SOURCE_A, digest: DIGEST_B } },
    });
    expect(decideResume(journal, computePlanId(rebuilt), afterPreparation()).kind).toBe("resume");
  });

  test("a journal whose phases all committed resumes at the phase after the last committed one", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const decision = decideResume(journal, journal.planId, afterPreparation());
    if (decision.kind !== "resume") throw new Error("expected a resume");
    expect(DEPLOYMENT_PHASES.indexOf(decision.nextPhase)).toBeGreaterThan(DEPLOYMENT_PHASES.indexOf("prepare"));
  });

  test("expectations are projected from the LATEST phase's own record, not the first", async () => {
    // The plan phase began with one participant; by the time preflight began
    // the run had accepted a second. A rerun that finds both is the world this
    // journal last recorded — resume. Projecting from phases[0] would refuse.
    const paths = freshPaths();
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan());
    await writer.beginPhase("plan", null, expectations({ participants: ["athena"] }));
    await writer.commitPhase(outcome());
    await writer.beginPhase("preflight", null, expectations({ participants: ["athena", "themis"] }));
    await writer.endPhase("interrupted", "SIGINT at phase boundary");
    const journal = readJournal(paths) as Journal;

    const resumed = decideResume(journal, journal.planId, expectations({ participants: ["themis", "athena"] }));
    expect(resumed.kind).toBe("resume");
    const refused = decideResume(journal, journal.planId, expectations({ participants: ["athena"] }));
    expect(refused.kind).toBe("refuse");
    if (refused.kind !== "refuse") throw new Error("expected a refusal");
    expect(refused.reason).toContain("[athena]");
    expect(refused.reason).toContain("[athena,themis]");
  });

  test("a journal with no phase yet resumes at `plan` whatever the world looks like — it recorded no expectation", () => {
    const paths = freshPaths();
    openJournal(paths, { kind: "fresh-start", reason: "none" }, plan());
    const journal = readJournal(paths) as Journal;
    const decision = decideResume(journal, journal.planId, expectations({ ledger: ["0099_anything.sql"] }));
    expect(decision).toEqual({ kind: "resume", journal, nextPhase: "plan" });
  });
});

describe("decideResume rule 2 — §1.3, a different plan id supersedes and never reuses completed phases", () => {
  test("a changed roster supersedes rather than resuming", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const newId = computePlanId(plan({ roster: { agents: [], judges: plan().roster.judges } }));
    expect(decideResume(journal, newId, afterPreparation()).kind).toBe("supersede");
  });

  test("a changed image source supersedes rather than resuming", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const newId = computePlanId(
      plan({ images: { api: { source: SOURCE_B, digest: DIGEST_A }, worker: { source: SOURCE_A, digest: DIGEST_A } } }),
    );
    expect(decideResume(journal, newId, afterPreparation()).kind).toBe("supersede");
  });

  test("a changed target supersedes rather than resuming", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const remote = plan().target;
    if (remote.kind !== "remote") throw new Error("fixture is remote");
    const newId = computePlanId(plan({ target: { ...remote, host: "other.invalid" } }));
    expect(decideResume(journal, newId, afterPreparation()).kind).toBe("supersede");
  });

  test("the supersede carries a report of what the old journal reached, naming its committed migration", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const newId = computePlanId(plan({ mutations: ["migrate", "seed"] }));
    const decision = decideResume(journal, newId, afterPreparation());
    if (decision.kind !== "supersede") throw new Error("expected a supersede");
    expect(decision.report).toContain("0055_deployment_identity.sql");
    expect(decision.report).toContain("prepare (migrate), committed");
    expect(decision.previous.planId).toBe(journal.planId);
  });

  test("an already-closed journal is a fresh start, not a second supersede", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const closed: Journal = { ...journal, closedAt: "2026-09-23T00:00:00.000Z" };
    expect(decideResume(closed, journal.planId, expectations()).kind).toBe("fresh-start");
  });
});

describe("openJournal on a supersede — §1.3 rule 2, close the old journal, report it, start at zero phases", () => {
  async function supersede() {
    const paths = freshPaths();
    const old = await journalWithCommittedPreparation(paths);
    const next = plan({ mutations: ["migrate", "seed"] });
    const decision = decideResume(old, computePlanId(next), afterPreparation());
    if (decision.kind !== "supersede") throw new Error("expected a supersede");
    const writer = openJournal(paths, decision, next);
    return { paths, old, next, decision, writer };
  }

  test("the new journal starts with zero phases: no completed phase is reused", async () => {
    const { paths, next } = await supersede();
    const journal = readJournal(paths) as Journal;
    expect(journal.planId).toBe(computePlanId(next));
    expect(journal.phases).toEqual([]);
    expect(journal.closedAt).toBeNull();
  });

  test("a rerun under the new plan begins at `plan`, not after the old journal's committed `prepare`", async () => {
    const { paths, next } = await supersede();
    const decision = decideResume(readJournal(paths), computePlanId(next), afterPreparation());
    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") throw new Error("expected a resume");
    expect(decision.nextPhase).toBe("plan");
  });

  test("the old journal is archived CLOSED, with its report and the superseding plan id — not overwritten", async () => {
    const { paths, old, next, decision } = await supersede();
    const archived = readArchivedJournals(paths);
    expect(archived).toHaveLength(1);
    const [closed] = archived;
    expect(closed?.planId).toBe(old.planId);
    expect(closed?.closedAt).not.toBeNull();
    expect(closed?.closeReport).toBe(decision.report);
    expect(closed?.closeReport).toContain("0055_deployment_identity.sql");
    expect(closed?.supersededBy).toBe(computePlanId(next));
    expect(closed?.phases.map((record) => record.phase)).toEqual(["plan", "prepare"]);
  });

  test("a supersede decision about a journal no longer on disk refuses", async () => {
    const { paths, decision } = await supersede();
    expect(() => openJournal(paths, decision, plan({ mutations: ["seed"] }))).toThrow(/no longer the one/);
  });
});

describe("decideResume rule 3 — §1.3, state changed by another operation refuses, naming expected AND observed", () => {
  async function refusal(observed: StateExpectations): Promise<string> {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const decision = decideResume(journal, journal.planId, observed);
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") throw new Error("expected a refusal");
    return decision.reason;
  }

  test("a migration the journal's outcomes cannot account for refuses, naming both lists", async () => {
    const reason = await refusal(
      afterPreparation({
        ledger: [
          "0053_database_role_taxonomy.sql",
          "0054_rm_worker_allowlist.sql",
          "0055_deployment_identity.sql",
          "0056_someone_elses.sql",
        ],
        manifestHash: "manifest-ccc",
      }),
    );
    expect(reason).toContain("0056_someone_elses.sql");
    expect(reason).toContain("3 file(s) ending 0055_deployment_identity.sql");
  });

  test("a migration applied BELOW the head refuses, though the head is unchanged — rule 3 compares the whole list", async () => {
    // Another operation applied a lower-filename migration while the journal
    // was stopped. The head is still 0055, so only a whole-list comparison sees
    // it (the same case target-lock.test.ts proves for revalidation).
    const reason = await refusal(
      afterPreparation({
        ledger: [
          "0050_below_the_head.sql",
          "0053_database_role_taxonomy.sql",
          "0054_rm_worker_allowlist.sql",
          "0055_deployment_identity.sql",
        ],
      }),
    );
    expect(reason).toContain("4 file(s) ending 0055_deployment_identity.sql");
    expect(reason).toContain("3 file(s) ending 0055_deployment_identity.sql");
    expect(reason).toContain("position 1: 0050_below_the_head.sql where the journal expects 0053_database_role_taxonomy.sql");
  });

  test("the journal's own committed migration advances the expected list, wherever it sorts", async () => {
    // Rule 1: work the journal committed never refuses its own resume.
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    expect(decideResume(journal, journal.planId, afterPreparation()).kind).toBe("resume");
  });

  test("a manifest hash that moved unaccountably refuses, naming both hashes", async () => {
    const reason = await refusal(afterPreparation({ manifestHash: "manifest-zzz" }));
    expect(reason).toContain("manifest-zzz");
    expect(reason).toContain("manifest-bbb");
  });

  test("a re-enrolled target refuses: every policy decision the plan was built on was taken against another answer", async () => {
    const reason = await refusal(afterPreparation({ identity: "production" }));
    expect(reason).toContain("production");
    expect(reason).toContain("rehearsal");
  });

  test("a spoofed-key generation nobody journaled refuses, naming it and the generation expected", async () => {
    const reason = await refusal(afterPreparation({ spoofGeneration: "gen-unknown" }));
    expect(reason).toContain("gen-unknown");
    expect(reason).toContain("expects null");
  });

  test("running participants that differ from the journal's refuse, naming both sets", async () => {
    const reason = await refusal(afterPreparation({ participants: ["athena", "intruder"] }));
    expect(reason).toContain("[athena,intruder]");
    expect(reason).toContain("expects [athena]");
  });

  test("a service on a digest neither the plan nor the journal names refuses, naming the observed and expected digests", async () => {
    const foreign = "sha256:9999999999999999999999999999999999999999999999999999999999999999";
    const reason = await refusal(afterPreparation({ services: { api: foreign, worker: DIGEST_A } }));
    expect(reason).toContain(foreign);
    expect(reason).toContain(`expects ${DIGEST_A}`);
  });

  test("an expected service that is no longer running refuses — absence is a change too", async () => {
    const reason = await refusal(afterPreparation({ services: { api: DIGEST_A } }));
    expect(reason).toContain("service worker is not running");
    expect(reason).toContain(DIGEST_A);
  });

  test("a refusal is a refusal, never a silent reconciliation", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const decision = decideResume(journal, journal.planId, expectations({ ledger: ["0099_foreign.sql"] }));
    expect(decision.kind).not.toBe("fresh-start");
    expect(decision.kind).not.toBe("resume");
  });
});

describe("readJournal / openJournal — §1.3, an unparseable record is never an absent one", () => {
  test("an instance that has never run has no journal", () => {
    expect(readJournal(freshPaths())).toBeNull();
  });

  test("a malformed journal refuses rather than reading as absent — absent means `mutate freely`", () => {
    const paths = freshPaths();
    writeFileSync(paths.journalFile, "{ truncated");
    expect(() => readJournal(paths)).toThrow(/journal|malformed|parse/i);
  });

  test("a version-1 journal (the pre-{source,digest} plan shape) refuses rather than parsing as the new type", () => {
    const paths = freshPaths();
    expect(JOURNAL_FORMAT_VERSION).toBe(2);
    writeFileSync(
      paths.journalFile,
      JSON.stringify({
        formatVersion: 1,
        payload: { planId: "0".repeat(64), plan: { images: { api: DIGEST_A }, roster: ["athena"] }, phases: [] },
      }),
    );
    expect(() => readJournal(paths)).toThrow(/unknown format version: 1/);
  });

  test("a journal with an unknown format version refuses", () => {
    const paths = freshPaths();
    writeFileSync(paths.journalFile, JSON.stringify({ formatVersion: 9999, phases: [] }));
    expect(() => readJournal(paths)).toThrow(/version|format/i);
  });

  test("openJournal on a `refuse` decision refuses: the check is not re-litigated here", () => {
    const paths = freshPaths();
    expect(() =>
      openJournal(paths, { kind: "refuse", reason: "schema moved under the journal" }, plan()),
    ).toThrow(/refus|schema moved/i);
  });

  test("openJournal on a missing state directory refuses — a run that cannot journal must not mutate", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-smoke-journal-"));
    cleanup.push(root);
    const paths = instancePaths(root, "never-created");
    expect(() => openJournal(paths, { kind: "fresh-start", reason: "none" }, plan())).toThrow(/director|writ/i);
  });

  test("a resume decision for another plan id refuses: only a matching plan id resumes", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const decision = decideResume(journal, journal.planId, afterPreparation());
    if (decision.kind !== "resume") throw new Error("expected a resume");
    expect(() => openJournal(paths, decision, plan({ mutations: ["seed"] }))).toThrow(/plan/);
  });

  test("a fresh start over an OPEN journal refuses: the caller decided without it", async () => {
    const paths = freshPaths();
    await journalWithCommittedPreparation(paths);
    expect(() => openJournal(paths, { kind: "fresh-start", reason: "none" }, plan())).toThrow(/open journal/);
  });

  test("a fresh start over a CLOSED journal archives it first, so nothing a journal recorded is lost", async () => {
    const paths = freshPaths();
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan());
    await writer.beginPhase("plan", null, expectations());
    await writer.close("operator abandoned the plan");
    openJournal(paths, { kind: "fresh-start", reason: "closed" }, plan({ mutations: [] }));
    const [archived] = readArchivedJournals(paths);
    expect(archived?.closeReport).toBe("operator abandoned the plan");
    expect(readJournal(paths)?.phases).toEqual([]);
  });

  test("close records its reason — it is not discarded", async () => {
    const paths = freshPaths();
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan());
    await writer.close("operator abandoned the plan");
    const journal = readJournal(paths);
    expect(journal?.closedAt).not.toBeNull();
    expect(journal?.closeReport).toBe("operator abandoned the plan");
  });

  test("the journal is written BEFORE the phase acts, so a crash inside a phase leaves a trace", async () => {
    const paths = freshPaths();
    const p = plan();
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    await writer.beginPhase("prepare", "migrate", expectations());

    const journal = readJournal(paths);
    expect(journal?.phases).toHaveLength(1);
    expect(journal?.phases[0]?.phase).toBe("prepare");
    expect(journal?.phases[0]?.step).toBe("migrate");
    expect(journal?.phases[0]?.status).toBe("started");
    expect(journal?.phases[0]?.outcome).toBeNull();
  });

  test("each committed preparation is recorded separately, not as one grouped `prepare`", async () => {
    const paths = freshPaths();
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan({ mutations: ["migrate", "seed"] }));
    await writer.beginPhase("prepare", "migrate", expectations());
    await writer.commitPhase(outcome({ migrationsApplied: ["0055_deployment_identity.sql"] }));
    await writer.beginPhase("prepare", "seed", expectations());
    await writer.commitPhase(outcome());

    const steps = (readJournal(paths)?.phases ?? []).filter((p) => p.phase === "prepare").map((p) => p.step);
    expect(steps).toEqual(["migrate", "seed"]);
  });
});

describe("interruption — §1.4, Ctrl-C stops at the next phase boundary", () => {
  test("a Ctrl-C before `replace` leaves the committed preparation journaled and no service replaced", async () => {
    const paths = freshPaths();
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan());
    await writer.beginPhase("prepare", "migrate", expectations());
    await writer.commitPhase(outcome({ migrationsApplied: ["0055_deployment_identity.sql"] }));
    await writer.beginPhase("preflight", null, expectations());
    await writer.endPhase("interrupted", "SIGINT at phase boundary");

    const journal = readJournal(paths);
    const prepare = journal?.phases.find((p) => p.phase === "prepare");
    expect(prepare?.status).toBe("committed");
    expect(prepare?.outcome?.migrationsApplied).toEqual(["0055_deployment_identity.sql"]);
    expect(journal?.phases.some((p) => p.phase === "replace")).toBe(false);
    for (const phase of journal?.phases ?? []) {
      expect(phase.outcome?.servicesReplaced ?? {}).toEqual({});
    }
  });

  test("an interrupted phase records the reason and is a first-class ending, not a failure", async () => {
    const paths = freshPaths();
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, plan());
    await writer.beginPhase("preflight", null, expectations());
    await writer.endPhase("interrupted", "SIGINT at phase boundary");

    const record = readJournal(paths)?.phases.at(-1);
    expect(record?.status).toBe("interrupted");
    expect(record?.reason).toBe("SIGINT at phase boundary");
    expect(record?.endedAt).not.toBeNull();
  });

  test("a Ctrl-C after replacement began leaves the journal describing which services moved, and a rerun resumes", async () => {
    const paths = freshPaths();
    const p = plan({ images: { api: { source: SOURCE_B, digest: DIGEST_B }, worker: { source: SOURCE_A, digest: DIGEST_A } } });
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    await writer.beginPhase("replace", null, expectations());
    await writer.commitPhase(outcome({ servicesReplaced: { api: DIGEST_B } }));
    await writer.beginPhase("participants", null, expectations({ services: { api: DIGEST_B, worker: DIGEST_A } }));
    await writer.endPhase("interrupted", "SIGINT at phase boundary");

    const journal = readJournal(paths);
    if (journal === null) throw new Error("expected a journal");
    const decision = decideResume(
      journal,
      computePlanId(p),
      expectations({ services: { api: DIGEST_B, worker: DIGEST_A } }),
    );
    expect(decision.kind).toBe("resume");
    if (decision.kind !== "resume") throw new Error("expected a resume");
    expect(decision.nextPhase).toBe("participants");
  });

  test("the watch starts unrequested and observes a stop request without aborting in-flight work", () => {
    const watch = watchForInterrupt();
    try {
      expect(watch.requested()).toBe(false);
      process.emit("SIGINT");
      expect(watch.requested()).toBe(true);
    } finally {
      watch.dispose();
    }
  });

  test("a second Ctrl-C does not escalate to an immediate exit — the thing it would kill is a transaction", () => {
    const watch = watchForInterrupt();
    try {
      process.emit("SIGINT");
      process.emit("SIGINT");
      expect(watch.requested()).toBe(true);
    } finally {
      watch.dispose();
    }
  });

  test("installing the watch never fails a run", () => {
    expect(() => watchForInterrupt().dispose()).not.toThrow();
  });

  test("after dispose the watch no longer reports requests from later signals", () => {
    const watch = watchForInterrupt();
    watch.dispose();
    expect(watch.requested()).toBe(false);
  });
});

describe("receipt — §1.4, the artifact that outlives the run", () => {
  function receiptFor(p: DeploymentPlan, overrides: Partial<Receipt> = {}): Receipt {
    return {
      planId: computePlanId(p),
      plan: p,
      instance: p.instance,
      writtenAt: "2026-09-23T10:00:00.000Z",
      images: { api: DIGEST_B, worker: DIGEST_B },
      schema: { manifestHash: "manifest-bbb", migrations: ["0054_rm_worker_allowlist.sql"] },
      preflight: [{ check: "roles authenticate", pass: true, detail: "4/4" }],
      readiness: [{ check: "scheduler ready", pass: true, detail: "stream synchronized, rebuild complete" }],
      ...overrides,
    };
  }

  test("an instance with no receipt reads as null, which routes the reader to the journal", () => {
    expect(readReceipt(freshPaths())).toBeNull();
  });

  test("a written receipt round-trips exactly — it must be self-contained for incident work", async () => {
    const paths = freshPaths();
    const p = plan();
    openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    const receipt = receiptFor(p);
    await writeReceipt(paths, receipt);
    expect(readReceipt(paths)).toEqual(receipt);
  });

  test("the receipt records the built digests that ran — the plan id does not hash them", async () => {
    const paths = freshPaths();
    const p = plan();
    openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    await writeReceipt(paths, receiptFor(p));
    expect(readReceipt(paths)?.images).toEqual({ api: DIGEST_B, worker: DIGEST_B });
    expect(summarizeProgress(null, readReceipt(paths))).toContain(`service api: running ${DIGEST_B}`);
  });

  test("a version-1 receipt (no `images`) refuses rather than parsing as the new type", () => {
    const paths = freshPaths();
    expect(RECEIPT_FORMAT_VERSION).toBe(2);
    writeFileSync(
      paths.receiptFile,
      JSON.stringify({ formatVersion: 1, payload: { planId: "0".repeat(64), instance: "alpha", schema: {} } }),
    );
    expect(() => readReceipt(paths)).toThrow(/unknown format version: 1/);
  });

  test("a shapeless secret in the plan's configuration refuses openJournal and writeReceipt when it is in the secrets list", async () => {
    // The shape rule misses about 3 in 10,000 random tokens; the by-value list
    // is the guarantee, and both files that persist the plan must apply it.
    const clustered = "jbehcZSIMTwjYcojMIglixoZAn_IjwJC";
    expect(credentialShape(clustered)).toBeNull();
    const leaky = plan({ configuration: { SWARM_EPOCH_MINUTES: "15", NOTE: clustered } });

    const refusedOpen = freshPaths();
    expect(() =>
      openJournal(refusedOpen, { kind: "fresh-start", reason: "none" }, leaky, { secrets: [clustered] }),
    ).toThrow(/contains one of this run's secrets/);
    expect(readJournal(refusedOpen)).toBeNull();

    const paths = freshPaths();
    openJournal(paths, { kind: "fresh-start", reason: "none" }, leaky);
    await expect(writeReceipt(paths, receiptFor(leaky), { secrets: [clustered] })).rejects.toThrow(
      /contains one of this run's secrets/,
    );
    expect(readReceipt(paths)).toBeNull();
  });

  test("a receipt keyed by something that is not a service name refuses", async () => {
    const paths = freshPaths();
    const p = plan();
    openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    await expect(
      writeReceipt(paths, receiptFor(p, { images: { "postgres://u:hunter2@db": DIGEST_B } })),
    ).rejects.toThrow(/service name/);
  });

  test("a receipt recording a tag rather than a digest refuses", async () => {
    const paths = freshPaths();
    const p = plan();
    openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    await expect(writeReceipt(paths, receiptFor(p, { images: { api: "robotmoney/api:latest" } }))).rejects.toThrow(
      /digest/,
    );
  });

  test("a receipt is refused when readiness did not pass — there is no receipt for a boot that never got there", async () => {
    const paths = freshPaths();
    const p = plan();
    openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    const failed = receiptFor(p, {
      readiness: [{ check: "scheduler ready", pass: false, detail: "initial rebuild never completed" }],
    });
    await expect(writeReceipt(paths, failed)).rejects.toThrow(/readiness/i);
    expect(readReceipt(paths)).toBeNull();
  });

  test("a receipt whose plan id does not match the open journal refuses", async () => {
    const paths = freshPaths();
    const p = plan();
    openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    const mismatched = receiptFor(plan({ instance: "beta" }));
    await expect(writeReceipt(paths, mismatched)).rejects.toThrow(/plan id/i);
  });

  test("a receipt whose plan id is not its own plan's content hash refuses", async () => {
    const paths = freshPaths();
    const p = plan();
    openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    const forged = receiptFor(p, { plan: plan({ mutations: ["seed"] }) });
    await expect(writeReceipt(paths, forged)).rejects.toThrow(/content hash/);
  });

  test("a malformed receipt refuses rather than reading as absent", () => {
    const paths = freshPaths();
    writeFileSync(paths.receiptFile, "{ truncated");
    expect(() => readReceipt(paths)).toThrow(/receipt|malformed|parse/i);
  });
});

describe("summarizeProgress — §1.4, receipt when present, journal when not", () => {
  test("with a receipt it reports a finished run", async () => {
    const paths = freshPaths();
    const p = plan();
    openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    const receipt: Receipt = {
      planId: computePlanId(p),
      plan: p,
      instance: p.instance,
      writtenAt: "2026-09-23T10:00:00.000Z",
      images: { api: DIGEST_A },
      schema: { manifestHash: "manifest-bbb", migrations: ["0054_rm_worker_allowlist.sql"] },
      preflight: [{ check: "roles authenticate", pass: true, detail: "4/4" }],
      readiness: [{ check: "scheduler ready", pass: true, detail: "stream synchronized" }],
    };
    await writeReceipt(paths, receipt);
    const summary = summarizeProgress(readJournal(paths), readReceipt(paths));
    expect(summary).toContain("readiness");
  });

  test("with no receipt it reports the journal's phase and the preparation that committed", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const summary = summarizeProgress(journal, null);
    expect(summary).toContain("prepare");
    expect(summary).toContain("0055_deployment_identity.sql");
  });

  test("after replacement began it says which services are new versus old, and never claims a gone service still serves", async () => {
    const paths = freshPaths();
    const p = plan({ images: { api: { source: SOURCE_B, digest: DIGEST_B }, worker: { source: SOURCE_A, digest: DIGEST_A } } });
    const writer = openJournal(paths, { kind: "fresh-start", reason: "none" }, p);
    await writer.beginPhase("replace", null, expectations());
    await writer.commitPhase(outcome({ servicesReplaced: { api: DIGEST_B } }));
    const summary = summarizeProgress(readJournal(paths), null);
    expect(summary).toContain(`service api: new, on ${DIGEST_B}`);
    expect(summary).toContain("service worker: not replaced");
    expect(summary).toContain("no guarantee it survived");
  });

  test("with neither a journal nor a receipt it says so rather than inventing a phase", () => {
    expect(summarizeProgress(null, null)).toContain("no recorded run");
  });
});

// ── Wiring helpers the boot uses (issue #1026, W2) ──────────────────────────
describe("closeOpenJournal — the operator stopped the deployment (`smoke:down`)", () => {
  test("closes an open journal with its reason, and a later run fresh-starts instead of refusing over the stop", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    expect(closeOpenJournal(paths, "stopped by bun smoke:down")).toBe(true);
    const closed = readJournal(paths)!;
    expect(closed.closedAt).not.toBeNull();
    expect(closed.closeReport).toBe("stopped by bun smoke:down");
    // The services it expected are gone; a closed journal is a fresh start, not a refusal.
    expect(decideResume(closed, journal.planId, expectations({ services: {} })).kind).toBe("fresh-start");
  });

  test("no journal, or an already-closed one, is a no-op", async () => {
    const paths = freshPaths();
    expect(closeOpenJournal(paths, "x")).toBe(false);
    await journalWithCommittedPreparation(paths);
    closeOpenJournal(paths, "first");
    expect(closeOpenJournal(paths, "second")).toBe(false);
    expect(readJournal(paths)!.closeReport).toBe("first");
  });

  test("red control: without the close, the same stop IS a refusal — the expected services are missing", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    expect(decideResume(readJournal(paths), journal.planId, afterPreparation({ services: {} })).kind).toBe("refuse");
  });
});

describe("expectationMismatch — the schema check a run makes the moment the database can be asked", () => {
  test("the journal's own projected ledger passes; another migration is named", async () => {
    const paths = freshPaths();
    const journal = await journalWithCommittedPreparation(paths);
    const expected = projectExpectations(journal)!;
    expect(expectationMismatch(expected, { ledger: afterPreparation().ledger, manifestHash: "manifest-bbb" })).toBeNull();
    const extra = expectationMismatch(expected, { ledger: [...afterPreparation().ledger, "0099_someone_else.sql"], manifestHash: "manifest-bbb" });
    expect(extra).toContain("0099_someone_else.sql");
    expect(expectationMismatch(expected, { ledger: afterPreparation().ledger, manifestHash: "manifest-zzz" })).toContain("manifest-zzz");
  });
});

// Criterion 38's risk, checked: a roster fingerprint taken from a SPOOFED key
// would move the plan id when a `--spoof-keys` phase writes its generation
// (§6.4 step 1), and the rerun would supersede its own journal. The plan id
// excludes "any state a journaled phase itself changes" (§1.2), so the boot
// fingerprints the credential file's keys and never reads the generation.
describe("the boot's roster fingerprints come from the credential file, never a spoof generation (criterion 38)", () => {
  const smokeMain = readFileSync(join(import.meta.dir, "..", "..", "lib", "smoke-main.ts"), "utf8");

  test("hashing a spoofed key instead WOULD change the plan id — the risk is real", () => {
    const fromFile = plan();
    const spoofed = plan({
      roster: { ...fromFile.roster, agents: fromFile.roster.agents.map((m) => (m.name === "athena" ? { ...m, keyFingerprint: publicKeyFingerprint("spoofed-generation-key") } : m)) },
    });
    expect(computePlanId(spoofed)).not.toBe(computePlanId(fromFile));
  });

  test("smoke-main fingerprints loadCredentialFile's keys and reads no spoof generation", () => {
    expect(smokeMain).toContain("loadCredentialFile(resolution.path)");
    expect(smokeMain).toContain("publicKeyFingerprint(entry.publicKeyB64)");
    for (const forbidden of ["readSpoofGeneration(", "effectiveRoster(", "spoofGenerationFile"]) {
      expect({ forbidden, present: smokeMain.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  test("and it hashes each image's SOURCE: the boot's plan carries source identities with no digest", () => {
    expect(smokeMain).toContain("resolveSourceIdentities(gitRunner(repoRoot), buildContextsFor(");
    expect(smokeMain).toMatch(/\[service, \{ source, digest: null \}\]/);
  });
});
