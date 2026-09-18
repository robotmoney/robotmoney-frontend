// PROJECT FUSION RC2 — a dropped allocation is an unlucky SAMPLE, not a
// fabricated one.
//
// `authorTake` already re-samples a take that omits a required prose section
// (TAKE_SECTION_LEAD_INS) and renders the member ABSENT when every attempt
// fails. The four-bucket vector joins that contract on exactly the same terms,
// and this file proves it with a fake `opencode` on OPENCODE_BIN whose answer
// CHANGES between attempts — no model call, no network.
//
// The rule the middle test pins is the one that matters: nothing is ever
// patched into compliance. A member who cannot state an allocation is absent,
// which is a take the swarm never receives — never a zero-filled or
// renormalized vector signed in that member's name.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorTake } from "../../lib/swarm/inference.ts";

let fakeDir = "";
let fakeOpenCode = "";
let counterFile = "";
const originalBin = process.env.OPENCODE_BIN;

const PROSE = ["**REGIME**", "- one", "**ALLOCATION**", "- two", "**SUBJECT**", "- three"].join("\n");
const GOOD_WEIGHTS = "WEIGHTS: agent_tokens=0.15 | conservative_defi_yield=0.70 | protocol_tokens=0.10 | real_world_assets=0.05";
const STANCE = "STANCE: bullish | CONFIDENCE: 0.8";

/** Install a fake CLI that emits `answers[min(callIndex, last)]`. */
async function installAnswers(answers: string[]): Promise<void> {
  await writeFile(fakeOpenCode, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
let n = 0;
try { n = Number(readFileSync(${JSON.stringify(counterFile)}, "utf8")) || 0; } catch {}
writeFileSync(${JSON.stringify(counterFile)}, String(n + 1));
const answers = ${JSON.stringify(answers)};
const text = answers[Math.min(n, answers.length - 1)];
console.log(JSON.stringify({ type: "text", part: { type: "text", text } }));
`);
  await chmod(fakeOpenCode, 0o755);
  await writeFile(counterFile, "0");
}

beforeAll(async () => {
  fakeDir = await mkdtemp(join(tmpdir(), "swarm-take-weights-resample-"));
  fakeOpenCode = join(fakeDir, "opencode");
  counterFile = join(fakeDir, "calls.count");
  process.env.OPENCODE_BIN = fakeOpenCode;
});

afterEach(async () => { await writeFile(counterFile, "0"); });

afterAll(async () => {
  if (originalBin === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = originalBin;
  await rm(fakeDir, { recursive: true, force: true });
});

const persona = (memberId: string) => ({ memberId, name: memberId, lens: "risk", bias: 0 });
const regime = { composite: 0.5 };

test("a first sample that drops the WEIGHTS line is RE-SAMPLED, and the second take is kept whole", async () => {
  await installAnswers([
    [PROSE, STANCE].join("\n"),                  // attempt 1: prose only
    [PROSE, GOOD_WEIGHTS, STANCE].join("\n"),    // attempt 2: with the vector
  ]);
  const take = await authorTake(persona("athena"), regime, "robotmoney-allocation", { requireWeights: true });
  expect(take.weights).toEqual([
    { bucket: "agent_tokens", weight: 0.15 },
    { bucket: "conservative_defi_yield", weight: 0.7 },
    { bucket: "protocol_tokens", weight: 0.1 },
    { bucket: "real_world_assets", weight: 0.05 },
  ]);
  expect(take.stance).toBe("bullish");
  // The stored body is the prose alone — the vector lives only in `weights`.
  expect(take.body).not.toContain("WEIGHTS:");
  expect(take.body).toContain("**ALLOCATION**");
});

test("every attempt dropping the vector renders the member ABSENT — no zero-fill, no renormalization", async () => {
  await installAnswers([[PROSE, STANCE].join("\n")]);
  await expect(
    authorTake(persona("boreas"), regime, "robotmoney-allocation", { requireWeights: true }),
  ).rejects.toThrow(/rendered ABSENT, never patched into compliance/);
});

test("a partial vector is refused by name across every attempt", async () => {
  await installAnswers([[PROSE, "WEIGHTS: agent_tokens=0.5 | conservative_defi_yield=0.5", STANCE].join("\n")]);
  await expect(
    authorTake(persona("cygnus"), regime, "robotmoney-allocation", { requireWeights: true }),
  ).rejects.toThrow(/missing protocol_tokens, real_world_assets/);
});

test("a position_actions subject is unaffected: no vector asked for, none attached", async () => {
  await installAnswers([[PROSE, STANCE].join("\n")]);
  const take = await authorTake(persona("athena"), regime, "woon");
  expect(take.weights).toBeUndefined();
  expect(take.stance).toBe("bullish");
});
