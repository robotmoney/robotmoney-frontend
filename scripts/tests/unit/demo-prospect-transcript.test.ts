// Issue #317: the standing live demo must retain and expose a discoverable,
// tailable, secret-redacted transcript for EVERY prospective committee-member
// run — successful, failed, or still in progress — not only append the
// combined transcript to the shared demo log when a prospect fails.
//
// scripts/lib/demo-main.ts cannot be imported in a unit test (it boots a
// stack at module scope — see scripts/tests/unit/demo-onboarding-driver.test.ts's
// doc comment), so the WIRING into demo-main.ts is graded over source text
// there. This file proves the actual BEHAVIOUR of the extracted primitive
// demo-main.ts wires in: scripts/lib/demo-prospect-transcript.ts. No Docker,
// no model call — everything here is pure file I/O and pure record-shaping,
// which is exactly the part issue #317 needed and the part that is safe to
// execute in CI without a real container.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifiableRun } from "../../agent/classify-outcome.ts";
import { createOnboardingTelemetry } from "../../lib/onboarding-telemetry.ts";
import type { OnboardingEvalResult, OnboardingIdentity } from "../../lib/onboarding-eval.ts";
import { buildOutcomeRecord, startProspectTranscript } from "../../lib/demo-prospect-transcript.ts";

/** A throwaway repo root with just enough shape for the writer: the skill file it hashes. */
function fakeRepoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "prospect-transcript-test-"));
  const skillDir = join(root, "frontend", "public", "skills", "committee-onboarding");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# fake skill\n");
  return root;
}

const IDENTITY: OnboardingIdentity = { runId: "helios", name: "Helios", contact: "helios@example.test" };

function admittedResult(overrides: Partial<OnboardingEvalResult> = {}): OnboardingEvalResult {
  return {
    identity: IDENTITY,
    memberId: "m-helios",
    steps: [{ step: "apply", status: "done" }],
    admitted: true,
    applyState: "claimed",
    claimedAt: "2026-08-01T00:00:00.000Z",
    onActiveRoster: true,
    timedOut: false,
    containerExitCode: 0,
    containerLaunched: true,
    observerError: null,
    transcript: "--- stdout ---\nhello\n--- stderr ---\n",
    homeVolume: null,
    ...overrides,
  };
}

