// PRODUCTION INITIALIZATION — issue #1026 criteria 42 and 43, smoke spec §9.1
// steps 4-6, §4.3, §5.
//
//   §4.3: production initialization is "a set of separate commands allowed on
//   `production`, each gated by `RM_ENV=prod`, `y/n`, a receipt and the target
//   lock. A command that writes the database directly also requires a typed
//   `rm_owner`; the key rotation of §9.1 step 6 goes through the admin API with
//   the operator's admin service token instead. None is reachable through
//   `bun smoke`."
//   §5: "A remote rehearsal target uses tokens provisioned for that enrolled
//   target by the same procedure, run explicitly."
//
// Every gate is driven through the real runProdInit with its effects injected:
// no database, no Docker, no network (this file runs in the unit tier with
// Docker unreachable, criterion 151). Each refusal asserts that NOTHING was
// touched — no lock, no write, no receipt. The real effects behind the
// injection — set-identity's fenced read, provision-tokens' fenced writes and
// token files, rebind-members' rotate-key calls — run as real processes against
// a real database and a real api in
// scripts/tests/integration/prod-init-runtime.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PROD_INIT_COMMANDS, ProdInitRefusal, runProdInit, type ProdInitDeps } from "../../prod-init.ts";
import { instancePaths, writeStackState } from "../../lib/smoke-state.ts";
import { PROVISION_TOKENS_COMMAND, tokenReuseRefusal } from "../../lib/smoke-secret.ts";
import type { TargetState } from "../../../backend/src/db/target-lock.ts";
import { SUPPORTED_RELEASES } from "../../../backend/src/db/supported-releases.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const OWNER_PASSWORD = "home-env-owner-secret-7f3a";
const DOADMIN_PASSWORD = "home-env-doadmin-secret-91c2";
const HOME_ENV: Record<string, string> = { host: "db.example.internal", port: "25060", database: "defaultdb", sslmode: "require", rm_readonly: "ro-pw", rm_owner: OWNER_PASSWORD, doadmin: DOADMIN_PASSWORD, RM_ENV: "prod" };
/** The target ~/.env resolves to, exactly as D61's --confirm-target must name it. */
const TARGET = "db.example.internal:25060/defaultdb";
const CONFIRM = ["--confirm-target", TARGET] as const;

interface Recorder {
  calls: string[];
  deps: ProdInitDeps;
  root: string;
}

/** The supported baseline's ledger: the pre-identity state enable-owner-login accepts (D61). */
const BASELINE_LEDGER = [...SUPPORTED_RELEASES[0]!.migrations];

/** A full set of fake effects that records every call, with overrides. */

function fake(over: Partial<ProdInitDeps> & { identity?: TargetState["identity"]; canLogin?: boolean; ledger?: readonly string[] } = {}): Recorder {
  const root = mkdtempSync(join(tmpdir(), "rm-prod-init-"));
  roots.push(root);
  const calls: string[] = [];
  const deps: ProdInitDeps = {
    env: {},
    homeEnv: HOME_ENV,
    homeEnvPath: "/home/operator/.env",
    stateRoot: root,
    readTarget: async () => {
      calls.push("readTarget");
      return { identity: over.identity ?? "production", ledger: over.ledger ?? BASELINE_LEDGER, manifestHash: "sha256:x" };
    },
    acquireLock: async (_url, holder) => {
      calls.push(`acquireLock:${holder.tool}`);
      return {
        lock: { key: 1n as never, holder: { ...holder, acquiredAt: "now" }, backendPid: 7, stillHeld: async () => true },
        release: async () => {
          calls.push("release");
        },
      };
    },
    setIdentity: async (options) => {
      const kind = options.expected ?? "production";
      calls.push(`setIdentity:${options.rmEnv}:${options.confirmed}${kind === "production" ? "" : `:${kind}`}`);
      return {
        before: kind,
        row: { kind, writtenAt: "2026-09-25T00:00:00.000Z", writtenBy: "rm_owner", note: "bun run migrate: the identity-first pass" },
        written: false,
      };
    },
    provisionTokens: async (options) => {
      calls.push(`provisionTokens:${options.instance}`);
      return { holders: ["system-scheduler", "analytics-producer", "operator"], files: options.tokenFiles };
    },
    rotateKey: async (_api, _token, memberId) => {
      calls.push(`rotateKey:${memberId}`);
      return { status: 200, token: `tok_${memberId}_new` };
    },
    enableOwnerLogin: async (options) => {
      calls.push(`enableOwnerLogin:${new URL(options.doadminUrl).username}:${new URL(options.ownerUrl).username}`);
      const before = over.canLogin ?? false;
      return { rolcanloginBefore: before, altered: !before, verified: true };
    },
    now: () => new Date("2026-09-25T12:00:00.000Z"),
    log: () => {},
    ...over,
  };
  return { calls, deps, root };
}

/** The mutating effects: none of these may run when a gate refuses. */
const MUTATIONS = /^(acquireLock|setIdentity|provisionTokens|rotateKey|enableOwnerLogin|release)/;

