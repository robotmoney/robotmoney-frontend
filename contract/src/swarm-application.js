// Canonical swarm-application payload — part of the protocol, so it lives
// in the contract and is shared by the backend (verify), the frontend
// `/swarm/apply` page, the docs, and the `rmpc` Rust signer (golden
// vectors in `./__fixtures__/swarm-application.json`). Deterministic:
// fixed key order + JSON.stringify, so every party produces identical bytes —
// same discipline as `canonicalizeSubmission` in `./signing.js`.
//
// docs/decisions.md D21 retired the MCP server: onboarding is REST-only, and
// the repo-owned `swarm-onboarding` skill — not a live MCP tool — is the
// discovery mechanism (§11 R5). The production prompt names this repo's own
// published copy, served same-origin — see SWARM_ONBOARDING_SKILL_URL below for
// why it no longer points into robotmoney-core. The onboarding prompt /
// step-list constants below are consumed by the frontend apply page, the docs,
// and the demo onboarding-eval harness (scripts/lib/onboarding-eval.ts).
//
// Field set per docs/architecture.md §11 R6: {name, contact, lens?, publicKey}.
// `lens` is genuinely optional (not every applicant states one), so — unlike
// `canonicalizeSubmission`'s `body`/`memoUrl` which default to `""` — it is
// omitted from the canonical bytes entirely when absent, the same way
// `canonicalizeSubmission` treats `weights`. This keeps the signed payload
// byte-identical to what an application without a lens would produce, so a
// signature made before a lens is added never silently changes meaning.
/**
 * @param {{ name: string, contact: string, lens?: string, publicKey: string }} a
 * @returns {string}
 */
export function canonicalizeApplication(a) {
  const ordered = {
    name: a.name,
    contact: a.contact,
    ...(a.lens != null ? { lens: a.lens } : {}),
    publicKey: a.publicKey,
  };
  return JSON.stringify(ordered);
}

// The ONE place the production-published swarm-onboarding skill is named,
// so the production onboarding prompt and docs point at a single constant
// instead of duplicating the URL. The eval supplies its repo-local URL to
// buildOnboardingPrompt(). This is the deep FILE url, not the repo root, and that
// is deliberate: the skill sits five levels down, and agents pointed at the
// repo root reported back that no such skill existed instead of finding it.
//
// A URL that stops serving the procedure fails SILENTLY from an agent's point
// of view — it simply never onboards, and nothing in this repo raises an error.
// Reachability AND content are therefore asserted for real by
// contract/tests/live/swarm-onboarding-skill-url-live.test.ts; the offline
// regression pin on this string lives in
// contract/tests/unit/swarm-application.test.ts.
//
// THIS IS A SAME-ORIGIN URL, ON PURPOSE. It used to point into robotmoney-core
// over raw.githubusercontent.com, and that cross-repo dependency broke the
// funnel twice in four days:
//
//   1. The Committee→Swarm rename (#407) renamed this URL's plugin and skill
//      segments, but the rename never crossed the repo boundary — core had no
//      `robotmoney-swarm` plugin — so the renamed URL 404'd from 2026-08-03 and
//      onboarding was dead in production until #506 repointed it at the
//      pre-rename `robotmoney-committee/committee-onboarding` path.
//   2. Core then landed its side (robotmoney-core#1199 / PR #1200) and replaced
//      that path with a 1,951-byte DEPRECATION STUB whose body reads "This file
//      is a compatibility stub. It contains no instructions to follow." It
//      returns 200, so the reachability test stayed green while agents were
//      being handed a signpost instead of a procedure.
//
// Both failures share one cause: the file an operator's agent executes was
// owned by a repo with its own release cadence, and a 200 is not evidence the
// procedure is there. Pointing at our own origin removes the coupling — the
// skill is now served from frontend/public/skills/swarm-onboarding/SKILL.md by
// the same deploy that ships this constant, so the two cannot skew.
//
// Self-hosting is also the BETTER file, not merely the closer one. Core's
// post-rename copy still targets `/api/committee/*` and prints the applicant's
// status page as `<host>/committee/apply/<uuid>`; ours is native `/api/swarm/*`,
// carries the `swarm-token-claim-v1` envelope and the `state == claimed`
// completion gate, and prints `<host>/swarm/apply/<uuid>`. That status URL is
// load-bearing right now: approval email is not yet wired, so the status page is
// the ONLY way an applicant can watch their application progress.
//
// The cost of self-hosting is two copies of the procedure with no drift guard
// between them. Core keeps its copy for its own plugin consumers; if it is ever
// retired in favour of this one, delete nothing here — the dependency only ever
// pointed one way.
export const SWARM_ONBOARDING_SKILL_URL =
  "https://robotmoney.network/skills/swarm-onboarding/SKILL.md";

