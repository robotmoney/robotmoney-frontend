// W4 part 3 — THE WIRE SHAPES ON THE TWO SIDES OF THE CREDENTIAL BOUNDARY
// (issue #1026).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §3, §6.3 and §7.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// §7 forbids `system-scheduler` a database credential, and
// `backend/src/swarm/domain.ts` — where the server's declarations of these
// shapes live — opens a database handle at module scope. So the client cannot
// import them, and `scripts/lib/system-scheduler/types.ts` re-declares them.
//
// Duplication that nothing checks becomes drift, and drift here is silent: a
// renamed field arrives as `undefined`, a missing deadline reads as "no
// deadline", and a scheduler quietly stops finalizing. So the two declarations
// are compared as TEXT — read from the backend source, never imported — and the
// field names must match.
//
// WHAT THIS DOES NOT PROVE. It compares names, not types, and it compares
// declarations, not what the handler actually serializes. The backend's own
// tests own the second; this owns the first, which is the one the boundary
// makes impossible to get from the compiler.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import { SCHEDULER_FULL_READ_PATH } from "../../lib/system-scheduler/health.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const DOMAIN = readFileSync(join(REPO, "backend/src/swarm/domain.ts"), "utf8");
const CLIENT = readFileSync(join(REPO, "scripts/lib/system-scheduler/types.ts"), "utf8");

/** The property names declared inside `export interface <name> { … }`. */
function fieldsOf(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  expect({ name, found: start !== -1 }).toEqual({ name, found: true });
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  return [...body.matchAll(/(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/g)].map((m) => m[1]).sort();
}

describe("the full read's shape is declared identically on both sides (§3)", () => {
  for (const name of ["SchedulerSubject", "CollectingSession", "SettlingSession", "SchedulerFullRead"]) {
    test(`${name} has the same fields in domain.ts and in types.ts`, () => {
      expect({ name, fields: fieldsOf(CLIENT, name) }).toEqual({ name, fields: fieldsOf(DOMAIN, name) });
    });
  }

  test("the settling states match", () => {
    const pick = (s: string): string[] =>
      [...(s.match(/export type SettlingState = ([^;]+);/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)]
        .map((m) => m[1])
        .sort();
    expect(pick(CLIENT)).toEqual(pick(DOMAIN));
    expect(pick(CLIENT)).toEqual(["aggregated", "judged", "judging", "window_closed"]);
  });
});

describe("the one path the startup check hard-codes matches the contract (§7)", () => {
  test("SCHEDULER_FULL_READ_PATH is ROUTES.swarm.scheduler.fullRead", () => {
    // health.ts holds it as a literal so the module imports nothing outside its
    // own directory. This is the pin that keeps the literal honest.
    expect(SCHEDULER_FULL_READ_PATH).toBe(ROUTES.swarm.scheduler.fullRead);
  });
});
