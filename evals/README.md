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

## Current contents

**This directory is a scaffold.** The layered onboarding suites — layers 0-3
(isolated: runtime, skill install, `rmpc` toolchain, keygen + offline signature
verification), layer 4 (the sampled admission sweep on a `core` stack), and
their support modules, budget, probe/harvest and scorecard — land in the
follow-up feature of this phase. What already exists, and what those suites will
ride on, is the shared machinery outside this directory:

| Piece | Where |
|---|---|
| Member-agent container primitive (`runMemberAgent`) | `scripts/agent/member-agent.ts` |
| Model + credential registry (`resolveAgentModel` / `isKeylessModel`) | `scripts/lib/model-registry.ts` |
| Model/credential resolution for the eval (`resolveModelConfig`) | `scripts/lib/onboarding-eval.ts` |
| Outcome classifier (`classifyOutcome` / `explainOutcome`) | `scripts/agent/classify-outcome.ts` |
| `opencode run --format json` transcript parser | `scripts/agent/transcript.ts` |
| Shared compose bring-up (`core` / `full` profiles) | `scripts/stack/` |
| Layer-4 observer (prompt + poll loop) | `scripts/lib/onboarding-eval.ts` |

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
selection path, fails the gate. `AGENT_MODEL=free` remains fully supported for
genuinely unfunded runs; it is an option, not a mandate.

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

Read this before choosing `AGENT_MODEL=free`. The free tier **degrades by
HANGING, not by returning 429**. In one
observed run four layers took 4.3, 25.0, 25.0 and 5.0 minutes — three of them
hitting their cap — with not one rate-limit string in the entire 59-minute log;
the provider simply stopped answering. Two consequences worth knowing before
reading any result:

- `rate-limited` will rarely fire on the free tier. **`timed-out` is the real
  throttle signal there** — which is why the retry wrapper only treats a bare
  timeout as retryable when the resolved model is keyless.
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
