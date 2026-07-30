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
// Verification is O(keys × signatures) real ed25519 verifies, so there has to be
// SOME bound. The old bound was 25 per dimension, justified as "a genuine run
// produces one key and one signature — a cap this high can only bite on noise."
// Observation falsified that: a real layer-3 run on 2026-07-26 yielded 3
// candidate keys and 34 candidate SIGNATURES (an agent that clones
// robotmoney-core drags in a lot of base64-shaped text), so 9 signatures were
// silently never tested. If the agent's real signature had been among them, the
// harness would have reported "nothing verified" — a harness miss dressed as a
// canonicalization-drift result.
//
// The bound was also far more expensive than it looked worth: a FAILED verify
// measured at 0.009 ms here, so the old cap bought ~0.0 s and cost coverage.
// 500 per dimension is a 2.2 s worst case against layers that run for minutes.
// Truncation is additionally reported (see `truncatedCandidates`) — a cap that
// silently discards evidence is exactly the false green this eval exists to
// prevent.
const MAX_CANDIDATES = 500;

export interface Candidates {
  publicKeys: string[];
  signatures: string[];
}

function scanExactly(text: string): Candidates {
  return {
    publicKeys: [...new Set(text.match(B64_PUBLIC_KEY) ?? [])],
    signatures: [...new Set(text.match(B64_SIGNATURE) ?? [])],
  };
}

// Re-join a base64 token that an ENCODER wrapped across lines: drop each newline
// together with the indentation that follows it.
//
// Why this is not hypothetical. `base64` (GNU coreutils) wraps at 76 columns by
// default and `openssl base64` at 64, and HARVEST_FILE_PATTERNS deliberately
// lists `home/agent/*.sig` and `home/agent/*.b64` — encoder output is an
// IN-SCOPE sink. An 88-char signature with a newline at column 76 matches
// B64_SIGNATURE zero times, and a key that lands mid-line can wrap too. That is
// the same false-negative class as the `key=value` blind spot above: the harness
// observes a perfectly good signature and reports "NO SIGNATURE MATERIAL
// ANYWHERE", a harness miss dressed as a product result.
export function joinWrappedLines(text: string): string {
  return text.replace(/\r?\n[ \t]*/g, "");
}

// The re-joined copy is scanned IN ADDITION to the raw text, never instead of
// it: joining lines also GLUES two adjacent unrelated tokens together, and the
// raw pass is what still finds those. Merging two candidate sets can only ADD
// candidates — it can never manufacture a pass, because a pair is admitted only
// by a real ed25519 verification against the contract's canonical bytes. The
// worst it can do is spend candidate budget, which the cap bounds and
// `truncatedCandidates` reports.
export function scanBase64Candidates(text: string): Candidates {
  const raw = scanExactly(text);
  const joined = joinWrappedLines(text);
  return joined === text ? raw : merge(raw, scanExactly(joined));
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
  // The canonical bytes the harness verified against, with the applicant's own
  // publicKey elided (it differs per candidate). Reported so a drift red says
  // what the agent SHOULD have signed instead of only that nothing matched —
  // without it, "nothing verified" is undiagnosable from a CI log.
  canonicalShapeExpected?: string;
  // What the agent actually left on disk, compared BYTE-WISE. See
  // PayloadOnDiskEvidence: the whole point is that a trailing newline is
  // visible here rather than trimmed away.
  payloadOnDisk?: PayloadOnDiskEvidence;
  // Set ONLY when the candidate cap actually discarded something. Absence means
  // every observed pair really was verified — so "nothing verified" can be read
  // as a result rather than a possible truncation artifact.
  truncatedCandidates?: { publicKeys: number; signatures: number };
  // Set ONLY when the walk stepped over a file WITHOUT reading it. Same doctrine
  // as `truncatedCandidates`: a cap that silently discards evidence is exactly
  // the false green this eval exists to prevent, and `filesScanned` counts only
  // the files actually read — so without this record a run whose key and
  // signature lived solely inside a 3 MiB log reports "the agent most likely
  // never generated a key", which is a harness miss reported as a product
  // result. Optional so that absence means "every file present was read".
  unscannedFiles?: UnscannedFiles;
}

// Files the walk did NOT read, by reason. Counted separately because they mean
// different things: `oversized` is our own byte cap biting, `unreadable` is the
// host refusing (permissions, a vanished path, a device node).
export interface UnscannedFiles {
  oversized: number;
  unreadable: number;
}

