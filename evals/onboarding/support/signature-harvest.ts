// Layer 3's PASSIVE observation of the signed application
// (docs/architecture.md §11.3 E3).
//
// No artifact instruction, no capture server, no stack, no network. Everything
// here reads a run that ALREADY HAPPENED: the drained `opencode --format json`
// transcript the member-agent primitive returns, and the stopped container's
// filesystem. The agent is never told to hand anything over.
//
// TWO PHASES, matching when each source becomes readable:
//   1. `extractHarvestFiles()` runs inside the primitive's `inspect` bracket —
//      the only moment the STOPPED container still exists.
//   2. `harvestSignedApplication()` runs after the run returns, when the
//      transcript has been drained. It touches no container.
//
// ── How a signature is IDENTIFIED, and why that shape ───────────────────────
// Not by parsing opencode's event schema (not a published contract) and not by
// knowing where rmpc writes (not a published contract either). Instead:
//   1. Collect every base64 token of exactly ed25519 public-key length (32
//      bytes → 44 chars) and exactly ed25519 signature length (64 bytes → 88
//      chars) from the transcript and from the extracted files.
//   2. Recompute the canonical bytes with the CONTRACT's
//      canonicalizeApplication({name, contact, publicKey}) — never a
//      reimplementation.
//   3. Verify every (key, signature) pair with the REAL backend primitive
//      verifyApplicationSignature (backend/src/lib/signing.ts) — the exact
//      function POST /api/committee/apply runs. The pair that VERIFIES is the
//      evidence; nothing else has to be guessed.
// This survives an upstream transcript-schema change (the tokens are still in
// the text) and it cannot produce a false positive: a signature that verifies
// over our canonical bytes could only have been made by a key whose private
// half the agent generated and holds — which is precisely R3. It is also the
// canonicalization-drift catch: an agent that signed a payload with a `lens`
// field, different key order, or stray whitespace produces candidates that
// never verify, which is a DIFFERENT red from "no candidates at all".
//
// ── The one thing this file must never do ───────────────────────────────────
// It must never SIGN anything, and it must never fall back to signing on the
// agent's behalf (§11.3 E2 — no scripted fallback that performs the agent's
// steps for it). It only ever verifies.
import { canonicalizeApplication } from "@robotmoney/contract";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { extractMatching, fileSize, walk } from "./probe.ts";

// base64 of exactly 32 raw bytes / exactly 64 raw bytes, not glued to
// surrounding base64 text (so a longer blob can't yield a spurious prefix).
//
// The two boundaries are deliberately ASYMMETRIC, and the difference is
// load-bearing:
//   - LOOKAHEAD excludes `=` as well as base64 chars. A trailing `=` means the
//     real token is longer than what matched, so a 44-char prefix of a padded
//     blob must not be harvested.
//   - LOOKBEHIND excludes base64 chars ONLY. `=` is terminal padding in base64,
//     so a preceding `=` marks the END of some other token — it is a boundary,
//     not a continuation. Excluding it here made the harvest blind to the whole
//     `key=value` family (`publicKey=…`, `PUBKEY=…`, `--public-key=…`,
//     `signature=…`), which is exactly the shape a bash-only agent emits: the
//     member-agent's opencode permissions are `{"*": "deny", bash: "allow"}`, so
//     its transcript is shell output, not JSON. That false negative is
//     indistinguishable from "the agent never signed" — the worst failure this
//     file can have, because it reports a harness miss as a product result.
const B64_PUBLIC_KEY = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/g;
const B64_SIGNATURE = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{86}==(?![A-Za-z0-9+/=])/g;

// Where rmpc's keystore plausibly lands. Broad ON PURPOSE: rmpc's default path
// and whatever `--path` an agent chooses are both outside our control, so this
// is a family of shapes rather than one literal. Layer 3 reports what it
// matched, so a miss is diagnosable instead of mysterious.
export const KEYSTORE_PATH_PATTERN = /(committee[-_]?identity|keystore|\.rmpc\/|rmpc[-_]?identity|identity\.json)/i;

// Files worth reading when hunting for a signature the transcript did not
// carry. Scoped patterns, never a whole-filesystem extract: an agent that
// cloned robotmoney-core leaves hundreds of MB behind.
export const HARVEST_FILE_PATTERNS = [
  "*/.local/share/opencode/storage/*",
  "*/.local/state/opencode/*",
  "*/.config/opencode/*",
  "home/agent/*.json",
  "home/agent/*.txt",
  "home/agent/*.sig",
  "home/agent/*.b64",
  "home/agent/*.payload",
];

const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;
// Verification is O(keys × signatures) real ed25519 verifies; a transcript full
// of base64 noise must not turn that into minutes. A genuine run produces one
// key and one signature — a cap this high can only bite on noise.
const MAX_CANDIDATES = 25;

export interface Candidates {
  publicKeys: string[];
  signatures: string[];
}

export function scanBase64Candidates(text: string): Candidates {
  return {
    publicKeys: [...new Set(text.match(B64_PUBLIC_KEY) ?? [])],
    signatures: [...new Set(text.match(B64_SIGNATURE) ?? [])],
  };
}

