// D54 (issue #1026 W7, criterion 157): a decision entry records that the static
// website is its own release unit — it declares the API versions it accepts,
// the API reports its version, and deploying either side checks the other — and
// the smoke spec gains a website-lifecycle section carrying the same rules.
//
// Each rule is a pattern that must match BOTH the D54 entry in
// docs/decisions.md and §13 of docs/technical/smoke-production-spec.md, so the
// two cannot drift into saying different things. The red controls feed the
// same checker a copy with one rule cut out and require it to name that rule.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const decisions = readFileSync(join(repoRoot, "docs/decisions.md"), "utf8");
const spec = readFileSync(join(repoRoot, "docs/technical/smoke-production-spec.md"), "utf8");

/** Text from a heading line to the next heading of the same level (or EOF). */
function section(text: string, headingStart: string, level: "## " | "### "): string {
  const at = text.indexOf(`\n${headingStart}`);
  if (at === -1) return "";
  const rest = text.slice(at + 1);
  const next = rest.slice(1).search(new RegExp(`\\n${level.replace(/ /g, " ")}(?!#)`));
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Collapse whitespace so a rule may wrap across lines in the Markdown. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const d54 = flat(section(decisions, "## D54", "## "));
const s13 = flat(section(spec, "## 13. Website lifecycle", "## "));
const s10 = flat(section(spec, "## 10. Acceptance gates", "## "));

// The rules both documents must state. Patterns are deliberately about the
// rule, not the wording around it.
const RULES: Record<string, RegExp> = {
  "own release unit": /its own release unit/i,
  "site declares a range in frontend/package.json apiRange": /`frontend\/package\.json`[^.]*`apiRange`/,
  "/version.json carries the range": /`\/version\.json` carries/,
  "api version is contract/package.json's version": /API version is `contract\/package\.json`'s version|It is `contract\/package\.json`'s version/,
  "GET /api/version answers {api, commit}": /`GET \/api\/version` answers `\{api, commit\}`/,
  "no credential, no database": /no credential[^.]*(database)/i,
  "routes.js change needs a bump against the merge base": /change to `contract\/src\/routes\.js`[^.]*greater `contract\/package\.json` version[^.]*merge base/,
  "smoke:web builds into a versioned dir under the instance state dir": /builds the site into a versioned directory under the instance state directory/,
  "smoke:web refuses a running API outside the site's range": /refuses when (the running API's version|that version) is outside the new site's range/,
  "smoke:web switches atomically with an nginx reload": /atomic[^.]*nginx reload|reloads nginx\. The switch is atomic/,
  "smoke:web restarts no api or worker": /restarts no `api` or worker container/,
  "smoke:web writes its own journal and receipt under web/": /its own journal and receipt under the instance's `web\/` directory/,
  "smoke:web --rollback returns to the previous dir": /`bun smoke:web --rollback` returns[^.]*previous directory/,
  "smoke refuses an API outside the live site's range": /refuse[s]? [^.]*(API|version) [^.]*outside the live site's range/,
  "unless the same plan deploys a site that admits it": /unless the same plan deploys a site whose range includes that version/,
  "no declared range counts as outside every range": /no declared range counts as outside every range/,
  "the page checks at load": /page reads its own range from `\/version\.json` and the API's version from `\/api\/version`/,
  "reload notice and no other /api/* call": /reload notice and makes no other `\/api\/\*` call/,
  "T26 named as open, pointing at the issue": /(T26[^]*not decided|not decided here \(T26\))[^]*issue #1026/,
};

function missingRules(text: string): string[] {
  return Object.entries(RULES).filter(([, re]) => !re.test(text)).map(([name]) => name);
}

describe("D54 records the website as its own release unit", () => {
  test("the entry exists, is accepted, and names the owner's 2026-09-24 approval", () => {
    expect(d54).toContain("## D54 — The static website is its own release unit");
    expect(d54).toMatch(/\*\*Status\.\*\* Accepted 2026-09-24/);
    expect(d54).toMatch(/approved workstream W7 on issue #1026/);
  });

  test("the entry carries every rule", () => {
    expect(missingRules(d54)).toEqual([]);
  });

  test("the T26 question is left open, not decided", () => {
    expect(d54).toMatch(/Open question, not decided here \(T26\)/);
    expect(d54).toMatch(/`_static`/);
  });
});

describe("the smoke spec's website-lifecycle section", () => {
  test("§13 exists and carries every rule", () => {
    expect(s13).toContain("## 13. Website lifecycle");
    expect(s13).toContain("[D54](../decisions.md#d54)");
    expect(missingRules(s13)).toEqual([]);
  });

  test("§10 lists the W7 gates, and every test file a gate names exists", () => {
    expect(s10).toContain("**W7 website lifecycle (§13, D54)**");
    const w7 = s10.slice(s10.indexOf("**W7 website lifecycle"));
    const files = [...w7.matchAll(/\(`([^`]+\.(?:test|spec)\.ts)`\)/g)].map((m) => m[1]!);
    expect(files.sort()).toEqual([
      "backend/tests/api-version-endpoint.test.ts",
      "frontend/test/browser/api-range-mismatch.spec.ts",
      "scripts/tests/integration/website-server-api-version.test.ts",
      "scripts/tests/unit/contract-version-bump.test.ts",
      "scripts/tests/unit/web-client-api-range.test.ts",
    ]);
    for (const f of files) expect({ f, exists: existsSync(join(repoRoot, f)) }).toEqual({ f, exists: true });
    // The deploy-tool gates arrive with the tooling; they are listed now so the
    // tooling has a target, and name no file yet.
    expect(w7).toMatch(/`bun smoke:web` refuses/);
    expect(w7).toMatch(/`bun smoke` refuses an API outside the live site's range/);
    expect(w7).toMatch(/Rolling:/);
  });

  test("the new command is written as `bun smoke:web`, never `bun run smoke:web`", () => {
    // docs-commands-exist.test.ts resolves every `bun run <name>` against the
    // manifests, and smoke:web does not exist until its tooling lands.
    expect(d54 + s13 + s10).not.toMatch(/bun run smoke:web/);
    expect(d54).toContain("`bun smoke:web`");
  });
});

describe("red controls: the checker names a rule that goes missing", () => {
  test("cutting the 'unless the same plan' exception out of the entry is caught", () => {
    const cut = d54.replace(/unless the same plan deploys a site whose range includes that version/, "");
    expect(cut).not.toBe(d54);
    expect(missingRules(cut)).toEqual(["unless the same plan deploys a site that admits it"]);
  });

  test("a section that forgets the api/worker restart rule is caught", () => {
    const cut = s13.replace(/restarts no `api` or worker container/, "restarts what it needs");
    expect(cut).not.toBe(s13);
    expect(missingRules(cut)).toEqual(["smoke:web restarts no api or worker"]);
  });

  test("an empty document misses every rule", () => {
    expect(missingRules("")).toEqual(Object.keys(RULES));
  });
});
