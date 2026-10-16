// W4 part 3 — NOTHING IN THE STACK JUDGES INLINE (issue #1026).
//
// AUTHORITY: docs/technical/smoke-production-spec.md §6, and
// system-scheduler-spec.md §1 and §7.
//
//   §1: participants "do the work that needs a model: takes and judgements."
//   §7: `system-scheduler` "calls no model, so it has no model key", and the
//   model key is "delivered to those containers only" — the participants.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT "INLINE" MEANS AND WHY IT IS A STRUCTURAL TEST
// ─────────────────────────────────────────────────────────────────────────────
//
// Two paths ran the judge model inside a process that holds a database
// credential: the `swarm.judge` queue handler in `worker-swarm`, and the admin
// route's `judge` verb inside the API. Both are inline judging, and both put a
// model key in a process §7 says must not have one.
//
// This cannot be a behavioural test. "Nothing judges inline" is a claim about
// which code paths EXIST, and a test that drives the surviving paths and sees
// no model call proves only that those paths did not judge — not that no path
// would. So the assertions are over the source: the handler registration, the
// route's dispatch table, and the absence of any caller.
//
// The positive half matters as much: the judge still runs, as a PARTICIPANT
// over HTTP from its own container with its own key, and that path is asserted
// to exist rather than merely the old one to be absent.
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const REPO = join(import.meta.dir, "..", "..", "..");
const read = (rel: string): string => readFileSync(join(REPO, rel), "utf8");

/** Source with comments stripped: quoting the rule is not breaking it. */
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/.*/g, "");

describe("the queue no longer judges", () => {
  test("`swarm.judge` is not a registered handler kind", () => {
    const handlers = code("backend/src/worker/handlers/index.ts");
    expect(handlers).not.toContain('"swarm.judge"');
  });

  test("the swarm worker handler module no longer exposes a judge step", () => {
    const rel = "backend/src/worker/handlers/swarm.ts";
    if (!existsSync(join(REPO, rel))) return; // removed entirely: also acceptable
    const text = code(rel);
    expect(text).not.toContain("judgeSession");
    expect(text).not.toContain("judgeSessionAdmin");
  });
});

