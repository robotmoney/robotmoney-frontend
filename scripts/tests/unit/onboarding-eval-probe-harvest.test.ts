// PURE, Docker-free unit tests for the two eval-support modules that carried no
// executed coverage at all: evals/onboarding/support/probe.ts and
// evals/onboarding/support/signature-harvest.ts (~394 lines of parsing and
// offline verification that only `tsc` had ever looked at).
//
// Cost class `unit` (docs/architecture.md §3 L1, docs/decisions.md D23): bun and
// the checkout, nothing else. Every Docker-touching export of probe.ts
// (tryCopyOut, copyOut, listContainerFiles, extractMatching, runExtractedBinary)
// is deliberately OUT of scope here — this file covers the pure surface plus the
// `listing`-injected form of the finders, and the harvest pipeline, which needs
// no container at all once the transcript and files exist.
//
// Testing these from scripts/tests/ rather than from evals/ is the L3 direction
// (tests may import eval code; runtime may not), and it keeps the eval path
// itself free of the seams check-eval-keyless.sh forbids: nothing here is
// imported BY an eval, so no injection point is created on an eval's own path.
//
// The load-bearing case is "a real signature verifies, a drifted one does not".
// It uses a genuinely generated Ed25519 key and the REAL production verifier
// (backend/src/lib/signing.ts) — the same function POST /api/committee/apply
// runs — so a canonicalization change in @robotmoney/contract turns this red
// instead of silently degrading layer 3 into a permanent "nothing verified".
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeApplication } from "@robotmoney/contract";
import { fileSize, findByName, findMatching, toContainerPath, walk } from "../../../evals/onboarding/support/probe.ts";
import {
  explainHarvestFailure,
  findApplicationPayloadOnDisk,
  harvestSignedApplication,
  HARVEST_FILE_PATTERNS,
  KEYSTORE_PATH_PATTERN,
  scanBase64Candidates,
  type HarvestDiagnostics,
} from "../../../evals/onboarding/support/signature-harvest.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

// A container name that CANNOT exist. Passed to the finders alongside an
// explicit `listing` so that any regression removing the `listing ??`
// short-circuit turns these tests red (a real `docker export` against this name
// throws) instead of silently reaching for Docker in the unit cost class.
const NO_SUCH_CONTAINER = "rm-unit-test-no-such-container-000";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── probe.ts: the pure surface ──────────────────────────────────────────────
describe("probe.toContainerPath", () => {
  test("a tar member path becomes an absolute container path", () => {
    expect(toContainerPath("home/agent/keystore.json")).toBe("/home/agent/keystore.json");
  });

  test("an already-absolute path is returned unchanged (idempotent)", () => {
    expect(toContainerPath("/home/agent/keystore.json")).toBe("/home/agent/keystore.json");
    expect(toContainerPath(toContainerPath("home/agent/x"))).toBe("/home/agent/x");
  });
});

describe("probe.findByName / findMatching with an injected listing", () => {
  const listing = [
    "home/agent/.config/opencode/skills/committee-onboarding/SKILL.md",
    "usr/local/share/other/SKILL.md",
    "home/agent/NOT-SKILL.md",
    "home/agent/SKILL.md.bak",
    "root/.rmpc/committee-identity.json",
  ];

  test("matches a basename ANYWHERE in the filesystem — the documented loose-by-design behaviour", () => {
    expect(findByName(NO_SUCH_CONTAINER, "SKILL.md", listing)).toEqual([
      "home/agent/.config/opencode/skills/committee-onboarding/SKILL.md",
      "usr/local/share/other/SKILL.md",
    ]);
  });

  test("basename equality is exact — a longer name that merely CONTAINS the target does not match", () => {
    const hits = findByName(NO_SUCH_CONTAINER, "SKILL.md", listing);
    expect(hits).not.toContain("home/agent/NOT-SKILL.md");
    expect(hits).not.toContain("home/agent/SKILL.md.bak");
  });

  test("no match is an empty list, not a throw — absence is a real observation layers 1-2 assert on", () => {
    expect(findByName(NO_SUCH_CONTAINER, "nothing-like-this.md", listing)).toEqual([]);
  });

  test("findMatching tests the WHOLE path, not just the basename", () => {
    expect(findMatching(NO_SUCH_CONTAINER, /committee-onboarding/, listing)).toEqual([
      "home/agent/.config/opencode/skills/committee-onboarding/SKILL.md",
    ]);
  });

  test("a global regex does not lose alternate matches to lastIndex carry-over", () => {
    // /g regexes are stateful across .test() calls; a filter over several paths
    // is exactly where that bites, so pin the behaviour the finders rely on.
    expect(findMatching(NO_SUCH_CONTAINER, /SKILL\.md/g, listing).length).toBeGreaterThan(1);
  });
});