// How the agent's own payload file compares to the canonical bytes.
//
// `trailing-whitespace-only` is called out separately because it is the single
// most likely way a shell-driven agent fails this layer and the hardest to see:
// `rmpc committee-identity sign --payload-file F` signs the bytes of F EXACTLY
// and canonicalizes nothing, so `echo "$payload" > F` appends one \n and the
// signature can never verify — while every human-readable rendering of F still
// looks perfectly correct. `printf '%s'` (or writing without a trailing
// newline) is the fix.
//
// The upstream fix belongs to the repo-owned committee-onboarding skill, not
// here: the skill must state, in as many words, that the payload file is
// signed EXACT BYTES, not a human-editable rendering — tracked as
// robotmoney/robotmoney-core#1188, referenced only (cross-repo work gets
// issues, never code edits, from this repo).
export type PayloadDiskMatch = "none" | "byte-exact" | "trailing-whitespace-only" | "shaped-but-different";

export interface PayloadOnDiskEvidence {
  match: PayloadDiskMatch;
  // JSON-escaped so invisible bytes (\n, \r, trailing spaces) are legible in a
  // CI log; truncated, because an agent can leave a very large file behind.
  bytes: string | null;
}

const MAX_REPORTED_PAYLOAD_CHARS = 400;

function escapeForLog(text: string): string {
  const escaped = JSON.stringify(text);
  return escaped.length > MAX_REPORTED_PAYLOAD_CHARS ? `${escaped.slice(0, MAX_REPORTED_PAYLOAD_CHARS)}…` : escaped;
}

/**
 * Compare every file the agent left behind against the canonical bytes for each
 * candidate public key, WITHOUT trimming — the trim is precisely what hides the
 * defect. Best match wins.
 */
