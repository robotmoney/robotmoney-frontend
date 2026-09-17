-- Issue #829 (third instance of the shape #766 fixed) — a discriminator for
-- WHICH CANONICAL FORM produced a stored `inputs_digest`, so `swarm-judge-
-- replay` can tell "this row predates a canonicalization change and a raw
-- comparison was never going to match" from "this row claims the current
-- rule and no longer reproduces" (docs/decisions.md D44).
--
-- #808 changed what `inputs_digest` commits to (issue #765's derivation-wide
-- reading) without ever recording which reading produced a given row's
-- stored value. `swarm_judge_config.mode` ships `off` (migration 0039) and
-- #808's own gate recorded that no default deployment had ever turned it on
-- — which is exactly why NOT NULL DEFAULT is safe here: as of this
-- migration every row in this table, if any exist at all, was written under
-- the CURRENT scheme (`judge.ts`'s `DIGEST_SCHEME`), so there is nothing to
-- backfill under an older one. The column exists for the NEXT
-- canonical-form change, not this one — this is the cheap moment to add it,
-- before a soak creates rows on either side of a future boundary.
ALTER TABLE swarm_session_judgements
  ADD COLUMN IF NOT EXISTS digest_scheme text NOT NULL DEFAULT 'derivation-v1';

COMMENT ON COLUMN swarm_session_judgements.digest_scheme IS
  'Which canonical form (judge.ts DIGEST_SCHEME) produced this row''s inputs_digest. swarm-judge-replay treats a mismatch on a row whose digest_scheme equals the CURRENT constant as a real finding, and a mismatch on any other value as expected history to report, not fail (issue #829, D44).';
