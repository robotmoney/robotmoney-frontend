// The v0 archive artifact's own guards — the checks that decide whether a
// payload is allowed to reach a database at all. loadV0Archive()'s HAPPY path
// is covered by v0-seed-bootstrap.test.ts (which loads the real committed
// artifact on every run); what is asserted here is the REJECTION path, which
// had no coverage: a validator nobody proves rejects anything is a validator
// that quietly accepts everything.
//
// Pure file/parse level — no database, no network. Every case builds a real
// gzipped artifact + manifest pair in a temp directory and drives the exact
// loader production calls.
import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoCountRegression,
  computeChecksum,
  isV0ArchiveNonce,
  loadV0Archive,
  V0_ARCHIVE_FORMAT_VERSION,
  V0_ARCHIVE_NONCE_PREFIX,
  V0_ARCHIVE_PUBLIC_KEY_B64,
  V0_ARCHIVE_SIGNING_KEY_PKCS8_B64,
  type V0ArchiveManifest,
  type V0ArchivePayload,
} from "../src/swarm/v0-archive.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PAYLOAD: V0ArchivePayload = {
  members: [{ id: "athena" } as never],
  subjects: [{ id: "woon" } as never],
  sessions: [{ date: "2026-05-25", subject_id: "woon", takes: [] } as never],
  snapshots: [{ subject_id: "woon", date: "2026-05-25" } as never],
  briefs: [{ date: "2026-05-25", subject_id: "woon", body: {} }],
};

function countsOf(p: V0ArchivePayload): V0ArchiveManifest["counts"] {
  return {
    members: p.members.length,
    subjects: p.subjects.length,
    sessions: p.sessions.length,
    snapshots: p.snapshots.length,
    briefs: p.briefs.length,
  };
}

/** Write a real artifact/manifest pair, optionally corrupting the manifest. */
function writePair(
  payload: V0ArchivePayload,
  patch: Partial<V0ArchiveManifest> = {},
): { artifact: string; manifest: string } {
  const dir = mkdtempSync(join(tmpdir(), "v0-archive-"));
  dirs.push(dir);
  const canonicalText = JSON.stringify(payload);
  const manifest: V0ArchiveManifest = {
    formatVersion: V0_ARCHIVE_FORMAT_VERSION,
    sourceRepo: "https://github.com/agentjuno/robotmoney",
    sourceCommit: "0".repeat(40),
    extractedAt: "2026-08-05T00:00:00.000Z",
    counts: countsOf(payload),
    checksum: computeChecksum(canonicalText),
    ...patch,
  };
  const artifact = join(dir, "archive.json.gz");
  const manifestPath = join(dir, "archive.manifest.json");
  writeFileSync(artifact, gzipSync(Buffer.from(canonicalText, "utf8")));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { artifact, manifest: manifestPath };
}

test("a well-formed artifact loads", async () => {
  const { artifact, manifest } = writePair(PAYLOAD);
  const loaded = await loadV0Archive(artifact, manifest);
  expect(loaded.payload.sessions).toHaveLength(1);
  expect(loaded.manifest.counts.briefs).toBe(1);
});

// Each of these is a way the artifact can be wrong. None of them may load.
test("loadV0Archive rejects every shape of corruption, loudly", async () => {
  const bumped = { formatVersion: V0_ARCHIVE_FORMAT_VERSION + 1 };
  const wrongVersion = writePair(PAYLOAD, bumped);
  expect(loadV0Archive(wrongVersion.artifact, wrongVersion.manifest)).rejects.toThrow(/unsupported formatVersion/);

  // One manifest count lies, per dataset — the message must name the dataset,
  // or an operator cannot tell which half of the pair is wrong.
  for (const [dataset, pattern] of [
    ["members", /member\(s\) but manifest declares counts\.members/],
    ["subjects", /subject\(s\) but manifest declares counts\.subjects/],
    ["sessions", /session\(s\) but manifest declares counts\.sessions/],
    ["snapshots", /snapshot\(s\) but manifest declares counts\.snapshots/],
    ["briefs", /brief\(s\) but manifest declares counts\.briefs/],
  ] as const) {
    const counts = { ...countsOf(PAYLOAD), [dataset]: 99 };
    const bad = writePair(PAYLOAD, { counts });
    expect(loadV0Archive(bad.artifact, bad.manifest)).rejects.toThrow(pattern);
  }

  // Content edited after the manifest was written: every count still agrees,
  // and only the checksum catches it.
  const tampered = writePair(PAYLOAD, { checksum: "0".repeat(64) });
  expect(loadV0Archive(tampered.artifact, tampered.manifest)).rejects.toThrow(/checksum mismatch/);

  // Absent / unreadable files, which must never degrade to an empty load.
  const ok = writePair(PAYLOAD);
  expect(loadV0Archive(join(dirs[dirs.length - 1], "nope.json.gz"), ok.manifest)).rejects.toThrow(/archive not found/);
  expect(loadV0Archive(ok.artifact, join(dirs[dirs.length - 1], "nope.json"))).rejects.toThrow(/manifest not found/);

  const notGzip = mkdtempSync(join(tmpdir(), "v0-archive-"));
  dirs.push(notGzip);
  const plain = join(notGzip, "archive.json.gz");
  writeFileSync(plain, "this is not gzip");
  expect(loadV0Archive(plain, ok.manifest)).rejects.toThrow(/not valid gzip/);
});

