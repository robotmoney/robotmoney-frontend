# Plan: align tools, tests, and demos to the §11 onboarding workflow

Status: working plan (adhoc branch). Target: `docs/architecture.md` §11 (normative;
merged in #252, amended on this branch) — sequence `connect → discover →
toolchain + keygen → apply (signed) → review/approve → claim + participate`,
requirements R1–R8. Companion issue for the linked skill:
robotmoney/robotmoney-core#1170.

> **D21 update.** `docs/decisions.md` D21 retired the MCP server: there is no
> RM-hosted MCP surface. "Discover" is now "install the `swarm-onboarding`
> skill" (the skill is the discovery mechanism, not a live tool call), and
> every remaining step — apply, claim, submit, memo — rides on the REST API
> that already exists (`ROUTES.swarm.*`), not an MCP tool. This plan is
> updated in place to match; the phase that only existed to build an MCP
> discovery surface (formerly Phase 3) is dropped.

Two load-bearing decisions this plan implements:

- **Setup-gated apply (R6).** There is no separate prove-setup step. The
  application itself carries username, contact, public key, and an `rmpc`
  signature over the canonical application payload; the server verifies the
  signature before recording anything. Setup (skill install, `rmpc`, keygen) must
  therefore precede apply, and a completed application is itself the proof the
  owner's agent works. The server mints the member UUID at completion and exposes
  it (response + status page).
- **Demo onboarding is an eval, not a script (R8).** Every demo admission
  launches a vanilla OpenCode agent container, hands it the canonical copy-paste
  prompt with a generated identity, and the agent onboards itself with real
  inference. The demo observes progress via the public status API; a failed
  onboarding is a red eval result about our instructions, never something a
  driver script works around.

Current-state audit (2026-07-24, main @ `3ec7885`): the claim flow (#205) and
activation-email outbox are already §11-shaped. Everything below diverges.

## Phase 1 — Signed-apply contract

Today `POST /api/swarm/apply` takes a **client-supplied `memberId`** plus
`name`/`publicKey`/`contact` with no signature
(`backend/src/api/routes/swarm.ts:148`, `backend/src/api/validation.ts:53`,
`backend/src/swarm/domain.ts:385-408`).

- Define the **canonical application payload** (deterministic byte serialization
  of `{name, contact, publicKey, ...}`) in the `contract` package, alongside the
  existing canonical signing-payload format, so backend, docs, skill, and
  `rmpc` all reference one definition.
- Rework the route + `applyMember`: accept
  `{name, contact, lens?, publicKey, signature}`; verify the ed25519 signature
  over the canonical payload against the submitted key (same primitives as
  `claimMemberToken`, `domain.ts:503`); generate `memberId = randomUUID()`
  server-side; store member `applied` + inactive key + pending application in one
  txn (as today); return the UUID in the 201 body. Unsigned/invalid → 400, and
  nothing is recorded.
- Application state machine simplifies: `pending → approved` (no `setup_proven`
  intermediate — proof is at the door). `activateMember` and the admin
  applications queue need no gating change; every queued application is
  toolchain-proven by construction.
- Rewrite the tests that assert the old shape:
  `backend/tests/swarm.test.ts:27-52`,
  `backend/tests/swarm-claim.test.ts:25-38` (`applyAndActivate` helper),
  roster-cap tests. Add: invalid-signature, key/signature mismatch, replayed
  payload, and UUID-minting assertions.

## Phase 2 — Status page + apply page rework

- Public status route `GET /api/swarm/apply/:id` (add to
  `contract/src/routes.js`): redacted application state
  (`applied → approved → claimed`, timestamps, no contact echo). New frontend
  view `/swarm/apply/:id` polling it — the page the runbook already promises
  (absent today; confirmed).
- `/swarm/apply` (`frontend/public/views/swarm/apply.html` +
  `apply-form.js`): remove in-browser keygen and the typed member-id. The page
  becomes (a) the canonical prompt to copy into an agent, and (b) a paste box
  accepting the agent-produced signed application payload for owners who prefer
  submitting by hand — same contract, no unsigned path.
- Tests: status-route redaction; docs/route tests extended
  (`scripts/tests/unit/swarm-docs-rmpc-and-routes.test.ts`).

## Phase 3 — retired (D21)

This phase was "MCP: anonymous discovery surface (`apply-how-to` + `apply`)" —
building a pre-credential, unauthenticated tool surface on the MCP server so an
agent could discover the application steps before it had any membership
credential. `docs/decisions.md` D21 retired the MCP server entirely, and with
it the premise of this phase: there is no MCP tool surface to add anonymous
tools to.

The capability this phase existed to provide — canonical, current application
steps reachable before any credential exists — is now provided by the
**`swarm-onboarding` skill** itself (§11 R5): it is installed fresh from
`robotmoney-core` as the first onboarding step, so it is already
"pre-credential discovery" by construction, no server call needed. `apply`
needs no new surface either — `ROUTES.swarm.apply` already exists and
already accepts the signed payload (Phase 1). Nothing here carries forward to
another phase; it is dropped, not merged.

## Phase 4 — Demo as onboarding eval (OpenCode container, real inference)

Today `onboardMember()` (`mcp/src/e2e.ts:236-305`) is a scripted driver: JS
keygen (`mcp/src/crypto.ts`), client-supplied id, sleep, activate, claim — and
the TUI strip steps are `keypair → apply → review → activate → connect → …`
(`scripts/lib/demo-main.ts:317`). Replace the driver with an eval harness. Per
D21, the harness talks to the backend API directly — there is no demo MCP
container to depend on:

- **Member container**: a vanilla OpenCode agent image (no Robot Money tooling
  preinstalled) added to `docker-compose.demo.yml`, one instance per admission,
  with egress to the demo **API** container, the `robotmoney-core` `rmpc`
  release asset, the repo-owned `swarm-onboarding` skill served by the API
  from `frontend/public/skills/swarm-onboarding/SKILL.md`, and the
  model API. Real inference on a **vanilla OpenCode install** running a funded,
  registry-selected model (D22 rule 1 as amended 2026-07-28): the model is chosen
  by the single `AGENT_MODEL` signal resolved against
  `scripts/lib/model-registry.ts`, and billed to `OPENCODE_API_KEY`. Model ids
  live in versioned source, never in the environment — the environment carries
  only the selector. `AGENT_MODEL=free` remains a genuinely keyless path.
- **Harness**: for each scheduled admission, `onboardingDriver()`
  (`scripts/lib/demo-main.ts:1295+`) generates an identity, starts the
  container, and injects the canonical copy-paste prompt with only the skill
  URL pointed at that local static file (all other text is sourced from the
  contract, not duplicated). No further interaction: the agent must install the
  `swarm-onboarding` skill, install `rmpc`, keygen, and submit the signed
  application over the REST API on its own.
- **Observation**: the strip's step states come from the outside — the public
  status API (Phase 2) and the roster — not from instrumenting the agent. Step
  names change to track §11.2
  (`connect → discover → toolchain → apply → approve → claim → session → memo →
  admitted`); §10.1 of architecture.md updates to match (`discover` now means
  "skill installed," not "MCP tool called").
- **Auto-approve**: demo-side watcher approves each application 10 s after it
  completes, via `POST /api/swarm/admin/activate` (unchanged, R7).
- **Failure semantics**: an admission that doesn't reach `admitted` within its
  window renders red in the strip and logs the container transcript — the eval
  failed; nothing retries the member's steps for it.
- `mcp/src/e2e.ts` `onboardMember()` and JS-keygen onboarding remain only where
  a non-eval fixture is genuinely needed (unit tests of crypto primitives) —
  and per D21, this file's logic is relocated out of the retired `mcp/`
  package as part of this phase, not left behind as dead weight; every demo/e2e
  onboarding path goes through the eval harness.

## Phase 5 — Test/CI adaptation

Per the test-coverage invariants (loud-skip only, executed-in-CI assertions):

- `integration.yml`: Phases 1–2 test rewrites/additions run here (backend +
  scripts tests). No MCP tests to add or maintain (D21).
- `e2e.yml` (PR gate) currently runs the demo hermetically with inference off.
  **Decided: the PR gate runs the real-inference onboarding eval**, not just
  eval infrastructure — most of what this workflow tests is whether a vanilla
  agent can navigate our installation from our instructions alone, which is
  meaningless without a real model doing the reasoning. Keep the
  infrastructure-only check (containers start, the skill/`rmpc` install
  succeeds, a signed apply built with the real `rmpc` binary lands over the
  REST API) as a fast fail-fast step that runs *before* the real-inference
  eval in the same job, not as a substitute for it. The known flake risk
  (self-hosted runner shares its IP with the standing `rm_demo_*` stack — live
  quota flake) is handled with retry/backoff around the model call, not by
  dropping inference from the gate. Because the eval is keyless (D22) there is
  no secret to withhold and therefore **no fork/same-repo distinction**: every
  PR, forked or not, runs the identical eval. ~~`swarm-opencode-nightly.yml`
  is repointed at the layered eval (§11.3) on a `core` stack — sampling and
  layer diagnostics live there; the PR gate keeps the single admission.~~
  **Superseded by D26 (issue #373):** that workflow is retired. Layer diagnostics
  live in `onboarding-evals-nightly.yml`, and the single admission runs in
  `e2e.yml` on a push to `main` and on that workflow's nightly `schedule` mirror
  of it.
- `rmpc-release-e2e-nightly.yml` / `scripts/rmpc-release-e2e.ts`: currently
  drives the pre-#205 `apply → activate` chain with client-supplied id over
  MCP's OAuth `client_credentials` flow — that flow no longer exists (D21);
  converge this workflow onto the eval harness's REST-only path (or retire it
  into the nightly eval) so there is one onboarding driver, not two, and no
  OAuth step left to maintain.
- Docs tests: pin the quickstart prompt text to the contract constant; assert
  the prompt names the `swarm-onboarding` skill and the signed-application
  step.

## Phase 6 — Deployment/provisioning

- Demo: no `mcp` container in `docker-compose.demo.yml` (D21) — the member
  containers need egress to the demo **API** container (which serves the
  repo-owned skill) and the `robotmoney-core` `rmpc` release asset, not a demo
  MCP surface or a remotely published development skill.
- Staging: nothing to provision for onboarding specifically — the copy-paste
  prompt is exercised against `swarm.<staging-domain>`'s existing REST API,
  the same surface everything else on staging already uses. (D18's `mcp.`
  subdomain provisioning is dropped, not needed.)
- Model-key secret management for the demo/nightly eval containers (never baked
  into images; env-injected like `SWARM_REAL_INFERENCE` today).

## Cross-repo dependencies (robotmoney-core)

- The onboarding skill is no longer a development dependency on
  `robotmoney-core`: its canonical eval copy lives in this repo. Publishing an
  approved copy externally is a separate vendoring/release process and is out
  of scope for this phase.
- `rmpc`: confirm the pinned release (v0.3.2 per `scripts/rmpc-release-e2e.ts:31`)
  can sign the canonical application payload byte-exactly; if a new subcommand or
  release is needed, it gates Phases 1 and 4.

## Suggested issue slicing

Phase 1+2 as one issue (contract + surfaces share the migration and tests);
Phase 3 is retired (D21) — nothing to slice. Phase 4, Phase 5, Phase 6 one
issue each. 1+2 block everything; 6 is parallel. A separate issue tracks D21's
own follow-up code retirement (the `mcp/` package, its CI workflows, and the
`mcp.<domain>` DNS/firewall records) — that work is independent of this plan's
phases, since none of them depend on the old MCP code still existing. When
promoted into the Plan via `superfield-strategy`, this document retires in
favor of the GitHub Plan tracking issue.
