# Reconciling `stack` with the runbooks

What changes, what does not, and the five collisions that need a decision
rather than an edit.

Inputs: [`release-runbooks.md`](./release-runbooks.md) (foundational policy),
[`../runbooks/deployment.md`](../runbooks/deployment.md) (standing topology and
credentials), and the verified behaviour in
[`stack-orchestrator.md`](./stack-orchestrator.md).

---

## Verdict

**Every goal the runbook policy exists to serve is achievable with `stack` as
the deployment vendor, and three of the six are better served than today.** The
work is in mechanism, not in objectives — no gate has to be weakened, waived, or
rewritten to accommodate the platform.

| Goal the policy serves | Under stack | Mechanism |
|---|---|---|
| **Reproducibility** — the procedure is written, not remembered | **Better** | The spec file is a versioned artifact. Today nothing describes what staging *is*. |
| **Rehearsal fidelity** — prove on a twin before prod | **Better** | `backup restore --from <prod>` makes the twin a *whole-stack* twin, not a database twin. Repositories are interchangeable across compose and k8s. |
| **Recoverability** — always able to get back | **Better**, once §5.2 is adopted | Data: restic snapshots + `backup restore`. Code: immutable published tags make rollback a pointer change. |
| **Auditability** — reports, sign-off, go/no-go | **Same** | Human artifacts; the platform is neutral. |
| **Agent execution** — no human at a production shell | **Same or better** | A CLI plus a kubeconfig, with no interactive step. |
| **No silent drift** — Git is the source of truth | **Same, conditional** | Holds only with the deployment-directory discipline in §5.1. |

The single objective that is *not* natively met is code rollback, and §5.2 shows
it is closed by a definition-level choice rather than by tooling we would have
to build. What remains below are decisions to make, not obstacles.

## The short version

The three documents sit at different altitudes, and `stack` lands on exactly
one of them.

| Document | Altitude | Effect of adopting stack |
|---|---|---|
| `release-runbooks.md` | **policy** — which gates must pass | **Essentially unchanged.** Two gates name a mechanism and need rewording. |
| `../runbooks/deployment.md` | **topology + credentials** — what exists and how it is reached | **This is where stack lands.** Several sections change materially. |
| per-release runbooks | **procedure** — the commands to run | Gain the stack command sequences. Nothing structural. |

That split is not an accident: `release-runbooks.md` §1 already says it "is not
itself a runnable checklist". A deployment platform is a mechanism, and the
policy was written to be mechanism-agnostic. It mostly holds.

---

## 1. What the policy keeps, unchanged

Every gate in §4 survives adoption, because each one describes an *obligation*,
not a tool:

- **§4.1 code-readiness** — unaffected, this is git and issues.
- **§4.2 pre-upgrade baseline** — still required; only the capture command changes.
- **§4.5 stage rehearsal report**, **§4.9 rollout report** — unaffected.
- **§4.6 fix loop** — unaffected, and see §7 below for why it matters here.
- **§4.7 agent-executed end to end** — *strengthened*, if anything. `stack` is a
  CLI with a kubeconfig; there is less reason than before for a human to hold a
  production shell.

The release-branch and tagging rules (§2, §3) are untouched by a deployment
platform.

## 2. What the policy has to reword

Two gates name a mechanism that stack replaces. Both should become
platform-neutral statements of the obligation, with the mechanism moved into the
per-release runbook.

**§4.3 backup/restore smoke test** currently reads "on a staging host inside the
production database's private network … of the production read-only database".
That presumes DO Managed Postgres reached over a private network. Under a
stack-owned database the same obligation is met by
`stack manage --dir <d> backup now` followed by a real restore. The obligation —
*prove the backup produces a restorable artifact before proceeding* — is what
should stay in the policy.

**§4.4 digital-twin rehearsal** currently requires restoring "to a local Postgres
container (not a remote database) on a staging machine". Under stack this gets
strictly better and should be allowed to: the documented fan-out pattern makes
the twin a **whole-stack** twin, not just a database —

```sh
stack deploy   --spec-file <spec> --deployment-dir ~/deployments/twin
stack manage   --dir ~/deployments/twin start
stack manage   --dir ~/deployments/twin backup restore --from <prod-deployment-name>
```

The policy's intent (rehearse on real data, in isolation, on the same RC) is
preserved and better served. Reword the parenthetical rather than the gate.

## 3. Gate → command mapping, for per-release runbooks

