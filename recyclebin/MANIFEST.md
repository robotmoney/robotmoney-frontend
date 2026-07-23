# Recycle Bin Manifest

Documents moved here during the 2026-07-10 documentation-gardening pass.
These were triaged as stale, orphaned, or off-topic — not obviously garbage,
but not canonical/current documentation either. Preserved here for a human
to review and decide: keep (restore to docs/), or delete for real.

| Moved item | Original path | Reason moved | Date |
|---|---|---|---|
| `recyclebin/docs/coarse-diagram.md` | `docs/coarse-diagram.md` | Orphaned standalone mermaid diagram, not linked anywhere; its content was copied into `docs/topology.md`'s own diagram and updated there (CoinGecko → CoinMetrics), leaving this copy stale/duplicate. | 2026-07-10 |
| `recyclebin/docs/demo-diagram.md` | `docs/demo-diagram.md` | Orphaned standalone mermaid diagram, not linked anywhere; superseded by the equivalent diagram embedded directly in `docs/demo-spec.md`. | 2026-07-10 |
| `recyclebin/docs/task-queue-diagram.md` | `docs/task-queue-diagram.md` | Orphaned standalone mermaid diagram, not linked anywhere; byte-identical duplicate of the diagram embedded in `docs/topology.md` §11. | 2026-07-10 |
| `recyclebin/docs/FEATURE_PARITY_PLAN.md` | `docs/FEATURE_PARITY_PLAN.md` | Dated point-in-time audit (2026-06-30) tied to a now-merged/closed effort; its remaining-work list has since all shipped. Not linked from README/CONTRIBUTING/ARCHITECTURE. | 2026-07-10 |
| `recyclebin/docs/REGIME_PIXEL_PARITY_PLAN.md` | `docs/REGIME_PIXEL_PARITY_PLAN.md` | Single-commit implementation plan for regime-dashboard pixel-parity work, fully implemented since. Not linked from anywhere; historical design rationale only now. | 2026-07-10 |
| `recyclebin/docs/screenshots/` (README.md + reference/) | `docs/screenshots/` | Visual-QA reference tied to the same completed feature-parity effort; confirmed via grep that no script/tooling/CI config references this path, so it's safe to relocate wholesale. | 2026-07-10 |
| `recyclebin/docs/superfield-skill-improvements.md` | `docs/superfield-skill-improvements.md` | Substantive (567-line) but off-topic document: a friction-log/proposal for the `~/.agents` Superfield tooling install, not this repo's product documentation. Zero git history (untracked). Real content, worth a human's eyes, but doesn't belong in this repo's docs/. | 2026-07-10 |

## Pre-move verification

Before moving, each of the 7 filenames/dirnames above was grepped across the
repo (excluding `node_modules`, `.git`, and `recyclebin`) and specifically
against `README.md`, `CONTRIBUTING.md`, `docs/architecture.md`,
`docs/topology.md`, `docs/deployment.md`, `docs/demo-spec.md`, and
`docs/preview-server-spec.md`. No legitimate links were found in any of
those canonical documents, so all 7 items were moved as planned.

## Addendum 2026-07-23

The docs cited above by their original paths — `docs/topology.md`,
`docs/deployment.md`, `docs/demo-spec.md`, and `docs/preview-server-spec.md` —
were consolidated into `docs/architecture.md` (or moved to `docs/runbooks/`)
on 2026-07-21 (PR #235). The entries and pre-move verification above record
the pre-consolidation paths as verified at their original 2026-07-10 dates and
are intentionally left unedited.
