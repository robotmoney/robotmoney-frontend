// Reading a format 1 archive from disk: the node:fs ArchiveFiles adapter for
// the pure reader core in src/archive/reader.ts (issue 1513). That module
// selects and checks the backups, then reads, inflates, hashes, row-counts and
// parses a listed file the first time a call needs it, and replays revised tables; this edge module only lists csv/ and
// reads bytes. bin/inputs.ts writes one run's input with it; the published-record
// replay (backend/tests/regime-replay-archive.test.ts, issue 1431) replays every
// regime run of an archive with the same reader, so there is one archive reader.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectRunInputs, openArchive, type ArchiveFiles, type Archive } from "../src/archive/reader.ts";

export { collectRunInputs };
export type { ArchiveFiles, Archive };

// An ArchiveFiles reader over a csv-backups folder.
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

// Open a csv-backups folder in place as of a backup id (or its newest backup).
export function openBackupsDir(root: string, asOf?: string): Archive {
  return openArchive(diskArchiveFiles(root), asOf);
}
