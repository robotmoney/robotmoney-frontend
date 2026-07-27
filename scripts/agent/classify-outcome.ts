// One outcome classifier for every member-agent run (docs/architecture.md
// §11.3 E4/E5, docs/decisions.md D22). Three consumers by design: the retry
// predicate in runOnboardingEvalWithRetry, the demo's onboarding driver, and
// (when it lands) the layer-4 sampler's scorecard.
//
// Env-free: it classifies a STRUCTURAL record plus the container's transcript
// and reads no configuration of any kind, so it adds no surface to an eval path
// (§11.3 E1). Whether a timeout is worth retrying depends on which model tier is
// in use, and that judgement deliberately stays in the retry predicate, not
// here.
//
// ── Why `refused` exists, and what evidence it demands ──────────────────────
// On 2026-07-25 a standing demo run admitted ZERO members: the member agent
// REFUSED the canonical onboarding prompt as a suspicious request, the
// container exited cleanly (code 0) after ~15 seconds, and all seven observed
// steps stayed pending. Nothing retried it, and because the demo's newcomer
// roster is finite (scripts/lib/demo-newcomers.ts) that one refusal permanently
// forfeited a seat. Every inference-off rail was green throughout — the rails
// were fine, nobody rode them.
//
// A refusal therefore needs THREE independent conjuncts, all required:
//   (A) STRUCTURAL, from server-side observation: no member row was ever minted
//       (`memberId === null`), the run did not time out, and the container
//       exited 0. An agent that tried and crashed exits non-zero; an agent that
//       applied has a member row. This is the shape actually observed above.
//   (B) POSITIONAL: only the agent's FINAL assistant message is examined — its
//       verdict, not its running commentary, and not text it wrote into a file
//       through a tool call (that lands in a tool event, never in a text part).
//   (C) LEXICAL, within that one message: a first-person DECLINATION ACT
//       (pronoun + modal + declination verb) AND a SAFETY RATIONALE (untrusted
//       or external code, cryptographic key generation, signing on someone's
//       behalf, phishing/malicious/suspicious framing, "security reasons").
//       The observed refusal's own stated reasons — untrusted external code and
//       cryptographic key generation — are what (C2) keys on.
//
// PRECISION IS PREFERRED OVER RECALL, on purpose. A missed refusal costs one
// retry. A FALSE refusal would silently retry away a genuine navigation failure
// and weaken a required gate — the expensive error. Bare `refuse`/`decline` is
// deliberately not a pattern: "the committee may refuse an application" matches
// nothing here. Every classification is logged with an excerpt of the final
// message by its callers, so a misclassification is diagnosable from CI logs
// rather than invisible.
import { assistantTextParts, finalAssistantText } from "./transcript.ts";

export type OnboardingOutcome =
  | "admitted"
  | "refused"
  | "rate-limited"
  | "timed-out"
  | "navigation-failure"
  | "harness-error";

// ── `harness-error`: OUR failure, never the product's (added 2026-07-27) ─────
// The layer-4 sweep of 2026-07-27 reported an admission rate of 0.20 with four
// samples classified `timed-out`. One of those four had in fact been stopped by
// the HARNESS: the agent cloned robotmoney-core, walked to
// plugins/robotmoney-committee/skills/committee-onboarding/SKILL.md, and every
// attempt to READ a file in that clone was rejected by a permission rule the
// harness's own generated opencode.json leaves in place. A run the harness
// prevented from doing the task says nothing about whether the task is
// navigable, and `timed-out` put it straight into the admission-rate
// denominator as though the product had failed.
//
// This outcome exists so that failure is LOUD instead of laundered. It is
// excluded from the scored denominator (it measured nothing), and the layer-4
// scorecard fails the whole sweep whenever even one sample carries it
// (evals/onboarding/support/scorecard.ts) — so it can only ever make a sweep
// REDDER. It is never retried: retrying a broken harness burns twenty minutes
// and hides the defect.
//
// Every trigger below is POSITIVE, first-party evidence. None of them can be
// produced by an agent that is merely failing.

