// LAYER 2 — rmpc toolchain (docs/architecture.md §11.3 E3, row 2).
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
// The binary the agent installed is linux/amd64; it is mounted read-only into a
// fresh member-agent container and executed THERE, so this layer behaves the
// same on an arm64 dev laptop as on an x64 CI runner.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { missingCommitteeIdentitySubcommands } from "../../../scripts/lib/rmpc-fetch.ts";
import type { Stack } from "../../../scripts/stack/index.ts";
import { buildMemberAgentImage, evalProject, imageOnlyStack, repoRoot, tearDown } from "../support/eval-stack.ts";
import { explainLayerFailure, ISOLATED_LAYER_TIMEOUT_MS, runIsolatedLayer, type IsolatedLayerResult } from "../support/layer-run.ts";
import { ISOLATED_SETUP_TIMEOUT_MS as SETUP_TIMEOUT_MS } from "../support/budget.ts";
import { buildLayer2Task } from "../support/layer-tasks.ts";
import { generateIdentity } from "../../../scripts/lib/onboarding-eval.ts";
import { findByName, listContainerFiles, runExtractedBinary, toContainerPath, tryCopyOut } from "../support/probe.ts";

const LAYER = "layer2";

// The image's OWN contract for where an executable may live, read from the
// Dockerfile rather than hard-coded: a SET of directories, so moving the
// writable bin dir is a one-line image change and not a broken eval.
export function executableDirs(): string[] {
  const dockerfile = readFileSync(join(repoRoot, "scripts", "lib", "member-agent", "Dockerfile"), "utf8");
  const m = dockerfile.match(/^ENV PATH="([^"]+)"/m);
  if (!m) {
    throw new Error(
      "scripts/lib/member-agent/Dockerfile no longer declares `ENV PATH=\"…\"` — layer 2's on-PATH assertion has no contract to read",
    );
  }
  const declared = m[1]!.split(":").filter((d) => d.length > 0 && !d.includes("$"));
  return [...new Set([...declared, "/usr/local/bin", "/usr/bin"])];
}

// WHAT THE HARNESS SAW — and, just as importantly, what it did NOT look at.
// `missingSubcommands` used to default to all three names, so a binary the
// harness never executed was reported as LACKING create/show-public-key/sign:
// a specific factual claim about a program that had never been run. The
// unchecked state is now modelled explicitly (null) so no message can assert an
// untested negative.
interface ToolchainObservation {
  rmpcPaths: string[];
  // An rmpc in one of the image's declared PATH dirs — the layer's criterion.
  onPathBinary: string | null;
  // The binary `committee-identity --help` was actually run against, wherever it
  // was found; null when nothing could be copied out and executed.
  executedBinary: string | null;
  // null on all three below-the-line fields' behalf: NOT CHECKED, never "failed".
  helpExitCode: number | null;
  helpOutput: string;
  missingSubcommands: string[] | null;
}

// How many distinct rmpc-named paths are worth executing. An agent that
// unpacked a release tree can leave several; the first that runs cleanly is the
// answer, and a small cap keeps a pathological listing from spawning dozens of
// probe containers.
const MAX_PROBE_CANDIDATES = 3;

// The evidence, rendered for the HUMAN reading a red log (§11.3 E3 — this is
// never shown to the agent). Phrased so an unexecuted binary reads as
// "not checked", which is the truth, rather than as a subcommand deficiency.
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
      `executed \`committee-identity --help\` against ${obs.executedBinary}: exit ${obs.helpExitCode}`,
      `subcommands absent from that --help output: ${obs.missingSubcommands === null ? "NOT CHECKED" : JSON.stringify(obs.missingSubcommands)}`,
      `--help output:\n${obs.helpOutput.slice(0, 2000)}`,
    );
  }
  return lines.join("\n");
}

let stack: Stack | null = null;
let hostDir = "";
let result: IsolatedLayerResult<ToolchainObservation>;

