-- Phase 1 committee onboarding: applicants claim their bearer credential by
-- proving possession of the Ed25519 private key they registered. Admins only
-- approve the identity; they never receive the member's token.

ALTER TABLE committee_member_keys
  ADD COLUMN IF NOT EXISTS token_claimed_at timestamptz;

ALTER TABLE regime_snapshots
  ADD COLUMN IF NOT EXISTS synthetic boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS committee_token_claims (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   text NOT NULL REFERENCES committee_members(id) ON DELETE CASCADE,
  key_id      bigint NOT NULL REFERENCES committee_member_keys(id) ON DELETE CASCADE,
  challenge   text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS committee_token_claims_member_idx
  ON committee_token_claims (member_id, created_at DESC);
