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
- The funded telemetry sample exposed that the then-current `admitted`
  predicate was roster-derived: approval made it true before token claim. The
  harness now requires public `state=claimed`, a non-null `claimedAt`, and
  active-roster membership independently.

These gaps turn a recoverable command failure, an API rejection, or a process
stall into a needle-in-a-haystack investigation across console buffers,
container state, and temporary files.

## Consolidated telemetry in the existing harness

The existing primitives now provide the consolidated timeline; no second
runner, proxy, sidecar, service, CLI, or OpenCode mode was introduced:

1. The member-agent pipe drain emits complete redacted lines as they arrive,
   while building the final stdout, stderr, and classifier transcript from the
   same redacted records. A partial line stays behind the safety boundary until
   its continuation arrives, so a secret split across read chunks cannot leak.
2. The local eval follows timestamped API and Postgres Compose logs after stack
   readiness and merges them with agent output and harness lifecycle events.
   It attaches with `--tail=0`, so historical database initialization does not
   bury the current exchange. The follower is stopped and fully drained before
   the existing teardown.
3. One sequencer normalizes those records with compose project, run ID,
   attempt, source, stream, timestamp, container name, OpenCode session ID when
   observed, and member ID after it is minted.
4. Observer reads emit `observer.poll.failed` and
   `observer.poll.recovered` transitions per API surface. A failure still
   active when observation ends is retained in the result and classified as a
   non-retryable `harness-error`, rather than being mislabeled as an agent
   navigation failure or timeout.
5. Every local run, successful or failed, persists under the ignored runtime tree:

   ```text
   .agents/onboarding-evals/<project>/<run-id>/
     manifest.json
     events.ndjson
     agent.stdout.ndjson
     agent.stderr.log
     services.log
     result.json
   ```

6. The manifest/result records prompt and skill hashes, selected model, timing
   limits, exit status, step observations, errors, and cleanup results. It does
   not persist the prompt, credentials, or contact; only a run-scoped contact
   hash is retained.

The console and artifact paths consume the same already-redacted event objects.
The compatibility transcript is assembled from those objects rather than from
a separate unsafe buffer.

## Security and redaction requirements

The current source-level redactor removes exact model-key and owner-secret
values injected by the harness before returning a transcript. Preserve that
property when streaming: redact before a line reaches the terminal, callback,
or disk, including secrets split across read chunks.

Exact injected-value redaction is followed by structural scrubbing for
Authorization/Bearer values, claim-token shapes, admin/analytics/access/refresh
tokens, API-key/passphrase/private-key assignments, keystores, and private-key
blocks. JSON-escaped secret fields are scrubbed too, including the real
`rmpc-committee-identity-keystore` ciphertext when a shell tool result is
wrapped inside OpenCode NDJSON. The local contact is also an exact redaction input for agent and service
streams. Public keys, signatures, member IDs, HTTP status, and redacted
request/response shapes remain because they are useful evidence.

Artifact directories should be owner-only and files should not be world
readable. Redaction tests need positive cases for injected and generated
credentials plus negative controls proving ordinary diagnostic text survives.

## Validation

Executed in the adhoc worktree:

- `bun test scripts/tests/unit/onboarding-telemetry.test.ts
  scripts/tests/unit/onboarding-eval-helpers.test.ts
  scripts/tests/unit/member-agent-classify.test.ts` — 112 passed, 0 failed.
  This includes executable checks for live-before-exit output, interleaved
  ordering, chunk-split and generated-secret redaction, transcript/classifier
  compatibility, observer failure/recovery classification, success/failure
  artifacts, and follower termination.
- `bun test contract/tests/unit/swarm-application.test.ts scripts/tests/unit/onboarding-eval-helpers.test.ts` — 88 passed, 0 failed. (Path renamed since — issue #263 renamed `committee-application.test.ts` to `swarm-application.test.ts`; the command as originally run used the pre-rename name.)
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
- Claim completion is now independently proven. The eval does not yet execute
  an actual committee session; its final `session` step means the claimed,
  active member is ready to participate, not that a take was submitted.
- This first telemetry phase follows API and Postgres process logs but does not
  add request-level API tracing; a request/response correlation layer remains a
  possible later phase if process logs prove insufficient.
- Vendoring the approved skill to the external skills repository, versioning
  it, and switching production publication are explicitly out of scope.

## Funded consolidated-telemetry sample

One post-implementation sample ran with Bun explicitly loading the operator's
private `.env` and `AGENT_MODEL=deepseek/v4-flash`; no free-tier model was
selected or probed. Project `rmeval_improved_logging_funded`, run `9f799ca7`,
completed the then-current roster-derived gate in 211 seconds (222.7 seconds
including setup and cleanup).

The retained artifact has 178 contiguous, timestamp-ordered events across
agent, API, Postgres, harness, Compose, and cleanup sources. One OpenCode
session is correlated from the local skill fetch onward; one server-minted
member ID is correlated across 13 later events. The local skill fetch,
application, auto-approval, classifier, follower stop, container purge, and
stack teardown are all visible in order. All six files are mode `600` inside a
mode `700` directory. Exact model key/contact values and generated bearer,
claim-token, passphrase, private-key, and keystore patterns were absent.

That sample found three defects, fixed without spending a second inference
run: Compose replayed historical Postgres logs; the member-agent Compose child
lacked the generated `RM_STACK_ENV_*` map and warned about a volume hash
mismatch; and approval was mislabeled as full onboarding before claim. The
follower now starts at the current log edge, the exact stack spawn environment
is reused by the member-agent Compose process, and claim-based success is
covered by approved-but-unclaimed and claimed regression tests. The retained
sample's `admitted=true` result records the pre-fix semantics and is preserved
as evidence rather than rewritten.

## Generic eval-suite follow-up

The local admission runner is now a reusable case in a native Bun eval suite.
`bun run eval` discovers only `evals/`, while appended path and test-name
filters retain Bun's normal behavior and fail on an empty selection. The first
registered case is `onboarding.admission`; its executor is the existing local
stack/agent/observer path, not a second harness.

Definitions carry stable metadata, real-inference tier, samples, timeout and
budget plus run/score functions. Suite artifacts are consolidated under
`.agents/evals/<suite-run-id>/` with manifest/summary files and the existing
redacted case files nested by eval and sample. The suite requires keyed model
access before Docker and does not probe the retired free-tier path.

The first suite-native funded sample used `deepseek/v4-flash` and completed in
257 seconds. Suite run `2026-07-29T19-36-30-430Z-694961d2` executed exactly one
sample and correctly scored red: the agent submitted a valid signed
application, was auto-approved and appeared on the active roster, but exited
without claiming its bearer token (`applyState=approved`, `claimedAt=null`).
The domain outcome is `navigation-failure`; the separate runner result is
`failed`, with admission rate 0/1.

The retained 109-event timeline has complete suite/eval/sample/model
correlation, one OpenCode session and the server-minted member id. It exposed
two concrete instruction defects before the final claim failure: the canonical
payload recipe invokes `node`, which the vanilla member-agent image does not
contain, and the recipe initially treats `show-public-key` and `sign` output as
raw strings although released `rmpc` returns JSON objects. The agent recovered
with shell extraction, but then interpreted “wait for human approval” as a
terminal state even though the harness approved it while the process was still
alive. These are product findings from the eval, not harness errors; no second
funded sample was run.
