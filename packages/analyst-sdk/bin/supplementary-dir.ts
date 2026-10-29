// Reading and writing the supplementary directory: the file side of
// src/input/supplementary.ts (analyst SDK requirements section 4; D79). That
// module is pure and reads through an injected SupplementaryFiles; this edge
// module supplies the node:fs one, and hashes and writes the files.
//
// The supplementary directory is never the local copy and never inside it or
// around it: the local copy holds supported series exactly as csvb wrote them,
// and a supplementary series must not be mistaken for one. A directory that is,
// contains, or lies inside a format 1 local copy is refused.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BACKUP_ID_RE } from "../src/archive/format1.ts";
import type { Point } from "../src/types.ts";
import {
  formatSupplementaryCsv,
  openSupplementary,
  serializeSupplementaryManifest,
  supplementaryPaths,
  SupplementaryError,
  validateSupplementaryManifest,
  type SupplementaryFiles,
  type SupplementaryManifest,
  type SupplementarySeries,
} from "../src/input/supplementary.ts";

export type { SupplementarySeries };

const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

// A folder of backups: `<id>/backup.json` for some format 1 backup id.
function holdsBackups(dir: string): boolean {
  try {
    return readdirSync(dir).some((n) => BACKUP_ID_RE.test(n) && existsSync(join(dir, n, "backup.json")));
  } catch {
    return false;
  }
}

/** Throws unless `dir` is safe to use as a supplementary directory: not a local copy (`csv/<backup id>/backup.json`),
 *  not its `csv` folder or one of its backups, and inside none of them. */
export function assertSupplementaryDir(dir: string): void {
  const abs = resolve(dir);
  for (let d = abs; ; d = dirname(d)) {
    if (holdsBackups(join(d, "csv")) || holdsBackups(d) || existsSync(join(d, "backup.json"))) {
      throw new SupplementaryError(`${abs} is a local copy or inside one (${d}); keep supplementary series in their own directory`);
    }
    if (dirname(d) === d) return;
  }
}

/** The node:fs SupplementaryFiles over `dir`: the edge side of openSupplementary. */
export function supplementaryFiles(dir: string): SupplementaryFiles {
  return {
    label: dir,
    read: (path) => {
      const f = join(dir, path);
      return existsSync(f) ? new Uint8Array(readFileSync(f)) : null;
    },
    list: () => {
      if (!existsSync(dir)) return [];
      const out: string[] = [];
      for (const provider of readdirSync(dir, { withFileTypes: true })) {
        if (!provider.isDirectory()) continue;
        for (const name of readdirSync(join(dir, provider.name))) out.push(`${provider.name}/${name}`);
      }
      return out;
    },
  };
}

/** Read one series and check it against its manifest. A missing series names the command that fetches it. */
export function readSupplementary(dir: string, id: string): SupplementarySeries {
  return openSupplementary(supplementaryFiles(dir)).read(id);
}

/** Every source id with a series file in the directory, sorted. */
export function listSupplementary(dir: string): string[] {
  return openSupplementary(supplementaryFiles(dir)).list();
}

/** Write one series and its manifest. Refuses to replace an existing series unless `replace` is set; each file is
 *  written beside its target and renamed into place, so a failed write leaves the old pair. */
export function writeSupplementary(
  dir: string,
  id: string,
  points: readonly Point[],
  meta: { field: string; fetched_at: string; fetched_by: string },
  opts: { replace?: boolean } = {},
): SupplementaryManifest {
  assertSupplementaryDir(dir);
  const paths = supplementaryPaths(id);
  const file = join(dir, paths.file);
  const manifestFile = join(dir, paths.manifest);
  if (!opts.replace && (existsSync(file) || existsSync(manifestFile))) {
    throw new SupplementaryError(`${id}: ${file} exists; pass --replace to fetch it again`);
  }
  const bytes = new TextEncoder().encode(formatSupplementaryCsv(id, points));
  const manifest: SupplementaryManifest = {
    format: 1,
    series: id,
    field: meta.field,
    row_count: points.length,
    first_date: points[0]?.date ?? null,
    last_date: points.at(-1)?.date ?? null,
    sha256: sha256(bytes),
    fetched_at: meta.fetched_at,
    fetched_by: meta.fetched_by,
  };
  const text = serializeSupplementaryManifest(manifest);
  validateSupplementaryManifest(text, { series: id, sha256: manifest.sha256, points });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.part`, bytes);
  writeFileSync(`${manifestFile}.part`, text);
  renameSync(`${file}.part`, file);
  renameSync(`${manifestFile}.part`, manifestFile);
  return manifest;
}
