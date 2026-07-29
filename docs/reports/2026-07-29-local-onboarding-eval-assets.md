# Local onboarding eval assets and observability report

Date: 2026-07-29
Status: implementation validated in an adhoc worktree

## Objective and scope

The onboarding prompt and `committee-onboarding` skill need a tight local
development loop. A developer must be able to edit either one in this repo and
immediately run the existing real-agent eval against those exact bytes. The
loop must not require a commit, pull request, merge, or publication in another
repository.

This change deliberately does not add an eval command, proxy, sidecar, model
adapter, or second harness. It changes only where the current harness fetches
its bootstrap skill. The existing participation guide was already a static
asset in this repo and remains available through the same API process.

Publishing an approved skill to an external skills repository is a later
vendoring/release concern and is out of scope.

## Previous coupling

`COMMITTEE_ONBOARDING_SKILL_URL` points at a deep file URL in
`robotmoney-core`. The production copy-paste prompt used that constant, and the
eval injected the production prompt unchanged. Consequently, an instruction
experiment was not real until the core copy was pushed and remotely reachable.
That coupled frontend development to another repository's review and release
cycle and made prompt debugging unnecessarily slow.

The coupling was especially costly for agent failures: an agent could spend
minutes searching remote source after one incomplete instruction, while a
local edit could not be evaluated through the normal harness.

## Implemented architecture

The canonical development/eval skill now lives at:

`frontend/public/skills/committee-onboarding/SKILL.md`

No new serving mechanism was needed. The existing Compose stack already mounts
`frontend/public` read-only at `/srv/frontend`; the API already serves that
directory through `STATIC_DIR`. The member-agent can therefore fetch the exact
worktree file over the existing Compose network:

```text
frontend/public/skills/committee-onboarding/SKILL.md
                    |
                    | existing read-only Compose mount
                    v
       API static server at http://api:8787
                    |
                    | GET /skills/committee-onboarding/SKILL.md
                    v
          existing OpenCode member-agent
```

The contract now exposes `buildOnboardingPrompt(skillUrl)`. Its default remains
the published `robotmoney-core` URL, so the production prompt is unchanged.
`scripts/lib/onboarding-eval.ts` calls the same builder with
`http://api:8787/skills/committee-onboarding/SKILL.md`; every other prompt byte
and the existing separately delimited owner note remain unchanged. The
vendored browser contract was synchronized from the contract source.

The Docker integration rail also fetches both local assets from inside the
member-agent container:

- `/skills/committee-onboarding/SKILL.md`
- `/views/docs/investment-committee/participation.html`

It asserts recognizable file content and rejects the SPA shell. This proves
the agent sees exact static files rather than a client-side fallback page.

## Worktree environment caveat

Git worktrees do not copy ignored, untracked `.env` files from the principal
checkout. Bun resolves `.env` relative to the process working directory, so
running the eval from a new worktree can appear to have no OpenCode credential
even when the principal checkout is configured.

For a funded local run, export the required values into the invoking shell from
the operator's private configuration, or create a private `.env` in the
worktree. Do not commit it. The harness uses the existing keyed model registry;
the default is a funded model and a missing key fails loudly. A keyless model
should only be selected when that is the explicit experiment.

## Funded eval evidence

One local run exercised the existing harness with
`opencode/deepseek-v4-flash`, funded through the configured OpenCode key.

- The agent fetched
  `http://api:8787/skills/committee-onboarding/SKILL.md`.
- It did not fetch the participation guide.
- It generated an identity and submitted an application accepted with HTTP
  201 and a server-minted member ID.
- The harness observed application, auto-approval, claim activity, and an
  admitted result.
- The run completed successfully in 208 seconds.

This is evidence that an unmerged local skill can drive the real onboarding
path. It is one sample, not a model-quality benchmark.

The transcript also demonstrates why detailed evidence matters. The agent
first assumed `rmpc` returned raw strings, discovered that the commands return
JSON, attempted an unavailable Perl JSON module, installed Python, extracted
the fields, and recovered. The skill should state the actual JSON extraction
directly; an admitted boolean alone hides this fragility.