export function classifyPayloadOnDisk(
  contents: Map<string, string>,
  canonicalCandidates: string[],
  contact: string,
): PayloadOnDiskEvidence {
  const exact = new Set(canonicalCandidates);
  let whitespaceOnly: string | null = null;
  let shaped: string | null = null;

  for (const text of contents.values()) {
    if (exact.has(text)) return { match: "byte-exact", bytes: escapeForLog(text) };
    if (whitespaceOnly === null && exact.has(text.trim())) whitespaceOnly = text;
    if (shaped === null) {
      const t = text.trim();
      if (t.startsWith("{") && t.includes(contact) && t.includes("publicKey")) shaped = text;
    }
  }
  if (whitespaceOnly !== null) return { match: "trailing-whitespace-only", bytes: escapeForLog(whitespaceOnly) };
  if (shaped !== null) return { match: "shaped-but-different", bytes: escapeForLog(shaped) };
  return { match: "none", bytes: null };
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
  // Every file the walk steps over is COUNTED, because the alternative is a
  // silent discard that later reads as "the agent never signed" (see
  // `unscannedFiles`).
  const unscanned: UnscannedFiles = { oversized: 0, unreadable: 0 };
  for (const abs of walk(opts.hostDir)) {
    if (fileSize(abs) > MAX_SCANNED_FILE_BYTES) {
      unscanned.oversized += 1;
      continue;
    }
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      unscanned.unreadable += 1;
      continue; // the host would not hand us the bytes; that is an observation, not a result
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
    canonicalShapeExpected: canonicalizeApplication({
      name: opts.application.name,
      contact: opts.application.contact,
      publicKey: "<the applicant's own base64 public key>",
    }),
  };

  if (unscanned.oversized > 0 || unscanned.unreadable > 0) diagnostics.unscannedFiles = unscanned;

  const droppedKeys = Math.max(0, candidates.publicKeys.length - MAX_CANDIDATES);
  const droppedSignatures = Math.max(0, candidates.signatures.length - MAX_CANDIDATES);
  if (droppedKeys > 0 || droppedSignatures > 0) {
    diagnostics.truncatedCandidates = { publicKeys: droppedKeys, signatures: droppedSignatures };
  }

  const verify = await loadVerifier(opts.repoRoot);
  // Every canonical rendering the agent could legitimately have signed, one per
  // candidate key — the comparison set for the on-disk payload evidence below.
  const canonicalCandidates: string[] = [];
  for (const publicKey of candidates.publicKeys.slice(0, MAX_CANDIDATES)) {
    const application = { name: opts.application.name, contact: opts.application.contact, publicKey };
    const canonical = canonicalizeApplication(application);
    canonicalCandidates.push(canonical);
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
  // Nothing verified. Attach what the agent actually wrote, compared byte-wise —
  // this is the evidence that separates "signed the right bytes plus a newline"
  // from "signed a different payload shape", and it is invisible without it.
  diagnostics.payloadOnDisk = classifyPayloadOnDisk(contents, canonicalCandidates, opts.application.contact);
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

// A cap that discarded evidence must SAY SO: without this line, a truncated
// search and an exhaustive one produce the same "nothing verified" text, and the
// reader cannot tell a result from an artifact.
export function explainTruncation(t: HarvestDiagnostics["truncatedCandidates"]): string {
  if (!t) return "";
  return (
    `\nWARNING — THE SEARCH WAS TRUNCATED: ${t.publicKeys} public key(s) and ${t.signatures} signature(s) ` +
    "exceeded the candidate cap and were NEVER TESTED, so this failure may be an artifact of the cap rather " +
    "than a real drift. Raise MAX_CANDIDATES in evals/onboarding/support/signature-harvest.ts."
  );
}

// The same doctrine as explainTruncation, one layer earlier: a file the walk
// never READ cannot be evidence against the agent. Silent when every file
// present was read, so silence means the search really was exhaustive.
export function explainUnscannedFiles(u: HarvestDiagnostics["unscannedFiles"]): string {
  if (!u || (u.oversized === 0 && u.unreadable === 0)) return "";
  return (
    `\nWARNING — THE SCAN DID NOT READ EVERY FILE: ${u.oversized} file(s) exceeded the ` +
    `${MAX_SCANNED_FILE_BYTES}-byte per-file cap and ${u.unreadable} file(s) could not be read, so their ` +
    "contents were NEVER SEARCHED and this failure may be an artifact of the harness rather than a result. " +
    "Raise MAX_SCANNED_FILE_BYTES in evals/onboarding/support/signature-harvest.ts."
  );
}

// The on-disk payload half of the drift diagnosis. Silent when the agent left
// nothing behind — there is no evidence to report and a "none" line would be
// noise.
export function explainPayloadOnDisk(e: PayloadOnDiskEvidence | undefined): string {
  if (!e || e.match === "none") return "";
  if (e.match === "trailing-whitespace-only") {
    return (
      `\nTHE AGENT'S PAYLOAD FILE IS CANONICAL EXCEPT FOR SURROUNDING WHITESPACE: ${e.bytes}\n` +
      "That is the entire defect. `rmpc committee-identity sign --payload-file F` signs the bytes of F " +
      "EXACTLY and canonicalizes nothing, so a single trailing newline — what `echo \"$payload\" > F` " +
      "writes — makes the signature unverifiable while the file still LOOKS right. Writing the payload " +
      "without a trailing newline (`printf '%s'`) is the fix."
    );
  }
  if (e.match === "byte-exact") {
    return (
      `\nThe agent's payload file IS byte-exact: ${e.bytes}\n` +
      "So the drift is not in the payload — the signature was made over something else, or with a key " +
      "whose public half was never observed."
    );
  }
  return `\nThe agent's payload file differs in SHAPE, not just whitespace: ${e.bytes}`;
}

// Everything BOTH reds need. Neither branch may keep evidence to itself: the
// zero-candidate branch used to return before the payload comparison, so a
// `trailing-whitespace-only` verdict already computed by
// harvestSignedApplication was silently thrown away whenever no base64
// candidate had been harvested — the flagship diagnosis, lost in exactly the
// case where the reader has the least to go on.
function explainSharedEvidence(d: HarvestDiagnostics): string {
  return (
    // Without the expected shape this red is undiagnosable from a CI log: the
    // reader can see that nothing matched but not what the target was.
    (d.canonicalShapeExpected ? `\nThe harness verified against exactly: ${d.canonicalShapeExpected}` : "") +
    explainPayloadOnDisk(d.payloadOnDisk) +
    explainUnscannedFiles(d.unscannedFiles) +
    explainTruncation(d.truncatedCandidates)
  );
}

// The message layer 3 fails with. Its whole job is to separate the two very
// different reds this observation can produce.
export function explainHarvestFailure(d: HarvestDiagnostics): string {
  if (d.candidatePublicKeys === 0 && d.candidateSignatures === 0) {
    return (
      "NO SIGNATURE MATERIAL ANYWHERE: neither the run transcript nor the stopped container's filesystem " +
      "contained an ed25519-shaped key or signature. The agent most likely never generated a key or never signed " +
      `(searched: ${d.sources.join(", ")}).` +
      explainSharedEvidence(d)
    );
  }
  return (
    `SIGNATURE MATERIAL FOUND BUT NOTHING VERIFIED: ${d.candidatePublicKeys} candidate public key(s) and ` +
    `${d.candidateSignatures} candidate signature(s) were observed, and no pair verifies over the contract's ` +
    "canonicalizeApplication bytes. Either the agent signed a DIFFERENT payload (canonicalization drift — key " +
    "order, whitespace, a `lens` field) or the harness observed a signature from some other operation." +
    explainSharedEvidence(d)
  );
}
