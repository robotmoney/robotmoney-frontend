// THE RUNNER HALF OF THE 2026-09-13 FIX: a provider that has refused ends the
// call, instead of being waited out.
//
// WHAT HAPPENED. Every swarm member on rm-frontend-stage-1 produced no take for
// nine hours. The opencode CLI wrote ONE line to stderr —
// `level=ERROR … message="stream error" … mode=primary
//  error.error="AI_APICallError: Rate limit exceeded. Please try again later."`
// — and then sat there with the session open. Nothing parsed stderr, so the
// runner waited out its entire 120,000 ms bound and reported
// `cause=timed-out — raise OPENCODE_TIMEOUT_MS or check provider latency` for a
// provider that had already said, in its own words, that it would not answer.
// 183 of a 400-run sample ended exactly that way.
//
// WHY THIS TEST SPAWNS. The parse is pinned hermetically next door
// (opencode-error-attribution.test.ts). What it cannot pin is the thing that
// actually cost nine hours: the WAIT. Only driving the real runner against a
// real child process that behaves like the CLI did — refuse, then hang — can
// show that the call now ends in seconds and that the diagnosis names the
// provider's sentence rather than the clock. The fake CLI is a 4-line shell
// script; there is no network and no model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorTake, type InferenceTelemetryEvent, type Persona, type RegimeContext } from "../../lib/swarm/inference.ts";
import { InferenceFailure } from "../../agent/inference-failure.ts";

const dir = mkdtempSync(join(tmpdir(), "rm-fatal-stream-"));
const fakeCli = join(dir, "opencode");

// The staging line, verbatim apart from the session id. `mode=primary` and the
// model id are what make it the PRIMARY stream rather than the auxiliary title
// agent, and both are load-bearing — see the narrowness test next door.
const STREAM_ERROR =
  'timestamp=2026-09-13T20:04:33.699Z level=ERROR run=2ed64d00 message="stream error" ' +
  "providerID=opencode modelID=nemotron-3-ultra-free session.id=ses_test small=false agent=build mode=primary " +
  'error.error="AI_APICallError: Rate limit exceeded. Please try again later."';

// SLEEP_S is the CLI's behaviour after the refusal: it does not exit. The whole
// point is that we no longer wait for it.
const SLEEP_S = 25;
const TIMEOUT_MS = 20_000;

const persona: Persona = { memberId: "m1", name: "Probe", lens: "probe lens", bias: 0 };
const regime: RegimeContext = { composite: 0.5, regime: "risk_on" };

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  writeFileSync(fakeCli, `#!/bin/sh\n>&2 echo '${STREAM_ERROR.replace(/'/g, "'\\''")}'\nsleep ${SLEEP_S}\n`);
  chmodSync(fakeCli, 0o755);
  for (const k of ["OPENCODE_BIN", "AGENT_MODEL", "OPENCODE_TIMEOUT_MS"]) saved[k] = process.env[k];
  process.env.OPENCODE_BIN = fakeCli;
  process.env.AGENT_MODEL = "free"; // resolves to opencode/nemotron-3-ultra-free — the id in the line
  process.env.OPENCODE_TIMEOUT_MS = String(TIMEOUT_MS);
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("a refused primary stream ends the call immediately", () => {
  test("it fails in seconds, names the provider's own sentence, and never says 'timed out'", async () => {
    const milestones: InferenceTelemetryEvent[] = [];
    const started = Date.now();
    let thrown: unknown;
    try {
      await authorTake(persona, regime, "subject-1", { telemetry: (e) => milestones.push(e) });
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - started;

    expect(thrown).toBeInstanceOf(InferenceFailure);
    const failure = thrown as InferenceFailure;

    // THE REGRESSION, IN ONE NUMBER. Before the fix this returned after the full
    // time bound; it now returns as soon as the provider says no. Generous
    // headroom over the ~1s the fake CLI needs, and still far under the bound.
    expect(elapsed, `took ${elapsed}ms of a ${TIMEOUT_MS}ms bound`).toBeLessThan(TIMEOUT_MS / 2);

    // THE DIAGNOSIS. The provider's own words, not a guess about latency.
    expect(failure.message).toContain("Rate limit exceeded");
    expect(failure.message).toContain("stopped early");
    expect(failure.message).not.toContain("timed out");
    expect(failure.message).toContain("NO template fallback");
    // Named but unclassified: no status code and no typed discriminator came
    // with it, and prose is never mined for one.
    expect(failure.kind).toBe("unclassified-error");

    // THE TELEMETRY. The primary stream was observed — carrying a refusal — and
    // the clock never ran out.
    const names = milestones.map((m) => m.milestone);
    expect(names).toContain("primary_provider_error");
    expect(names).toContain("primary_stream_observed");
    expect(names).not.toContain("timeout_reached");
    expect(names).toContain("process_exit");
  }, 40_000);

  test("THE CONTROL: a CLI that merely says nothing is still a timeout", async () => {
    // Without this, the change above could have been "call everything a provider
    // error", which would be the same bug with a different label.
    const silent = join(dir, "opencode-silent");
    writeFileSync(silent, `#!/bin/sh\n>&2 echo 'timestamp=x level=INFO message=bootstrapping'\nsleep ${SLEEP_S}\n`);
    chmodSync(silent, 0o755);
    process.env.OPENCODE_BIN = silent;
    process.env.OPENCODE_TIMEOUT_MS = "3000";
    try {
      const milestones: InferenceTelemetryEvent[] = [];
      let thrown: unknown;
      try {
        await authorTake(persona, regime, "subject-1", { telemetry: (e) => milestones.push(e) });
      } catch (err) { thrown = err; }
      expect(thrown).toBeInstanceOf(InferenceFailure);
      expect((thrown as InferenceFailure).message).toContain("timed out");
      expect((thrown as InferenceFailure).kind).toBe("timed-out");
      expect(milestones.map((m) => m.milestone)).toContain("timeout_reached");
    } finally {
      process.env.OPENCODE_BIN = fakeCli;
      process.env.OPENCODE_TIMEOUT_MS = String(TIMEOUT_MS);
    }
  }, 40_000);
});
