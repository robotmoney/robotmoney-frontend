# Reconciling `stack` with the runbooks

Whether the runbook policy's goals survive changing the deployment vendor to
`stack` — they do — and the mechanism each goal needs in order to hold.

Inputs: [`release-runbooks.md`](./release-runbooks.md) (foundational policy),
[`../runbooks/deployment.md`](../runbooks/deployment.md) (standing topology and
credentials), and the verified behaviour in the field guide,
[`stack-orchestrator.md`](./stack-orchestrator.md) — which carries the mechanism
this document only cites.

> **Section references.** A bare `§` is a section of *this* document. References
> to the other two are always qualified — `policy §4.3`, `deployment.md §7` —
> because all three documents number their sections and several numbers collide.

---

## Verdict

**Every goal the runbook policy exists to serve is achievable with `stack` as
the deployment vendor, and three of the six are better served than today.** The
work is in mechanism, not in objectives: no gate is weakened, waived, or dropped.
Two gates get reworded, but only to move a named mechanism out of the policy and
into the per-release runbook — the obligation each one imposes is unchanged (§2).

| Goal the policy serves | Under stack | Mechanism |
|---|---|---|
| **Reproducibility** — the procedure is written, not remembered | **Better** | The spec file is a versioned artifact. Today nothing describes what staging *is*. |
| **Rehearsal fidelity** — prove on a twin before prod | **Better** | `backup restore --from <prod>` makes the twin a *whole-stack* twin, not a database twin. Repositories are interchangeable across compose and k8s. |
| **Recoverability** — always able to get back | **Better**, once §4.2 is adopted | Data: restic snapshots + `backup restore`. Code: published images are commit-addressed, so rollback is a pointer change — but only if we publish rather than stage locally. |
| **Auditability** — reports, sign-off, go/no-go | **Same** | Human artifacts; the platform is neutral. |
| **Agent execution** — no human at a production shell | **Same or better** | A CLI plus a kubeconfig, with no interactive step. |
| **No silent drift** — Git is the source of truth | **Same, conditional** | Holds only with the deployment-directory discipline in §4.1. |

Recoverability is the only row that depends on a choice we have not yet made:
its data axis is native, and its **code** axis is native *too* — but only on the
published-image path. The local staging path, which is what an unconfigured
deployment uses, is mutable and cannot roll back. §4.2 is that choice. Nothing
below is an obstacle to a policy goal.

## Where the change lands

The three documents sit at different altitudes, and `stack` lands on exactly
one of them.

| Document | Altitude | Effect of adopting stack |
|---|---|---|
| `release-runbooks.md` | **policy** — which gates must pass | **Essentially unchanged.** Two gates name a mechanism and need rewording. |
| `../runbooks/deployment.md` | **topology + credentials** — what exists and how it is reached | **This is where stack lands.** Several sections change materially. |
| per-release runbooks | **procedure** — the commands to run | Gain the stack command sequences. Nothing structural. |

That split is not an accident: the policy already says of itself (policy §1)
that it "is not itself a runnable checklist". A deployment platform is a
mechanism, and the policy was written to be mechanism-agnostic — which is
exactly why adopting stack costs it so little.

---

## 1. What the policy keeps, unchanged

Every gate in policy §4 survives adoption, because each one describes an
*obligation*, not a tool:

- **policy §4.1 code-readiness** — unaffected, this is git and issues.
- **policy §4.2 pre-upgrade baseline** — still required; only the capture command changes.
- **policy §4.5 stage rehearsal report**, **policy §4.9 rollout report** — unaffected.
- **policy §4.6 fix loop** — unaffected, and see §6 below for why it matters here.
- **policy §4.7 agent-executed end to end** — *strengthened*, if anything.
  `stack` is a CLI with a kubeconfig; there is less reason than before for a
  human to hold a production shell.

The release-branch and tagging rules (policy §2, §3) are untouched by a
deployment platform.

## 2. What the policy has to reword

Two gates name a mechanism that stack replaces. Both should become
platform-neutral statements of the obligation, with the mechanism moved into the
per-release runbook.

