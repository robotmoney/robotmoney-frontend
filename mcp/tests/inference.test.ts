import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStanceFromBody,
  extractAssistantText,
  authorTake,
  type RegimeContext,
} from "../src/inference.ts";

// ── parseStanceFromBody: control line extracted + stripped ──────────────────
test("parseStanceFromBody extracts stance+confidence and strips the control line", () => {
  const body = [
    "**REGIME**",
    "- Composite 0.544 at the 56th percentile reads risk-on.",
    "",
    "**ALLOCATION**",
    "- Targets stay 95/5/0/0.",
    "",
    "**SUBJECT**",
    "- Woon carries most of its book on a single stream.",
    "STANCE: cautious | CONFIDENCE: 0.72",
  ].join("\n");

  const parsed = parseStanceFromBody(body);
  expect(parsed.stance).toBe("cautious");
  expect(parsed.confidence).toBe(0.72);
  // The STANCE/CONFIDENCE control line must NOT survive into the stored body.
  expect(parsed.body).not.toContain("STANCE:");
  expect(parsed.body).not.toContain("CONFIDENCE:");
  // But the authored sections must remain intact.
  expect(parsed.body).toContain("**REGIME**");
  expect(parsed.body).toContain("**SUBJECT**");
});

test("parseStanceFromBody clamps confidence into [0,1] and lowercases stance", () => {
  const parsed = parseStanceFromBody("**REGIME**\n- x\nSTANCE: Bullish | CONFIDENCE: 1.4");
  expect(parsed.stance).toBe("bullish");
  expect(parsed.confidence).toBe(1);
});

test("parseStanceFromBody degrades to neutral/0.5 when no control line is present", () => {
  const body = "**REGIME**\n- Just prose, no control line.";
  const parsed = parseStanceFromBody(body);
  expect(parsed.stance).toBe("neutral");
  expect(parsed.confidence).toBe(0.5);
  expect(parsed.body).toBe(body);
});

// ── extractAssistantText: parse the opencode --format json NDJSON transcript ──
// Fixture mirrors the REAL opencode 1.16.x `run --format json` stream: one JSON
// object per line, assistant prose in finalized `{"type":"text","part":{...}}`
// events, non-text lifecycle events ignored. Concatenated text parts are the
// authored take.
test("extractAssistantText concatenates finalized text parts from an NDJSON transcript", () => {
  const transcript = [
    JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } }),
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "**REGIME**\n- Composite 0.544 reads risk-on.", time: { end: 1 } } }),
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "STANCE: cautious | CONFIDENCE: 0.7", time: { end: 2 } } }),
    JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish" } }),
  ].join("\n");

  const text = extractAssistantText(transcript);
  expect(text).toContain("**REGIME**");
  expect(text).toContain("STANCE: cautious | CONFIDENCE: 0.7");
  // The parseStanceFromBody path should then recover the control line.
  const parsed = parseStanceFromBody(text);
  expect(parsed.stance).toBe("cautious");
  expect(parsed.confidence).toBe(0.7);
});

test("extractAssistantText returns '' for a transcript with no assistant text (empty run)", () => {
  // A run that only emitted a step_start (exactly what a stalled/failed keyless
  // zen call produces) has NO authored text — the wrapper must treat this as an
  // empty transcript and throw.
  const transcript = JSON.stringify({ type: "step_start", sessionID: "ses_x", part: { type: "step-start" } });
  expect(extractAssistantText(transcript)).toBe("");
});

// ── loud-skip contract: authorTake throws when opencode is unavailable ───────
// This proves the keyless inference wrapper NEVER returns a templated fallback
// when the external resource (the opencode CLI / zen model) is missing — it
// fails loudly instead. We point OPENCODE_BIN at a nonexistent path so the spawn
// cannot succeed, proving the contract WITHOUT any live model call.
const savedBin = process.env.OPENCODE_BIN;
const savedTimeout = process.env.OPENCODE_TIMEOUT_MS;
afterEach(() => {
  if (savedBin === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = savedBin;
  if (savedTimeout === undefined) delete process.env.OPENCODE_TIMEOUT_MS;
  else process.env.OPENCODE_TIMEOUT_MS = savedTimeout;
});

test("authorTake throws (no fallback) when the opencode binary is unavailable", async () => {
  process.env.OPENCODE_BIN = "/nonexistent/opencode-does-not-exist-xyz";
  const regime: RegimeContext = { composite: 0.544, compositePercentile: 0.56, regime: "risk_on" };
  await expect(
    authorTake({ memberId: "athena", name: "Athena", lens: "macro risk", bias: -0.1 }, regime, "woon"),
  ).rejects.toThrow(/opencode/i);
});

// ── timeout bound: a hung zen call throws instead of blocking forever ─────────
// Points OPENCODE_BIN at a tiny sleeper that ignores its args and sleeps far
// longer than the (deliberately tiny) OPENCODE_TIMEOUT_MS. The wrapper must throw
// loudly WELL before the sleeper finishes — proving one stalled member can't
// freeze the session, and still WITHOUT any template fallback.
//
// The sleeper deliberately does NOT `exec`, so `sleep` is a GRANDCHILD that keeps
// the inherited stdout/stderr pipes open after the shell is killed. This is the
// worst case: proc.kill() closing the pipes is NOT sufficient. The Promise.race
// timeout must reject on its own timer, independent of pipe closure — if the
// throw depended on the pipes closing, this test would hang to the sleeper's 5s.
test("authorTake throws (no fallback) when the opencode call exceeds OPENCODE_TIMEOUT_MS", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "opencode-sleeper-"));
  const sleeper = join(dir, "opencode-sleeper.sh");
  await fs.writeFile(sleeper, "#!/bin/sh\nsleep 5\n");
  await fs.chmod(sleeper, 0o755);

  process.env.OPENCODE_BIN = sleeper;
  process.env.OPENCODE_TIMEOUT_MS = "300";
  const regime: RegimeContext = { composite: 0.544, compositePercentile: 0.56, regime: "risk_on" };
  try {
    await expect(
      authorTake({ memberId: "athena", name: "Athena", lens: "macro risk", bias: -0.1 }, regime, "woon"),
    ).rejects.toThrow(/timed out/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
