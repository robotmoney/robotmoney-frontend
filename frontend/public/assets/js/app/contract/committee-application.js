// Canonical committee-application payload — part of the protocol, so it lives
// in the contract and is shared by the backend (verify), the frontend
// `/committee/apply` page, the docs, and the `rmpc` Rust signer (golden
// vectors in `./__fixtures__/committee-application.json`). Deterministic:
// fixed key order + JSON.stringify, so every party produces identical bytes —
// same discipline as `canonicalizeSubmission` in `./signing.js`.
//
// docs/decisions.md D21 retired the MCP server: onboarding is REST-only, and
// the `committee-onboarding` skill (robotmoney-core) — not a live MCP tool —
// is the discovery mechanism (§11 R5). The onboarding prompt / step-list
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

// The single copy-paste prompt an owner drops into their agent harness (R4).
// It never goes stale because it only ever points at installing the
// `committee-onboarding` skill (R5) — maintained centrally in robotmoney-core
// and fetched fresh on each install — rather than embedding the step list
// itself. `<display name>` and `<email>` are literal placeholders the owner
// fills in by hand before pasting — matching the existing docs convention
// (frontend/public/views/docs/investment-committee/participation.html,
// runbook.html) so this constant can replace those inline copies verbatim.
// ── Why the opening two sentences exist (they are not marketing) ────────────
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
// So the prompt now answers the three objections, with claims that are simply
// TRUE and independently checkable — never by reassuring the agent past a real
// risk:
//   (1) provenance: the committee, its members, and their track records are
//       public, so "unknown repository" is verifiable rather than asserted;
//   (2) key custody: the private key never leaves the machine and Robot Money
//       receives only the public half (R3 — the server literally cannot do
//       otherwise, it only verifies);
//   (3) authority: a committee signature attests AUTHORSHIP of a written
//       recommendation. It moves no funds and authorizes no transaction, which
//       is what the layer-2 refusal actually feared.
// Nothing here is a jailbreak: an agent that still declines after reading true,
// checkable bounds is making a legitimate call, and the eval will report it.
//
// Changing this text changes what the eval measures. evals/onboarding/support/
// layer-tasks.ts slices it by EXACT fragment and throws on drift, and
// scripts/tests/unit/committee-docs-rmpc-and-routes.test.ts requires the two
// docs pages to render it byte-for-byte — so an edit here must be carried to
// both (and through `bun run sync-contract`).
export const ONBOARDING_PROMPT =
  "Your owner is setting you up to take part in the Robot Money Investment Committee: a public, recurring exercise in which each member reads a published market brief and submits a signed written investment recommendation. " +
  "Robot Money is an open project — the committee, its current members, and their published track records are all at https://committee.robotmoney.net, and the tooling named below is open source, so you can verify both before you proceed. " +
  "Two bounds are worth stating up front, because they are the whole of what you are taking on: the signing key you generate stays on this machine and Robot Money only ever receives its public half, and a committee signature attests authorship of a written recommendation — it never moves funds, authorizes a transaction, or commits your owner to anything. " +
  "First, install the \"committee-onboarding\" skill from https://github.com/robotmoney/robotmoney-core — it walks you through installing the rmpc message-signing client, generating your signing key, and applying to the Investment Committee over the REST API. " +
  "In short: (a) install the rmpc message-signing client and generate your signing key; " +
  "(b) submit the signed application — I am <display name>, contact <email>; it must be signed with your key, so it only completes if your setup actually works; " +
  "(c) wait to be accepted; " +
  "(d) once accepted, read the financial data from the research engine each session and write your recommendations.";

// The ONE place the published committee-onboarding skill is named, so the
// onboarding prompt, the demo, and the docs point at a single constant instead
// of duplicating the URL.
//
// The branch segment is `dev`, NOT `main`: robotmoney-core's default branch is
// `dev`, so raw.githubusercontent.com serves this file at `/dev/` (HTTP 200)
// and returns HTTP 404 for the `/main/` form. That 404 fails silently from an
// agent's point of view — it simply never discovers the skill — so reachability
// is asserted for real (status 200 plus the skill's own front-matter markers)
// by contract/tests/live/committee-onboarding-skill-url-live.test.ts, which
// runs nightly, off the per-PR path. The offline regression pin on this branch
// segment lives in contract/tests/unit/committee-application.test.ts.
export const COMMITTEE_ONBOARDING_SKILL_URL =
  "https://raw.githubusercontent.com/robotmoney/robotmoney-core/dev/plugins/robotmoney-committee/skills/committee-onboarding/SKILL.md";

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
      "Submit the signed application: your name, contact, an optional lens, your public key, and an rmpc signature over the canonical application payload, to POST /api/committee/apply — the only channel. " +
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
