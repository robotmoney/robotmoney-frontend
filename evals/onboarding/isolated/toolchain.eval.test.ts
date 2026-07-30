// toolchain (docs/architecture.md §11.3 E3, row 2).
//
// Proves: the agent can install `rmpc` FOR ITS OWN ARCHITECTURE, on PATH, with
// the `committee-identity` subcommands the whole onboarding flow depends on.
//
// NO HOST-SIDE FETCH, EVER. `fetchRmpc()` (scripts/lib/rmpc-fetch.ts) must
// never be called on this path: the agent working out which release asset it
// needs and putting it somewhere executable IS the measurement, and a harness
// that fetched the binary would be performing the agent's step for it (§11.3
// E2 — no scripted fallback). Only the PURE helper
// `missingCommitteeIdentitySubcommands()` is imported, so "what a working rmpc
// is" has ONE definition in this repo rather than a second one here.
//
// The binary the agent installed is linux/amd64; it is mounted read-only into
// a fresh member-agent container and executed THERE, so this claim behaves
// the same on an arm64 dev laptop as on an x64 CI runner.
//
// RUNTIME GATES THE RUN (evals/onboarding/support/gating.ts): if `runtime` did
// not admit, this claim's report is `not-measured`, never `failed`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { missingCommitteeIdentitySubcommands } from "../../../scripts/lib/rmpc-fetch.ts";
import type { Stack } from "../../../scripts/stack/index.ts";
import { evalSuiteRunId } from "../../support/artifacts.ts";
import { buildMemberAgentImage, evalProject, imageOnlyStack, repoRoot, tearDown } from "../support/eval-stack.ts";
import { readRuntimeOutcome } from "../support/gating.ts";
import { findByName, listContainerFiles, runExtractedBinary, toContainerPath, tryCopyOut } from "../support/probe.ts";
import { explainClaimFailure, ISOLATED_LAYER_TIMEOUT_MS, resolveIsolatedEvalModelConfig, runIsolatedClaim, type IsolatedClaimResult } from "../support/run.ts";
import { ISOLATED_SETUP_TIMEOUT_MS as SETUP_TIMEOUT_MS } from "../support/budget.ts";
import { buildToolchainTask } from "../support/tasks.ts";

const CLAIM = "toolchain";
const suiteRunId = evalSuiteRunId();

// The image's OWN contract for where an executable may live, read from the
// Dockerfile rather than hard-coded: a SET of directories, so moving the
// writable bin dir is a one-line image change and not a broken eval.
export function executableDirs(): string[] {
  const dockerfile = readFileSync(join(repoRoot, "scripts", "lib", "member-agent", "Dockerfile"), "utf8");
  const m = dockerfile.match(/^ENV PATH="([^"]+)"/m);
  if (!m) {
    throw new Error(
      "scripts/lib/member-agent/Dockerfile no longer declares `ENV PATH=\"…\"` — toolchain's on-PATH assertion has no contract to read",
    );
  }
  const declared = m[1]!.split(":").filter((d) => d.length > 0 && !d.includes("$"));
  return [...new Set([...declared, "/usr/local/bin", "/usr/bin"])];
}

interface ToolchainObservation {
  rmpcPaths: string[];
  onPathBinary: string | null;
  executedBinary: string | null;
  helpExitCode: number | null;
  helpOutput: string;
  missingSubcommands: string[] | null;
  otherProbes: { path: string; exitCode: number; missingSubcommands: string[] }[];
}

const MAX_PROBE_CANDIDATES = 3;

function describeToolchainEvidence(obs: ToolchainObservation | null | undefined): string {
  if (!obs) return "no toolchain observation was captured — see the harness observation error above.";
  const lines = [
    `rmpc paths found anywhere in the container: ${JSON.stringify(obs.rmpcPaths)}`,
    `in one of the image's declared PATH dirs ${JSON.stringify(executableDirs())}: ${obs.onPathBinary ?? "NONE"}`,
  ];
  if (obs.executedBinary === null) {
    lines.push(
      "the harness executed NO binary here, so this run says NOTHING about which committee-identity " +
        "subcommands rmpc has: exit code and subcommand set are NOT CHECKED, not missing.",
    );
  } else {
    lines.push(
      `executed \`committee-identity --help\` against the ON-PATH binary ${obs.executedBinary}: exit ${obs.helpExitCode}`,
      `subcommands absent from that --help output: ${obs.missingSubcommands === null ? "NOT CHECKED" : JSON.stringify(obs.missingSubcommands)}`,
      `--help output:\n${obs.helpOutput.slice(0, 2000)}`,
    );
  }
  for (const p of obs.otherProbes) {
    lines.push(
      `also present, NOT counted toward the verdict — ${p.path}: \`committee-identity --help\` exit ${p.exitCode}, ` +
        `subcommands absent: ${JSON.stringify(p.missingSubcommands)}`,
    );
  }
  return lines.join("\n");
}