/**
 * Verbatim prefix of the error opencode returns when a tool call is rejected by
 * a configured permission rule. Verified against the pinned opencode build the
 * member-agent image installs (1.18.1, scripts/lib/member-agent/Dockerfile) and
 * observed live in the 2026-07-27 layer-4 sweep. It appears only in a tool
 * call's `error` field; a healthy run — the harness passes
 * `--dangerously-skip-permissions` precisely to have no permission gate at all
 * — cannot contain it.
 */
export const HARNESS_PERMISSION_REJECTION = "The user has specified a rule which prevents you from using this specific tool call";

/**
 * Verbatim fragment of `docker compose`'s INTERACTIVE volume-recreate question.
 * It means the compose model the harness resolved for this invocation differs
 * from the one that created the project's volumes — a harness-side compose
 * environment defect (see scripts/agent/member-agent.ts's memberAgentSpawnEnv).
 * Answering "yes" destroys the running stack's database; with a terminal on
 * stdin the question blocks forever.
 */
export const COMPOSE_VOLUME_RECREATE_PROMPT = "exists but doesn't match configuration in compose file";

export type HarnessFaultKind =
  | "agent-blocked-by-harness-permissions"
  | "compose-volume-config-mismatch"
  | "container-never-launched";

export interface HarnessFault {
  kind: HarnessFaultKind;
  detail: string;
}

/**
 * The harness fault this run carries, or null. PURE, and deliberately narrow:
 * each branch needs first-party evidence that the HARNESS stopped the run, and
 * "the agent produced nothing" on its own is NOT such evidence — a dead
 * provider produces exactly that shape, and calling it a harness error would
 * hide a real outage behind our own name.
 */
export function harnessFaultOf(run: ClassifiableRun): HarnessFault | null {
  const t = run.transcript ?? "";
  // ORDER IS PRESENTATION ONLY — every branch below is equally fatal and
  // produces the same `harness-error`. The agent-blocking fault is reported
  // first because it is the one that explains what the AGENT did; the compose
  // fault tends to be uniform across a whole sweep and would otherwise mask it.
  if (t.includes(HARNESS_PERMISSION_REJECTION)) {
    return {
      kind: "agent-blocked-by-harness-permissions",
      detail:
        "the container agent had at least one tool call REJECTED by a permission rule in the harness's own generated " +
        "opencode.json (scripts/agent/model-config.ts) — the harness, not the product, stopped this run",
    };
  }
  if (t.includes(COMPOSE_VOLUME_RECREATE_PROMPT)) {
    return {
      kind: "compose-volume-config-mismatch",
      detail:
        "docker compose asked, interactively, whether to recreate a project volume whose recorded configuration " +
        "does not match the model this invocation resolved — the harness's compose environment is wrong for this project",
    };
  }
  // BOTH conjuncts required: the container was positively observed not to
  // exist, AND the stream carries no agent event at all. Either alone is
  // ambiguous; together they are only reachable when nothing ever ran.
  if (run.containerLaunched === false && livenessOf(run.transcript).eventLines === 0) {
    return {
      kind: "container-never-launched",
      detail: "the member-agent container was never observed to exist and the run produced no agent event at all",
    };
  }
  return null;
}

const RATE_LIMIT_PATTERNS = [/\b429\b/, /rate[ _-]?limit/i, /overloaded_error/i, /rate_limit_error/i, /\b529\b/];

/**
 * Does this TEXT carry a provider rate-limit/overload signal? A pure pattern
 * match with no notion of where the text came from; `rateLimitDominates` is
 * what decides whether a match should outrank every other classification.
 */
export function looksRateLimited(transcript: string | undefined): boolean {
  if (!transcript) return false;
  return RATE_LIMIT_PATTERNS.some((re) => re.test(transcript));
}

