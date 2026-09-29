// D55 (4), issue #1026: only the scheduler opens, turns over and settles
// epochs, so no operator early-turnover path exists in the contract, the
// admin UI or the api's dispatcher. The runtime half (every epoch route
// refuses the operator token) is backend/tests/epoch-lifecycle-auth.test.ts
// and backend/tests/epoch-deactivation.test.ts (169); this file pins the
// places a path could be written down.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "../../../contract/src/routes.js";

const REPO = join(import.meta.dir, "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

/** Admin route keys that would let an operator move an epoch. */
const RETIRED_KEYS = ["open", "brief", "close", "aggregate", "publish", "enqueueJob"];
const EPOCH_KEYS = ["epochOpen", "epochTurnover", "epochAggregate", "epochRequestJudging", "epochFinalize"];

const FORBIDDEN_IN_UI =
  /\/epochs\/|epoch(Open|Turnover|Aggregate|RequestJudging|Finalize)|swarm\/admin\/(open|brief|close|aggregate|publish|enqueue-job)\b|\/sessions\/[^"'`\s]*\/(cancel|close|reopen|aggregate|publish)\b/;

/** Every non-comment line of the admin UI that names a forbidden path. */
function uiHits(read: (rel: string) => string, list: (dir: string) => string[]): string[] {
  const dirs = ["frontend/public/views/admin", "frontend/public/assets/js/app/alpine/views/admin"];
  const hits: string[] = [];
  for (const dir of dirs) {
    for (const file of list(dir)) {
      read(join(dir, file))
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line)) return;
          if (FORBIDDEN_IN_UI.test(line)) hits.push(`${dir}/${file}:${i + 1}: ${line.trim()}`);
        });
    }
  }
  return hits;
}

describe("no operator early-turnover path (D55 (4))", () => {
  test("the contract names the five epoch transitions and none of the retired session actions", () => {
    const admin = ROUTES.swarm.admin as Record<string, string>;
    for (const key of RETIRED_KEYS) expect({ key, present: key in admin }).toEqual({ key, present: false });
    for (const key of EPOCH_KEYS) expect(admin[key]).toMatch(/^\/api\/swarm\/admin\/epochs\//);
    const sessionVerbs = Object.entries(admin).filter(([, path]) =>
      /\/sessions\/:id\/(cancel|close|reopen|aggregate|publish)$/.test(path),
    );
    expect(sessionVerbs).toEqual([]);
  });

  test("the frontend's contract mirror is the same table", () => {
    const mirror = read("frontend/public/assets/js/app/contract/routes.js");
    for (const key of RETIRED_KEYS) expect(mirror).not.toMatch(new RegExp(`^\\s+${key}: "/api/swarm/admin/`, "m"));
  });

  test("the admin UI never calls an epoch route or a retired session action", () => {
    expect(uiHits(read, (dir) => readdirSync(join(REPO, dir)))).toEqual([]);
  });

  test("red control: a UI file that called the turnover route would be reported", () => {
    const planted = uiHits(
      () => 'fetch(ROUTES.swarm.admin.epochTurnover, { method: "POST" })',
      () => ["planted.js"],
    );
    expect(planted.length).toBeGreaterThan(0);
  });
});