async function refused(argv: string[], rec: Recorder, message: string | RegExp): Promise<void> {
  let error: unknown;
  try {
    await runProdInit(argv, rec.deps);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ProdInitRefusal);
  expect((error as Error).message).toMatch(message);
  expect((error as Error).message).toContain("Nothing was changed");
  expect(rec.calls.filter((c) => MUTATIONS.test(c))).toEqual([]);
  // No receipt: a refusal changed nothing, so there is nothing to record.
  const receiptDir = join(rec.root, "rm_prod", "prod-init");
  expect(existsSync(receiptDir) ? readdirSync(receiptDir) : []).toEqual([]);
}

describe("every command refuses before anything changes", () => {
  test("an unknown command refuses with the usage", async () => {
    await refused(["enable-schedules"], fake(), /unknown command.*enable-owner-login\|set-identity\|provision-tokens\|rebind-members/);
  });

  test("RM_ENV unset refuses each command", async () => {
    for (const command of PROD_INIT_COMMANDS) {
      const { RM_ENV: _rm, ...homeEnv } = HOME_ENV;
      await refused([command], fake({ homeEnv }), /RM_ENV is unset/);
    }
  });

  test("D61: RM_ENV=stage holds set-identity to a `rehearsal` target; a production one refuses", async () => {
    await refused(["set-identity", ...CONFIRM], fake({ env: { RM_ENV: "stage" }, identity: "production" }), /RM_ENV=stage requires .* enrolled `rehearsal`; it reads `production`/);
  });

  test("RM_ENV=stage lets rebind-members past the policy gate (R3.8/B10, owner 2026-10-05) and then holds it to a `rehearsal` target", async () => {
    // Past the policy: the next gate is the target's enrollment, which a
    // production-enrolled target fails under stage policy (§4.3).
    await refused(["rebind-members"], fake({ env: { RM_ENV: "stage" }, identity: "production" }), /requires .* enrolled `rehearsal`/);
  });

  test("any other RM_ENV refuses provision-tokens", async () => {
    await refused(["provision-tokens"], fake({ env: { RM_ENV: "smoke" } }), /RM_ENV is "smoke"/);
  });

  test("no remote connection in ~/.env refuses, naming the file", async () => {
    await refused(["set-identity"], fake({ homeEnv: undefined, env: { RM_ENV: "prod" } }), /\/home\/operator\/\.env/);
    const { rm_readonly: _ro, ...noReader } = HOME_ENV;
    await refused(["provision-tokens"], fake({ homeEnv: noReader }), /rm_readonly/);
  });

  test("set-identity refuses a rehearsal database; the others refuse a target not enrolled production", async () => {
    await refused(["set-identity"], fake({ identity: "rehearsal" }), /enrolled `production`; it reads `rehearsal`/);
    // D55 (9): the first production migrate writes `production` with the
    // table, so set-identity never writes a missing row. It refuses before any
    // prompt, naming the migrate. (Red control for the pre-D55 (9) command,
    // which accepted a table with no row and wrote `production` into it.)
    const missing = fake({ identity: "missing" });
    await refused(["set-identity"], missing, /reads `missing`.*writes `production` in the transaction that creates deployment_identity.*bun run migrate/);
    expect(missing.calls).toEqual(["readTarget"]);
    await refused(["provision-tokens"], fake({ identity: "missing" }), /enrolled `production`; it reads `missing`/);
    await refused(["rebind-members"], fake({ identity: "rehearsal" }), /enrolled `production`/);
  });

  test("stage policy never touches production data: provision-tokens under stage refuses a production target", async () => {
    await refused(["provision-tokens"], fake({ env: { RM_ENV: "stage" }, identity: "production" }), /enrolled `rehearsal`.*reads `production`/);
    await refused(["provision-tokens"], fake({ env: { RM_ENV: "stage" }, identity: "missing" }), /reads `missing`/);
  });

  test("the target lock held elsewhere refuses, naming the holder", async () => {
    const rec = fake({ acquireLock: async () => ({ refusal: "target lock held by smoke plan c0ffee on host-a (pid 42)" }) });
    await refused(["set-identity", ...CONFIRM], rec, /held by smoke plan c0ffee/);
  });

  test("rebind-members refuses without the operator token, naming how it is provisioned", async () => {
    await refused(["rebind-members"], fake(), /operator service token file .* is missing/);
  });
});