describe("the API no longer judges inside a request", () => {
  test("the admin session-action dispatch has no `judge` verb bound to the inline judge", () => {
    const admin = code("backend/src/api/routes/swarm-admin.ts");
    expect(admin).not.toMatch(/judge:\s*admin\.judgeSessionAdmin/);
    expect(admin).not.toContain("judgeSessionAdmin");
  });

  test("no route file anywhere calls the inline judge", () => {
    const offenders: string[] = [];
    for (const rel of new Glob("backend/src/api/**/*.ts").scanSync({ cwd: REPO })) {
      if (code(rel).includes("judgeSessionAdmin")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe("nothing at all reaches the inline judge", () => {
  test("`judgeSessionAdmin` has no caller in backend/src", () => {
    const callers: string[] = [];
    for (const rel of new Glob("backend/src/**/*.ts").scanSync({ cwd: REPO })) {
      const text = code(rel);
      // The declaration itself, if it survives, is not a caller.
      const withoutDecl = text.replace(/export async function judgeSessionAdmin[\s\S]*?\n\}/, "");
      if (withoutDecl.includes("judgeSessionAdmin")) callers.push(rel);
    }
    expect(callers).toEqual([]);
  });

  test("no model key is named in any worker service of any composition", () => {
    // §7: the model key is "delivered to those containers only" — the
    // participants. `worker-swarm` carried one; nothing that survives may.
    for (const rel of new Glob("docker-compose*.yml").scanSync({ cwd: REPO })) {
      const text = read(rel);
      const serviceBlocks = text.split(/\n  (?=[a-z0-9-]+:\n)/);
      for (const block of serviceBlocks) {
        const name = block.match(/^\s*([a-z0-9-]+):/)?.[1] ?? "";
        if (!name.startsWith("worker")) continue;
        expect({ rel, name, hasModelKey: block.includes("OPENCODE_API_KEY") }).toEqual({
          rel,
          name,
          hasModelKey: false,
        });
      }
    }
  });
});

describe("the inline judge is DELETED, not merely uncalled (D53 point 4)", () => {
  // Criterion: "`templateOpinion` is deleted, not merely uncalled". The same
  // holds for the rest of the backend judge — its session runner, its model
  // transport and `judge()` itself. An uncalled function is one import away
  // from being called again; a deleted one is not.
  const RETIRED = ["templateOpinion", "judgeSession", "judgeSessionAdmin", "resolveJudgeTransport", "JudgeTransport"];

  /** Every retired identifier still present in CODE (comments stripped) under a tree. */
  function survivors(files: Iterable<string>, text: (rel: string) => string): string[] {
    const found: string[] = [];
    for (const rel of files) {
      const body = text(rel);
      for (const name of RETIRED) {
        if (new RegExp(`\\b${name}\\b`).test(body)) found.push(`${rel}: ${name}`);
      }
      if (/export\s+(async\s+)?function\s+judge\s*\(/.test(body)) found.push(`${rel}: judge()`);
    }
    return found;
  }

  test("no retired judge identifier exists anywhere under backend/src", () => {
    const files = [...new Glob("backend/src/**/*.ts").scanSync({ cwd: REPO })];
    expect(files.length).toBeGreaterThan(50);
    expect(survivors(files, code)).toEqual([]);
  });

  test("the scan is not vacuous — a planted definition or call of each is found", () => {
    const planted: Record<string, string> = {
      "a.ts": "export function templateOpinion(input: unknown) { return input; }",
      "b.ts": "const r = await judgeSession(id, {});",
      "c.ts": "export async function judge(input: unknown) {}",
      "d.ts": "// templateOpinion is gone\nconst ok = 1;",
    };
    const stripped = (rel: string) =>
      planted[rel]!.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/.*/g, "");
    expect(survivors(Object.keys(planted), stripped)).toEqual([
      "a.ts: templateOpinion",
      "b.ts: judgeSession",
      "c.ts: judge()",
    ]);
  });

  test("the inline judge's session module is gone", () => {
    expect(existsSync(join(REPO, "backend/src/swarm/judge-session.ts"))).toBe(false);
  });

  test("what remains of judge.ts is pure: no database, no environment, no network", () => {
    const text = code("backend/src/swarm/judge.ts");
    expect(text).not.toMatch(/from "\.\.\/db\//);
    expect(text).not.toContain("process.env");
    expect(text).not.toMatch(/\bfetch\(/);
  });
});

describe("the judge still runs, as a participant over HTTP", () => {
  test("a judge client exists and submits through the participant routes", () => {
    const rel = "scripts/agent/participant/judge-client.ts";
    expect(existsSync(join(REPO, rel))).toBe(true);
    const text = read(rel);
    expect(text).toContain("participants.judgeSubscribe");
    expect(text).toContain("participants.judgement");
  });

  test("the judge client fabricates nothing when it cannot reach a model", () => {
    // "a judge refuses rather than fakes" — no fallback mode, no templated
    // opinion. Asserted structurally because a fallback is a branch, and a
    // branch that does not exist cannot be taken.
    const text = code("scripts/agent/participant/judge-client.ts").toLowerCase();
    for (const word of ["fallback", "template", "placeholder", "default verdict"]) {
      expect({ word, found: text.includes(word) }).toEqual({ word, found: false });
    }
  });

  test("the judge client SIGNS what it submits, over the contract's canonical judgement bytes", () => {
    // Criterion 123: "its judgement arriving over HTTP from that container
    // signed with that key". The behaviour is proven in
    // participant-judge-client.test.ts (the signature verifies); this pins that
    // the client builds the bytes from the contract rather than a local copy.
    const text = code("scripts/agent/participant/judge-client.ts");
    expect(text).toContain("canonicalizeJudgement");
    expect(text).toContain("crypto.subtle.sign");
    expect(text).toMatch(/signature/);
  });

  test("the judge client names its refusals from the D-A7 taxonomy, not free text", () => {
    const text = code("scripts/agent/participant/judge-client.ts");
    expect(text).toContain("failureCodeForAnswer");
    expect(text).not.toMatch(/model refused with HTTP/);
  });

  test("`PARTICIPANT_PENDING_PATH` is in the contract, not a client-side literal", () => {
    const routes = read("contract/src/routes.js");
    expect(routes).toContain("/api/swarm/participants/pending");
    const main = read("scripts/agent/participant/main.ts");
    expect(main).not.toMatch(/PARTICIPANT_PENDING_PATH\s*=\s*"/);
  });
});
