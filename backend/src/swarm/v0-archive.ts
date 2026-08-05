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

// v2 (2026-08-05): adds `snapshots` and `briefs`. v1 carried members/subjects/
// sessions only, because it was extracted from robotmoney-site — a FORK 2015
// commits behind agentjuno/robotmoney, where neither dataset had ever been
// committed. The archive repo (robotmoney/v0-archive) now holds 208 snapshot
// files and 74 briefs alongside 72 sessions, so the artifact carries them too.
// There is no v1 compatibility path: the committed artifact is regenerated in
// the same commit as this bump, and loadV0Archive() rejects any other version.
export const V0_ARCHIVE_FORMAT_VERSION = 2;

// ── Archival take identity ──────────────────────────────────────────────────
//
// Two facts every consumer of an imported take needs, and neither of them can
// live in the importer alone: the WRITE side (scripts/v0-seed-bootstrap.ts)
// stamps them, and the READ side (src/swarm/projections.ts) has to recognise
// them. They live here, in the module both already depend on.
//
// The nonce prefix is what marks a swarm_recommendations row as archival —
// content published by v0 before member key registration existed, not a
// submission any member ever signed. It is the only durable marker: the rows
// are otherwise structurally identical to a live submission, which is the
// point (see processTake()).
export const V0_ARCHIVE_NONCE_PREFIX = "v0-archive";

/** True for a take imported from the v0 archive, by its nonce. */
export function isV0ArchiveNonce(nonce: unknown): boolean {
  return typeof nonce === "string" && nonce.startsWith(`${V0_ARCHIVE_NONCE_PREFIX}-`);
}

// THE ARCHIVAL SIGNING KEY, PUBLISHED IN FULL — private half included, on
// purpose. Read the next paragraph before treating this as a leaked secret.
//
// swarm_recommendations.signature is NOT NULL and means "the member signed
// this". v0's takes were never member-signed, so the import signs them with a
// key that is deliberately NOT registered in swarm_member_keys: the row is
// structurally honest (a real Ed25519 signature over the real canonical
// payload) and toVerifiedTake() still reports verified:false forever, because
// no member key can ever verify it.
//
// The first pass generated that key per run and threw it away. That made the
// signatures UNATTRIBUTABLE — nobody, including us, could say which key wrote
// a given archive row, so an import interrupted and resumed under a second
// key was undetectable. Publishing the key instead of hiding it fixes exactly
// that, and costs nothing: this key confers no authority anywhere in the
// system. It is not a member key, it cannot become one (registration is a
// separate, admin-gated path), the rows it signs are append-only and
// natural-key guarded so a forged signature cannot overwrite one, and every
// take it signs is rendered as archival rather than verified. What it buys is
// reproducibility: every deployment's archive rows carry byte-identical
// signatures, anyone can check them against the public half below, and
// `signature` can be drift-checked like any other column.
//
// V0_ARCHIVE_SIGNING_KEY still overrides it, for an operator who wants their
// own — at the cost of the reproducibility above.
export const V0_ARCHIVE_SIGNING_KEY_PKCS8_B64 =
  "MC4CAQAwBQYDK2VwBCIEIB2KmmJ5DX3eDP1gwX52sGQbHcL37wCZi98wxx/oeODZ";
/** Raw 32-byte public half — the encoding importEd25519PublicKey() accepts. */
export const V0_ARCHIVE_PUBLIC_KEY_B64 = "MbhCd0igTHYoNVTVPwjiG7lC64gOS1fNRvKC9/xd+1E=";

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

// One daily portfolio read for one subject, from
// public/data/committee/subjects/<subject_id>/<date>.json. Framework subjects
// (source.type === "framework") have nothing on-chain to read and contribute
// no snapshots at all — an absent subject here is correct, not missing data.
// Carried VERBATIM, including fields v1 has no column for (`fetched_at`,
// `source_type`). The artifact is a shipping format for v0's bytes, not a
// projection of v1's schema — dropping unmapped fields is the importer's job,
// at the point rows are written, so re-reading the artifact always shows what
// v0 actually published. Same reason V0Take keeps `model`/`usage`.
export interface V0Snapshot {
  subject_id: string;
  date: string; // YYYY-MM-DD
  total_value_usd: number | null;
  positions: unknown[];
  wallets: unknown[];
  notable: unknown[];
  [key: string]: unknown;
}

// The research/regime brief members received before a session, from
// public/data/committee/briefs/<date>-<subject_id>.json. `body` is stored
// whole: v0 never settled its shape and v1 reads it as opaque jsonb.
export interface V0Brief {
  date: string; // YYYY-MM-DD
  subject_id: string;
  body: unknown;
}

export interface V0ArchivePayload {
  members: V0Member[];
  subjects: V0Subject[];
  sessions: V0Session[];
  snapshots: V0Snapshot[];
  briefs: V0Brief[];
}

export interface V0ArchiveManifest {
  formatVersion: number;
  sourceRepo: string;
  sourceCommit: string;
  extractedAt: string;
  counts: { members: number; subjects: number; sessions: number; snapshots: number; briefs: number };
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

  if (!Array.isArray(payload.snapshots) || payload.snapshots.length !== manifest.counts.snapshots) {
    throw new Error(
      `v0 committee archive: parsed ${payload.snapshots?.length ?? 0} snapshot(s) but manifest declares counts.snapshots=${manifest.counts.snapshots}`,
    );
  }
  if (!Array.isArray(payload.briefs) || payload.briefs.length !== manifest.counts.briefs) {
    throw new Error(
      `v0 committee archive: parsed ${payload.briefs?.length ?? 0} brief(s) but manifest declares counts.briefs=${manifest.counts.briefs}`,
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

// ── Regression guard for regeneration (F5) ──────────────────────────────────
//
// validateArchive() above checks the payload against the manifest that was
// derived FROM THAT PAYLOAD. That makes it a corruption detector and nothing
// more: it is structurally incapable of noticing under-extraction, because a
// short read produces a manifest that agrees with it. That is precisely the
// failure this whole artifact exists to correct — the previous extraction read
// 32 of v0's 72 sessions, zero snapshots and zero briefs, and every
// self-consistency check it had passed.
//
// The only external reference point is the manifest already committed. A
// regeneration that reads FEWER rows than the committed artifact holds is a
// source problem until proven otherwise, so it is refused rather than written.
// Growth is unremarkable (v0 kept publishing); shrinkage needs a human saying
// so with --allow-shrink.
export function assertNoCountRegression(
  incoming: V0ArchiveManifest["counts"],
  committed: V0ArchiveManifest["counts"],
): void {
  const shrunk = (Object.keys(incoming) as (keyof V0ArchiveManifest["counts"])[])
    .filter((k) => incoming[k] < committed[k])
    .map((k) => `${k}: committed ${committed[k]} -> read ${incoming[k]}`);
  if (shrunk.length > 0) {
    throw new Error(
      `v0 committee archive: regeneration read fewer rows than the committed artifact holds — ` +
        `${shrunk.join(", ")}. This is what an incomplete source checkout looks like. ` +
        `Re-check --source, or pass --allow-shrink if the shrinkage is intended.`,
    );
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