let stack: Stack | null = null;
let hostDir = "";
let runtimeOutcome: string | null = null;
let result: IsolatedClaimResult<ToolchainObservation> | null = null;

describe("onboarding eval — toolchain", () => {
  beforeAll(async () => {
    runtimeOutcome = readRuntimeOutcome(repoRoot, suiteRunId);
    if (runtimeOutcome !== "admitted") return; // gated — see gating.ts and the tests below

    const modelConfig = resolveIsolatedEvalModelConfig(process.env);
    hostDir = mkdtempSync(join(tmpdir(), "rmeval-toolchain-"));
    stack = imageOnlyStack(evalProject(CLAIM));
    await buildMemberAgentImage(stack);

    const dirs = executableDirs();
    result = await runIsolatedClaim<ToolchainObservation>({
      claim: CLAIM,
      repoRoot,
      composeProject: stack.config.project,
      prompt: buildToolchainTask(),
      modelConfig,
      timeoutMs: ISOLATED_LAYER_TIMEOUT_MS,
      observe: (containerName) => {
        const listing = listContainerFiles(containerName);
        const rmpcPaths = findByName(containerName, "rmpc", listing);
        const onPath = rmpcPaths.find((p) => dirs.includes(dirname(toContainerPath(p)))) ?? null;
        const obs: ToolchainObservation = {
          rmpcPaths,
          onPathBinary: onPath,
          executedBinary: null,
          helpExitCode: null,
          helpOutput: "",
          missingSubcommands: null,
          otherProbes: [],
        };

        const probe = (candidate: string) => {
          const copied = tryCopyOut(
            containerName,
            toContainerPath(candidate),
            join(hostDir, "bin", encodeURIComponent(candidate)),
          );
          if (copied === null) return null;
          const r = runExtractedBinary({
            repoRoot,
            composeProject: stack!.config.project,
            hostBinaryPath: copied,
            argv: ["committee-identity", "--help"],
          });
          const output = `${r.stdout}\n${r.stderr}`;
          return { exitCode: r.exitCode, output, missing: missingCommitteeIdentitySubcommands(output) };
        };

        if (onPath !== null) {
          const r = probe(onPath);
          if (r !== null) {
            obs.executedBinary = toContainerPath(onPath);
            obs.helpExitCode = r.exitCode;
            obs.helpOutput = r.output;
            obs.missingSubcommands = r.missing;
          }
        }

        for (const candidate of rmpcPaths.filter((p) => p !== onPath).slice(0, MAX_PROBE_CANDIDATES)) {
          const r = probe(candidate);
          if (r === null) continue;
          obs.otherProbes.push({ path: toContainerPath(candidate), exitCode: r.exitCode, missingSubcommands: r.missing });
        }
        return obs;
      },
      ok: (obs) =>
        obs.onPathBinary !== null && obs.helpExitCode === 0 && obs.missingSubcommands !== null && obs.missingSubcommands.length === 0,
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    tearDown(stack, CLAIM);
    if (hostDir) rmSync(hostDir, { recursive: true, force: true });
  }, SETUP_TIMEOUT_MS);

  test("not-measured, never failed, when runtime did not admit", () => {
    if (runtimeOutcome === "admitted") return;
    expect(result).toBeNull();
  });

  test("the agent installed rmpc somewhere on the image's declared PATH", () => {
    if (runtimeOutcome !== "admitted") return; // gated
    if (result!.observation?.onPathBinary == null) {
      const criterion = !result!.observation
        ? "THE CONTAINER'S FILESYSTEM WAS NEVER OBSERVED — nothing here is a statement about what the agent installed."
        : result!.observation.rmpcPaths.length > 0
          ? "THE CRITERION THAT FAILED IS PATH PLACEMENT — an rmpc binary WAS present in the container, just not in one of the image's declared PATH dirs."
          : "NO rmpc BINARY WAS FOUND ANYWHERE in the container's filesystem.";
      throw new Error(
        explainClaimFailure(result!, `an \`rmpc\` binary in one of ${JSON.stringify(executableDirs())}`) +
          `\n${criterion}` +
          `\n${describeToolchainEvidence(result!.observation)}`,
      );
    }
    expect(executableDirs()).toContain(dirname(toContainerPath(result!.observation.onPathBinary)));
  });

  test("that binary really runs and exposes every committee-identity subcommand onboarding needs", () => {
    if (runtimeOutcome !== "admitted") return; // gated
    if (result!.outcome !== "admitted") {
      throw new Error(
        explainClaimFailure(result!, "`rmpc committee-identity --help` exiting 0 with create/show-public-key/sign") +
          `\n${describeToolchainEvidence(result!.observation)}`,
      );
    }
    expect(result!.observation?.helpExitCode).toBe(0);
    expect(result!.observation?.missingSubcommands).toEqual([]);
  });
});
