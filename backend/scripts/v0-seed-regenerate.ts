// Explicit v0 committee seed regeneration command. The ONLY way the committed
// artifact + manifest pair is ever produced or replaced — NEVER implicit during
// migrations, bootstrap, demo boot, or CI (no other code path imports this
// file). Same convention as scripts/edgar-seed-regenerate.ts.
//
// WHY THIS EXISTS. The v1 seed artifact was originally extracted once, by hand,
// with no committed tooling — so it could not be refreshed, and nobody could
// re-derive it to check what it contained. That is how it came to hold 32 of
// v0's 72 sessions and none of its briefs or snapshots: the extraction was run
// against robotmoney-site, a FORK 2015 commits behind agentjuno/robotmoney.
//
// SOURCE OF TRUTH is robotmoney/v0-archive — a read-only, verbatim copy of what
// v0 published, itself collected from agentjuno/robotmoney by v0's own backup
// tooling. This script reads a CHECKOUT of that repo and reshapes it into one
// gzipped artifact. It copies bytes; it does not interpret them:
//
//   * every field v0 wrote is carried through, INCLUDING fields v1 has no
//     column for (take.model, take.usage, snapshot.fetched_at,
//     snapshot.source_type). Dropping unmapped fields is the importer's job.
//   * NOTHING is added. No signatures, no nonces, no provenance stamps inside
//     the payload. Signing legacy takes is something v0-seed-bootstrap.ts does
//     when it writes swarm_recommendations rows, so the archive keeps saying
//     exactly what v0 said.
//
// Usage:
//   bun run scripts/v0-seed-regenerate.ts --source /path/to/v0-archive
//   bun run scripts/v0-seed-regenerate.ts --source ../v0-archive --dry-run
//
// --source must be a checkout of robotmoney/v0-archive (the directory holding
// manifest.json and current/). Its manifest.json supplies the provenance
// recorded here, so the artifact always names the commit of agentjuno/robotmoney
// the data actually came from rather than a local filesystem path.
import { readdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  DEFAULT_V0_ARCHIVE_PATH,
  DEFAULT_V0_ARCHIVE_MANIFEST_PATH,
  V0_ARCHIVE_FORMAT_VERSION,
  computeChecksum,
  loadV0Archive,
  type V0ArchivePayload,
  type V0ArchiveManifest,
  type V0Member,
  type V0Subject,
  type V0Session,
  type V0Snapshot,
  type V0Brief,
} from "../src/swarm/v0-archive.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// Directory listing that is STABLE and LOUD: sorted so the artifact's byte
// content (and therefore its checksum) does not depend on filesystem order,
// and throwing rather than returning [] so a renamed/missing source directory
// can never silently produce an artifact with a whole dataset absent — the
// exact failure that shipped 0 briefs and 0 snapshots last time.
function listJson(dir: string): string[] {
  if (!existsSync(dir)) {
    throw new Error(`v0-seed-regenerate: expected source directory not found: ${dir}`);
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .sort();
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readMembers(root: string): V0Member[] {
  const dir = join(root, "current/data/committee/members");
  return listJson(dir).map((f) => {
    const raw = readJson<Record<string, unknown>>(join(dir, f));
    // voice_doc points at a path inside v0's repo; v1 stores the prose itself
    // in swarm_members.voice_md, so the sibling .voice.md is inlined here.
    // Absent is legal (a member may have no voice doc); unreadable is not.
    const voicePath = join(dir, f.replace(/\.json$/, ".voice.md"));
    const voice_md = existsSync(voicePath) ? readFileSync(voicePath, "utf8") : "";
    return { ...raw, voice_md } as unknown as V0Member;
  });
}

function readSubjects(root: string): V0Subject[] {
  const dir = join(root, "current/data/committee/subjects");
  return listJson(dir).map((f) => readJson<V0Subject>(join(dir, f)));
}

function readSessions(root: string): V0Session[] {
  const dir = join(root, "current/public/data/committee/sessions");
  return listJson(dir)
    .map((f) => readJson<V0Session>(join(dir, f)))
    .sort((a, b) => (a.date + a.subject_id).localeCompare(b.date + b.subject_id));
}

// One row per <subject_id>/<date>.json. Framework subjects have no directory
// here at all and contribute nothing — correct, not missing: they hold no
// portfolio to read.
function readSnapshots(root: string): V0Snapshot[] {
  const base = join(root, "current/public/data/committee/subjects");
  if (!existsSync(base)) {
    throw new Error(`v0-seed-regenerate: expected source directory not found: ${base}`);
  }
  const out: V0Snapshot[] = [];
  for (const subjectId of readdirSync(base).filter((d) => !d.startsWith("_")).sort()) {
    const dir = join(base, subjectId);
    for (const f of listJson(dir)) {
      const raw = readJson<Record<string, unknown>>(join(dir, f));
      // subject_id/date are already inside every file v0 wrote; fall back to
      // the path only if a file ever omits them.
      out.push({
        ...raw,
        subject_id: (raw.subject_id as string) ?? subjectId,
        date: (raw.date as string) ?? f.replace(/\.json$/, ""),
      } as unknown as V0Snapshot);
    }
  }
  return out;
}

// <date>-<subject_id>.json, whose ENTIRE contents are the brief body — v1's
// swarm_briefs.body is opaque jsonb, so the file is stored whole and date /
// subject_id are lifted out as the natural key.
//
// DELIBERATELY NOT INCLUDED: the briefs/today/ subdirectory. Those are v0's
// PER-MEMBER briefs (athena.json, robotmoney.json, woon.json), overwritten
// every day, so only the final day ever existed on disk. v1 keys briefs by
// (date, subject_id) with no per-member dimension, so there is nowhere honest
// to put them. They remain in robotmoney/v0-archive verbatim; they are simply
// not imported. listJson() ignores subdirectories, which is why this is a
// comment rather than a filter — but it is a decision, not an oversight.
function readBriefs(root: string): V0Brief[] {
  const dir = join(root, "current/public/data/committee/briefs");
  return listJson(dir).map((f) => {
    const body = readJson<Record<string, unknown>>(join(dir, f));
    const m = /^(\d{4}-\d{2}-\d{2})-(.+)\.json$/.exec(f);
    const date = (body.date as string) ?? m?.[1];
    const subject_id = (body.subject_id as string) ?? m?.[2];
    if (!date || !subject_id) {
      throw new Error(`v0-seed-regenerate: cannot derive date/subject_id for brief ${f}`);
    }
    return { date, subject_id, body };
  });
}

export async function main(): Promise<void> {
  const source = arg("source");
  if (!source) {
    console.error("usage: bun run scripts/v0-seed-regenerate.ts --source <v0-archive checkout> [--dry-run]");
    process.exitCode = 1;
    return;
  }

  const sourceManifestPath = join(source, "manifest.json");
  if (!existsSync(sourceManifestPath)) {
    console.error(`[v0-seed-regenerate] ${sourceManifestPath} not found — is --source a checkout of robotmoney/v0-archive?`);
    process.exitCode = 1;
    return;
  }
  const sourceManifest = readJson<{ repoHeadSha?: string }>(sourceManifestPath);
  if (!sourceManifest.repoHeadSha) {
    console.error(`[v0-seed-regenerate] ${sourceManifestPath} has no repoHeadSha — refusing to write an artifact with unknown provenance`);
    process.exitCode = 1;
    return;
  }

  console.log(`[v0-seed-regenerate] reading v0 archive from ${source} ...`);
  const payload: V0ArchivePayload = {
    members: readMembers(source),
    subjects: readSubjects(source),
    sessions: readSessions(source),
    snapshots: readSnapshots(source),
    briefs: readBriefs(source),
  };

  const takes = payload.sessions.reduce((n, s) => n + (s.takes?.length ?? 0), 0);
  console.log(
    `[v0-seed-regenerate] members=${payload.members.length} subjects=${payload.subjects.length} ` +
      `sessions=${payload.sessions.length} (takes=${takes}) snapshots=${payload.snapshots.length} briefs=${payload.briefs.length}`,
  );

  const canonicalText = JSON.stringify(payload);
  const manifest: V0ArchiveManifest = {
    formatVersion: V0_ARCHIVE_FORMAT_VERSION,
    // The upstream repo the data actually came from, NOT a local path. The
    // previous manifest recorded "/drive2/home/lucas/robotmoney/robotmoney-site",
    // which named a machine rather than a source and hid that it was a fork.
    sourceRepo: "https://github.com/agentjuno/robotmoney",
    sourceCommit: sourceManifest.repoHeadSha,
    extractedAt: new Date().toISOString(),
    counts: {
      members: payload.members.length,
      subjects: payload.subjects.length,
      sessions: payload.sessions.length,
      snapshots: payload.snapshots.length,
      briefs: payload.briefs.length,
    },
    checksum: computeChecksum(canonicalText),
  };

  if (flag("dry-run")) {
    console.log("[v0-seed-regenerate] --dry-run: nothing written. Manifest would be:");
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  // Write to temp siblings, validate through the EXACT path the loader uses,
  // and only then move both into place — so a failed regeneration can never
  // leave a half-replaced artifact/manifest pair behind.
  const tmpArtifact = `${DEFAULT_V0_ARCHIVE_PATH}.tmp`;
  const tmpManifest = `${DEFAULT_V0_ARCHIVE_MANIFEST_PATH}.tmp`;
  writeFileSync(tmpArtifact, gzipSync(Buffer.from(canonicalText, "utf8"), { level: 9 }));
  writeFileSync(tmpManifest, `${JSON.stringify(manifest, null, 2)}\n`);

  await loadV0Archive(tmpArtifact, tmpManifest); // throws on ANY structural/checksum violation

  renameSync(tmpArtifact, DEFAULT_V0_ARCHIVE_PATH);
  renameSync(tmpManifest, DEFAULT_V0_ARCHIVE_MANIFEST_PATH);

  console.log(`[v0-seed-regenerate] wrote ${DEFAULT_V0_ARCHIVE_PATH}`);
  console.log(`[v0-seed-regenerate] wrote ${DEFAULT_V0_ARCHIVE_MANIFEST_PATH}`);
  console.log(JSON.stringify(manifest, null, 2));
}

if (import.meta.main) await main();
