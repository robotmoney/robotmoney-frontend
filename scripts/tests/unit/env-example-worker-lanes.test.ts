// #1086: every lane name .env.example documents for WORKER_LANE is one
// `resolveLane` accepts, and every lane `resolveLane` accepts is documented.
// The retired `research` lane stayed in the example after the code dropped it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LANES, resolveLane } from "../../../backend/src/worker/lanes.ts";

const example = readFileSync(join(import.meta.dir, "..", "..", "..", ".env.example"), "utf8");

/** The names in the comment `one of a | b | c.` that introduces WORKER_LANE. */
function documentedLanes(): string[] {
  const block = example.match(/Execution lane[\s\S]*?one of\s*\n?#?\s*([a-z| ]+?)\.\s/);
  if (!block) throw new Error(".env.example no longer documents the WORKER_LANE lane names");
  return block[1]!.split("|").map((n) => n.trim()).filter(Boolean);
}

test(".env.example documents at least one lane", () => {
  expect(documentedLanes().length).toBeGreaterThan(0);
});

test("every lane .env.example documents is accepted by resolveLane", () => {
  for (const name of documentedLanes()) expect(resolveLane(name).name).toBe(name as keyof typeof LANES);
});

test("every lane resolveLane accepts is documented in .env.example", () => {
  expect(documentedLanes().sort()).toEqual(Object.keys(LANES).sort());
});
