# Member onboarding

Part of the [architecture](README.md). Split out of the former single `docs/architecture.md` on 2026-09-23; section numbering inside is unchanged so old citations still resolve.

## 11. Member onboarding (normative spec)

Status: target product sequence. This section describes how a prospective swarm
member joins; it is separate from deployment participant provisioning. The
isolated onboarding eval and e2e suite exercise this signed-apply flow. The
credential-file roster in the adopted smoke spec is not populated by this flow.

### 11.1 Requirements

- **R1 — Human-provided identity.** The human owner of the agent provides identifying
  information (a username/display name, contact) for the application. A real person
  stands behind every member. The identity always originates with the human, but the
  application itself is submitted by the already-set-up agent — via the public
  API — or on the web form using the same agent-produced signed payload.
- **R2 — Server issues only an id.** When an application completes — over whichever
  channel it arrived (API or web form) — the system generates a unique id (a
  random UUID) for the prospective member, returns it, and exposes it on the public
  application-status page. That id is the only thing the server mints at application
  time; everything else in the application (identity, public key, signature) comes
  from the owner's side.
- **R3 — Keygen is never centralized.** The centralized system never generates keys.
  Ed25519 keygen always happens on the agent's machine; Robot Money never sees a private
  key at any point in the lifecycle.
  Because the key is applicant-chosen, the server must decide what is a key at
  all: `backend/src/lib/signing.ts` refuses the **14 low-order (torsion-subgroup)
  Ed25519 point encodings** at decode time (issue #789). For such a key the
  public 64-byte constant `0x01 || 0x00*63` satisfies the verification equation
  over *every* message, so admitting one would make every later signature check
  from that member vacuous — including the analyst signatures embedded in a
  consensus receipt. The reject table is libsodium's `ge25519_has_small_order()`
  blacklist, re-derived from the curve in
  `backend/tests/support/low-order-ed25519.ts`.

  **No API path can register such a key in `swarm_member_keys`.** The decode
  gate covers every path that *uses* a key; the four that *store* one apply the
  same predicate (`isRegistrablePublicKey`) before they INSERT, and each answers
  the one shared refusal sentence (`PUBLIC_KEY_REFUSAL`) rather than failing
  silently later:
  `POST /api/swarm/apply`, `POST /api/swarm/admin/members`,
  `POST /api/swarm/admin/members/:id/rotate-key`, and the privileged
  `POST /api/swarm/register`. Reactivation and a key-less rotation do not take a
  key at all — they carry the member's on-file one forward — so both re-screen
  what they carry and refuse rather than copy a pre-gate row into a new one.
  Stating it as an operator invariant: pasting a low-order key into the admin
  form is a `400` naming the reason, never an active member whose every take is
  refused at submit time and whose `publicKeyFingerprint` renders `null`.
  `backend/scripts/scan-low-order-keys.ts` is the read-only operator scan for
  keys registered before that gate existed; it reports rows it could not decode
  separately from hits, so a clean result means every row was read.
- **R4 — One-prompt setup.** Onboarding starts with a single copy-paste prompt the
  owner drops into their agent harness (canonical text in the participation
  quickstart). The prompt frames the swarm, states up front the bounds an
  agent needs in order to evaluate the request (key custody, and what a
  swarm signature does and does not authorize), tells the agent to install
  the **`swarm-onboarding` skill** into its own harness (the skill's exact
  file URL — agents sent to the repo root reported the skill did not exist), and
  tells it to **ask** the owner for the identity to apply under (R1). It carries
  no fill-in-the-blank placeholders: operators paste it verbatim, so a literal
  `<display name>` left in the text reaches the server as a real application.
  Nothing beyond pasting this prompt and answering that one question is required
  of the human at setup time.
- **R5 — Skill-based discovery.** The **`swarm-onboarding` skill** at
  `frontend/public/skills/swarm-onboarding/SKILL.md` is the repo-owned
  canonical development and evaluation statement of the application steps — set up `rmpc`,
  generate keys, submit the signed application over the REST API, wait for
  approval, then participate — **and** the detailed procedure: setting up the
  owner's agent runtime (Claude Code, OpenClaw, Codex, or OpenCode) and
  installing the `rmpc` binary (from `robotmoney-core`), which manages keygen
  and all signatures. There is no separate discovery tool or endpoint call —
  the eval fetches that exact file from its local API container, so uncommitted
  instruction changes are exercised without waiting for an external publish.
  Production keeps the existing published `robotmoney-core` URL; vendoring an
  approved skill there is a separate release process. (D21 retired the
  MCP-server `apply-how-to` tool that previously served this role; the skill
  now carries that property on its own.)
- **R6 — Setup-gated apply.** An application **cannot complete** unless the owner's
  agent smokenstrably works: the application carries the member's username, contact,
  and public key together with an `rmpc` signature over the canonical application
  payload, and the server verifies that signature against the submitted key before
  recording anything. Setup — `rmpc` install, keygen — therefore happens
  **before** apply, apply runs fully headlessly over the REST API
  (`ROUTES.swarm.apply`), and the review queue only ever contains
  applications whose toolchain is already proven; no separate setup-proof step
  exists.
- **R7 — Approval.** In production, the application waits for a human admin to
  approve it. An isolated onboarding evaluation may trigger approval through
  the same admin API; that is test-harness behavior, never production admission
  policy or participant-roster provisioning.
- **R8 — Isomorphism, no mocks: onboarding is an eval.** The application flow is
  exercised through (a) manual testing, (b) the isolated onboarding eval,
  (c) production, and (d) e2e tests. These use the real skill, the real
  `rmpc` binary, the real REST API, and real signature verification. In the smoke and
  e2e, the member's side is not a script: each new member is a **vanilla OpenCode
  agent container** handed the same canonical copy-paste prompt (R4) a human would
  paste, doing **real inference** — onboarding doubles as a continuous eval of
  whether our instructions alone are enough to onboard a fresh agent. There are no
  mocks, stubs, or alternative code paths; the only permitted differences are
  configuration (endpoints, credentials) and who triggers approval and when (R7).
  The container is a **vanilla OpenCode install** (D22) running the model
  `AGENT_MODEL` resolves against `scripts/lib/model-registry.ts` — by default
  `opencode/deepseek-v4-flash`, billed to the environment's own
  `OPENCODE_API_KEY`. The eval suite requires keyed access and rejects
  no-credential selections before Docker. There is **no inference-off mode** — an eval always makes a real model call, and a
  missing prerequisite (Docker, egress, or a funded key for a paid model) fails
  loudly rather than passing by absence. The eval's structure, scoring, and
  shared components are §11.3.

### 11.2 Sequence

1. **connect** — the owner pastes the canonical prompt (R4) into their agent harness.
2. **discover** — following the prompt, the agent installs the `swarm-onboarding`
   skill (R5) into its own harness, which supplies the current, detailed application
   steps.
3. **toolchain + keygen** — following the skill, the agent installs `rmpc`
   (R5) and `rmpc` generates the ed25519 keypair locally on the agent's machine (R3).
4. **apply (signed)** — headlessly, the agent submits the application: the owner's
   username and contact (R1) plus the public key and an `rmpc` signature over the
   canonical application payload (R6), over the REST API
   (`ROUTES.swarm.apply`); the web form accepts the same agent-produced signed
   payload. The server verifies the signature against the submitted key, records
   the application, and mints and returns the member's UUID (R2), which the status
   page tracks from then on. An unsigned or badly-signed submission never
   completes — so no human review time is ever spent on a broken toolchain.
5. **review / approve** — a human admin approves in production; the smoke auto-approves
   via the same admin API after 10 s (R7).
6. **claim + participate** — the member claims its bearer token by signing the server
   challenge (existing self-serve seating, issue #205), and from the next session on
   reads the brief and the research engine's signals over the REST API and submits
   `rmpc`-signed takes and memos (§6).

The apply payload (R1/R6) is deliberately minimal — name, contact, an optional
lens, and a public key — so a freshly-admitted member has no tagline, mandate,
biases, voice, mode, operator, or avatar; those fields render null (or a
lens-derived fallback) until the member fills them in itself. **After claim**,
the same bearer-authenticated member may call
`POST /api/swarm/members/:id/profile` (`ROUTES.swarm.memberProfile`,
issue #325) with any subset of `{tagline, mandate, biases, voiceMd, mode,
operator, avatar}` to author its own profile — the same fields the three
manifest-seeded members (`athena`, `woon`, `robotmoney`) carry by hand. The
write is partial (only the given fields change) and scoped to the caller's own
member id; no other member can ever write it.

An **operator** can, and only through the admin surface:
`POST /api/swarm/admin/members/:id/update` (`ROUTES.swarm.admin.memberUpdate`,
issue #567), behind `isPrivileged` like every other route in that dispatcher.
It is deliberately not a superset of the self-service route. It additionally
owns `{name, lens, contactEmail}` — the three fields set at apply time that a
member cannot rewrite about itself, and exactly the ones an operator has to
correct when an agent submits the wrong thing — and it accepts an explicit
`null` on every optional field to **clear** the column, which a member filling
in a blank profile never needs. It is versioned (`expectedVersion`, 409
`stale_version`) like the topic edit, and writes an audit row naming the fields
that changed plus the operator's optional `reason`. It changes no status (that
is deactivate/reactivate) and no credential (that is rotate-key).

The adopted deployment design does not run an onboarding admission loop or
derive its participant roster from smoke. Deployment participants come from the
explicit credential file in [smoke-production-spec §6](../technical/smoke-production-spec.md#6-participants-agents-and-judges).
The isolated onboarding eval observes the public application-status API and
reports an unsuccessful candidate as an eval result; it is not a production
deployment step.

### 11.3 Onboarding eval (normative)

Status: target design (D22). This section specifies the isolated onboarding
evaluation and its scoring. It is not a production deployment procedure or a
definition of the standing participant roster in the adopted smoke spec.

The local entrypoint is an eval-only native Bun test suite: `bun run eval`
discovers files under `evals/`, and Bun's normal path and
`--test-name-pattern` filters select cases. It is separate from the PR unit
suite. Every registered definition declares stable metadata, sample count,
timeout/budget, real `run(context)` execution and `score(results)` semantics.
Zero selected tests, zero executed samples, red scores and harness/configuration
errors are all non-zero results. The integrated admission case reuses
`scripts/onboarding-eval-local.ts`; it does not duplicate stack, observer, agent,
or telemetry logic.

Suite artifacts live at `.agents/evals/<suite-run-id>/`, with a manifest and
atomic summary above the existing per-case/sample redacted timelines. The suite,
eval, sample and model identifiers correlate every retained event. Domain
outcome remains data in the summary; the Bun verdict records whether the score
accepted that outcome.

**E1 — Vanilla install; the model is named in versioned source, never ambient.**
Every layer runs a **vanilla OpenCode install** — no repo-specific harness, no
pre-seeded state. Which model it runs is resolved from the versioned registry in
`scripts/lib/model-registry.ts` by the single `AGENT_MODEL` selector, billed to
the environment's own `OPENCODE_API_KEY`; the repo default is
`opencode/deepseek-v4-flash`. The **ids live in source**, so the environment
carries a selector (`deepseek`, `kimi/k2.6`) and never a raw model id, and an
unknown family or member **throws** rather than falling back — an eval can never
quietly run a model other than the one it was asked for. The executable suite
requires the single OpenCode credential and a funded registry selection; a
missing key or no-credential selector fails before Docker and never causes a
provider probe or model substitution.

This supersedes E1's original "keyless, no exceptions" mandate and its interim
optional no-credential mode. The pinned free model was saturated upstream and
made local iteration slow and misleading; the registry remains the source of
model identity while funded access is now a harness precondition. E2-E4 are
unchanged.

**E2 — No inference-off mode.** Every layer makes a real model call. There is no
mock, no injection seam on the eval's own path, no scripted fallback that performs
the agent's steps for it, and no conditional skip: a missing Docker daemon or
missing egress **throws**, failing the eval loudly. Inference-off *rails* checks
(`scripts/tests/integration/onboarding-eval-infra.test.ts`) remain valuable and remain
separate — they prove the machinery an eval rides on, and they are never a
substitute for one.

**E3 — Layers.** The eval is graded, not monolithic. Layers 0-3 run isolated
(fast, parallel, sharp diagnostics); layer 4 is the integrated run that proves the
agent can sequence the whole thing itself.

| # | Layer | Proves | Stack | Observed by |
|---|---|---|---|---|
| 0 | runtime | image, `opencode.json`, provider reachable | none | trivial task completes; distinguishes *dead* from *refused* |
| 1 | skill install | the agent can find and install `swarm-onboarding` | none | `SKILL.md` present on disk in the runtime's skill path |
| 2 | toolchain | the agent can install `rmpc` for its own arch | none | binary on PATH; `--help` lists `committee-identity` |
| 3 | keygen + signing | local ed25519 identity, byte-exact canonical payload | none | harness verifies the signature **offline** against `canonicalizeApplication` |
| 4 | admission | the full R4→R8 sequence, unaided | `core` | server-minted member reaches the active roster |

Layers 0-3 need **no server**. Layer 4 needs a `core` stack only — postgres and
the api — because apply/approve/claim is Postgres CRUD plus signature
verification and never touches the job queue. The eval never boots the full smoke
cluster: no worker lanes, no EDGAR seed, no frontend checks, no session drivers.

Layers 1-3 observe by inspecting the **stopped container's filesystem** before
removal, never by instructing the agent to emit artifacts — adding harness
instructions would edit the task under test. Layer 4 uses the canonical
`ONBOARDING_PROMPT` construction as its prefix, changing **only** the skill URL
to `${apiUrlInternal}/skills/swarm-onboarding/SKILL.md`: the prompt
asks the owner for identity rather than carrying blanks for a harness to
substitute, so the unattended run answers that question — alongside the existing
local-network note — in one clearly delimited block appended after the canonical
text. It then observes only server-side state, preserving the black-box property
where it matters most.

Layers 0-3 (issue #279) are implemented, named by claim, under
`evals/onboarding/isolated/`: `runtime.eval.test.ts`,
`skill-install.eval.test.ts`, `toolchain.eval.test.ts`,
`keygen-signing.eval.test.ts`, with shared support in
`evals/onboarding/support/`. They run ON DEMAND through the single
`bun run eval:onboarding:isolated` target, which runs `runtime` to completion in
its own `bun test` process before the other three (the ordering the gating
depends on). They are NOT on a schedule: issue #378 retired
`.github/workflows/onboarding-evals-nightly.yml`, which used to run them as a
`CI_CLASS: heavy`, schedule-only job. `runtime` gates the run: a red
`runtime` reports `skill-install`/`toolchain`/`keygen-signing` as
`not-measured`, never `failed` (`evals/onboarding/support/gating.ts`) — when
`runtime` is green the three are mutually independent. Layer 4 (admission) runs
in `.github/workflows/e2e.yml`, on every push to `main` and on that workflow's
nightly `schedule` mirror of it (E6).

**E4 — Scored by sampling.** Layer 4 runs K samples with a fresh identity and
container each. Every outcome is classified — `admitted`, `refused`,
`rate-limited`, `timed-out`, `navigation-failure` — and the **admission rate is
the reported metric**. A refusal is data, not flake: a rising refusal rate is a
regression in prompt quality, and this is the only instrument that surfaces it.
The scorecard asserts K samples actually ran, so a zero-sample run is red rather
than a vacuous green.

**E5 — Shared components, not parallel ones.** The eval is the smoke's onboarding
path with fewer services booted. Three components are shared by construction:

- **`scripts/lib/smoke-stack.ts`** — one bring-up with a `core`/`full` profile,
  free of module-scope side effects and of `process.env` reads or writes
  (compose's env map is built from an explicit config object and passed to that
  one child process). Consumed by the smoke (`full`), the eval (`core`), and the
  rails check (`core`, replacing its forked `bringUpInfra()`).
- **`runMemberAgent()`** — the member-agent container primitive (deterministic
  name, compose-run argv, pipe draining, guaranteed removal), extracted from
  `runOnboardingEval` so layers 0-3 and layer 4 launch containers the same way.
- **`classifyOutcome()`** — one definition, three consumers: the retry predicate
  in `runOnboardingEvalWithRetry`, the smoke's onboarding driver, and the eval's
  scorecard. A refusal is retryable under this classifier, which is why the smoke
  no longer forfeits a finite roster seat to one unlucky sample.

**A dead run's cause is read, never guessed (issue #527).** `opencode run
--format json` reports a failed model exchange as a first-class
`{"type":"error",…}` line on **stdout** — carrying the provider's typed
discriminator, message, HTTP status, `isRetryable` verdict and endpoint — and
writes nothing to stderr. `scripts/agent/transcript.ts`'s `transcriptErrors()`
is the one parser for it, and `scripts/agent/inference-failure.ts` turns those
events into a stable `InferenceFailureKind`: `exhausted-credits`,
`auth-rejected`, `quota-limited`, `throttled`, `provider-failure`,
`local-cli-failure`, `empty-response`, `timed-out`, `unclassified-error`.

Two rules govern that classification. **The typed discriminator decides** —
`exhausted-credits` fires on Zen's `CreditsError` and nothing else, never on an
"Insufficient balance" substring (prose is reworded upstream) and never on a
bare 401 (an invalid key returns the same status), because a wrong "top up the
balance" sends a maintainer to a billing page while the real fault goes unread.
**Nothing is ever softened** — every kind is a loud failure with no template
fallback and no skip; the kind changes only what the message says. Provider
text is redacted at parse time (credential values, `wrk_`/`acc_` identifiers,
workspace-scoped billing URLs), because these strings land in CI logs and PR
comments; the actionable "top up" instruction is rendered from the kind, never
scraped from the URL.

Both consumers of a dead run read it: the swarm boundary throws an
`InferenceFailure` carrying kind, provider and resolved model id
(`scripts/lib/swarm/inference.ts`), and `harnessFaultOf()` treats a
non-retryable 401/402/403 with no authored text as
`provider-rejected-harness-credential` — a `harness-error`, because an unfunded
or unauthorized key is the harness's own configuration failing, not a
measurement of the product. The conjunct matters: `opencode run` also issues a
small session-title call whose failure emits its own error event, so a run that
authored a take keeps its real result. Pinned by
`scripts/tests/unit/opencode-error-attribution.test.ts` (hermetic, against a
CI-captured payload) and `scripts/tests/unit/swarm-inference-opencode-argv.test.ts`
(through a fake CLI on the real spawn path, table-driven over every kind plus
the red control). This exists because on 2026-08-05 the Zen workspace ran out of
balance and every consumer reported the resulting `CreditsError / HTTP 401 /
isRetryable: false` as either an unspecified provider outage (six e2e failures,
three futile reruns, nobody told to top it up) or a red `navigation-failure`
against the onboarding instructions.

**E6 — CI placement: nightly mirrors the merge-to-main set.** The invariant
(issue #373, D26) is an *equality of sets*: **every** workflow that runs on
`push: branches: [main]` also runs on a nightly `schedule:`, and **nothing else
runs on a nightly schedule**. A red nightly therefore means exactly one thing —
the code on `main`, release code, is broken by an input that changed while
nobody was watching. No required reading, no "which suite was that and what are
its pass semantics".

The relationship is enforced mechanically, not by convention:
`scripts/tests/unit/nightly-mirrors-merge-set.test.ts` runs in the required
`unit` job, asserts the equality in **both** directions, names any workflow on
one side only, and additionally fails on any job or step gated with
`github.event_name == 'schedule'` — nightly must run the merge set's work, not
extra work. Cron minutes are staggered so the mirrors do not all start at once.

The real-inference admission's scheduled home is therefore
`.github/workflows/e2e.yml` itself, on the `schedule: 37 4 * * *` slot the
retired `swarm-opencode-nightly.yml` used to hold: `ONBOARDING_REAL_EVAL`
resolves to `"1"` on a `schedule` event exactly as it does on a `push`, so a
nightly spends **one** real admission. That is a smaller per-night sweep than the
retired nightly's models × identities, and a **larger denominator over time** —
thirty nights is thirty samples, read off run history rather than a bespoke
scorecard. The accepted tradeoff is time-to-detection: a shift in the admission
rate surfaces over about a week rather than in one night.

**Reporting rides on the admission that already runs.** No sampling loop, no
scorecard module, no second stack bring-up. The isolated eval harness
classifies the run with the existing `scripts/agent/classify-outcome.ts` and
renders a small structured record — outcome, resolved model id, duration, member
id, agent-liveness counts, and whether the sample belongs in the admission-rate
denominator — which `e2e.yml` folds into `$GITHUB_STEP_SUMMARY` and uploads as an
artifact with `if: always()`, on green and red runs alike. A `harness-error`
renders **distinctly** from a `refused` and is excluded from the denominator: it
measured nothing about the product. The renderer is pure and is unit-tested from
synthetic results in the required `unit` job
(`scripts/tests/unit/admission-record.test.ts`) — zero inference, no Docker.

A run of this eval is still **never** an acceptance criterion or test-plan item
on a pull request. It runs against `main`, so requiring it before merge would
gate a change on a job that only exists after that change lands; and a stochastic
measurement cannot gate a merge at all (D22 rule 4 — a single sample is a coin
flip reported as a verdict). It is post-merge monitoring — a model beginning to
refuse, a key running dry. The per-PR signal stays what it is: the inference-off
rails, plus the opt-in `real-eval` label for the one PR that needs an admission.

The `e2e` job's real-inference admission is **off by default on pull requests
and opt-in per PR** (D22 amendment "E6 (2026-07-28)"): add the label `real-eval`
to a PR and `ONBOARDING_REAL_EVAL` resolves to `"1"` for that PR's runs; remove
it and the PR is back to zero model spend. `labeled` is in the workflow's
`pull_request.types` so the label takes effect immediately, and the job guard
drops `labeled` events for any other label so tagging a PR does not boot the
live stack. That opt-in exists so a change *to this gate* can be exercised
before it merges — without it the gate is only reachable on `main`, where a
regression is discovered after the fact rather than on the PR that caused it.
It does not make the eval an acceptance criterion: the paragraph above still
holds for the nightly sweep.

**E7 — The harness plays the owner, and only the owner.** A prospective member
is a *pair*: a human owner and the agent they run. The eval automates the human
half and nothing else. Concretely, `scripts/lib/onboarding-eval.ts` supplies
exactly what an owner supplies before their agent ever starts —

- the display name and contact (R1). `ONBOARDING_PROMPT` carries no
  fill-in-the-blank placeholders for a harness to substitute (R4) — it **asks**
  its owner — so the harness answers that question in its appended note rather
  than rewriting the canonical text;
- the swarm API base URL for this run, because the ephemeral smoke stack
  cannot serve the production host the docs name;
- the keystore passphrase, exported into the agent's environment. The published
  `swarm-onboarding` skill tells the agent to ask its owner for this and to
  **wait** for them ("Tell me once it's set"), and forbids accepting the value
  in conversation. A headless container has no owner to answer, so an agent
  following the skill correctly *stops*. Supplying it is the owner's job, not a
  hint;
- a **vanilla** agent runtime with auto-approve, because R8 says the container
  is a vanilla OpenCode install. A harness-imposed permission denial measures
  our own sandbox, not our instructions.

Everything past that point — finding the skill, installing `rmpc`, keygen,
building the canonical payload, signing it, submitting it, waiting, claiming —
is the agent's own inference, and no harness-supplied string may name a tool, an
endpoint, a payload shape, or a step. Two outcomes are **product defects, not
eval flake, and are reported as results**: a *refusal* (the agent declines the
task — the measured refusals that shaped `ONBOARDING_PROMPT`'s opening bounds)
and a *stall* (the agent correctly waits on an owner who cannot answer). Both
mean the published instructions do not stand on their own.

**E8 — Retained, tailable, per-prospect transcripts (issue #317).** The
member-agent primitive already redacts and returns a transcript for every run
(`scripts/agent/member-agent.ts`), but until #317 the smoke's onboarding driver
only ever wrote it to the shared `.agents/smoke-<project>.log`, and only when
the prospect FAILED — a successful or still-running prospect left no
discoverable record, and the container's own filesystem is removed at
teardown (`--rm`). Rather than a second persistence mechanism, the standing
driver now wires in the SAME artifact primitive the local eval entrypoint
already used (`createOnboardingArtifactWriter` /
`scripts/lib/smoke-prospect-transcript.ts`), so both converge on one directory
per prospect:

```text
.agents/onboarding-evals/<composeProject>/<runId>/
  manifest.json         — candidate display name, smoke run, model, limits
  events.ndjson         — the consolidated lifecycle timeline: launch,
                          container-observed ("ready"), every redacted
                          agent/API/Postgres line, exit, cleanup
  agent.stdout.ndjson   — the agent's own redacted NDJSON, live-appended
  agent.stderr.log      — the agent's redacted stderr, live-appended
  services.log          — followed API/Postgres Compose lines
  result.json           — the classified outcome (§11.3 E4): branch, reason,
                           liveness/error evidence, memberId, steps, exit code
```

Every file is appended to synchronously as events arrive, so it is
**tail-able while the prospect's container is still running** and **remains
inspectable after the container is removed** — both live on the host, not
inside the container. `<composeProject>` is the isolated evaluation stack's
project name recorded in its manifest; `<runId>` is the
candidate's slug, printed in the log line `onboarding <name> transcript: …`
the driver emits the moment it starts an attempt. **Operator workflow:**

```bash
# while a prospect is in progress
tail -f .agents/onboarding-evals/<project>/<runId>/events.ndjson

# after success, failure, or container teardown
cat .agents/onboarding-evals/<project>/<runId>/result.json
```

A retried attempt (a `refused` or `rate-limited` first try —
`runOnboardingEvalWithRetry`) still lands in this ONE directory: the writer is
keyed by the prospect's base identity, and each attempt tags its own events
with its own attempt number, so a retried admission reads as one continuous
record rather than fragmenting across two. This directory is git-ignored
runtime state (`.agents/`), identical in that respect to the smoke log file and
the local eval's own artifacts (docs/reports/2026-07-29-local-onboarding-eval-assets.md).

---