| Gate | stack mechanism |
|---|---|
| §4.2 baseline | `stack manage --dir <d> backup now`, plus the app-specific state capture the objective names |
| §4.3 backup smoke | `backup now` → `backup list` → `backup restore` into a scratch deployment |
| §4.4 twin | `deploy` + `start` + `backup restore --from <prod>` (§2 above) |
| §4.7 cutover | `prepare` → publish the version tag → edit the reference → `manage update` (§5.2) |
| §4.8 rollback | Code: point the reference at the previous version tag → `update`. Data: stop → `backup restore` → start (§5.3). Two axes, reasoned about separately. |

---

# The decisions

One of these (§5.2) is resolved and only needs adopting. The other four are
genuine decisions, none of which threatens a policy goal.

## 5.1. The deployment directory is stateful, and GitOps assumes it is not

`deployment.md` §1 states the principle: "Git is the source of truth; our CI
pipeline applies changes… CI is the **only** actor that mutates infrastructure."

A stack deployment is not stateless. `stack deploy` mints a **deployment
directory** carrying a `cluster-id`, and that id determines the Kubernetes
namespace *and* the restic repository path (`<bucket>/<deployment-name>`).

Observed directly: four `deploy` invocations in one session produced four
namespaces — `stack-18ea628b5d60d628`, `stack-08fb872ae056b0ad`,
`stack-2692653a17e2e000`, `stack-d6b992128bd8e312` — each a separate deployment
with its own PVC. `stop` did not remove them.

**So a CI job that runs `stack deploy` on every release does not upgrade
production. It creates a new production next to the old one, with an empty
database and a fresh backup repository, and leaves the real one orphaned.**

The reconciliation:

- **`deploy` is a rare, deliberate, human-authorized act** — environment
  creation, not release. It belongs in an environment-bootstrap runbook, not in
  the release pipeline.
- **CI only ever runs `prepare` → `push-images` → `manage update`.**
- **The deployment directory must be durable and identified.** At minimum the
  `cluster-id` must be recorded somewhere Git-tracked, so a lost directory is
  recoverable rather than silently replaced. The spec file itself should be
  committed; it is the artifact `deployment.md` §1 wants Git to be the source of
  truth for.

This is the deepest change to the GitOps section, and it is a *sharpening* of it
rather than a contradiction: the spec becomes the Git-tracked truth, and the
deployment directory becomes identified state that CI attaches to rather than
recreates.

## 5.2. Rollback has two axes — reference published tags, not `:stack`

`release-runbooks.md` §4.8 defines rollback as restoring the pre-upgrade dump.
That is the **data** axis, and stack serves it well (`backup restore`, with the
§5.3 caveat).

The **code** axis depends entirely on how the composefile names its image, and
the default is the wrong choice for a release process.

`remote_tag_for_image_unique` (`deploy/images.py:117`) rewrites a reference to a
private mutable staging tag — `…/robotmoney/api:deploy-8bd8e312` — **only when
the tag is one of `LOCALLY_BUILT_TAGS = ("local", "stack")`**. Any other
reference is returned verbatim and treated as a published image, digest-locked
in `stack.lock`.

So `image: robotmoney/api:stack` opts into mutability. New content arrives under
an unchanged reference, there is no earlier tag to point back at, and rollback
degrades into rebuild-and-re-push. Referencing a **published version tag**
instead makes rollback a pointer change. Verified end to end:

```
### roll FORWARD
deploy-api: image …/robotmoney/api:v0-2-2 -> …/robotmoney/api:v0-2-3
### ROLL BACK — no rebuild
deploy-api: image …/robotmoney/api:v0-2-3 -> …/robotmoney/api:v0-2-2
### no-op
deploy-api: unchanged
```

That third line is the second dividend. On the staging tag, stack cannot tell
whether content changed, so **every** `update` — including a no-op — forces a
re-pull and restarts the whole app tier. On an immutable tag a no-op is
genuinely `unchanged`, and only the services that actually changed roll. Blast
radius becomes proportionate to the change, which is what §4.7 and §4.8 both
assume.

**The recommendation, then:** pod composefiles reference
`<registry>/robotmoney/api:<version>`, CI publishes that tag at release time,
and the version in the composefile is the thing a release changes. It also makes
the deployed version legible from the spec — `kubectl get deploy -o
jsonpath=…image` answers "what is running" without inspecting digests.

Two properties remain true regardless and belong in §4.8:

- The axes roll independently and must be reasoned about independently: a
  migration that ran is not undone by rolling the image back.
- Rolling back to a version whose schema expectations differ from the live
  database is the case §4.8's default (restore the dump) exists for.

