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

interface ToolchainObservation {
  rmpcPaths: string[];
  onPathBinary: string | null;
  helpExitCode: number | null;
  helpOutput: string;
  missingSubcommands: string[];
}

let stack: Stack | null = null;
let hostDir = "";
let result: IsolatedLayerResult<ToolchainObservation>;

describe("onboarding eval — layer 2: rmpc toolchain", () => {
  beforeAll(async () => {
    hostDir = mkdtempSync(join(tmpdir(), "rmeval-layer2-"));
    stack = await imageOnlyStack(evalProject(LAYER));
    await buildMemberAgentImage(stack);

    const dirs = executableDirs();
    result = await runIsolatedLayer<ToolchainObservation>({
      layer: LAYER,
      repoRoot,
      composeProject: stack.config.project,
      prompt: buildLayer2Task(generateIdentity()),
      timeoutMs: ISOLATED_LAYER_TIMEOUT_MS,
      observe: (containerName) => {
        const listing = listContainerFiles(containerName);
        const rmpcPaths = findByName(containerName, "rmpc", listing);
        const onPath = rmpcPaths.find((p) => dirs.includes(dirname(toContainerPath(p)))) ?? null;
        const obs: ToolchainObservation = {
          rmpcPaths,
          onPathBinary: onPath,
          helpExitCode: null,
          helpOutput: "",
          missingSubcommands: ["create", "show-public-key", "sign"],
        };
        if (onPath === null) return obs;

        const copied = tryCopyOut(containerName, toContainerPath(onPath), join(hostDir, "bin"));
        if (copied === null) return obs;
        const r = runExtractedBinary({
          repoRoot,
          composeProject: stack!.config.project,
          hostBinaryPath: copied,
          argv: ["committee-identity", "--help"],
        });
        obs.helpExitCode = r.exitCode;
        obs.helpOutput = `${r.stdout}\n${r.stderr}`;
        obs.missingSubcommands = missingCommitteeIdentitySubcommands(obs.helpOutput);
        return obs;
      },
      ok: (obs) => obs.onPathBinary !== null && obs.helpExitCode === 0 && obs.missingSubcommands.length === 0,
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    tearDown(stack, LAYER);
    if (hostDir) rmSync(hostDir, { recursive: true, force: true });
  }, SETUP_TIMEOUT_MS);

  test("the agent installed rmpc somewhere on the image's declared PATH", () => {
    if (result.observation?.onPathBinary == null) {
      throw new Error(
        explainLayerFailure(result, `an \`rmpc\` binary in one of ${JSON.stringify(executableDirs())}`) +
          `\nrmpc paths found anywhere in the container: ${JSON.stringify(result.observation?.rmpcPaths ?? [])}`,
      );
    }
    expect(executableDirs()).toContain(dirname(toContainerPath(result.observation.onPathBinary)));
  });

  test("that binary really runs and exposes every committee-identity subcommand onboarding needs", () => {
    if (result.outcome !== "admitted") {
      throw new Error(
        explainLayerFailure(result, "`rmpc committee-identity --help` exiting 0 with create/show-public-key/sign") +
          `\nhelp exit=${result.observation?.helpExitCode}, missing=${JSON.stringify(result.observation?.missingSubcommands)}` +
          `\nhelp output:\n${(result.observation?.helpOutput ?? "").slice(0, 2000)}`,
      );
    }
    expect(result.observation?.helpExitCode).toBe(0);
    expect(result.observation?.missingSubcommands).toEqual([]);
  });
});
