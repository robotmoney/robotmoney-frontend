// scripts/tests/unit/release-host-tools.test.ts — the host's Bun against the
// checkout's lockfiles (issue 1528; scripts/release/host-tools.ts). The v0.7.0
// production preflight failed P03-install: Bun 1.3.14 could not read a
// lockfileVersion 2 bun.lock. host-identity.ts now refuses that host in every
// identity step, before any install.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bunRequirement, hostToolProblems, lockfileVersionOf, MIN_BUN_FOR_LOCKFILE } from "../../release/host-tools.ts";
import { lockfilePaths } from "../../release/lockfile.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

/** The head of a real bun.lock: version 2 is the release line's after `lockfile.ts refresh` (releases-0.7.x). */
const head = (v: number) => `{\n  "lockfileVersion": ${v},\n  "configVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "robotmoney-frontend-monorepo",\n    },\n  },\n}\n`;
const all = (v: number) => lockfilePaths().map((path) => ({ path, text: head(v) }));

describe("lockfileVersionOf", () => {
  test("reads 1 and 2 from the head of a bun.lock", () => {
    expect(lockfileVersionOf(head(1))).toBe(1);
    expect(lockfileVersionOf(head(2))).toBe(2);
    expect(lockfileVersionOf(head(9))).toBe(9);
  });

  test("reads main's committed lockfiles", () => {
    for (const path of lockfilePaths()) {
      const v = lockfileVersionOf(readFileSync(join(repoRoot, path), "utf8"));
      expect(v).toBeDefined();
      expect(MIN_BUN_FOR_LOCKFILE[v!]).toBeDefined();
    }
  });

  test("red: a text with no lockfileVersion reads as undefined", () => {
    expect(lockfileVersionOf(`{ "workspaces": {} }`)).toBeUndefined();
  });
});

describe("hostToolProblems", () => {
  test("bun 1.4.4 reads lockfileVersion 2 lockfiles", () => {
    expect(hostToolProblems({ bunVersion: "1.4.4", lockfiles: all(2) })).toEqual([]);
    expect(hostToolProblems({ bunVersion: "1.4.0", lockfiles: all(2) })).toEqual([]);
  });

  test("red: bun 1.3.14 cannot read a lockfileVersion 2 bun.lock (the v0.7.0 P03-install failure)", () => {
    const p = hostToolProblems({ bunVersion: "1.3.14", lockfiles: [{ path: "bun.lock", text: head(2) }] });
    expect(p).toEqual(["bun 1.3.14 cannot read bun.lock (lockfileVersion 2 needs bun >= 1.4.0); upgrade bun for this user on this host before the install step"]);
  });

  test("one problem per lockfile that is short; a version 1 lockfile beside it passes", () => {
    const lockfiles = [{ path: "bun.lock", text: head(2) }, { path: "backend/bun.lock", text: head(1) }, { path: "packages/analyst-sdk/bun.lock", text: head(2) }];
    const p = hostToolProblems({ bunVersion: "1.3.14", lockfiles });
    expect(p).toHaveLength(2);
    expect(p[0]).toContain("bun.lock (lockfileVersion 2");
    expect(p[1]).toContain("packages/analyst-sdk/bun.lock");
    expect(bunRequirement(lockfiles)).toEqual({ minimum: "1.4.0", from: "bun.lock" });
  });

  test("compares numerically: 1.10.0 passes a 1.4.0 minimum", () => {
    expect(hostToolProblems({ bunVersion: "1.10.0", lockfiles: all(2) })).toEqual([]);
  });

  test("red: an unknown lockfileVersion is a problem naming the table", () => {
    const p = hostToolProblems({ bunVersion: "1.10.0", lockfiles: [{ path: "bun.lock", text: head(9) }] });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("add its minimum bun to MIN_BUN_FOR_LOCKFILE");
  });

  test("a missing lockfile is skipped", () => {
    expect(hostToolProblems({ bunVersion: "1.3.14", lockfiles: [{ path: "bun.lock", text: undefined }] })).toEqual([]);
    expect(bunRequirement([{ path: "bun.lock", text: undefined }])).toEqual({ minimum: null, from: null });
  });
});

describe("imports: host-identity runs before bun install", () => {
  const importsOf = (rel: string) => readFileSync(join(repoRoot, rel), "utf8").split("\n").filter((l) => /^import\b/.test(l));

  test("host-identity.ts imports host-tools.ts", () => {
    expect(importsOf("scripts/release/host-identity.ts").some((l) => l.includes(`from "./host-tools.ts"`))).toBe(true);
  });

  test("host-tools.ts imports only node: built-ins and local modules", () => {
    for (const l of importsOf("scripts/release/host-tools.ts")) {
      const from = /from\s+"([^"]+)"/.exec(l)?.[1] ?? "";
      expect(from.startsWith("node:") || from.startsWith(".")).toBe(true);
    }
  });
});
