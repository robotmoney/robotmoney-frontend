// THE CRITICAL TEST (Stage 3, docs/architecture.md §11 R6 / risk register #1
// in docs/plans/onboarding-ic-workflow.md and /drive2/home/lucas/tmp/rm-committee-workflow.md).
//
// Proves byte-exactness across the JS/Rust boundary for the canonical
// committee-application payload: the REAL rmpc binary (downloaded from
// GitHub Releases, never built from source here — same discipline as
// scripts/rmpc-release-e2e.ts) signs the EXACT bytes produced by
// contract/src/committee-application.js's canonicalizeApplication() (Stage
// 0's golden fixtures), and the resulting signature is checked with the REAL
// backend verification primitive (backend/src/lib/signing.ts
// verifyApplicationSignature) — the exact function POST /api/committee/apply
// runs in production. Nothing here is mocked or reimplemented: if the JS
// serializer and whatever an agent feeds `rmpc committee-identity sign`
// diverge by even one byte (field order, whitespace, escaping, encoding), a
// real member agent's signed application will always fail backend
// verification, and this test is where that would first show up.
//
// Loud-skip-never (test-coverage-policy): this test requires network access
// to GitHub Releases to fetch the pinned rmpc binary (cached after the first
// run — see scripts/lib/rmpc-fetch.ts) and requires being able to execute the
// downloaded binary. It does NOT skip when either is unavailable — every
// failure path in rmpc-fetch.ts throws, which fails this test file loudly.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeApplication } from "@robotmoney/contract";
import { fetchRmpc, runRmpcJson } from "../lib/rmpc-fetch.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");

const fixtures = JSON.parse(
  await Bun.file(join(repoRoot, "contract", "src", "__fixtures__", "committee-application.json")).text(),
) as {
  vectors: { name: string; payload: Record<string, unknown>; expectedCanonicalJson: string; expectedBytesHex: string }[];
};

// Import the REAL backend verification primitive (not a reimplementation) so
// this test exercises the exact production code path — never mock the
// subject under test.
const { verifyApplicationSignature } = (await import(join(repoRoot, "backend", "src", "lib", "signing.ts"))) as {
  verifyApplicationSignature: (application: any, signatureB64: string, publicKeyB64: string) => Promise<boolean>;
};

// Resolved once and shared across every test below — a shared in-flight
// promise means concurrent tests await the SAME fetch/verify instead of
// racing to populate the cache independently.
const rmpcPathPromise = fetchRmpc();

function createIdentity(rmpcPath: string, keystorePath: string, passphrase: string) {
  const env = { RMPC_COMMITTEE_IDENTITY_PASSPHRASE: passphrase };
  const created = runRmpcJson(rmpcPath, ["committee-identity", "--path", keystorePath, "create"], env);
  if (!created.ok || typeof created.public_key !== "string") {
    throw new Error(`committee-identity create did not return a public key: ${JSON.stringify(created)}`);
  }
  const shown = runRmpcJson(rmpcPath, ["committee-identity", "--path", keystorePath, "show-public-key"], env);
  if (!shown.ok || shown.public_key !== created.public_key) {
    throw new Error(`show-public-key (${shown.public_key}) does not match create's public key (${created.public_key})`);
  }
  return shown.public_key as string;
}

function signCanonical(rmpcPath: string, keystorePath: string, passphrase: string, workDir: string, canonical: string, expectedPublicKey: string) {
  const payloadFile = join(workDir, `payload-${crypto.randomUUID()}.txt`);
  writeFileSync(payloadFile, canonical);
  const signed = runRmpcJson(
    rmpcPath,
    ["committee-identity", "--path", keystorePath, "sign", "--payload-file", payloadFile],
    { RMPC_COMMITTEE_IDENTITY_PASSPHRASE: passphrase },
  );
  if (!signed.ok || typeof signed.signature !== "string") {
    throw new Error(`committee-identity sign did not return a signature: ${JSON.stringify(signed)}`);
  }
  if (signed.public_key !== expectedPublicKey) {
    throw new Error(`sign's public_key (${signed.public_key}) does not match show-public-key's (${expectedPublicKey})`);
  }
  return signed.signature as string;
}

