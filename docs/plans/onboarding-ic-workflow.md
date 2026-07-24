# Plan: align tools, tests, and demos to the §11 onboarding workflow

Status: working plan (adhoc branch). Target: `docs/architecture.md` §11 (normative;
merged in #252, amended on this branch) — sequence `connect → discover →
toolchain + keygen → apply (signed) → review/approve → claim + participate`,
requirements R1–R8. Companion issue for the linked skill:
robotmoney/robotmoney-core#1170.

Two load-bearing decisions this plan implements:

- **Setup-gated apply (R6).** There is no separate prove-setup step. The
  application itself carries username, contact, public key, and an `rmpc`
  signature over the canonical application payload; the server verifies the
  signature before recording anything. Setup (MCP access, `rmpc`, keygen) must
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

Today `POST /api/committee/apply` takes a **client-supplied `memberId`** plus
`name`/`publicKey`/`contact` with no signature
(`backend/src/api/routes/committee.ts:148`, `backend/src/api/validation.ts:53`,
`backend/src/committee/domain.ts:385-408`).

- Define the **canonical application payload** (deterministic byte serialization
  of `{name, contact, publicKey, ...}`) in the `contract` package, alongside the
  existing canonical signing-payload format, so backend, MCP, docs, skill, and
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
  `backend/tests/committee.test.ts:27-52`,
  `backend/tests/committee-claim.test.ts:25-38` (`applyAndActivate` helper),
  roster-cap tests. Add: invalid-signature, key/signature mismatch, replayed
  payload, and UUID-minting assertions.

## Phase 2 — Status page + apply page rework

- Public status route `GET /api/committee/apply/:id` (add to
  `contract/src/routes.js`): redacted application state
  (`applied → approved → claimed`, timestamps, no contact echo). New frontend
  view `/committee/apply/:id` polling it — the page the runbook already promises
  (absent today; confirmed).
- `/committee/apply` (`frontend/public/views/committee/apply.html` +
  `apply-form.js`): remove in-browser keygen and the typed member-id. The page
  becomes (a) the canonical prompt to copy into an agent, and (b) a paste box
  accepting the agent-produced signed application payload for owners who prefer
  submitting by hand — same contract, no unsigned path.
- Tests: status-route redaction; docs/route tests extended
  (`scripts/tests/committee-docs-rmpc-and-routes.test.ts`).

## Phase 3 — MCP: anonymous discovery surface (`apply-how-to` + `apply`)

The MCP server has **no unauthenticated tool surface** — a bearer is required
before any session starts (`mcp/src/server.ts:312-333`). §11 R5/R6 need two
pre-credential tools:

- Anonymous sessions expose exactly `apply-how-to` and `apply`; the member
  toolset stays OAuth-gated as today. Implementation shape: build a second,
  anonymous `McpServer` when no bearer is presented instead of rejecting at
  `server.ts:312`.
- `apply-how-to`: canonical current steps (mirrors §11.2), the canonical-payload
  definition, the apply/status routes, and the raw-GitHub link to the
  `committee-onboarding` skill. Content sourced from the contract package so
  docs, tool, and tests cannot drift.
- `apply`: accepts the signed application payload and forwards it to the backend
  apply route — submitting over MCP is the preferred channel precisely because it
  proves MCP reachability at the same time (R6).
- Tests: anonymous session exposes exactly those two tools; every member tool
  still refuses anonymously; `apply` round-trips a validly-signed payload and
  rejects a bad signature; content snapshot pinned to §11.2 step names.

## Phase 4 — Demo as onboarding eval (OpenCode container, real inference)

Today `onboardMember()` (`mcp/src/e2e.ts:236-305`) is a scripted driver: JS
keygen (`mcp/src/crypto.ts`), client-supplied id, sleep, activate, claim — and
the TUI strip steps are `keypair → apply → review → activate → connect → …`
(`scripts/lib/demo-main.ts:317`). Replace the driver with an eval harness:

- **Member container**: a vanilla OpenCode agent image (no Robot Money tooling
  preinstalled) added to `docker-compose.demo.yml`, one instance per admission,
  with egress to the demo MCP container, the robotmoney-core release assets
  (`rmpc` download), and the model API. Real inference — reuse the model-key
  plumbing from the existing `committee-opencode-nightly.yml` path
  (`COMMITTEE_REAL_INFERENCE`).
- **Harness**: for each scheduled admission, `onboardingDriver()`
  (`scripts/lib/demo-main.ts:1295+`) generates an identity, starts the
  container, and injects the canonical copy-paste prompt verbatim (same text as
  the participation quickstart — sourced from the contract constant, not
  duplicated). No further interaction: the agent must discover, install `rmpc`,
  keygen, and submit the signed application on its own.
- **Observation**: the strip's step states come from the outside — the public
  status API (Phase 2), MCP server logs, and the roster — not from instrumenting
  the agent. Step names change to track §11.2
  (`connect → discover → toolchain → apply → approve → claim → session → memo →
  admitted`); §10.1 of architecture.md updates to match.
- **Auto-approve**: demo-side watcher approves each application 10 s after it
  completes, via `POST /api/committee/admin/activate` (unchanged, R7).
- **Failure semantics**: an admission that doesn't reach `admitted` within its
  window renders red in the strip and logs the container transcript — the eval
  failed; nothing retries the member's steps for it.
- `mcp/src/e2e.ts` `onboardMember()` and JS-keygen onboarding remain only where
  a non-eval fixture is genuinely needed (unit tests of crypto primitives);
  every demo/e2e onboarding path goes through the eval harness.

## Phase 5 — Test/CI adaptation

Per the test-coverage invariants (loud-skip only, executed-in-CI assertions):

- `integration.yml`: Phases 1–3 test rewrites/additions run here (backend +
  MCP + scripts tests).
- `e2e.yml` (PR gate) currently runs the demo hermetically with inference off.
  **Decided: the PR gate runs the real-inference onboarding eval**, not just
  eval infrastructure — most of what this workflow tests is whether a vanilla
  agent can navigate our installation from our instructions alone, which is
  meaningless without a real model doing the reasoning. Keep the
  infrastructure-only check (containers start, anonymous MCP discovery answers,
  a signed apply built with the real `rmpc` binary lands) as a fast fail-fast
  step that runs *before* the real-inference eval in the same job, not as a
  substitute for it. The known flake risk (self-hosted runner shares its IP
  with the standing `rmdemo_*` stack — live quota flake) is handled with
  retry/backoff around the model call, not by dropping inference from the gate.
  Fork PRs don't get the model-key secret (GitHub Actions default) — they run
  the infra-only check and say so loudly; same-repo PRs get the full eval.
  `committee-opencode-nightly.yml` keeps its own real-inference assertions and
  runs a broader/deeper sweep than the PR gate, not the *only* place inference
  happens.
- `rmpc-release-e2e-nightly.yml` / `scripts/rmpc-release-e2e.ts`: currently
  drives the pre-#205 `apply → activate` chain with client-supplied id; converge
  it onto the eval harness (or retire it into the nightly eval) so there is one
  onboarding driver, not two.
- Docs tests: pin the quickstart prompt text to the contract constant; assert
  the prompt names `apply-how-to` and the signed-application step.

## Phase 6 — Deployment/provisioning

- Demo: `mcp` container exists in `docker-compose.demo.yml`; Phase 3's anonymous
  surface must be reachable from the member containers (compose network).
- Staging: provision `mcp.<staging-domain>` per the production topology (D18 /
  §3.1: orange-cloud proxied, alternate port 8443, `MCP_PORT=8443`, Cloud
  Firewall allowing 8443 from Cloudflare ranges). Until then the copy-paste
  prompt cannot be exercised against staging.
- Model-key secret management for the demo/nightly eval containers (never baked
  into images; env-injected like `COMMITTEE_REAL_INFERENCE` today).

## Cross-repo dependencies (robotmoney-core)

- #1170/#1171: the `committee-onboarding` skill must teach the **signed apply**
  (canonical payload, `rmpc committee-identity sign`, submit via the MCP `apply`
  tool or API) and must not reference a separate prove-setup step or a
  pre-issued applicant id.
- `rmpc`: confirm the pinned release (v0.3.2 per `scripts/rmpc-release-e2e.ts:31`)
  can sign the canonical application payload byte-exactly; if a new subcommand or
  release is needed, it gates Phases 1 and 4.

## Suggested issue slicing

Phase 1+2 as one issue (contract + surfaces share the migration and tests);
Phase 3, Phase 4, Phase 5, Phase 6 one issue each. 1+2 block everything; 3
blocks 4; 6 is parallel. When promoted into the Plan via `superfield-strategy`,
this document retires in favor of the GitHub Plan tracking issue.
