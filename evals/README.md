# `evals/` — the eval cost class

Status: normative (docs/decisions.md **D22**, docs/architecture.md **§11.3**,
and the directory rule **L1** in architecture.md's "Test, eval, and tooling
layout").

A directory is a selectable unit of CI cost (L1). Everything under `evals/`
needs **Docker + network egress + REAL model inference**, so it runs
**nightly / sweep-only** and is **never** on the per-PR path. The root
`package.json`'s `test` script is deliberately path-scoped
(`bun test scripts/tests`) so nothing here can drift onto that path by
accident; `bun run eval:onboarding` is how this suite is invoked.

```
evals/onboarding/
  isolated/    layers 0-3 — NO server: runtime, skill install, rmpc toolchain, keygen+signing
  admission/   layer 4    — the sampled admission sweep on a `core` stack (postgres + api)
  support/     the layer prompts, the stopped-container probe, the signature harvest, the scorecard
```

## The invariants this directory holds to

These are enforced, not merely stated: `scripts/checks/check-eval-keyless.sh`
greps this tree on every PR (wired into `.github/workflows/integration.yml`),
and `scripts/tests/unit/evals-guard.test.ts` executes that script — including against
a fixture that must make it fail, so the gate can never be vacuously green.

**E1 — keyless, no exceptions.** No API key, provider secret, paid model, or
opt-in override may appear on any path under this directory. The model id is an
in-code constant (`EVAL_MODEL` in `scripts/agent/model-config.ts`), never an
environment variable — there is deliberately **no configuration surface at all**
here, which is why even a bare ambient-environment read fails the gate. A contributor
with a fresh checkout, Docker, and egress runs exactly what CI runs.

**E2 — no inference-off mode.** Every layer makes a real model call. No test
double, no injection seam on the eval's own path, no scripted fallback that
performs the agent's steps for it, and **no conditional skip**: a missing Docker daemon or
missing egress **throws**. Loud-skip-never — `0 tests collected` is red too
(`bun test <dir>` exits non-zero when it collects nothing).

Inference-**off** rails checks are legitimate and valuable, but they are not
evals and never stand in for one. They live outside this directory
(`scripts/tests/integration/onboarding-eval-infra.test.ts`), where test doubles and
injection seams are allowed precisely *because* nothing there claims to be an
eval.

**E3 — observation, never instruction.** Layers 1-3 observe by inspecting the
**stopped container's filesystem** and the drained run transcript before the
container is removed. Telling the agent to emit an artifact would edit the task
under test. Layer 4 observes **server-side state only**.

**E4 — scored by sampling.** Layer 4 takes K samples with a fresh identity and
container each, classifies every outcome
(`admitted | refused | rate-limited | timed-out | navigation-failure`) and
reports the **admission rate**. A refusal is data, not flake.

## Cost, stated plainly

Every number here is derived in `evals/onboarding/support/budget.ts` and pinned
against the nightly workflow by
`scripts/tests/unit/onboarding-eval-budget.test.ts`. Change the model, not the
literals.

| Target | Healthy tier | Measured 2026-07-26 | Worst case |
|---|---|---|---|
| `bun run eval:onboarding:isolated` | ~20 min — layers complete in 0.1-4.3 min | **59.5 min** — 3 of 4 layers ran to their full cap | **181 min** — each heavy layer retries once at its 25-min cap |
| `bun run eval:onboarding:admission` | — never yet executed | — | **122 min** — 5 × 20 min plus stack bring-up and image build |

Do not plan around the healthy column. In one observed run the same four layers
took 4.3, 25.0, 25.0, and 5.0 minutes — three of them hitting their cap — because
**the free tier degrades by HANGING, not by returning 429**. There was not one
rate-limit string in the entire 59-minute log; the provider simply stopped
answering. Layer 0, whose task is to write two characters to a file, went from
`admitted` in 6 seconds to a 5-minute timeout with an **empty transcript** over
the course of that single run.

Two consequences worth knowing before reading any result:

- `rate-limited` will rarely fire on this tier. **`timed-out` is the real
  throttle signal here**, and `runIsolatedLayer` deliberately retries only
  `rate-limited` (retrying a 25-minute timeout would double an already expensive
  layer), so a throttled run is reported rather than retried.
- **A red layer 0 invalidates the run.** See below.

## Layer 0 is the canary, not just the first layer

Layer 0 asks the agent to write two characters to a file. Nothing about Robot
Money appears in it, so it cannot be refused on the merits and it cannot fail for
any product reason. When layer 0 is red, the runtime or the provider is not
serving — and the other layers' results in that run are **not measurements**. A
layer 2 timeout sitting under a red layer 0 says nothing about whether an agent
can install `rmpc`; it says the tier stopped answering.

Read layer 0 first. If it is red, re-run later rather than drawing conclusions,
and do not spend the admission sweep at all.

CI timeouts are ordered `in-test < step < job`, so the harness always diagnoses
a stuck run before the runner kills it. A GitHub step timeout is a SIGKILL: it
takes the outcome classification, the agent's final message, and the scorecard
with it.

Do not put a fast check in here, and do not put anything from here on a
`pull_request` trigger.
