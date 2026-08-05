// Hermetic guards on HOW swarm inference invokes the opencode CLI: the argv
// it passes and the strict environment allowlist. Each invocation now runs
// inside its member's own container/home, so the retired host-side temp-XDG
// collision workaround has no place in this module. A
// fake `opencode` on OPENCODE_BIN records one JSON file per invocation, so both
// properties are asserted without a model call, a network hop, or a real
// opencode binary.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorTake, InferenceFailure, opencodeSpawnEnv, parseStanceFromBody } from "../../lib/swarm/inference.ts";
import { assertAuthoredTakes } from "../../lib/swarm/session.ts";
import { resolveAgentModel } from "../../lib/model-registry.ts";
import { ZEN_KEY_ENV } from "../../lib/opencode-key.ts";

let fakeDir = "";
let fakeOpenCode = "";
let callsDir = "";
const originalBin = process.env.OPENCODE_BIN;
const originalAdminToken = process.env.ADMIN_TOKEN;
const originalAnalyticsToken = process.env.ANALYTICS_TOKEN;
const originalMemberToken = process.env.RM_MEMBER_TOKEN;
const originalPassphrase = process.env.RMPC_COMMITTEE_IDENTITY_PASSPHRASE;

interface RecordedCall {
  argv: string[];
  // The subprocess's own view of the credentials the harness holds — asserted
  // EMPTY below (issue #361 Phase 0: scrubbed spawn env, not an inherit).
  adminToken: string;
  analyticsToken: string;
  memberToken: string;
  passphrase: string;
  envKeys: string[];
}

async function recordedCalls(): Promise<RecordedCall[]> {
  const files = await readdir(callsDir);
  return await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(callsDir, f), "utf8")) as RecordedCall),
  );
}

beforeAll(async () => {
  fakeDir = await mkdtemp(join(tmpdir(), "swarm-inference-opencode-"));
  fakeOpenCode = join(fakeDir, "opencode");
  callsDir = join(fakeDir, "calls");
  await mkdir(callsDir, { recursive: true });
  await writeFile(fakeOpenCode, `#!/usr/bin/env bun
await Bun.write(
  ${JSON.stringify(callsDir)} + "/" + crypto.randomUUID() + ".json",
  JSON.stringify({
    argv: Bun.argv.slice(2),
    adminToken: process.env.ADMIN_TOKEN ?? "",
    analyticsToken: process.env.ANALYTICS_TOKEN ?? "",
    memberToken: process.env.RM_MEMBER_TOKEN ?? "",
    passphrase: process.env.RMPC_COMMITTEE_IDENTITY_PASSPHRASE ?? "",
    envKeys: Object.keys(process.env).sort(),
  }),
);
console.log(JSON.stringify({ type: "text", part: { type: "text", text: "**REGIME**\\n- one\\nSTANCE: bullish | CONFIDENCE: 0.8" } }));
`);
  await chmod(fakeOpenCode, 0o755);
  process.env.OPENCODE_BIN = fakeOpenCode;
  // Planted stack credentials: the scrub test below proves neither ever
  // reaches the spawned model subprocess.
  process.env.ADMIN_TOKEN = "planted-admin-token";
  process.env.ANALYTICS_TOKEN = "planted-analytics-token";
  process.env.RM_MEMBER_TOKEN = "tok_planted_member_secret";
  process.env.RMPC_COMMITTEE_IDENTITY_PASSPHRASE = "planted-keystore-passphrase";
});

afterAll(async () => {
  if (originalBin === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = originalBin;
  if (originalAdminToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = originalAdminToken;
  if (originalAnalyticsToken === undefined) delete process.env.ANALYTICS_TOKEN;
  else process.env.ANALYTICS_TOKEN = originalAnalyticsToken;
  if (originalMemberToken === undefined) delete process.env.RM_MEMBER_TOKEN;
  else process.env.RM_MEMBER_TOKEN = originalMemberToken;
  if (originalPassphrase === undefined) delete process.env.RMPC_COMMITTEE_IDENTITY_PASSPHRASE;
  else process.env.RMPC_COMMITTEE_IDENTITY_PASSPHRASE = originalPassphrase;
  await rm(fakeDir, { recursive: true, force: true });
});

const persona = (memberId: string) => ({ memberId, name: memberId, lens: "risk", bias: 0 });

test("swarm inference passes OpenCode's real auto-approval flag", async () => {
  const take = await authorTake(persona("member-1"), { composite: 0.5 }, "subject-1");

  const calls = await recordedCalls();
  expect(take.stance).toBe("bullish");
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.argv).toContain("--auto");
    expect(call.argv).not.toContain("--dangerously-skip-permissions");
  }
});

