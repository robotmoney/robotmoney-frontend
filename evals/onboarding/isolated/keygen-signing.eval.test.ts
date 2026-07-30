// keygen-signing, verified OFFLINE (docs/architecture.md §11.3 E3, row 3).
//
// Proves: the agent generates an ed25519 identity ON ITS OWN MACHINE and signs
// the BYTE-EXACT canonical application payload. No stack, no server, no
// network verification — the signature is checked here, offline, against the
// contract's `canonicalizeApplication` using the REAL backend primitive
// `verifyApplicationSignature` (the exact function POST /api/committee/apply
// runs). Nothing is reimplemented and no libsodium appears anywhere.
//
// This is the claim that catches CANONICALIZATION DRIFT — key order, stray
// whitespace, an included-when-absent `lens` — which would otherwise surface
// in production as an unexplained 400 with no indication of whose bytes were
// wrong.
//
// R3 IS PART OF THE MEASUREMENT: the private key must never leave the agent's
// machine. The harness never generates a key, never signs, and never reads a
// private key; it only verifies material the agent left behind, and
// separately records that an rmpc keystore exists inside the container.
//
// RUNTIME GATES THE RUN (evals/onboarding/support/gating.ts): if `runtime` did
// not admit, this claim's report is `not-measured`, never `failed`.
//
// KNOWN RESIDUAL RISK (stated, not hidden): the harvest depends on the agent's
// key/signature appearing in the drained transcript or in a small file in the
// container. Neither opencode's transcript shape nor rmpc's on-disk layout is
// a published contract, so a red here can be a HARNESS observation limit
// rather than a product regression — which is exactly why the failure message
// distinguishes "no signature material anywhere" from "material found,
// nothing verifies".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { canonicalizeApplication } from "@robotmoney/contract";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stack } from "../../../scripts/stack/index.ts";
import { evalSuiteRunId } from "../../support/artifacts.ts";
import { buildMemberAgentImage, evalProject, imageOnlyStack, repoRoot, tearDown } from "../support/eval-stack.ts";
import { readRuntimeOutcome } from "../support/gating.ts";
import { findMatching, listContainerFiles } from "../support/probe.ts";
import { explainClaimFailure, ISOLATED_LAYER_TIMEOUT_MS, resolveIsolatedEvalModelConfig, runIsolatedClaim, type IsolatedClaimResult } from "../support/run.ts";
import { ISOLATED_SETUP_TIMEOUT_MS as SETUP_TIMEOUT_MS } from "../support/budget.ts";
import { buildKeygenSigningTask, generateClaimIdentity, type ClaimIdentity } from "../support/tasks.ts";
import {
  explainHarvestFailure,
  extractHarvestFiles,
  harvestSignedApplication,
  KEYSTORE_PATH_PATTERN,
  type HarvestResult,
} from "../support/signature-harvest.ts";

const CLAIM = "keygen-signing";
const suiteRunId = evalSuiteRunId();

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
let identity: ClaimIdentity;
let runtimeOutcome: string | null = null;
let result: IsolatedClaimResult<SigningObservation> | null = null;

describe("onboarding eval — keygen-signing", () => {
  beforeAll(async () => {
    runtimeOutcome = readRuntimeOutcome(repoRoot, suiteRunId);
    if (runtimeOutcome !== "admitted") return; // gated — see gating.ts and the tests below

    identity = generateClaimIdentity();
    // Printed BEFORE anything that can throw. A red claim is diagnosed by
    // replaying the exact canonical bytes for THIS run, and two paths lose the
    // identity entirely otherwise: the zero-candidate harvest branch returns
    // before `canonicalShapeExpected` renders it, and a bring-up throw or a
    // timeout produces no harvest and no message at all. Never a private key.
    console.log(`[${CLAIM}] run ${identity.name} <${identity.contact}>`);

    const modelConfig = resolveIsolatedEvalModelConfig(process.env);
    hostDir = mkdtempSync(join(tmpdir(), "rmeval-keygen-signing-"));
    stack = imageOnlyStack(evalProject(CLAIM));
    await buildMemberAgentImage(stack);

    result = await runIsolatedClaim<CapturedContainer, SigningObservation>({
      claim: CLAIM,
      repoRoot,
      composeProject: stack.config.project,
      prompt: buildKeygenSigningTask(identity),
      modelConfig,
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
    tearDown(stack, CLAIM);
    if (hostDir) rmSync(hostDir, { recursive: true, force: true });
  }, SETUP_TIMEOUT_MS);

  test("not-measured, never failed, when runtime did not admit", () => {
    if (runtimeOutcome === "admitted") return;
    expect(result).toBeNull();
  });

  test("the agent produced a signature that verifies against the contract's canonical application bytes", () => {
    if (runtimeOutcome !== "admitted") return; // gated
    if (result!.outcome !== "admitted") {
      throw new Error(
        explainClaimFailure(result!, "an observable ed25519 signature over canonicalizeApplication({name, contact, publicKey})") +
          `\n${explainHarvestFailure(result!.observation?.harvest.diagnostics ?? { candidatePublicKeys: 0, candidateSignatures: 0, filesScanned: 0, sources: [] })}`,
      );
    }
    expect(result!.observation?.harvest.verified?.signature).toBeTruthy();
    expect(result!.observation?.harvest.verified?.publicKey).toBeTruthy();
  });

  test("the key was generated INSIDE the container — an rmpc keystore is present and the harness never made one (R3)", () => {
    if (runtimeOutcome !== "admitted") return; // gated
    const paths = result!.observation?.keystorePaths ?? [];
    if (paths.length === 0) {
      throw new Error(
        "no rmpc keystore-shaped file was observed in the stopped container.\n" +
          "Either the agent never generated a key on its own machine (an R3 failure) or it wrote the keystore " +
          `somewhere this harness does not recognise (patterns: ${KEYSTORE_PATH_PATTERN}).\n` +
          explainClaimFailure(result!, "an rmpc keystore file inside the container"),
      );
    }
    expect(paths.length).toBeGreaterThan(0);
  });

  test("the payload the agent left on disk is BYTE-IDENTICAL to the canonical bytes (canonicalization-drift catch)", () => {
    if (runtimeOutcome !== "admitted") return; // gated
    const verified = result!.observation?.harvest.verified;
    if (!verified) throw new Error("no verified signature — see the first test in this file for the diagnosis");
    const canonical = canonicalizeApplication({ name: identity.name, contact: identity.contact, publicKey: verified.publicKey });
    expect(verified.canonicalPayloadExpected).toBe(canonical);
    if (verified.canonicalPayloadOnDisk === null) return;
    expect(verified.canonicalPayloadOnDisk).toBe(canonical);
  });
});