// ── Under-extraction guard (review-data-integrity F5) ───────────────────────
//
// The manifest is derived from whatever regeneration just read, so it agrees
// with a short read perfectly. That is how 32 of 72 sessions and 0 briefs
// shipped once already, passing every self-consistency check on the way. The
// committed manifest is the only number that did not come from the new run.
test("regeneration is refused when it reads fewer rows than the committed artifact holds", () => {
  const committed = { members: 3, subjects: 4, sessions: 72, snapshots: 208, briefs: 73 };

  // The exact historical failure: a source checkout carrying a subset.
  expect(() => assertNoCountRegression({ ...committed, sessions: 32, snapshots: 0, briefs: 0 }, committed))
    .toThrow(/sessions: committed 72 -> read 32/);
  expect(() => assertNoCountRegression({ ...committed, sessions: 32, snapshots: 0, briefs: 0 }, committed))
    .toThrow(/briefs: committed 73 -> read 0/);
  // A single dataset shrinking is enough.
  expect(() => assertNoCountRegression({ ...committed, briefs: 72 }, committed)).toThrow(/allow-shrink/);

  // Growth and equality are unremarkable — v0 kept publishing.
  expect(() => assertNoCountRegression(committed, committed)).not.toThrow();
  expect(() => assertNoCountRegression({ ...committed, sessions: 80, briefs: 90 }, committed)).not.toThrow();
});

// ── Archival identity ───────────────────────────────────────────────────────
test("the archival nonce prefix is what marks a take as archive content", () => {
  expect(isV0ArchiveNonce(`${V0_ARCHIVE_NONCE_PREFIX}-2026-05-25-woon`)).toBe(true);
  // A live member submission's nonce is member-chosen and must never match.
  expect(isV0ArchiveNonce("9f2c1e0a-aaaa-bbbb-cccc-000000000001")).toBe(false);
  expect(isV0ArchiveNonce("v0-archiver-2026-05-25-woon")).toBe(false);
  expect(isV0ArchiveNonce(V0_ARCHIVE_NONCE_PREFIX)).toBe(false);
  // A query that did not select `nonce` reads as NOT archival — the safe
  // direction, since a live take can then never be mislabelled.
  expect(isV0ArchiveNonce(undefined)).toBe(false);
  expect(isV0ArchiveNonce(null)).toBe(false);
});

test("the published archival keypair is a real, matching Ed25519 pair", async () => {
  const priv = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(V0_ARCHIVE_SIGNING_KEY_PKCS8_B64, "base64"),
    "Ed25519",
    false,
    ["sign"],
  );
  const pub = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(Buffer.from(V0_ARCHIVE_PUBLIC_KEY_B64, "base64")),
    "Ed25519",
    false,
    ["verify"],
  );
  const msg = new TextEncoder().encode("v0 archival key pair check");
  const sig = await crypto.subtle.sign("Ed25519", priv, msg);
  // The committed public half must actually verify the committed private
  // half's output, or "signed with the published key" is an unverifiable
  // claim and F3 is only half fixed.
  expect(await crypto.subtle.verify("Ed25519", pub, sig, msg)).toBe(true);
  expect(Buffer.from(V0_ARCHIVE_PUBLIC_KEY_B64, "base64").length).toBe(32);
});
