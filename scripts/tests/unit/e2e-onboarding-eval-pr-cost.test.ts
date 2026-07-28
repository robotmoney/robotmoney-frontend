// CI-cost guard for the real-inference onboarding eval (issue #289, extended
// 2026-07-28 with a per-PR opt-in).
//
// WHAT THIS PROTECTS
// The required `e2e` gate used to set ONBOARDING_REAL_EVAL="1" unconditionally,
// spending a real model admission (with retries) on every non-draft PR. The
// free keyless OpenCode tier could not fund that at PR cadence — it was
// exhausted, and the required gate went red on every open PR for a reason
// unrelated to the code under test. The default model is funded now (D22 as
// amended), but this repo has ONE self-hosted runner, so an eval per PR is
// still minutes of exclusive runner time per PR against a stochastic metric.
//
// The arrangement the workflow now encodes, and this file asserts:
//   - an UNLABELLED pull_request run spends ZERO model tokens;
//   - a PR carrying the `real-eval` label DOES run the eval (that is the
//     debugging escape hatch — without it a change to this gate cannot be
//     exercised before merge, and only breaks `main` afterwards);
//   - a push to the default branch runs it;
//   - a `workflow_dispatch` runs it only when the `real_eval` input asked;
//   - labelling a PR with anything ELSE does not boot the ~40-minute live
//     stack (the job `if:` drops that event before a runner is allocated);
//   - the job-summary notice is driven by the SAME expression as the spend, so
//     it can never claim "DELIBERATELY NOT RUN" on a run that spent one.
//
// HOW IT IS ASSERTED — and why this is not a tautology
// Grepping for a substring of the expression passes for ANY expression
// containing that substring, including one that pays on every PR. So this file
// EVALUATES the workflow's real GitHub-Actions expressions against synthetic
// event contexts, using the miniature expression interpreter below, and
// asserts the resolved values. The RED CONTROLS feed that same interpreter
// deliberately-broken expressions — including one that is event-conditioned
// and mentions `pull_request` yet still pays on every PR — and require each
// guard to reject them.
//
// Cost class: fast unit. Pure file reads + expression evaluation — no Docker,
// no network, no model. Nothing here can skip; every test below runs on every
// invocation of `bun test scripts/tests/unit` (a required job).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const e2eYml = readFileSync(join(repoRoot, ".github/workflows/e2e.yml"), "utf8");
const nightlyYml = readFileSync(
  join(repoRoot, ".github/workflows/committee-opencode-nightly.yml"),
  "utf8",
);

/** The opt-in label. Changing it here without changing e2e.yml fails these tests. */
const OPT_IN_LABEL = "real-eval";

