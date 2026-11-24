// Issue 1742 (R5): the fields of a brief body and of a judge input are listed,
// with their source and as-of rule, in one registry and one doc table.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import * as epoch from "../src/swarm/domain.ts";
import { BRIEF_BODY_FIELDS, JUDGE_INPUT_FIELDS, buildBriefBody, judgeInputFromFrozen } from "../src/swarm/domain.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject } from "./support/epoch-fixtures.ts";

useCleanDatabase(import.meta.file);

const DOC = readFileSync(join(import.meta.dir, "../../docs/technical/regime-engine.md"), "utf8");
const section = DOC.slice(DOC.indexOf("## 12. Swarm brief and judge input fields"), DOC.indexOf("\n## See also"));
const findings = section.slice(section.indexOf("### 12.1"));

function tableRows(): Array<{ surface: string; field: string; source: string; asOf: string }> {
  return section
    .split("\n")
    .map((l) => l.match(/^\| (brief|judge) \| `(\w+)` \| (.*?) \| (.*?) \| (yes|no) \|$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ surface: m[1]!, field: m[2]!, source: m[3]!.trim(), asOf: m[4]!.trim() }));
}

describe("brief body and judge input fields", () => {
  test("a built brief body has exactly the registry's keys, less the conditional allocation", async () => {
    await sql`UPDATE swarm_judge_config SET model = 'deepseek-v4.1-flash' WHERE id = 1`;
    const subjectId = await activeSubject("fields_brief", 1800);
    const session = await epoch.openSession(subjectId);
    const [s] = await sql<any[]>`SELECT * FROM swarm_sessions WHERE id = ${session.id}`;
    const { body } = await buildBriefBody(s, new Date().toISOString(), undefined, sql);
    const required = Object.entries(BRIEF_BODY_FIELDS).filter(([, v]) => !v.conditional).map(([k]) => k);
    expect(Object.keys(body).sort()).toEqual(required.sort());
    expect(Object.keys(BRIEF_BODY_FIELDS)).toContain("allocation");
  });

  test("a built judge input has exactly the registry's keys", async () => {
    const subjectId = await activeSubject("fields_judge", 1800);
    const session = await epoch.openSession(subjectId);
    await epoch.publishBrief(session.id, 60);
    const [s] = await sql<any[]>`SELECT * FROM swarm_sessions WHERE id = ${session.id}`;
    const input = await judgeInputFromFrozen({ session: s, takes: [], activeMembers: [] } as any, 3);
    expect(Object.keys(input).sort()).toEqual(Object.keys(JUDGE_INPUT_FIELDS).sort());
  });

  test("the doc table has one row per registry field, each with a source and an as-of rule", () => {
    const rows = tableRows();
    const expected = [
      ...Object.keys(BRIEF_BODY_FIELDS).map((f) => `brief.${f}`),
      ...Object.keys(JUDGE_INPUT_FIELDS).map((f) => `judge.${f}`),
    ].sort();
    expect(rows.map((r) => `${r.surface}.${r.field}`).sort()).toEqual(expected);
    for (const r of rows) {
      expect(r.source, `${r.surface}.${r.field} source`).not.toBe("");
      expect(r.asOf, `${r.surface}.${r.field} as-of`).not.toBe("");
    }
  });

  test("every field not cut at the session date is listed under the findings heading", () => {
    expect(findings.length).toBeGreaterThan(0);
    let notCut = 0;
    for (const [surface, reg] of [["brief", BRIEF_BODY_FIELDS], ["judge", JUDGE_INPUT_FIELDS]] as const) {
      for (const [field, spec] of Object.entries(reg)) {
        if (spec.cutAtSessionDate) continue;
        notCut++;
        expect(findings, `${surface}.${field}`).toContain(`\`${surface}.${field}\``);
      }
    }
    expect(notCut).toBeGreaterThanOrEqual(4);
    expect(findings).toContain("regime.correlations.forward");
  });
});
