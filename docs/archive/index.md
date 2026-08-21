# Archived documentation

Files here are historical investigations or other evidence retained for
traceability. They are not normative specifications. If an investigation
changes an architectural or product commitment, capture that change in the
canonical document and an accepted decision record, then leave the evidence
here with its date intact.

## Contents

| File | Original path | Date moved | Reason |
|---|---|---|---|
| `allocation-data-root-causes.md` | `docs/tmp-allocation-data-root-causes.md` | 2026-07-21 | Archived investigation evidence (allocation-data root-causes investigation, dated 2026-07-16). |
| `v0-2-2-rollout.md` | `docs/runbooks/v0-2-2-rollout.md` | 2026-08-21 | v0.2.2 shipped (tag `v0.2.2` = `bf63dc6`, 2026-08-20), so the runbook is history rather than procedure. Kept whole: it is the executed record of that rollout, corrected across eleven release candidates. Its release-independent half was extracted to [`docs/runbooks/rollout-procedure.md`](../runbooks/rollout-procedure.md), which is where per-release runbooks now cite from. |
| `release-cycle.md` | `docs/technical/release-cycle.md` | 2026-08-21 | Never-ratified draft that mixed live policy with a future topology proposal. Its §5 compatibility contract (the four ordering rules, expand/contract, migration hygiene) was migrated to [`docs/technical/release-runbooks.md` §8](../technical/release-runbooks.md); the k3s/GitOps topology it proposes is future infrastructure, kept here as the design record #680 draws on. |

## Dropped without archive

- `docs/demo-plan.md` — 282-line delivery plan whose phases had all shipped;
  deleted 2026-07-21 in PR #235 without archiving. Recoverable via
  `git show c42c47a:docs/demo-plan.md`.
- `docs/preview-server-spec.md` — spec for the retired `scripts/serve-preview.ts`
  server; superseded by decision D19 (static Cloudflare Pages previews +
  client-side wrapper) and deleted 2026-07-23 in PR #234 without archiving.
  Preview mode is now described in `docs/architecture.md` §4. Recoverable via
  `git show 8719f4c:docs/preview-server-spec.md`.