## 5.3. `backup restore` does not orchestrate, but §4.7 says "agent-executed"

Upstream is explicit: "Stopping the deployment first is the operator's job."
Restoring onto live volumes corrupts data, and there is no stop/restore/start
orchestration in the tool.

`release-runbooks.md` §4.7 requires the upgrade to be agent-executed end to end
with no human at a production shell. Both can be true only if the per-release
runbook **spells out the ordering explicitly** and the agent follows it:

```sh
stack manage --dir <d> stop
stack manage --dir <d> backup restore [--snapshot <id>]
stack manage --dir <d> start
```

Do not rely on the tool to refuse a live restore. It will not.

Also unimplemented upstream, and therefore not available to a runbook that
assumes them: `backup status`, `backup prune`, `backup check`, and
`backup list --from <deployment>`.

## 5.4. Generated secrets collide with the credential doctor

`credential-doctor.md` lists `ADMIN_TOKEN` and `ANALYTICS_TOKEN` as **generated
(64-char hex)** and pushed to GitHub Environment secrets; `deployment.md` §5 says
application secrets "live in the droplet env, injected by CI at deploy".

`stack` generates the same names itself, per deployment, into a cluster
`stack-secrets` Secret. **Two generators owning one name is drift**, and the
failure is quiet: the api authenticates against whichever value actually reached
it.

Decide one:

- **(a) stack owns them.** Drop `ADMIN_TOKEN`/`ANALYTICS_TOKEN` from the doctor's
  required set — `bun run credentials:check` must stop failing on their absence —
  and read them out with `stack manage --dir <d> secrets show` when an operator
  needs one. Fewer moving parts; recommended.
- **(b) CI owns them.** Declare them `external: true` in `stack.yml` and pass
  `--secret ADMIN_TOKEN=env:ADMIN_TOKEN` at init. Keeps the doctor authoritative
  and the existing rotation story intact.

Either way the inventory changes on the k8s path:

- **`SSH_PRIVATE_KEY` is no longer needed** — there is no droplet to SSH into.
  `deployment.md` §4.4's "pick a deploy mechanism" gains a third option, and the
  §7 checklist loses a line.
- **A kubeconfig credential appears**, best supplied as
  `--kube-config env:KUBECONFIG_DATA` from a GitHub Environment secret rather
  than a file copied into the deployment directory.
- **Registry credentials become load-bearing**, because `--image-registry` is
  mandatory for a k8s target (verified: importing into the node's containerd
  does not satisfy it).

## 5.5. There is no `staging` value for `RM_ENV`

`deployment.md` §2 tabulates staging and production as peer environments.
`backend/src/config.ts:539` pins `VALID_ENVS = ["ephemeral", "demo", "prod"]` and
throws on anything else — verified, it is how the first deployment crash-looped.

**Staging must run `RM_ENV=prod`**, and therefore inherits every prod fail-closed
path, `PROJECTS_SOURCE=live` included. That is arguably correct for a rehearsal
environment, but it is currently implicit, and `deployment.md` §2's table reads
as though a staging mode exists. State it in the table.

---

## 6. Smaller edits, for completeness

- **`deployment.md` §2.1** — "a hand-run `docker compose up -d` must run
  `bun run static:assemble` first" stays true for compose and becomes **false**
  for k8s, where `_static` is a layer in the image. Mark the note
  target-conditional; without the bake, `/` returns 500 while `/health` returns
  ok (verified).
- **`deployment.md` §4.4** — add the stack/registry mechanism alongside SSH and
  registry-pull.
- **`deployment.md` §7 checklist** — split into a compose column and a k8s
  column, or the checklist will ask for credentials the k8s path does not use.

## 7. Sequencing — do not do this during the 0.2 line

`release-runbooks.md` §4.6 is unambiguous: any change that affects production
safety sends the release back to §4.1 and costs a new release candidate. A
deployment-platform change during an in-flight rollout would do exactly that,
repeatedly.

The order that respects both documents:

1. Finish v0.2.2 on the existing mechanism. Change nothing in
   `docs/runbooks/v0-2-2-rollout.md`.
2. Land the §2 policy rewordings — they are platform-neutral improvements and
   are safe to make on `main` at any time.
3. Decide §5.1 and §5.4. These are the two that change credentials and CI, and
   both are cheaper to decide before staging runs on stack than after.
4. Reconcile `deployment.md` once staging has actually run on stack for a few
   releases — the plan's Phase 4 soak. Writing the standing reference against a
   platform with no production track record is how the drift the runbook policy
   exists to prevent gets introduced.
