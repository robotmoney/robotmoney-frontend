// The judge fallback-reason enumeration in docs/architecture.md §9.7 is PINNED
// to backend/src/swarm/judge.ts. Neither side may gain a reason the other does
// not have.
//
// WHY THIS EXISTS. §9.7's "Failure is an outcome, never an error." paragraph
// claims exhaustiveness — it is the only place an operator reading a
// `fallback_reason` off `swarm_session_judgements` can find out what the value
// means. It was written by hand in PR #778 (issue #773) and was ALREADY STALE
// on the day it landed: PR #777 had merged `too_many_positions` and
// `duplicate_position:<id>` hours earlier, and the freshly written list omitted
// both. A hand-maintained enumeration of string literals living in prose drifts
// the moment anyone adds a `JudgeResponseError`, and nothing went red.
//
// So this test makes the drift RED, in both directions:
//   - a reason reachable in judge.ts with no §9.7 entry, and
//   - a §9.7 entry no longer reachable in judge.ts
// both fail, and the failure names the difference rather than reporting a
// count mismatch.
//
// PARAMETERISED REASONS are compared on their KEY — the part before the first
// `:`. Source writes `` `unknown_member:${memberId}` ``, the doc writes
// `unknown_member:<id>`; the suffix is runtime data an operator reads
// literally, not a name the doc can pin.
//
// EXTRACTION IS STRUCTURALLY GUARDED. A citation gate that silently matches
// nothing is worse than none, so the source scan does not merely collect what
// its regexes happen to find: it counts every `new JudgeResponseError(` and
// every `fallback(` call site and REFUSES to run if any of them is written in
// a shape it cannot read (a computed reason, a helper it does not know about).
// A new failure path introduced in an unrecognised shape goes red as a
// structural failure, not as a silent pass.
//
// The planted-violation controls at the bottom are the load-bearing half: each
// direction of the comparison, and each structural guard, is mutated in memory
// and must be SEEN to go red.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const SOURCE_PATH = "backend/src/swarm/judge.ts";
const DOC_PATH = "docs/architecture.md";

// The §9.7 anchor. The enumeration must live in this section and nowhere else:
// a reason list that drifted into another section would be found by a bare
// grep but would no longer be where §9.7 promises it is.
const SECTION_HEADING = "### 9.7 The consensus judge";
const PARAGRAPH_ANCHOR = "**Failure is an outcome, never an error.**";

// A reason key: lowercase snake_case, optionally followed by `:` and a
// runtime-supplied suffix. Deliberately narrow so that camelCase function
// names (`buildRationale`) and SCREAMING_CASE env/constant names
// (`SWARM_JUDGE_TIMEOUT_MS`, `MAX_POSITIONS`) in the same prose are excluded.
const REASON_LITERAL = /^[a-z][a-z0-9_]*(?::.*)?$/;

const keyOf = (literal: string) => literal.split(":")[0];

// Every string / template literal inside a fragment of source.
function literalsIn(fragment: string): string[] {
  const out: string[] = [];
  const re = /"([^"\\]*)"|`([^`\\]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) out.push(m[1] ?? m[2] ?? "");
  return out;
}

function countOf(source: string, re: RegExp): number {
  return (source.match(re) ?? []).length;
}

/**
 * Every fallback reason KEY reachable in judge.ts.
 *
 * Three producing shapes, and the guards that prove the scan saw all of them:
 *   1. `new JudgeResponseError("<reason>")` — caught at judge.ts's parse catch
 *      and recorded verbatim. Guard: every call site must pass a literal.
 *   2. `fallback("<reason>", model)` — the pre-transport outcomes. Guard: every
 *      call site must pass either a literal or the identifier `reason`.
 *   3. `const reason = … "<reason>" …` — the two catch blocks that pick a
 *      reason before handing it to `fallback(reason, …)`. Guard: there must be
 *      one such assignment for every identifier-passing `fallback()` call site.
 *
 * Throws — loudly, not silently returning a short set — when a guard trips.
 */