function merge(a: Candidates, b: Candidates): Candidates {
  return {
    publicKeys: [...new Set([...a.publicKeys, ...b.publicKeys])],
    signatures: [...new Set([...a.signatures, ...b.signatures])],
  };
}

// PHASE 1 — inside the `inspect` bracket. Returns the extracted file paths
// (relative to hostDir); throws on any docker/tar failure that is not simply
// "the archive contains no such member".
export function extractHarvestFiles(containerName: string, hostDir: string): string[] {
  return extractMatching(containerName, HARVEST_FILE_PATTERNS, hostDir);
}

export interface HarvestOptions {
  repoRoot: string;
  transcript: string;
  hostDir: string;
  application: { name: string; contact: string };
}

export interface HarvestDiagnostics {
  candidatePublicKeys: number;
  candidateSignatures: number;
  filesScanned: number;
  sources: string[];
}

export interface HarvestedApplication {
  publicKey: string;
  signature: string;
  // The canonical payload found ON DISK in the container, when the agent left
  // one there — reported so a byte-difference is visible rather than inferred.
  canonicalPayloadOnDisk: string | null;
  // The canonical bytes the harness recomputed and verified against.
  canonicalPayloadExpected: string;
}

export interface HarvestResult {
  verified: HarvestedApplication | null;
  diagnostics: HarvestDiagnostics;
}

// The REAL production verifier, imported dynamically by absolute path exactly
// as scripts/tests/integration/rmpc-canonical-apply.test.ts does — the backend package is
// not on this package's module graph, and no crypto is reimplemented here.
async function loadVerifier(repoRoot: string) {
  const mod = (await import(join(repoRoot, "backend", "src", "lib", "signing.ts"))) as {
    verifyApplicationSignature: (application: unknown, signatureB64: string, publicKeyB64: string) => Promise<boolean>;
  };
  return mod.verifyApplicationSignature;
}

// PHASE 2 — after the run returned. Reads the transcript and whatever phase 1
// extracted; touches no container and no network.
export async function harvestSignedApplication(opts: HarvestOptions): Promise<HarvestResult> {
  const sources: string[] = ["transcript"];
  let candidates = scanBase64Candidates(opts.transcript);

  const contents = new Map<string, string>();
  for (const abs of walk(opts.hostDir)) {
    if (fileSize(abs) > MAX_SCANNED_FILE_BYTES) continue;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue; // a binary/unreadable member is simply not a signature source
    }
    contents.set(abs, text);
    candidates = merge(candidates, scanBase64Candidates(text));
  }
  sources.push(`container-files(${contents.size})`);

  const diagnostics: HarvestDiagnostics = {
    candidatePublicKeys: candidates.publicKeys.length,
    candidateSignatures: candidates.signatures.length,
    filesScanned: contents.size,
    sources,
  };

  const verify = await loadVerifier(opts.repoRoot);
  for (const publicKey of candidates.publicKeys.slice(0, MAX_CANDIDATES)) {
    const application = { name: opts.application.name, contact: opts.application.contact, publicKey };
    const canonical = canonicalizeApplication(application);
    for (const signature of candidates.signatures.slice(0, MAX_CANDIDATES)) {
      if (await verify(application, signature, publicKey)) {
        return {
          verified: {
            publicKey,
            signature,
            canonicalPayloadOnDisk: findApplicationPayloadOnDisk(contents, canonical, opts.application.contact),
            canonicalPayloadExpected: canonical,
          },
          diagnostics,
        };
      }
    }
  }
  return { verified: null, diagnostics };
}

// The agent's own copy of the bytes it signed, if it left one behind. Matched
// by CONTENT, never by filename — the harness never told the agent where to put
// anything. Returns the byte-exact canonical file when there is one; otherwise
// a payload-SHAPED file that is not byte-identical, so layer 3 can report the
// drift (key order, whitespace, a `lens` field) instead of silently ignoring
// it. Returns null only when the agent left no payload file at all.
export function findApplicationPayloadOnDisk(
  contents: Map<string, string>,
  canonical: string,
  contact: string,
): string | null {
  for (const text of contents.values()) {
    if (text.trim() === canonical) return text.trim();
  }
  for (const text of contents.values()) {
    const t = text.trim();
    if (t.startsWith("{") && t.includes(contact) && t.includes("publicKey")) return t;
  }
  return null;
}

// The message layer 3 fails with. Its whole job is to separate the two very
// different reds this observation can produce.
export function explainHarvestFailure(d: HarvestDiagnostics): string {
  if (d.candidatePublicKeys === 0 && d.candidateSignatures === 0) {
    return (
      "NO SIGNATURE MATERIAL ANYWHERE: neither the run transcript nor the stopped container's filesystem " +
      "contained an ed25519-shaped key or signature. The agent most likely never generated a key or never signed " +
      `(searched: ${d.sources.join(", ")}).`
    );
  }
  return (
    `SIGNATURE MATERIAL FOUND BUT NOTHING VERIFIED: ${d.candidatePublicKeys} candidate public key(s) and ` +
    `${d.candidateSignatures} candidate signature(s) were observed, and no pair verifies over the contract's ` +
    "canonicalizeApplication bytes. Either the agent signed a DIFFERENT payload (canonicalization drift — key " +
    "order, whitespace, a `lens` field) or the harness observed a signature from some other operation."
  );
}
