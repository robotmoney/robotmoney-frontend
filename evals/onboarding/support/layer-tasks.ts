// The literal task text for eval layers 0-3 (docs/architecture.md §11.3 E3).
//
// Every layer task is DERIVED FROM THE CANONICAL ONBOARDING_PROMPT, verbatim,
// by slicing it — never by paraphrase. A slice that no longer matches THROWS on
// import, so an edit to the canonical prompt fails the eval loudly instead of
// silently evaluating prose nobody ships. (Layer 4 does not appear here at all:
// it uses ONBOARDING_PROMPT itself, via the shared buildAgentPrompt().)
//
// DELIBERATELY FREE OF HOW-TO. The whole point of a layer is to measure whether
// the agent can DISCOVER the step, so no task below may name a `curl` recipe, a
// releases URL, an install directory, an rmpc subcommand, or the apply
// endpoint. scripts/tests/unit/onboarding-layer-tasks.test.ts asserts exactly that
// on every PR — if you find yourself wanting to add a hint here, you are
// deleting the measurement.
//
// Layers are CUMULATIVE (1 ⊂ 2 ⊂ 3): each adds one canonical step to the
// previous task, so a red layer N with a green layer N-1 localises the failure
// to precisely the step N added.
import { ONBOARDING_PROMPT } from "@robotmoney/contract";
import { fillPromptIdentity, type OnboardingIdentity } from "../../../scripts/lib/onboarding-eval.ts";

// A fragment must appear in the canonical prompt EXACTLY. Anything else is
// drift, and drift here means the eval stopped measuring the shipped prompt.
function canonicalFragment(fragment: string): string {
  if (!ONBOARDING_PROMPT.includes(fragment)) {
    throw new Error(
      `ONBOARDING_PROMPT no longer contains the fragment the layered onboarding eval slices it at:\n  ${JSON.stringify(fragment)}\n` +
        `Update evals/onboarding/support/layer-tasks.ts to slice the CURRENT canonical prompt — never paraphrase it.`,
    );
  }
  return fragment;
}

// ── Layer 0 — runtime probe ─────────────────────────────────────────────────
// Robot-Money-FREE on purpose. Layer 0 answers exactly one question: is this
// container's agent alive and doing what it is told? That is what separates a
// DEAD runtime (bad image, unreachable provider, empty transcript) from a
// REFUSAL of our onboarding prompt — a distinction the 2026-07-25 zero-admission
// demo run had no instrument for at all. Nothing about Robot Money may appear
// in it, or a refusal of Robot Money would look like a dead runtime.
export const EVAL_PROBE_PATH = "/home/agent/eval-probe.txt";
export const EVAL_PROBE_CONTENT = "OK";
export const LAYER0_TASK =
  `Create a file at ${EVAL_PROBE_PATH} whose entire contents are the two characters ${EVAL_PROBE_CONTENT}. ` +
  "That is the whole task; nothing else is needed.";

// ── Layer 1 — skill install ─────────────────────────────────────────────────
// The canonical prompt's framing sentence plus its "install the
// committee-onboarding skill" sentence, VERBATIM, and nothing after it. It
// names the skill and where it lives; how to install one is the agent's own
// harness knowledge, which is the thing under test.
const IN_SHORT_MARKER = canonicalFragment("In short:");
export const LAYER1_TASK = ONBOARDING_PROMPT.slice(0, ONBOARDING_PROMPT.indexOf(IN_SHORT_MARKER)).trim();

// ── Layer 2 — rmpc toolchain ────────────────────────────────────────────────
// Layer 1 plus the TOOLCHAIN half of canonical step (a). No release URL, no
// arch mapping, no target directory: the agent working out which asset its own
// architecture needs IS the measurement (which is also why nothing on this
// path may call scripts/lib/rmpc-fetch.ts's host-side fetcher).
const STEP_A_TOOLCHAIN = canonicalFragment("install the rmpc message-signing client");
export const LAYER2_TASK = `${LAYER1_TASK} In short: (a) ${STEP_A_TOOLCHAIN}.`;

// ── Layer 3 — keygen + signing ──────────────────────────────────────────────
// Layer 2 plus canonical step (a) in full (keygen) and canonical step (b) with
// ONE deliberate substitution: "submit" becomes "produce". Layer 3 runs with NO
// server (§11.3 E3), so asking for a submission would send the agent chasing a
// host that does not exist and turn a signing measurement into a networking
// one. The signature is then verified OFFLINE by the harness against the
// contract's canonicalizeApplication.
const STEP_A_FULL = canonicalFragment("install the rmpc message-signing client and generate your signing key");
const STEP_B_APPLICATION = canonicalFragment(
  "the signed application — I am <display name>, contact <email>; it must be signed with your key, so it only completes if your setup actually works",
);
export const LAYER3_TASK_TEMPLATE = `${LAYER1_TASK} In short: (a) ${STEP_A_FULL}; (b) produce ${STEP_B_APPLICATION}.`;

// The identity substitution is the SAME one the demo and layer 4 perform —
// fillPromptIdentity throws if either placeholder has disappeared, so a real
// name/contact can never be silently stranded out of the task.
export function buildLayer3Task(identity: OnboardingIdentity): string {
  return fillPromptIdentity(LAYER3_TASK_TEMPLATE, identity);
}

// ── Harness note: non-interactive container + the owner's identity ──────────
// ENVIRONMENT INFO, never how-to — the same category as layer 4's local-network
// note (scripts/lib/onboarding-eval.ts's demoNetworkNote), kept clearly
// delimited and appended after the task rather than blended into it.
//
// Why it is REQUIRED for layers 1-2. Observed live on 2026-07-26, layer 1: the
// agent neither failed nor refused — it found the skill, understood the job, and
// then STOPPED to ask its owner two questions ("What display name and contact
// email should I use? Which host should I apply to?"). That is the correct move
// under the skill's own Step 0 ("if the owner's identity is missing or ambiguous,
// ask for it — never invent or guess"), and layers 1-2 slice the canonical prompt
// BEFORE the sentence carrying the identity, so the agent was asked to act on
// information the slice had removed. In a container with no owner to answer, the
// layer measured "does it ask a sensible question?" rather than "can it install
// the skill". This note restores exactly the two facts the slice dropped — who
// the owner is, and that nobody is there to reply — and nothing else.
//
// It names no install command, directory, URL, subcommand, or endpoint;
// scripts/tests/unit/onboarding-layer-tasks.test.ts re-runs the answer-leak
// assertions against the NOTED tasks to keep it that way.
export function harnessNote(identity: OnboardingIdentity): string {
  return (
    "\n\n---\n" +
    "Harness note (environment, not part of your task): you are running " +
    "non-interactively inside a container. No owner is available to answer " +
    "questions, so do not wait for confirmation — carry out the task, and if some " +
    "part of it is genuinely impossible, say so plainly and stop. The owner's " +
    `identity for this run is: display name ${identity.name}, contact ${identity.contact}.`
  );
}

// Layers 1 and 2 are pure canonical slices, so their identity arrives via the
// note. Layer 3's task already carries the identity inside canonical step (b),
// but it takes the same note for the non-interactive half.
export function buildLayer1Task(identity: OnboardingIdentity): string {
  return `${LAYER1_TASK}${harnessNote(identity)}`;
}
export function buildLayer2Task(identity: OnboardingIdentity): string {
  return `${LAYER2_TASK}${harnessNote(identity)}`;
}
export function buildLayer3TaskWithNote(identity: OnboardingIdentity): string {
  return `${buildLayer3Task(identity)}${harnessNote(identity)}`;
}
