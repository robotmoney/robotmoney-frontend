// Runtime-gates-the-run reporting (docs/architecture.md §11.3, this issue's
// "New behaviour").
//
// A red `runtime` claim means the container itself was never a fair test
// subject (dead image, unreachable provider, an empty transcript) — so
// `skill-install`, `toolchain`, and `keygen-signing` cannot mean anything
// either, and reporting them `failed` would blame the product for something
// the harness never got to observe. They must report `not-measured` instead —
// never `failed` — whenever `runtime` is not `admitted`. When `runtime` IS
// `admitted`, the other three are mutually independent and each reports its
// own classified outcome unchanged.
//
// PURE. This function takes four already-classified outcomes and returns a
// report; it runs no container, reads no environment, and makes no model
// call, so scripts/tests/unit/onboarding-eval-gating.test.ts can drive its
// whole outcome table with zero inference and zero Docker.
import type { OnboardingOutcome } from "../../../scripts/agent/classify-outcome.ts";

export type ClaimReportStatus = OnboardingOutcome | "not-measured";

export interface RuntimeGatedOutcomes {
  runtime: OnboardingOutcome;
  skillInstall: OnboardingOutcome;
  toolchain: OnboardingOutcome;
  keygenSigning: OnboardingOutcome;
}

export interface RuntimeGatedReport {
  runtime: OnboardingOutcome;
  skillInstall: ClaimReportStatus;
  toolchain: ClaimReportStatus;
  keygenSigning: ClaimReportStatus;
  /** True exactly when `runtime` did not admit — the gate that fired, if any. */
  gated: boolean;
}

/**
 * One claim's REPORTED status given the run's own classified outcome and
 * whether runtime admitted. Never returns anything but the real outcome or
 * `"not-measured"` — there is no `"failed"` synthesised here or anywhere else
 * in this module.
 */
export function gatedClaimStatus(runtimeOutcome: OnboardingOutcome, claimOutcome: OnboardingOutcome): ClaimReportStatus {
  return runtimeOutcome === "admitted" ? claimOutcome : "not-measured";
}

/** The whole isolated suite's report, runtime-gated. */
export function buildRuntimeGatedReport(outcomes: RuntimeGatedOutcomes): RuntimeGatedReport {
  const gated = outcomes.runtime !== "admitted";
  return {
    runtime: outcomes.runtime,
    skillInstall: gatedClaimStatus(outcomes.runtime, outcomes.skillInstall),
    toolchain: gatedClaimStatus(outcomes.runtime, outcomes.toolchain),
    keygenSigning: gatedClaimStatus(outcomes.runtime, outcomes.keygenSigning),
    gated,
  };
}

// ── Cross-file handoff (runtime-first execution order) ──────────────────────
// The four claims are separate Bun test files so they collect and run in
// isolation (§11.3 E3). Bun does not serialise multiple files given to ONE
// `bun test` invocation in argv order (confirmed empirically: with all four
// listed together, files complete in an order that matches neither the argv
// order nor its reverse, and a file that `await`s another file's not-yet-
// written result can stall the whole run rather than yield to it) — so
// "runtime-first execution order" is enforced with TWO SEPARATE Bun
// PROCESSES, not in-process scheduling. package.json's
// `eval:onboarding:isolated` target runs `runtime.eval.test.ts` to completion
// FIRST, then — regardless of its exit code, so a red runtime still lets the
// other three report `not-measured` rather than silently not running — runs
// `skill-install.eval.test.ts`, `toolchain.eval.test.ts`, and
// `keygen-signing.eval.test.ts` in a second process. By the time the second
// process starts, the first has already exited and its handoff file is fully
// flushed to disk, so the read below needs no polling and no retry.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function handoffPath(repoRoot: string, suiteRunId: string): string {
  return join(repoRoot, ".agents", "evals", suiteRunId, "runtime-outcome.json");
}

export function writeRuntimeOutcome(repoRoot: string, suiteRunId: string, outcome: OnboardingOutcome): void {
  const path = handoffPath(repoRoot, suiteRunId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ outcome }), { mode: 0o600 });
}

/**
 * Read runtime's outcome, written by a PRIOR, already-exited
 * `runtime.eval.test.ts` process. Throws when the file is absent — a
 * harness/wiring failure (runtime crashed before it could write anything, or
 * this file ran standalone rather than via `bun run eval:onboarding:isolated`)
 * — never silently treated as an admission.
 */
export function readRuntimeOutcome(repoRoot: string, suiteRunId: string): OnboardingOutcome {
  const path = handoffPath(repoRoot, suiteRunId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `no runtime outcome recorded at ${path}. skill-install/toolchain/keygen-signing must run AFTER runtime has ` +
        "fully exited, via `bun run eval:onboarding:isolated` — never invoked standalone.",
    );
  }
  return (JSON.parse(raw) as { outcome: OnboardingOutcome }).outcome;
}
