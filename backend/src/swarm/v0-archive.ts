// Loader for the committed v0 (robotmoney-site) Investment Committee archive
// (issue: production-bootstrap seed of pre-launch swarm content). Production
// cannot depend on v0's repo being checked out at runtime, so the three
// member personas, four subjects, and 32 historical per-subject sessions were
// extracted ONCE from robotmoney-site (read-only source) into a committed,
// gzipped fixture — same convention as the EDGAR/MNA seed
// (analytics/extract/edgar-seed.ts): a gzipped canonical JSON payload plus a
// sidecar manifest carrying provenance (source repo, source commit, extraction
// date) and a checksum so a corrupted/hand-edited artifact is caught loudly
// before ever reaching the database.
//
// Pure parsing/validation — no SQL, no network. scripts/v0-seed-bootstrap.ts
// is the only caller that writes the parsed rows to Postgres.
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

export const V0_ARCHIVE_FORMAT_VERSION = 1;

export interface V0Wallet {
  address: string;
  chain: string;
  label?: string;
  delegated_position?: unknown;
}

export interface V0Member {
  id: string;
  status: string;
  name: string;
  tagline: string | null;
  lens: string | null;
  mandate: string | null;
  biases: string[];
  voice_md: string;
  mode: string | null;
  submit: unknown;
  operator: string | null;
  avatar: unknown;
}

export interface V0Subject {
  id: string;
  status: string;
  name: string;
  operator: string | null;
  homepage: string | null;
  x_handle: string | null;
  thesis_blurb: string | null;
  wallets: V0Wallet[];
  nft_contracts: unknown[];
  source: unknown;
  recommendation_type: string | null;
  linked_member_id: string | null;
  structural_notes: string[];
  last_reviewed: string | null;
}

export interface V0Take {
  member_id: string;
  member_name?: string;
  mode?: string;
  stance?: string;
  confidence?: number;
  body?: string;
  model?: string;
  generated_at?: string;
  [key: string]: unknown;
}

export interface V0Session {
  date: string; // YYYY-MM-DD
  subject_id: string;
  subject_name: string | null;
  regime_summary: unknown;
  subject_snapshot_total_value_usd: number | null;
  takes: V0Take[];
  synthesis: string | null;
  committee_recommendation: unknown;
  social_draft_id: string | null;
  generated_at: string | null;
}

export interface V0ArchivePayload {
  members: V0Member[];
  subjects: V0Subject[];
  sessions: V0Session[];
}

export interface V0ArchiveManifest {
  formatVersion: number;
  sourceRepo: string;
  sourceCommit: string;
  extractedAt: string;
  counts: { members: number; subjects: number; sessions: number };
  checksum: string; // sha256 hex of the canonical decompressed JSON text
}

// The committed fixture location (same convention as
// analytics/extract/edgar-seed.ts's DEFAULT_EDGAR_SEED_PATH) — overridable via
// V0_ARCHIVE_PATH/V0_ARCHIVE_MANIFEST_PATH for tests.
export const DEFAULT_V0_ARCHIVE_PATH = new URL("../../seed-data/v0-committee-archive.json.gz", import.meta.url).pathname;
export const DEFAULT_V0_ARCHIVE_MANIFEST_PATH = new URL(
  "../../seed-data/v0-committee-archive.manifest.json",
  import.meta.url,
).pathname;

function resolveArchivePath(explicit?: string): string {
  return explicit || process.env.V0_ARCHIVE_PATH || DEFAULT_V0_ARCHIVE_PATH;
}
function resolveManifestPath(explicit?: string): string {
  return explicit || process.env.V0_ARCHIVE_MANIFEST_PATH || DEFAULT_V0_ARCHIVE_MANIFEST_PATH;
}

export function computeChecksum(canonicalText: string): string {
  return createHash("sha256").update(canonicalText, "utf8").digest("hex");
}

// Full structural + manifest-consistency validation. Throws with a
// descriptive message on the FIRST violation.
export function validateArchive(payload: V0ArchivePayload, manifest: V0ArchiveManifest, canonicalText: string): void {
  if (manifest.formatVersion !== V0_ARCHIVE_FORMAT_VERSION) {
    throw new Error(
      `v0 committee archive: unsupported formatVersion ${manifest.formatVersion} (expected ${V0_ARCHIVE_FORMAT_VERSION})`,
    );
  }
  if (!Array.isArray(payload.members) || payload.members.length !== manifest.counts.members) {
    throw new Error(
      `v0 committee archive: parsed ${payload.members?.length ?? 0} member(s) but manifest declares counts.members=${manifest.counts.members}`,
    );
  }
  if (!Array.isArray(payload.subjects) || payload.subjects.length !== manifest.counts.subjects) {
    throw new Error(
      `v0 committee archive: parsed ${payload.subjects?.length ?? 0} subject(s) but manifest declares counts.subjects=${manifest.counts.subjects}`,
    );
  }
  if (!Array.isArray(payload.sessions) || payload.sessions.length !== manifest.counts.sessions) {
    throw new Error(
      `v0 committee archive: parsed ${payload.sessions?.length ?? 0} session(s) but manifest declares counts.sessions=${manifest.counts.sessions}`,
    );
  }

  // Content checksum LAST, same rationale as edgar-seed.ts: every structural
  // check above is independent of this, and any byte-level change to the
  // canonical content always changes this digest.
  const checksum = computeChecksum(canonicalText);
  if (checksum !== manifest.checksum) {
    throw new Error(`v0 committee archive: checksum mismatch (computed ${checksum}, manifest declares ${manifest.checksum})`);
  }
}

// Load + FULLY VALIDATE the committed artifact. Fails loudly (never
// silent-skip) on a missing file, corrupt gzip, malformed manifest JSON, or
// any structural/checksum violation — always BEFORE returning.
export async function loadV0Archive(
  path?: string,
  manifestPath?: string,
): Promise<{ payload: V0ArchivePayload; manifest: V0ArchiveManifest }> {
  const p = resolveArchivePath(path);
  const mp = resolveManifestPath(manifestPath);

  const file = Bun.file(p);
  if (!(await file.exists())) {
    throw new Error(`v0 committee archive not found at ${p} — set V0_ARCHIVE_PATH or ship the committed seed`);
  }
  const manifestFile = Bun.file(mp);
  if (!(await manifestFile.exists())) {
    throw new Error(`v0 committee archive manifest not found at ${mp} — set V0_ARCHIVE_MANIFEST_PATH or ship the committed manifest`);
  }

  const gz = Buffer.from(await file.arrayBuffer());
  let canonicalText: string;
  try {
    canonicalText = gunzipSync(gz).toString("utf8");
  } catch (e) {
    throw new Error(`v0 committee archive at ${p} is not valid gzip: ${e instanceof Error ? e.message : e}`);
  }

  let manifest: V0ArchiveManifest;
  try {
    manifest = JSON.parse(await manifestFile.text()) as V0ArchiveManifest;
  } catch (e) {
    throw new Error(`v0 committee archive manifest at ${mp} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }

  let payload: V0ArchivePayload;
  try {
    payload = JSON.parse(canonicalText) as V0ArchivePayload;
  } catch (e) {
    throw new Error(`v0 committee archive at ${p} did not decompress to valid JSON: ${e instanceof Error ? e.message : e}`);
  }

  validateArchive(payload, manifest, canonicalText); // throws loudly on ANY corruption — before any DB write

  return { payload, manifest };
}
