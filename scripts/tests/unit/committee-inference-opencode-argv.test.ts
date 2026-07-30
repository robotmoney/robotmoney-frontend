import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorTake } from "../../lib/committee/inference.ts";

let fakeDir = "";
let fakeOpenCode = "";
let capturedArgv = "";
const originalBin = process.env.OPENCODE_BIN;

beforeAll(async () => {
  fakeDir = await mkdtemp(join(tmpdir(), "committee-inference-opencode-"));
  fakeOpenCode = join(fakeDir, "opencode");
  capturedArgv = join(fakeDir, "argv.json");
  await writeFile(fakeOpenCode, `#!/usr/bin/env bun
await Bun.write(${JSON.stringify(capturedArgv)}, JSON.stringify(Bun.argv.slice(2)));
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

test("committee inference passes OpenCode's real host-side auto-approval flag", async () => {
  const take = await authorTake(
    { memberId: "member-1", name: "Ada", lens: "risk", bias: 0 },
    { composite: 0.5 },
    "subject-1",
  );

  const argv = JSON.parse(await readFile(capturedArgv, "utf8")) as string[];
  expect(take.stance).toBe("bullish");
  expect(argv).toContain("--auto");
  expect(argv).not.toContain("--dangerously-skip-permissions");
});
