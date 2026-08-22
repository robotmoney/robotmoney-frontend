# Code review artefacts

Every code review this repo has run, kept permanently.

**These are never deleted, and never edited after the fact.** A review is dated
evidence about a specific tree: it names the commit it read and says what was
true there. Retro-editing one — even to fix a path a later rename broke —
destroys the only thing it is for, which is reconciling a past finding against
what the code does now. Correct a review the way you correct any record: append
a dated addendum, or supersede it with a newer review that says so.

That rule already has a precedent in this directory. `20260723-review-docs-claude`
found that an earlier sweep had retro-edited `20260721-review-docs-codex.json`
and a manifest to cite paths that did not exist on the date those documents were
written, and recorded it as a finding.

## Why this index exists

Most of the files below are cited by nothing. That is expected for a completed
review, but it makes them look abandoned to anything that scans for orphans — a
2026-07-10 documentation sweep had to triage this directory by hand for exactly
that reason, and a 2026-08-22 sweep flagged the same files again. This index is
the answer to "is anyone still using these?": no, and they stay anyway.

## Contents

Reviews are named `<YYYYMMDD>-review-<dimension>-<slug>`. A `.md` is the
human-readable report; a `.json` is the same review in machine-readable form.
Either may appear alone.

| Date | Review | Pinned at | Scope |
|---|---|---|---|
| 2026-07-14 | `20260714-review-maintainability-claude` `.md` `.json` | `main` @ `4fc1236` | Whole repository, weighted toward surfaces changed by #103, #112, #117, #119, #122. Dimensions: duplicated semantics and coupling, dead paths, obsolete surfaces. |
| 2026-07-21 | `20260721-review-docs-codex` `.md` `.json` | `adhoc/20260721-190555-docs-cleanup` @ `c42c47a` | Documentation alignment. Deliberately reviewed the **uncommitted** worktree, not just the committed tree; the report records the `git diff HEAD` SHA-256 taken before either artefact existed. |
| 2026-07-23 | `20260723-review-docs-claude` `.md` `.json` | `adhoc/20260721-190555-docs-cleanup` @ `6e5cfb4` | `docs/**`, `CONTRIBUTING.md`, `README.md`, `frontend/public/views/docs/**`, doc back-links across backend/frontend/contract/scripts/CI, Plan issue #15. Reconciles the 2026-07-21 artefact above. |
| 2026-08-05 | `20260805-review-data-integrity-edgar-tiers` `.json` | `adhoc/20260803-175430-r6-edgar-full-recrawl` @ `2e541ae` | `backend/src/analytics/index.ts` — the RESEARCH SIGNALS section and EDGAR tiering. |
| 2026-08-05 | `20260805-review-security-claude` `.json` | `adhoc/20260805-004008-remove-no-supabase-guard` @ `1cdd4f9` | Removal of the no-Supabase CI guard: `.github/workflows/backend.yml`, `backend/scripts/check-no-*`. |
| 2026-08-05 | `20260805-review-security-ai-overview-guard` `.json` | `adhoc/20260805-015816-remove-no-ai-overview-guard` @ `aba6600` | Removal of the no-AI-overview CI guard, same surfaces as above. |
| 2026-08-14 | `20260814-review-data-integrity-macro-index-discrepancy` `.md` + `evidence/20260814-macro-index-discrepancy.json` | PR #620, head `f5fe64d` against base `ccf983f` | Macro index discrepancy, v1 `0.657` vs v0 `0.611`. Found that v0 persists its own forward-fills as real observations. **The one live review here** — cited by `floor-seed-generator.ts`, `floor-seed-calendar.ts`, `seed-provenance.ts`, `floor-seed-regenerate.ts`, `floor-seed-calendar-guard.test.ts`, `regime-fetchers.test.ts` and `docs/technical/regime-engine.md`, which quotes its §6, §14.3 and §14.4 as the rationale for current behaviour. |

## Related evidence directories

- [`docs/audits/`](../audits/) — point-in-time audits, same retention rule.
- [`docs/reports/`](../reports/) — dated operational reports.
- [`docs/archive/`](../archive/index.md) — documents that were once normative and
  are now history. Different category: an archived document *used* to be the
  spec, while a review was never one.
