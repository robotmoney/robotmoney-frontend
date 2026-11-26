// Reading a universe file from disk (issue 1400; moved to the node edge in
// issue 1765). src/allocate/universe.ts is pure: it ships the Base asset
// universe as a static JSON import and checks a member's own file when handed
// it as parsed JSON. This edge module reads that file. bin/universe-option.ts
// calls it for `--universe <path>`.
import { loadUniverse, type Universe } from "../src/allocate/universe.ts";

/** The universe in the JSON file at `path`, checked by loadUniverse. An unreadable file or bad JSON throws. */
export async function universeFromFile(path: string): Promise<Universe> {
  return loadUniverse(JSON.parse(await Bun.file(path).text()));
}
