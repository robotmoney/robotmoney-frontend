// NO SCRIPT ENABLES THE JUDGE (issue #1026, D48 as waived by D53).
//
// This file used to pin that setJudgeMode() refused to enable the judge
// without naming a model in the same request (migration 0056 constrains the
// mode/model PAIR, and a two-step `off -> shadow` once turned the GitHub e2e
// red). setJudgeMode() is gone: nothing on a booted stack judges inline, the
// judge is a participant (smoke spec §6.2), and the only writer of
// `swarm_judge_config` is the admin route itself (§6.2: "nothing but the admin
// route writes `swarm_judge_config`"). The pair constraint stays in the schema.
//
// What this file pins now is the stronger fact: no script in the repo enables
// the judge at all, in one step or two, and none can write `shadow`. It walks
// the trees rather than naming files, proves the walk reaches real code, and
// plants the retired shapes to show the scan catches them.
//
// SCOPE: SCRIPTS ONLY — this is the driver half of criterion 6, not all of it.
// The admin route (backend/src/api/routes/swarm-admin.ts) no longer accepts
// `shadow` — D53 item 1 removed it: the route refuses any mode but
// `off|enforce`, and `swarm/judge-config.ts`, the one writer of the row,
// stores `off` wherever a legacy `shadow` stood. That half is pinned in the
// backend suite, against the route and the registry. The column CHECK does
// NOT forbid it yet: `swarm_judge_config_mode_check` still admits
// off|shadow|enforce (backend/schema/snapshot.sql, through migration 0078).
// Tightening it to off|enforce is pending, in a separate migration owned by the
// wave's migration package. This file claims only the scripts: no driver
// enables the judge or names `shadow`.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

// Scripts only: backend/src is where the admin route that legitimately writes
// the row lives, and its behaviour is owned by the backend suite.
const scanRoots = ["scripts/lib", "scripts/agent", "backend/scripts"];
const files = scanRoots
  .filter((root) => existsSync(join(repoRoot, root)))
  .flatMap((root) =>
    readdirSync(join(repoRoot, root), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => relative(repoRoot, join(e.parentPath ?? (e as unknown as { path: string }).path, e.name))),
  );

/** Code only: comment and doc lines dropped, so prose naming a retired call is not one. */
function codeOnly(src: string): string {
  return src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
}

/** Every judge-mode write a source makes: the retired helpers, or a judge-config POST whose body sets `mode`. */
function judgeModeWrites(src: string): string[] {
  const code = codeOnly(src);
  const found: string[] = [];
  for (const m of code.matchAll(/\b(setJudgeMode|enableTwinJudge)\s*\(/g)) found.push(`${m[1]}(`);
  for (const m of code.matchAll(/judgeConfig[\s\S]{0,400}?body:\s*JSON\.stringify\(([^)]*)\)/g)) {
    if (/\bmode\b/.test(m[1]!)) found.push(`POST judgeConfig ${m[1]!.replace(/\s+/g, " ").trim()}`);
  }
  if (/["']shadow["']\s*[,)]/.test(code) && /judgeConfig|setJudgeMode/.test(code)) found.push('"shadow"');
  return found;
}

describe("no script in the repo writes judge mode", () => {
  test("the walk is not vacuous — it reaches the files that used to write it", () => {
    for (const f of [join("scripts", "lib", "swarm", "session.ts"), join("scripts", "lib", "smoke-twin.ts")]) {
      expect(files).toContain(f);
    }
    expect(files.length).toBeGreaterThan(50);
  });

  test("no script declares or calls setJudgeMode / enableTwinJudge, or POSTs a mode", () => {
    const offenders = files.flatMap((rel) =>
      judgeModeWrites(readFileSync(join(repoRoot, rel), "utf8")).map((w) => `${rel}: ${w}`),
    );
    expect(offenders).toEqual([]);
  });

  test("the retired helper is not exported from session.ts for a future caller to find", async () => {
    const session = await import("../../lib/swarm/session.ts");
    for (const name of ["setJudgeMode", "enableTwinJudge", "runJudgeRoleCoverage", "setJudgeModel"]) {
      expect({ name, exported: name in session }).toEqual({ name, exported: false });
    }
  });

  test("red control: the retired two-step shadow enable is caught", () => {
    const planted = 'const x = 1;\nawait setJudgeMode("shadow", automationToken);\n';
    expect(judgeModeWrites(planted)).toEqual(["setJudgeMode(", '"shadow"']);
  });

  test("red control: a raw POST of a mode to the judge-config route is caught", () => {
    const planted =
      "await fetch(`${backendUrl()}${ROUTES.swarm.admin.judgeConfig}`, {\n" +
      '  method: "POST",\n' +
      '  body: JSON.stringify({ mode: "enforce", model }),\n' +
      "});\n";
    expect(judgeModeWrites(planted)).toEqual(['POST judgeConfig { mode: "enforce", model }']);
  });

  test("red control: a comment naming the retired call is not a write", () => {
    expect(judgeModeWrites('// setJudgeMode("enforce") used to live here\n')).toEqual([]);
  });
});
