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

Prior release runbooks, superseded deployment designs, and unadopted
infrastructure proposals were removed from the documentation tree on
2026-09-23. Their historical versions are recoverable from Git. They are not
retained here as alternate instructions.

## Dropped without archive

- `docs/smoke-plan.md` — 282-line delivery plan whose phases had all shipped;
  deleted 2026-07-21 in PR #235 without archiving. Recoverable via
  `git show c42c47a:docs/smoke-plan.md`.
- `docs/preview-server-spec.md` — spec for the retired `scripts/serve-preview.ts`
  server; its later hosted-preview proposals were never activated. Preview is
  local-only and is now described in `docs/architecture.md` §4. Recoverable via
  `git show 8719f4c:docs/preview-server-spec.md`.