## Telemetry and logging gaps

The current primitives already collect most required signals, but not in one
inspectable timeline:

- `runMemberAgent` concurrently drains OpenCode stdout and stderr but buffers
  each entire stream until the container finishes.
- The local command prints the combined transcript only after completion.
- Harness lifecycle events are emitted live, but have no shared event schema
  with OpenCode or service logs.
- API and Postgres Compose logs are not followed alongside the agent.
- Successful and failed runs do not share a durable, consistently located
  artifact set.
- The current `admitted` predicate is roster-derived; approval can make that
  predicate true before token claim is independently proven. Claim should have
  an explicit observed assertion if it remains part of the success contract.

These gaps turn a recoverable command failure, an API rejection, or a process
stall into a needle-in-a-haystack investigation across console buffers,
container state, and temporary files.

## Minimal consolidation in the existing harness

The next change should extend the existing primitives, not introduce another
runner:

1. Change the current stream drain to emit redacted, timestamped lines while
   continuing to build the same final stdout, stderr, and transcript strings
   used by classifiers.
2. Follow timestamped Compose logs for the services in the active profile
   (API and Postgres for the local core eval; the existing demo services for a
   demo run) and merge them into the same event timeline.
3. Normalize harness lifecycle events, agent output, and service output into
   NDJSON with common correlation fields: compose project, run ID, attempt,
   container name, OpenCode session ID when known, contact hash, and member ID
   when minted.
4. Persist every run, successful or failed, under the ignored runtime tree:

   ```text
   .agents/onboarding-evals/<project>/<run-id>/
     manifest.json
     events.ndjson
     agent.stdout.ndjson
     agent.stderr.log
     services.log
     result.json
   ```

5. Put prompt and skill hashes, selected model, start/end times, limits, exit
   status, step observations, and classifier result in the manifest/result so
   two experiments can be compared without guessing what ran.

The console and artifact paths must consume the same already-redacted event
objects. There should be no separate unsafe transcript path.

## Security and redaction requirements

The current source-level redactor removes exact model-key and owner-secret
values injected by the harness before returning a transcript. Preserve that
property when streaming: redact before a line reaches the terminal, callback,
or disk, including secrets split across read chunks.

Exact injected-value redaction is necessary but insufficient. Credentials
created during the run are not known when the container is launched. The
funded transcript contained a token-shaped claim response field. Consolidated
logging must structurally redact known secret-bearing fields such as bearer
tokens in addition to scrubbing injected values. It must never persist API
keys, passphrases, bearer tokens, keystores, private keys, or the temporary
OpenCode configuration. Public keys, signatures, member IDs, HTTP status, and
redacted request/response shapes can remain because they are useful evidence.

Artifact directories should be owner-only and files should not be world
readable. Redaction tests need positive cases for injected and generated
credentials plus negative controls proving ordinary diagnostic text survives.

## Validation

Executed in the adhoc worktree:

- `bun test contract/tests/unit/committee-application.test.ts scripts/tests/unit/onboarding-eval-helpers.test.ts` — 88 passed, 0 failed.
- `bun test scripts/tests/integration/onboarding-eval-infra.test.ts` — 7
  passed, 0 failed, including in-container static-file fetches and a real
  `rmpc` signed application against the API.
- `bun run check-contract` — vendored frontend contract current.
- `bun run typecheck` — passed.
- Funded real-agent run — admitted in 208 seconds as described above.

## Known limitations and next boundary

- The production prompt intentionally still names the externally published
  skill; this change accelerates development/evaluation, not release.
- `rmpc` is still downloaded from external release assets. Local publication
  in this change concerns the bootstrap skill and existing participation guide,
  not the client binary.
- The funded evidence is a single model/sample and included agent recovery from
  incomplete command-output instructions.
- The current success predicate should distinguish approval, token claim, and
  actual authenticated participation rather than deriving them all from active
  roster membership.
- Live consolidated telemetry and durable artifacts are proposed here but not
  implemented in this scope.
- Vendoring the approved skill to the external skills repository, versioning
  it, and switching production publication are explicitly out of scope.