describe("canonicalizeApplication() is golden-fixture-stable", () => {
  for (const vector of fixtures.vectors) {
    test(`${vector.name}: JS serialization matches the pinned fixture bytes`, () => {
      const canonical = canonicalizeApplication(vector.payload as any);
      expect(canonical).toBe(vector.expectedCanonicalJson);
      expect(Buffer.from(canonical, "utf-8").toString("hex")).toBe(vector.expectedBytesHex);
    });
  }
});

// Generous per-test timeout: the first test in the file pays for the
// (network-dependent, potentially multi-second) rmpc download + extraction +
// verification that every other test then reuses via the shared
// rmpcPathPromise. Not a loud-skip escape hatch — a genuinely stuck/broken
// fetch still fails the test, just after a fair amount of time to succeed.
const RMPC_TEST_TIMEOUT_MS = 60_000;

describe("rmpc-signed canonical committee-application payload verifies against the real backend primitive", () => {
  for (const vector of fixtures.vectors) {
    test(`${vector.name}`, async () => {
      const rmpcPath = await rmpcPathPromise;
      const workDir = mkdtempSync(join(tmpdir(), "rmpc-canonical-apply-"));
      try {
        const passphrase = crypto.randomUUID();
        const keystorePath = join(workDir, "identity.json");
        const publicKeyB64 = createIdentity(rmpcPath, keystorePath, passphrase);

        // Sign the EXACT canonical bytes our JS serializer produces for this
        // vector's fields, using the REAL rmpc-generated public key — the
        // same construction a real applyMember() request carries: the
        // signature is over canonicalizeApplication({ name, contact, lens?,
        // publicKey }) where `publicKey` is the signer's own key (Stage 1,
        // backend/src/committee/domain.ts applyMember).
        const application = { ...vector.payload, publicKey: publicKeyB64 };
        const canonical = canonicalizeApplication(application as any);
        const signature = signCanonical(rmpcPath, keystorePath, passphrase, workDir, canonical, publicKeyB64);

        const verified = await verifyApplicationSignature(application, signature, publicKeyB64);
        expect(verified).toBe(true);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }, RMPC_TEST_TIMEOUT_MS);
  }

  // Negative control: proves the assertions above aren't vacuously true (e.g.
  // a broken verify that always returns true would still pass every test
  // above). A signature made by a DIFFERENT rmpc identity must NOT verify.
  test("negative control: a signature from a different rmpc identity does not verify", async () => {
    const rmpcPath = await rmpcPathPromise;
    const workDir = mkdtempSync(join(tmpdir(), "rmpc-canonical-apply-negctrl-"));
    try {
      const vector = fixtures.vectors[0];
      const signerPassphrase = crypto.randomUUID();
      const signerKeystore = join(workDir, "signer.json");
      const signerPublicKey = createIdentity(rmpcPath, signerKeystore, signerPassphrase);

      const otherPassphrase = crypto.randomUUID();
      const otherKeystore = join(workDir, "other.json");
      const otherPublicKey = createIdentity(rmpcPath, otherKeystore, otherPassphrase);
      expect(otherPublicKey).not.toBe(signerPublicKey);

      // Application claims `signerPublicKey`, but is actually signed by the
      // OTHER identity's key — exactly the key/signature-mismatch case
      // backend/tests/committee-apply-signed.test.ts pins at the route layer.
      const application = { ...vector.payload, publicKey: signerPublicKey };
      const canonical = canonicalizeApplication(application as any);
      const wrongSignature = signCanonical(rmpcPath, otherKeystore, otherPassphrase, workDir, canonical, otherPublicKey);

      const verified = await verifyApplicationSignature(application, wrongSignature, signerPublicKey);
      expect(verified).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, RMPC_TEST_TIMEOUT_MS);
});
