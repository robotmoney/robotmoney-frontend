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
  "docs/architecture/README.md",
  "docs/architecture/admin-surface.md",
  "docs/architecture/backend.md",
  "docs/architecture/configuration-delivery.md",
  "docs/architecture/dashboards-live-data.md",
  "docs/architecture/data-model.md",
  "docs/architecture/deployment.md",
  "docs/architecture/frontend.md",
  "docs/architecture/investment-swarm.md",
  "docs/architecture/member-onboarding.md",
  "docs/architecture/network-topology.md",
  "docs/architecture/projects-directory.md",
  "docs/architecture/repository-layout.md",
  "docs/architecture/task-queue-and-workers.md",
  "docs/architecture/vault-and-wallet.md",
  "docs/decisions.md",
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

// Spec §1 retires `smoke:archive` and `smoke:stage` "with no alias" (criterion
// 5). A document naming either is caught above, because no manifest defines
// them; this block pins the manifest half directly, so re-adding either key —
// even with no document pointing at it yet — goes red on its own.
const RETIRED_SCRIPTS = ["smoke:archive", "smoke:stage"];

/** Retired script keys a set of manifests (path → parsed JSON) still defines. */
function retiredScriptKeys(manifests: Record<string, { scripts?: Record<string, string> }>): string[] {
  return Object.entries(manifests).flatMap(([path, json]) =>
    RETIRED_SCRIPTS.filter((name) => name in (json.scripts ?? {})).map((name) => `${path}: ${name}`),
  );
}

describe("retired smoke scripts are defined by no manifest (spec §1)", () => {
  const manifests = Object.fromEntries(
    MANIFESTS.filter((m) => existsSync(join(repoRoot, m))).map((m) => [m, JSON.parse(readFileSync(join(repoRoot, m), "utf8"))]),
  );

  test("the scan reads the real root manifest, which defines `smoke`", () => {
    expect(Object.keys(manifests)).toContain("package.json");
    expect(Object.keys(manifests["package.json"].scripts ?? {})).toContain("smoke");
  });

  test("no manifest defines smoke:archive or smoke:stage", () => {
    expect(retiredScriptKeys(manifests)).toEqual([]);
  });

  test("the file the retired smoke:stage key ran is gone too", () => {
    expect(existsSync(join(repoRoot, "scripts", "smoke-stage.ts"))).toBe(false);
  });

  test("no CURRENT document tells an operator to `bun run` either name", () => {
    for (const file of CURRENT) {
      const named = referencedScripts(readFileSync(join(repoRoot, file), "utf8")).filter((n) => RETIRED_SCRIPTS.includes(n));
      expect({ file, named }).toEqual({ file, named: [] });
    }
  });

  test("red control: a manifest that re-adds either key is caught, naming the file", () => {
    const planted = {
      "package.json": { scripts: { smoke: "bun scripts/smoke.ts", "smoke:stage": "bun scripts/smoke-stage.ts" } },
      "backend/package.json": { scripts: { "smoke:archive": "bun x" } },
    };
    expect(retiredScriptKeys(planted)).toEqual(["package.json: smoke:stage", "backend/package.json: smoke:archive"]);
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
