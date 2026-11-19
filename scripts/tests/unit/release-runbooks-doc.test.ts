// scripts/tests/unit/release-runbooks-doc.test.ts — the release policy says
// what the runner does (issue 1684). It checks the load-bearing facts only, not
// prose, so a later rewording does not break it:
//   - §2 and §7: QA-branch fixes reach `main` after the production cutover;
//   - §3: an entry after the cutover entry names that backport to `main`;
//   - §4.2 or §9: a stage acceptance carries to production;
//   - §4.4: the runner tears stage down after a pass, and --keep-stage keeps it;
//   - §4.6: docs/** is check-only;
//   - §4.7: the deferred session grade's hand command passes --release;
//   - decisions.md: D86 records the boot-anchored hourly stage schedule.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const policy = readFileSync(join(root, "docs", "technical", "release-runbooks.md"), "utf8");
const decisions = readFileSync(join(root, "docs", "decisions.md"), "utf8");

/** The text of one heading's section, up to the next heading of the same or a higher level. */
function section(doc: string, heading: RegExp): string {
  const lines = doc.split("\n");
  const at = lines.findIndex((l) => heading.test(l));
  expect(at, String(heading)).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(lines[at]!)![0].length;
  const end = lines.findIndex((l, i) => i > at && /^#+ /.test(l) && /^#+/.exec(l)![0].length <= level);
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
}

/** Collapse line breaks, so a fact may wrap anywhere. */
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("the release policy says what the runner does (issue 1684)", () => {
  test("§2 and §7: QA-branch fixes reach main after the production cutover", () => {
    expect(flat(section(policy, /^## 2\. Branches/))).toContain("after the production cutover");
    expect(flat(section(policy, /^## 7\. Backporting/))).toContain("after the production cutover");
  });

  test("§3: an entry after the cutover entry names the backport to main", () => {
    const s = section(policy, /^## 3\. Release candidates/);
    const entries = [...s.matchAll(/^(\d+)\. \*\*([^*]+)\*\*/gm)].map((m) => ({ n: Number(m[1]), title: m[2]!, at: m.index! }));
    const cutover = entries.find((e) => /cutover starts/i.test(e.title));
    expect(cutover).toBeDefined();
    const next = entries.find((e) => e.n === cutover!.n + 1);
    expect(next).toBeDefined();
    const body = flat(s.slice(next!.at, s.indexOf("\n\n", next!.at)));
    expect(body).toContain("`main`");
    expect(body).toMatch(/production cutover/);
  });

  test("§4.2 or §9: a stage acceptance carries to production", () => {
    const text = flat(`${section(policy, /^### 4\.2\. Preflight/)}\n${section(policy, /^## 9\. Standing check IDs/)}`);
    expect(text).toMatch(/accept\w* [^.|]*carr(y|ies) to production/i);
  });

  test("§4.4 names --keep-stage", () => {
    expect(section(policy, /^### 4\.4\. Stage QA/)).toContain("--keep-stage");
  });

  test("§4.6 names docs/** as check-only", () => {
    expect(section(policy, /^### 4\.6\. Fix loop/)).toContain("`docs/**`");
  });

  test("§4.7: the deferred session grade's hand command passes --release", () => {
    const cmds = [...section(policy, /^### 4\.7\. Production execution/).matchAll(/`(bun run prod:gate --mode post-release[^`]*)`/g)].map((m) => m[1]!);
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) expect(c).toMatch(/--release v\S+/);
  });

  test("decisions.md: D86 records the boot-anchored hourly stage schedule", () => {
    const d86 = flat(section(decisions, /^## D86 /));
    expect(d86).toMatch(/hourly/);
    expect(d86).toMatch(/boot/);
    expect(d86).toMatch(/stage/i);
    expect(decisions).toContain('<a id="d86"></a>');
  });
});
