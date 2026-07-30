# `evals/` — the eval cost class

Status: normative (docs/decisions.md **D22**, docs/architecture.md **§11.3**).

## Why this directory exists

Until D22 this repo had **no real eval at all**. Every CI gate proved that code
we wrote runs — unit, integration, the demo readiness checks — never that the
product works for its actual user. That user is an unaided outside AI agent,
and the product surface *is* onboarding itself (architecture §11.1 R8). This
harness is the SDLC's only measurement of that capability: real agent, real
inference, real skill, real `rmpc`, real REST, real signature verification —
nothing stands in for the real call. Its entire value is the trustworthiness of
its verdicts: a red that reflects a true product or provider result is a valid
output; a green it cannot back is worse than no eval, because it restores the
false confidence the eval was built to remove. Every rule below exists to keep
that measurement honest, not to keep it green.

A directory is a selectable unit of CI cost. Everything under `evals/` needs
**Docker + network egress + REAL model inference**, so it runs
**nightly / sweep-only** and is **never** on the per-PR path. The root
`package.json`'s `test` script is deliberately path-scoped
(`bun test scripts/tests`) so nothing here can drift onto that path by accident.

## Running evals

The root entrypoint uses Bun's native test discovery with this directory as its
working directory. It is intentionally separate from `bun run test`:

```bash
bun run eval
bun run eval -- onboarding
bun run eval -- onboarding/admission.eval.test.ts
bun run eval -- --test-name-pattern admission
```

File and test-name filters are native Bun filters. A filter that selects no
file or no test exits non-zero. Every selected file contains real inference;
there is no listing or rehearsal mode under this directory.

The current suite registers the integrated onboarding admission case. Support
code in `evals/support/` provides validated definitions, sample planning,
scoring, Bun registration, and suite artifacts. The real stack and agent logic
remain shared machinery outside this directory:

| Piece | Where |
|---|---|
| Member-agent container primitive (`runMemberAgent`) | `scripts/agent/member-agent.ts` |
| Model + credential registry (`resolveAgentModel` / `isKeylessModel`) | `scripts/lib/model-registry.ts` |
| Model/credential resolution for the eval (`resolveModelConfig`) | `scripts/lib/onboarding-eval.ts` |
| Outcome classifier (`classifyOutcome` / `explainOutcome`) | `scripts/agent/classify-outcome.ts` |
| `opencode run --format json` transcript parser | `scripts/agent/transcript.ts` |
| Shared compose bring-up (`core` / `full` profiles) | `scripts/stack/` |
| Admission observer (prompt + poll loop) | `scripts/lib/onboarding-eval.ts` |
| Reusable local admission case | `scripts/onboarding-eval-local.ts` |

Definitions declare a stable id/title/tags, the `real-inference` tier, sample
count, timeout and optional budget metadata, plus `run(context)` and
`score(results)`. The wrapper registers an ordinary Bun test. Zero executed
samples, a red score, or a harness/configuration error makes that test red.

The canonical local skill and participation guide are served from this
checkout's `frontend/public/` tree by the existing stack. The development loop
therefore tests uncommitted local instruction changes; publishing those assets
to another repository is a separate release concern.

### The isolated claims: runtime, skill-install, toolchain, keygen-signing

