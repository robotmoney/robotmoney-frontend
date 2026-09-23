// The judge refusal-reason enumeration in docs/architecture.md §9.7 is PINNED
// to backend/src/swarm/judge.ts. Neither side may gain a reason the other does
// not have.
//
// WHY THIS EXISTS. §9.7's failure paragraph
// claims exhaustiveness — it is the only place an operator reading a
// `JudgeUnavailable.reason` off `swarm_session_judgements` can find out what the value
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
// its regexes happen to find: it counts every `new JudgeResponseError(`, every
// judge-refusal site (`new Judge{Unavailable,NothingToJudge}Error(`, and the
// local `refuse(` helper that throws one), and every `fallbackOutcome(` call
// site, and REFUSES to run if any of them is written in a shape it cannot read
// (a computed reason, a helper it does not know about). A new failure path
// introduced in an unrecognised shape goes red as a structural failure, not as
// a silent pass.
//
// BOTH OUTCOME CLASSES ARE SCANNED (the D-A7 ruling). judge.ts answers a
// CONFIGURATION gap by throwing, and the one remaining deterministic outcome —
// the fault-injection lever — by returning `fallbackOutcome(input, reason,
// model)`. §9.7 enumerates both lists in one paragraph, and a scan that read
// only one shape would go quietly green the moment the other grew a reason.
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
const PARAGRAPH_ANCHOR = "**Failure is a REFUSAL, and records nothing.**";

// A reason key: lowercase snake_case, optionally followed by `:` and a
// runtime-supplied suffix. Deliberately narrow so that camelCase function
// names (`buildRationale`) and SCREAMING_CASE env/constant names
// (`SWARM_JUDGE_TIMEOUT_MS`, `MAX_POSITIONS`) in the same prose are excluded.
const REASON_LITERAL = /^[a-z][a-z0-9_]*(?::.*)?$/;

const keyOf = (literal: string) => literal.split(":")[0];

