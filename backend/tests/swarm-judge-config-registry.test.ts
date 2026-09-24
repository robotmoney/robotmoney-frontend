// "Nothing but the admin route writes `swarm_judge_config`"
// (smoke-production-spec.md §6.2), asserted FROM THE REGISTRY (issue #1026,
// criterion "Every registered query writing `swarm_judge_config` declares
// `swarm-admin.ts` as its only call site, asserted from the registry, not by
// grep").
//
// WHY THE REGISTRY AND NOT A GREP. A grep for callers proves only what the
// pattern happened to match: an alias, a re-export or a dynamic import walks
// past it. The registry is where each statement declares, next to itself, the
// entry modules allowed to reach it (`QueryDeclaration.callers`,
// src/db/registry.ts), and `registeredSites()` enumerates every declaration a
// loaded module made. So the test loads what the API loads, reads the writes
// on `swarm_judge_config` out of the registry, and holds each to exactly one
// caller: the admin route.
//
// THE RED CONTROL. The check is a function, run twice: once over the real
// declarations (must be clean) and once over the real declarations plus a
// planted second writer (must name it). A check that cannot fail proves
// nothing, and this is how this one shows it can.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// WHAT THE API LOADS. `src/api/index.ts` itself starts a server and runs the
// boot guards at import, so the test imports the route modules it dispatches
// to — the same module graph, without binding a port.
import "../src/api/routes/swarm.ts";
import "../src/api/routes/admin.ts";
import "../src/api/routes/admin-webauthn.ts";
import "../src/api/routes/analytics.ts";
import "../src/api/routes/comments.ts";
import "../src/api/routes/dashboards.ts";
import "../src/api/routes/projects.ts";
import "../src/api/routes/submissions.ts";
import { registeredSites, registerQuery, type QueryDeclaration } from "../src/db/registry.ts";

const ADMIN_ROUTE = "src/api/routes/swarm-admin";
const OBJECT = "swarm_judge_config";

/** The registered WRITES on the judge switch. */
function judgeConfigWrites(sites: readonly QueryDeclaration[]): QueryDeclaration[] {
  return sites.filter((d) => d.object === OBJECT && d.privileges.some((p) => p === "INSERT" || p === "UPDATE"));
}

/** Every write whose declared callers are anything but exactly the admin route. */
function offenders(sites: readonly QueryDeclaration[]): string[] {
  return judgeConfigWrites(sites)
    .filter((d) => d.callers.length !== 1 || d.callers[0] !== ADMIN_ROUTE)
    .map((d) => `${d.site}: ${JSON.stringify(d.callers)}`);
}

describe("swarm_judge_config is written only through the admin route", () => {
  test("the API's module graph registers the switch's writes — the set is not empty", () => {
    const writes = judgeConfigWrites(registeredSites());
    // Non-vacuous: an empty set would make "every write declares the admin
    // route" true of nothing.
    expect(writes.map((d) => d.site).sort()).toEqual([
      "src/swarm/judge-config:setJudgeConfig.insert",
      "src/swarm/judge-config:setJudgeConfig.update",
    ]);
    expect(writes.every((d) => d.role === "rm_app")).toBe(true);
  });

  test("every registered write on swarm_judge_config declares the admin route as its ONLY caller", () => {
    for (const d of judgeConfigWrites(registeredSites())) {
      expect({ site: d.site, callers: d.callers }).toEqual({ site: d.site, callers: [ADMIN_ROUTE] });
    }
    expect(offenders(registeredSites())).toEqual([]);
  });

  test("RED CONTROL: a second declared caller of a write is named by the same check", () => {
    const planted = registerQuery({
      role: "rm_app",
      object: OBJECT,
      privileges: ["UPDATE"],
      site: `tests/swarm-judge-config-registry:planted_${crypto.randomUUID().slice(0, 8)}`,
      purpose: "A deliberately wrong declaration: a second module writing the judge switch.",
      callers: [ADMIN_ROUTE, "src/worker/loop"],
    });
    const found = offenders([...registeredSites()]);
    expect(found).toEqual([`${planted.declaration.site}: ${JSON.stringify([ADMIN_ROUTE, "src/worker/loop"])}`]);
    // …and a planted writer declaring ANOTHER single caller is named too.
    const other = registerQuery({
      ...planted.declaration,
      site: `${planted.declaration.site}_other`,
      callers: ["src/api/routes/swarm-judge-participant"],
    });
    expect(offenders([...registeredSites()])).toContain(`${other.declaration.site}: ["src/api/routes/swarm-judge-participant"]`);
  });

  test("a read of the switch is not a write, and is not held to the rule", () => {
    const read = registeredSites().find((d) => d.site === "src/swarm/judge-config:getJudgeConfig");
    expect(read?.privileges).toEqual(["SELECT"]);
    expect(judgeConfigWrites(registeredSites()).map((d) => d.site)).not.toContain("src/swarm/judge-config:getJudgeConfig");
  });

  test("the registry is the WHOLE list: no module under src/ writes the switch outside a registered site", () => {
    // Completeness, not the property itself. The declarations above are only
    // the truth if no statement bypasses them; a raw write in a module that the
    // raw-SQL ratchet still tolerates (db-registry.test.ts RAW_SQL_ALLOWLIST)
    // would. The one module allowed to write is the one that registers.
    const SRC = join(import.meta.dir, "..", "src");
    const WRITE = /\b(?:UPDATE\s+swarm_judge_config|INSERT\s+INTO\s+swarm_judge_config)\b/i;
    const writers = (readdirSync(SRC, { recursive: true, encoding: "utf8" }) as string[])
      .filter((rel) => rel.endsWith(".ts"))
      .filter((rel) => WRITE.test(readFileSync(join(SRC, rel), "utf8")));
    expect(writers).toEqual(["swarm/judge-config.ts"]);
  });
});
