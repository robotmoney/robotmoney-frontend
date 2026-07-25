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

export function looksRateLimited(transcript: string | undefined): boolean {
  if (!transcript) return false;
  return RATE_LIMIT_PATTERNS.some((re) => re.test(transcript));
}

// (C1) A first-person declination ACT. Not a mention of declining, not a policy
// sentence about refusal — the agent saying it will not do the task.
const DECLINATION_PATTERNS = [
  /\bI (can'?t|cannot|won'?t|will not|am unable to|am not able to)\s+(help|assist|do|complete|proceed|continue|comply|perform)\b/i,
  /\bI(?:'|’)?ll have to decline\b/i,
  /\bI (must|have to|need to) decline\b/i,
  /\bI (don'?t|do not) feel comfortable\b/i,
  /\bnot something I can help with\b/i,
];

// (C2) The safety rationale that must accompany the declination IN THE SAME
// MESSAGE. "I can't complete this without the passphrase" is a navigation
// failure, not a refusal, and fails here.
const SAFETY_RATIONALE_PATTERNS = [
  /untrusted/i,
  /unverified (code|source|script|binary|software)/i,
  /(download(ing)?|execut(e|ing)|run(ning)?)\s+(arbitrary|untrusted|external|unverified)\s+(code|scripts?|binaries|software)/i,
  /\b(cryptographic key|crypto(graphic)? keypair|key ?pair|private key)\b/i,
  /sign(ing)? (something )?on (your|the user'?s|someone'?s|another'?s) behalf/i,
  /\b(phishing|malicious|scam|social engineering)\b/i,
  /suspicious (request|prompt|instructions?)/i,
  /security (reasons|concerns|risks?)/i,
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
  if (looksRateLimited(run.transcript)) return "rate-limited";
  if (run.timedOut) return "timed-out";
  const cleanNoProgressExit = run.memberId === null && run.containerExitCode === 0;
  if (cleanNoProgressExit && looksRefusal(finalAssistantText(run.transcript ?? ""))) return "refused";
  return "navigation-failure";
}
