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
// touched — no lock, no write, no receipt. The fenced database writes behind
// the injected effects are proven against a real database in
// backend/tests/automation-token-provision.test.ts (provision-tokens) and
// backend/tests/target-lock.test.ts (the identity write in the fence).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PROD_INIT_COMMANDS, ProdInitRefusal, runProdInit, type ProdInitDeps } from "../../prod-init.ts";
import { instancePaths, writeStackState } from "../../lib/smoke-state.ts";
import { PROVISION_TOKENS_COMMAND, tokenReuseRefusal } from "../../lib/smoke-secret.ts";
import type { TargetState } from "../../../backend/src/db/target-lock.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HOME_ENV = { host: "db.example.internal", port: "25060", database: "defaultdb", sslmode: "require", rm_readonly: "ro-pw", RM_ENV: "prod" };
const OWNER_PASSWORD = "typed-owner-secret-7f3a";

interface Recorder {
  calls: string[];
  deps: ProdInitDeps;
  root: string;
}

/** A full set of fake effects that records every call, with overrides. */
function fake(over: Partial<ProdInitDeps> & { identity?: TargetState["identity"]; answer?: string; password?: string } = {}): Recorder {
  const root = mkdtempSync(join(tmpdir(), "rm-prod-init-"));
  roots.push(root);
  const calls: string[] = [];
  const deps: ProdInitDeps = {
    env: {},
    homeEnv: HOME_ENV,
    homeEnvPath: "/home/operator/.env",
    stateRoot: root,
    isTerminal: true,
    promptSecret: async () => {
      calls.push("promptSecret");
      return over.password ?? OWNER_PASSWORD;
    },
    promptLine: async () => {
      calls.push("promptLine");
      return over.answer ?? "y";
    },
    readTarget: async () => {
      calls.push("readTarget");
      return { identity: over.identity ?? "production", ledger: ["0001_init.sql"], manifestHash: "sha256:x" };
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
      calls.push(`setIdentity:${options.rmEnv}:${options.confirmed}`);
      return { before: "absent", row: { kind: "production", writtenAt: "2026-09-25T00:00:00.000Z", writtenBy: "rm_owner", note: options.note } };
    },
    provisionTokens: async (options) => {
      calls.push(`provisionTokens:${options.instance}`);
      return { holders: ["system-scheduler", "analytics-producer", "operator"], files: options.tokenFiles };
    },
    rotateKey: async (_api, _token, memberId) => {
      calls.push(`rotateKey:${memberId}`);
      return { status: 200, token: `tok_${memberId}_new` };
    },
    now: () => new Date("2026-09-25T12:00:00.000Z"),
    log: () => {},
    ...over,
  };
  return { calls, deps, root };
}

