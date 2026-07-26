// LAYER 3 — keygen + signing, verified OFFLINE (docs/architecture.md §11.3 E3,
// row 3).
//
// Proves: the agent generates an ed25519 identity ON ITS OWN MACHINE and signs
// the BYTE-EXACT canonical application payload. No stack, no server, no network
// verification — the signature is checked here, offline, against the contract's
// `canonicalizeApplication` using the REAL backend primitive
// `verifyApplicationSignature` (the exact function POST /api/committee/apply
// runs). Nothing is reimplemented and no libsodium appears anywhere.
//
// This is the layer that catches CANONICALIZATION DRIFT — key order, stray
// whitespace, an included-when-absent `lens` — which would otherwise surface in
// production as an unexplained 400 with no indication of whose bytes were wrong.
//
// R3 IS PART OF THE MEASUREMENT: the private key must never leave the agent's
// machine. The harness never generates a key, never signs, and never reads a
// private key; it only verifies material the agent left behind, and separately
// records that an rmpc keystore exists inside the container.
//
// KNOWN RESIDUAL RISK (stated, not hidden): the harvest depends on the agent's
// key/signature appearing in the drained transcript or in a small file in the
// container. Neither opencode's transcript shape nor rmpc's on-disk layout is a
// published contract, so a red here can be a HARNESS observation limit rather
// than a product regression — which is exactly why the failure message
// distinguishes "no signature material anywhere" from "material found, nothing
// verifies".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { canonicalizeApplication } from "@robotmoney/contract";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, type OnboardingIdentity } from "../../../scripts/lib/onboarding-eval.ts";
import type { Stack } from "../../../scripts/stack/index.ts";
import { buildMemberAgentImage, evalProject, imageOnlyStack, repoRoot, tearDown } from "../support/eval-stack.ts";
import { explainLayerFailure, ISOLATED_LAYER_TIMEOUT_MS, runIsolatedLayer, type IsolatedLayerResult } from "../support/layer-run.ts";
import { buildLayer3TaskWithNote } from "../support/layer-tasks.ts";
import { findMatching, listContainerFiles } from "../support/probe.ts";
import {
  explainHarvestFailure,
  extractHarvestFiles,
  harvestSignedApplication,
  KEYSTORE_PATH_PATTERN,
  type HarvestResult,
} from "../support/signature-harvest.ts";

const LAYER = "layer3";
const SETUP_TIMEOUT_MS = 45 * 60_000;

// Captured inside the `inspect` bracket (the stopped container still exists).
interface CapturedContainer {
  keystorePaths: string[];
  extractedFiles: string[];
}

// Derived after the run returned (the transcript exists by then).
interface SigningObservation {
  keystorePaths: string[];
  harvest: HarvestResult;
}

let stack: Stack | null = null;
let hostDir = "";
let identity: OnboardingIdentity;
let result: IsolatedLayerResult<SigningObservation>;

describe("onboarding eval — layer 3: keygen + signing", () => {
  beforeAll(async () => {
    hostDir = mkdtempSync(join(tmpdir(), "rmeval-layer3-"));
    identity = generateIdentity();
    stack = await imageOnlyStack(evalProject(LAYER));
    await buildMemberAgentImage(stack);

    result = await runIsolatedLayer<CapturedContainer, SigningObservation>({
      layer: LAYER,
      repoRoot,
      composeProject: stack.config.project,
      prompt: buildLayer3TaskWithNote(identity),
      timeoutMs: ISOLATED_LAYER_TIMEOUT_MS,
      observe: (containerName) => ({
        keystorePaths: findMatching(containerName, KEYSTORE_PATH_PATTERN, listContainerFiles(containerName)),
        extractedFiles: extractHarvestFiles(containerName, hostDir),
      }),
      derive: async (captured, run) => ({
        keystorePaths: captured?.keystorePaths ?? [],
        harvest: await harvestSignedApplication({
          repoRoot,
          transcript: run.transcript,
          hostDir,
          application: { name: identity.name, contact: identity.contact },
        }),
      }),
      ok: (obs) => obs.harvest.verified !== null,
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    tearDown(stack, LAYER);
    if (hostDir) rmSync(hostDir, { recursive: true, force: true });
  }, SETUP_TIMEOUT_MS);

  test("the agent produced a signature that verifies against the contract's canonical application bytes", () => {
    if (result.outcome !== "admitted") {
      throw new Error(
        explainLayerFailure(result, "an observable ed25519 signature over canonicalizeApplication({name, contact, publicKey})") +
          `\n${explainHarvestFailure(result.observation?.harvest.diagnostics ?? { candidatePublicKeys: 0, candidateSignatures: 0, filesScanned: 0, sources: [] })}`,
      );
    }
    expect(result.observation?.harvest.verified?.signature).toBeTruthy();
    expect(result.observation?.harvest.verified?.publicKey).toBeTruthy();
  });

  test("the key was generated INSIDE the container — an rmpc keystore is present and the harness never made one (R3)", () => {
    const paths = result.observation?.keystorePaths ?? [];
    if (paths.length === 0) {
      throw new Error(
        "no rmpc keystore-shaped file was observed in the stopped container.\n" +
          "Either the agent never generated a key on its own machine (an R3 failure) or it wrote the keystore " +
          `somewhere this harness does not recognise (patterns: ${KEYSTORE_PATH_PATTERN}).\n` +
          explainLayerFailure(result, "an rmpc keystore file inside the container"),
      );
    }
    expect(paths.length).toBeGreaterThan(0);
  });

  test("the payload the agent left on disk is BYTE-IDENTICAL to the canonical bytes (canonicalization-drift catch)", () => {
    const verified = result.observation?.harvest.verified;
    if (!verified) throw new Error("no verified signature — see the first test in this file for the diagnosis");
    const canonical = canonicalizeApplication({
      name: identity.name,
      contact: identity.contact,
      publicKey: verified.publicKey,
    });
    // Always asserted: the bytes the harness VERIFIED against are the contract's
    // canonical bytes for this run's identity, so this test can never pass by
    // having checked nothing.
    expect(verified.canonicalPayloadExpected).toBe(canonical);
    // The agent is never told to write the payload down, so its absence is not
    // a failure — the verification above already proves the SIGNED bytes were
    // canonical. When it IS present, it must match exactly.
    if (verified.canonicalPayloadOnDisk === null) return;
    expect(verified.canonicalPayloadOnDisk).toBe(canonical);
  });
});