function reachableReasonKeys(source: string): Set<string> {
  const keys = new Set<string>();

  const collect = (literal: string, where: string) => {
    const key = keyOf(literal);
    if (!REASON_LITERAL.test(literal)) {
      throw new Error(`${SOURCE_PATH}: ${where} produces a reason this scan cannot read: ${JSON.stringify(literal)}`);
    }
    keys.add(key);
  };

  // 1. JudgeResponseError.
  const thrownRe = /new JudgeResponseError\(\s*(?:"([^"\\]*)"|`([^`\\]*)`)/g;
  let thrownCount = 0;
  let m: RegExpExecArray | null;
  while ((m = thrownRe.exec(source)) !== null) {
    thrownCount += 1;
    collect(m[1] ?? m[2] ?? "", "new JudgeResponseError()");
  }
  const thrownSites = countOf(source, /new JudgeResponseError\(/g);
  if (thrownCount !== thrownSites) {
    throw new Error(
      `${SOURCE_PATH}: ${thrownSites} \`new JudgeResponseError(\` call sites but only ${thrownCount} carry a readable string literal — a computed reason cannot be pinned to ${DOC_PATH}. Pass a literal, or teach this scan the new shape.`,
    );
  }

  // 2. fallback() with a literal.
  const fallbackLiteralRe = /(?<![\w.$])fallback\(\s*(?:"([^"\\]*)"|`([^`\\]*)`)/g;
  let fallbackLiteralCount = 0;
  while ((m = fallbackLiteralRe.exec(source)) !== null) {
    fallbackLiteralCount += 1;
    collect(m[1] ?? m[2] ?? "", "fallback()");
  }

  // 2b. fallback() with an identifier — only `reason` is understood.
  const fallbackIdentRe = /(?<![\w.$])fallback\(\s*([A-Za-z_$][\w$]*)\s*,/g;
  let fallbackIdentCount = 0;
  while ((m = fallbackIdentRe.exec(source)) !== null) {
    fallbackIdentCount += 1;
    if (m[1] !== "reason") {
      throw new Error(
        `${SOURCE_PATH}: fallback() is called with an unrecognised variable \`${m[1]}\` — this scan only follows \`reason\`, so its value cannot be pinned to ${DOC_PATH}.`,
      );
    }
  }

  const fallbackSites = countOf(source, /(?<![\w.$])fallback\(/g);
  if (fallbackLiteralCount + fallbackIdentCount !== fallbackSites) {
    throw new Error(
      `${SOURCE_PATH}: ${fallbackSites} \`fallback(\` call sites but ${fallbackLiteralCount + fallbackIdentCount} readable (${fallbackLiteralCount} literal, ${fallbackIdentCount} via \`reason\`) — an unreadable reason cannot be pinned to ${DOC_PATH}.`,
    );
  }

  // 3. The `reason` assignments feeding 2b.
  // `const reason = …` / `let reason = …` only. `this.reason = boundedReason(reason)`
  // inside the JudgeResponseError constructor is a re-wrap of an already-collected
  // value, not a producer, and must not be read as one.
  const reasonAssignRe = /(?:const|let|var)\s+reason\s*=\s*([^;]+);/g;
  let reasonAssignCount = 0;
  while ((m = reasonAssignRe.exec(source)) !== null) {
    reasonAssignCount += 1;
    const found = literalsIn(m[1]).filter((lit) => REASON_LITERAL.test(lit));
    if (found.length === 0) {
      throw new Error(`${SOURCE_PATH}: \`const reason = ${m[1].trim()}\` yields no readable reason literal.`);
    }
    for (const lit of found) collect(lit, "reason assignment");
  }
  if (reasonAssignCount !== fallbackIdentCount) {
    throw new Error(
      `${SOURCE_PATH}: ${fallbackIdentCount} \`fallback(reason, …)\` call sites but ${reasonAssignCount} \`reason =\` assignments — one of them is fed from somewhere this scan does not read.`,
    );
  }

  return keys;
}

/** The §9.7 paragraph, proven to be inside §9.7 and not merely somewhere in the doc. */
function fallbackParagraph(doc: string): string {
  const sectionStart = doc.indexOf(SECTION_HEADING);
  if (sectionStart < 0) throw new Error(`${DOC_PATH}: section heading "${SECTION_HEADING}" not found.`);
  const nextHeading = doc.indexOf("\n### ", sectionStart + 1);
  const sectionEnd = nextHeading < 0 ? doc.length : nextHeading;

  const anchor = doc.indexOf(PARAGRAPH_ANCHOR);
  if (anchor < 0) throw new Error(`${DOC_PATH}: paragraph anchor "${PARAGRAPH_ANCHOR}" not found.`);
  if (anchor < sectionStart || anchor >= sectionEnd) {
    throw new Error(`${DOC_PATH}: the fallback-reason enumeration is no longer inside ${SECTION_HEADING} — §9.7 is where it is promised to live.`);
  }
  if (doc.indexOf(PARAGRAPH_ANCHOR, anchor + 1) >= 0) {
    throw new Error(`${DOC_PATH}: "${PARAGRAPH_ANCHOR}" appears more than once — this scan cannot tell which list is authoritative.`);
  }

  const end = doc.indexOf("\n\n", anchor);
  return doc.slice(anchor, end < 0 ? sectionEnd : end);
}

/** Every reason KEY enumerated by §9.7. */
function documentedReasonKeys(doc: string): Set<string> {
  const paragraph = fallbackParagraph(doc);
  const keys = new Set<string>();
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(paragraph)) !== null) {
    if (REASON_LITERAL.test(m[1])) keys.add(keyOf(m[1]));
  }
  if (keys.size === 0) throw new Error(`${DOC_PATH}: §9.7's failure paragraph enumerates no reason literals — the scan matched nothing.`);
  return keys;
}

const missing = (a: Set<string>, b: Set<string>) => [...a].filter((k) => !b.has(k)).sort();

describe("§9.7's fallback-reason enumeration is pinned to judge.ts", () => {
  const source = read(SOURCE_PATH);
  const doc = read(DOC_PATH);
  const reachable = reachableReasonKeys(source);
  const documented = documentedReasonKeys(doc);

  test("every reason reachable in judge.ts is enumerated in §9.7", () => {
    expect(
      missing(reachable, documented),
      `reachable in ${SOURCE_PATH} but absent from ${DOC_PATH} §9.7 — §9.7 claims exhaustiveness, so add these to its "Failure is an outcome, never an error." paragraph`,
    ).toEqual([]);
  });

  test("every reason enumerated in §9.7 is reachable in judge.ts", () => {
    expect(
      missing(documented, reachable),
      `enumerated in ${DOC_PATH} §9.7 but not reachable in ${SOURCE_PATH} — a removed reason must leave the doc with it`,
    ).toEqual([]);
  });

  // Not an assertion about the number, which will change: an assertion that
  // BOTH scans actually collected something. A pair of empty sets is equal.
  test("both scans collected a non-trivial set", () => {
    expect(reachable.size).toBeGreaterThan(15);
    expect(documented.size).toBeGreaterThan(15);
    expect(reachable.has("too_many_positions")).toBe(true);
    expect(documented.has("too_many_positions")).toBe(true);
    expect(reachable.has("duplicate_position")).toBe(true);
    expect(documented.has("duplicate_position")).toBe(true);
  });
});

// The controls. Each mutates the real file content in memory and asserts the
// gate above would have gone red. Without these, a regex that quietly stopped
// matching would leave this file permanently, invisibly green.
describe("planted violations are caught", () => {
  const source = read(SOURCE_PATH);
  const doc = read(DOC_PATH);

  test("a reason dropped from §9.7 is reported as undocumented", () => {
    const mutated = doc.replace("(`too_many_positions`)", "(`   `)");
    expect(mutated).not.toBe(doc);
    const gap = missing(reachableReasonKeys(source), documentedReasonKeys(mutated));
    expect(gap).toContain("too_many_positions");
  });

  test("a new JudgeResponseError with no §9.7 entry is reported as undocumented", () => {
    const mutated = source.replace(
      'throw new JudgeResponseError("not_an_object");',
      'throw new JudgeResponseError("not_an_object");\n  if (false) throw new JudgeResponseError("planted_fake_reason");',
    );
    expect(mutated).not.toBe(source);
    const gap = missing(reachableReasonKeys(mutated), documentedReasonKeys(doc));
    expect(gap).toEqual(["planted_fake_reason"]);
  });

  test("a §9.7 entry with no reachable reason is reported as unreachable", () => {
    const mutated = doc.replace("(`not_json`)", "(`not_json`, `planted_doc_only`)");
    expect(mutated).not.toBe(doc);
    const gap = missing(documentedReasonKeys(mutated), reachableReasonKeys(source));
    expect(gap).toEqual(["planted_doc_only"]);
  });

  test("a computed JudgeResponseError reason trips the structural guard", () => {
    const mutated = source.replace(
      'throw new JudgeResponseError("not_an_object");',
      "throw new JudgeResponseError(someComputedReason);",
    );
    expect(mutated).not.toBe(source);
    expect(() => reachableReasonKeys(mutated)).toThrow(/call sites but only/);
  });

  test("a fallback() fed by an unknown variable trips the structural guard", () => {
    const mutated = source.replace("return fallback(reason, transport.model);", "return fallback(otherReason, transport.model);");
    expect(mutated).not.toBe(source);
    expect(() => reachableReasonKeys(mutated)).toThrow(/unrecognised variable/);
  });

  test("a `fallback(reason, …)` with no matching assignment trips the structural guard", () => {
    const mutated = source.replace(
      'if (!transport) return fallback("model_unconfigured", null);',
      'if (!transport) return fallback("model_unconfigured", null);\n  if (false) return fallback(reason, null);',
    );
    expect(mutated).not.toBe(source);
    expect(() => reachableReasonKeys(mutated)).toThrow(/assignments/);
  });

  test("the enumeration moving out of §9.7 trips the section check", () => {
    const paragraph = fallbackParagraph(doc);
    const mutated = doc.replace(paragraph, "") + `\n\n### 9.99 Elsewhere\n\n${paragraph}\n`;
    expect(() => documentedReasonKeys(mutated)).toThrow(/no longer inside/);
  });
});