describe("each command writes inside the lock and records a receipt, never a secret", () => {
  function receiptOf(rec: Recorder, command: string): Record<string, unknown> {
    const dir = join(rec.root, "rm_prod", "prod-init");
    const [file] = readdirSync(dir).filter((f) => f.startsWith(command));
    expect(file).toBeDefined();
    const text = readFileSync(join(dir, file!), "utf8");
    expect(text).not.toContain(OWNER_PASSWORD);
    expect(text).not.toContain(DOADMIN_PASSWORD);
    expect(text).not.toContain("ro-pw");
    return JSON.parse(text);
  }

  test("set-identity: ~/.env owner, --confirm-target, lock, the fenced read, release, receipt — in that order, reporting the row unchanged", async () => {
    const rec = fake({ identity: "production" });
    const receipt = await runProdInit(["set-identity", ...CONFIRM], rec.deps);
    expect(rec.calls).toEqual(["readTarget", "acquireLock:prod-init:set-identity", "setIdentity:prod:true", "release"]);
    expect(receipt.outcome).toBe("completed");
    expect(receipt.identityBefore).toBe("production");
    expect(receipt.instance).toBe("rm_prod");
    expect(receipt.detail).toMatchObject({ before: "production", after: "production", written: false });
    const onDisk = receiptOf(rec, "set-identity");
    expect(onDisk).toMatchObject({ command: "set-identity", outcome: "completed", target: "rm_readonly@db.example.internal:25060/defaultdb" });
  });

  test("provision-tokens under prod provisions the instance's three holders inside the lock", async () => {
    const rec = fake();
    const receipt = await runProdInit(["provision-tokens", ...CONFIRM], rec.deps);
    expect(rec.calls).toContain("provisionTokens:rm_prod");
    expect(rec.calls.indexOf("provisionTokens:rm_prod")).toBeGreaterThan(rec.calls.indexOf("acquireLock:prod-init:provision-tokens"));
    expect(rec.calls.at(-1)).toBe("release");
    expect(receipt.detail).toMatchObject({ holders: ["system-scheduler", "analytics-producer", "operator"] });
    receiptOf(rec, "provision-tokens");
  });

  test("a failure after the lock is recorded as failed, the lock released, and the error rethrown", async () => {
    const rec = fake({
      setIdentity: async () => {
        throw new Error("deployment_identity cannot be read (relation does not exist)");
      },
    });
    await expect(runProdInit(["set-identity", ...CONFIRM], rec.deps)).rejects.toThrow("relation does not exist");
    expect(rec.calls.at(-1)).toBe("release");
    expect(receiptOf(rec, "set-identity")).toMatchObject({ outcome: "failed", error: expect.stringContaining("relation does not exist") });
  });
});

describe("a remote rehearsal target's tokens come only from the explicit command (criterion 43)", () => {
  test("a remote boot with no token files refuses, names the command, and provisions nothing", async () => {
    // The boot's own check (smoke-main.ts, before any mutation): it never
    // mints for a remote target, so absent files are a refusal naming the
    // explicit command — and no provisioning effect exists on that path.
    const root = mkdtempSync(join(tmpdir(), "rm-remote-rehearsal-"));
    roots.push(root);
    const paths = instancePaths(root, "rm_local_remote", { create: true });
    const refusal = tokenReuseRefusal(paths, "remote");
    expect(refusal).toContain(PROVISION_TOKENS_COMMAND);
    for (const holder of ["system-scheduler", "analytics-producer", "operator"] as const) {
      expect(existsSync(paths.tokenFiles[holder])).toBe(false);
    }
    const smokeMain = readFileSync(join(REPO, "scripts/lib/smoke-main.ts"), "utf8");
    const remoteCheck = smokeMain.indexOf('tokenReuseRefusal(paths, remote ? "remote" : "volume")');
    expect(remoteCheck).toBeGreaterThan(-1);
    // …and it runs before the plan's first mutation.
    expect(remoteCheck).toBeLessThan(smokeMain.indexOf("async function main("));
    // The one provisioning call in the boot is for a database it created or
    // restored (`mintsServiceTokens`: blank, or dump without --reuse).
    const provision = smokeMain.indexOf("runTokenProvisioning(");
    expect(smokeMain.lastIndexOf("if (mintsServiceTokens(mode, reuseTwin)", provision)).toBeGreaterThan(-1);
  });

  test("the explicit command provisions a rehearsal target under RM_ENV=stage, receipted", async () => {
    const rec = fake({ env: { RM_ENV: "stage" }, identity: "rehearsal" });
    const receipt = await runProdInit(["provision-tokens", "--instance", "rm_remote_rehearsal", ...CONFIRM], rec.deps);
    expect(rec.calls).toContain("provisionTokens:rm_remote_rehearsal");
    expect(receipt).toMatchObject({ rmEnv: "stage", instance: "rm_remote_rehearsal", identityBefore: "rehearsal", outcome: "completed" });
    expect(existsSync(join(rec.root, "rm_remote_rehearsal", "prod-init"))).toBe(true);
  });
});

/** A credential.json with three members and an operator token for instance rm_prod. */
const credentialEntry = (memberId: string, publicKeyB64: string) => ({
  memberId,
  publicKeyB64,
  privateJwk: { kty: "OKP", crv: "Ed25519", x: publicKeyB64, d: `${publicKeyB64}-d` },
  bearer: `tok_${memberId}_fixture`,
  modelKey: `model-${memberId}`,
});

function setup(rec: Recorder, instance = "rm_prod"): { credentialPath: string } {
  const paths = instancePaths(rec.root, instance, { create: true });
  mkdirSync(paths.tokenDirs.operator, { recursive: true, mode: 0o700 });
  writeFileSync(paths.tokenFiles.operator, "rmat_operator\n", { mode: 0o600 });
  const credentialPath = join(rec.root, "credential.json");
  writeFileSync(
    credentialPath,
    JSON.stringify({ agents: { athena: credentialEntry("m-athena", "pkA"), boreas: credentialEntry("m-boreas", "pkB") }, judges: { themis: credentialEntry("m-themis", "pkT") } }, null, 2),
    { mode: 0o600 },
  );
  chmodSync(credentialPath, 0o600);
  return { credentialPath };
}