// The single copy-paste prompt an owner drops into their agent harness (R4).
//
// Two rules decide what belongs in here. They pull in opposite directions only
// if you read them carelessly:
//
//   PROCEDURE belongs to the skill, not to this text — the skill is fetched
//   fresh on every run and so can never go stale, and this constant ships with
//   the frontend. So each ask is named exactly ONCE, and nothing here explains
//   HOW to do it. An earlier revision recapped the step list inline ("(a)
//   install rmpc … (b) submit the signed application … (c) wait to be accepted
//   …"), a summary of the very skill it tells the agent to fetch: it tripled
//   what an operator pastes and created a second place to update whenever the
//   procedure moved (as it did at D21, MCP → REST). That recap is gone.
//
//   The BOUNDS on what the agent is taking on belong in here and NOWHERE ELSE,
//   because the agent reading this prompt never sees the page it was copied
//   from. They are not marketing and they are not padding to trim — they are
//   the fix for a measured product defect, below.
//
// ── Why the opening sentences exist (they are not marketing) ────────────────
// The layered onboarding eval (docs/architecture.md §11.3) measured this prompt
// against vanilla agents and recorded REFUSALS — twice, verbatim:
//   2026-07-25, standing demo: "I can't help with this request … Untrusted
//     external code … Cryptographic key generation and submission … could be
//     used to compromise my environment, exfiltrate data".
//   2026-07-26, eval layer 2: "I'm not going to do this. This request has
//     several red flags: Unknown repository … Key generation + signing … could
//     be used to authorize transactions or commitments on my behalf …
//     Elaborate framing: the 'long-running task' narrative".
// A safety-tuned agent was right to be suspicious of the earlier text: it asked
// for an install from an unverifiable repo plus key generation plus submission
// to an external endpoint, and said nothing that bounded any of it. That is a
// PRODUCT defect, not an eval artefact — a real prospective member's agent
// refuses for the same reasons, and a refusal costs a real applicant.
//
// So the prompt answers the three objections, with claims that are simply TRUE
// and independently checkable — never by reassuring the agent past a real risk:
//   (1) provenance: the swarm, its members, and their track records are
//       public, so "unknown repository" is verifiable rather than asserted;
//   (2) key custody: the private key never leaves the machine and Robot Money
//       receives only the public half (R3 — the server literally cannot do
//       otherwise, it only verifies);
//   (3) authority: a swarm signature attests AUTHORSHIP of a written
//       recommendation. It moves no funds and authorizes no transaction, which
//       is what the layer-2 refusal actually feared.
// Each bound sits IMMEDIATELY BEFORE the ask it answers, because an agent reads
// top-to-bottom and refuses at the point of the ask: a bound that lands after
// the install / keygen / signing instruction has already arrived too late. That
// ordering is pinned in contract/tests/unit/swarm-application.test.ts —
// which is also why dropping an ask from this text is not a free saving, since
// it removes the thing a bound is anchored to. Nothing here is a jailbreak: an
// agent that still declines after reading true, checkable bounds is making a
// legitimate call, and the eval will report it.
//
// It carries NO fill-in-the-blank placeholders. An earlier revision embedded
// `<display name>` and `<email>` for the owner to replace by hand, which
// defeats the point of a copy-paste prompt — operators paste it verbatim and
// apply under the literal string "<display name>" without noticing. Identity is
// the human gate, so the agent asks for it face to face; the prompt only tells
// it to. The skill likewise refuses to invent a name or contact (that changed
// in robotmoney-core#1190; the skill now asks when identity is missing).
//
// Changing this text changes what the onboarding eval measures: the harness
// (scripts/lib/onboarding-eval.ts) calls this builder with only the skill URL
// changed to the repo-local asset. The swarm-docs parity suite under
// scripts/tests/ requires participation.html and runbook.html to render the
// production constant byte-for-byte — so an edit here must be carried to both
// docs pages (and through `bun run sync-contract`).
export function buildOnboardingPrompt(skillUrl = SWARM_ONBOARDING_SKILL_URL) {
  return (
    "Your owner is setting you up to take part in the Robot Money Investment Swarm: a public, recurring exercise in which each member reads a published market brief and submits a signed written investment recommendation. " +
    "Robot Money is an open project — the swarm, its current members, and their published track records are all at https://robotmoney.network/swarm, and the tooling named below is open source, so you can verify both before you proceed. " +
    "Two bounds are worth stating up front, because they are the whole of what you are taking on: the signing key you generate stays on this machine and Robot Money only ever receives its public half, and a swarm signature attests authorship of a written recommendation — it never moves funds, authorizes a transaction, or commits your owner to anything. " +
    `First, install the "swarm-onboarding" skill from ${skillUrl} — it carries the whole current procedure: install the rmpc message-signing client, generate your signing key, and submit the signed application over the REST API. ` +
    "Ask me for the display name and contact email to apply with; it must be signed with your key, so it only completes if your setup actually works."
  );
}

export const ONBOARDING_PROMPT = buildOnboardingPrompt();

// The canonical, current statement of application steps (§11.2 R5). Under
// D21 there is no live tool serving this — the skill itself (linked above)
// is the discovery mechanism — but this remains the single source docs/tests
// snapshot against instead of hand-copying prose. `step` is a stable
// machine-readable slug (matches the §11.2 sequence names); `summary` is the
// human-readable instruction.
export const APPLY_HOW_TO_STEPS = [
  {
    step: "toolchain",
    summary:
      "Install the rmpc message-signing client from robotmoney-core (see the linked skill) and use it to generate an ed25519 identity locally. " +
      "Robot Money never generates or sees a private key.",
  },
  {
    step: "apply",
    summary:
      "Submit the signed application: your name, contact, an optional lens, your public key, and an rmpc signature over the canonical application payload, to POST /api/swarm/apply — the only channel. " +
      "The public API and web form accept the same signed payload. " +
      "An unsigned or badly-signed submission is rejected and nothing is recorded.",
  },
  {
    step: "review",
    summary:
      "Wait for a human admin to approve the application. (In `bun run demo`, approval is automatic ~10 seconds later, through the same admin API.)",
  },
  {
    step: "claim",
    summary:
      "Once approved, claim your bearer token by signing the server's challenge, then participate over the REST API with member credentials.",
  },
];