`evals/onboarding/isolated/` holds the four claim-named, serverless evals that
bisect the onboarding funnel (issue #279) — named by what each one asserts,
never by a layer number: `runtime.eval.test.ts`, `skill-install.eval.test.ts`,
`toolchain.eval.test.ts`, `keygen-signing.eval.test.ts`. None of the four boot
a server (§11.3 E3); support code shared across them lives in
`evals/onboarding/support/` (`budget.ts`, `run.ts`, `tasks.ts`, `eval-stack.ts`,
`probe.ts`, `signature-harvest.ts`, `gating.ts`).

`runtime` GATES the other three: a red `runtime` means the container itself was
never a fair test subject, so `skill-install`/`toolchain`/`keygen-signing`
report `not-measured` — never `failed` (`evals/onboarding/support/gating.ts`).
Bun does not serialise multiple test files given to one `bun test` invocation
in argv order, so this ordering is enforced by running `runtime` to completion
in its **own** `bun test` process first; only once that process has fully
exited does a second process run the other three, reading runtime's outcome
from a suite-scoped handoff file. Both processes are wrapped in the single
target below, which is also the command `.github/workflows/onboarding-evals-
nightly.yml`'s `heavy`, schedule-only job runs:

```bash
bun run eval:onboarding:isolated
```

Each is billed to the registry-selected, funded model exactly like the
integrated admission case (E1 below) — there is no separate keyless mode for
these four.

## Artifacts

Each invocation receives a suite run id and writes owner-only files beneath:

```text
.agents/evals/<suite-run-id>/
  manifest.json
  summary.json
  cases/<eval-id>/<sample-id>/
    manifest.json
    events.ndjson
    agent.stdout.ndjson
    agent.stderr.log
    services.log
    result.json
```

Suite summaries keep domain outcomes distinct from the Bun runner verdict.
Every sample event carries the suite run id, eval id, sample id, model, compose
project, container/session identifiers when known, and member id when known.
The existing redaction boundary applies before console or disk output.

The invariants below are enforced against this directory whether or not it yet
holds a suite: `scripts/checks/check-model-selection.sh` announces loudly when
there is no `evals/` tree to scan, so a rename can never turn its green into a
silent one.

## The invariants this directory holds to

These are enforced, not merely stated: `scripts/checks/check-model-selection.sh`
greps this tree on every PR (wired into `.github/workflows/integration.yml`),
and `scripts/tests/unit/model-selection-guard.test.ts` executes that script —
including against fixture trees that must make it fail, so the gate can never be
vacuously green.

**E1 — one model-selection signal, and it lives in versioned source.**
*(Amended 2026-07-28 — D22 rule 1. This rule used to read "keyless, no
exceptions": the model was an in-code constant and no key could reach any eval
path. That mandate did not survive contact with the free tier —
`opencode/big-pickle`, the model it pinned, is saturated upstream with no paid
sibling to escape to, so enforcing it would have enforced an outage.)*

An eval selects its model through `AGENT_MODEL`, resolved against
`scripts/lib/model-registry.ts`. Model **ids** live in that one versioned file;
the environment carries only a **selector** (`deepseek`, `kimi/k2.6`). An
unknown family or member **throws** — a run must use the model it was asked for,
because a silent substitution turns a benchmark result into a lie. The single
credential is `OPENCODE_API_KEY`, injected into the container by one explicit
`-e` at `docker compose run` time and nowhere else.

A raw model id anywhere outside the registry, or a second env knob, or a second
selection path, fails the gate. The eval suite requires `OPENCODE_API_KEY` and a
funded registry selection. A missing key or no-credential selector fails before
the first Docker call; the suite never probes or falls back to a free model.

**E2 — no inference-off mode.** Every layer makes a real model call. No test
double, no injection seam on the eval's own path, no scripted fallback that
performs the agent's steps for it, and **no conditional skip**: a missing Docker
daemon or missing egress **throws**. Loud-skip-never — `0 tests collected` is
red too (`bun test <dir>` exits non-zero when it collects nothing).

Inference-**off** rails checks are legitimate and valuable, but they are not
evals and never stand in for one. They live outside this directory
(`scripts/tests/integration/onboarding-eval-infra.test.ts`), where test doubles
and injection seams are allowed precisely *because* nothing there claims to be
an eval.

**E3 — observation, never instruction.** Layers 1-3 observe by inspecting the
**stopped container's filesystem** and the drained run transcript before the
container is removed. Telling the agent to emit an artifact would edit the task
under test. Layer 4 observes **server-side state only**.

**E4 — scored by sampling.** Layer 4 takes K samples with a fresh identity and
container each, classifies every outcome
(`admitted | refused | rate-limited | timed-out | navigation-failure |
harness-error`) and reports the **admission rate**. A refusal is data, not
flake; a `harness-error` measured nothing about the product and can only make a
sweep redder.

## Cost, stated plainly

Every selected sample spends funded inference. A provider can degrade by
hanging rather than returning a rate-limit response, so two consequences are
worth knowing before reading any result:

- `timed-out` can be the real throttle signal. A funded
  `opencode/deepseek-v4-flash` was measured stalling mid-session for ~18 minutes
  with no token, tool call, or error on 2026-07-28, so the tier gate is gone. A
  genuine navigation failure presents as a container **exit**, not a timeout,
  and is still never retried on any tier.
- **A red layer 0 invalidates the run.** Layer 0 asks the agent to write two
  characters to a file. Nothing about Robot Money appears in it, so it cannot be
  refused on the merits and it cannot fail for any product reason. When layer 0
  is red, the runtime or the provider is not serving, and the other layers'
  results in that run are **not measurements**.

CI timeouts must be ordered `in-test < step < job`, so the harness always
diagnoses a stuck run before the runner kills it. A GitHub step timeout is a
SIGKILL: it takes the outcome classification, the agent's final message, and the
scorecard with it.

Do not put a fast check in here, and do not put anything from here on a
`pull_request` trigger.