// ── Issue #361 Phase 0: the spawn environment is an ALLOWLIST, not an inherit ─
describe("opencode subprocess env is scrubbed down to the single model credential", () => {
  test("a spawned call sees only the model key, never product or member credentials", async () => {
    const before = (await recordedCalls()).length;
    await authorTake(persona("scrub-check"), { composite: 0.5 }, "subject-1");
    const fresh = (await recordedCalls()).slice(before);
    expect(fresh.length).toBe(1);
    // The member-client process REALLY held all four (planted in beforeAll) …
    expect(process.env.ADMIN_TOKEN).toBe("planted-admin-token");
    expect(process.env.ANALYTICS_TOKEN).toBe("planted-analytics-token");
    // … and the subprocess saw neither.
    expect(fresh[0].adminToken).toBe("");
    expect(fresh[0].analyticsToken).toBe("");
    expect(fresh[0].memberToken).toBe("");
    expect(fresh[0].passphrase).toBe("");
    expect(fresh[0].envKeys).not.toContain("ADMIN_TOKEN");
    expect(fresh[0].envKeys).not.toContain("ANALYTICS_TOKEN");
    expect(fresh[0].envKeys).not.toContain("RM_MEMBER_TOKEN");
    expect(fresh[0].envKeys).not.toContain("RMPC_COMMITTEE_IDENTITY_PASSPHRASE");
    // Everything present is on the documented allowlist. XDG overrides are
    // intentionally absent: isolation comes from the member container HOME.
    const allowed = new Set(["PATH", "HOME", "TERM", "OPENCODE_API_KEY"]);
    for (const k of fresh[0].envKeys) expect(allowed.has(k)).toBe(true);
    expect(fresh[0].envKeys).not.toContain("XDG_DATA_HOME");
    expect(fresh[0].envKeys).not.toContain("XDG_STATE_HOME");
  });

  test("opencodeSpawnEnv is a pure allowlist over its input", () => {
    const env = opencodeSpawnEnv({
      PATH: "/bin",
      HOME: "/home/x",
      TERM: "xterm",
      OPENCODE_API_KEY: "sk-test",
      ADMIN_TOKEN: "nope",
      ANALYTICS_TOKEN: "nope",
      DATABASE_URL: "nope",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/x", TERM: "xterm", OPENCODE_API_KEY: "sk-test" });
    // No key configured → no credential entry at all (not an empty string).
    expect(Object.keys(opencodeSpawnEnv({ PATH: "/bin" }))).toEqual(["PATH"]);
  });
});

// ── Issue #361 Phase 0: a malformed control line is a LOUD ABSENCE, never a
// fabricated neutral/0.5 stance ─────────────────────────────────────────────
describe("parseStanceFromBody throws on a missing or malformed control line", () => {
  test("parses a well-formed trailing control line and strips it from the body", () => {
    const parsed = parseStanceFromBody("**REGIME**\n- x\nSTANCE: bullish | CONFIDENCE: 0.8");
    expect(parsed).toEqual({ stance: "bullish", confidence: 0.8, body: "**REGIME**\n- x" });
  });

  test("throws when the control line is absent (no neutral/0.5 default)", () => {
    expect(() => parseStanceFromBody("**REGIME**\n- prose with no control line")).toThrow(
      /missing its trailing "STANCE:.*rendered ABSENT/,
    );
  });

  test("throws on a stance outside the contract vocabulary", () => {
    expect(() => parseStanceFromBody("body\nSTANCE: mega | CONFIDENCE: 0.9")).toThrow(
      /stance 'mega'.*rendered ABSENT/,
    );
  });

  test("throws on unparseable confidence", () => {
    expect(() => parseStanceFromBody("body\nSTANCE: neutral | CONFIDENCE: .")).toThrow(
      /unparseable confidence/,
    );
  });

  test("clamps out-of-range confidence into [0,1] without fabricating a stance", () => {
    expect(parseStanceFromBody("body\nSTANCE: cautious | CONFIDENCE: 1.7").confidence).toBe(1);
  });
});

// ── Issue #527: a funded-inference failure names its own cause ───────────────
// Driven through the REAL Bun.spawn path with a fake `opencode` on
// OPENCODE_BIN: each case emits one pinned `--format json` error event on
// stdout and exits 1, exactly as the pinned CLI does, so what is asserted is
// what authorTake actually throws — not a pure function standing in for it.
//
// The incident: on 2026-08-05 the Zen workspace exhausted its pay-as-you-go
// balance (the failure mode scripts/lib/opencode-key.ts already documents:
// "an unfunded key returns CreditsError: Insufficient balance on every paid
// model while still authenticating fine"). Nothing parsed the event, so six
// e2e runs reported a generic provider-side maybe and three reruns were spent
// on a fault marked isRetryable:false.
describe("a funded-inference failure carries a machine-readable kind", () => {
  const PLANTED_KEY = "sk-planted-zen-key-abcdef123456";
  const PLANTED_WORKSPACE = "wrk_01KYMNGS96XZEV3RQ994DFJSVT";
  const PLANTED_ACCOUNT = "acc_01HZZZACCOUNTID9999";
  const originalKey = process.env[ZEN_KEY_ENV];
  let caseDir = "";

  // A fake CLI that prints `stdout` verbatim and exits `code`. One script per
  // case: the spawn env is a strict allowlist, so a payload cannot be handed to
  // the child through the environment.
  async function withFakeOpencode<T>(stdout: string, code: number, fn: () => Promise<T>): Promise<T> {
    const bin = join(caseDir, `oc-${crypto.randomUUID()}`);
    await writeFile(bin, `#!/usr/bin/env bun\nconsole.log(${JSON.stringify(stdout)});\nprocess.exit(${code});\n`);
    await chmod(bin, 0o755);
    const previous = process.env.OPENCODE_BIN;
    process.env.OPENCODE_BIN = bin;
    try {
      return await fn();
    } finally {
      process.env.OPENCODE_BIN = previous;
    }
  }

  const errorEvent = (data: Record<string, unknown>) =>
    JSON.stringify({ type: "error", timestamp: 1785943114380, sessionID: "ses_fake", error: { name: "APIError", data } });
  const zenBody = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });
  const creditsEvent = errorEvent({
    message: `Insufficient balance. Manage your billing here: https://opencode.ai/workspace/${PLANTED_WORKSPACE}/billing`,
    statusCode: 401,
    isRetryable: false,
    responseBody: zenBody("CreditsError", "Insufficient balance."),
    metadata: { url: "https://opencode.ai/zen/v1/chat/completions" },
  });

  // The failure authorTake rejected with, or a loud test failure if it resolved.
  async function failureOf(stdout: string, code = 1): Promise<InferenceFailure> {
    return await withFakeOpencode(stdout, code, async () => {
      try {
        const take = await authorTake(persona("kind-check"), { composite: 0.5 }, "subject-1");
        throw new Error(`authorTake RESOLVED where it must reject — it returned a take: ${JSON.stringify(take)}`);
      } catch (err) {
        if (!(err instanceof InferenceFailure)) throw err;
        return err;
      }
    });
  }

  beforeAll(async () => {
    caseDir = await mkdtemp(join(tmpdir(), "swarm-inference-kinds-"));
    process.env[ZEN_KEY_ENV] = PLANTED_KEY;
  });

  afterAll(async () => {
    if (originalKey === undefined) delete process.env[ZEN_KEY_ENV];
    else process.env[ZEN_KEY_ENV] = originalKey;
    await rm(caseDir, { recursive: true, force: true });
  });

  test("Zen's typed CreditsError rejects with exhausted-credits, the provider, the model and a top-up action", async () => {
    const failure = await failureOf(creditsEvent);
    expect(failure.kind).toBe("exhausted-credits");
    expect(failure.provider).toBe("opencode");
    expect(failure.model).toBe(resolveAgentModel());
    expect(failure.providerType).toBe("CreditsError");
    expect(failure.statusCode).toBe(401);
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("cause=exhausted-credits");
    expect(failure.message).toContain("top it up in the provider's billing settings");
    expect(failure.message).toContain("NOT an application regression");
    // No fabricated take, and no claim that a key's mere presence means funded.
    expect(failure.message).toContain("NO template fallback");
    expect(failure.message).not.toContain("(funded)");
  });

  test.each([
    ["AuthError", errorEvent({ message: "Invalid API key.", statusCode: 401, isRetryable: false, responseBody: zenBody("AuthError", "Invalid API key.") }), "auth-rejected"],
    ["MonthlyLimitError", errorEvent({ message: "Monthly limit reached.", statusCode: 429, responseBody: zenBody("MonthlyLimitError", "Monthly limit reached.") }), "quota-limited"],
    ["UserLimitError", errorEvent({ message: "User limit reached.", statusCode: 429, responseBody: zenBody("UserLimitError", "User limit reached.") }), "quota-limited"],
    ["untyped throttle", errorEvent({ message: "Too many requests", statusCode: 429, isRetryable: true }), "throttled"],
    ["provider 5xx", errorEvent({ message: "Bad gateway", statusCode: 502 }), "provider-failure"],
    ["error event with no CreditsError", errorEvent({ message: "something went sideways" }), "unclassified-error"],
    ["malformed JSON", "{not json at all", "empty-response"],
    ["truly empty response", "", "empty-response"],
  ] as const)("%s fails loudly as %s — never as exhausted credits", async (_label, stdout, expected) => {
    const failure = await failureOf(stdout);
    expect(failure.kind).toBe(expected);
    expect(failure.kind).not.toBe("exhausted-credits");
    expect(failure.message).not.toContain("top it up in the provider's billing settings");
    expect(failure.model).toBe(resolveAgentModel());
  });

  test("the red control: HTTP 401 plus the words 'Insufficient balance' under AuthError is NOT credit exhaustion", async () => {
    const failure = await failureOf(errorEvent({
      message: `Insufficient balance. Manage your billing here: https://opencode.ai/workspace/${PLANTED_WORKSPACE}/billing`,
      statusCode: 401,
      isRetryable: false,
      responseBody: zenBody("AuthError", "Invalid API key."),
    }));
    expect(failure.kind).toBe("auth-rejected");
    expect(failure.message).toContain("check that the configured key is valid");
  });

  test("no credential, workspace id, account id or workspace URL reaches the thrown diagnostic", async () => {
    const failure = await failureOf(errorEvent({
      message: `Insufficient balance for ${PLANTED_ACCOUNT} (key ${PLANTED_KEY}). ` +
        `Manage your billing here: https://opencode.ai/workspace/${PLANTED_WORKSPACE}/billing`,
      statusCode: 401,
      isRetryable: false,
      responseBody: zenBody("CreditsError", "Insufficient balance."),
      metadata: { url: `https://opencode.ai/workspace/${PLANTED_WORKSPACE}/billing` },
    }));
    // The key really was configured for this call …
    expect(process.env[ZEN_KEY_ENV]).toBe(PLANTED_KEY);
    // … and none of it survives into anything a log or PR comment will carry.
    for (const secret of [PLANTED_KEY, PLANTED_WORKSPACE, PLANTED_ACCOUNT, "/workspace/"]) {
      expect(failure.message).not.toContain(secret);
    }
    // What a maintainer needs is all still there.
    expect(failure.kind).toBe("exhausted-credits");
    expect(failure.provider).toBe("opencode");
    expect(failure.model).toBe(resolveAgentModel());
    expect(failure.message).toContain("CreditsError");
    expect(failure.message).toContain("billing settings");
  });

  // The PR #513-shaped path, hermetically: every funded author fails, the
  // session has nothing to publish, and the readiness gate stays RED — with the
  // real cause already named on each member's failure line.
  test("three failed authors fabricate nothing, name the cause, and leave assertAuthoredTakes red", async () => {
    const failures = await withFakeOpencode(creditsEvent, 1, async () =>
      await Promise.all(["athena", "boreas", "cygnus"].map(async (id) => {
        try {
          await authorTake(persona(id), { composite: 0.5 }, "subject-1");
          return null;
        } catch (err) {
          return err as InferenceFailure;
        }
      })));
    expect(failures.every((f) => f instanceof InferenceFailure && f.kind === "exhausted-credits")).toBe(true);
    for (const f of failures) expect(f!.message).toContain("top it up in the provider's billing settings");
    // No take row exists for a member whose author threw, so the gate that
    // guards a zero-take session must still reject — unchanged by this work.
    expect(() => assertAuthoredTakes("[session 1]", [], [])).toThrow(/no authored takes to assert on/);
  });
});
