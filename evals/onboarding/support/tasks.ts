// The literal task text for the isolated onboarding claims (runtime,
// skill-install, toolchain, keygen-signing — docs/architecture.md §11.3 E3).
//
// Every non-runtime claim is DERIVED FROM THE CANONICAL ONBOARDING_PROMPT,
// verbatim, by slicing it — never by paraphrase. A slice that no longer
// matches THROWS on import, so an edit to the canonical prompt fails the eval
// loudly instead of silently evaluating prose nobody ships.
//
// DELIBERATELY FREE OF HOW-TO beyond what the canonical prompt itself already
// names. The whole point of a claim is to measure whether the agent can
// DISCOVER the next step on its own, so no task below may add a `curl`
// recipe, an install directory, an rmpc subcommand, or the apply endpoint —
// scripts/tests/unit/onboarding-eval-tasks.test.ts asserts exactly that on
// every PR.
//
// CUMULATIVE (skill-install ⊂ toolchain ⊂ keygen-signing), so a red claim with
// a green predecessor localises the failure to precisely the step it added.
// The current canonical prompt states the toolchain/keygen/submit sequence as
// ONE comma-separated clause inside a single sentence (it no longer carries
// the old per-step "(a)/(b)" breakdown), so the cumulative slices below cut at
// successive commas within that one sentence rather than at sentence
// boundaries — still a verbatim prefix at every step, just a finer-grained one.
import { ONBOARDING_PROMPT } from "@robotmoney/contract";

// A fragment must appear in the canonical prompt EXACTLY. Anything else is
// drift, and drift here means the eval stopped measuring the shipped prompt.
function canonicalFragment(fragment: string): string {
  if (!ONBOARDING_PROMPT.includes(fragment)) {
    throw new Error(
      `ONBOARDING_PROMPT no longer contains the fragment the isolated onboarding claims slice it at:\n  ${JSON.stringify(fragment)}\n` +
        "Update evals/onboarding/support/tasks.ts to slice the CURRENT canonical prompt — never paraphrase it.",
    );
  }
  return fragment;
}

function sliceThrough(fragment: string): string {
  const anchor = canonicalFragment(fragment);
  const end = ONBOARDING_PROMPT.indexOf(anchor) + anchor.length;
  return ONBOARDING_PROMPT.slice(0, end);
}

// ── runtime — the runtime probe ──────────────────────────────────────────────
// Robot-Money-FREE on purpose. `runtime` answers exactly one question: is this
// container's agent alive and doing what it is told? That is what separates a
// DEAD runtime (bad image, unreachable provider, empty transcript) from a
// REFUSAL of our onboarding prompt. Nothing about Robot Money may appear in
// it, or a refusal of Robot Money would look like a dead runtime.
export const EVAL_PROBE_PATH = "/home/agent/eval-probe.txt";
export const EVAL_PROBE_CONTENT = "OK";
export const RUNTIME_TASK =
  `Create a file at ${EVAL_PROBE_PATH} whose entire contents are the two characters ${EVAL_PROBE_CONTENT}. ` +
  "That is the whole task; nothing else is needed.";

// ── skill-install ────────────────────────────────────────────────────────────
// The canonical prompt's framing, its two bounds, and the ask to install the
// swarm-onboarding skill — verbatim, up to (and including) the colon that
// introduces what the skill carries, and nothing after it. It names the skill
// and where it lives; how to install one is the agent's own harness
// knowledge, which is the thing under test.
const SKILL_INSTALL_ANCHOR = "it carries the whole current procedure:";
export const SKILL_INSTALL_TASK = sliceThrough(SKILL_INSTALL_ANCHOR).trim();

// ── toolchain ────────────────────────────────────────────────────────────────
// skill-install's task plus the TOOLCHAIN clause of what the skill carries. No
// release URL, no arch mapping, no target directory: the agent working out
// which asset its own architecture needs IS the measurement.
const TOOLCHAIN_ANCHOR = "install the rmpc message-signing client";
export const TOOLCHAIN_TASK = `${sliceThrough(TOOLCHAIN_ANCHOR)}.`;

// ── keygen-signing ───────────────────────────────────────────────────────────
// toolchain's clause plus the KEYGEN clause, with ONE deliberate substitution:
// "submit the signed application over the REST API" becomes "produce the
// signed application". keygen-signing runs with NO server (§11.3 E3), so
// asking for a submission would send the agent chasing a host that does not
// exist and turn a signing measurement into a networking one. The signature is
// then verified OFFLINE by the harness against the contract's
// canonicalizeApplication.
const KEYGEN_ANCHOR = "generate your signing key";
export const KEYGEN_SIGNING_TASK_BASE = `${sliceThrough(KEYGEN_ANCHOR)}, and produce the signed application.`;

// The identity ask is its own sentence in the canonical prompt and mentions
// neither "submit" nor a server, so it survives verbatim into keygen-signing's
// task unmodified — the same slice-not-paraphrase discipline as every fragment
// above.
const IDENTITY_ASK = canonicalFragment(
  "Ask me for the display name and contact email to apply with; it must be signed with your key, so it only completes if your setup actually works.",
);
export const KEYGEN_SIGNING_TASK_TEMPLATE = `${KEYGEN_SIGNING_TASK_BASE} ${IDENTITY_ASK}`;

export interface ClaimIdentity {
  name: string;
  contact: string;
}

export function generateClaimIdentity(runId: string = crypto.randomUUID().slice(0, 8)): ClaimIdentity {
  return { name: `Onboarding Eval ${runId}`, contact: `onboarding-eval-${runId}@example.test` };
}

// ── Harness note: non-interactive container ─────────────────────────────────
// ENVIRONMENT INFO, never how-to — the same category as the admission eval's
// demoHarnessNote (scripts/lib/onboarding-eval.ts), kept clearly delimited and
// appended after the task rather than blended into it.
//
// Required for skill-install and toolchain: a container with no owner to
// answer would otherwise stall on the skill's own "ask the owner" step (its
// Step 0 says: if identity is missing or ambiguous, ask — never invent). This
// note restores exactly the two facts a headless run needs — nobody is there
// to reply, and (for keygen-signing) who the owner is — and nothing else. It
// names no install command, directory, URL, subcommand, or endpoint.
export function harnessNote(identity?: ClaimIdentity): string {
  const identityLine = identity
    ? ` The owner's identity for this run is: display name ${identity.name}, contact ${identity.contact}.`
    : "";
  return (
    "\n\n---\n" +
    "Harness note (environment, not part of your task): you are running " +
    "non-interactively inside a container. No owner is available to answer " +
    "questions, so do not wait for confirmation — carry out the task, and if " +
    "some part of it is genuinely impossible, say so plainly and stop." +
    `${identityLine}`
  );
}

export function buildSkillInstallTask(): string {
  return `${SKILL_INSTALL_TASK}${harnessNote()}`;
}
export function buildToolchainTask(): string {
  return `${TOOLCHAIN_TASK}${harnessNote()}`;
}
export function buildKeygenSigningTask(identity: ClaimIdentity): string {
  return `${KEYGEN_SIGNING_TASK_TEMPLATE}${harnessNote(identity)}`;
}