describe("rebind-members writes each returned bearer back into its credential.json entry", () => {
  test("one member at a time, through rotate-key with the entry's key, each bearer written to its own entry", async () => {
    const rec = fake({ env: { RM_ENV: "prod" } });
    const { credentialPath } = setup(rec);
    const receipt = await runProdInit(["rebind-members", "--credentials", credentialPath, "--api", "http://127.0.0.1:9", ...CONFIRM], rec.deps);
    expect(rec.calls.filter((c) => c.startsWith("rotateKey"))).toEqual(["rotateKey:m-athena", "rotateKey:m-boreas", "rotateKey:m-themis"]);
    const after = JSON.parse(readFileSync(credentialPath, "utf8"));
    expect(after.agents.athena.bearer).toBe("tok_m-athena_new");
    expect(after.agents.boreas.bearer).toBe("tok_m-boreas_new");
    expect(after.judges.themis.bearer).toBe("tok_m-themis_new");
    // Every other field of every entry is exactly what it was.
    expect(after.agents.athena).toMatchObject({ memberId: "m-athena", publicKeyB64: "pkA", modelKey: "model-m-athena" });
    expect(after.judges.themis.privateJwk).toEqual(credentialEntry("m-themis", "pkT").privateJwk);
    // Atomic: the rename left no temporary beside it, and the mode is kept.
    expect(readdirSync(dirname(credentialPath)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect((await Bun.file(credentialPath).stat()).mode & 0o777).toBe(0o600);
    expect(receipt.detail).toMatchObject({ rebound: [{ name: "athena" }, { name: "boreas" }, { name: "themis" }] });
    expect(JSON.stringify(receipt)).not.toContain("tok_m-athena_new");
  });

  test("a refused rotation stops there: earlier entries keep their new bearer, later ones are untouched, the receipt says failed", async () => {
    const rec = fake({
      env: { RM_ENV: "prod" },
      rotateKey: async (_api, _token, memberId) => {
        rec.calls.push(`rotateKey:${memberId}`);
        return memberId === "m-boreas" ? { status: 409, error: "no on-file public key" } : { status: 200, token: `tok_${memberId}_new` };
      },
    });
    const { credentialPath } = setup(rec);
    await expect(runProdInit(["rebind-members", "--credentials", credentialPath, "--api", "http://127.0.0.1:9", ...CONFIRM], rec.deps)).rejects.toThrow("409");
    const after = JSON.parse(readFileSync(credentialPath, "utf8"));
    expect(after.agents.athena.bearer).toBe("tok_m-athena_new");
    expect(after.agents.boreas.bearer).toBe("tok_m-boreas_fixture");
    expect(after.judges.themis.bearer).toBe("tok_m-themis_fixture");
    const dir = join(rec.root, "rm_prod", "prod-init");
    const receipt = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8"));
    expect(receipt).toMatchObject({ outcome: "failed", detail: { rebound: [{ name: "athena" }] } });
  });

  test("the api address defaults to the instance's recorded stack", async () => {
    const rec = fake({ env: { RM_ENV: "prod" } });
    const { credentialPath } = setup(rec);
    const paths = instancePaths(rec.root, "rm_prod");
    writeStackState(paths, {
      instance: "rm_prod", project: "p", apiPort: 41234, webPort: 41235, pgPort: null, stage: true, envClass: "local", envHash: "h",
      composeFiles: "docker-compose.yml", db: "external", externalPg: true, databaseUrl: "", dbUser: "", dbPassword: "", dbName: "",
      logFile: paths.logFile, createdAt: "now",
    });
    const seen: string[] = [];
    rec.deps.rotateKey = async (api, _t, memberId) => {
      seen.push(api);
      return { status: 200, token: `tok_${memberId}_new` };
    };
    await runProdInit(["rebind-members", "--credentials", credentialPath, ...CONFIRM], rec.deps);
    expect(new Set(seen)).toEqual(new Set(["http://127.0.0.1:41234"]));
  });
});

// ---------------------------------------------------------------------------
// "None is reachable through `bun smoke`" (§4.3): smoke-main's and
// scripts/stack's import graphs never reach a production-initialization module.
// ---------------------------------------------------------------------------
const PROD_INIT_MODULES = [resolve(REPO, "scripts/prod-init.ts"), resolve(REPO, "backend/scripts/set-identity.ts")];

/** Every module a file reaches through RELATIVE static and dynamic imports. */
function importGraph(entry: string, readText: (file: string) => string | null = (f) => (existsSync(f) ? readFileSync(f, "utf8") : null)): Set<string> {
  const seen = new Set<string>();
  const stack = [resolve(entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    const text = readText(file);
    if (text === null) continue;
    seen.add(file);
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      stack.push(resolve(dirname(file), m[1]!));
    }
  }
  return seen;
}

describe("production initialization is unreachable from `bun smoke` and scripts/stack", () => {
  test("smoke-main's import graph reaches no prod-init module", () => {
    const graph = importGraph(join(REPO, "scripts/lib/smoke-main.ts"));
    expect(graph.size).toBeGreaterThan(20); // the walk is real
    expect(PROD_INIT_MODULES.filter((m) => graph.has(m))).toEqual([]);
  });

  test("scripts/stack's import graph reaches no prod-init module", () => {
    const graph = importGraph(join(REPO, "scripts/stack/index.ts"));
    expect(graph.size).toBeGreaterThan(5);
    expect(PROD_INIT_MODULES.filter((m) => graph.has(m))).toEqual([]);
  });

  test("red control: a planted import is found", () => {
    const planted = resolve(REPO, "scripts/lib/__planted__.ts");
    const graph = importGraph(planted, (file) => (file === planted ? 'import { runProdInit } from "../prod-init.ts";\n' : existsSync(file) ? readFileSync(file, "utf8") : null));
    expect(graph.has(resolve(REPO, "scripts/prod-init.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R3.8: under RM_ENV=stage, rebind-members addresses the instance's own
// smoke-owned twin through its generated rm_readonly, never ~/.env (which on a
// stage host names production's read replica). Under prod the twin is ignored.
// ---------------------------------------------------------------------------
describe("rebind-members targets the instance's own twin under RM_ENV=stage", () => {
  function twin(rec: Recorder, instance: string): void {
    const paths = instancePaths(rec.root, instance, { create: true });
    writeStackState(paths, {
      instance, project: "p", apiPort: 41234, webPort: 41235, pgPort: null, stage: true, envClass: "local", envHash: "h",
      composeFiles: "docker-compose.yml", db: "smoke-twin", externalPg: true,
      databaseUrl: "postgres://restore_check:rc-pw@172.17.0.1:32823/rm_restore_check", dbUser: "", dbPassword: "", dbName: "",
      logFile: paths.logFile, createdAt: "now",
    });
    writeFileSync(paths.rolePasswordsFile, JSON.stringify({ rm_owner: "o", rm_app: "a", rm_worker: "w", rm_readonly: "twin-ro-pw" }), { mode: 0o600 });
  }

  test("the twin's generated rm_readonly is the target, and the receipt names it", async () => {
    const rec = fake({ env: { RM_ENV: "stage" }, identity: "rehearsal" });
    const { credentialPath } = setup(rec, "rehearse");
    twin(rec, "rehearse");
    const targets: string[] = [];
    const inner = rec.deps.readTarget;
    rec.deps.readTarget = async (url) => {
      targets.push(url);
      return inner(url);
    };
    const receipt = await runProdInit(["rebind-members", "--instance", "rehearse", "--credentials", credentialPath], rec.deps);
    expect(targets).toEqual(["postgres://rm_readonly:twin-ro-pw@172.17.0.1:32823/rm_restore_check"]);
    expect(receipt.target).toBe("rm_readonly@172.17.0.1:32823/rm_restore_check");
  });

  test("a stage host with no ~/.env still reaches its twin", async () => {
    const rec = fake({ env: { RM_ENV: "stage" }, identity: "rehearsal", homeEnv: undefined });
    const { credentialPath } = setup(rec, "rehearse");
    twin(rec, "rehearse");
    const receipt = await runProdInit(["rebind-members", "--instance", "rehearse", "--credentials", credentialPath], rec.deps);
    expect(receipt.outcome).toBe("completed");
  });

  test("under RM_ENV=prod the twin is ignored: ~/.env's connection is the target", async () => {
    const rec = fake({ env: { RM_ENV: "prod" } });
    const { credentialPath } = setup(rec);
    twin(rec, "rm_prod");
    const targets: string[] = [];
    const inner = rec.deps.readTarget;
    rec.deps.readTarget = async (url) => {
      targets.push(url);
      return inner(url);
    };
    const receipt = await runProdInit(["rebind-members", "--instance", "rm_prod", "--credentials", credentialPath, ...CONFIRM], rec.deps);
    expect(targets[0]).toContain("@db.example.internal:25060/defaultdb");
    expect(receipt.target).toBe("rm_readonly@db.example.internal:25060/defaultdb");
  });

  test("provision-tokens under stage never takes the twin route: a twin's tokens are smoke's phase", async () => {
    const rec = fake({ env: { RM_ENV: "stage" }, identity: "production" });
    twin(rec, "rehearse");
    await refused(["provision-tokens", "--instance", "rehearse"], rec, /enrolled `rehearsal`.*reads `production`/);
  });
});

// ---------------------------------------------------------------------------
// D61: no prompt. rm_owner (and doadmin, for enable-owner-login only) come from
// ~/.env; the `y` is --confirm-target, which must name exactly the target
// ~/.env resolves to. Neither password reaches a receipt, a log or a message.
// ---------------------------------------------------------------------------
/** Run, capturing every log line and the thrown message. */
async function runCaptured(argv: string[], rec: Recorder): Promise<{ logs: string[]; error: Error | undefined }> {
  const logs: string[] = [];
  rec.deps.log = (line) => logs.push(line);
  let error: Error | undefined;
  try {
    await runProdInit(argv, rec.deps);
  } catch (e) {
    error = e as Error;
  }
  return { logs, error };
}

/** No file under the state root, no log line and no message holds either password. */
function assertNoSecret(rec: Recorder, logs: string[], error: Error | undefined): void {
  const texts = [...logs, error?.message ?? ""];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else texts.push(readFileSync(full, "utf8"));
    }
  };
  walk(rec.root);
  expect(texts.length).toBeGreaterThan(1);
  for (const text of texts) {
    expect(text).not.toContain(OWNER_PASSWORD);
    expect(text).not.toContain(DOADMIN_PASSWORD);
  }
}

describe("D61: rm_owner comes from ~/.env, never a prompt", () => {
  test("a missing rm_owner line refuses set-identity and provision-tokens, naming rm_owner and the file", async () => {
    const { rm_owner: _o, ...noOwner } = HOME_ENV;
    for (const command of ["set-identity", "provision-tokens"]) {
      await refused([command, ...CONFIRM], fake({ homeEnv: noOwner }), /\/home\/operator\/\.env has no rm_owner line/);
    }
  });

  test("red control: with the line present the same run proceeds and hands the ~/.env password to the write", async () => {
    const seen: string[] = [];
    const rec = fake({
      setIdentity: async (options) => {
        seen.push(decodeURIComponent(new URL(options.ownerUrl).password));
        return { before: "production", row: { kind: "production", writtenAt: "x", writtenBy: "rm_owner", note: null }, written: false };
      },
    });
    await runProdInit(["set-identity", ...CONFIRM], rec.deps);
    expect(seen).toEqual([OWNER_PASSWORD]);
  });

  test("the deps have no prompt and no terminal check left", () => {
    const keys = Object.keys(fake().deps);
    for (const gone of ["isTerminal", "promptSecret", "promptLine"]) expect(keys).not.toContain(gone);
    const source = readFileSync(join(REPO, "scripts/prod-init.ts"), "utf8");
    expect(source).not.toMatch(/hiddenPrompt|isTTY|readline/);
  });
});

describe("D61: --confirm-target replaces the y", () => {
  test("a missing --confirm-target refuses each ~/.env command, naming the resolved target", async () => {
    await refused(["set-identity"], fake(), new RegExp(`no --confirm-target was given.*${TARGET}`));
    await refused(["provision-tokens"], fake(), /no --confirm-target/);
    await refused(["enable-owner-login"], fake({ identity: "missing" }), /no --confirm-target/);
    const rec = fake();
    const { credentialPath } = setup(rec);
    await refused(["rebind-members", "--credentials", credentialPath, "--api", "http://127.0.0.1:9"], rec, /no --confirm-target/);
  });

  test("a wrong --confirm-target refuses and prints both, normalizing nothing", async () => {
    for (const wrong of ["db.example.internal:25060/otherdb", "DB.example.internal:25060/defaultdb", "db.example.internal/defaultdb", ` ${TARGET}`, ""]) {
      await refused(
        ["set-identity", "--confirm-target", wrong],
        fake(),
        /does not name the target.*Resolved target: "db\.example\.internal:25060\/defaultdb"/,
      );
    }
    const rec = fake();
    const { error } = await runCaptured(["provision-tokens", "--confirm-target", "elsewhere:5432/db"], rec);
    expect(error?.message).toContain('"elsewhere:5432/db"');
    expect(error?.message).toContain(`"${TARGET}"`);
  });

  test("the --confirm-target=<value> spelling is accepted; a matching flag proceeds", async () => {
    const receipt = await runProdInit(["set-identity", `--confirm-target=${TARGET}`], fake().deps);
    expect(receipt.outcome).toBe("completed");
  });

  test("a ~/.env without a port line resolves to port 5432, and only that string confirms it", async () => {
    const { port: _p, ...noPort } = HOME_ENV;
    await refused(["set-identity", ...CONFIRM], fake({ homeEnv: noPort }), /Resolved target: "db\.example\.internal:5432\/defaultdb"/);
    const receipt = await runProdInit(["set-identity", "--confirm-target", "db.example.internal:5432/defaultdb"], fake({ homeEnv: noPort }).deps);
    expect(receipt.outcome).toBe("completed");
  });

  test("rebind-members against the instance's own local twin needs no flag", async () => {
    const rec = fake({ env: { RM_ENV: "stage" }, identity: "rehearsal" });
    const { credentialPath } = setup(rec, "rehearse");
    const paths = instancePaths(rec.root, "rehearse", { create: true });
    writeStackState(paths, {
      instance: "rehearse", project: "p", apiPort: 41234, webPort: 41235, pgPort: null, stage: true, envClass: "local", envHash: "h",
      composeFiles: "docker-compose.yml", db: "smoke-twin", externalPg: true,
      databaseUrl: "postgres://restore_check:rc-pw@172.17.0.1:32823/rm_restore_check", dbUser: "", dbPassword: "", dbName: "",
      logFile: paths.logFile, createdAt: "now",
    });
    writeFileSync(paths.rolePasswordsFile, JSON.stringify({ rm_owner: "o", rm_app: "a", rm_worker: "w", rm_readonly: "twin-ro-pw" }), { mode: 0o600 });
    const receipt = await runProdInit(["rebind-members", "--instance", "rehearse", "--credentials", credentialPath], rec.deps);
    expect(receipt.outcome).toBe("completed");
  });
});

describe("D61: enable-owner-login", () => {
  test("NOLOGIN: the doadmin and rm_owner URLs from ~/.env reach the dep inside the lock; ALTER then verify, receipted", async () => {
    const rec = fake({ identity: "missing", canLogin: false });
    const urls: { doadmin: string; owner: string }[] = [];
    const inner = rec.deps.enableOwnerLogin;
    rec.deps.enableOwnerLogin = async (options) => {
      urls.push({ doadmin: decodeURIComponent(new URL(options.doadminUrl).password), owner: decodeURIComponent(new URL(options.ownerUrl).password) });
      return inner(options);
    };
    const { logs, error } = await runCaptured(["enable-owner-login", ...CONFIRM], rec);
    expect(error).toBeUndefined();
    expect(rec.calls).toEqual(["readTarget", "acquireLock:prod-init:enable-owner-login", "enableOwnerLogin:doadmin:rm_owner", "release"]);
    expect(urls).toEqual([{ doadmin: DOADMIN_PASSWORD, owner: OWNER_PASSWORD }]);
    const dir = join(rec.root, "rm_prod", "prod-init");
    const receipt = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("enable-owner-login"))!), "utf8"));
    expect(receipt).toMatchObject({ command: "enable-owner-login", outcome: "completed", identityBefore: "missing", detail: { rolcanloginBefore: false, altered: true, verified: true } });
    assertNoSecret(rec, logs, error);
  });

  test("already LOGIN: verify only, the receipt says no ALTER ran", async () => {
    const rec = fake({ identity: "production", canLogin: true });
    const receipt = await runProdInit(["enable-owner-login", ...CONFIRM], rec.deps);
    expect(receipt.detail).toEqual({ rolcanloginBefore: true, altered: false, verified: true });
  });

  test("a wrong --confirm-target refuses: no lock, no dep call, no receipt", async () => {
    await refused(["enable-owner-login", "--confirm-target", "db.example.internal:25060/postgres"], fake({ identity: "missing" }), /Resolved target/);
  });

  test("a missing doadmin line refuses, naming doadmin and the file", async () => {
    const { doadmin: _d, ...noDoadmin } = HOME_ENV;
    await refused(["enable-owner-login", ...CONFIRM], fake({ homeEnv: noDoadmin, identity: "missing" }), /\/home\/operator\/\.env has no doadmin line/);
  });

  test("a missing rm_owner line refuses it too: the login it proves is the ~/.env one", async () => {
    const { rm_owner: _o, ...noOwner } = HOME_ENV;
    await refused(["enable-owner-login", ...CONFIRM], fake({ homeEnv: noOwner, identity: "missing" }), /has no rm_owner line/);
  });

  test("the identity gate refuses the cross: prod against rehearsal, stage against production", async () => {
    await refused(["enable-owner-login", ...CONFIRM], fake({ identity: "rehearsal" }), /RM_ENV=prod requires .* enrolled `production`; it reads `rehearsal`/);
    await refused(["enable-owner-login", ...CONFIRM], fake({ env: { RM_ENV: "stage" }, identity: "production" }), /RM_ENV=stage requires .* enrolled `rehearsal`; it reads `production`/);
    // Red controls: stage against a pre-identity or rehearsal target proceeds.
    for (const identity of ["missing", "rehearsal"] as const) {
      const receipt = await runProdInit(["enable-owner-login", ...CONFIRM], fake({ env: { RM_ENV: "stage" }, identity }).deps);
      expect(receipt.outcome).toBe("completed");
    }
  });

  test("a driver error carrying a password is scrubbed from the receipt and the rethrown message", async () => {
    const rec = fake({
      identity: "missing",
      enableOwnerLogin: async () => {
        throw new Error(`connect failed for postgres://doadmin:${DOADMIN_PASSWORD}@h/db and rm_owner ${encodeURIComponent(OWNER_PASSWORD)}`);
      },
    });
    const { logs, error } = await runCaptured(["enable-owner-login", ...CONFIRM], rec);
    expect(error?.message).toContain("connect failed");
    assertNoSecret(rec, logs, error);
  });
});

describe("D61: every command runs prod against `production` and stage against `rehearsal`, never crosswise", () => {
  /** Run `command` to its end with a matching flag; rebind-members gets its credential file and token. */
  async function run(command: (typeof PROD_INIT_COMMANDS)[number], rec: Recorder, rmEnv: "prod" | "stage"): Promise<{ error?: Error }> {
    // Under stage the instance is named (§1.1); under prod it is rm_prod.
    const instance = rmEnv === "prod" ? "rm_prod" : "rm_stage_rehearsal";
    const argv: string[] = [command, ...CONFIRM, ...(rmEnv === "stage" ? ["--instance", instance] : [])];
    if (command === "rebind-members") {
      const { credentialPath } = setup(rec, instance);
      argv.push("--credentials", credentialPath, "--api", "http://127.0.0.1:9");
    }
    try {
      await runProdInit(argv, rec.deps);
      return {};
    } catch (error) {
      return { error: error as Error };
    }
  }

  for (const command of PROD_INIT_COMMANDS) {
    test(`${command}: prod + production and stage + rehearsal proceed`, async () => {
      for (const [rmEnv, identity] of [["prod", "production"], ["stage", "rehearsal"]] as const) {
        const rec = fake({ env: { RM_ENV: rmEnv }, identity, homeEnv: { ...HOME_ENV, RM_ENV: rmEnv } });
        const { error } = await run(command, rec, rmEnv);
        expect({ command, rmEnv, error: error?.message }).toEqual({ command, rmEnv, error: undefined });
      }
    });

    test(`${command}: RED CONTROL — prod + rehearsal and stage + production refuse before anything changes`, async () => {
      for (const [rmEnv, identity] of [["prod", "rehearsal"], ["stage", "production"]] as const) {
        const rec = fake({ env: { RM_ENV: rmEnv }, identity, homeEnv: { ...HOME_ENV, RM_ENV: rmEnv } });
        const { error } = await run(command, rec, rmEnv);
        expect(error).toBeInstanceOf(ProdInitRefusal);
        expect(error?.message).toContain("never crosswise");
        expect(rec.calls.filter((c) => MUTATIONS.test(c))).toEqual([]);
      }
    });
  }

  test("set-identity under stage reads and reports `rehearsal`, receipted", async () => {
    const rec = fake({ env: { RM_ENV: "stage" }, identity: "rehearsal" });
    const receipt = await runProdInit(["set-identity", ...CONFIRM], rec.deps);
    expect(rec.calls).toContain("setIdentity:stage:true:rehearsal");
    expect(receipt.detail).toMatchObject({ before: "rehearsal", after: "rehearsal", written: false });
  });

  test("enable-owner-login on a pre-identity target proceeds under either policy when the ledger is a supported baseline", async () => {
    for (const rmEnv of ["prod", "stage"] as const) {
      const receipt = await runProdInit(["enable-owner-login", ...CONFIRM], fake({ env: { RM_ENV: rmEnv }, identity: "missing" }).deps);
      expect(receipt.outcome).toBe("completed");
    }
  });

  test("enable-owner-login on a pre-identity target: RED CONTROL — a ledger that is not a supported baseline refuses under either policy", async () => {
    for (const rmEnv of ["prod", "stage"] as const) {
      for (const ledger of [["0001_init.sql"], BASELINE_LEDGER.slice(0, -1), [...BASELINE_LEDGER, "0081_deployment_identity.sql"]]) {
        await refused(["enable-owner-login", ...CONFIRM], fake({ env: { RM_ENV: rmEnv }, identity: "missing", ledger }), /requires a ledger exactly equal to a supported baseline/);
      }
    }
  });

  test("the other commands never accept a pre-identity target, whatever its ledger", async () => {
    for (const command of ["set-identity", "provision-tokens"] as const) {
      for (const rmEnv of ["prod", "stage"] as const) {
        await refused([command, ...CONFIRM], fake({ env: { RM_ENV: rmEnv }, identity: "missing" }), /reads `missing`/);
      }
    }
  });
});

describe("D61: doadmin is read by enable-owner-login and nothing else", () => {
  test("set-identity, provision-tokens and rebind-members run with no doadmin line, and no dep of theirs sees a doadmin URL", async () => {
    const { doadmin: _d, ...noDoadmin } = HOME_ENV;
    const seen: string[] = [];
    const record = (url: string): void => {
      seen.push(new URL(url).username);
    };
    const rec = fake({ homeEnv: noDoadmin });
    const innerSet = rec.deps.setIdentity;
    rec.deps.setIdentity = async (o) => {
      record(o.ownerUrl);
      return innerSet(o);
    };
    const innerProvision = rec.deps.provisionTokens;
    rec.deps.provisionTokens = async (o) => {
      record(o.ownerUrl);
      record(o.readerUrl);
      return innerProvision(o);
    };
    const innerRead = rec.deps.readTarget;
    rec.deps.readTarget = async (url) => {
      record(url);
      return innerRead(url);
    };
    const innerLock = rec.deps.acquireLock;
    rec.deps.acquireLock = async (url, holder, expected) => {
      record(url);
      return innerLock(url, holder, expected);
    };
    await runProdInit(["set-identity", ...CONFIRM], rec.deps);
    await runProdInit(["provision-tokens", ...CONFIRM], rec.deps);
    const { credentialPath } = setup(rec);
    await runProdInit(["rebind-members", "--credentials", credentialPath, "--api", "http://127.0.0.1:9", ...CONFIRM], rec.deps);
    expect(seen.length).toBeGreaterThan(5);
    expect(seen).not.toContain("doadmin");
    expect(rec.calls.filter((c) => c.startsWith("enableOwnerLogin"))).toEqual([]);
  });

  test("the source reads doadmin in exactly two lines, both inside the enable-owner-login branch", () => {
    const source = readFileSync(join(REPO, "scripts/prod-init.ts"), "utf8");
    const lines = source.split("\n").filter((l) => /"doadmin"/.test(l) && !l.trim().startsWith("//") && !l.includes("as const"));
    expect(lines.map((l) => l.trim())).toEqual([
      'requirePrivilegedPassword(homeEnv, "doadmin", deps.homeEnvPath);',
      'doadminUrl = urlForRole(homeEnv!, "doadmin");',
    ]);
    const branch = source.indexOf('if (command === "enable-owner-login") {\n        requirePrivilegedPassword(homeEnv, "doadmin"');
    expect(branch).toBeGreaterThan(-1);
  });

  test("no successful command logs or receipts either password", async () => {
    for (const command of ["set-identity", "provision-tokens"]) {
      const rec = fake();
      const { logs, error } = await runCaptured([command, ...CONFIRM], rec);
      expect(error).toBeUndefined();
      assertNoSecret(rec, logs, error);
    }
  });
});
