-- Investment Committee v0: member key registry, append-only signed
-- recommendations, session lifecycle state, and an audit log. The signed
-- recommendation is the canonical, attributable record (docs/ARCHITECTURE.md §9).

-- Session lifecycle: scheduled → brief_published → collecting → window_closed
--                    → aggregated → published
ALTER TABLE committee_sessions ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'scheduled';
ALTER TABLE committee_sessions ADD COLUMN IF NOT EXISTS window_closes_at timestamptz;
ALTER TABLE committee_sessions ADD COLUMN IF NOT EXISTS published_at timestamptz;

-- Member key + access registry. public_key (ed25519, base64 raw) verifies
-- authorship; token_hash (sha256 of a demo bearer token) verifies transport
-- identity for the MCP/REST surfaces. RM never holds private keys.
CREATE TABLE committee_member_keys (
  id          bigserial PRIMARY KEY,
  member_id   text NOT NULL REFERENCES committee_members(id) ON DELETE CASCADE,
  public_key  text NOT NULL,
  alg         text NOT NULL DEFAULT 'ed25519',
  token_hash  text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX committee_member_keys_member_idx ON committee_member_keys (member_id);
CREATE UNIQUE INDEX committee_member_keys_token_idx ON committee_member_keys (token_hash) WHERE token_hash IS NOT NULL;

-- Append-only signed recommendations (the canonical take store). One per member
-- per session; nonce unique per member for replay protection.
CREATE TABLE committee_recommendations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES committee_sessions(id) ON DELETE CASCADE,
  member_id   text NOT NULL REFERENCES committee_members(id),
  subject_id  text NOT NULL,
  date        date NOT NULL,
  nonce       text NOT NULL,
  stance      text NOT NULL,
  confidence  numeric,
  body        text,
  memo_url    text,
  payload     jsonb NOT NULL,
  signature   text NOT NULL,
  verified    boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, member_id),
  UNIQUE (member_id, nonce)
);
CREATE INDEX committee_recommendations_session_idx ON committee_recommendations (session_id);

CREATE TABLE audit_log (
  id     bigserial PRIMARY KEY,
  actor  text NOT NULL,
  action text NOT NULL,
  scope  jsonb,
  at     timestamptz NOT NULL DEFAULT now()
);