// ---------------------------------------------------------------------------
// A miniature GitHub-Actions expression interpreter.
//
// Supports exactly what e2e.yml's gating expressions use: `||`, `&&`, `!`,
// `==`, `!=`, parentheses, single-quoted strings, `true`/`false`/`null`,
// context paths (including the `.*.` array filter) and `contains()`. It
// reproduces Actions' value-returning `&&`/`||` (they yield an operand, not a
// boolean — which is what makes `cond && '1' || ''` work) and Actions' loose
// `==` casting. An unknown context root or function THROWS, so a workflow that
// starts using something this interpreter does not model fails loudly here
// rather than being silently mis-evaluated into a false green.
// ---------------------------------------------------------------------------
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Ctx = Record<string, Json>;
type Tok = { t: "op" | "str" | "num" | "id" | "punc"; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let out = "";
      let closed = false;
      while (j < src.length) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            out += "'";
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        out += src[j];
        j++;
      }
      if (!closed) throw new Error(`unterminated string literal in ${JSON.stringify(src)}`);
      toks.push({ t: "str", v: out });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "==" || two === "!=") {
      toks.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (c === "!") {
      toks.push({ t: "op", v: "!" });
      i++;
      continue;
    }
    if (c === "(" || c === ")" || c === ",") {
      toks.push({ t: "punc", v: c });
      i++;
      continue;
    }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num) {
      toks.push({ t: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.(?:\*|[A-Za-z_][A-Za-z0-9_-]*))*/.exec(src.slice(i));
    if (id) {
      toks.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in ${JSON.stringify(src)}`);
  }
  return toks;
}

function truthy(v: Json): boolean {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v !== "";
  return true;
}

/** Actions casts operands of differing types to numbers before comparing. */
function looseEq(a: Json, b: Json): boolean {
  if (typeof a === typeof b && (a === null || typeof a !== "object")) return a === b;
  if (a === null && b === null) return true;
  const num = (v: Json): number => {
    if (v === null) return 0;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") return v;
    if (typeof v === "string") return v === "" ? 0 : Number(v);
    return Number.NaN;
  };
  const na = num(a);
  const nb = num(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return false;
  return na === nb;
}

function resolveFrom(obj: Json, parts: string[]): Json {
  let cur: Json = obj;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (cur === null || typeof cur !== "object") return null;
    if (p === "*") {
      if (!Array.isArray(cur)) return null;
      const rest = parts.slice(i + 1);
      return rest.length === 0 ? cur : (cur.map((el) => resolveFrom(el, rest)) as Json);
    }
    if (Array.isArray(cur)) return null;
    const next = (cur as { [k: string]: Json })[p];
    cur = next === undefined ? null : next;
  }
  return cur;
}

function resolvePath(ctx: Ctx, path: string): Json {
  const parts = path.split(".");
  if (!(parts[0]! in ctx)) {
    throw new Error(`unknown context root ${JSON.stringify(parts[0])} in ${JSON.stringify(path)}`);
  }
  return resolveFrom(ctx[parts[0]!]!, parts.slice(1));
}

function containsFn(search: Json, item: Json): boolean {
  if (Array.isArray(search)) return search.some((x) => looseEq(x, item));
  const s = search === null ? "" : String(search);
  const i = item === null ? "" : String(item);
  return s.includes(i);
}

/** Evaluate one Actions expression (WITHOUT the surrounding `${{ }}`). */
export function evalExpression(src: string, ctx: Ctx): Json {
  const toks = tokenize(src);
  let pos = 0;
  const peek = (): Tok | undefined => toks[pos];
  const eat = (t: Tok["t"], v: string): boolean => {
    const p = peek();
    if (p && p.t === t && p.v === v) {
      pos++;
      return true;
    }
    return false;
  };

  function parsePrimary(): Json {
    const p = peek();
    if (!p) throw new Error(`unexpected end of expression in ${JSON.stringify(src)}`);
    if (eat("punc", "(")) {
      const v = parseOr();
      if (!eat("punc", ")")) throw new Error(`missing ) in ${JSON.stringify(src)}`);
      return v;
    }
    if (p.t === "str") {
      pos++;
      return p.v;
    }
    if (p.t === "num") {
      pos++;
      return Number(p.v);
    }
    if (p.t === "id") {
      pos++;
      const next = peek();
      if (next && next.t === "punc" && next.v === "(") {
        pos++;
        const args: Json[] = [];
        if (!eat("punc", ")")) {
          for (;;) {
            args.push(parseOr());
            if (eat("punc", ")")) break;
            if (!eat("punc", ",")) throw new Error(`bad argument list in ${JSON.stringify(src)}`);
          }
        }
        if (p.v === "contains") return containsFn(args[0] ?? null, args[1] ?? null);
        if (p.v === "always") return true;
        throw new Error(`unsupported function ${p.v}() in ${JSON.stringify(src)}`);
      }
      if (p.v === "true") return true;
      if (p.v === "false") return false;
      if (p.v === "null") return null;
      return resolvePath(ctx, p.v);
    }
    throw new Error(`unexpected token ${JSON.stringify(p.v)} in ${JSON.stringify(src)}`);
  }

  function parseUnary(): Json {
    if (eat("op", "!")) return !truthy(parseUnary());
    return parsePrimary();
  }

  function parseCmp(): Json {
    let left = parseUnary();
    for (;;) {
      if (eat("op", "==")) left = looseEq(left, parseUnary());
      else if (eat("op", "!=")) left = !looseEq(left, parseUnary());
      else return left;
    }
  }

  function parseAnd(): Json {
    let left = parseCmp();
    while (eat("op", "&&")) {
      const right = parseCmp();
      left = truthy(left) ? right : left;
    }
    return left;
  }

  function parseOr(): Json {
    let left = parseAnd();
    while (eat("op", "||")) {
      const right = parseAnd();
      left = truthy(left) ? left : right;
    }
    return left;
  }

  const value = parseOr();
  if (pos !== toks.length) throw new Error(`trailing tokens in ${JSON.stringify(src)}`);
  return value;
}

// ---------------------------------------------------------------------------
// Pulling the real expressions out of the workflow file.
// ---------------------------------------------------------------------------

/** Strip the `${{ … }}` wrapper; throws when a mapping value is not one. */
function unwrap(raw: string, label: string): string {
  const m = /^\$\{\{(.*)\}\}$/s.exec(raw.trim());
  if (!m) throw new Error(`${label}: ${JSON.stringify(raw)} is not a single \${{ }} expression`);
  return m[1]!;
}

/** The sole `KEY: <value>` mapping line in a workflow, as raw text. */
export function soleMappingValue(workflow: string, key: string): string {
  const values = workflow
    .split("\n")
    .filter((l) => new RegExp(`^\\s*${key}:`).test(l))
    .map((l) => l.replace(new RegExp(`^\\s*${key}:\\s*`), "").trim());
  if (values.length === 0) throw new Error(`workflow sets ${key} nowhere`);
  if (values.length > 1) {
    throw new Error(`workflow sets ${key} ${values.length} times; expected once`);
  }
  return values[0]!;
}

/** The job-level `if:` guard (4-space indent — step guards are deeper). */
export function jobIfExpression(workflow: string): string {
  const lines = workflow.split("\n").filter((l) => /^ {4}if:/.test(l));
  if (lines.length !== 1) {
    throw new Error(`expected exactly one job-level if:, found ${lines.length}`);
  }
  return unwrap(lines[0]!.replace(/^ {4}if:\s*/, ""), "job if");
}

// Split a workflow into per-step blocks (each starts at "- name:") so an
// assertion is scoped to the step it is about — a matching string elsewhere in
// the file cannot satisfy it.
function stepBlocks(workflow: string): string[] {
  return workflow.split(/\n\s*- name:/).slice(1);
}
function stepContaining(workflow: string, needle: string, label: string): string {
  const block = stepBlocks(workflow).find((b) => b.includes(needle));
  if (!block) throw new Error(`${label}: no step containing ${JSON.stringify(needle)}`);
  return block;
}

// ---------------------------------------------------------------------------
// Synthetic event contexts standing in for the payloads GitHub delivers.
// ---------------------------------------------------------------------------
function prContext(opts: {
  labels: string[];
  draft?: boolean;
  action?: string;
  fork?: boolean;
}): Ctx {
  return {
    github: {
      event_name: "pull_request",
      repository: "org/repo",
      event: {
        action: opts.action ?? "synchronize",
        // On a `labeled` event the payload also carries the label just added.
        ...(opts.action === "labeled"
          ? { label: { name: opts.labels[opts.labels.length - 1] ?? "" } }
          : {}),
        pull_request: {
          draft: opts.draft ?? false,
          labels: opts.labels.map((name) => ({ name })),
          head: { repo: { full_name: opts.fork ? "someone-else/repo" : "org/repo" } },
        },
      },
    },
    inputs: {},
  };
}

const CTX = {
  push: { github: { event_name: "push", repository: "org/repo", event: {} }, inputs: {} } as Ctx,
  prPlain: prContext({ labels: [] }),
  prOtherLabels: prContext({ labels: ["documentation", "phase-3"] }),
  prOptedIn: prContext({ labels: [OPT_IN_LABEL] }),
  prDraft: prContext({ labels: [], draft: true }),
  prLabeledOther: prContext({ labels: ["documentation"], action: "labeled" }),
  prLabeledOptIn: prContext({ labels: [OPT_IN_LABEL], action: "labeled" }),
  prLabeledOptInDraft: prContext({ labels: [OPT_IN_LABEL], action: "labeled", draft: true }),
  dispatchOff: {
    github: { event_name: "workflow_dispatch", repository: "org/repo", event: {} },
    inputs: { real_eval: false },
  } as Ctx,
  dispatchOn: {
    github: { event_name: "workflow_dispatch", repository: "org/repo", event: {} },
    inputs: { real_eval: true },
  } as Ctx,
};

// ---------------------------------------------------------------------------
// The graded properties, written as functions over an EXPRESSION so the same
// code that grades the real workflow can be pointed at a broken one. Each
// returns null when the property holds, or a reason string when it does not.
// ---------------------------------------------------------------------------

/**
 * The spend expression must resolve to "" for every ordinary PR run and to "1"
 * for exactly the three opt-in routes.
 */
export function realEvalSpendIsOptIn(expr: string): string | null {
  const cases: Array<[string, Ctx, string]> = [
    ["an unlabelled pull_request run", CTX.prPlain, ""],
    ["a pull_request run carrying unrelated labels", CTX.prOtherLabels, ""],
    ["a draft pull_request run", CTX.prDraft, ""],
    ["a workflow_dispatch that did not ask for the eval", CTX.dispatchOff, ""],
    [`a pull_request labelled '${OPT_IN_LABEL}'`, CTX.prOptedIn, "1"],
    [`a labeled event adding '${OPT_IN_LABEL}'`, CTX.prLabeledOptIn, "1"],
    ["a push to the default branch", CTX.push, "1"],
    ["a workflow_dispatch with real_eval=true", CTX.dispatchOn, "1"],
  ];
  for (const [what, ctx, want] of cases) {
    let got: Json;
    try {
      got = evalExpression(expr, ctx);
    } catch (err) {
      return `${what}: expression did not evaluate — ${(err as Error).message}`;
    }
    if (got !== want) {
      return want === ""
        ? `${what} resolves the eval spend to ${JSON.stringify(got)} — it must be "" (zero model tokens)`
        : `${what} resolves the eval spend to ${JSON.stringify(got)} — the opt-in must resolve to "1"`;
    }
  }
  return null;
}

/**
 * The job guard must keep drafts out (unchanged) AND must not let a `labeled`
 * event for an unrelated label boot the full live stack.
 */
export function jobGuardIsLabelNarrowed(expr: string): string | null {
  const cases: Array<[string, Ctx, boolean]> = [
    ["a push to the default branch", CTX.push, true],
    ["a non-draft pull_request", CTX.prPlain, true],
    ["a draft pull_request", CTX.prDraft, false],
    [`adding the '${OPT_IN_LABEL}' label`, CTX.prLabeledOptIn, true],
    ["adding an unrelated label", CTX.prLabeledOther, false],
    [`adding '${OPT_IN_LABEL}' to a DRAFT pull_request`, CTX.prLabeledOptInDraft, false],
    ["a manual workflow_dispatch", CTX.dispatchOn, true],
  ];
  for (const [what, ctx, want] of cases) {
    let got: boolean;
    try {
      got = truthy(evalExpression(expr, ctx));
    } catch (err) {
      return `${what}: the job if: did not evaluate — ${(err as Error).message}`;
    }
    if (got !== want) {
      return want
        ? `${what} SKIPS the e2e job; it must run`
        : `${what} RUNS the whole e2e job; it must be skipped before a runner is allocated`;
    }
  }
  return null;
}

/**
 * Holds when the job summary written on a PR run that did NOT spend an eval
 * says so, names where the eval does run, and says how to opt this PR in. A
 * silent withholding is the failure mode this catches.
 */
export function prSummaryNamesTheNightly(workflow: string): string | null {
  let step: string;
  try {
    step = stepContaining(workflow, "GITHUB_STEP_SUMMARY", "e2e.yml");
  } catch {
    return "no step writes to GITHUB_STEP_SUMMARY";
  }
  if (!/IS_PULL_REQUEST/.test(step)) {
    return "the summary step does not branch on whether this is a pull_request run";
  }
  const marker = /\[\s*"\$IS_PULL_REQUEST"\s*=\s*"true"\s*\]/.exec(step);
  if (!marker) return "the summary step never tests $IS_PULL_REQUEST in its shell body";
  const prBranch = step.slice(marker.index);
  if (!prBranch.includes("committee-opencode-nightly.yml")) {
    return "the PR-run summary does not name committee-opencode-nightly.yml as the eval's home";
  }
  if (!prBranch.includes("workflow_dispatch")) {
    return "the PR-run summary does not name workflow_dispatch as the eval's other trigger";
  }
  if (!/NOT RUN/.test(prBranch)) {
    return "the PR-run summary does not state plainly that the eval was not run here";
  }
  if (!prBranch.includes(OPT_IN_LABEL)) {
    return `the PR-run summary does not tell the reader to add the '${OPT_IN_LABEL}' label to opt in`;
  }
  return null;
}

/**
 * Holds when the "did not run" notice is gated on the SAME expression that
 * gates the spend. Otherwise the notice can drift into lying — claiming a
 * deliberate skip on a run that in fact spent an eval.
 */
export function noticeTracksTheSpend(workflow: string): string | null {
  let requested: string;
  let spend: string;
  try {
    requested = soleMappingValue(workflow, "REAL_EVAL_REQUESTED");
    spend = soleMappingValue(workflow, "ONBOARDING_REAL_EVAL");
  } catch (err) {
    return (err as Error).message;
  }
  if (requested !== spend) {
    return `REAL_EVAL_REQUESTED ${requested} differs from ONBOARDING_REAL_EVAL ${spend}; the job summary can lie about what ran`;
  }
  let step: string;
  try {
    step = stepContaining(workflow, "GITHUB_STEP_SUMMARY", "e2e.yml");
  } catch {
    return "no step writes to GITHUB_STEP_SUMMARY";
  }
  if (!/\[\s*"\$REAL_EVAL_REQUESTED"\s*=\s*"1"\s*\]/.test(step)) {
    return "the summary step does not branch on $REAL_EVAL_REQUESTED";
  }
  const notRunIdx = step.indexOf("DELIBERATELY NOT RUN");
  const requestedIdx = step.indexOf('"$REAL_EVAL_REQUESTED" = "1"');
  if (notRunIdx === -1) return 'the summary step never says "DELIBERATELY NOT RUN"';
  if (notRunIdx < requestedIdx) {
    return "the 'DELIBERATELY NOT RUN' message is not inside the branch guarded by $REAL_EVAL_REQUESTED";
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. The real workflow passes every check.
// ---------------------------------------------------------------------------
describe("e2e.yml spends no onboarding eval on an unlabelled pull_request", () => {
  test("the spend expression resolves to '' on ordinary PRs and '1' on the opt-in routes", () => {
    const expr = unwrap(soleMappingValue(e2eYml, "ONBOARDING_REAL_EVAL"), "ONBOARDING_REAL_EVAL");
    expect(realEvalSpendIsOptIn(expr)).toBeNull();
  });

  test("the job guard skips drafts and ignores label events for other labels", () => {
    expect(jobGuardIsLabelNarrowed(jobIfExpression(e2eYml))).toBeNull();
  });

  test(`adding the '${OPT_IN_LABEL}' label re-triggers the workflow (pull_request types)`, () => {
    // Without `labeled` in the trigger list, applying the label would do
    // nothing until the next push — the opt-in would not be usable for the
    // debugging loop it exists to serve.
    const types = /^\s*types:\s*\[(.*)\]\s*$/m.exec(e2eYml);
    expect(types).not.toBeNull();
    const list = types![1]!.split(",").map((s) => s.trim());
    expect(list).toContain("labeled");
    // ready_for_review must survive: it is what defers this system-correctness
    // gate until the PR leaves draft.
    expect(list).toContain("ready_for_review");
  });

  test("workflow_dispatch exposes a real_eval input, defaulting to off", () => {
    const dispatch = /workflow_dispatch:\n(?:.*\n)*?[ ]*inputs:\n((?:[ ]{6,}.*\n)+)/.exec(e2eYml);
    expect(dispatch).not.toBeNull();
    expect(dispatch![1]!).toContain("real_eval:");
    expect(dispatch![1]!).toContain("type: boolean");
    expect(dispatch![1]!).toContain("default: false");
  });

  test("the PR-path summary says the eval did not run, names the nightly, and says how to opt in", () => {
    expect(prSummaryNamesTheNightly(e2eYml)).toBeNull();
  });

  test("the summary notice is driven by the same expression as the spend", () => {
    expect(noticeTracksTheSpend(e2eYml)).toBeNull();
  });

  test("no comment still claims the eval always/unconditionally runs on PRs", () => {
    const offenders = e2eYml
      .split("\n")
      .filter((l) => /^\s*#/.test(l))
      .filter((l) =>
        /onboarding eval ALWAYS runs|unconditionally "1"|UNCONDITIONALLY for every PR/i.test(l),
      );
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. RED CONTROLS. Deliberately-broken inputs MUST be rejected — proof that the
//    checks above are load-bearing and not vacuously green.
// ---------------------------------------------------------------------------
describe("red control: the guards reject workflows that spend an eval per PR", () => {
  test('an unconditional eval spend of "1" is reported, not accepted', () => {
    const reason = realEvalSpendIsOptIn("'1'");
    expect(reason).not.toBeNull();
    expect(reason).toContain("unlabelled pull_request");
  });

  test("an expression that MENTIONS pull_request but still pays on every PR is reported", () => {
    // The pre-2026-07-28 substring checks ("must contain github.event_name",
    // "must mention pull_request") all pass for this expression. Only actually
    // evaluating it catches that every PR spends a model call.
    const reason = realEvalSpendIsOptIn(
      "(github.event_name != 'pull_request' || github.event.pull_request.draft == false) && '1' || ''",
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("zero model tokens");
  });

  test("an expression with no opt-in route at all is reported", () => {
    // Cost-safe, but it re-creates the hole this change exists to close: the
    // gate could not be exercised on a PR before merge.
    const reason = realEvalSpendIsOptIn("github.event_name == 'push' && '1' || ''");
    expect(reason).not.toBeNull();
    expect(reason).toContain('the opt-in must resolve to "1"');
  });

  test("a job guard without the label narrowing is reported (every label would boot the stack)", () => {
    const reason = jobGuardIsLabelNarrowed(
      "github.event_name != 'pull_request' || github.event.pull_request.draft == false",
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("RUNS the whole e2e job");
  });

  test("a job guard that lost the draft deferral is reported", () => {
    const reason = jobGuardIsLabelNarrowed(
      `github.event.action != 'labeled' || github.event.label.name == '${OPT_IN_LABEL}'`,
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("draft pull_request");
  });

  const SILENT_FIXTURE = [
    "jobs:",
    "  e2e:",
    "    if: ${{ github.event_name != 'pull_request' }}",
    "    steps:",
    "      - name: Configure onboarding real-inference eval",
    "        env:",
    "          IS_PULL_REQUEST: ${{ github.event_name == 'pull_request' }}",
    "        run: |",
    '          echo "eval running" >> "$GITHUB_STEP_SUMMARY"',
    "      - name: Full-stack demo (demo readiness gate)",
    "        env:",
    '          ONBOARDING_REAL_EVAL: "1"',
    "",
  ].join("\n");

  test("a summary that never names the nightly is reported, not accepted", () => {
    const reason = prSummaryNamesTheNightly(SILENT_FIXTURE);
    expect(reason).not.toBeNull();
    expect(reason).toContain("$IS_PULL_REQUEST");
  });

  test("a notice not wired to the spend expression is reported", () => {
    const reason = noticeTracksTheSpend(SILENT_FIXTURE);
    expect(reason).not.toBeNull();
    expect(reason).toContain("REAL_EVAL_REQUESTED");
  });

  test("a workflow with no ONBOARDING_REAL_EVAL line at all is reported too", () => {
    expect(() => soleMappingValue("jobs:\n  e2e:\n    steps: []\n", "ONBOARDING_REAL_EVAL")).toThrow(
      /sets ONBOARDING_REAL_EVAL nowhere/,
    );
  });

  test("two ONBOARDING_REAL_EVAL lines are reported (each would need its own guard)", () => {
    expect(() =>
      soleMappingValue(
        '          ONBOARDING_REAL_EVAL: "1"\n          ONBOARDING_REAL_EVAL: ""\n',
        "ONBOARDING_REAL_EVAL",
      ),
    ).toThrow(/2 times/);
  });
});

// ---------------------------------------------------------------------------
// 3. The interpreter itself is exercised, so a bug in it cannot silently make
//    every assertion above vacuous.
// ---------------------------------------------------------------------------
describe("the expression interpreter reproduces Actions semantics", () => {
  test("&& / || return operands, not booleans", () => {
    expect(evalExpression("true && '1' || ''", {})).toBe("1");
    expect(evalExpression("false && '1' || ''", {})).toBe("");
    expect(evalExpression("'' || 'fallback'", {})).toBe("fallback");
  });

  test("contains() works over the .*. array filter and over plain strings", () => {
    expect(
      evalExpression(
        `contains(github.event.pull_request.labels.*.name, '${OPT_IN_LABEL}')`,
        CTX.prOptedIn,
      ),
    ).toBe(true);
    expect(
      evalExpression("contains(github.event.pull_request.labels.*.name, 'nope')", CTX.prOptedIn),
    ).toBe(false);
    // A push carries no pull_request object at all — false, not a throw.
    expect(
      evalExpression(
        `contains(github.event.pull_request.labels.*.name, '${OPT_IN_LABEL}')`,
        CTX.push,
      ),
    ).toBe(false);
  });

  test("an unknown context root throws instead of silently resolving to null", () => {
    expect(() => evalExpression("secrets.SOMETHING != ''", {})).toThrow(/unknown context root/);
  });

  test("an unsupported function throws instead of being ignored", () => {
    expect(() => evalExpression("startsWith('a', 'b')", {})).toThrow(/unsupported function/);
  });
});

// ---------------------------------------------------------------------------
// 4. The compensating coverage the default PR path still carries, and the
//    nightly the summary points at, both still exist.
// ---------------------------------------------------------------------------
describe("the coverage that replaces the per-PR eval is really there", () => {
  test("the inference-off rails step still runs on PRs, with no if: guard", () => {
    const step = stepContaining(
      e2eYml,
      "bun test scripts/tests/integration/onboarding-eval-infra.test.ts",
      "e2e.yml",
    );
    expect(step).toContain("Onboarding eval infra rails (inference-off, fail-fast)");
    // An `if:` on this step would let the last onboarding-surface assertion a
    // PR makes disappear as quietly as the eval did.
    expect(step).not.toMatch(/^\s*if:/m);
  });

  test("the nightly still sets ONBOARDING_REAL_EVAL=1 on schedule + workflow_dispatch", () => {
    expect(nightlyYml).toContain('ONBOARDING_REAL_EVAL: "1"');
    expect(nightlyYml).toContain('cron: "37 4 * * *"');
    expect(nightlyYml).toContain("workflow_dispatch:");
    // Heavy sweep-only class: a `pull_request` trigger here would re-import the
    // exact per-PR spend #289 removed.
    expect(nightlyYml).not.toMatch(/^\s{2}pull_request:/m);
  });
});
