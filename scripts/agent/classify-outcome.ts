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
import { finalAssistantText } from "./transcript.ts";

export type OnboardingOutcome = "admitted" | "refused" | "rate-limited" | "timed-out" | "navigation-failure";

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
}

/**
 * Total, deterministic, first-match-wins classification of one member-agent
 * run (§11.3 E4's outcome classes).
 *
 *  1. admitted            — an admitted run is never reclassified, even if a
 *                           429 appears somewhere mid-transcript.
 *  2. rate-limited        — provider flake dominates: the run never happened.
 *                           Requires the STRUCTURAL conjunct in
 *                           `rateLimitDominates` — a pattern match anywhere in
 *                           the transcript is not enough, because tool output
 *                           echoes whatever the agent read.
 *  3. timed-out           — the agent was still going when the deadline
 *                           elapsed, so a refusal-shaped phrase early in a
 *                           20-minute transcript must not outrank it.
 *  4. refused             — the three-conjunct evidence above.
 *  5. navigation-failure  — everything else: the agent genuinely tried and did
 *                           not get there. The one outcome that is a real,
 *                           never-retried red result.
 */
export function classifyOutcome(run: ClassifiableRun): OnboardingOutcome {
  if (run.admitted) return "admitted";
  if (rateLimitDominates(run.transcript)) return "rate-limited";
  if (run.timedOut) return "timed-out";
  const cleanNoProgressExit = run.memberId === null && run.containerExitCode === 0;
  if (cleanNoProgressExit && looksRefusal(finalAssistantText(run.transcript ?? ""))) return "refused";
  return "navigation-failure";
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
 * NOTE for the layer-4 sampler: it deliberately does NOT consult this. A
 * sampler that retried refusals would erase the refusal RATE, which is the
 * metric the whole eval exists to report (§11.3 E4/E5).
 */
export function shouldRetry(outcome: OnboardingOutcome): boolean {
  return outcome === "rate-limited" || outcome === "refused" || outcome === "timed-out";
}