// The only variable names a judge outcome may be produced from, and the only
// functions allowed to decide one. Both lists are closed on purpose: an outcome
// built from anything else is a reason this scan cannot pin to §9.7, and goes
// red as a structural failure rather than passing silently.
const OUTCOME_IDENTS: readonly string[] = ["reason", "gap"];
const CLASSIFIERS: readonly string[] = ["judgeConfigGap", "judgeTransportGap"];

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
 * Every reason KEY reachable in judge.ts, across BOTH D-A7 outcome classes.
 *
 * Five producing shapes, and the guards that prove the scan saw all of them:
 *   1. `new JudgeResponseError("<reason>")` — caught at judge.ts's parse catch
 *      and recorded verbatim. Guard: every call site must pass a literal.
 *   2. `new Judge{Unavailable,NothingToJudge}Error("<reason>", …)` and the
 *      local `refuse("<reason>", model)` helper that throws one — the
 *      fail-closed and nothing-to-judge refusals with a literal reason.
 *   3. `fallbackOutcome(input, "<reason>", …)` — a deterministic outcome with
 *      a literal reason.
 *   4. Shapes 2 and 3 fed by the identifier `reason`. Guard: every such site
 *      must use exactly that name, and there must be one `const reason = …`
 *      assignment carrying readable literals for each of them.
 *   5. `judgeConfigGap()` — the exported classifier that decides WHICH
 *      configuration is missing. It feeds one of shape 4's assignments, so its
 *      own `return "<reason>"` literals are read from its body. Guard: the
 *      function must exist and every return in it must be a literal.
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

  // 2 + 3. Every OUTCOME site: a refusal thrown, or a deterministic fallback
  // returned. Both name a reason in the same position, and §9.7 enumerates both.
  // `fallbackOutcome(input,` deliberately excludes the function's own
  // declaration, which reads `fallbackOutcome(input: JudgeInput,`.
  // `refuse(` is the local helper that throws a JudgeUnavailable — an outcome
  // site like the explicit throws, and reached from the same catch blocks.
  // `const refuse:` (its declaration) does not match, so only call sites count.
  const OUTCOME_SITE = String.raw`(?:new Judge(?:Unavailable|NothingToJudge)Error\(|(?<![\w.$])refuse\(|fallbackOutcome\(\s*input\s*,\s*)`;
  const outcomeLiteralRe = new RegExp(`${OUTCOME_SITE}\\s*(?:"([^"\\\\]*)"|\`([^\`\\\\]*)\`)`, "g");
  let outcomeLiteralCount = 0;
  while ((m = outcomeLiteralRe.exec(source)) !== null) {
    outcomeLiteralCount += 1;
    collect(m[1] ?? m[2] ?? "", "judge outcome site");
  }

  // 4. An outcome site fed by an identifier — only `reason` (a literal-bearing
  //    assignment) and `gap` (a classifier call, shape 5) are understood.
  const outcomeIdentRe = new RegExp(`${OUTCOME_SITE}\\s*([A-Za-z_$][\\w$]*)\\s*,`, "g");
  let outcomeIdentCount = 0;
  while ((m = outcomeIdentRe.exec(source)) !== null) {
    outcomeIdentCount += 1;
    if (!OUTCOME_IDENTS.includes(m[1]!)) {
      throw new Error(
        `${SOURCE_PATH}: a judge outcome is produced with an unrecognised variable \`${m[1]}\` — this scan only follows ${OUTCOME_IDENTS.map((i) => `\`${i}\``).join(" and ")}, so its value cannot be pinned to ${DOC_PATH}.`,
      );
    }
  }

  const outcomeSites = countOf(source, new RegExp(OUTCOME_SITE, "g"));
  if (outcomeLiteralCount + outcomeIdentCount !== outcomeSites) {
    throw new Error(
      `${SOURCE_PATH}: ${outcomeSites} judge outcome sites but ${outcomeLiteralCount + outcomeIdentCount} readable (${outcomeLiteralCount} literal, ${outcomeIdentCount} via \`reason\`) — an unreadable reason cannot be pinned to ${DOC_PATH}.`,
    );
  }

  // 5. The CLASSIFIERS the `gap` assignments are fed from, read so that every
  //    fail-closed reason is collected from the one place that decides it:
  //      judgeConfigGap()    — which CONFIGURATION is missing
  //                            (`model_unconfigured` / `credential_unconfigured`)
  //      judgeTransportGap() — which of Zen's own refusals is an account or an
  //                            id problem rather than a model that misbehaved
  //                            (`credit_exhausted`, `credential_rejected`,
  //                            `model_not_supported`), and `null` for the 5xx /
  //                            network / timeout cases that keep the fallback.
  //    `return null` is the "not fail-closed" answer and is deliberately NOT a
  //    reason: it is skipped rather than collected, and every OTHER return must
  //    still be a readable literal.
  for (const classifier of CLASSIFIERS) {
    const gapStart = source.indexOf(`export function ${classifier}(`);
    if (gapStart < 0) {
      throw new Error(`${SOURCE_PATH}: ${classifier}() is gone — the fail-closed reasons are now decided somewhere this scan does not read.`);
    }
    const gapBody = source.slice(gapStart, source.indexOf("\n}\n", gapStart));
    const gapReturns = [...gapBody.matchAll(/return\s+(?:"([^"\\]*)"|`([^`\\]*)`|(null))\s*;/g)];
    const gapReturnSites = countOf(gapBody, /return\s/g);
    const literals = gapReturns.filter((g) => g[3] === undefined);
    if (literals.length === 0 || gapReturns.length !== gapReturnSites) {
      throw new Error(
        `${SOURCE_PATH}: ${classifier}() has ${gapReturnSites} return(s) but ${gapReturns.length} readable (${literals.length} reason literal(s)) — a computed fail-closed reason cannot be pinned to ${DOC_PATH}.`,
      );
    }
    for (const g of literals) collect(g[1] ?? g[2] ?? "", `${classifier}() return`);
  }

  // The assignments feeding shape 4. A CLASSIFIER CALL is an allowed
  // right-hand side — shape 5 already read its literals — so those are the only
  // assignments that need not carry literals of their own; every other one must.
  // `this.reason = boundedReason(reason)` inside the error constructors is a
  // re-wrap of an already-collected value, not a producer, and is not matched.
  const reasonAssignRe = new RegExp(String.raw`(?:const|let|var)\s+(?:${OUTCOME_IDENTS.join("|")})\s*=\s*([^;]+);`, "g");
  let reasonAssignCount = 0;
  while ((m = reasonAssignRe.exec(source)) !== null) {
    reasonAssignCount += 1;
    if (CLASSIFIERS.some((c) => m![1]!.includes(`${c}(`))) continue;
    const found = literalsIn(m[1]!).filter((lit) => REASON_LITERAL.test(lit));
    if (found.length === 0) {
      throw new Error(`${SOURCE_PATH}: \`const ${m[1].trim()}\` yields no readable reason literal.`);
    }
    for (const lit of found) collect(lit, "reason assignment");
  }
  if (reasonAssignCount !== outcomeIdentCount) {
    throw new Error(
      `${SOURCE_PATH}: ${outcomeIdentCount} outcome site(s) fed by ${OUTCOME_IDENTS.map((i) => `\`${i}\``).join("/")} but ${reasonAssignCount} assignment(s) — one of them is fed from somewhere this scan does not read.`,
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
      `reachable in ${SOURCE_PATH} but absent from ${DOC_PATH} §9.7 — §9.7 claims exhaustiveness, so add these to its ${PARAGRAPH_ANCHOR} paragraph`,
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

  test("a refusal fed by an unknown variable trips the structural guard", () => {
    const mutated = source.replace("throw new JudgeUnavailableError(gap, opts.model ?? null);", "throw new JudgeUnavailableError(otherReason, opts.model ?? null);");
    expect(mutated).not.toBe(source);
    expect(() => reachableReasonKeys(mutated)).toThrow(/unrecognised variable/);
  });

  test("an outcome site fed by `reason` with no matching assignment trips the structural guard", () => {
    const mutated = source.replace(
      "throw new JudgeUnavailableError(gap, opts.model ?? null);",
      "throw new JudgeUnavailableError(gap, opts.model ?? null);\n    if (false) throw new JudgeUnavailableError(reason, null);",
    );
    expect(mutated).not.toBe(source);
    expect(() => reachableReasonKeys(mutated)).toThrow(/assignment\(s\)/);
  });

  // ── The D-A7 half: the deterministic fallback is scanned too ──────────────

  test("a fallback reason with no §9.7 entry is reported as undocumented", () => {
    const mutated = source.replace(
      "return fallbackOutcome(input, reason, transport.model);",
      'if (false) return fallbackOutcome(input, "planted_fallback_reason", null);\n    return fallbackOutcome(input, reason, transport.model);',
    );
    expect(mutated).not.toBe(source);
    const gap = missing(reachableReasonKeys(mutated), documentedReasonKeys(doc));
    expect(gap).toEqual(["planted_fallback_reason"]);
  });

  test("a computed fallback reason trips the structural guard", () => {
    const mutated = source.replace(
      "return fallbackOutcome(input, reason, transport.model);",
      "return fallbackOutcome(input, computeReason(), transport.model);",
    );
    expect(mutated).not.toBe(source);
    expect(() => reachableReasonKeys(mutated)).toThrow(/judge outcome sites but/);
  });

  test("losing judgeConfigGap() trips the classifier guard", () => {
    const mutated = source.replace("export function judgeConfigGap(", "function judgeConfigGapRenamed(");
    expect(mutated).not.toBe(source);
    expect(() => reachableReasonKeys(mutated)).toThrow(/judgeConfigGap\(\) is gone/);
  });

  test("a computed judgeConfigGap() return trips the classifier guard", () => {
    const mutated = source.replace('  return "model_unconfigured";\n}', "  return someComputedGap;\n}");
    expect(mutated).not.toBe(source);
    expect(() => reachableReasonKeys(mutated)).toThrow(/judgeConfigGap\(\) has/);
  });

  // ── The credit/credential half: Zen's own refusals are classified too ─────
  // These three are the reasons an EXHAUSTED ACCOUNT must fail closed on
  // (checklist §4.1). A scan that read only judgeConfigGap() would go green the
  // moment someone deleted the classifier and let a 402 fall back again.

  test("losing judgeTransportGap() trips the classifier guard", () => {
    const mutated = source.replace("export function judgeTransportGap(", "function judgeTransportGapRenamed(");
    expect(mutated).not.toBe(source);
    expect(() => reachableReasonKeys(mutated)).toThrow(/judgeTransportGap\(\) is gone/);
  });

  test("a computed judgeTransportGap() return trips the classifier guard", () => {
    const mutated = source.replace('return "credit_exhausted";', "return someComputedGap;");
    expect(mutated).not.toBe(source);
    expect(() => reachableReasonKeys(mutated)).toThrow(/judgeTransportGap\(\) has/);
  });

  test("the credit/credential reasons really are reachable and documented", () => {
    const reachable = reachableReasonKeys(source);
    const documented = documentedReasonKeys(doc);
    for (const reason of ["credit_exhausted", "credential_rejected", "model_not_supported"]) {
      expect(reachable.has(reason), `${reason} must be reachable in ${SOURCE_PATH}`).toBe(true);
      expect(documented.has(reason), `${reason} must be enumerated in ${DOC_PATH} §9.7`).toBe(true);
    }
  });

  test("a fail-closed reason dropped from §9.7 is reported as undocumented", () => {
    const mutated = doc.replaceAll("`credit_exhausted`", "`   `");
    expect(mutated).not.toBe(doc);
    expect(missing(reachableReasonKeys(source), documentedReasonKeys(mutated))).toContain("credit_exhausted");
  });

  test("the enumeration moving out of §9.7 trips the section check", () => {
    const paragraph = fallbackParagraph(doc);
    const mutated = doc.replace(paragraph, "") + `\n\n### 9.99 Elsewhere\n\n${paragraph}\n`;
    expect(() => documentedReasonKeys(mutated)).toThrow(/no longer inside/);
  });
});
