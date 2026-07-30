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
import { authorTake } from "../../lib/committee/inference.ts";

let fakeDir = "";
let fakeOpenCode = "";
let callsDir = "";
const originalBin = process.env.OPENCODE_BIN;

interface RecordedCall {
  argv: string[];
  dataHome: string;
  stateHome: string;
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
  }),
);
console.log(JSON.stringify({ type: "text", part: { type: "text", text: "**REGIME**\\n- one\\nSTANCE: bullish | CONFIDENCE: 0.8" } }));
`);
  await chmod(fakeOpenCode, 0o755);
  process.env.OPENCODE_BIN = fakeOpenCode;
});

afterAll(async () => {
  if (originalBin === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = originalBin;
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
