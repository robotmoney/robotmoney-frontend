-- Self-serve committee credential claim (issue #205).
-- Forward-only and idempotent: the migration runner applies this once, while
-- every DDL statement is also safe when executed again by the migration test.

-- One row per member is the one-live-challenge invariant. Issuing another
-- challenge replaces this row atomically. A successful claim stamps
-- consumed_at in the same transaction that installs the first token hash.
CREATE TABLE IF NOT EXISTS committee_claim_challenges (
  member_id    text PRIMARY KEY REFERENCES committee_members(id) ON DELETE CASCADE,
  challenge    text NOT NULL UNIQUE,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  CONSTRAINT committee_claim_challenges_expiry_check CHECK (expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS committee_claim_challenges_expiry_idx
  ON committee_claim_challenges (expires_at);

-- Transactional email outbox. Activation writes this row and its queue job in
-- the same transaction as the member/key status changes. The worker records a
-- bounded error on failure; the durable queue owns retries.
CREATE TABLE IF NOT EXISTS committee_notification_outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('activation_approved')),
  member_id     text NOT NULL REFERENCES committee_members(id) ON DELETE CASCADE,
  from_email    text NOT NULL,
  to_email      text NOT NULL,
  payload       jsonb NOT NULL,
  attempts      int NOT NULL DEFAULT 0,
  sent_at       timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, member_id)
);
CREATE INDEX IF NOT EXISTS committee_notification_outbox_pending_idx
  ON committee_notification_outbox (created_at) WHERE sent_at IS NULL;
