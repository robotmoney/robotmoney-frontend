// The swarm archive's index (frontend/public/data/swarm/archive-index.json)
// lists exactly the snapshot and brief files the archive holds. The pages ask
// it before fetching (lib/swarm-archive.js), so a file the index names and the
// folder lacks is a 404 in every reader's console, and a file the folder holds
// and the index omits is data the pages never show.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../../frontend/public/data/swarm");
const stems = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();

describe("the swarm archive index", () => {
  const index = JSON.parse(readFileSync(join(root, "archive-index.json"), "utf8"));

  test("names every subject snapshot the archive holds, and no other", () => {
    const onDisk = Object.fromEntries(readdirSync(join(root, "subjects")).sort().map((s) => [s, stems(join(root, "subjects", s))]));
    expect(index.snapshots).toEqual(onDisk);
  });

  test("names every brief the archive holds, and no other", () => {
    expect(index.briefs).toEqual(stems(join(root, "briefs")));
  });
});