/** The mutating effects: none of these may run when a gate refuses. */
const MUTATIONS = /^(acquireLock|setIdentity|provisionTokens|rotateKey|release)/;

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
    await refused(["enable-schedules"], fake(), /unknown command.*set-identity\|provision-tokens\|rebind-members/);
  });

  test("RM_ENV unset refuses each command", async () => {
    for (const command of PROD_INIT_COMMANDS) {
      const { RM_ENV: _rm, ...homeEnv } = HOME_ENV;
      await refused([command], fake({ homeEnv }), /RM_ENV is unset/);
    }
  });

  test("RM_ENV=stage refuses set-identity and rebind-members: production initialization is prod's", async () => {
    for (const command of ["set-identity", "rebind-members"]) {
      await refused([command], fake({ env: { RM_ENV: "stage" } }), /requires RM_ENV=prod/);
    }
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
    await refused(["set-identity"], fake({ identity: "rehearsal" }), /enrolled `rehearsal`/);
    await refused(["provision-tokens"], fake({ identity: "missing" }), /enrolled `production`; it reads `missing`/);
    await refused(["rebind-members"], fake({ identity: "rehearsal" }), /enrolled `production`/);
  });

  test("stage policy never touches production data: provision-tokens under stage refuses a production target", async () => {
    await refused(["provision-tokens"], fake({ env: { RM_ENV: "stage" }, identity: "production" }), /enrolled `rehearsal`.*reads `production`/);
    await refused(["provision-tokens"], fake({ env: { RM_ENV: "stage" }, identity: "missing" }), /reads `missing`/);
  });

  test("no terminal refuses: the password and the y are never read from a pipe", async () => {
    const rec = fake({ isTerminal: false });
    await refused(["set-identity"], rec, /needs an operator at a terminal/);
    expect(rec.calls).not.toContain("promptSecret");
  });

  test("an empty rm_owner password refuses", async () => {
    await refused(["provision-tokens"], fake({ password: "" }), /no rm_owner password was typed/);
  });

  test("any answer but a literal y refuses", async () => {
    for (const answer of ["", "n", "Y", "yes", "y please"]) {
      await refused(["set-identity"], fake({ answer }), /not y/);
    }
  });

  test("the target lock held elsewhere refuses, naming the holder", async () => {
    const rec = fake({ acquireLock: async () => ({ refusal: "target lock held by smoke plan c0ffee on host-a (pid 42)" }) });
    await refused(["set-identity"], rec, /held by smoke plan c0ffee/);
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
    expect(text).not.toContain("ro-pw");
    return JSON.parse(text);
  }

  test("set-identity: typed owner, y, lock, the fenced write, release, receipt — in that order", async () => {
    const rec = fake({ identity: "missing" });
    const receipt = await runProdInit(["set-identity"], rec.deps);
    expect(rec.calls).toEqual(["readTarget", "promptSecret", "promptLine", "acquireLock:prod-init:set-identity", "setIdentity:prod:true", "release"]);
    expect(receipt.outcome).toBe("completed");
    expect(receipt.identityBefore).toBe("missing");
    expect(receipt.instance).toBe("rm_prod");
    expect(receipt.detail).toMatchObject({ before: "absent", after: "production" });
    const onDisk = receiptOf(rec, "set-identity");
    expect(onDisk).toMatchObject({ command: "set-identity", outcome: "completed", target: "rm_readonly@db.example.internal:25060/defaultdb" });
  });

  test("provision-tokens under prod provisions the instance's three holders inside the lock", async () => {
    const rec = fake();
    const receipt = await runProdInit(["provision-tokens"], rec.deps);
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
    await expect(runProdInit(["set-identity"], rec.deps)).rejects.toThrow("relation does not exist");
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
    // The one provisioning call in the boot is for a database it created.
    const provision = smokeMain.indexOf("runTokenProvisioning(");
    expect(smokeMain.lastIndexOf('(mode === "blank" || mode === "dump")', provision)).toBeGreaterThan(-1);
  });

  test("the explicit command provisions a rehearsal target under RM_ENV=stage, receipted", async () => {
    const rec = fake({ env: { RM_ENV: "stage" }, identity: "rehearsal" });
    const receipt = await runProdInit(["provision-tokens", "--instance", "rm_remote_rehearsal"], rec.deps);
    expect(rec.calls).toContain("provisionTokens:rm_remote_rehearsal");
    expect(receipt).toMatchObject({ rmEnv: "stage", instance: "rm_remote_rehearsal", identityBefore: "rehearsal", outcome: "completed" });
    expect(existsSync(join(rec.root, "rm_remote_rehearsal", "prod-init"))).toBe(true);
  });
});

describe("rebind-members writes each returned bearer back into its credential.json entry", () => {
  const entry = (memberId: string, publicKeyB64: string) => ({
    memberId,
    publicKeyB64,
    privateJwk: { kty: "OKP", crv: "Ed25519", x: publicKeyB64, d: `${publicKeyB64}-d` },
    bearer: `tok_${memberId}_fixture`,
    modelKey: `model-${memberId}`,
  });

  function setup(rec: Recorder): { credentialPath: string } {
    const paths = instancePaths(rec.root, "rm_prod", { create: true });
    mkdirSync(paths.tokenDirs.operator, { recursive: true, mode: 0o700 });
    writeFileSync(paths.tokenFiles.operator, "rmat_operator\n", { mode: 0o600 });
    const credentialPath = join(rec.root, "credential.json");
    writeFileSync(
      credentialPath,
      JSON.stringify({ agents: { athena: entry("m-athena", "pkA"), boreas: entry("m-boreas", "pkB") }, judges: { themis: entry("m-themis", "pkT") } }, null, 2),
      { mode: 0o600 },
    );
    chmodSync(credentialPath, 0o600);
    return { credentialPath };
  }

  test("one member at a time, through rotate-key with the entry's key, each bearer written to its own entry", async () => {
    const rec = fake({ env: { RM_ENV: "prod" } });
    const { credentialPath } = setup(rec);
    const receipt = await runProdInit(["rebind-members", "--credentials", credentialPath, "--api", "http://127.0.0.1:9"], rec.deps);
    expect(rec.calls.filter((c) => c.startsWith("rotateKey"))).toEqual(["rotateKey:m-athena", "rotateKey:m-boreas", "rotateKey:m-themis"]);
    // No rm_owner for an API write (§4.3).
    expect(rec.calls).not.toContain("promptSecret");
    const after = JSON.parse(readFileSync(credentialPath, "utf8"));
    expect(after.agents.athena.bearer).toBe("tok_m-athena_new");
    expect(after.agents.boreas.bearer).toBe("tok_m-boreas_new");
    expect(after.judges.themis.bearer).toBe("tok_m-themis_new");
    // Every other field of every entry is exactly what it was.
    expect(after.agents.athena).toMatchObject({ memberId: "m-athena", publicKeyB64: "pkA", modelKey: "model-m-athena" });
    expect(after.judges.themis.privateJwk).toEqual(entry("m-themis", "pkT").privateJwk);
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
    await expect(runProdInit(["rebind-members", "--credentials", credentialPath, "--api", "http://127.0.0.1:9"], rec.deps)).rejects.toThrow("409");
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
    await runProdInit(["rebind-members", "--credentials", credentialPath], rec.deps);
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
