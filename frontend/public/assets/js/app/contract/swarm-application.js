// Canonical swarm-application payload — part of the protocol, so it lives
// in the contract and is shared by the backend (verify), the frontend
// `/swarm/apply` page, the docs, and the `rmpc` Rust signer (golden
// vectors in `./__fixtures__/swarm-application.json`). Deterministic:
// fixed key order + JSON.stringify, so every party produces identical bytes —
// same discipline as `canonicalizeSubmission` in `./signing.js`.
//
// docs/decisions.md D21 retired the MCP server: onboarding is REST-only, and
// the repo-owned `swarm-onboarding` skill — not a live MCP tool — is the
// discovery mechanism (§11 R5). The production prompt still names its
// published robotmoney-core copy. The onboarding prompt / step-list
// constants below are consumed by the frontend apply page, the docs, and the
// demo onboarding-eval harness (scripts/lib/onboarding-eval.ts).
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
// The branch segment is `dev`, NOT `main`: robotmoney-core has NO `main` branch
// at all — `dev` is its default and only long-lived branch — so
// raw.githubusercontent.com serves this file at `/dev/` (HTTP 200) and returns
// HTTP 404 for the `/main/` form (verified 2026-07-27). That 404 fails silently
// from an agent's point of view — it simply never discovers the skill — so
// reachability is asserted for real (status 200 plus the skill's own
// front-matter markers) by
// contract/tests/live/swarm-onboarding-skill-url-live.test.ts. The offline
// regression pin on this string lives in
// contract/tests/unit/swarm-application.test.ts.
//
// THE PLUGIN/SKILL SEGMENTS ARE THE PRE-RENAME ONES, ON PURPOSE (issue #484).
// The Committee→Swarm rename (#407) renamed this URL's `robotmoney-committee/
// …/committee-onboarding` segments to `robotmoney-swarm/…/swarm-onboarding`,
// but that rename never crossed the repo boundary: robotmoney-core@dev ships
// plugins `robotmoney-analyst`, `robotmoney-cli`, `robotmoney-committee` and
// `robotmoney-user` — there is no `robotmoney-swarm` — so the renamed URL 404'd
// from 2026-08-03 and the entire onboarding funnel was dead in production, with
// no error raised anywhere in this repo. Measured 2026-08-05: the renamed form
// 404s, the form below returns 200. This constant therefore names WHAT IS
// PUBLISHED, not what this repo would prefer to be published.
//
// Consequence worth stating plainly rather than hiding: the file served here
// declares `name: committee-onboarding` in its front matter while
// ONBOARDING_PROMPT (below) and this repo's own evaluation copy at
// frontend/public/skills/swarm-onboarding/SKILL.md use the post-rename name.
// That label mismatch is the residue of the half-finished cross-repo rename,
// and it is strictly better than a 404: the agent gets the real, current
// procedure. Renaming the plugin in robotmoney-core so the post-rename URL
// becomes true is the permanent repair, and it is tracked THERE, not here —
// this repo does not edit robotmoney-core: robotmoney-core#1199 (the 404 URL
// itself) and robotmoney-core#1201 (the still-open `committee-identity` →
// `swarm-identity` decision that determines how far the rename goes). When it
// lands, change this string and the live test follows automatically — it
// derives the expected front-matter name from this URL's own skill segment,
// so no edit there is needed.
export const SWARM_ONBOARDING_SKILL_URL =
  "https://raw.githubusercontent.com/robotmoney/robotmoney-core/dev/plugins/robotmoney-swarm/skills/swarm-onboarding/SKILL.md";

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
    "Robot Money is an open project — the swarm, its current members, and their published track records are all at https://robotmoney.net/swarm, and the tooling named below is open source, so you can verify both before you proceed. " +
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
