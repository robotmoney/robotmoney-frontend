// `off -> shadow` IS ONE REQUEST, NOT TWO (migration 0056).
//
// THE RED BUILD THIS FILE EXISTS BECAUSE OF. `swarm_judge_config` ships
// `mode = 'off'` with `model = NULL`, and 0056 constrains the PAIR: a
// `shadow`/`enforce` row must name a model. The GitHub e2e flipped off → shadow
// by updating the mode alone, so the very first statement was refused by the
// database and the whole suite went red on a control working exactly as
// designed.
//
// The fix is a refusal IN setJudgeMode(), not a corrected call site. Repairing
// the one caller that went red would leave the next one to rediscover it as an
// opaque 400 — or, worse, to pass against a restored twin whose model happens
// to be set and fail on a fresh database, which is the hardest possible shape
// for this bug to take.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { setJudgeMode } from "../../lib/swarm/session.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

interface Sent { url: string; body: Record<string, unknown> }

const realFetch = globalThis.fetch;
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  process.env.BACKEND_URL = "http://judge-mode.invalid";
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    sent.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("setJudgeMode refuses to enable the judge without naming a model", () => {
  for (const mode of ["shadow", "enforce"] as const) {
    test(`${mode} with no model throws BEFORE any request is made`, async () => {
      await expect(setJudgeMode(mode, "tok")).rejects.toThrow(/migration 0056/);
      // Not a 400 handled after the fact: nothing was sent at all, so no
      // half-applied state can exist on the server either.
      expect(sent).toEqual([]);
    });

    test(`${mode} with a blank model is treated as no model`, async () => {
      await expect(setJudgeMode(mode, "tok", "   ")).rejects.toThrow(/same request/i);
      expect(sent).toEqual([]);
    });

    test(`${mode} with a model sends BOTH fields in ONE request`, async () => {
      await setJudgeMode(mode, "tok", "deepseek-v4-flash");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).toEqual({ mode, model: "deepseek-v4-flash" });
    });
  }

  test("off is the one mode that may omit the model — and it does not invent one", async () => {
    await setJudgeMode("off", "tok");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ mode: "off" });
  });

  test("off with a model is still allowed — `off` plus a model is a legal row", async () => {
    await setJudgeMode("off", "tok", "deepseek-v4-flash");
    expect(sent[0]!.body).toEqual({ mode: "off", model: "deepseek-v4-flash" });
  });
});

// The source-level half: every remaining enable in the repo passes a model.
// A behavioural test can only cover the call it makes; this covers the ones it
// does not, and goes red when a new two-step enable is written.
describe("no caller in this repo enables the judge in two steps", () => {
  // A GLOB, NOT A LIST. The first cut hardcoded the two files that call
  // setJudgeMode() today, which made the scan complete on the day it was
  // written and silently incomplete the moment a third file was added — while
  // its own name went on claiming repo-wide coverage. Walk the trees instead,
  // and prove below that the walk really reaches the known call sites.
  //
  // The runtime refusal inside setJudgeMode() still catches a third-file
  // offender when it executes; this is the half that catches it at review time.
  const scanRoots = ["scripts/lib", "backend/src", "scripts/agent", "backend/scripts"];
  const selfPath = join("scripts", "tests", "unit", "judge-mode-model-atomic.test.ts");
  const files = scanRoots
    .filter((root) => existsSync(join(repoRoot, root)))
    .flatMap((root) =>
      readdirSync(join(repoRoot, root), { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".ts"))
        .map((e) => relative(repoRoot, join(e.parentPath ?? (e as unknown as { path: string }).path, e.name))))
    .filter((rel) => rel !== selfPath && readFileSync(join(repoRoot, rel), "utf8").includes("setJudgeMode("));

  // CALLS ONLY: `await setJudgeMode(`, with comment and doc lines dropped. The
  // function's own error message names `setJudgeMode(${mode})` in prose, and a
  // scan that read that as a call site would be permanently, unfixably red.
  const callsIn = (src: string): { args: string[]; text: string }[] => {
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    return [...code.matchAll(/await setJudgeMode\(\s*([^)]*)\)/gs)]
      .map((m) => ({ args: m[1]!.split(",").map((a) => a.trim()).filter(Boolean), text: m[1]!.replace(/\s+/g, " ").trim() }));
  };

  test("every setJudgeMode call that enables the judge carries a model argument", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      for (const call of callsIn(readFileSync(join(repoRoot, rel), "utf8"))) {
        if (call.args[0] === '"off"') continue; // not an enable
        if (call.args.length < 3 || call.args[2] === "undefined") {
          offenders.push(`${rel}: setJudgeMode(${call.text})`);
        }
      }
    }
    expect(offenders, "an enable with no model is refused by migration 0056").toEqual([]);
  });

  test("the scan is not vacuous — the WALK really reaches the known call sites", () => {
    // Both halves matter: the glob must have found the files, and the call
    // extraction must find the calls inside them. A walk that silently matched
    // nothing would leave the gate above permanently, invisibly green.
    expect(files).toContain(join("scripts", "lib", "swarm", "session.ts"));
    expect(files).toContain(join("scripts", "lib", "smoke-twin.ts"));
    const calls = callsIn(readFileSync(join(repoRoot, "scripts", "lib", "swarm", "session.ts"), "utf8"));
    expect(calls.length).toBeGreaterThan(1);
    // `enforce`, not `shadow`: runJudgeRoleCoverage flips to the only mode D48
    // still admits (backend/src/swarm/domain.ts's currentJudgeMode reduces a
    // `shadow` switch to `off` when it stamps a closing session), and that call
    // is the repo's one live two-argument-plus-model enable.
    expect(calls.some((c) => c.text.includes('"enforce", automationToken, selectedJudgeModel'))).toBe(true);
  });

  test("the scan would CATCH a two-step enable — the control that keeps it honest", () => {
    const planted = 'const x = 1;\nawait setJudgeMode("shadow", automationToken);\n';
    const calls = callsIn(planted);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.length).toBeLessThan(3);
  });
});