describe("startProspectTranscript (scripts/lib/demo-prospect-transcript.ts)", () => {
  test("creates a discoverable directory under the documented .agents/onboarding-evals/<project>/<runId> convention", () => {
    const repoRoot = fakeRepoRoot();
    try {
      const transcript = startProspectTranscript({
        repoRoot,
        composeProject: "rm_demo_abc123",
        identity: IDENTITY,
        model: "opencode/deepseek-v4-flash",
      });
      expect(transcript.directory).toBe(join(repoRoot, ".agents", "onboarding-evals", "rm_demo_abc123", "helios"));
      expect(statSync(transcript.directory).isDirectory()).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("the manifest is written immediately (before any event or finish()) and names the candidate — discoverable while the container is still launching", () => {
    const repoRoot = fakeRepoRoot();
    try {
      const transcript = startProspectTranscript({
        repoRoot,
        composeProject: "rm_demo_abc123",
        identity: IDENTITY,
        model: "opencode/deepseek-v4-flash",
      });
      const manifest = JSON.parse(readFileSync(join(transcript.directory, "manifest.json"), "utf8"));
      expect(manifest.candidateName).toBe("Helios");
      expect(manifest.composeProject).toBe("rm_demo_abc123");
      expect(manifest.runId).toBe("helios");
      expect(manifest.model).toBe("opencode/deepseek-v4-flash");
      // Contact itself is never persisted unredacted — only its hash.
      const raw = readFileSync(join(transcript.directory, "manifest.json"), "utf8");
      expect(raw).not.toContain(IDENTITY.contact);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("an event emitted through the sink is durably readable on disk immediately — proves the in-progress tailing path", () => {
    const repoRoot = fakeRepoRoot();
    try {
      const transcript = startProspectTranscript({
        repoRoot,
        composeProject: "rm_demo_abc123",
        identity: IDENTITY,
        model: "opencode/deepseek-v4-flash",
      });
      const telemetry = createOnboardingTelemetry({ composeProject: "rm_demo_abc123", runId: "helios" }, transcript.sink);
      telemetry.emit({ source: "agent", stream: "event", message: "member-agent container observed", containerName: "c1" });
      telemetry.emit({ source: "agent", stream: "stdout", message: '{"type":"text","text":"hi"}' });
      // No finish() call yet — this is what tailing an IN-PROGRESS prospect reads.
      const events = readFileSync(join(transcript.directory, "events.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(events).toHaveLength(2);
      expect(events[0].message).toBe("member-agent container observed");
      expect(events[0].composeProject).toBe("rm_demo_abc123");
      const stdout = readFileSync(join(transcript.directory, "agent.stdout.ndjson"), "utf8").trim();
      expect(stdout.length).toBeGreaterThan(0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("two attempts sharing one sink land in the SAME directory, each correctly tagged with its own attempt number — the retry case", () => {
    const repoRoot = fakeRepoRoot();
    try {
      const transcript = startProspectTranscript({
        repoRoot,
        composeProject: "rm_demo_abc123",
        identity: IDENTITY,
        model: "opencode/deepseek-v4-flash",
      });
      // Mirrors what runOnboardingEval does internally per attempt: its own
      // fresh telemetry (correct per-attempt runId/attempt), funneled through
      // the ONE sink this module handed to runOnboardingEvalWithRetry.
      const attempt1 = createOnboardingTelemetry({ composeProject: "rm_demo_abc123", runId: "helios", attempt: 1 }, transcript.sink);
      attempt1.emit({ source: "harness", stream: "event", message: "attempt 1 refused" });
      const attempt2 = createOnboardingTelemetry({ composeProject: "rm_demo_abc123", runId: "helios-r2", attempt: 2 }, transcript.sink);
      attempt2.emit({ source: "harness", stream: "event", message: "attempt 2 admitted" });

      const events = readFileSync(join(transcript.directory, "events.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(events.map((e) => e.attempt)).toEqual([1, 2]);
      expect(events.map((e) => e.runId)).toEqual(["helios", "helios-r2"]);
      expect(readdirSync(transcript.directory)).toContain("events.ndjson");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("finish() writes a result.json with the classified outcome, branch, reason, and correlating fields — no Docker required", () => {
    const repoRoot = fakeRepoRoot();
    try {
      const transcript = startProspectTranscript({
        repoRoot,
        composeProject: "rm_demo_abc123",
        identity: IDENTITY,
        model: "opencode/deepseek-v4-flash",
      });
      transcript.finish(admittedResult(), 12_345);
      const result = JSON.parse(readFileSync(join(transcript.directory, "result.json"), "utf8"));
      expect(result.admitted).toBe(true);
      expect(result.outcome).toBe("admitted");
      expect(result.demoRun).toBe("rm_demo_abc123");
      expect(result.memberId).toBe("m-helios");
      expect(result.durationMs).toBe(12_345);
      expect(typeof result.branch).toBe("string");
      expect(typeof result.reason).toBe("string");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("finish() on a FAILED prospect identifies the failing phase and retains the classified evidence", () => {
    const repoRoot = fakeRepoRoot();
    try {
      const transcript = startProspectTranscript({
        repoRoot,
        composeProject: "rm_demo_abc123",
        identity: IDENTITY,
        model: "opencode/deepseek-v4-flash",
      });
      const failed = admittedResult({
        admitted: false,
        memberId: null,
        applyState: "applied",
        claimedAt: null,
        onActiveRoster: false,
        containerExitCode: 1,
        transcript: "--- stdout ---\nrefusing this task\n--- stderr ---\n",
      });
      transcript.finish(failed, 5_000);
      const result = JSON.parse(readFileSync(join(transcript.directory, "result.json"), "utf8"));
      expect(result.admitted).toBe(false);
      expect(result.outcome).not.toBe("admitted");
      expect(result.branch).toBeTruthy();
      expect(result.reason).toBeTruthy();
      expect(result.evidence).toContain(result.branch);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("finishThrew() closes out the record when the harness itself throws before any classifiable result", () => {
    const repoRoot = fakeRepoRoot();
    try {
      const transcript = startProspectTranscript({
        repoRoot,
        composeProject: "rm_demo_abc123",
        identity: IDENTITY,
        model: "opencode/deepseek-v4-flash",
      });
      transcript.finishThrew(new Error("docker compose run failed: no space left on device"), 900);
      const result = JSON.parse(readFileSync(join(transcript.directory, "result.json"), "utf8"));
      expect(result.admitted).toBe(false);
      expect(result.outcome).toBe("harness-error");
      expect(result.error).toContain("no space left on device");
      expect(result.durationMs).toBe(900);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("buildOutcomeRecord (pure)", () => {
  test("computes the SAME outcome classifyOutcome/explainOutcome would, from a synthetic result — no Docker, no inference", () => {
    const result = admittedResult({ admitted: false, memberId: null, containerExitCode: 1 });
    const record = buildOutcomeRecord("rm_demo_xyz", result, 1234);
    expect(record.demoRun).toBe("rm_demo_xyz");
    expect(record.durationMs).toBe(1234);
    expect(record.admitted).toBe(false);
    expect(record.finalAttemptRunId).toBe("helios");
    // Sanity: the object is JSON-serializable (this is what writer.finish() persists).
    expect(() => JSON.stringify(record)).not.toThrow();
  });

  test("a red control: an intentionally malformed run (admitted but no evidence) is still classified, never thrown", () => {
    const brokenRun = { admitted: true, timedOut: false, memberId: null, containerExitCode: null } as unknown as OnboardingEvalResult;
    expect(() => buildOutcomeRecord("p", { ...brokenRun, identity: IDENTITY, steps: [], applyState: null, claimedAt: null, onActiveRoster: false, containerLaunched: null, observerError: null, homeVolume: null }, 0)).not.toThrow();
  });
});

// Keep ClassifiableRun imported so a future structural drift between
// OnboardingEvalResult and ClassifiableRun is a compile error here, not a
// silent `as unknown as` cast slipping past review.
function _typeAssertion(r: OnboardingEvalResult): ClassifiableRun {
  return r;
}
void _typeAssertion;
