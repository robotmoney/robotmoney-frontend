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

| Target | Expected | Worst case (every retry taken) |
|---|---|---|
| `bun run eval:onboarding:isolated` | ~45 min — 4 real runs, layers 1-3 at ~8-12 min each | **181 min** — each heavy layer retries once at its 25-min cap |
| `bun run eval:onboarding:admission` | ~110 min — `SAMPLE_COUNT` sequential samples | **122 min** — 5 × 20 min plus stack bring-up and image build |

The isolated suite is cheap in *expectation* and expensive only when the free
tier is rate-limiting: a 429 is retried once per layer (`MAX_ATTEMPTS = 2`),
which is what doubles the bound. That is also the night the run must not be
truncated — a killed job cannot report that it was rate-limited, and
`rate-limited` is the one outcome meaning the eval measured nothing at all.

CI timeouts are ordered `in-test < step < job`, so the harness always diagnoses
a stuck run before the runner kills it. A GitHub step timeout is a SIGKILL: it
takes the outcome classification, the agent's final message, and the scorecard
with it.

Do not put a fast check in here, and do not put anything from here on a
`pull_request` trigger.