describe("onboarding eval — layer 2: rmpc toolchain", () => {
  beforeAll(async () => {
    // Printed BEFORE anything that can throw (bring-up, the run itself, an
    // assertion), so a red run's generated identity is always recoverable from
    // the log — including when the failure produces no observation at all.
    // Never a private key: name, contact and run id only.
    const identity = generateIdentity();
    console.log(`[${LAYER}] run ${identity.runId} — ${identity.name} <${identity.contact}>`);

    hostDir = mkdtempSync(join(tmpdir(), "rmeval-layer2-"));
    stack = await imageOnlyStack(evalProject(LAYER));
    await buildMemberAgentImage(stack);

    const dirs = executableDirs();
    result = await runIsolatedLayer<ToolchainObservation>({
      layer: LAYER,
      repoRoot,
      composeProject: stack.config.project,
      prompt: buildLayer2Task(identity),
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
        };

        // Execute whatever rmpc exists, WHEREVER it was found — on PATH first,
        // then the rest. An off-PATH binary still gets run so the log can say
        // what it really does; the previous early return left the "missing"
        // list at its default and made the harness report a negative about a
        // program it had never executed.
        const candidates = [...(onPath === null ? [] : [onPath]), ...rmpcPaths.filter((p) => p !== onPath)].slice(
          0,
          MAX_PROBE_CANDIDATES,
        );
        for (const candidate of candidates) {
          const copied = tryCopyOut(containerName, toContainerPath(candidate), join(hostDir, "bin", encodeURIComponent(candidate)));
          if (copied === null) continue;
          const r = runExtractedBinary({
            repoRoot,
            composeProject: stack!.config.project,
            hostBinaryPath: copied,
            argv: ["committee-identity", "--help"],
          });
          obs.executedBinary = toContainerPath(candidate);
          obs.helpExitCode = r.exitCode;
          obs.helpOutput = `${r.stdout}\n${r.stderr}`;
          obs.missingSubcommands = missingCommitteeIdentitySubcommands(obs.helpOutput);
          if (r.exitCode === 0) break;
        }
        return obs;
      },
      // UNCHANGED VERDICT. Still: on a declared PATH dir, AND `--help` exit 0,
      // AND no subcommand absent. The added `!== null` is what the explicit
      // unchecked state costs in types — before, an unexecuted probe carried a
      // three-element list, so this clause was false there too.
      //
      // WHETHER PATH PLACEMENT SHOULD GATE THIS LAYER AT ALL is a design
      // question for the human, not for this harness: an agent that fetched the
      // right asset and ran it from ~/bin has arguably done the toolchain step.
      // The observation above now records that case honestly so the call can be
      // made from evidence; changing the criterion here is not this file's job.
      ok: (obs) =>
        obs.onPathBinary !== null && obs.helpExitCode === 0 && obs.missingSubcommands !== null && obs.missingSubcommands.length === 0,
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    tearDown(stack, LAYER);
    if (hostDir) rmSync(hostDir, { recursive: true, force: true });
  }, SETUP_TIMEOUT_MS);

  test("the agent installed rmpc somewhere on the image's declared PATH", () => {
    if (result.observation?.onPathBinary == null) {
      // Three genuinely different reds, kept apart: no filesystem observation at
      // all (a harness limit), a binary present but off PATH, and no rmpc
      // anywhere. Only the last two are statements about the agent's work.
      const criterion = !result.observation
        ? "THE CONTAINER'S FILESYSTEM WAS NEVER OBSERVED — nothing here is a statement about what the agent installed."
        : result.observation.rmpcPaths.length > 0
          ? "THE CRITERION THAT FAILED IS PATH PLACEMENT — an rmpc binary WAS present in the container, just not in one of the image's declared PATH dirs."
          : "NO rmpc BINARY WAS FOUND ANYWHERE in the container's filesystem.";
      throw new Error(
        explainLayerFailure(result, `an \`rmpc\` binary in one of ${JSON.stringify(executableDirs())}`) +
          `\n${criterion}` +
          `\n${describeToolchainEvidence(result.observation)}`,
      );
    }
    expect(executableDirs()).toContain(dirname(toContainerPath(result.observation.onPathBinary)));
  });

  test("that binary really runs and exposes every committee-identity subcommand onboarding needs", () => {
    if (result.outcome !== "admitted") {
      throw new Error(
        explainLayerFailure(result, "`rmpc committee-identity --help` exiting 0 with create/show-public-key/sign") +
          `\n${describeToolchainEvidence(result.observation)}`,
      );
    }
    expect(result.observation?.helpExitCode).toBe(0);
    expect(result.observation?.missingSubcommands).toEqual([]);
  });
});