describe("probe.walk / fileSize", () => {
  test("walk returns every FILE recursively and no directory entries", () => {
    const root = tmpDir("probe-walk-");
    try {
      mkdirSync(join(root, "a", "b"), { recursive: true });
      writeFileSync(join(root, "top.txt"), "1");
      writeFileSync(join(root, "a", "mid.txt"), "22");
      writeFileSync(join(root, "a", "b", "deep.txt"), "333");
      const found = walk(root).map((p) => p.slice(root.length + 1)).sort();
      expect(found).toEqual([join("a", "b", "deep.txt"), join("a", "mid.txt"), "top.txt"].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("walk on a MISSING directory returns [] — extractMatching relies on this when tar matched nothing", () => {
    expect(walk(join(tmpdir(), "rm-unit-test-definitely-absent-dir-000"))).toEqual([]);
  });

  test("fileSize reports bytes, not characters", () => {
    const root = tmpDir("probe-size-");
    try {
      const p = join(root, "utf8.txt");
      writeFileSync(p, "é"); // 1 char, 2 bytes
      expect(fileSize(p)).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── signature-harvest.ts: candidate scanning ────────────────────────────────
describe("scanBase64Candidates", () => {
  const KEY = "A".repeat(43) + "="; // 44 chars → 32 raw bytes
  const SIG = "B".repeat(86) + "=="; // 88 chars → 64 raw bytes

  test("finds an ed25519-shaped key and signature embedded in prose", () => {
    const c = scanBase64Candidates(`the key is ${KEY} and the signature is ${SIG} ok`);
    expect(c.publicKeys).toEqual([KEY]);
    expect(c.signatures).toEqual([SIG]);
  });

  test("finds tokens inside JSON quoting — the shape a transcript actually carries", () => {
    const c = scanBase64Candidates(`{"publicKey":"${KEY}","signature":"${SIG}"}`);
    expect(c.publicKeys).toEqual([KEY]);
    expect(c.signatures).toEqual([SIG]);
  });

  test("de-duplicates repeats — a key echoed five times is one candidate", () => {
    const c = scanBase64Candidates(Array(5).fill(KEY).join("\n"));
    expect(c.publicKeys).toEqual([KEY]);
  });

  test("does NOT carve a spurious key out of a longer base64 blob (the lookaround guard)", () => {
    // A 200-char base64 body contains 44-char windows; without the
    // not-glued-to-base64 lookarounds every long blob would yield noise
    // candidates and burn the MAX_CANDIDATES budget on garbage.
    const blob = "C".repeat(200);
    const c = scanBase64Candidates(`payload=${blob}`);
    expect(c.publicKeys).toEqual([]);
    expect(c.signatures).toEqual([]);
  });

  // ── REGRESSION: the `key=value` blind spot (fixed 2026-07-26) ─────────────
  // The lookbehind used to exclude `=` alongside the base64 characters, so every
  // `publicKey=<b64>` / `PUBKEY=<b64>` / `--public-key=<b64>` / `signature=<b64>`
  // token was invisible. The member agent's opencode permissions are
  // `{"*": "deny", bash: "allow"}` — its transcript is SHELL OUTPUT, where that
  // shape is the norm — so the harvest could observe a perfectly good signature
  // and report "NO SIGNATURE MATERIAL ANYWHERE", turning a harness miss into
  // what reads as a product result. Each shape below is pinned individually.
  const KEY_VALUE_SHAPES: Array<[string, string, string]> = [
    ["a JSON-ish publicKey= assignment", `publicKey=${KEY}`, KEY],
    ["a shell export", `export PUBKEY=${KEY}`, KEY],
    ["a long-option flag", `rmpc apply --public-key=${KEY}`, KEY],
    ["an env-style line", `RMPC_PUBLIC_KEY=${KEY}`, KEY],
  ];
  for (const [what, text, expected] of KEY_VALUE_SHAPES) {
    test(`finds a key preceded by '=' — ${what}`, () => {
      expect(scanBase64Candidates(text).publicKeys).toEqual([expected]);
    });
  }

  test("finds a signature preceded by '=' — the same blind spot on the 88-char token", () => {
    expect(scanBase64Candidates(`signature=${SIG}`).signatures).toEqual([SIG]);
  });

  test("'=' is a token BOUNDARY: a padded blob followed by a real key yields the key", () => {
    // base64 padding is terminal, so whatever follows a `=` is a new token —
    // this must be harvested, while the blob itself must not produce noise.
    const c = scanBase64Candidates(`${"C".repeat(200)}=${KEY}`);
    expect(c.publicKeys).toEqual([KEY]);
  });

  test("relaxing the lookbehind did NOT make a signature yield a spurious key", () => {
    // The 88-char signature's own characters must never satisfy the 44-char key
    // pattern — the base64-char lookbehind is what still prevents that.
    expect(scanBase64Candidates(SIG).publicKeys).toEqual([]);
    expect(scanBase64Candidates(`sig=${SIG}`).publicKeys).toEqual([]);
  });

  test("wrong-length tokens are not candidates — only exactly 32-byte and 64-byte encodings", () => {
    const short = "D".repeat(42) + "="; // 43 chars
    const long = "E".repeat(44) + "="; // 45 chars
    const c = scanBase64Candidates(`${short} ${long}`);
    expect(c.publicKeys).toEqual([]);
    expect(c.signatures).toEqual([]);
  });

  test("a key is not mistaken for a signature, or vice versa", () => {
    expect(scanBase64Candidates(KEY).signatures).toEqual([]);
    expect(scanBase64Candidates(SIG).publicKeys).toEqual([]);
  });

  test("empty text yields empty candidate lists, not null", () => {
    expect(scanBase64Candidates("")).toEqual({ publicKeys: [], signatures: [] });
  });

  test("a REAL generated key and signature are both recognised", async () => {
    const { publicKeyB64, signatureB64 } = await realSignedApplication({ name: "N", contact: "c@example.test" });
    const c = scanBase64Candidates(`pub ${publicKeyB64}\nsig ${signatureB64}`);
    expect(c.publicKeys).toContain(publicKeyB64);
    expect(c.signatures).toContain(signatureB64);
  });
});

// ── The keystore path family and the harvest wildcards ──────────────────────
describe("KEYSTORE_PATH_PATTERN", () => {
  test("matches the plausible rmpc keystore shapes, case-insensitively", () => {
    for (const p of [
      "home/agent/.rmpc/identity.json",
      "home/agent/committee-identity.json",
      "home/agent/committee_identity.json",
      "home/agent/COMMITTEE-IDENTITY.JSON",
      "home/agent/.local/share/rmpc/keystore",
      "home/agent/rmpc-identity/key",
      "var/lib/identity.json",
    ]) {
      expect(KEYSTORE_PATH_PATTERN.test(p)).toBe(true);
    }
  });

  test("does not match unrelated container paths", () => {
    for (const p of ["usr/lib/node_modules/x/README.md", "home/agent/notes.txt", "etc/passwd"]) {
      expect(KEYSTORE_PATH_PATTERN.test(p)).toBe(false);
    }
  });
});

describe("HARVEST_FILE_PATTERNS", () => {
  test("no pattern is absolutely anchored — a leading slash matches nothing in a docker-export tar", () => {
    // `docker export` emits RELATIVE members (`home/agent/x`), and the harvest
    // passes these to `tar --wildcards --no-anchored`. A leading "/" would make
    // a pattern silently match zero members, which extractMatching tolerates as
    // "the agent produced no such file" — a false negative that would look like
    // a product result.
    expect(HARVEST_FILE_PATTERNS.length).toBeGreaterThan(0);
    for (const p of HARVEST_FILE_PATTERNS) expect(p.startsWith("/")).toBe(false);
  });

  test("covers both the opencode storage tree and the agent home", () => {
    const joined = HARVEST_FILE_PATTERNS.join(" ");
    expect(joined).toContain("opencode");
    expect(joined).toContain("home/agent/");
  });
});

// ── findApplicationPayloadOnDisk ────────────────────────────────────────────
describe("findApplicationPayloadOnDisk", () => {
  const canonical = '{"name":"N","contact":"c@example.test","publicKey":"K"}';

  test("returns the byte-exact canonical payload the agent left behind, trimmed", () => {
    const contents = new Map([["/x/payload.json", `  ${canonical}\n`]]);
    expect(findApplicationPayloadOnDisk(contents, canonical, "c@example.test")).toBe(canonical);
  });

  test("prefers the EXACT match over a merely payload-shaped file, whatever the iteration order", () => {
    const drifted = '{"contact":"c@example.test","name":"N","publicKey":"K"}'; // different key order
    const contents = new Map([
      ["/x/drifted.json", drifted],
      ["/x/exact.json", canonical],
    ]);
    expect(findApplicationPayloadOnDisk(contents, canonical, "c@example.test")).toBe(canonical);
  });

  test("falls back to a payload-SHAPED file so layer 3 can report drift instead of ignoring it", () => {
    const drifted = '{"contact":"c@example.test","lens":"x","name":"N","publicKey":"K"}';
    const contents = new Map([["/x/drifted.json", drifted]]);
    expect(findApplicationPayloadOnDisk(contents, canonical, "c@example.test")).toBe(drifted);
  });

  test("returns null when the agent left no payload file at all", () => {
    const contents = new Map([["/x/notes.txt", "I generated a key today"]]);
    expect(findApplicationPayloadOnDisk(contents, canonical, "c@example.test")).toBeNull();
  });

  test("a file mentioning the contact but not JSON-shaped is not a payload", () => {
    const contents = new Map([["/x/log.txt", "applied as c@example.test with publicKey ok"]]);
    expect(findApplicationPayloadOnDisk(contents, canonical, "c@example.test")).toBeNull();
  });

  test("an empty content map is null, not a throw", () => {
    expect(findApplicationPayloadOnDisk(new Map(), canonical, "c@example.test")).toBeNull();
  });
});

// ── explainHarvestFailure: the two reds must stay distinguishable ───────────
describe("explainHarvestFailure", () => {
  function diagnostics(over: Partial<HarvestDiagnostics> = {}): HarvestDiagnostics {
    return { candidatePublicKeys: 0, candidateSignatures: 0, filesScanned: 0, sources: ["transcript"], ...over };
  }

  test("no material at all names the likely cause and the sources searched", () => {
    const msg = explainHarvestFailure(diagnostics({ sources: ["transcript", "container-files(3)"] }));
    expect(msg).toContain("NO SIGNATURE MATERIAL ANYWHERE");
    expect(msg).toContain("transcript");
    expect(msg).toContain("container-files(3)");
  });

  test("material present but nothing verifying is a DIFFERENT red, and reports the counts", () => {
    const msg = explainHarvestFailure(diagnostics({ candidatePublicKeys: 2, candidateSignatures: 3 }));
    expect(msg).toContain("SIGNATURE MATERIAL FOUND BUT NOTHING VERIFIED");
    expect(msg).toContain("2 candidate public key");
    expect(msg).toContain("3 candidate signature");
    expect(msg).toContain("canonicalization drift");
  });

  test("the expected canonical shape is echoed, so a drift red is diagnosable from a CI log", () => {
    const shape = '{"name":"Ada","contact":"ada@example.test","publicKey":"<key>"}';
    const msg = explainHarvestFailure(diagnostics({ candidatePublicKeys: 1, candidateSignatures: 1, canonicalShapeExpected: shape }));
    expect(msg).toContain("The harness verified against exactly:");
    expect(msg).toContain(shape);
  });

  test("the shape line is omitted entirely when it is not known — no empty dangling label", () => {
    expect(explainHarvestFailure(diagnostics({ candidatePublicKeys: 1 }))).not.toContain("verified against exactly");
  });

  test("the two messages never collide — separating them is this function's whole job", () => {
    const none = explainHarvestFailure(diagnostics());
    const some = explainHarvestFailure(diagnostics({ candidatePublicKeys: 1, candidateSignatures: 1 }));
    expect(none).not.toBe(some);
  });

  test("a signature with no key still reads as 'found but unverified', not 'nothing anywhere'", () => {
    expect(explainHarvestFailure(diagnostics({ candidateSignatures: 1 }))).toContain("FOUND BUT NOTHING VERIFIED");
  });
});

// ── harvestSignedApplication: the whole pipeline, offline ───────────────────
// Uses the REAL backend key generation + signing helpers so the bytes under test
// are produced the same way a member's rmpc keypair produces them.
async function realSignedApplication(app: { name: string; contact: string }, payloadOverride?: object) {
  const signing = (await import(join(repoRoot, "backend", "src", "lib", "signing.ts"))) as {
    generateKeyPair: () => Promise<{ publicKeyB64: string; privateKey: CryptoKey }>;
    signMessage: (message: string, privateKey: CryptoKey) => Promise<string>;
  };
  const { publicKeyB64, privateKey } = await signing.generateKeyPair();
  const application = { ...app, publicKey: publicKeyB64 };
  const canonical = canonicalizeApplication(application);
  const signed = payloadOverride ? JSON.stringify({ ...payloadOverride, publicKey: publicKeyB64 }) : canonical;
  return { publicKeyB64, signatureB64: await signing.signMessage(signed, privateKey), canonical, application };
}

describe("harvestSignedApplication", () => {
  const application = { name: "Ada Lovelace", contact: "ada@example.test" };

  test("a genuine signature carried in the TRANSCRIPT verifies against the contract's canonical bytes", async () => {
    const { publicKeyB64, signatureB64, canonical } = await realSignedApplication(application);
    const hostDir = tmpDir("harvest-transcript-");
    try {
      const result = await harvestSignedApplication({
        repoRoot,
        transcript: `agent output\npublicKey=${publicKeyB64}\nsignature=${signatureB64}\ndone`,
        hostDir,
        application,
      });
      expect(result.verified).not.toBeNull();
      expect(result.verified!.publicKey).toBe(publicKeyB64);
      expect(result.verified!.signature).toBe(signatureB64);
      expect(result.verified!.canonicalPayloadExpected).toBe(canonical);
      expect(result.verified!.canonicalPayloadOnDisk).toBeNull(); // nothing on disk in this case
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  test("a signature found only in an EXTRACTED FILE verifies too — the transcript is not the only source", async () => {
    const { publicKeyB64, signatureB64, canonical } = await realSignedApplication(application);
    const hostDir = tmpDir("harvest-files-");
    try {
      mkdirSync(join(hostDir, "home", "agent"), { recursive: true });
      writeFileSync(join(hostDir, "home", "agent", "application.json"), canonical);
      writeFileSync(join(hostDir, "home", "agent", "sig.b64"), signatureB64);
      const result = await harvestSignedApplication({ repoRoot, transcript: "no base64 here", hostDir, application });
      expect(result.verified).not.toBeNull();
      expect(result.verified!.publicKey).toBe(publicKeyB64);
      // The agent's own copy of the signed bytes is reported back byte-exact.
      expect(result.verified!.canonicalPayloadOnDisk).toBe(canonical);
      expect(result.diagnostics.filesScanned).toBe(2);
      expect(result.diagnostics.sources).toContain("container-files(2)");
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  test("CANONICALIZATION DRIFT: a real signature over a DIFFERENT payload does not verify (and is never signed for)", async () => {
    // The agent signed {name, contact, lens, publicKey} instead of the canonical
    // three fields. Material is present, so this must land on the "found but
    // nothing verified" red — and the harness must NOT rescue it by re-signing.
    const { publicKeyB64, signatureB64 } = await realSignedApplication(application, {
      name: application.name,
      contact: application.contact,
      lens: "macro",
    });
    const hostDir = tmpDir("harvest-drift-");
    try {
      const result = await harvestSignedApplication({
        repoRoot,
        transcript: `${publicKeyB64}\n${signatureB64}`,
        hostDir,
        application,
      });
      expect(result.verified).toBeNull();
      expect(result.diagnostics.candidatePublicKeys).toBe(1);
      expect(result.diagnostics.candidateSignatures).toBe(1);
      expect(explainHarvestFailure(result.diagnostics)).toContain("FOUND BUT NOTHING VERIFIED");
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  test("a signature over the right payload but from ANOTHER key does not verify", async () => {
    const real = await realSignedApplication(application);
    const other = await realSignedApplication(application);
    const hostDir = tmpDir("harvest-wrongkey-");
    try {
      // Pair the first key with the second key's signature: both are genuine
      // ed25519 artifacts, and the pair must still be rejected.
      const result = await harvestSignedApplication({
        repoRoot,
        transcript: `${real.publicKeyB64}\n${other.signatureB64}`,
        hostDir,
        application,
      });
      expect(result.verified).toBeNull();
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  test("the CORRECT pair is still found when decoy candidates are present", async () => {
    const real = await realSignedApplication(application);
    const decoy = await realSignedApplication({ name: "Someone Else", contact: "other@example.test" });
    const hostDir = tmpDir("harvest-decoys-");
    try {
      const result = await harvestSignedApplication({
        repoRoot,
        transcript: [decoy.publicKeyB64, decoy.signatureB64, real.publicKeyB64, real.signatureB64].join("\n"),
        hostDir,
        application,
      });
      expect(result.verified).not.toBeNull();
      expect(result.verified!.publicKey).toBe(real.publicKeyB64);
      expect(result.verified!.signature).toBe(real.signatureB64);
      expect(result.diagnostics.candidatePublicKeys).toBe(2);
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  test("diagnostics carry the canonical shape for THIS applicant, with the key elided", async () => {
    const hostDir = tmpDir("harvest-shape-");
    try {
      const result = await harvestSignedApplication({ repoRoot, transcript: "", hostDir, application });
      const shape = result.diagnostics.canonicalShapeExpected!;
      expect(shape).toContain(application.name);
      expect(shape).toContain(application.contact);
      // Field ORDER is the whole point of a canonicalization check, so the
      // reported shape must be the contract's own ordering, not a re-spelling.
      expect(shape.indexOf('"name"')).toBeLessThan(shape.indexOf('"contact"'));
      expect(shape.indexOf('"contact"')).toBeLessThan(shape.indexOf('"publicKey"'));
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  test("no material anywhere yields a null verdict with zeroed diagnostics, never a throw", async () => {
    const hostDir = tmpDir("harvest-empty-");
    try {
      const result = await harvestSignedApplication({
        repoRoot,
        transcript: "the agent explained what it would do and stopped",
        hostDir,
        application,
      });
      expect(result.verified).toBeNull();
      expect(result.diagnostics.candidatePublicKeys).toBe(0);
      expect(result.diagnostics.candidateSignatures).toBe(0);
      expect(result.diagnostics.filesScanned).toBe(0);
      expect(explainHarvestFailure(result.diagnostics)).toContain("NO SIGNATURE MATERIAL ANYWHERE");
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  test("an oversized file is skipped, not scanned — the 2 MiB cap keeps a huge artifact from stalling the harvest", async () => {
    const { publicKeyB64, signatureB64 } = await realSignedApplication(application);
    const hostDir = tmpDir("harvest-big-");
    try {
      // The ONLY copy of the material sits inside a >2 MiB file, so if the cap
      // is honoured there is nothing left to verify.
      writeFileSync(join(hostDir, "huge.log"), `${"x".repeat(2 * 1024 * 1024 + 1)}\n${publicKeyB64}\n${signatureB64}`);
      const result = await harvestSignedApplication({ repoRoot, transcript: "", hostDir, application });
      expect(result.verified).toBeNull();
      expect(result.diagnostics.filesScanned).toBe(0);
      expect(result.diagnostics.candidatePublicKeys).toBe(0);
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  test("a binary/undecodable file is stepped over without failing the harvest", async () => {
    const { publicKeyB64, signatureB64 } = await realSignedApplication(application);
    const hostDir = tmpDir("harvest-binary-");
    try {
      writeFileSync(join(hostDir, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]));
      writeFileSync(join(hostDir, "sig.txt"), `${publicKeyB64}\n${signatureB64}`);
      const result = await harvestSignedApplication({ repoRoot, transcript: "", hostDir, application });
      expect(result.verified).not.toBeNull();
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  test("the verified pair is checked against the caller's identity — another applicant's bytes do not pass", async () => {
    // Same key and a genuine signature, but canonicalized over a DIFFERENT
    // contact than the one layer 3 is asking about.
    const other = await realSignedApplication({ name: "Someone Else", contact: "other@example.test" });
    const hostDir = tmpDir("harvest-identity-");
    try {
      const result = await harvestSignedApplication({
        repoRoot,
        transcript: `${other.publicKeyB64}\n${other.signatureB64}`,
        hostDir,
        application, // Ada, not "Someone Else"
      });
      expect(result.verified).toBeNull();
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });
});
