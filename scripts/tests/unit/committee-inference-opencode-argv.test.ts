// Hermetic guards on HOW committee inference invokes the opencode CLI: the argv
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
import { authorTake, opencodeSpawnEnv, parseStanceFromBody } from "../../lib/committee/inference.ts";

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
  fakeDir = await mkdtemp(join(tmpdir(), "committee-inference-opencode-"));
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

test("committee inference passes OpenCode's real auto-approval flag", async () => {
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
