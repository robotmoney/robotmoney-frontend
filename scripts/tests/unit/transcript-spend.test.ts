// WHAT A MEMBER RUN COST (R19).
//
// The `opencode run --format json` stream already carries the provider's own
// token counts and cost on every `step_finish` event; every parser in this repo
// skipped them, so "what did this session spend on member inference" was only
// answerable from the vendor's dashboard — out of band, and unattributable to a
// session or a member.
//
// WHAT THIS FILE PROTECTS:
//   1. The numbers are SUMMED across the steps of one run, not taken from the
//      last one — a run with a tool call has several.
//   2. An unreported spend is `null`, NEVER a row of zeroes. Zeroes would read
//      as a free run, which is the one lie a spend report must not tell.
//   3. Garbage never throws: a spend figure may not be able to fail a take.
//   4. The per-run `manifest.json` carries it, so the artifact an operator
//      opens answers the question without a second tool.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptSpend } from "../../agent/transcript.ts";
import { createSwarmSessionArtifactWriter } from "../../lib/swarm/telemetry.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const step = (input: number, output: number, cost: number, reasoning = 0) =>
  JSON.stringify({
    type: "step_finish",
    part: { type: "step_finish", tokens: { input, output, reasoning, cache: { read: 0, write: 0 } }, cost },
  });

const TEXT_LINE = JSON.stringify({ type: "text", part: { type: "text", text: "STANCE: bullish" } });

test("the spend is summed across every step of one run", () => {
  const transcript = [step(1000, 300, 0.0002), TEXT_LINE, step(820, 311, 0.00022, 5)].join("\n");
  expect(transcriptSpend(transcript)).toEqual({
    inputTokens: 1820,
    outputTokens: 611,
    reasoningTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 2436,
    costUsd: 0.00042,
    steps: 2,
  });
});

test("a transcript with no step_finish reports NULL, not a free run", () => {
  expect(transcriptSpend([TEXT_LINE, "not json at all", ""].join("\n"))).toBeNull();
  expect(transcriptSpend("")).toBeNull();
  // The control: the same transcript WITH a step does report one, so the null
  // above is about the missing event and not about an unreadable parser.
  expect(transcriptSpend([TEXT_LINE, step(1, 1, 0)].join("\n"))?.steps).toBe(1);
});

test("unreadable fields contribute nothing and never throw", () => {
  const junk = JSON.stringify({ type: "step_finish", part: { tokens: { input: "lots", output: null }, cost: -3 } });
  const spend = transcriptSpend([junk, step(10, 5, 0.001)].join("\n"))!;
  expect(spend.steps).toBe(2);
  expect(spend.inputTokens).toBe(10);
  expect(spend.outputTokens).toBe(5);
  // A negative cost is not a rebate: it is unreadable, and contributes zero.
  expect(spend.costUsd).toBe(0.001);
});

test("the per-run manifest carries the spend, and says so when there is none", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-spend-manifest-"));
  roots.push(root);
  const writer = createSwarmSessionArtifactWriter({
    repoRoot: root,
    composeProject: "rm_smoke_stack_x",
    sessionId: "42",
    memberId: "athena",
    runId: "athena-s42-spend",
    model: "deepseek-v4-flash",
    timeoutMs: 300_000,
  });
  const manifestPath = join(writer.directory, "manifest.json");
  // Present and null BEFORE the run finishes: an absent key and an unreported
  // spend must not be the same shape to a reader.
  expect(JSON.parse(readFileSync(manifestPath, "utf8")).spend).toBeNull();

  writer.sink({ source: "agent", stream: "stdout", message: step(1000, 300, 0.0002) } as any);
  writer.sink({ source: "agent", stream: "stdout", message: TEXT_LINE } as any);
  writer.sink({ source: "agent", stream: "stdout", message: step(820, 311, 0.00022) } as any);
  writer.finish({ exitCode: 0 });

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(manifest.spend).toMatchObject({ inputTokens: 1820, outputTokens: 611, costUsd: 0.00042, steps: 2 });
  expect(typeof manifest.finishedAt).toBe("string");
  // The rest of the manifest survived the rewrite.
  expect(manifest.model).toBe("deepseek-v4-flash");
  expect(manifest.sessionId).toBe("42");
});

test("a run that produced no step_finish finishes with a null spend", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-spend-none-"));
  roots.push(root);
  const writer = createSwarmSessionArtifactWriter({
    repoRoot: root,
    composeProject: "rm_smoke_stack_x",
    sessionId: "42",
    memberId: "athena",
    runId: "athena-s42-dead",
    model: "deepseek-v4-flash",
    timeoutMs: 1000,
  });
  writer.sink({ source: "agent", stream: "stderr", message: "boom" } as any);
  writer.finish({ error: "dead" });
  expect(JSON.parse(readFileSync(join(writer.directory, "manifest.json"), "utf8")).spend).toBeNull();
});
