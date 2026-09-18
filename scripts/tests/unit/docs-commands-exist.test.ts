// Every command a CURRENT document tells an operator to run must exist.
//
// WHY THIS FILE EXISTS. Three separate rots, all found by hand on 2026-09-18,
// all of the same shape — a command name in prose that no `package.json` has:
//
//   1. The demo→smoke rename (9121367e) substituted twice over text that
//      already said "smoke", leaving `smoke:smoke:capture`,
//      `smoke:smoke-twin` and `smoke:smoke:smoke-twin --once` in README.md,
//      architecture.md, release-runbooks.md, rollout-procedure.md and five
//      source headers. 34 occurrences. Every one of them is a copy-paste that
//      ends in "script not found".
//   2. `rollout:where` — the FIRST command rollout-procedure.md tells an
//      operator to run, under the heading "run this before reading anything
//      else" — was subsumed by `backend/scripts/upgrades/runbook.ts` and the
//      script deleted. The document kept naming it.
//   3. `eval:onboarding:isolated` was deleted with its nightly workflow
//      (#378) while the evals it runs, and both documents naming it, stayed.
//
// None of this is catchable by review: a name like `smoke:smoke-twin` reads
// fine, and the only thing that knows it is wrong is `package.json`. So the
// check is mechanical, and it runs in the fast unit lane.
//
// SCOPE — current documents only. A superseded release runbook is a RECORD of
// what was run at the time, and `bun run demo` was real in v0.4.0; rewriting it
// would falsify history. Those live under the exemptions below and stay
// readable exactly as they were.
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

/** Every workspace whose `package.json` can define a documented script. */
const MANIFESTS = ["package.json", "backend/package.json", "contract/package.json", "frontend/package.json"];

/** Documents and sources that describe how the repo works TODAY. */
const CURRENT = [
  "README.md",
  "evals/README.md",
  "docs/architecture.md",
  "docs/decisions.md",
  "docs/runbooks/rollout-procedure.md",
  "docs/runbooks/deployment.md",
  "docs/runbooks/v0-5-0-rollout.md",
  "docs/technical/release-runbooks.md",
  "scripts/smoke-twin.ts",
  "scripts/smoke-twin-rehearse.ts",
  "scripts/lib/smoke-twin-rehearsal.ts",
  "backend/scripts/smoke-twin-capture.ts",
];

function knownScripts(): Set<string> {
  const out = new Set<string>();
  for (const m of MANIFESTS) {
    const p = join(repoRoot, m);
    if (!existsSync(p)) continue;
    for (const name of Object.keys(JSON.parse(readFileSync(p, "utf8")).scripts ?? {})) out.add(name);
  }
  return out;
}

/**
 * Script names referenced as `bun run <name>` in `text`.
 *
 * A name containing `/` or `.` is a PATH invocation (`bun run scripts/x.ts`),
 * not a script name, and `--cwd` is a flag — both are skipped. Trailing prose
 * punctuation is trimmed, because `…run `smoke:archive`.` is a sentence.
 */
export function referencedScripts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/bun run (?:--cwd \S+ )?([A-Za-z0-9:_.\/-]+)/g)) {
    const name = m[1]!.replace(/[.,;:)`'"]+$/, "");
    if (!name || name.startsWith("-") || name.includes("/") || name.includes(".")) continue;
    out.push(name);
  }
  return out;
}

describe("documented commands exist", () => {
  const known = knownScripts();

  for (const file of CURRENT) {
    test(`${file} names only real scripts`, () => {
      const path = join(repoRoot, file);
      expect(existsSync(path)).toBe(true);
      const missing = [...new Set(referencedScripts(readFileSync(path, "utf8")))].filter((n) => !known.has(n));
      expect(missing).toEqual([]);
    });
  }

  test("the four names the 2026-09-18 audit found are gone for good", () => {
    // Spelled out, because a regression here reads as a plausible command.
    for (const file of CURRENT) {
      const text = readFileSync(join(repoRoot, file), "utf8");
      expect({ file, mangled: /smoke:smoke/.test(text) }).toEqual({ file, mangled: false });
      expect({ file, retired: /bun run rollout:where/.test(text) }).toEqual({ file, retired: false });
    }
  });
});

describe("script names are invocable as written", () => {
  // `"smoke:twin --once"` was a real key: `bun run smoke:twin --once` does NOT
  // reach it (bun runs `smoke:twin` and passes `--once`, which smoke-twin.ts
  // rejects as an unknown flag), so the only way in was the quoted
  // `bun run "smoke:twin --once"` — which no document used. A name with a space
  // in it cannot be copy-pasted, so it must not be the name anything documents.
  test("no documented script name contains whitespace", () => {
    const known = knownScripts();
    const documented = new Set<string>();
    for (const file of CURRENT) {
      for (const n of referencedScripts(readFileSync(join(repoRoot, file), "utf8"))) documented.add(n);
    }
    const spaced = [...documented].filter((n) => /\s/.test(n));
    expect(spaced).toEqual([]);
    // …and the invocable alias for the rehearsal is present.
    expect(known.has("smoke:twin:once")).toBe(true);
  });
});

describe("referencedScripts", () => {
  test("reads a plain name", () => {
    expect(referencedScripts("run `bun run smoke:capture` first")).toEqual(["smoke:capture"]);
  });

  test("skips a path invocation, which is not a script name", () => {
    expect(referencedScripts("bun run scripts/smoke-e2e-assert.ts")).toEqual([]);
    expect(referencedScripts("bun run src/worker/index.ts")).toEqual([]);
  });

  test("looks through --cwd to the script it names", () => {
    expect(referencedScripts("bun run --cwd backend migrate")).toEqual(["migrate"]);
  });

  test("trims the sentence it sits in", () => {
    expect(referencedScripts("use `bun run smoke:archive`.")).toEqual(["smoke:archive"]);
    expect(referencedScripts("either bun run smoke:down, or stop it")).toEqual(["smoke:down"]);
  });
});
