// Hermetic guards on HOW committee inference invokes the opencode CLI: the argv
// it passes, and the per-call environment isolation that keeps concurrent
// members from racing each other inside the CLI's own local state database. A
// fake `opencode` on OPENCODE_BIN records one JSON file per invocation, so both
// properties are asserted without a model call, a network hop, or a real
// opencode binary.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorTake, opencodeSpawnEnv, parseStanceFromBody } from "../../lib/committee/inference.ts";

let fakeDir = "";
let fakeOpenCode = "";
let callsDir = "";
const originalBin = process.env.OPENCODE_BIN;
const originalAdminToken = process.env.ADMIN_TOKEN;
const originalAnalyticsToken = process.env.ANALYTICS_TOKEN;

interface RecordedCall {
  argv: string[];
  dataHome: string;
  stateHome: string;
  // The subprocess's own view of the credentials the harness holds — asserted
  // EMPTY below (issue #361 Phase 0: scrubbed spawn env, not an inherit).
  adminToken: string;
  analyticsToken: string;
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
    dataHome: process.env.XDG_DATA_HOME ?? "",
    stateHome: process.env.XDG_STATE_HOME ?? "",
    adminToken: process.env.ADMIN_TOKEN ?? "",
    analyticsToken: process.env.ANALYTICS_TOKEN ?? "",
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
});

afterAll(async () => {
  if (originalBin === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = originalBin;
  if (originalAdminToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = originalAdminToken;
  if (originalAnalyticsToken === undefined) delete process.env.ANALYTICS_TOKEN;
  else process.env.ANALYTICS_TOKEN = originalAnalyticsToken;
  await rm(fakeDir, { recursive: true, force: true });
});

const persona = (memberId: string) => ({ memberId, name: memberId, lens: "risk", bias: 0 });

test("committee inference passes OpenCode's real host-side auto-approval flag", async () => {
  const take = await authorTake(persona("member-1"), { composite: 0.5 }, "subject-1");

  const calls = await recordedCalls();
  expect(take.stance).toBe("bullish");
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.argv).toContain("--auto");
    expect(call.argv).not.toContain("--dangerously-skip-permissions");
  }
});

// Regression guard for the e2e "demo readiness gate" failing on one or two
// committee members per run. Members author concurrently, and every one of
// those `opencode run` processes migrates the CLI's SQLite state database under
// $XDG_DATA_HOME/opencode on first use. Sharing one data home means exactly one
// concurrent cold start wins the `CREATE TABLE workspace` race and the rest die
// with "Unexpected error" BEFORE any model call — reported here as an empty
// transcript, blaming the model for a collision in our own process management.
describe("each opencode call gets its own XDG state, so concurrent members cannot race", () => {
  test("concurrent authorTake calls never share a data home", async () => {
    const before = (await recordedCalls()).length;
    await Promise.all([
      authorTake(persona("athena"), { composite: 0.5 }, "woon"),
      authorTake(persona("boreas"), { composite: 0.5 }, "woon"),
      authorTake(persona("cygnus"), { composite: 0.5 }, "woon"),
    ]);

    const fresh = (await recordedCalls()).slice(before);
    expect(fresh.length).toBe(3);
    for (const call of fresh) {
      expect(call.dataHome).not.toBe("");
      expect(call.stateHome).not.toBe("");
      // Scratch state, not the runner's real home: nothing here outlives the call.
      expect(call.dataHome).toContain("committee-opencode-home-");
      // ...and it is cleaned up once the call returns.
      expect(existsSync(call.dataHome)).toBe(false);
    }
    expect(new Set(fresh.map((c) => c.dataHome)).size).toBe(3);
    expect(new Set(fresh.map((c) => c.stateHome)).size).toBe(3);
  });
});

// ── Issue #361 Phase 0: the spawn environment is an ALLOWLIST, not an inherit ─
describe("opencode subprocess env is scrubbed down to the single model credential", () => {
  test("a spawned call never sees ADMIN_TOKEN / ANALYTICS_TOKEN even when the harness holds them", async () => {
    const before = (await recordedCalls()).length;
    await authorTake(persona("scrub-check"), { composite: 0.5 }, "subject-1");
    const fresh = (await recordedCalls()).slice(before);
    expect(fresh.length).toBe(1);
    // The harness process REALLY held both (planted in beforeAll) …
    expect(process.env.ADMIN_TOKEN).toBe("planted-admin-token");
    expect(process.env.ANALYTICS_TOKEN).toBe("planted-analytics-token");
    // … and the subprocess saw neither.
    expect(fresh[0].adminToken).toBe("");
    expect(fresh[0].analyticsToken).toBe("");
    expect(fresh[0].envKeys).not.toContain("ADMIN_TOKEN");
    expect(fresh[0].envKeys).not.toContain("ANALYTICS_TOKEN");
    // Everything present is on the documented allowlist (+ the per-call XDG
    // isolation dirs).
    const allowed = new Set(["PATH", "HOME", "TERM", "OPENCODE_API_KEY", "XDG_DATA_HOME", "XDG_STATE_HOME"]);
    for (const k of fresh[0].envKeys) expect(allowed.has(k)).toBe(true);
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
