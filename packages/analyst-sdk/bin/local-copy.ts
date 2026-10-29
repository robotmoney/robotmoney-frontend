// Reading a format 1 local copy from disk: the node:fs ArchiveFiles adapter for
// the pure reader core in src/archive/local-copy.ts (issue 1513). That module
// selects and checks the backups, inflates, hashes, row-counts and parses the
// listed files, and replays revised tables; this edge module only lists csv/ and
// reads bytes. bin/inputs.ts writes one run's input with it; the published-record
// replay (backend/tests/regime-replay-archive.test.ts, issue 1431) replays every
// regime run of a copy with the same reader, so there is one archive reader.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectRunInputs, openArchive, type ArchiveFiles, type LocalCopy } from "../src/archive/local-copy.ts";

export { collectRunInputs };
export type { ArchiveFiles, LocalCopy };

// An ArchiveFiles reader over a local copy directory.
export function diskArchiveFiles(root: string): ArchiveFiles {
  return {
    root,
    backupDirs: () => {
      const csvDir = join(root, "csv");
      return existsSync(csvDir) ? readdirSync(csvDir) : null;
    },
    read: (path) => {
      const abs = join(root, path);
      return existsSync(abs) ? readFileSync(abs) : null;
    },
  };
}

// Open and verify a local copy directory as of a backup id (or its newest backup).
export function openLocalCopy(root: string, asOf?: string): LocalCopy {
  return openArchive(diskArchiveFiles(root), asOf);
}