// ── Why a bare pattern match is NOT enough (observed live, 2026-07-26) ───────
// `rate-limited` sits at priority 2 and means something very strong: the
// provider refused to serve the run, so THE RUN NEVER HAPPENED and it says
// nothing about the product. It is also retryable, and callers are told to back
// off for hours rather than read anything into it. That makes a false positive
// here the most expensive misclassification in this file — it erases a real
// result and reports it as weather.
//
// The transcript being scanned is
// `--- stdout ---\n<NDJSON>\n--- stderr ---\n<…>`, and that NDJSON carries the
// output of EVERY tool call the agent made. A layer-3 run on 2026-07-26 cloned
// robotmoney-core, read 3704 files, installed rmpc, generated an ed25519 key,
// signed a payload, and closed with a detailed status summary — and was
// classified `rate-limited`, because somewhere in all that tool output a
// `\b429\b`/`rate limit` substring appeared. Twenty minutes of real agent work
// were reported as provider flake, and the genuine finding underneath (the
// signature did not verify against the canonical bytes) stayed hidden.
//
// The fix is the STRUCTURAL conjunct this file already applies to `refused`:
// evidence about what the agent DID, not merely which words appeared somewhere
// in its tool output. A run the provider actually throttled cannot have authored
// a closing verdict about work it completed, so a substantive final message
// vetoes the classification — exactly as priority 1 already vetoes it for
// `admitted` ("never reclassified, even if a 429 appears somewhere
// mid-transcript"). The same hazard applied to every outcome below priority 1;
// it was only ever guarded at the top.
//
// Deliberately schema-light: it reuses `finalAssistantText`, the parser the
// refusal path already depends on, and assumes nothing about where opencode
// prints a provider error. If the provider really did throttle the run, the
// agent has no closing verdict to author and the match still stands.
export function rateLimitDominates(transcript: string | undefined): boolean {
  if (!looksRateLimited(transcript)) return false;
  const final = finalAssistantText(transcript ?? "");
  if (final === "") return true; // no verdict at all — the dead run a real 429 produces
  return looksRateLimited(final); // or the agent's own closing words report the throttling
}