**policy §4.3 backup/restore smoke test** currently reads "on a staging host inside the
production database's private network … of the production read-only database".
That presumes DO Managed Postgres reached over a private network. Under a
stack-owned database the same obligation is met by
`stack manage --dir <d> backup now` followed by a real restore. The obligation —
*prove the backup produces a restorable artifact before proceeding* — is what
should stay in the policy.

**policy §4.4 digital-twin rehearsal** currently requires restoring "to a local Postgres
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

All gate numbers in this table are the policy's.

| Gate | stack mechanism |
|---|---|
| §4.2 baseline | `stack manage --dir <d> backup now`, plus the app-specific state capture the objective names |
| §4.3 backup smoke | `backup now` → `backup list` → `backup restore` into a scratch deployment |
| §4.4 twin | `deploy` + `start` + `backup restore --from <prod>` (§2 above) |
| §4.7 cutover | `prepare --publish-images` from a clean release checkout → `manage update` against the durable deployment directory (§4.1, §4.2) |
| §4.8 rollback | Code: point the reference at the previous version tag → `update`. Data: stop → `backup restore` → start (§4.3). Two axes, reasoned about separately. |

---

## 4. The decisions

Five items, and they are not all the same kind of thing. **§4.1 and §4.4 are
genuine decisions** — they change CI and the credential inventory, and §6
sequences them first. **§4.2 is already resolved** and only needs adopting.
**§4.3 is an instruction to whoever writes the per-release runbook**, and
**§4.5 is a fact to write down.** None of the five threatens a policy goal.

### 4.1. The deployment directory is stateful, and GitOps assumes it is not

`deployment.md` §1 states the principle: "Git is the source of truth; our CI
pipeline applies changes… CI is the **only** actor that mutates infrastructure."

A stack deployment is not stateless. `stack deploy` mints a **deployment
directory** carrying a `cluster-id`, and that id determines the Kubernetes
namespace *and* the restic repository path (`<bucket>/<deployment-name>`).

Observed directly: four `deploy` invocations in one session produced four
namespaces — `stack-18ea628b5d60d628`, `stack-08fb872ae056b0ad`,
`stack-2692653a17e2e000`, `stack-d6b992128bd8e312` — each a separate deployment
with its own PVC.

`stop` does not remove them, and it is not meant to: it stops the workloads and
leaves the deployment intact. The lifecycle-ending command is
`stack manage --dir <d> destroy`, and **only `destroy --delete-volumes` removes
the namespace** — the default preserves volumes, so a half-cleaned deployment
keeps its PVC and its restic repository. So the orphans are recoverable; the
problem is not that cleanup is impossible but that nothing in a release pipeline
would ever perform it.

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

### 4.2. Rollback has two axes — publish images, don't stage them

Policy §4.8 defines rollback as restoring the pre-upgrade dump. That is the
**data** axis, and stack serves it well (`backup restore`, with the §4.3 caveat).

The **code** axis is served too, but only on the published-image path, and the
difference is invisible until you need it.

**Published images are commit-addressed.** `stack prepare --publish-images
--image-registry ghcr.io` pushes under a name taken from `stack.yml` with the
registry host prefixed, and **a tag that is the recipe repo's commit hash**.
Pulling needs no configuration at all: `prepare` computes the hash of the
checkout in front of it, pulls that image if it exists, and builds only if it
does not. A production host sets `--build-policy prebuilt-remote` so it fails
rather than quietly building from source.

That gives the release process exactly what policy §4.8 assumes, for free:

- every release is an immutable artifact identified by the commit it came from;
- rollback is checking out the previous release commit and running `update` — a
  pointer change, no rebuild;
- "what is running" is answerable from the Deployment, and maps to a commit.

One condition: **the tag is a plain commit hash only for a clean checkout with a
committed lock file.** A dirty tree or uncommitted `stack.lock` yields a
`stackdev-<hash>` instead. Release builds must run from a clean tree, and
`stack.lock` must be committed — which is a release-branch discipline the policy
already has machinery for.

**The unpublished path cannot do any of this.** With no published image,
`push-images` stages the local build under a private *mutable* per-deployment tag
(`…:deploy-<id>`). New content arrives under an unchanged reference, so there is
nothing earlier to point back at — and stack cannot tell whether content changed,
so **every** `update`, including a no-op, forces a re-pull and restarts the whole
app tier. Verified, switching between two immutable tags to show the contrast:

```
### roll FORWARD
deploy-api: image …/robotmoney/api:v0-2-2 -> …/robotmoney/api:v0-2-3
### ROLL BACK — no rebuild
deploy-api: image …/robotmoney/api:v0-2-3 -> …/robotmoney/api:v0-2-2
### no-op
deploy-api: unchanged
```

That third line is the second dividend: blast radius becomes proportionate to the
change, which is what policy §4.7 and §4.8 both assume.

**The decision, then:** publish to `ghcr.io` from CI on every `main` build, and
deploy published images everywhere except a developer laptop. The plan's §3.1
carries this; it reverses that plan's original DO Container Registry choice,
because auto-discovery only works when the registry matches the git host.

Two properties remain true regardless and belong in policy §4.8:

- The axes roll independently and must be reasoned about independently: a
  migration that ran is not undone by rolling the image back.
- Rolling back to a version whose schema expectations differ from the live
  database is exactly the case policy §4.8's default — restore the dump — exists
  for.

### 4.3. `backup restore` does not orchestrate, but policy §4.7 says "agent-executed"

Upstream is explicit: "Stopping the deployment first is the operator's job."
Restoring onto live volumes corrupts data, and there is no stop/restore/start
orchestration in the tool.

Policy §4.7 requires the upgrade to be agent-executed end to end
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

### 4.4. Generated secrets collide with the credential doctor

`../runbooks/credential-doctor.md` lists `ADMIN_TOKEN` and `ANALYTICS_TOKEN` as **generated
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
  `deployment.md` §4.4's "pick a deploy mechanism" gains a third option, and
  `deployment.md` §7's checklist loses a line.
- **A kubeconfig credential appears**, best supplied as
  `--kube-config env:KUBECONFIG_DATA` from a GitHub Environment secret rather
  than a file copied into the deployment directory.
- **Registry credentials become load-bearing**, because a reachable registry is
  mandatory for a k8s target — verified: importing into the node's containerd
  does not satisfy the check. Publishing to `ghcr.io` (§4.2) keeps this cheap:
  Actions' own `GITHUB_TOKEN` authenticates it with `packages: write`, so no
  long-lived registry credential joins the inventory.

### 4.5. There is no `staging` value for `RM_ENV`

`deployment.md` §2 tabulates staging and production as peer environments.
`backend/src/config.ts:539` pins `VALID_ENVS = ["ephemeral", "demo", "prod"]` and
throws on anything else — verified, it is how the first deployment crash-looped.

**Staging must run `RM_ENV=prod`**, and therefore inherits every prod fail-closed
path, `PROJECTS_SOURCE=live` included. That is arguably correct for a rehearsal
environment, but it is currently implicit, and `deployment.md` §2's table reads
as though a staging mode exists. State it in the table.

---

## 5. Smaller edits, for completeness

- **`deployment.md` §2.1** — "a hand-run `docker compose up -d` must run
  `bun run static:assemble` first" stays true for compose and becomes **false**
  for k8s, where `_static` is a layer in the image. Mark the note
  target-conditional; without the bake, `/` returns 500 while `/health` returns
  ok (verified).
- **`deployment.md` §4.4** — add the stack/registry mechanism alongside SSH and
  registry-pull.
- **`deployment.md` §7 checklist** — split into a compose column and a k8s
  column, or the checklist will ask for credentials the k8s path does not use.

## 6. Sequencing — do not do this during the 0.2 line

Policy §4.6 is unambiguous: any change that affects production safety sends the
release back to policy §4.1 and costs a new release candidate. A
deployment-platform change during an in-flight rollout would do exactly that,
repeatedly.

The order that respects both documents:

1. Finish v0.2.2 on the existing mechanism. Change nothing in
   `docs/runbooks/v0-2-2-rollout.md`.
2. Land the §2 policy rewordings — they are platform-neutral improvements and
   are safe to make on `main` at any time.
3. Decide §4.1 and §4.4 — the two genuine decisions. Both change credentials and
   CI, and both are cheaper to decide before staging runs on stack than after.
4. Reconcile `deployment.md` once staging has actually run on stack for a few
   releases — the plan's Phase 4 soak. Writing the standing reference against a
   platform with no production track record is how the drift the runbook policy
   exists to prevent gets introduced.