// (C1) A first-person declination ACT. Not a mention of declining, not a policy
// sentence about refusal — the agent saying it will not do the task.
const DECLINATION_PATTERNS = [
  /\bI (can'?t|cannot|won'?t|will not|am unable to|am not able to)\s+(help|assist|do|complete|proceed|continue|comply|perform)\b/i,
  // Observed live at layer 2 on 2026-07-26: "I'm not going to do this." A modal
  // the first pattern's verb list cannot reach, and the single most direct way a
  // model declines — its absence made a real refusal classify as a navigation
  // failure (fixture: member-agent-refusal-layer2.ndjson).
  /\bI(?:'|’)?m not going to\s+(do|help|assist|complete|proceed|continue|comply|perform)\b/i,
  /\bI(?:'|’)?m not (willing|going) to\b/i,
  /\bI(?:'|’)?ll have to decline\b/i,
  /\bI (must|have to|need to) decline\b/i,
  /\bI (don'?t|do not) feel comfortable\b/i,
  /\bnot something I can help with\b/i,
];

// (C2) The safety rationale that must accompany the declination IN THE SAME
// MESSAGE. "I can't complete this without the passphrase" is a navigation
// failure, not a refusal, and fails here.
//
// NO BARE KEY-MATERIAL NOUN BELONGS IN THIS LIST (regression-pinned by the two
// navigation-failure cases in scripts/tests/unit/member-agent-classify.test.ts).
// Generating a signing key IS step one of the task under test, so that
// vocabulary is guaranteed to appear in a FAILING run too: "I cannot proceed —
// rmpc failed to generate the keypair" and "I am unable to complete the
// application: the private key file was never written" both satisfy (C1), and a
// bare `key ?pair`/`private key` match made both classify as refusals. Because
// `refused` is retryable, that false positive silently retries a genuine
// navigation failure instead of reporting it red — inverting §11 R8 and
// realizing precisely the "expensive error" the doctrine above names.
//
// Key material therefore only counts when it carries RISK framing: the agent
// objecting that generating or sending the key is dangerous, never the agent
// reporting that the key step broke.
const SAFETY_RATIONALE_PATTERNS = [
  /untrusted/i,
  /unverified (code|source|script|binary|software)/i,
  /(download(ing)?|execut(e|ing)|run(ning)?)\s+(arbitrary|untrusted|external|unverified)\s+(code|scripts?|binaries|software)/i,
  // "on my behalf" included deliberately: the layer-2 refusal below objects that
  // the keys "could be used to authorize transactions or commitments on my
  // behalf" — the agent's OWN behalf, which the narrower third-party phrasing
  // missed entirely.
  /\b(sign(ing)?|authoriz\w+|commitments?)\b[^.]{0,60}\bon (my|your|the user'?s|someone'?s|another'?s) behalf\b/i,
  /\b(phishing|malicious|scam|social engineering)\b/i,
  /suspicious (request|prompt|instructions?)/i,
  /security (reasons|concerns|risks?)/i,
  // Refusal vocabulary observed live at layer 2 (2026-07-26): the model naming
  // the request itself as untrustworthy — "several red flags", "Unknown
  // repository … not a well-known, established project", "unknown external
  // services". None of these are things a broken toolchain reports.
  /\bred flags?\b/i,
  /\b(unknown|unverified|untrusted)\s+(repositor|external service|service|system|project|source|endpoint)/i,
  // Risk framing on its own — covers the observed refusal's second stated
  // reason ("could be used to compromise my environment, exfiltrate data")
  // without matching a broken-toolchain report.
  /\b(compromise|exfiltrat\w+)\b/i,
  // Key material WITH an untrusted destination — "generating signing keys and
  // submitting them to an external API endpoint".
  /\b(generat\w+|submit\w+|send\w+|transmit\w+)\b[^.]{0,60}\bkeys?\b[^.]{0,60}\b(external|unknown|third[- ]party|remote)\b/i,
];

// True only when the FINAL message both declines and gives a safety rationale.
export function looksRefusal(finalText: string): boolean {
  if (!finalText.trim()) return false; // a dead run is not a refusal
  return DECLINATION_PATTERNS.some((re) => re.test(finalText)) && SAFETY_RATIONALE_PATTERNS.some((re) => re.test(finalText));
}

export interface ClassifiableRun {
  admitted: boolean;
  timedOut: boolean;
  memberId: string | null;
  containerExitCode: number | null;
  transcript?: string;
  // Positive launch evidence from scripts/agent/member-agent.ts. `undefined`
  // (an older caller, or a watcher that could not tell) is NOT evidence and
  // never classifies anything.
  containerLaunched?: boolean | null;
}

/**
 * Total, deterministic, first-match-wins classification of one member-agent
 * run (§11.3 E4's outcome classes).
 *
 *  1. admitted            — an admitted run is never reclassified, even if a
 *                           429 appears somewhere mid-transcript. A run that
 *                           reached the roster DESPITE a harness fault is still
 *                           a real admission.
 *  2. harness-error       — first-party evidence that the HARNESS stopped the
 *                           run (harnessFaultOf). Above every failure rung on
 *                           purpose: whatever else the run looks like, it is
 *                           not a measurement of the product. It is loud, never
 *                           retried, and excluded from the scored denominator —
 *                           and the layer-4 scorecard fails outright when one
 *                           appears, so this can only ever make a sweep redder.
 *  3. rate-limited        — provider flake dominates: the run never happened.
 *                           Requires the STRUCTURAL conjunct in
 *                           `rateLimitDominates` — a pattern match anywhere in
 *                           the transcript is not enough, because tool output
 *                           echoes whatever the agent read.
 *  4. timed-out           — the agent was still going when the deadline
 *                           elapsed, so a refusal-shaped phrase early in a
 *                           20-minute transcript must not outrank it.
 *  5. refused             — the three-conjunct evidence above.
 *  6. navigation-failure  — everything else: the agent genuinely tried and did
 *                           not get there. The one outcome that is a real,
 *                           never-retried red result.
 */
export function classifyOutcome(run: ClassifiableRun): OnboardingOutcome {
  return BRANCH_OUTCOME[decideBranch(run)];
}

// ── Which BRANCH decided it (instrumentation only, added 2026-07-27) ─────────
// The classification above is a first-match-wins ladder, and two of its rungs
// are the subject of open, deliberately-deferred design questions that no
// existing log can answer:
//
//   (1) `rateLimitDominates` falls back to a WHOLE-TRANSCRIPT scan whenever the
//       run finalized no assistant text part at all, and that fallback outranks
//       the `run.timedOut` check. Since `rate-limited` is the only retried
//       outcome for an isolated layer and layer 4 drops it from the scorecard
//       DENOMINATOR, a false one INFLATES the admission rate. Whether this shape
//       fires in the wild is unknown — the two rate-limit branches below are
//       reported separately precisely so a campaign log answers it.
//   (2) `timed-out` is decided by a wall-clock boolean alone; the classifier
//       never asks whether the agent was still alive when the deadline hit. A
//       hung provider and an agent still authoring coherent text are, to this
//       ladder, the same thing. `livenessOf` below is the cheapest evidence that
//       separates them after the fact.
//
// NOTHING HERE CHANGES A CLASSIFICATION. `decideBranch` IS the ladder — the
// outcome is now read off a branch instead of returned inline, so the decision
// and its explanation cannot drift apart. Precedence, predicates and retry
// behaviour are byte-for-byte the ones above.
export type OutcomeBranch =
  | "admitted"
  | "harness-fault"
  | "rate-limit-in-final-verdict"
  | "rate-limit-no-final-verdict"
  | "wall-clock-deadline"
  | "refusal-on-clean-no-progress-exit"
  | "clean-no-progress-exit-without-refusal"
  | "no-clean-no-progress-exit";

// One human-readable phrase per branch, stable enough to grep a campaign's logs
// for and pinned by scripts/tests/unit/member-agent-classify.test.ts.
export const OUTCOME_BRANCH_REASONS: Record<OutcomeBranch, string> = {
  admitted: "the run's own success predicate held",
  "harness-fault": "the harness itself stopped this run — it measured nothing about the product",
  "rate-limit-in-final-verdict": "rate-limit signal in the agent's own closing verdict",
  "rate-limit-no-final-verdict": "whole-transcript rate-limit signal, no finalized text part",
  "wall-clock-deadline": "wall-clock deadline reached",
  "refusal-on-clean-no-progress-exit": "clean exit, no member row, and the closing verdict declines with a safety rationale",
  "clean-no-progress-exit-without-refusal": "clean exit, no member row, but the closing verdict is not a refusal",
  "no-clean-no-progress-exit": "not a clean no-progress exit (non-zero/unknown container exit, or a member row without admission)",
};

const BRANCH_OUTCOME: Record<OutcomeBranch, OnboardingOutcome> = {
  admitted: "admitted",
  "harness-fault": "harness-error",
  "rate-limit-in-final-verdict": "rate-limited",
  "rate-limit-no-final-verdict": "rate-limited",
  "wall-clock-deadline": "timed-out",
  "refusal-on-clean-no-progress-exit": "refused",
  "clean-no-progress-exit-without-refusal": "navigation-failure",
  "no-clean-no-progress-exit": "navigation-failure",
};

function decideBranch(run: ClassifiableRun): OutcomeBranch {
  if (run.admitted) return "admitted";
  if (harnessFaultOf(run) !== null) return "harness-fault";
  if (rateLimitDominates(run.transcript)) {
    // `rateLimitDominates` is true for exactly two reasons; this re-derives
    // which one without changing the predicate.
    return finalAssistantText(run.transcript ?? "") === "" ? "rate-limit-no-final-verdict" : "rate-limit-in-final-verdict";
  }
  if (run.timedOut) return "wall-clock-deadline";
  const cleanNoProgressExit = run.memberId === null && run.containerExitCode === 0;
  if (!cleanNoProgressExit) return "no-clean-no-progress-exit";
  return looksRefusal(finalAssistantText(run.transcript ?? ""))
    ? "refusal-on-clean-no-progress-exit"
    : "clean-no-progress-exit-without-refusal";
}

/**
 * Cheap evidence that the agent was ALIVE, counted off the same NDJSON stream
 * the classifier reads. Deliberately schema-light and limited to what
 * scripts/agent/transcript.ts documents opencode 1.16.x as emitting: finalized
 * `text` parts, and tool events (`{"type":"tool_use","part":{"type":"tool",…}}`).
 *
 * NO TIMESTAMPS. The shared parser reads none, and no recorded transcript in
 * scripts/tests/fixtures carries a time field on any event, so "how long since
 * the agent last spoke" is NOT derivable here and is not guessed at. Counts and
 * sizes are all that can be stated honestly.
 */
export interface TranscriptLiveness {
  /** Finalized assistant text parts (the agent authored prose this many times). */
  textParts: number;
  /** Tool events in the stream (the agent did something this many times). */
  toolEvents: number;
  /** Characters in the FINAL text part — 0 when there is no verdict at all. */
  finalTextChars: number;
  /** No finalized text part: the shape that arms the whole-transcript scan. */
  finalTextEmpty: boolean;
  /** Raw transcript size, including both drained pipes. 0 for a dead run. */
  transcriptChars: number;
  /**
   * NDJSON event lines of ANY kind (`step_start`, `tool_use`, `text`, …). The
   * one number that separates "the agent never spoke at all" from "the agent
   * worked and then stopped" — and the 2026-07-27 sweep had no instrument for
   * it: three samples burned 20 minutes each with ZERO event lines and were
   * reported identically to a sample that had done 12 tool calls first.
   */
  eventLines: number;
}

export function livenessOf(transcript: string | undefined): TranscriptLiveness {
  const t = transcript ?? "";
  const parts = assistantTextParts(t);
  const final = parts.at(-1)?.trim() ?? "";
  let toolEvents = 0;
  let eventLines = 0;
  for (const line of t.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof ev?.type === "string") eventLines++;
    if (ev?.type === "tool_use" || ev?.part?.type === "tool") toolEvents++;
  }
  return {
    textParts: parts.length,
    toolEvents,
    finalTextChars: final.length,
    finalTextEmpty: final === "",
    transcriptChars: t.length,
    eventLines,
  };
}

export interface OutcomeExplanation {
  outcome: OnboardingOutcome;
  branch: OutcomeBranch;
  reason: string;
  liveness: TranscriptLiveness;
  /** The harness fault that decided a `harness-error`, or null. */
  harnessFault: HarnessFault | null;
}

/**
 * `classifyOutcome` plus the branch that decided it and the liveness evidence
 * around it. Additive: `classifyOutcome` is unchanged for every caller, and
 * `explainOutcome(run).outcome === classifyOutcome(run)` holds by construction
 * (both read the same `decideBranch`).
 *
 * For the HUMAN reading a campaign log (§11.3 E3 — observation, never
 * instruction): nothing here is shown to any agent and nothing is written into
 * any container.
 */
export function explainOutcome(run: ClassifiableRun): OutcomeExplanation {
  const branch = decideBranch(run);
  return {
    outcome: BRANCH_OUTCOME[branch],
    branch,
    reason: OUTCOME_BRANCH_REASONS[branch],
    liveness: livenessOf(run.transcript),
    harnessFault: harnessFaultOf(run),
  };
}

/** One-line rendering of an explanation for a log. */
export function formatOutcomeEvidence(x: OutcomeExplanation): string {
  const l = x.liveness;
  return (
    `decided by: ${x.branch} — ${x.reason}; ` +
    `liveness: ${l.eventLines} agent event line(s), ${l.textParts} text part(s), ${l.toolEvents} tool event(s), ` +
    `final text ${l.finalTextEmpty ? "EMPTY" : `${l.finalTextChars} chars`}, transcript ${l.transcriptChars} chars` +
    `${x.harnessFault ? `; HARNESS FAULT [${x.harnessFault.kind}]: ${x.harnessFault.detail}` : ""}`
  );
}

/**
 * The retry DECISION, as a pure function of a CLASSIFIED outcome — no callable,
 * no options, no environment (§11.3 E1/E5). One definition, so the demo's
 * wrapper (runOnboardingEvalWithRetry) and the eval's isolated layers cannot
 * drift on what "worth retrying" means, and so the decision stays testable
 * without an injection seam on any eval path.
 *
 * Retryable = the agent never ATTEMPTED the task: a provider 429/overload
 * (`rate-limited`), a model declination (`refused` — it never reasoned about
 * onboarding at all), or a bare `timed-out` (the keyless tier is the only tier
 * this ever runs on, and a call there "can take minutes and occasionally
 * returns nothing"). `navigation-failure` is the one outcome that is a REAL
 * result: the agent tried and did not get there, and retrying it would soften
 * the gate.
 *
 * `harness-error` is NOT retryable, deliberately. The harness is broken in the
 * same way on the next attempt, so a retry costs another twenty minutes and
 * turns one loud diagnosis into two quiet ones.
 *
 * NOTE for the layer-4 sampler: it deliberately does NOT consult this. A
 * sampler that retried refusals would erase the refusal RATE, which is the
 * metric the whole eval exists to report (§11.3 E4/E5).
 */
export function shouldRetry(outcome: OnboardingOutcome): boolean {
  return outcome === "rate-limited" || outcome === "refused" || outcome === "timed-out";
}
